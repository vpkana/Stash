import type { Folder, LinkTag, Note, NoteLink, SavedLink, Tag } from '@/db/types';
import type { VaultSnapshot } from '@/lib/search';
import { isSealed } from '@/lib/privacy/protection';
import { normalizeUrl } from '@/lib/url/normalize';
import { newId as defaultNewId } from '@/db/id';
import type { BackupData, PortableSettings } from './format';

/**
 * Planning an import before performing one.
 *
 * The plan is a pure value: given a validated backup and what is currently in
 * the database, it says exactly which rows would be written, which would be left
 * alone, and what would be merged into what. Nothing here touches IndexedDB, so
 * the consequences of a restore can be shown, tested, and explained *before* any
 * destructive step is taken — which is the only way a confirmation dialog can be
 * honest.
 *
 * ## Merge is a merge, not only a collision check
 *
 * Merge used to be implemented as one rule: *an id that already exists is left
 * exactly as it is.* That single rule gives every guarantee that matters — no
 * duplicate ids, no broken references, no half-updated records, and importing
 * the same file twice is a no-op — but it is blind to the case it was written
 * for and does not cover. A backup taken on another device (or from the same
 * device before a reinstall) carries *different ids for the same folders*, so
 * nothing collided and the import created a second `Development`, a second
 * `Entertainment`, and a second `Reading` beside the ones already there.
 *
 * A merge now matches on **identity** first, and only then on id:
 *
 *  - a **folder** is identified by its normalized name *under its matched
 *    parent*, so `Development/React` merges with `Development/React` and stays
 *    distinct from `Learning/React`;
 *  - a **link** is identified by its canonical URL *within its matched folder*,
 *    which is the same identity the capture flow already dedupes on — and it
 *    deliberately does not merge across folders, because the same page saved in
 *    two places is a decision the user already made;
 *  - a **note** is identified by its matched parent *and* its title *and* its
 *    body. Title alone is not identity: two notes called `Meeting` with
 *    different content are two notes, and collapsing them would be silent data
 *    loss;
 *  - a **tag** is identified by its normalized name.
 *
 * Everything that follows from the old rule still holds, and is what the
 * property tests below assert:
 *
 *  - an existing row is **never overwritten** and never has its id rewritten;
 *  - an incoming row that matches an existing one is **not written**, and the
 *    incoming id is *mapped* to the local one so children and join rows follow
 *    it;
 *  - an incoming row whose id is taken by a **different** record is inserted
 *    under a fresh local id rather than being skipped, so unique content is
 *    never dropped just because an id happened to collide;
 *  - the whole thing is idempotent: importing the same file twice changes
 *    nothing the second time, because by then every row matches by identity.
 *
 * ## Sealed rows have no identity
 *
 * A sealed folder has no readable name, a sealed link no readable address, a
 * sealed note neither title nor body — that is the point of sealing. Their
 * identity cannot be derived, so they fall back to the id rule: an id that is
 * already here means "this is the row we already have". The alternative would be
 * inventing an identity out of ciphertext, and two devices' keys differ, so a
 * blind insert would just as often duplicate as dedupe. The import screen says
 * which mode is in play when a backup contains sealed rows.
 *
 * ## Replace
 *
 * Replace writes exactly what is in the backup and nothing else. It is the only
 * mode that reproduces the original vault exactly, which is why it is the mode
 * for "my phone died, put my data back" — and it is the mode that takes a safety
 * copy first.
 */

export type ImportMode = 'merge' | 'replace';

export const JOIN_SEPARATOR = '\u0000';

export function joinKey(a: string, b: string): string {
  return `${a}${JOIN_SEPARATOR}${b}`;
}

// ---------------------------------------------------------------------------
// Identity
//
// These are the only places a comparison rule is written down, so the planner's
// behaviour and the tests that describe it cannot drift apart.
// ---------------------------------------------------------------------------

/**
 * Normalize a folder or tag name for comparison.
 *
 * Conservative on purpose, and it stops at the three differences that provably
 * cannot carry meaning: the Unicode normalization form, internal whitespace
 * runs, and leading/trailing whitespace. Case is *not* folded and near-matches
 * are not folded: `Development` and `development` are different names here, and
 * merging two differently-named folders because they look similar would be a
 * guess, not a merge.
 */
export function normalizeName(name: string): string {
  return text(name).normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * A string, or the empty string for anything that is not one.
 *
 * The identity helpers are declared over `string` because that is what a
 * validated row carries, but they are also reachable from an index built over
 * rows that arrived from somewhere else. Planning must never throw: it runs
 * before a destructive step, and a `TypeError` there would be indistinguishable
 * from "the file is fine" to a caller holding a `try`. Treating a missing name or
 * address as empty makes such a row simply unmatchable, which is the safe
 * answer.
 */
function text(value: string): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeTagName(name: string): string {
  // Tags are labels rather than names people read as proper nouns, and the app
  // already treats `Work` and `work` as one tag when filtering.
  return normalizeName(name).toLocaleLowerCase();
}

/** A folder's identity: its normalized name under its matched parent. */
export function folderIdentity(parentLocalId: string | null, name: string): string {
  return joinKey(parentLocalId ?? '', normalizeName(name));
}

/** A canonical URL, or the trimmed original when it cannot be canonicalized. */
export function canonicalUrl(url: string): string {
  const raw = text(url);
  return normalizeUrl(raw) ?? raw.trim();
}

/** A link's identity: its canonical address inside its matched folder. */
export function linkIdentity(folderLocalId: string | null, url: string): string {
  return joinKey(folderLocalId ?? '', canonicalUrl(url));
}

/**
 * A note's title identity, combined with its matched parent.
 *
 * The body is compared separately and exactly, because the body is the part
 * that can differ while the title is the same — and the body is what deciding
 * whether two notes are "the same note" has to rest on.
 */
export function noteIdentity(parentLocalId: string | null, title: string): string {
  return joinKey(parentLocalId ?? '', normalizeName(title));
}

/**
 * The body, in the form used for comparison only.
 *
 * Line endings are unified and trailing whitespace on each line is dropped,
 * because a note that went through a different editor on a different platform
 * differs in exactly those bytes while being the same note. The stored content
 * is never touched by this — the local row keeps every byte it had.
 */
export function noteBody(content: string): string {
  return text(content).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
}

// ---------------------------------------------------------------------------
// What is already here
// ---------------------------------------------------------------------------

export interface ExistingIndex {
  folderIds: ReadonlySet<string>;
  linkIds: ReadonlySet<string>;
  noteIds: ReadonlySet<string>;
  tagIds: ReadonlySet<string>;
  linkTagKeys: ReadonlySet<string>;
  noteLinkKeys: ReadonlySet<string>;
  /** True when there is no user content at all, so a merge can act like a restore. */
  isEmpty: boolean;
  /** Rows by id, so an id collision can be judged rather than assumed. */
  folderById: ReadonlyMap<string, Folder>;
  linkById: ReadonlyMap<string, SavedLink>;
  noteById: ReadonlyMap<string, Note>;
  /** Identity → local id, for rows whose identity is knowable. */
  folderByKey: ReadonlyMap<string, string>;
  linkByKey: ReadonlyMap<string, string>;
  tagByName: ReadonlyMap<string, string>;
  /** Title identity → every local note at it. Plural: titles are not unique. */
  notesByKey: ReadonlyMap<string, readonly string[]>;
}

export function indexExisting(snapshot: VaultSnapshot): ExistingIndex {
  const isEmpty =
    snapshot.folders.length === 0 &&
    snapshot.links.length === 0 &&
    snapshot.notes.length === 0 &&
    snapshot.tags.length === 0;

  const folderById = new Map(snapshot.folders.map((row) => [row.id, row]));
  const folderByKey = new Map<string, string>();
  for (const folder of snapshot.folders) {
    // A sealed folder's name is blank, so it has no identity to key on.
    if (isSealed(folder)) continue;
    const key = folderIdentity(folder.parentId, folder.name);
    if (!folderByKey.has(key)) folderByKey.set(key, folder.id);
  }

  const linkByKey = new Map<string, string>();
  for (const link of snapshot.links) {
    if (isSealed(link)) continue;
    const key = linkIdentity(link.folderId, link.url);
    if (!linkByKey.has(key)) linkByKey.set(key, link.id);
  }

  const notesByKey = new Map<string, string[]>();
  for (const note of snapshot.notes) {
    if (isSealed(note)) continue;
    const key = noteIdentity(note.parentNoteId, note.title);
    const bucket = notesByKey.get(key);
    if (bucket) bucket.push(note.id);
    else notesByKey.set(key, [note.id]);
  }

  const tagByName = new Map<string, string>();
  for (const tag of snapshot.tags) {
    const key = normalizeTagName(tag.name);
    if (!tagByName.has(key)) tagByName.set(key, tag.id);
  }

  return {
    folderIds: new Set(snapshot.folders.map((row) => row.id)),
    linkIds: new Set(snapshot.links.map((row) => row.id)),
    noteIds: new Set(snapshot.notes.map((row) => row.id)),
    tagIds: new Set(snapshot.tags.map((row) => row.id)),
    linkTagKeys: new Set(snapshot.linkTags.map((row) => joinKey(row.linkId, row.tagId))),
    noteLinkKeys: new Set(snapshot.noteLinks.map((row) => joinKey(row.noteId, row.linkId))),
    isEmpty,
    folderById,
    linkById: new Map(snapshot.links.map((row) => [row.id, row])),
    noteById: new Map(snapshot.notes.map((row) => [row.id, row])),
    folderByKey,
    linkByKey,
    tagByName,
    notesByKey,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface ImportCounts {
  folders: number;
  links: number;
  tags: number;
  notes: number;
  linkTags: number;
  noteLinks: number;
}

/** Rows the backup offered that matched something already here, per family. */
export interface MergeCounts {
  folders: number;
  links: number;
  notes: number;
  tags: number;
}

/**
 * Imported id → the id the row has here after the import.
 *
 * Exposed because it is the thing that makes the merge auditable, and the thing
 * any future caller needs in order to resolve a reference into the archive.
 * Built for both outcomes: a matched row maps to the local id it merged into, a
 * created row to the id it was given (which is its own unless that was taken).
 */
export interface ImportIdMap {
  folders: Record<string, string>;
  links: Record<string, string>;
  notes: Record<string, string>;
  tags: Record<string, string>;
}

export interface ImportPlan {
  mode: ImportMode;
  folders: Folder[];
  links: SavedLink[];
  tags: Tag[];
  notes: Note[];
  linkTags: LinkTag[];
  noteLinks: NoteLink[];
  /** Settings to apply, or `null` to keep this device's own. */
  settings: PortableSettings | null;
  /** Rows that will actually be written. */
  counts: ImportCounts;
  /** Of those matched, the ones matched by identity rather than by id. */
  merged: MergeCounts;
  /** Every incoming row that was recognized as already present, per family. */
  skipped: MergeCounts;
  /** Imported id → id here, for every row the file offered. */
  idMap: ImportIdMap;
  /**
   * Same parent and same title, different body — preserved as a separate note.
   *
   * Reported rather than resolved. Two notes called `Meeting` that say different
   * things are two notes, and the only safe answer to "are these the same?" when
   * the bodies disagree is "no, keep both" — with the count surfaced so the
   * user is not surprised by a new note they did not expect.
   */
  ambiguousNotes: number;
  /**
   * Whether the backup's keyring should replace the device's.
   *
   * `keep` when this device already has one and nothing is being cleared — the
   * local keyring is what unseals everything already here. `adopt` when the
   * backup brings a keyring *and* either the device has none or everything local
   * is about to be cleared, in which case the backup's key is the only one that
   * can open the rows arriving with it.
   */
  keyring: 'keep' | 'adopt';
  /**
   * True when adopting will replace a keyring this device already has. The
   * current passcode stops working at that point, which the user must be told
   * before, not after.
   */
  replacesKeyring: boolean;
  /** Things the user should know about what this plan will and will not do. */
  messages: string[];
}

/**
 * Decide what an import would do.
 *
 * `hasKeyring` and `canInstallKeyring` come from the caller rather than being
 * read here, so this stays a pure function and the same plan can be computed in
 * a test with no database at all. `newId` is a seam for the same reason: the
 * tests need to name the ids the planner invents in order to assert on them.
 */
export function planImport(input: {
  data: BackupData;
  existing: ExistingIndex;
  mode: ImportMode;
  /** Whether the backup carries a usable passcode-wrapped keyring. */
  backupHasKeyring: boolean;
  /** Whether this device already has a keyring. */
  deviceHasKeyring: boolean;
  /** Allocates a local id for an incoming row whose own id is taken. */
  newId?: () => string;
}): ImportPlan {
  const { data, existing, mode } = input;
  const messages: string[] = [];
  const allocate = input.newId ?? defaultNewId;

  const planned =
    mode === 'replace'
      ? planReplace(data)
      : planMerge(data, existing, allocate);

  // --- Settings ----------------------------------------------------------
  // Replace restores preferences, because it restores the vault. Merge keeps the
  // device's own preferences unless there is nothing here to preserve — a
  // merge should not silently retheme an app the user is already using.
  let settings: PortableSettings | null = data.settings;
  if (mode === 'merge') {
    if (!existing.isEmpty) {
      settings = null;
      if (hasNonDefaultSettings(data.settings)) {
        messages.push('Your current preferences are kept; the backup’s preferences were not applied.');
      }
    }
  }

  // Remembered capture destinations must point at real folders after the import,
  // or the Save sheet would offer a destination that no longer exists. The set of
  // folders that will exist is the destination's own plus everything created —
  // which is why a merged folder still counts: it is there, under the id it
  // already had.
  if (settings) {
    const knownFolders = new Set([...existing.folderIds, ...planned.folders.map((row) => row.id)]);
    const recents = settings.recentFolderIds.filter((id) => knownFolders.has(id));
    const lastFolderId = settings.lastFolderId && knownFolders.has(settings.lastFolderId) ? settings.lastFolderId : null;
    settings = { ...settings, recentFolderIds: recents, lastFolderId };
  }

  // --- Keyring -----------------------------------------------------------
  const keyring: 'keep' | 'adopt' = input.backupHasKeyring && (!input.deviceHasKeyring || mode === 'replace') ? 'adopt' : 'keep';
  const replacesKeyring = keyring === 'adopt' && input.deviceHasKeyring;

  if (keyring === 'keep' && input.deviceHasKeyring && input.backupHasKeyring && mode === 'merge') {
    messages.push(
      'This backup carries its own key. Your existing key is kept, so locked items from the backup stay locked unless the keys match.',
    );
  }

  const counts: ImportCounts = {
    folders: planned.folders.length,
    links: planned.links.length,
    tags: planned.tags.length,
    notes: planned.notes.length,
    linkTags: planned.linkTags.length,
    noteLinks: planned.noteLinks.length,
  };

  // --- What to tell the user ---------------------------------------------
  if (mode === 'merge') {
    const mergedTotal =
      planned.merged.folders + planned.merged.links + planned.merged.notes + planned.merged.tags;
    const recognised = planned.skipped.folders + planned.skipped.links + planned.skipped.notes + planned.skipped.tags;

    if (planned.merged.folders > 0) {
      messages.push(
        `${planned.merged.folders} folder(s) already existed here and were merged into, so nothing was duplicated.`,
      );
    }
    if (planned.merged.links > 0) {
      messages.push(`${planned.merged.links} link(s) were already saved in the same place and were kept as they are.`);
    }
    if (planned.merged.notes > 0) {
      messages.push(`${planned.merged.notes} note(s) already existed here unchanged and were kept.`);
    }
    if (recognised > mergedTotal) {
      messages.push(
        `${recognised - mergedTotal} locked item(s) already existed here and were left untouched — a sealed row carries no readable name to match on.`,
      );
    }

    const createdTotal =
      planned.folders.length + planned.links.length + planned.notes.length + planned.tags.length;
    if (createdTotal > 0 && mergedTotal > 0) {
      messages.push('Existing content is never overwritten by a merge: matching items were combined, not replaced.');
    }
    if (recognised === 0 && createdTotal === 0) {
      messages.push('This backup contains nothing that is not already here.');
    }

    if (planned.ambiguousNotes > 0) {
      messages.push(
        `${planned.ambiguousNotes} note(s) share a title with a note here but say something different, so both were kept. Nothing was merged or discarded.`,
      );
    }
  }

  return {
    mode,
    folders: planned.folders,
    links: planned.links,
    tags: planned.tags,
    notes: planned.notes,
    linkTags: planned.linkTags,
    noteLinks: planned.noteLinks,
    settings,
    counts,
    merged: planned.merged,
    skipped: planned.skipped,
    idMap: planned.idMap,
    ambiguousNotes: planned.ambiguousNotes,
    keyring,
    replacesKeyring,
    messages,
  };
}

interface PlannedRows {
  folders: Folder[];
  links: SavedLink[];
  tags: Tag[];
  notes: Note[];
  linkTags: LinkTag[];
  noteLinks: NoteLink[];
  merged: MergeCounts;
  skipped: MergeCounts;
  idMap: ImportIdMap;
  ambiguousNotes: number;
}

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

/**
 * Replace: write the file's rows verbatim.
 *
 * Join rows are still checked against the union of what the file contains, so a
 * pair whose other half is not in the file is dropped rather than written as a
 * dangling reference. Everything else is copied exactly, which is what makes a
 * replace reproduce the original vault rather than approximate it.
 */
function planReplace(data: BackupData): PlannedRows {
  const linkIds = new Set(data.links.map((row) => row.id));
  const noteIds = new Set(data.notes.map((row) => row.id));
  const tagIds = new Set(data.tags.map((row) => row.id));

  return {
    folders: [...data.folders],
    links: [...data.links],
    tags: [...data.tags],
    notes: [...data.notes],
    linkTags: dedupe(data.linkTags, (row) => joinKey(row.linkId, row.tagId)).filter(
      (row) => linkIds.has(row.linkId) && tagIds.has(row.tagId),
    ),
    noteLinks: dedupe(data.noteLinks, (row) => joinKey(row.noteId, row.linkId)).filter(
      (row) => noteIds.has(row.noteId) && linkIds.has(row.linkId),
    ),
    merged: { folders: 0, links: 0, notes: 0, tags: 0 },
    skipped: { folders: 0, links: 0, notes: 0, tags: 0 },
    idMap: {
      folders: identityMap(data.folders),
      links: identityMap(data.links),
      notes: identityMap(data.notes),
      tags: identityMap(data.tags),
    },
    ambiguousNotes: 0,
  };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function planMerge(data: BackupData, existing: ExistingIndex, allocate: () => string): PlannedRows {
  const idMap: ImportIdMap = { folders: {}, links: {}, notes: {}, tags: {} };

  // --- Folders, parent before child -------------------------------------
  const folderIds = new Set(existing.folderIds);
  const folderKeys = new Map(existing.folderByKey);
  const folders: Folder[] = [];
  const merged: MergeCounts = { folders: 0, links: 0, notes: 0, tags: 0 };
  const skipped: MergeCounts = { folders: 0, links: 0, notes: 0, tags: 0 };

  for (const incoming of parentsFirst(data.folders, (row) => row.parentId)) {
    // The parent is either absent (a root) or present in the file — validation
    // guarantees that — and parents come first, so the map has answered already.
    // The `?? incoming.parentId` arm is unreachable for validated input and
    // exists so a hand-built call cannot orphan a row.
    const parentLocalId =
      incoming.parentId === null ? null : (idMap.folders[incoming.parentId] ?? incoming.parentId);

    if (isSealed(incoming)) {
      idMap.folders[incoming.id] = incoming.id;
      if (existing.folderIds.has(incoming.id)) {
        skipped.folders += 1;
        continue;
      }
      folders.push({ ...incoming, parentId: parentLocalId });
      folderIds.add(incoming.id);
      continue;
    }

    const key = folderIdentity(parentLocalId, incoming.name);
    const matchedId = folderKeys.get(key);
    if (matchedId !== undefined) {
      idMap.folders[incoming.id] = matchedId;
      merged.folders += 1;
      skipped.folders += 1;
      continue;
    }

    const id = folderIds.has(incoming.id) ? allocate() : incoming.id;
    folders.push({ ...incoming, id, parentId: parentLocalId });
    folderIds.add(id);
    folderKeys.set(key, id);
    idMap.folders[incoming.id] = id;
  }

  // --- Links, inside their matched folder --------------------------------
  const linkIds = new Set(existing.linkIds);
  const linkKeys = new Map(existing.linkByKey);
  const links: SavedLink[] = [];

  for (const incoming of data.links) {
    const folderLocalId =
      incoming.folderId === null ? null : (idMap.folders[incoming.folderId] ?? incoming.folderId);

    if (isSealed(incoming)) {
      idMap.links[incoming.id] = incoming.id;
      if (existing.linkIds.has(incoming.id)) {
        skipped.links += 1;
        continue;
      }
      links.push({ ...incoming, folderId: folderLocalId });
      linkIds.add(incoming.id);
      continue;
    }

    const key = linkIdentity(folderLocalId, incoming.url);
    const matchedId = linkKeys.get(key);
    if (matchedId !== undefined) {
      idMap.links[incoming.id] = matchedId;
      merged.links += 1;
      skipped.links += 1;
      continue;
    }

    // A fresh id, not a rewrite of a local row: an id collision means the two
    // records are different things that happen to share a string, and the local
    // one keeps its identifier.
    const id = linkIds.has(incoming.id) ? allocate() : incoming.id;
    links.push({ ...incoming, id, folderId: folderLocalId });
    linkIds.add(id);
    linkKeys.set(key, id);
    idMap.links[incoming.id] = id;
  }

  // --- Tags ---------------------------------------------------------------
  const tagIds = new Set(existing.tagIds);
  const tagNames = new Map(existing.tagByName);
  const tags: Tag[] = [];

  for (const incoming of data.tags) {
    const key = normalizeTagName(incoming.name);
    const matchedId = tagNames.get(key);
    if (matchedId !== undefined) {
      idMap.tags[incoming.id] = matchedId;
      merged.tags += 1;
      skipped.tags += 1;
      continue;
    }
    const id = tagIds.has(incoming.id) ? allocate() : incoming.id;
    tags.push({ ...incoming, id });
    tagIds.add(id);
    tagNames.set(key, id);
    idMap.tags[incoming.id] = id;
  }

  // --- Notes, parent before child ----------------------------------------
  const noteIds = new Set(existing.noteIds);
  const noteKeys = new Map<string, string[]>(cloneBuckets(existing.notesByKey));
  // Bodies are read for comparison, so rows created above have to be readable
  // too: a backup containing the same note twice must dedupe against itself, not
  // only against the destination.
  const noteBodies = new Map<string, string>();
  for (const [id, row] of existing.noteById) {
    if (!isSealed(row)) noteBodies.set(id, noteBody(row.content));
  }
  const notes: Note[] = [];
  let ambiguousNotes = 0;

  for (const incoming of parentsFirst(data.notes, (row) => row.parentNoteId)) {
    const parentLocalId =
      incoming.parentNoteId === null ? null : (idMap.notes[incoming.parentNoteId] ?? incoming.parentNoteId);

    if (isSealed(incoming)) {
      idMap.notes[incoming.id] = incoming.id;
      if (existing.noteIds.has(incoming.id)) {
        skipped.notes += 1;
        continue;
      }
      notes.push({ ...incoming, parentNoteId: parentLocalId });
      noteIds.add(incoming.id);
      continue;
    }

    const key = noteIdentity(parentLocalId, incoming.title);
    const candidates = noteKeys.get(key) ?? [];
    const body = noteBody(incoming.content);
    const match = candidates.find((candidate) => noteBodies.get(candidate) === body);

    if (match !== undefined) {
      idMap.notes[incoming.id] = match;
      merged.notes += 1;
      skipped.notes += 1;
      continue;
    }
    // Same title, same place, different words. Both are kept: only the user
    // knows which of the two `Meeting` notes this one is.
    if (candidates.length > 0) ambiguousNotes += 1;

    const id = noteIds.has(incoming.id) ? allocate() : incoming.id;
    notes.push({ ...incoming, id, parentNoteId: parentLocalId });
    noteIds.add(id);
    noteBodies.set(id, body);
    noteKeys.set(key, [...candidates, id]);
    idMap.notes[incoming.id] = id;
  }

  // --- References ---------------------------------------------------------
  // Resolved after every family is planned, and against the union of what stays
  // and what arrives, so a pair whose other half is being kept still links up.
  const linkTags = dedupe(
    data.linkTags
      .map((row) => ({ linkId: idMap.links[row.linkId] ?? row.linkId, tagId: idMap.tags[row.tagId] ?? row.tagId }))
      .filter(
        (row) =>
          linkIds.has(row.linkId) && tagIds.has(row.tagId) && !existing.linkTagKeys.has(joinKey(row.linkId, row.tagId)),
      ),
    (row) => joinKey(row.linkId, row.tagId),
  );

  const noteLinks = dedupe(
    data.noteLinks
      .map((row) => ({
        noteId: idMap.notes[row.noteId] ?? row.noteId,
        linkId: idMap.links[row.linkId] ?? row.linkId,
        origin: row.origin,
        createdAt: row.createdAt,
        sortOrder: row.sortOrder,
      }))
      .filter(
        (row) =>
          noteIds.has(row.noteId) && linkIds.has(row.linkId) && !existing.noteLinkKeys.has(joinKey(row.noteId, row.linkId)),
      ),
    (row) => joinKey(row.noteId, row.linkId),
  );

  return { folders, links, tags, notes, linkTags, noteLinks, merged, skipped, idMap, ambiguousNotes };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A stable ordering in which every row comes after its parent.
 *
 * Merge has to walk parents first: a child's identity is defined by the local id
 * its parent resolved to, and the parent's own outcome has to be known before
 * that can be asked. A cycle — only reachable from hand-edited or imported data,
 * and already broken by validation — is emitted in the order it was met rather
 * than hanging, and a repeated id is emitted once.
 */
function parentsFirst<T extends { id: string }>(rows: readonly T[], parentOf: (row: T) => string | null): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: T[] = [];
  const emitted = new Set<string>();

  const visit = (row: T): void => {
    if (emitted.has(row.id)) return;
    emitted.add(row.id);
    const parentId = parentOf(row);
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (parent && parent.id !== row.id) visit(parent);
    out.push(row);
  };

  for (const row of rows) visit(row);
  return out;
}

function dedupe<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function identityMap(rows: readonly { id: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) out[row.id] = row.id;
  return out;
}

function cloneBuckets(source: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, ids] of source) out.set(key, [...ids]);
  return out;
}

function hasNonDefaultSettings(settings: PortableSettings): boolean {
  return (
    settings.themeMode !== 'system' ||
    settings.relockPolicy !== 'immediate' ||
    settings.lockApp !== true ||
    settings.secureScreen !== false ||
    settings.biometric !== true ||
    settings.lastFolderId !== null ||
    settings.recentFolderIds.length > 0
  );
}

export function planTotal(plan: ImportPlan): number {
  const counts = plan.counts;
  return counts.folders + counts.links + counts.tags + counts.notes + counts.linkTags + counts.noteLinks;
}

/** Total rows the file offered that are already here, in any form. */
export function planMerged(plan: ImportPlan): number {
  return plan.skipped.folders + plan.skipped.links + plan.skipped.notes + plan.skipped.tags;
}

/** A one-line description of what a plan will write, for the confirmation. */
export function describePlan(plan: ImportPlan): string {
  const parts: string[] = [];
  if (plan.counts.folders) parts.push(`${plan.counts.folders} folder(s)`);
  if (plan.counts.links) parts.push(`${plan.counts.links} link(s)`);
  if (plan.counts.notes) parts.push(`${plan.counts.notes} note(s)`);
  if (plan.counts.tags) parts.push(`${plan.counts.tags} tag(s)`);
  if (parts.length === 0) return 'Nothing to write.';
  return parts.join(', ');
}
