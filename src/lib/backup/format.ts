import type {
  EncryptedPayload,
  ExportedKeyring,
  Folder,
  LinkTag,
  Note,
  NoteLink,
  RelockPolicy,
  SavedLink,
  SessionEndPolicy,
  Tag,
} from '@/db/types';

/**
 * The backup format.
 *
 * A backup is the user's data, in a shape that belongs to the user rather than
 * to the app. Three properties drive every decision in this module:
 *
 *  1. **Self-describing.** `format`, `version`, `appVersion`, `exportedAt` and
 *     `mode` are all readable from the file itself, so a person can tell what
 *     they are holding and an import can tell whether it must migrate, refuse or
 *     proceed — before anything touches the database.
 *  2. **Versioned and forward-compatible.** The version is a single integer and
 *     the reader is explicit about which versions it understands. A file from a
 *     newer build is refused with a clear message instead of being half-read.
 *  3. **Explicit about its own sensitivity.** `mode` says whether the file holds
 *     ciphertext, plaintext, or an encrypted payload. A backup that contains the
 *     user's locked content in the clear says so in the file, so nobody has to
 *     guess later how careful to be with it.
 */

export const BACKUP_FORMAT = 'stash-backup' as const;

/**
 * The format revision this build writes.
 *
 * Bump it only for a change a previous reader could not interpret. Adding an
 * optional field is not such a change; renaming or repurposing one is.
 */
export const BACKUP_VERSION = 1 as const;

/**
 * How locked content is represented in a file.
 *
 * - `sealed`   — locked items travel exactly as they are stored: AES-GCM
 *                ciphertext, plus the passcode-wrapped keyring so a restore can
 *                still open them. Requires the Stash passcode to read.
 * - `plaintext`— every item is opened first. The file is a complete, readable
 *                copy of the vault, locked items included. Requires nothing to
 *                read, which is exactly why it is opt-in and labelled.
 * - `encrypted`— the whole payload is encrypted under a *separate* backup
 *                passphrase, so a file can be handed over or stored without
 *                exposing locked items and without depending on a device
 *                keyring. Requires that passphrase to read.
 */
export type BackupMode = 'sealed' | 'plaintext' | 'encrypted';

export const BACKUP_MODES: ReadonlyArray<{ id: BackupMode; label: string; description: string }> = [
  {
    id: 'sealed',
    label: 'As stored (recommended)',
    description: 'Locked items stay encrypted. Needs your Stash passcode to read them.',
  },
  {
    id: 'encrypted',
    label: 'Encrypted with a passphrase',
    description: 'The whole backup is encrypted with a passphrase you choose for the file.',
  },
  {
    id: 'plaintext',
    label: 'Everything readable',
    description: 'Locked items are decrypted into the file. Anyone with the file sees everything.',
  },
];

/**
 * Settings that travel with a backup.
 *
 * These are *preferences*, chosen deliberately and worth carrying to a new
 * device. Device bookkeeping is excluded on purpose:
 *
 *  - `db.schemaInfo` is rebuilt on arrival, and importing it would lie about the
 *    schema a database is actually at; the legacy `db.seeded` flag is ignored;
 *  - `notes.lastNoteId` and the collapsed/draft UI state are where *this* phone
 *    happened to be looking, which is not something to impose on another one.
 */
export interface PortableSettings {
  themeMode: 'light' | 'dark' | 'system';
  relockPolicy: RelockPolicy;
  sessionEndPolicy: SessionEndPolicy;
  lockApp: boolean;
  secureScreen: boolean;
  biometric: boolean;
  /** Last capture destination, so the Save sheet opens where it left off. */
  lastFolderId: string | null;
  /** Remembered capture destinations. */
  recentFolderIds: string[];
}

/** The vault itself. Everything here is source-of-truth user data. */
export interface BackupData {
  folders: Folder[];
  links: SavedLink[];
  tags: Tag[];
  /** link <-> tag join rows. */
  linkTags: LinkTag[];
  notes: Note[];
  /** note <-> link join rows. */
  noteLinks: NoteLink[];
  settings: PortableSettings;
}

/**
 * A counts-and-flags summary so a file can be described without being opened.
 *
 * Advisory only: validation recomputes every number from the data it reads and
 * never trusts these. They exist so a user can see what a file holds before
 * deciding to restore it, and so a stale summary can never affect behaviour.
 */
export interface BackupSummary {
  folders: number;
  links: number;
  tags: number;
  notes: number;
  linkTags: number;
  noteLinks: number;
  favorites: number;
  archived: number;
  sealedItems: number;
}

/**
 * The outer envelope.
 *
 * Deliberately separate from the payload: for an `encrypted` backup everything
 * below `kdf`/`payload` is ciphertext, while these fields stay readable so the
 * app can identify the file and know which passphrase to ask for.
 */
export interface StashBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** ISO 8601. A string, not an epoch number, so the file reads like a document. */
  exportedAt: string;
  appVersion: string;
  mode: BackupMode;
  summary: BackupSummary;
  /** Present for `sealed` and `plaintext` backups. */
  data?: BackupData;
  /** Present for `encrypted` backups. */
  kdf?: { algorithm: 'PBKDF2-SHA256'; salt: string; iterations: number };
  /** Present for `encrypted` backups: the sealed JSON of `BackupData`. */
  payload?: EncryptedPayload;
  /**
   * The passcode-wrapped vault key, present when the export included sealed
   * rows. Without it, sealed rows in the file cannot be opened anywhere — which
   * is a supported outcome, just a documented one.
   */
  security?: { keyring: ExportedKeyring };
}

export const EMPTY_BACKUP_SUMMARY: BackupSummary = {
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

/**
 * A conservative ceiling for a file we will try to parse.
 *
 * Not a product limit — a personal vault is a few megabytes — but a malformed or
 * hostile file should fail with a clear message instead of exhausting memory.
 */
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

/** `stash-backup-2026-09-27.json` */
export function backupFileName(at = new Date()): string {
  const iso = at.toISOString().slice(0, 10);
  return `stash-backup-${iso}.json`;
}

export function summarizeBackup(data: BackupData): BackupSummary {
  const sealed = (row: { enc?: EncryptedPayload }) => Boolean(row.enc);
  return {
    folders: data.folders.length,
    links: data.links.length,
    tags: data.tags.length,
    notes: data.notes.length,
    linkTags: data.linkTags.length,
    noteLinks: data.noteLinks.length,
    favorites:
      data.folders.filter((folder) => folder.isFavorite).length +
      data.links.filter((link) => link.isFavorite).length +
      data.notes.filter((note) => note.isFavorite).length,
    archived: data.links.filter((link) => link.isArchived).length + data.notes.filter((note) => note.isArchived).length,
    sealedItems: data.folders.filter(sealed).length + data.links.filter(sealed).length + data.notes.filter(sealed).length,
  };
}

export function emptyBackupData(settings: PortableSettings): BackupData {
  return { folders: [], links: [], tags: [], linkTags: [], notes: [], noteLinks: [], settings };
}
