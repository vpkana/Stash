/**
 * Persisted entity types.
 *
 * Nesting is always expressed through `parentId`, never by encoding a path
 * into a string such as `"Development/React/Tutorials"`. That choice is what
 * lets folders rename and move without rewriting descendants, and it is why
 * duplicate detection can answer "already saved in Development -> React"
 * without parsing anything.
 */

/**
 * An authenticated ciphertext produced by the platform's AES-GCM.
 *
 * `ct` is ciphertext *with* the GCM authentication tag appended, so a tampered
 * record fails to decrypt instead of silently returning altered plaintext. The
 * shape carries no key material: the key lives in the keyring, never here.
 */
export interface EncryptedPayload {
  /** Payload format version, so the envelope can evolve without guessing. */
  v: 1;
  /** Always the platform primitive. Stash never defines its own cipher. */
  alg: 'AES-GCM';
  /** Base64 of the random 96-bit nonce. Unique per encryption, never reused. */
  iv: string;
  /** Base64 of ciphertext + authentication tag. */
  ct: string;
}

/**
 * Fields every row that can be thrown away carries.
 *
 * Deleting is a two-step thing in Stash, and the data model says so rather than
 * hiding it behind a separate "trash" table:
 *
 *  - `deletedAt` marks a row as thrown away. It is *still a real row* — with its
 *    id, its place in the hierarchy and its content — which is what makes
 *    restoring it exact rather than approximate. Absent means live, so rows
 *    written before the trash existed are live by definition and nothing had to
 *    be rewritten to introduce it.
 *  - `trashBatch` records what was thrown away *together*. Deleting a folder is
 *    one act, so the folder and everything beneath it share a batch and come
 *    back as one thing. A single link is a batch of one.
 *
 * The alternative — moving rows into a `trash` table — would mean either
 * duplicating the hierarchy or flattening it, and every reference pointing into
 * the trash would have to be rewritten and un-rewritten. Two columns on the row
 * itself keep a deleted folder a folder.
 */
export interface Trashable {
  /** Epoch ms when the row was thrown away. Absent means it is live. */
  deletedAt?: number;
  /** Rows thrown away in the same act share this id, so they return together. */
  trashBatch?: string;
}

export interface Folder extends Trashable {
  id: string;
  /** Null means a top-level folder. */
  parentId: string | null;
  /** Blank when the folder is sealed. */
  name: string;
  /** Lucide icon name, resolved at render time so icons stay declarative. */
  icon?: string;
  createdAt: number;
  updatedAt: number;
  sortOrder: number;
  isFavorite: boolean;
  /** Locked against viewing until the session is unlocked. */
  isLocked: boolean;
  /**
   * Sealed `{ name, icon }`. Present exactly when the folder is effectively
   * locked; `name` and `icon` are blanked while it is.
   */
  enc?: EncryptedPayload;
}

export interface SavedLink extends Trashable {
  id: string;
  /** Null means the link lives in the Inbox rather than a user folder. */
  folderId: string | null;
  /**
   * The URL exactly as it was captured. Never rewritten, never normalized in
   * place, and kept even when the address stops working: the record of what you
   * meant to keep is the whole point of the row. `normalizedUrl` exists only to
   * catch duplicates and never replaces this.
   */
  url: string;
  /**
   * Conservative canonical form used only for duplicate detection.
   * Indexed so dedupe is a lookup, not a scan.
   */
  normalizedUrl: string;
  title?: string;
  description?: string;
  userNote?: string;
  /** Domain the link came from, e.g. `youtube.com`. */
  source?: string;
  /** Android package that produced the share, when known. */
  sourcePackage?: string;
  /** Verbatim shared text, preserved for provenance. */
  rawText?: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  isFavorite: boolean;
  isArchived: boolean;
  /**
   * Marked by the user as no longer reachable.
   *
   * Set by hand, never by a background check: Stash does not poll the network,
   * so it cannot know on its own that a page died, and pretending otherwise
   * would be a guess presented as a fact. The link stays where it is and stays
   * findable — a dead link is still the thing you remembered.
   */
  isUnavailable?: boolean;
  unavailableAt?: number;
  /** Locked against viewing until the session is unlocked. */
  isLocked: boolean;
  /**
   * Sealed `{ url, normalizedUrl, title, description, userNote, rawText,
   * source }`. Present exactly when the link is effectively locked, and those
   * fields are blanked while it is — so a sealed link leaves no address, no
   * title and no snippet behind in the database.
   */
  enc?: EncryptedPayload;
}

export interface Tag {
  id: string;
  name: string;
}

/**
 * A note in the knowledge tree.
 *
 * Structure is expressed by `parentNoteId` exactly as folders use `parentId`.
 * Child notes are never embedded in their parent: a note row stays small and
 * predictable no matter how deep the tree goes, and moving a subtree is a
 * single field update instead of rewriting a nested document.
 */
export interface Note extends Trashable {
  id: string;
  /** Null means a top-level note. */
  parentNoteId: string | null;
  title: string;
  /**
   * Markdown. Kept as plain text so it exports cleanly, renders on any device,
   * and is never locked into an editor's internal document format.
   */
  content: string;
  createdAt: number;
  updatedAt: number;
  sortOrder: number;
  isFavorite: boolean;
  isArchived: boolean;
  /** Locked against viewing until the session is unlocked. */
  isLocked: boolean;
  /**
   * Sealed `{ title, content }`. Present exactly when the note is effectively
   * locked; both fields are blanked while it is, so an encrypted note cannot
   * leak a title, an opening line or a checklist count.
   */
  enc?: EncryptedPayload;
}

/** How a note and a saved link came to be connected. */
export type NoteLinkOrigin = 'created-from' | 'attached';

/**
 * A reference from a note to a saved link.
 *
 * Links are referenced by id rather than copied, so a note points at the one
 * canonical record: editing the link's title or moving it to another folder is
 * reflected everywhere it is referenced, and deleting a note can never delete
 * the link it was thinking about.
 */
export interface NoteLink {
  noteId: string;
  linkId: string;
  /** `created-from` records that the note was born from this link. */
  origin: NoteLinkOrigin;
  createdAt: number;
  sortOrder: number;
}

export interface LinkTag {
  linkId: string;
  tagId: string;
}

/** Single-row-per-key settings store: theme, recents, schema bookkeeping. */
export interface MetaRow {
  key: string;
  value: unknown;
}

/** Same single-row-per-key shape as `MetaRow`, in its own table on purpose. */
export interface SecurityRow {
  key: string;
  value: unknown;
}

export const META_KEYS = {
  themeMode: 'theme.mode',
  recentFolders: 'capture.recentFolders',
  lastFolderId: 'capture.lastFolderId',
  seeded: 'db.seeded',
  schemaInfo: 'db.schemaInfo',
  /** Remembers the last note the user was reading, so Notes reopens in place. */
  lastNoteId: 'notes.lastNoteId',
  /** Collapsed/expanded state is per-device UI state, not vault data. */
  draftNoteId: 'notes.draftId',
  /**
   * Non-secret privacy preferences. Deliberately contains no passcode, no key
   * and no verifier: knowing this row tells an attacker nothing they could not
   * learn from the lock screen itself.
   */
  privacySettings: 'privacy.settings',
} as const;

/**
 * Keys for the `security` table.
 *
 * Kept separate from `META_KEYS` because this table is the one place in the app
 * that holds wrapping material, and it is excluded from export, import, the
 * in-memory snapshot and the search index by construction rather than by
 * remembering to filter it.
 */
export const SECURITY_KEYS = {
  keyring: 'privacy.keyring',
  /**
   * The WebAuthn credential this device enrolled for the unlock prompt. Not a
   * secret — it is an identifier, and the authenticator keeps the private half —
   * but it belongs here so it never travels in a backup: a credential enrolled
   * on this machine is meaningless on another one.
   */
  deviceCredential: 'privacy.deviceCredential',
} as const;

/**
 * How long an unlocked session used to be allowed to last.
 *
 * **Legacy only.** The session is no longer configurable: it ends on the next tab
 * change and the moment the app stops being the visible one, because a key that is
 * still in memory later than that was never really protected. The type and the
 * `relockPolicy` field survive so a vault — and a backup file — written by an
 * earlier build still loads and validates.
 */
export type RelockPolicy = 'immediate' | '1m' | '5m' | '15m';

export interface PrivacySettings {
  /** True once a keyring exists, i.e. locking content is possible at all. */
  enabled: boolean;
  /**
   * Legacy only: read from old rows and backups, never acted on. See
   * {@link RelockPolicy}.
   */
  relockPolicy: RelockPolicy;
  /**
   * Legacy only. This used to mean "show a lock screen over the whole app while
   * locked", which is no longer a thing Stash does: there is no app password and
   * no gate over the app. Locked items hide themselves and tapping one raises the
   * system prompt. Kept so an old settings row (and a backup carrying it) still
   * round-trips.
   */
  lockApp: boolean;
  /**
   * Ask Android to block screenshots and the app-switcher thumbnail while the
   * vault is unlocked. Android-only, and ignored everywhere else — see
   * `lib/privacy/screen.ts`, which reports whether it can be honoured here. It is
   * enforced independently of this flag while the vault is locked, and it never
   * gates access to anything: switching it on locks nothing.
   */
  secureScreen: boolean;
  /** Whether the device prompt is part of the way in. */
  biometric: boolean;
}

/**
 * Locked content by default, and the device prompt as the way to read it.
 *
 * Nothing here decides whether the app is usable: it always is. Screen privacy is
 * the only opt-in, because it blocks screenshots, which is a real cost most users
 * have not asked for.
 */
export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  enabled: false,
  relockPolicy: 'immediate',
  lockApp: true,
  secureScreen: false,
  biometric: true,
};

/** Wrapped (never raw) key material. Everything here is ciphertext or public. */
export interface KeyringRecord {
  version: 1;
  /**
   * Parameters needed to re-derive a passcode's wrapping key.
   *
   * **Legacy only.** A vault set up today is opened by the device lock alone and
   * has neither this nor `wrappedByPasscode` — locking without a Stash passcode
   * is the supported setup, not a degraded one. They are still read, because a
   * vault created by an earlier build (and a backup it wrote) is opened this way
   * and nothing about that content can be recovered any other way.
   */
  kdf?: {
    algorithm: 'PBKDF2-SHA256';
    /** Base64 salt. Public by design; a salt is not a secret. */
    salt: string;
    iterations: number;
  };
  /**
   * Legacy only: the vault key sealed under the passcode-derived key, for vaults
   * that predate device-only locking. Nothing writes it any more.
   */
  wrappedByPasscode?: EncryptedPayload;
  /**
   * The vault key sealed under a random key held in platform secure storage —
   * the Android Keystore on a phone, or the app's own security table on a
   * desktop, where there is no keystore to reach for. Device-bound: never
   * exported.
   */
  wrappedByDevice?: EncryptedPayload;
  createdAt: number;
  updatedAt: number;
}

/** The subset of the keyring that is safe and useful to travel in a backup. */
export interface ExportedKeyring {
  version: 1;
  kdf: KeyringRecord['kdf'];
  wrappedByPasscode: EncryptedPayload;
}

/**
 * A row as it arrives from a backup file.
 *
 * The lock flag is optional here and only here, because that is the truth about
 * the format: a file written by version 1 predates `isLocked` on links entirely,
 * and a file written by version 2 predates notes. Typing the wire format as the
 * internal shape would be a lie that the importer would then have to defend
 * against at runtime; typing it honestly means the default-to-unlocked decision
 * is made in one place, visibly, in `normalize*`.
 */
export interface IncomingFolder extends Omit<Folder, 'isLocked'> {
  isLocked?: boolean;
}
export interface IncomingNote extends Omit<Note, 'isLocked'> {
  isLocked?: boolean;
}
export interface IncomingLink extends Omit<SavedLink, 'isLocked'> {
  isLocked?: boolean;
}

export interface ExportBundle {
  format: 'stash-export';
  /**
   * 2 added `notes` and `noteLinks`. 3 added the privacy keyring envelope and,
   * with it, sealed (`enc`) rows whose secret fields are ciphertext. Version 1
   * files still import: the note collections and keyring are simply absent.
   */
  version: 1 | 2 | 3;
  exportedAt: number;
  folders: IncomingFolder[];
  links: IncomingLink[];
  tags: Tag[];
  linkTags: LinkTag[];
  notes?: IncomingNote[];
  noteLinks?: NoteLink[];
  meta: MetaRow[];
  /**
   * The passcode-wrapped vault key, so a restore on a new device can still be
   * unlocked — with the same passcode. Only ciphertext is ever written here, and
   * the device-bound wrapping is deliberately omitted: it is meaningless off the
   * device that created it.
   *
   * Absent for a vault locked with the device prompt alone: there is no portable
   * key to hand over, and the receiving device is told so rather than left with a
   * keyring that would promise an unlock it cannot perform.
   */
  security?: { keyring?: ExportedKeyring };
}

/**
 * One thing in the trash.
 *
 * A batch is the unit the user thinks in — "the folder I deleted", "that link" —
 * so it is also the unit the UI lists, restores and purges. The counts describe
 * what else came along with the root row.
 */
export interface TrashEntry {
  batch: string;
  /** What the batch was made of when it was thrown away. */
  kind: 'folder' | 'link' | 'note';
  /** The row the user actually deleted. */
  rootId: string;
  /** Its name or title as it was at the time. */
  label: string;
  deletedAt: number;
  folderCount: number;
  linkCount: number;
  noteCount: number;
  /** Where the root sat, so the trash entry can say where it came from. */
  path: string;
}

/** What a trash operation actually touched. */
export interface TrashImpact {
  folders: number;
  links: number;
  notes: number;
  /** Rows that had to be re-homed because their parent was gone for good. */
  rehomed: number;
}

/** A note plus the counts needed to describe the cost of deleting it. */
export interface NoteDeletionImpact {
  noteId: string;
  noteTitle: string;
  /** Direct children that would be affected. */
  childNoteCount: number;
  /** Every note below this one. */
  descendantNoteCount: number;
  /** Links referenced by this note or its subtree. Never deleted, only unlinked. */
  referencedLinkCount: number;
  /** Where children go when the user chooses "keep the subnotes". */
  newParentId: string | null;
}

/** A folder plus the counts needed to describe the cost of deleting it. */
export interface FolderDeletionImpact {
  folderId: string;
  folderName: string;
  childFolderCount: number;
  descendantFolderCount: number;
  directLinkCount: number;
  descendantLinkCount: number;
  /** Where contents move when the user chooses "move contents up". */
  newParentId: string | null;
}
