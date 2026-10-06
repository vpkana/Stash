import type { EncryptedPayload, Folder, Note, SavedLink } from '@/db/types';
import { decryptJson, encryptJson, isEncryptedPayload } from './crypto';

/**
 * What "locked" means in Stash.
 *
 * A locked folder is an **access boundary**, not a presentation state. Two
 * independent things are true of anything inside one, and both matter:
 *
 *  1. It is **sealed**. The secret fields are replaced by AES-GCM ciphertext in
 *     the database, so nothing sensitive survives in IndexedDB at rest. Sealing
 *     is not a UI trick: with no key in memory the plaintext genuinely is not
 *     present to be shown, indexed or leaked.
 *  2. It is **denied** until the person crosses that boundary. Access is granted
 *     per locked folder — see {@link canAccess} — and everything beneath a locked
 *     folder is protected exactly as if it had been locked itself.
 *
 * Inheritance is derived rather than stored, so moving an item into or out of a
 * locked folder cannot leave a record that is hidden but readable, or readable
 * but hidden. Every protected id also carries its **lock root**: the locked node
 * it belongs to. Granting that root is what unlocks it, and only that root, which
 * is what makes locking per-folder rather than per-app.
 *
 * A folder's *name* is deliberately not sealed. The name is the label on the
 * door, not what is behind it: without it a locked folder is indistinguishable
 * from every other locked folder — including in the destination picker, where
 * the user has to say which one a link is going into. What is sealed is the
 * content: links (address, title, note, snippet) and notes (title, body).
 */

/** Ids that are locked, either in their own right or through an ancestor. */
export interface Protection {
  folders: Set<string>;
  notes: Set<string>;
  links: Set<string>;
  /**
   * For every protected id in `folders`, the locked folder that protects it.
   *
   * A directly locked folder is its own root; a folder five levels beneath one
   * carries that ancestor's id. Access is decided on the root, so unlocking
   * `Private` opens `Private` and everything inside it, and nothing else.
   */
  folderRoots: Map<string, string>;
  noteRoots: Map<string, string>;
  linkRoots: Map<string, string>;
}

export const EMPTY_PROTECTION: Protection = {
  folders: new Set(),
  notes: new Set(),
  links: new Set(),
  folderRoots: new Map(),
  noteRoots: new Map(),
  linkRoots: new Map(),
};

export type ProtectedKind = 'folder' | 'note' | 'link';

export function hasAnyProtection(protection: Protection): boolean {
  return protection.folders.size > 0 || protection.notes.size > 0 || protection.links.size > 0;
}

/**
 * Walk from `id` up through `parentOf`, returning the first locked node.
 *
 * Cycles — which can only come from hand-edited or imported data — terminate
 * instead of hanging, and a node that is not protected returns `null`.
 */
function rootOf(
  id: string,
  parentOf: ReadonlyMap<string, string | null>,
  locked: ReadonlySet<string>,
): string | null {
  const guard = new Set<string>();
  let cursor: string | null = id;
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    if (locked.has(cursor)) return cursor;
    cursor = parentOf.get(cursor) ?? null;
  }
  return null;
}

/**
 * Resolve the effective lock set for the whole vault in one pass.
 *
 * Each family is walked root-down using the parent links the vault already
 * stores (`parentId`, `parentNoteId`), so a folder five levels under a locked
 * folder is protected without the user having to lock it too.
 */
export function computeProtection(
  folders: readonly Folder[],
  notes: readonly Note[],
  links: readonly SavedLink[],
): Protection {
  const lockedFolders = new Set<string>();
  for (const folder of folders) if (folder.isLocked) lockedFolders.add(folder.id);

  const folderParent = new Map<string, string | null>();
  for (const folder of folders) folderParent.set(folder.id, folder.parentId);

  const protectedFolders = new Set<string>();
  const folderRoots = new Map<string, string>();
  for (const folder of folders) {
    const root = rootOf(folder.id, folderParent, lockedFolders);
    if (!root) continue;
    protectedFolders.add(folder.id);
    folderRoots.set(folder.id, root);
  }

  const lockedNotes = new Set<string>();
  for (const note of notes) if (note.isLocked) lockedNotes.add(note.id);

  const noteParent = new Map<string, string | null>();
  for (const note of notes) noteParent.set(note.id, note.parentNoteId);

  const protectedNotes = new Set<string>();
  const noteRoots = new Map<string, string>();
  for (const note of notes) {
    const root = rootOf(note.id, noteParent, lockedNotes);
    if (!root) continue;
    protectedNotes.add(note.id);
    noteRoots.set(note.id, root);
  }

  // A link is protected when it is locked itself, or when it lives anywhere
  // inside a locked folder. A link referenced *by* a locked note is not covered:
  // links are owned by folders, and the same link may legitimately be visible in
  // the Library while a private note happens to reference it.
  const protectedLinks = new Set<string>();
  const linkRoots = new Map<string, string>();
  for (const link of links) {
    if (link.isLocked) {
      protectedLinks.add(link.id);
      linkRoots.set(link.id, link.id);
      continue;
    }
    const root = link.folderId ? folderRoots.get(link.folderId) : undefined;
    if (!root) continue;
    protectedLinks.add(link.id);
    linkRoots.set(link.id, root);
  }

  return {
    folders: protectedFolders,
    notes: protectedNotes,
    links: protectedLinks,
    folderRoots,
    noteRoots,
    linkRoots,
  };
}

function rootsFor(protection: Protection, kind: ProtectedKind): ReadonlyMap<string, string> {
  if (kind === 'folder') return protection.folderRoots;
  if (kind === 'note') return protection.noteRoots;
  return protection.linkRoots;
}

function idsFor(protection: Protection, kind: ProtectedKind): ReadonlySet<string> {
  if (kind === 'folder') return protection.folders;
  if (kind === 'note') return protection.notes;
  return protection.links;
}

/**
 * The locked node that protects `id`, or `null` when nothing does.
 *
 * This is the value a caller grants access to. It is a *folder* id for content
 * inside a locked folder and the item's own id for an individually locked link
 * or note, so one mechanism covers both without a second concept.
 */
export function lockRootOf(protection: Protection, kind: ProtectedKind, id: string): string | null {
  return rootsFor(protection, kind).get(id) ?? null;
}

/**
 * The single authorization rule for the whole app.
 *
 * Unprotected → always accessible. Protected → accessible only while the locked
 * node that guards it has been opened in this session. There is no third state:
 * nothing here blurs, hides or greys anything, it answers whether the content
 * may be read at all.
 *
 * Every route into protected content — opening a folder, a deep link, search,
 * recents, favourites, the share destination picker, navigation restoration —
 * goes through this, so a screen added later cannot get the rule subtly
 * different from the one already in place.
 */
export function canAccess(
  protection: Protection,
  granted: ReadonlySet<string>,
  kind: ProtectedKind,
  id: string,
): boolean {
  if (!idsFor(protection, kind).has(id)) return true;
  const root = lockRootOf(protection, kind, id);
  return root !== null && granted.has(root);
}

/** Ids a call must not treat as content right now. */
export interface HiddenIds {
  folders: ReadonlySet<string>;
  notes: ReadonlySet<string>;
  links: ReadonlySet<string>;
}

const EMPTY_HIDDEN: HiddenIds = {
  folders: new Set(),
  notes: new Set(),
  links: new Set(),
};

/**
 * The ids to withhold from every listing surface.
 *
 * This is the single choke point for the entire "do not leak" requirement:
 * protected ids whose lock root has not been granted are withheld; the ones
 * whose root *has* been granted are ordinary content again, in this session
 * only. Deriving it from {@link Protection} means a listing surface cannot get
 * the rule subtly different — it either consults this or it is operating on
 * already-filtered data.
 */
export function hiddenIds(protection: Protection, granted: ReadonlySet<string>): HiddenIds {
  if (!hasAnyProtection(protection)) return EMPTY_HIDDEN;

  const withhold = (kind: ProtectedKind): ReadonlySet<string> => {
    const ids = idsFor(protection, kind);
    if (ids.size === 0) return ids;
    const roots = rootsFor(protection, kind);
    const out = new Set<string>();
    for (const id of ids) {
      const root = roots.get(id);
      if (!root || !granted.has(root)) out.add(id);
    }
    return out;
  };

  return {
    folders: withhold('folder'),
    notes: withhold('note'),
    links: withhold('link'),
  };
}

export function isHidden(hidden: HiddenIds, kind: ProtectedKind, id: string): boolean {
  if (kind === 'folder') return hidden.folders.has(id);
  if (kind === 'note') return hidden.notes.has(id);
  return hidden.links.has(id);
}

/**
 * A protected link with everything readable stripped out.
 *
 * The seal protects the database; this protects *memory*.
 *
 * Those are different threats and the second one is easy to miss: the vault
 * holds a single key, so while any boundary is open the ciphertext of every
 * other sealed row decrypts too. Without this, the plaintext of a folder the
 * user has not opened would be sitting in the store, and the only thing standing
 * between it and the screen would be a component remembering to check. That is
 * exactly the class of bug that let a newly locked folder leak: one code path
 * disagreed and the content was right there to disagree about.
 *
 * After this, a withheld row has no address, title, note or snippet anywhere in
 * the app's memory — so a screen that forgets the check renders nothing, and the
 * only way to read the content is to cross the boundary, which re-reads it.
 *
 * Structural fields are deliberately kept: `id`, `folderId`, `createdAt`, the
 * flags and the counts. They are what lets the row exist on screen at all, and
 * what a lock badge and a "Tap to unlock" affordance are built from.
 */
export function redactLink(link: SavedLink): SavedLink {
  const redacted: SavedLink = { ...link, url: '', normalizedUrl: '' };
  delete redacted.title;
  delete redacted.description;
  delete redacted.userNote;
  delete redacted.rawText;
  delete redacted.source;
  return redacted;
}

/** The note equivalent of {@link redactLink}. */
export function redactNote(note: Note): Note {
  return { ...note, title: '', content: '' };
}

export function emptyHidden(): HiddenIds {
  return EMPTY_HIDDEN;
}

/**
 * Every distinct lock root in the vault.
 *
 * Granting all of them is the same as "nothing is withheld", which is what the
 * tests use to state the contrast case — and what a future "open everything in
 * this session" action would pass. It is derived from the maps rather than from
 * the id sets, because two folders behind the same lock are one boundary, and
 * counting them twice would confuse any caller reasoning about boundaries.
 */
export function allLockRoots(protection: Protection): Set<string> {
  return new Set([
    ...protection.folderRoots.values(),
    ...protection.noteRoots.values(),
    ...protection.linkRoots.values(),
  ]);
}

// ---------------------------------------------------------------------------
// Sealing
//
// The persisted shapes below are the *only* place a secret is allowed to become
// ciphertext. Each pair is symmetric: sealing blanks the plaintext fields and
// stores the payload; opening restores them and drops the payload, so an
// in-memory object never carries both.
// ---------------------------------------------------------------------------

interface NoteSecret {
  title: string;
  content: string;
}

interface LinkSecret {
  url: string;
  normalizedUrl: string;
  title?: string;
  description?: string;
  userNote?: string;
  rawText?: string;
  source?: string;
}

/** True when a row on disk is ciphertext rather than plaintext. */
export function isSealed(row: { enc?: EncryptedPayload }): boolean {
  return isEncryptedPayload(row.enc);
}

/**
 * Seal a note.
 *
 * Throws when no key is available. That is intentional: silently writing
 * plaintext for an item the user believes is locked would be the worst possible
 * failure, so the write is refused instead.
 */
export async function sealNote(note: Note, key: CryptoKey | null): Promise<Note> {
  if (isSealed(note)) return note;
  if (!key) throw new Error('Cannot lock a note while the vault is locked.');
  const secret: NoteSecret = { title: note.title, content: note.content };
  return { ...note, title: '', content: '', enc: await encryptJson(key, secret) };
}

/** Restore a note's plaintext. Without a key the blanked fields stay blank. */
export async function openNote(note: Note, key: CryptoKey | null): Promise<Note> {
  if (!isSealed(note)) return note;
  if (!key) return { ...note, title: '', content: '' };
  const secret = await decryptJson<NoteSecret>(key, note.enc as EncryptedPayload);
  const opened: Note = { ...note, title: secret.title, content: secret.content };
  delete opened.enc;
  return opened;
}

/**
 * Seal a link.
 *
 * The address goes in with everything else, so a sealed link leaves no URL, no
 * domain and no title readable in the database. `normalizedUrl` is blanked too:
 * dedupe must not report "you already saved this" from behind a lock, because
 * that answer would itself disclose a locked item's existence.
 */
export async function sealLink(link: SavedLink, key: CryptoKey | null): Promise<SavedLink> {
  if (isSealed(link)) return link;
  if (!key) throw new Error('Cannot lock a link while the vault is locked.');
  const secret: LinkSecret = { url: link.url, normalizedUrl: link.normalizedUrl };
  if (link.title !== undefined) secret.title = link.title;
  if (link.description !== undefined) secret.description = link.description;
  if (link.userNote !== undefined) secret.userNote = link.userNote;
  if (link.rawText !== undefined) secret.rawText = link.rawText;
  if (link.source !== undefined) secret.source = link.source;

  const sealed: SavedLink = { ...link, url: '', normalizedUrl: '', enc: await encryptJson(key, secret) };
  delete sealed.title;
  delete sealed.description;
  delete sealed.userNote;
  delete sealed.rawText;
  delete sealed.source;
  return sealed;
}

export async function openLink(link: SavedLink, key: CryptoKey | null): Promise<SavedLink> {
  if (!isSealed(link)) return link;
  if (!key) return link;
  const secret = await decryptJson<LinkSecret>(key, link.enc as EncryptedPayload);
  const opened: SavedLink = { ...link, url: secret.url, normalizedUrl: secret.normalizedUrl };
  delete opened.enc;
  if (secret.title !== undefined) opened.title = secret.title;
  if (secret.description !== undefined) opened.description = secret.description;
  if (secret.userNote !== undefined) opened.userNote = secret.userNote;
  if (secret.rawText !== undefined) opened.rawText = secret.rawText;
  if (secret.source !== undefined) opened.source = secret.source;
  return opened;
}

interface FolderSecret {
  name: string;
  icon?: string;
}

/**
 * Restore a folder's legacy sealed name.
 *
 * Folder names are no longer sealed — the name is the label that makes the lock
 * usable ("Private" versus an anonymous "Locked folder", and the only way to
 * tell two locked folders apart in the destination picker). Rows written by an
 * earlier build still carry a sealed name, so this stays readable and
 * `reconcileProtection` opens them once a key is available.
 */
export async function openFolder(folder: Folder, key: CryptoKey | null): Promise<Folder> {
  if (!isSealed(folder)) return folder;
  if (!key) return folder;
  const secret = await decryptJson<FolderSecret>(key, folder.enc as EncryptedPayload);
  const opened: Folder = { ...folder, name: secret.name };
  delete opened.enc;
  if (secret.icon !== undefined) opened.icon = secret.icon;
  return opened;
}

/**
 * Restore every secret in a vault read. Used by the snapshot path, which is the
 * only way the UI ever sees data, so decryption happens in exactly one place.
 */
export interface RawVault {
  folders: Folder[];
  notes: Note[];
  links: SavedLink[];
}

/**
 * Open as much of a vault read as will open.
 *
 * This is the lenient counterpart to the strict openers above, and the
 * difference is deliberate:
 *
 *  - on a *write* path the strict behaviour is required, because editing a row
 *    that failed to decrypt would overwrite content we could not read;
 *  - on a *read* path one unopenable row must not take down the whole vault.
 *
 * That second case is not hypothetical: importing a backup from a device with a
 * different keyring can bring in ciphertext this device holds no key for. The
 * honest outcomes there are "show it as locked" or "refuse the whole read", and
 * refusing would make an unrelated backup unopenable. So the row keeps its
 * ciphertext, its fields stay blank, and the UI presents it as locked rather
 * than pretending it is empty.
 */
export async function openVault(raw: RawVault, key: CryptoKey | null): Promise<RawVault> {
  const attempt = async <T>(row: T, open: (value: T, k: CryptoKey | null) => Promise<T>): Promise<T> => {
    try {
      return await open(row, key);
    } catch (error) {
      console.warn('[stash] could not open a sealed record', error);
      return row;
    }
  };

  const [folders, notes, links] = await Promise.all([
    Promise.all(raw.folders.map((folder) => attempt(folder, openFolder))),
    Promise.all(raw.notes.map((note) => attempt(note, openNote))),
    Promise.all(raw.links.map((link) => attempt(link, openLink))),
  ]);
  return { folders, notes, links };
}
