import {
  db,
  DEFAULT_PRIVACY_SETTINGS,
  META_KEYS,
  SECURITY_KEYS,
  type ExportedKeyring,
  type Folder,
  type MetaRow,
  type Note,
  type PrivacySettings,
  type RelockPolicy,
  type SavedLink,
} from '../index';
import type { VaultSnapshot } from '@/lib/search';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  summarizeBackup,
  type BackupData,
  type BackupMode,
  type PortableSettings,
  type StashBackup,
} from '@/lib/backup/format';
import { encryptBackupPayload } from '@/lib/backup/envelope';
import { getVaultKey, readKeyring, toExportedKeyring } from '@/lib/privacy/keyring';
import { isSealed, openFolder, openLink, openNote } from '@/lib/privacy/protection';
import { reconcileProtection } from '@/lib/privacy/reconcile';
import { APP_VERSION } from '@/lib/version';
import type { ImportCounts, ImportPlan, MergeCounts } from '@/lib/backup/merge';
import { getPrivacySettings } from './settings';
import { liveOnly } from '@/lib/trash';

/**
 * Exporting, backing up and restoring, as database work.
 *
 * Everything in this module is the *impure* half of the backup feature: reading
 * tables, writing rows inside one transaction, and keeping the emergency copy.
 * The decisions — what a file means, what a restore would do — live in
 * `lib/backup`, where they are pure functions with no database in sight. Keeping
 * that line is what makes the safety properties testable.
 *
 * ## What is exported
 *
 * Every row of user data: folders and their hierarchy, saved links, tags, both
 * join tables, notes and subnotes, and the portable preferences. Favourites and
 * archive state are ordinary columns on those rows, so they travel too. The one
 * exclusion is the `security` table's device-bound material: a key that only
 * means something on the phone that wrote it has no business in a file.
 *
 * ## Atomicity
 *
 * A restore is one Dexie transaction over every table it touches. Dexie rolls a
 * transaction back as a unit, so a failure part-way through — a quota error, a
 * constraint problem, the app being killed mid-write — leaves the previous vault
 * exactly as it was. There is no "partially imported" state to clean up because
 * there is no commit until the last row is in.
 *
 * Nothing awaits WebCrypto inside the transaction. That is not a stylistic
 * choice: Dexie's zone tracking cannot follow an async boundary that is not
 * itself a Dexie operation, and awaiting a crypto promise inside a transaction
 * aborts it. Every secret is resolved before the transaction opens.
 */

/** Tables every restore touches. Listed once so the transaction cannot miss one. */
const VAULT_TABLES = [
  'folders',
  'links',
  'tags',
  'linkTags',
  'notes',
  'noteLinks',
  'meta',
  'security',
] as const;

/** Every row as stored, ciphertext and all. */
export async function readVaultRaw(): Promise<VaultSnapshot> {
  return db.transaction('r', [db.folders, db.links, db.tags, db.linkTags, db.notes, db.noteLinks], async () => {
    const [folders, links, tags, linkTags, notes, noteLinks] = await Promise.all([
      db.folders.toArray(),
      db.links.toArray(),
      db.tags.toArray(),
      db.linkTags.toArray(),
      db.notes.toArray(),
      db.noteLinks.toArray(),
    ]);
    return { folders, links, tags, linkTags, notes, noteLinks };
  });
}

/**
 * The preferences that travel.
 *
 * Device bookkeeping is left behind deliberately: the schema version describes
 * the database a file came from, not the one it is going to, and "the note you
 * were last reading" is where this phone happened to be looking.
 */
export async function getPortableSettings(): Promise<PortableSettings> {
  const rows = await db.meta.bulkGet([
    META_KEYS.themeMode,
    META_KEYS.privacySettings,
    META_KEYS.lastFolderId,
    META_KEYS.recentFolders,
  ]);
  const [theme, privacy, lastFolder, recents] = rows.map((row) => row?.value);

  const policy = (privacy as { relockPolicy?: unknown } | null)?.relockPolicy;
  return {
    themeMode: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system',
    relockPolicy: isPolicy(policy) ? policy : DEFAULT_PRIVACY_SETTINGS.relockPolicy,
    lockApp: (privacy as { lockApp?: unknown } | null)?.lockApp !== false,
    secureScreen: (privacy as { secureScreen?: unknown } | null)?.secureScreen === true,
    biometric: (privacy as { biometric?: unknown } | null)?.biometric !== false,
    lastFolderId: typeof lastFolder === 'string' ? lastFolder : null,
    recentFolderIds: Array.isArray(recents) ? recents.filter((id): id is string => typeof id === 'string') : [],
  };
}

function isPolicy(value: unknown): value is RelockPolicy {
  return value === 'immediate' || value === '1m' || value === '5m' || value === '15m';
}

export interface ExportOutcome {
  ok: boolean;
  message?: string;
  fileName?: string;
  text?: string;
  backup?: StashBackup;
}

/**
 * Build the backup file.
 *
 * The three modes are three different promises, and the difference is only about
 * what happens to *locked* content:
 *
 *  - `sealed` — locked rows travel as the ciphertext they already are, with the
 *    passcode-wrapped keyring beside them. The file reveals nothing about locked
 *    content, and a restore can still open it with the original passcode. This
 *    is the default because it is the only mode that is both safe to store and
 *    fully recoverable.
 *  - `encrypted` — the same payload, and then the whole thing is encrypted under
 *    a passphrase chosen for the file. Belt and braces: nothing is readable
 *    without that passphrase, and locked items still need the Stash passcode
 *    afterwards.
 *  - `plaintext` — every locked row is opened into the file. This is a complete,
 *    readable copy of the vault and it is offered because losing the only
 *    readable copy of your own data is worse than the exposure — but it is
 *    opt-in, it is labelled as what it is, and it refuses to run at all if it
 *    cannot open something, rather than quietly shipping ciphertext in a file
 *    that claims to be readable.
 */
export async function buildBackup(options: {
  mode: BackupMode;
  passphrase?: string;
}): Promise<ExportOutcome> {
  const { mode } = options;
  const snapshot = await readVaultRaw();
  const settings = await getPortableSettings();

  // The trash is deliberately left behind. It is a recovery surface for *this*
  // device — "I deleted that a minute ago" — not part of the vault a person
  // backs up. Carrying it would also be actively harmful: the row fields that
  // mark a row as thrown away are not part of the format, so an imported
  // trashed row would arrive as a live one and resurrect data the user deleted.
  // Excluding it from the file is the honest reading of "your vault".
  const liveFolders = liveOnly(snapshot.folders);
  const liveLinks = liveOnly(snapshot.links);
  const liveNotes = liveOnly(snapshot.notes);
  const liveLinkIds = new Set(liveLinks.map((row) => row.id));
  const liveNoteIds = new Set(liveNotes.map((row) => row.id));

  let data: BackupData = {
    folders: liveFolders,
    links: liveLinks,
    tags: snapshot.tags,
    // A join row whose either end is in the trash describes a relationship the
    // restored vault could not show, so it goes with the row.
    linkTags: snapshot.linkTags.filter((row) => liveLinkIds.has(row.linkId)),
    notes: liveNotes,
    noteLinks: snapshot.noteLinks.filter(
      (row) => liveLinkIds.has(row.linkId) && liveNoteIds.has(row.noteId),
    ),
    settings,
  };

  const keyring = await readKeyring();
  let includeKeyring = mode !== 'plaintext';

  if (mode === 'plaintext') {
    const key = getVaultKey();
    const opened = await openEverything(data, key);
    if (!opened.ok) return { ok: false, message: opened.message };
    data = opened.data;
    // Nothing in this file is sealed any more, so a key for it would be
    // meaningless at best and a liability at worst.
    includeKeyring = false;
  }

  const summary = summarizeBackup(data);
  const backup: StashBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    mode,
    summary,
  };

  if (mode === 'encrypted') {
    if (!options.passphrase || options.passphrase.length === 0) {
      return { ok: false, message: 'A passphrase is needed to encrypt a backup.' };
    }
    // The keyring travels *inside* the encrypted payload, so the file cannot be
    // partially read and the locked rows stay locked even after the outer layer
    // is opened.
    const inner: BackupData = { ...data, settings };
    const envelope = await encryptBackupPayload(inner, options.passphrase);
    backup.kdf = envelope.kdf;
    backup.payload = envelope.payload;
    // `toExportedKeyring` answers `null` for a device-only vault: there is no
    // passcode wrap to hand over, and writing a keyring the receiving device
    // cannot use would be a false promise. The sealed rows still travel; they
    // just arrive locked, which the import side already presents as such.
    if (keyring && includeKeyring) {
      const exported = toExportedKeyring(keyring);
      if (exported) backup.security = { keyring: exported };
    }
  } else {
    backup.data = data;
    if (keyring && includeKeyring) {
      const exported = toExportedKeyring(keyring);
      if (exported) backup.security = { keyring: exported };
    }
  }

  return {
    ok: true,
    fileName: backupFileName(),
    text: JSON.stringify(backup, null, 2),
    backup,
  };
}

/**
 * Open every sealed row, or explain why the export cannot be complete.
 *
 * A row sealed with a key this device does not hold — one that arrived from
 * another device's backup — cannot be opened. Refusing is the honest response:
 * the alternative is a file called "everything readable" that contains a locked
 * item nobody mentioned.
 */
async function openEverything(
  data: BackupData,
  key: CryptoKey | null,
): Promise<{ ok: true; data: BackupData } | { ok: false; message: string }> {
  // Nothing is sealed, so there is nothing to open. This is the ordinary case
  // for someone who has not set a passcode at all — their vault is already
  // readable, and demanding an unlock for a readable export would be asking for
  // a key that does not exist.
  const sealedRows =
    data.folders.filter(isSealed).length + data.links.filter(isSealed).length + data.notes.filter(isSealed).length;
  if (sealedRows === 0) return { ok: true, data };

  if (!key) {
    return {
      ok: false,
      message: 'Unlock Stash first: a readable export has to open every locked item.',
    };
  }

  const stillSealed: string[] = [];
  const folders: Folder[] = [];
  const links: SavedLink[] = [];
  const notes: Note[] = [];

  for (const folder of data.folders) {
    const opened = await openFolder(folder, key);
    if (isSealed(opened)) stillSealed.push('a folder');
    folders.push(opened);
  }
  for (const link of data.links) {
    const opened = await openLink(link, key);
    if (isSealed(opened)) stillSealed.push('a link');
    links.push(opened);
  }
  for (const note of data.notes) {
    const opened = await openNote(note, key);
    if (isSealed(opened)) stillSealed.push('a note');
    notes.push(opened);
  }

  if (stillSealed.length > 0) {
    return {
      ok: false,
      message: `${stillSealed.length} item(s) in this vault are locked with a key this device does not have, so a fully readable export cannot be made.`,
    };
  }

  return { ok: true, data: { ...data, folders, links, notes } };
}

/**
 * A copy of the vault as it stands, taken immediately before a destructive
 * restore.
 *
 * This is the undo. It is written in `sealed` mode whatever the incoming file's
 * mode was, because its purpose is to be recoverable rather than portable, and
 * because a temporary file that happens to hold every locked item in the clear
 * would be a poor trade for a safety net.
 */
export async function buildEmergencyBackup(): Promise<string> {
  const snapshot = await readVaultRaw();
  const settings = await getPortableSettings();
  const keyring = await readKeyring();

  const data: BackupData = {
    folders: snapshot.folders,
    links: snapshot.links,
    tags: snapshot.tags,
    linkTags: snapshot.linkTags,
    notes: snapshot.notes,
    noteLinks: snapshot.noteLinks,
    settings,
  };

  const backup: StashBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    mode: 'sealed',
    summary: summarizeBackup(data),
    data,
  };
  if (keyring) {
    const exported = toExportedKeyring(keyring);
    if (exported) backup.security = { keyring: exported };
  }
  return JSON.stringify(backup, null, 2);
}

export interface ApplyOutcome {
  ok: boolean;
  message?: string;
  written: ImportCounts;
  /**
   * Rows the file offered that were recognized as already here.
   *
   * Reported next to `written` so the summary can say what a merge actually did:
   * a folder that was merged into an existing one is counted here and *not* as a
   * created folder, which is the number the user is being asked to trust.
   */
  merged: MergeCounts;
  /** JSON of the vault as it was, for a replace. Empty for a merge. */
  emergencyBackup: string | null;
  /**
   * True when the backup's keyring replaced this device's. The session must be
   * locked immediately afterwards: the key in memory belongs to the vault that
   * was just cleared.
   */
  keyringReplaced: boolean;
}

const ZERO_COUNTS: ImportCounts = { folders: 0, links: 0, tags: 0, notes: 0, linkTags: 0, noteLinks: 0 };
const ZERO_MERGED: MergeCounts = { folders: 0, links: 0, notes: 0, tags: 0 };

/**
 * Perform a planned restore.
 *
 * Order matters and is deliberate:
 *
 *  1. for a replace, take the emergency copy *first*, while the old vault is
 *     still there to copy;
 *  2. swap the keyring, if the plan says to, in the same transaction that clears
 *     the old rows — a keyring change outside it could survive a rolled-back
 *     clear and lock the user out of data that was never deleted;
 *  3. write every row;
 *  4. apply settings;
 *  5. derive protection again, because an imported subtree can sit under a lock
 *     boundary it did not sit under before, and seams like that are exactly what
 *     a restore creates.
 */
export async function applyImport(plan: ImportPlan, options: { keyring: ExportedKeyring | null }): Promise<ApplyOutcome> {
  let emergencyBackup: string | null = null;

  if (plan.mode === 'replace') {
    // Best-effort: if this fails, the user is told before anything is cleared
    // rather than discovering afterwards that there is no way back.
    try {
      emergencyBackup = await buildEmergencyBackup();
    } catch (error) {
      return {
        ok: false,
        message: `Could not take a safety copy of the current data (${error instanceof Error ? error.message : 'unknown error'}), so nothing was changed.`,
        written: ZERO_COUNTS,
        merged: ZERO_MERGED,
        emergencyBackup: null,
        keyringReplaced: false,
      };
    }
  }

  // Read the current privacy preferences before the transaction: `enabled` is a
  // statement about whether a keyring exists, and an imported file must not be
  // able to flip it on for a device that has none.
  const currentPrivacy = await getPrivacySettings();
  let keyringReplaced = false;

  try {
    await db.transaction('rw', VAULT_TABLES, async () => {
      if (plan.mode === 'replace') {
        await Promise.all([
          db.folders.clear(),
          db.links.clear(),
          db.tags.clear(),
          db.linkTags.clear(),
          db.notes.clear(),
          db.noteLinks.clear(),
        ]);
      }

      if (plan.keyring === 'adopt' && options.keyring) {
        const existing = await db.security.get(SECURITY_KEYS.keyring);
        keyringReplaced = Boolean(existing);
        const now = Date.now();
        // Only the passcode wrap is installed. The device wrap is meaningless
        // off the phone that created it, and copying it would offer a biometric
        // prompt that cannot succeed.
        await db.security.put({
          key: SECURITY_KEYS.keyring,
          value: {
            version: 1,
            kdf: options.keyring.kdf,
            wrappedByPasscode: options.keyring.wrappedByPasscode,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      if (plan.folders.length > 0) await db.folders.bulkPut(plan.folders);
      if (plan.links.length > 0) await db.links.bulkPut(plan.links);
      if (plan.tags.length > 0) await db.tags.bulkPut(plan.tags);
      if (plan.linkTags.length > 0) await db.linkTags.bulkPut(plan.linkTags);
      if (plan.notes.length > 0) await db.notes.bulkPut(plan.notes);
      if (plan.noteLinks.length > 0) await db.noteLinks.bulkPut(plan.noteLinks);

      const metaRows = portableMetaRows(plan.settings, currentPrivacy, plan.keyring === 'adopt');
      if (metaRows.length > 0) await db.meta.bulkPut(metaRows);
    });
  } catch (error) {
    // Dexie has rolled the transaction back. The vault is exactly as it was.
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'The restore could not be completed.',
      written: ZERO_COUNTS,
      merged: ZERO_MERGED,
      emergencyBackup,
      keyringReplaced: false,
    };
  }

  try {
    await reconcileProtection();
  } catch (error) {
    // The rows are in; only the lock derivation failed. Reporting it is better
    // than hiding it, but it is not a failed import.
    console.warn('[stash] could not re-derive lock state after import', error);
  }

  return {
    ok: true,
    written: plan.counts,
    merged: plan.merged,
    emergencyBackup,
    keyringReplaced,
  };
}

function portableMetaRows(
  settings: PortableSettings | null,
  current: PrivacySettings,
  installingKeyring: boolean,
): MetaRow[] {
  if (!settings) return [];

  // The lock policy, the screen-privacy flag and the biometric preference travel
  // because a file written by an earlier build carries them, and a restore should
  // not silently drop a user's settings on the way back in. `biometric` is legacy
  // now: locking has no separate switch, because creating a keyring *is* turning
  // it on, so the field round-trips and decides nothing.
  //
  // Whether privacy is *on* is not a preference — it follows from a keyring
  // existing, and only installing one can change it.
  const privacy: PrivacySettings = {
    ...current,
    enabled: current.enabled || installingKeyring,
    relockPolicy: settings.relockPolicy,
    lockApp: settings.lockApp,
    secureScreen: settings.secureScreen,
    biometric: settings.biometric,
  };

  return [
    { key: META_KEYS.themeMode, value: settings.themeMode },
    { key: META_KEYS.lastFolderId, value: settings.lastFolderId },
    { key: META_KEYS.recentFolders, value: settings.recentFolderIds },
    { key: META_KEYS.privacySettings, value: privacy },
  ];
}
