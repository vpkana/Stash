import type { ExportedKeyring, RelockPolicy } from '@/db/types';
import { isEncryptedPayload } from '@/lib/privacy/crypto';
import { isRelockPolicy } from '@/lib/privacy/session';
import { MAX_FOLDER_DEPTH, MAX_NOTE_DEPTH } from '@/lib/tree';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  summarizeBackup,
  type BackupData,
  type BackupMode,
  type BackupSummary,
  type PortableSettings,
  type StashBackup,
} from './format';
import {
  createCollector,
  isPlainObject,
  readFolders,
  readLinkTags,
  readLinks,
  readNoteLinks,
  readNotes,
  readTags,
  type ReadCollector,
} from './rows';

/**
 * Deciding whether a file may be restored.
 *
 * The rule this module exists to enforce: **nothing touches the database until
 * the whole document has been understood.** Validation is a pure function from
 * an untrusted value to either a complete, repaired, internally consistent vault
 * or a refusal with a reason. It never writes, never throws for bad input, and
 * never partially succeeds.
 *
 * Two kinds of problem, handled differently on purpose:
 *
 *  - **Fatal** — the file is not a Stash backup, its version is from the future,
 *    its structure is not what it claims, or a record is unreadable. Restoring
 *    such a file cannot be done faithfully, so it is not done at all.
 *  - **Repairable** — a reference points at something that is not in the file, a
 *    parent chain contains a cycle, a hierarchy is deeper than the app allows,
 *    or a field is missing. Each repair is *counted and named* in the report, so
 *    the user is told exactly what a restore would change rather than being left
 *    to discover it later.
 *
 * Repairs always move data toward reachable, never toward deleted. An orphaned
 * note becomes a root note; a join row whose partner is missing is dropped
 * because it records no information on its own. No record of user content is
 * ever invented or discarded.
 */

export type BackupProblem =
  | 'empty-file'
  | 'too-large'
  | 'not-json'
  | 'not-an-object'
  | 'not-a-backup'
  | 'unsupported-version'
  | 'missing-payload'
  | 'corrupt'
  /**
   * Reserved for a payload that failed to decrypt. An *intact* encrypted file is
   * never one of these: needing a passphrase is `kind: 'encrypted'`, a normal
   * stage of the flow, and modelling it as a failure would leave the UI with a
   * dead end and no way to ask for one.
   */
  | 'wrong-passphrase';

export interface ValidationReport {
  /** Where the file came from: the current format, or the legacy one. */
  origin: 'stash-backup' | 'stash-export';
  version: number;
  /** Human label for a legacy file that was upgraded, e.g. `stash-export v3`. */
  migratedFrom: string | null;
  mode: BackupMode;
  exportedAt: string | null;
  appVersion: string;
  summary: BackupSummary;
  keyring: ExportedKeyring | null;
  /** Every repair or coercion applied, in the order it was found. */
  repairs: string[];
  /** How many individual fields were defaulted. */
  coerced: number;
  /** Things the user should know but that do not stop a restore. */
  warnings: string[];
  /** True when the file has no key for ciphertext it contains. */
  orphanedCiphertext: boolean;
}

export type ParseResult =
  /** Fully validated and ready to restore. */
  | { kind: 'ready'; backup: StashBackup; data: BackupData; report: ValidationReport }
  /** Structurally sound, but the payload is encrypted: a passphrase is next. */
  | { kind: 'encrypted'; backup: StashBackup; report: ValidationReport }
  | { kind: 'invalid'; problem: BackupProblem; message: string; details: string[] };

export const DEFAULT_PORTABLE_SETTINGS: PortableSettings = {
  themeMode: 'system',
  relockPolicy: 'immediate',
  sessionEndPolicy: 'app-close',
  lockApp: true,
  secureScreen: false,
  biometric: true,
  lastFolderId: null,
  recentFolderIds: [],
};

const PROBLEM_MESSAGES: Record<BackupProblem, string> = {
  'empty-file': 'That file is empty.',
  'too-large': 'That file is far larger than any Stash backup, so it is not being opened.',
  'not-json': 'That file is not valid JSON, so it cannot be read as a backup.',
  'not-an-object': 'That file does not contain a backup document.',
  'not-a-backup': 'That file was not created by Stash. Nothing has been changed.',
  'unsupported-version':
    'That backup was written by a newer version of Stash, which this one cannot read safely.',
  'missing-payload': 'That backup declares no data to restore.',
  corrupt: 'That backup is damaged and cannot be restored faithfully.',
  'wrong-passphrase': 'That passphrase did not open this backup.',
};

export function problemMessage(problem: BackupProblem): string {
  return PROBLEM_MESSAGES[problem];
}

/** A refusal, with the specifics that made the document unusable. */
export function invalid(problem: BackupProblem, details: string[] = [], message?: string): ParseResult {
  return { kind: 'invalid', problem, message: message ?? PROBLEM_MESSAGES[problem], details };
}

/**
 * Read a file into a decision.
 *
 * `bytes` is passed in by the caller because it already holds the file, and
 * checking the size before parsing is what keeps a hostile file from being
 * parsed at all.
 */
export function parseBackup(text: string, options: { bytes?: number } = {}): ParseResult {
  const size = options.bytes ?? text.length;
  if (size > MAX_BACKUP_BYTES) return invalid('too-large');
  if (text.trim().length === 0) return invalid('empty-file');

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return invalid('not-json', [error instanceof Error ? error.message : 'Parse error.']);
  }

  return inspectBackupDocument(document);
}

/**
 * Classify a parsed document.
 *
 * Split out from {@link parseBackup} so tests (and future file sources) can
 * supply an already-parsed value without going through a string.
 */
export function inspectBackupDocument(document: unknown): ParseResult {
  if (!isPlainObject(document)) return invalid('not-an-object');

  const format = document.format;

  // The legacy format is recognised on purpose rather than tolerated by
  // accident: a user's older export is their data and must keep importing.
  if (format === 'stash-export') return migrateLegacyExport(document);
  if (format !== BACKUP_FORMAT) {
    return invalid('not-a-backup', [
      format === undefined ? 'It has no "format" field.' : `Its "format" is "${String(format)}".`,
    ]);
  }

  return readModernBackup(document);
}

// ---------------------------------------------------------------------------
// The current format
// ---------------------------------------------------------------------------

function readModernBackup(document: Record<string, unknown>): ParseResult {
  const version = document.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return invalid('corrupt', ['Its "version" is missing or not a number.']);
  }
  if (version > BACKUP_VERSION) {
    return invalid('unsupported-version', [
      `The file is version ${version}; this build understands up to ${BACKUP_VERSION}.`,
    ]);
  }

  const mode = document.mode;
  if (mode !== 'sealed' && mode !== 'plaintext' && mode !== 'encrypted') {
    return invalid('corrupt', [`Its locking mode "${String(mode)}" is not one this version knows.`]);
  }

  const exportedAt = typeof document.exportedAt === 'string' ? document.exportedAt : null;
  const appVersion = typeof document.appVersion === 'string' ? document.appVersion : 'unknown';
  const declaredSummary = isPlainObject(document.summary) ? (document.summary as unknown as BackupSummary) : null;

  const keyring = readExportedKeyring(document.security);
  const hasCiphertextEnvelope = isEncryptedPayload(document.payload);
  const rawData = document.data;

  /**
   * An encrypted backup with nothing readable in it: the passphrase is the next
   * step, and there is genuinely nothing to check until it arrives. Counts for
   * the review screen come from the file's own summary, which is advisory and
   * recomputed from the real payload once it is opened.
   */
  if (mode === 'encrypted' && !isPlainObject(rawData)) {
    if (!hasCiphertextEnvelope) {
      return invalid('missing-payload', ['It is marked encrypted but carries no encrypted payload.']);
    }
    if (!hasUsableKdf(document.kdf)) {
      return invalid('corrupt', ['Its key-derivation settings are missing or not understood.']);
    }
    return {
      kind: 'encrypted',
      backup: envelopeBackup(document, version, exportedAt, appVersion, keyring),
      report: envelopeReport(document, version, exportedAt, appVersion, keyring),
    };
  }

  // A file that says "encrypted" but also ships a readable payload is not
  // actually encrypted. Say so, and read what is really there: refusing would
  // reject a file that is perfectly readable, which helps nobody.
  const envelopeWarning: string[] = [];
  if (mode === 'encrypted' && isPlainObject(rawData)) {
    envelopeWarning.push(
      'This file is marked as encrypted but also contains readable data, so it is not actually encrypted.',
    );
  }

  if (!isPlainObject(rawData)) {
    return invalid('missing-payload', ['It has no "data" object.']);
  }

  const outcome = validateBackupData(rawData, {
    origin: 'stash-backup',
    version,
    migratedFrom: null,
    mode,
    exportedAt,
    appVersion,
    keyring,
    declaredSummary,
    extraWarnings: envelopeWarning,
  });

  if (!outcome.ok) return outcome.result;

  const backup: StashBackup = {
    format: BACKUP_FORMAT,
    version,
    exportedAt: exportedAt ?? new Date().toISOString(),
    appVersion,
    mode,
    summary: outcome.report.summary,
    data: outcome.data,
  };
  if (keyring) backup.security = { keyring };
  if (hasCiphertextEnvelope && isPlainObject(document.kdf)) {
    const kdf = document.kdf;
    if (kdf.algorithm === 'PBKDF2-SHA256' && typeof kdf.salt === 'string' && typeof kdf.iterations === 'number') {
      backup.kdf = { algorithm: 'PBKDF2-SHA256', salt: kdf.salt, iterations: kdf.iterations };
      backup.payload = document.payload as StashBackup['payload'];
    }
  }

  return { kind: 'ready', backup, data: outcome.data, report: outcome.report };
}

function hasUsableKdf(kdf: unknown): boolean {
  return (
    isPlainObject(kdf) &&
    kdf.algorithm === 'PBKDF2-SHA256' &&
    typeof kdf.salt === 'string' &&
    typeof kdf.iterations === 'number' &&
    kdf.iterations > 0
  );
}

/**
 * The envelope of an encrypted backup, described without opening it.
 *
 * Every number here comes from the file's own summary and is labelled as such
 * by the caller; nothing in it is trusted, and the real report replaces it the
 * moment the payload is decrypted.
 */
function envelopeReport(
  document: Record<string, unknown>,
  version: number,
  exportedAt: string | null,
  appVersion: string,
  keyring: ExportedKeyring | null,
): ValidationReport {
  return {
    origin: 'stash-backup',
    version,
    migratedFrom: null,
    mode: 'encrypted',
    exportedAt,
    appVersion,
    summary: readDeclaredSummary(document.summary),
    keyring,
    repairs: [],
    coerced: 0,
    warnings: [
      'This backup is encrypted. Its contents are checked once the passphrase opens it.',
    ],
    orphanedCiphertext: false,
  };
}

function envelopeBackup(
  document: Record<string, unknown>,
  version: number,
  exportedAt: string | null,
  appVersion: string,
  keyring: ExportedKeyring | null,
): StashBackup {
  const backup: StashBackup = {
    format: BACKUP_FORMAT,
    version,
    exportedAt: exportedAt ?? new Date().toISOString(),
    appVersion,
    mode: 'encrypted',
    summary: readDeclaredSummary(document.summary),
    kdf: document.kdf as StashBackup['kdf'],
    payload: document.payload as StashBackup['payload'],
  };
  if (keyring) backup.security = { keyring };
  return backup;
}

function readDeclaredSummary(value: unknown): BackupSummary {
  const zero: BackupSummary = {
    folders: 0,
    links: 0,
    tags: 0,
    notes: 0,
    linkTags: 0,
    noteLinks: 0,
    favorites: 0,
    archived: 0,
    sealedItems: 0,
  };
  if (!isPlainObject(value)) return zero;
  const read = (key: keyof BackupSummary) =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) ? (value[key] as number) : 0;
  return {
    folders: read('folders'),
    links: read('links'),
    tags: read('tags'),
    notes: read('notes'),
    linkTags: read('linkTags'),
    noteLinks: read('noteLinks'),
    favorites: read('favorites'),
    archived: read('archived'),
    sealedItems: read('sealedItems'),
  };
}

function readExportedKeyring(security: unknown): ExportedKeyring | null {
  if (!isPlainObject(security)) return null;
  const candidate = security.keyring;
  if (!isPlainObject(candidate)) return null;
  if (candidate.version !== 1) return null;
  if (!isPlainObject(candidate.kdf) || candidate.kdf.algorithm !== 'PBKDF2-SHA256') return null;
  if (typeof candidate.kdf.salt !== 'string' || typeof candidate.kdf.iterations !== 'number') return null;
  if (!isEncryptedPayload(candidate.wrappedByPasscode)) return null;
  return candidate as unknown as ExportedKeyring;
}

// ---------------------------------------------------------------------------
// The legacy `stash-export` format
// ---------------------------------------------------------------------------

/**
 * Upgrade a `stash-export` document.
 *
 * The old format kept settings as a `meta` row array, so they are lifted out
 * here rather than arriving as a `settings` object. Everything else already has
 * the right shape, so both formats converge on the same validator — which means
 * an older file gets exactly the same reference, cycle and depth checking as a
 * current one instead of a weaker path.
 */
function migrateLegacyExport(document: Record<string, unknown>): ParseResult {
  const version = document.version;
  if (typeof version !== 'number' || ![1, 2, 3].includes(version)) {
    return invalid('unsupported-version', [
      `That legacy export reports version ${String(version)}, and this build understands 1 to 3.`,
    ]);
  }

  const keyring = readExportedKeyring(document.security);
  const settings = settingsFromMeta(document.meta);

  const exportedAt = typeof document.exportedAt === 'number' ? new Date(document.exportedAt).toISOString() : null;

  const raw: Record<string, unknown> = {
    folders: document.folders,
    links: document.links,
    tags: document.tags,
    linkTags: document.linkTags,
    notes: document.notes,
    noteLinks: document.noteLinks,
    settings,
  };

  const outcome = validateBackupData(raw, {
    origin: 'stash-export',
    version,
    migratedFrom: `stash-export v${version}`,
    // The old format has no mode: it kept locked rows sealed and shipped the
    // keyring, which is exactly what `sealed` means now.
    mode: 'sealed',
    exportedAt,
    appVersion: 'unknown',
    keyring,
    declaredSummary: null,
    extraWarnings: [],
  });

  if (!outcome.ok) return outcome.result;

  const backup: StashBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: exportedAt ?? new Date().toISOString(),
    appVersion: 'unknown',
    mode: 'sealed',
    summary: outcome.report.summary,
    data: outcome.data,
  };
  if (keyring) backup.security = { keyring };

  return { kind: 'ready', backup, data: outcome.data, report: outcome.report };
}

function settingsFromMeta(meta: unknown): PortableSettings {
  const settings: PortableSettings = { ...DEFAULT_PORTABLE_SETTINGS };
  if (!Array.isArray(meta)) return settings;

  for (const row of meta) {
    if (!isPlainObject(row) || typeof row.key !== 'string') continue;
    const value = row.value;
    switch (row.key) {
      case 'theme.mode':
        if (value === 'light' || value === 'dark' || value === 'system') settings.themeMode = value;
        break;
      case 'capture.lastFolderId':
        settings.lastFolderId = typeof value === 'string' ? value : null;
        break;
      case 'capture.recentFolders':
        settings.recentFolderIds = Array.isArray(value)
          ? value.filter((id): id is string => typeof id === 'string')
          : [];
        break;
      case 'privacy.settings':
        if (isPlainObject(value)) {
          if (isRelockPolicy(value.relockPolicy)) settings.relockPolicy = value.relockPolicy;
          if (value.sessionEndPolicy === 'tab-change' || value.sessionEndPolicy === 'app-close') {
            settings.sessionEndPolicy = value.sessionEndPolicy;
          }
          if (typeof value.lockApp === 'boolean') settings.lockApp = value.lockApp;
          if (typeof value.secureScreen === 'boolean') settings.secureScreen = value.secureScreen;
          if (typeof value.biometric === 'boolean') settings.biometric = value.biometric;
        }
        break;
      default:
        break;
    }
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Data validation
// ---------------------------------------------------------------------------

interface BuildContext {
  origin: ValidationReport['origin'];
  version: number;
  migratedFrom: string | null;
  mode: BackupMode;
  exportedAt: string | null;
  appVersion: string;
  keyring: ExportedKeyring | null;
  declaredSummary: BackupSummary | null;
  /** Framing problems found before the payload was read. */
  extraWarnings: string[];
}

type BuildOutcome = { ok: true; data: BackupData; report: ValidationReport } | { ok: false; result: ParseResult };

/**
 * Validate and repair the payload.
 *
 * Also used directly after decrypting an `encrypted` backup's payload, so the
 * rules enforced on a file are identical whether it arrived in the clear or
 * behind a passphrase.
 */
export function validateBackupData(
  raw: Record<string, unknown>,
  context: Partial<Omit<BuildContext, 'extraWarnings'>> & { extraWarnings?: string[] } = {},
): BuildOutcome {
  const collector = createCollector();

  const folders = readFolders(raw.folders, collector);
  const links = readLinks(raw.links, collector);
  const tags = readTags(raw.tags, collector);
  let linkTags = readLinkTags(raw.linkTags, collector);
  const notes = readNotes(raw.notes, collector);
  let noteLinks = readNoteLinks(raw.noteLinks, collector);

  if (collector.errors.length > 0) {
    return { ok: false, result: invalid('corrupt', collector.errors.slice(0, 12)) };
  }

  const repairs: string[] = [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  const noteIds = new Set(notes.map((note) => note.id));
  const linkIds = new Set(links.map((link) => link.id));
  const tagIds = new Set(tags.map((tag) => tag.id));

  // --- References --------------------------------------------------------
  // A join row whose other half is missing records nothing, so it is dropped;
  // a row whose *parent* is missing is re-homed instead, because the row itself
  // is real content and dropping it would be data loss.
  const droppedLinkTags = linkTags.length;
  linkTags = linkTags.filter((row) => linkIds.has(row.linkId) && tagIds.has(row.tagId));
  const removedLinkTags = droppedLinkTags - linkTags.length;
  if (removedLinkTags > 0) {
    repairs.push(`${removedLinkTags} tag link(s) pointed at a link or tag that is not in this backup and were dropped.`);
  }

  const totalNoteLinks = noteLinks.length;
  noteLinks = noteLinks.filter((row) => noteIds.has(row.noteId) && linkIds.has(row.linkId));
  const removedNoteLinks = totalNoteLinks - noteLinks.length;
  if (removedNoteLinks > 0) {
    repairs.push(
      `${removedNoteLinks} note reference(s) pointed at a note or link that is not in this backup and were dropped.`,
    );
  }

  let orphanedLinks = 0;
  for (const link of links) {
    if (link.folderId && !folderIds.has(link.folderId)) {
      link.folderId = null;
      orphanedLinks += 1;
    }
  }
  if (orphanedLinks > 0) {
    repairs.push(`${orphanedLinks} link(s) belonged to a folder that is not in this backup and were moved to the library root.`);
  }

  // --- Hierarchy ---------------------------------------------------------
  const folderRepair = repairHierarchy(
    folders,
    (folder) => folder.id,
    (folder) => folder.parentId,
    (folder, parentId) => {
      folder.parentId = parentId;
    },
    MAX_FOLDER_DEPTH,
    'folder',
  );
  repairs.push(...folderRepair);

  const noteRepair = repairHierarchy(
    notes,
    (note) => note.id,
    (note) => note.parentNoteId,
    (note, parentId) => {
      note.parentNoteId = parentId;
    },
    MAX_NOTE_DEPTH,
    'note',
  );
  repairs.push(...noteRepair);

  // --- Settings ----------------------------------------------------------
  const settings = readSettings(raw.settings, repairs);

  // --- Locked content ----------------------------------------------------
  const sealedRows = [
    ...folders.filter((row) => row.enc),
    ...links.filter((row) => row.enc),
    ...notes.filter((row) => row.enc),
  ].length;
  const lockedNotSealed =
    folders.filter((folder) => folder.isLocked && !folder.enc).length +
    links.filter((link) => link.isLocked && !link.enc).length +
    notes.filter((note) => note.isLocked && !note.enc).length;

  const keyring = context.keyring ?? null;
  const warnings = [...(context.extraWarnings ?? [])];
  const orphanedCiphertext = sealedRows > 0 && !keyring;

  if (orphanedCiphertext) {
    warnings.push(
      `${sealedRows} locked item(s) in this backup are encrypted and this file carries no key for them. They will be restored as locked but unreadable until a matching passcode is set up.`,
    );
  }
  if (sealedRows > 0 && keyring) {
    warnings.push(
      `${sealedRows} locked item(s) stay encrypted. Restoring them makes them readable only with the passcode from the device that wrote this backup.`,
    );
    warnings.push(
      'This backup contains the key for those items, wrapped with the Stash passcode. Anyone who has the file and knows the passcode can read them.',
    );
  }
  if (lockedNotSealed > 0) {
    warnings.push(
      `${lockedNotSealed} item(s) are marked as locked but are stored in this file as readable text. Restoring them locks them again on this device.`,
    );
  }

  const data: BackupData = { folders, links, tags, linkTags, notes, noteLinks, settings };
  const summary = summarizeBackup(data);

  // Advisory fields are recomputed from the data, never trusted. A stale
  // summary must not be able to influence a restore decision.
  if (context.declaredSummary) {
    const mismatch = compareSummaries(context.declaredSummary, summary);
    if (mismatch) {
      warnings.push(`This backup's own summary does not match its contents (${mismatch}); the contents are being used.`);
    }
  }

  const report: ValidationReport = {
    origin: context.origin ?? 'stash-backup',
    version: context.version ?? BACKUP_VERSION,
    migratedFrom: context.migratedFrom ?? null,
    mode: context.mode ?? 'sealed',
    exportedAt: context.exportedAt ?? null,
    appVersion: context.appVersion ?? 'unknown',
    summary,
    keyring,
    repairs,
    coerced: collector.coerced,
    warnings,
    orphanedCiphertext,
  };

  if (summary.folders + summary.links + summary.notes + summary.tags === 0) {
    warnings.push('This backup contains no folders, links, tags or notes.');
  }

  return { ok: true, data, report };
}

function compareSummaries(declared: BackupSummary, actual: BackupSummary): string | null {
  const keys: Array<keyof BackupSummary> = ['folders', 'links', 'tags', 'notes', 'favorites'];
  for (const key of keys) {
    const value = declared[key];
    if (typeof value === 'number' && value !== actual[key]) {
      return `${key}: said ${value}, found ${actual[key]}`;
    }
  }
  return null;
}

/**
 * Make a parent-linked family reachable and no deeper than the app allows.
 *
 * Three separate problems, one pass:
 *
 *  1. a parent that is not in the file → the row becomes a root row;
 *  2. a cycle → broken at one deterministic member, so every row in the loop
 *     becomes reachable instead of being lost together;
 *  3. a chain deeper than the limit → the row that crosses the limit is lifted
 *     to the root, which only ever makes its children shallower.
 *
 * A cyclic chain is impossible to produce through the UI, so reaching this means
 * hand-edited or third-party data. Refusing the file would be unhelpful; making
 * it consistent and reporting it is not.
 */
function repairHierarchy<T>(
  rows: T[],
  idOf: (row: T) => string,
  parentOf: (row: T) => string | null,
  setParent: (row: T, parentId: string | null) => void,
  maxDepth: number,
  label: string,
): string[] {
  const repairs: string[] = [];
  const byId = new Map<string, T>();
  const order: string[] = [];
  for (const row of rows) {
    byId.set(idOf(row), row);
    order.push(idOf(row));
  }

  const parent = new Map<string, string | null>();
  for (const row of rows) {
    const id = idOf(row);
    const raw = parentOf(row);
    parent.set(id, raw && byId.has(raw) && raw !== id ? raw : null);
  }

  // 1. parents that cannot be resolved. The *row* is real content, so it is
  // re-homed rather than dropped — pointing at a parent that is not there would
  // make it unreachable, which is indistinguishable from losing it.
  let dangling = 0;
  let selfParents = 0;
  for (const row of rows) {
    const raw = parentOf(row);
    if (raw === null) continue;
    if (raw === idOf(row)) {
      setParent(row, null);
      selfParents += 1;
      continue;
    }
    if (!byId.has(raw)) {
      setParent(row, null);
      dangling += 1;
    }
  }
  if (dangling > 0) {
    repairs.push(`${dangling} ${label}(s) had a parent that is not in this backup and became top-level.`);
  }
  if (selfParents > 0) repairs.push(`${selfParents} ${label}(s) were their own parent and became top-level.`);

  // 2. cycles. Each node has at most one parent, so the graph is a set of
  // disjoint loops with trees hanging off them; breaking one member of each
  // loop frees every node that fed into it.
  const cycles = findCycles(order, parent);
  if (cycles.length > 0) {
    for (const cycle of cycles) {
      // Deterministic: the member that appears first in the file keeps its data
      // and loses only the parent edge that closed the loop.
      const target = order.find((id) => cycle.has(id));
      if (target) {
        parent.set(target, null);
        const row = byId.get(target);
        if (row) setParent(row, null);
      }
    }
    repairs.push(
      `${cycles.length} ${label} loop(s) were found (a ${label} contained itself through its parents) and were broken.`,
    );
  }

  // 3. depth. Walk in ascending depth so lifting one row also lifts its subtree.
  const depthOf = (id: string): number => {
    let depth = 0;
    let cursor = parent.get(id) ?? null;
    const guard = new Set<string>([id]);
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      depth += 1;
      cursor = parent.get(cursor) ?? null;
    }
    return depth;
  };

  const ordered = [...order].sort((a, b) => depthOf(a) - depthOf(b));
  let tooDeep = 0;
  for (const id of ordered) {
    // A root sits at 0; the deepest allowed node sits at `maxDepth - 1`, so a
    // node is out of range when its own depth reaches `maxDepth`.
    if (depthOf(id) >= maxDepth) {
      parent.set(id, null);
      const row = byId.get(id);
      if (row) setParent(row, null);
      tooDeep += 1;
    }
  }
  if (tooDeep > 0) {
    repairs.push(`${tooDeep} ${label}(s) were nested deeper than Stash allows and were lifted to the top level.`);
  }

  return repairs;
}

/** Every distinct loop in a parent-pointer graph. */
function findCycles(order: readonly string[], parent: ReadonlyMap<string, string | null>): Set<string>[] {
  const state = new Map<string, 'unvisited' | 'active' | 'done'>();
  const cycles: Set<string>[] = [];
  const seenCycles = new Set<string>();

  for (const start of order) {
    if (state.get(start) === 'done') continue;
    const path: string[] = [];
    const index = new Map<string, number>();
    let cursor: string | null = start;

    while (cursor !== null && state.get(cursor) !== 'done') {
      const at = index.get(cursor);
      if (at !== undefined) {
        const loop = path.slice(at);
        const key = [...loop].sort().join('\u0000');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push(new Set(loop));
        }
        break;
      }
      if (state.get(cursor) === 'active') break;
      state.set(cursor, 'active');
      index.set(cursor, path.length);
      path.push(cursor);
      cursor = parent.get(cursor) ?? null;
    }
    for (const id of path) state.set(id, 'done');
  }

  return cycles;
}

/**
 * Read portable settings, filling in anything absent.
 *
 * A missing or malformed preference is never a reason to refuse a backup: the
 * vault is the point, and the settings have safe defaults.
 */
function readSettings(value: unknown, repairs: string[]): PortableSettings {
  if (!isPlainObject(value)) {
    repairs.push('No settings were included, so this device’s own preferences are kept.');
    return { ...DEFAULT_PORTABLE_SETTINGS };
  }

  const theme = value.themeMode;
  const policy = value.relockPolicy;

  return {
    themeMode: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_PORTABLE_SETTINGS.themeMode,
    // An unrecognised policy degrades to the *strictest* one. Guessing "15m" for
    // a value written by a newer build would quietly weaken a device's lock.
    relockPolicy: isRelockPolicy(policy) ? (policy as RelockPolicy) : DEFAULT_PORTABLE_SETTINGS.relockPolicy,
    sessionEndPolicy:
      value.sessionEndPolicy === 'tab-change' || value.sessionEndPolicy === 'app-close'
        ? value.sessionEndPolicy
        : DEFAULT_PORTABLE_SETTINGS.sessionEndPolicy,
    lockApp: typeof value.lockApp === 'boolean' ? value.lockApp : DEFAULT_PORTABLE_SETTINGS.lockApp,
    secureScreen: typeof value.secureScreen === 'boolean' ? value.secureScreen : DEFAULT_PORTABLE_SETTINGS.secureScreen,
    biometric: typeof value.biometric === 'boolean' ? value.biometric : DEFAULT_PORTABLE_SETTINGS.biometric,
    lastFolderId: typeof value.lastFolderId === 'string' ? value.lastFolderId : null,
    recentFolderIds: Array.isArray(value.recentFolderIds)
      ? value.recentFolderIds.filter((id): id is string => typeof id === 'string').slice(0, 5)
      : [],
  };
}

/** Where a `{ folderId }` destination points in a backup, for import planning. */
export function destinationExists(data: BackupData, folderId: string | null): boolean {
  if (folderId === null) return true;
  return data.folders.some((folder) => folder.id === folderId);
}

/** Re-exported so callers can build a report for a decrypted payload. */
export type { ReadCollector };
