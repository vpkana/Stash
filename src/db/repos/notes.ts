import { newId } from '../id';
import {
  db,
  type Note,
  type NoteDeletionImpact,
  type NoteLink,
  type NoteLinkOrigin,
  type SavedLink,
} from '../index';
import { canMoveNote, nextNoteSortOrder, noteDeletionImpact, type MoveCheck } from '@/lib/tree';
import { contentFromLink, deriveNoteTitle, sanitizeNoteTitle, titleFromLink } from '@/lib/notes';
import { getVaultKey } from '@/lib/privacy/keyring';
import { isNoteParentProtected } from '@/lib/privacy/context';
import { isSealed, openNote, sealNote } from '@/lib/privacy/protection';
import { reconcileProtection } from '@/lib/privacy/reconcile';
import { trashNote } from './trash';

/**
 * Note persistence.
 *
 * Three invariants are enforced here rather than trusted to the UI:
 *
 *
 *  1. Deleting a note never deletes a saved link. Note deletion removes note
 *     rows and the references that point at links; the links themselves are not
 *     in the transaction's blast radius.
 *  2. A note can never be its own ancestor. Moves are validated against the
 *     same pure rules the UI uses to grey out impossible destinations.
 *  3. Sealing is a storage concern. Every function here accepts and returns
 *     *plaintext* notes; a locked note is sealed on the way into IndexedDB and
 *     opened on the way out. Callers never see a ciphertext blob, and a locked
 *     note's title never exists in the database at rest.
 */

export interface CreateNoteInput {
  title?: string;
  content?: string;
  parentNoteId?: string | null;
  /** Used when the title is blank: derived from the first line of content. */
  fallbackTitle?: string;
}

export type CreateNoteResult =
  | { ok: true; note: Note }
  | { ok: false; reason: 'invalid'; message: string };

export async function listNotes(): Promise<Note[]> {
  return db.notes.toArray();
}

export async function getNote(id: string): Promise<Note | undefined> {
  return db.notes.get(id);
}

export async function countNotes(): Promise<number> {
  return db.notes.count();
}

export function buildNoteRecord(input: CreateNoteInput, siblings: readonly Note[]): Note {
  const now = Date.now();
  const content = input.content ?? '';
  const title = sanitizeNoteTitle(input.title ?? '') || deriveNoteTitle(content, input.fallbackTitle ?? 'Untitled note');
  const parentNoteId = input.parentNoteId ?? null;

  return {
    id: newId(),
    parentNoteId,
    title,
    content,
    createdAt: now,
    updatedAt: now,
    sortOrder: nextNoteSortOrder(siblings, parentNoteId),
    isFavorite: false,
    isArchived: false,
    isLocked: false,
  };
}

export async function createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
  const parentNoteId = input.parentNoteId ?? null;
  const parentProtected = await isNoteParentProtected(parentNoteId);

  const notes = await db.notes.toArray();
  if (parentNoteId && !notes.some((note) => note.id === parentNoteId)) {
    return { ok: false, reason: 'invalid', message: 'The parent note no longer exists.' };
  }

  const note = buildNoteRecord(input, notes);
  // A subnote of a locked note is born sealed, so there is no instant at which
  // its title exists in the clear.
  await db.notes.add(parentProtected ? await sealNote(note, getVaultKey()) : note);
  return { ok: true, note };
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
}

export async function updateNote(id: string, patch: UpdateNoteInput): Promise<Note | null> {
  const raw = await db.notes.get(id);
  if (!raw) return null;

  // Work on the plaintext view, then decide how to store the result. A sealed
  // row stays sealed: an edit to a locked note must not leave the new text in
  // the clear, and must not blank the fields the user just typed.
  //
  // Deliberately not a Dexie transaction: awaiting WebCrypto inside one makes
  // Dexie consider the transaction over and the write is lost. Writes on a note
  // are serialised upstream anyway — the autosave controller keeps a single
  // write in flight — so the read-modify-write here has no interleaving writer
  // to race with.
  const note = await openNote(raw, getVaultKey());
  const updated: Note = { ...note, updatedAt: Date.now() };
  if (patch.title !== undefined) {
    const title = sanitizeNoteTitle(patch.title);
    updated.title = title.length > 0 ? title : deriveNoteTitle(updated.content);
  }
  if (patch.content !== undefined) updated.content = patch.content;

  await db.notes.put(isSealed(raw) ? await sealNote(updated, getVaultKey()) : updated);
  return updated;
}

/**
 * The autosave path.
 *
 * Deliberately narrow: it writes only content, title, and `updatedAt`, and it
 * never rewrites structure. Typing cannot disturb a note's position in the
 * tree, and an interrupted save can only ever lose the last few keystrokes.
 */
export async function saveNoteContent(id: string, content: string): Promise<number | null> {
  const raw = await db.notes.get(id);
  if (!raw) return null;
  const updatedAt = Date.now();

  // The autosave path. Typing must not be able to leak: for a locked note the
  // whole note is re-sealed, which is cheap (one AES-GCM operation on a note-sized
  // payload) and keeps the invariant "a locked note is never plaintext on disk".
  if (isSealed(raw)) {
    const note = await openNote(raw, getVaultKey());
    await db.notes.put(await sealNote({ ...note, content, updatedAt }, getVaultKey()));
    return updatedAt;
  }

  // `modify` avoids a read-modify-write race with a concurrent structural change.
  await db.notes.update(id, { content, updatedAt });
  return updatedAt;
}

export async function renameNote(id: string, rawTitle: string): Promise<Note | null> {
  const title = sanitizeNoteTitle(rawTitle);
  return updateNote(id, { title });
}

export type MoveNoteResult = { ok: true; note: Note } | { ok: false; reason: string };

export async function canMoveNoteTo(id: string, targetParentNoteId: string | null): Promise<MoveCheck> {
  const notes = await db.notes.toArray();
  return canMoveNote(notes, id, targetParentNoteId);
}

export async function moveNote(id: string, targetParentNoteId: string | null): Promise<MoveNoteResult> {
  const result = await db.transaction('rw', db.notes, async () => {
    const notes = await db.notes.toArray();
    const note = notes.find((candidate) => candidate.id === id);
    if (!note) return { ok: false, reason: 'That note no longer exists.' } as const;

    const check = canMoveNote(notes, id, targetParentNoteId);
    if (!check.ok) return { ok: false, reason: check.reason } as const;

    const updated: Note = {
      ...note,
      parentNoteId: targetParentNoteId,
      sortOrder: nextNoteSortOrder(notes, targetParentNoteId),
      updatedAt: Date.now(),
    };
    await db.notes.put(updated);
    return { ok: true, note: updated } as const;
  });

  // A move can cross a lock boundary in either direction: out of a locked parent
  // the note must be opened again, into one it must be sealed.
  if (result.ok) await reconcileProtection();
  return result;
}

/** Shift a note one slot up or down among its siblings. */
export async function reorderNote(id: string, direction: 'up' | 'down'): Promise<boolean> {
  return db.transaction('rw', db.notes, async () => {
    const notes = await db.notes.toArray();
    const note = notes.find((candidate) => candidate.id === id);
    if (!note) return false;

    const siblings = notes
      .filter((candidate) => candidate.parentNoteId === note.parentNoteId)
      .sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.title.localeCompare(b.title)));

    const index = siblings.findIndex((candidate) => candidate.id === id);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= siblings.length) return false;

    const reordered = siblings.slice();
    const [moved] = reordered.splice(index, 1);
    if (!moved) return false;
    reordered.splice(target, 0, moved);

    const now = Date.now();
    await Promise.all(
      reordered.map((candidate, position) =>
        db.notes.update(candidate.id, { sortOrder: position, updatedAt: now }),
      ),
    );
    return true;
  });
}

export async function setNoteFavorite(id: string, isFavorite: boolean): Promise<void> {
  await db.notes.update(id, { isFavorite, updatedAt: Date.now() });
}


/**
 * Lock or unlock one note.
 *
 * Only the flag is written here. Sealing the note (and its subnotes, which
 * inherit the lock) is done by {@link reconcileProtection}, which derives what
 * should be sealed from the flags and brings the database into line. Keeping the
 * flag and the sealing derived from one another is what makes inheritance
 * correct for free.
 *
 * Unlocking a note whose parent is still locked leaves it protected: the parent
 * wins, and reconciliation re-seals it. The UI says so rather than offering an
 * unlock that silently does nothing.
 */
export async function setNoteLocked(id: string, isLocked: boolean): Promise<void> {
  await db.notes.update(id, { isLocked, updatedAt: Date.now() });
  // Immediate, not deferred to the caller: the moment the flag changes, the
  // database and the flag must agree about what is encrypted.
  await reconcileProtection();
}

/**
 * Whether clearing this note's flag would actually release it.
 *
 *
 * A note beneath a locked parent cannot be unlocked on its own, and the sheet
 * needs to be able to explain that before the user taps anything.
 */
export async function isLockInherited(id: string): Promise<boolean> {
  const notes = await db.notes.toArray();
  const note = notes.find((candidate) => candidate.id === id);
  if (!note || note.isLocked) return false;
  const parentId = note.parentNoteId;
  if (!parentId) return false;
  return isNoteParentProtected(parentId);
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

export type NoteDeleteStrategy = 'delete-subtree' | 'keep-children';

export interface DeleteNoteResult {
  ok: boolean;
  removedNoteCount: number;
  /** Subnotes re-parented instead of removed (`keep-children`). */
  movedNoteCount: number;
  /** References removed. Saved links are never counted here as deletions. */
  removedReferenceCount: number;
}

export async function getNoteDeletionImpact(id: string): Promise<NoteDeletionImpact | null> {
  const [notes, noteLinks] = await Promise.all([db.notes.toArray(), db.noteLinks.toArray()]);
  return noteDeletionImpact(notes, groupLinksByNote(noteLinks), id);
}

/** `noteId -> linkIds`, the shape the pure impact calculation expects. */
export function groupLinksByNote(noteLinks: readonly NoteLink[]): Map<string, string[]> {
  const byNote = new Map<string, string[]>();
  for (const row of noteLinks) {
    const bucket = byNote.get(row.noteId);
    if (bucket) bucket.push(row.linkId);
    else byNote.set(row.noteId, [row.linkId]);
  }
  return byNote;
}

/**
 * Throw a note away.
 *
 * `delete-subtree` takes the whole branch as one batch, so restoring it puts the
 * branch back together. `keep-children` is the gentler act and the one the UI
 * recommends: the subnotes are promoted into the note's place, so only the note
 * itself goes.
 *
 * In neither case is anything destroyed, and in neither case are references
 * touched. A note's links stay referenced by it while it sits in the trash and
 * are there again the moment it comes back — unlinking is what *purging* does,
 * not what throwing away does.
 */
export async function deleteNote(id: string, strategy: NoteDeleteStrategy): Promise<DeleteNoteResult> {
  if (strategy === 'delete-subtree') {
    const impact = await trashNote(id, 'delete-subtree');
    return {
      ok: impact.notes > 0,
      removedNoteCount: impact.notes,
      movedNoteCount: 0,
      removedReferenceCount: 0,
    };
  }

  const result = await db.transaction('rw', db.notes, async () => {
    const notes = await db.notes.toArray();
    const note = notes.find((candidate) => candidate.id === id);
    if (!note) {
      return { ok: false, movedNoteCount: 0 };
    }

    // keep-children: promote the direct children into the note's own place.
    const newParentId = note.parentNoteId;
    const baseOrder = nextNoteSortOrder(
      notes.filter((candidate) => candidate.id !== id),
      newParentId,
    );
    const children = notes
      .filter((candidate) => candidate.parentNoteId === id)
      .sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.title.localeCompare(b.title)));

    const now = Date.now();
    await Promise.all(
      children.map((child, index) =>
        db.notes.update(child.id, { parentNoteId: newParentId, sortOrder: baseOrder + index, updatedAt: now }),
      ),
    );
    return { ok: true, movedNoteCount: children.length };
  });

  if (!result.ok) {
    return { ok: false, removedNoteCount: 0, movedNoteCount: 0, removedReferenceCount: 0 };
  }

  const impact = await trashNote(id, 'keep-children');
  if (impact.notes === 0) {
    return { ok: false, removedNoteCount: 0, movedNoteCount: result.movedNoteCount, removedReferenceCount: 0 };
  }

  return {
    ok: true,
    removedNoteCount: 1,
    movedNoteCount: result.movedNoteCount,
    removedReferenceCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Links <-> notes
// ---------------------------------------------------------------------------

export async function listNoteLinks(): Promise<NoteLink[]> {
  return db.noteLinks.toArray();
}

export async function linkIdsForNote(noteId: string): Promise<string[]> {
  const rows = await db.noteLinks.where('noteId').equals(noteId).toArray();
  return rows.map((row) => row.linkId);
}

export async function noteIdsForLink(linkId: string): Promise<string[]> {
  const rows = await db.noteLinks.where('linkId').equals(linkId).toArray();
  return rows.map((row) => row.noteId);
}

/**
 * Reference a saved link from a note.
 *
 * Only the link's id is stored. The one SavedLink row remains the single source
 * of truth for the URL, title and folder, so a note never holds a stale copy of
 * a link that has since moved.
 */
export async function attachLinkToNote(
  noteId: string,
  linkId: string,
  origin: NoteLinkOrigin = 'attached',
): Promise<NoteLink | null> {
  return db.transaction('rw', db.notes, db.links, db.noteLinks, async () => {
    const [note, link] = await Promise.all([db.notes.get(noteId), db.links.get(linkId)]);
    if (!note || !link) return null;

    const existing = await db.noteLinks.get([noteId, linkId]);
    if (existing) return existing;

    const siblings = await db.noteLinks.where('noteId').equals(noteId).toArray();
    const record: NoteLink = {
      noteId,
      linkId,
      origin,
      createdAt: Date.now(),
      sortOrder: siblings.length === 0 ? 0 : Math.max(...siblings.map((row) => row.sortOrder)) + 1,
    };
    await db.noteLinks.put(record);
    return record;
  });
}

/** Remove the reference only. The saved link is untouched. */
export async function detachLinkFromNote(noteId: string, linkId: string): Promise<void> {
  await db.noteLinks.delete([noteId, linkId]);
}

/**
 * Cascade used when a saved link is itself deleted: the notes that referenced it
 * simply stop referencing it. Notes are never deleted as a side effect.
 */
export async function removeLinkReferences(linkId: string): Promise<number> {
  return db.transaction('rw', db.noteLinks, async () => {
    const rows = await db.noteLinks.where('linkId').equals(linkId).toArray();
    if (rows.length === 0) return 0;
    await db.noteLinks.bulkDelete(rows.map((row) => [row.noteId, row.linkId] as [string, string]));
    return rows.length;
  });
}

export interface CreateNoteFromLinkOptions {
  parentNoteId?: string | null;
  /** Write the URL into the note body as well as referencing it. */
  includeLinkUrl?: boolean;
  title?: string;
}

/**
 * Turn a saved link into a note.
 *
 * The new note is titled from the link, seeded with the link's own note text,
 * and the link is attached with `origin: 'created-from'` so the relationship
 * survives even if the body text is later rewritten.
 */
export async function createNoteFromLink(
  linkId: string,
  options: CreateNoteFromLinkOptions = {},
): Promise<CreateNoteResult> {
  const link = await db.links.get(linkId);
  if (!link) return { ok: false, reason: 'invalid', message: 'That link no longer exists.' };

  const result = await createNote({
    title: options.title ?? titleFromLink(link),
    content: contentFromLink(link, { includeLinkUrl: options.includeLinkUrl ?? true }),
    parentNoteId: options.parentNoteId ?? null,
  });
  if (!result.ok) return result;

  await attachLinkToNote(result.note.id, linkId, 'created-from');
  return result;
}

/** Links referenced by a note, resolved for display. Order follows `sortOrder`. */
export async function linksReferencedByNote(noteId: string): Promise<SavedLink[]> {
  const rows = await db.noteLinks.where('noteId').equals(noteId).toArray();
  if (rows.length === 0) return [];
  rows.sort((a, b) => a.sortOrder - b.sortOrder);
  const links = await db.links.where('id').anyOf(rows.map((row) => row.linkId)).toArray();
  const byId = new Map(links.map((link) => [link.id, link]));
  return rows
    .map((row) => byId.get(row.linkId))
    .filter((link): link is SavedLink => Boolean(link));
}

/**
 * Notes that reference a link, resolved for display. Used by the link sheet so a
 * saved link can show what thinking it is attached to.
 */
export async function notesReferencingLink(linkId: string): Promise<Note[]> {
  const rows = await db.noteLinks.where('linkId').equals(linkId).toArray();
  if (rows.length === 0) return [];
  const notes = await db.notes.where('id').anyOf(rows.map((row) => row.noteId)).toArray();
  return notes.sort((a, b) => a.title.localeCompare(b.title));
}

/** Note ids and titles for a whole set of links at once, for list rendering. */
export async function noteReferenceMap(): Promise<Map<string, string[]>> {
  const rows = await db.noteLinks.toArray();
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = map.get(row.linkId);
    if (bucket) bucket.push(row.noteId);
    else map.set(row.linkId, [row.noteId]);
  }
  return map;
}
