import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { StashDatabase, db, openDatabase } from '@/db';
import {
  attachLinkToNote,
  createNote,
  createNoteFromLink,
  deleteNote,
  detachLinkFromNote,
  getNote,
  getNoteDeletionImpact,
  linkIdsForNote,
  linksReferencedByNote,
  moveNote,
  noteIdsForLink,
  notesReferencingLink,
  removeLinkReferences,
  renameNote,
  reorderNote,
  saveNoteContent,
  updateNote,
} from '@/db/repos/notes';
import { createLink, deleteLinkPermanently, getLink, listAllLinks } from '@/db/repos/links';
import { getSnapshot } from '@/db/repos/vault';
import { countTrashed, listTrashGroups, purgeBatch, restoreBatch } from '@/db/repos/trash';

/**
 * Notes persistence tests.
 *
 * These run against a real Dexie database backed by fake-indexeddb, so
 * transactions, compound keys and the v3 schema are exercised for real.
 */

async function resetDatabase() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

beforeEach(async () => {
  await resetDatabase();
});

/** Create a note and return its id, failing loudly if creation was rejected. */
async function mustCreate(input: { title?: string; content?: string; parentNoteId?: string | null }): Promise<string> {
  const result = await createNote(input);
  if (!result.ok) throw new Error(`createNote("${input.title ?? ''}") failed: ${result.message}`);
  return result.note.id;
}

async function mustLink(): Promise<string> {
  const link = await createLink({ url: `https://example.com/${Math.random().toString(36).slice(2)}`, folderId: null });
  return link.id;
}

describe('note creation', () => {
  it('creates a root note with defaults', async () => {
    const id = await mustCreate({ title: 'Machine Learning', content: 'The study of...' });
    const note = await getNote(id);
    expect(note).not.toBeUndefined();
    expect(note!.title).toBe('Machine Learning');
    expect(note!.parentNoteId).toBeNull();
    expect(note!.content).toBe('The study of...');
    expect(note!.isFavorite).toBe(false);
    expect(note!.isArchived).toBe(false);
    expect(note!.isLocked).toBe(false);
    expect(note!.sortOrder).toBe(0);
  });

  it('creates subnotes under a parent', async () => {
    const parentId = await mustCreate({ title: 'Regression' });
    const linearId = await mustCreate({ title: 'Linear Regression', parentNoteId: parentId });
    const note = await getNote(linearId);
    expect(note!.parentNoteId).toBe(parentId);
    expect(note!.sortOrder).toBe(0); // first child
  });

  it('derives a title from content when the title is blank', async () => {
    const id = await mustCreate({ content: '# The real title\nbody' });
    expect((await getNote(id))!.title).toBe('The real title');
  });

  it('rejects a parent that does not exist', async () => {
    const result = await createNote({ title: 'Orphan', parentNoteId: 'ghost' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('parent');
  });

  it('creates deeply nested notes without limit', async () => {
    let parentId: string | null = null;
    let depth = 0;
    for (; depth < 10; depth += 1) {
      const parent = parentId;
      parentId = await mustCreate({ title: `Level ${depth}`, parentNoteId: parent });
    }
    expect(depth).toBe(10);
  });
});

describe('editing', () => {
  it('renames and rewrites content', async () => {
    const id = await mustCreate({ title: 'Before' });
    const updated = await updateNote(id, { title: 'After', content: 'new body' });
    expect(updated!.title).toBe('After');
    expect(updated!.content).toBe('new body');
  });

  it('falls back to a content-derived title when renamed to blank', async () => {
    const id = await mustCreate({ title: 'Has name', content: '# Keep me' });
    await renameNote(id, '   ');
    expect((await getNote(id))!.title).toBe('Keep me');
  });

  it('autosaves content without touching structure', async () => {
    const parentId = await mustCreate({ title: 'Parent' });
    const id = await mustCreate({ title: 'Child', parentNoteId: parentId });
    const before = await getNote(id);

    const savedAt = await saveNoteContent(id, 'typed while walking');
    expect(savedAt).not.toBeNull();
    const after = await getNote(id);
    expect(after!.content).toBe('typed while walking');
    expect(after!.parentNoteId).toBe(parentId);
    expect(after!.title).toBe(before!.title);
    expect(after!.updatedAt).toBeGreaterThanOrEqual(before!.updatedAt);
  });

  it('returns null when autosaving a deleted note', async () => {
    expect(await saveNoteContent('ghost', 'hello')).toBeNull();
  });
});

describe('reorder', () => {
  it('shifts a note one slot among its siblings', async () => {
    const a = await mustCreate({ title: 'A' });
    const b = await mustCreate({ title: 'B' });
    const c = await mustCreate({ title: 'C' });

    expect(await reorderNote(c, 'up')).toBe(true);
    const bNote = await getNote(b);
    const cNote = await getNote(c);
    expect(cNote!.sortOrder).toBeLessThan(bNote!.sortOrder);

    expect(await reorderNote(a, 'up')).toBe(false); // already first
    expect(await reorderNote('ghost', 'up')).toBe(false);
  });
});

describe('move', () => {
  it('moves a note to another parent and to the root', async () => {
    const ml = await mustCreate({ title: 'ML' });
    const reg = await mustCreate({ title: 'Regression', parentNoteId: ml });
    const svm = await mustCreate({ title: 'SVM', parentNoteId: ml });

    const moved = await moveNote(svm, reg);
    expect(moved.ok).toBe(true);
    expect((await getNote(svm))!.parentNoteId).toBe(reg);

    const toRoot = await moveNote(svm, null);
    expect(toRoot.ok).toBe(true);
    expect((await getNote(svm))!.parentNoteId).toBeNull();
  });

  it('refuses to move a note into its own subtree', async () => {
    const parent = await mustCreate({ title: 'Parent' });
    const child = await mustCreate({ title: 'Child', parentNoteId: parent });
    const result = await moveNote(parent, child);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('own');
  });

  it('refuses to move a note into itself', async () => {
    const id = await mustCreate({ title: 'Self' });
    expect((await moveNote(id, id)).ok).toBe(false);
  });
});

describe('deletion', () => {
  it('throws a leaf note away instead of destroying it', async () => {
    const id = await mustCreate({ title: 'Leaf' });
    const result = await deleteNote(id, 'delete-subtree');
    expect(result.ok).toBe(true);
    expect(result.removedNoteCount).toBe(1);

    // The row is still there, marked. Every listing goes through the snapshot,
    // which is where the trash filter lives, so it is gone from the app without
    // being gone from the device.
    expect((await getNote(id))!.deletedAt).toBeGreaterThan(0);
    expect((await getSnapshot()).notes.some((note) => note.id === id)).toBe(false);
  });

  it('delete-subtree throws the whole branch away as one recoverable batch', async () => {
    const root = await mustCreate({ title: 'Root' });
    const child = await mustCreate({ title: 'Child', parentNoteId: root });
    const grandchild = await mustCreate({ title: 'Grandchild', parentNoteId: child });

    const result = await deleteNote(root, 'delete-subtree');
    expect(result.removedNoteCount).toBe(3);

    const snapshot = await getSnapshot();
    for (const id of [root, child, grandchild]) {
      expect(snapshot.notes.some((note) => note.id === id)).toBe(false);
    }

    // One act, one entry: the branch comes back together or not at all.
    expect(await countTrashed()).toEqual({ folders: 0, links: 0, notes: 3 });
    const groups = await listTrashGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.noteCount).toBe(3);

    await restoreBatch(groups[0]!.batch);
    expect((await getNote(root))!.parentNoteId).toBeNull();
    expect((await getNote(child))!.parentNoteId).toBe(root);
    expect((await getNote(grandchild))!.parentNoteId).toBe(child);
    expect((await getNote(child))!.deletedAt).toBeUndefined();
  });

  it('keep-children promotes subnotes and throws away only the note itself', async () => {
    const root = await mustCreate({ title: 'Root' });
    const child = await mustCreate({ title: 'Child', parentNoteId: root });
    const grandchild = await mustCreate({ title: 'Grandchild', parentNoteId: child });

    const result = await deleteNote(child, 'keep-children');
    expect(result.ok).toBe(true);
    expect(result.removedNoteCount).toBe(1);
    expect(result.movedNoteCount).toBe(1);

    // Promoted, not deleted, and never in the trash: promoting is a structural
    // move, so there is nothing for the user to recover.
    const promoted = await getNote(grandchild);
    expect(promoted!.parentNoteId).toBe(root);
    expect(promoted!.deletedAt).toBeUndefined();
    expect((await getNote(child))!.deletedAt).toBeGreaterThan(0);

    // Root is untouched.
    expect((await getNote(root))!.deletedAt).toBeUndefined();
    expect(await countTrashed()).toEqual({ folders: 0, links: 0, notes: 1 });
  });

  it('never deletes saved links referenced by a thrown-away note', async () => {
    const noteId = await mustCreate({ title: 'With resources' });
    const linkId = await mustLink();
    await attachLinkToNote(noteId, linkId, 'attached');

    const result = await deleteNote(noteId, 'delete-subtree');
    // References are *kept* while the note is only thrown away, which is what
    // makes restoring exact rather than a note that lost its links.
    expect(result.removedReferenceCount).toBe(0);

    const links = await listAllLinks();
    expect(links.some((link) => link.id === linkId)).toBe(true);

    const groups = await listTrashGroups();
    await restoreBatch(groups[0]!.batch);
    expect(await linkIdsForNote(noteId)).toEqual([linkId]);

    // Purging is the only thing that unlinks, and it does so for good.
    const purgeId = await mustCreate({ title: 'Purge me' });
    await attachLinkToNote(purgeId, linkId, 'attached');
    expect(await deleteNote(purgeId, 'delete-subtree')).toMatchObject({ ok: true });
    const again = await listTrashGroups();
    await purgeBatch(again[0]!.batch);
    expect(await linkIdsForNote(purgeId)).toEqual([]);
    expect((await listAllLinks()).some((link) => link.id === linkId)).toBe(true);
  });

  it('reports the impact before deletion', async () => {
    const root = await mustCreate({ title: 'Root' });
    await mustCreate({ title: 'Child', parentNoteId: root });
    const linkId = await mustLink();
    await attachLinkToNote(root, linkId, 'attached');

    const impact = await getNoteDeletionImpact(root);
    expect(impact).not.toBeNull();
    expect(impact!.childNoteCount).toBe(1);
    expect(impact!.referencedLinkCount).toBe(1);
    expect(impact!.noteTitle).toBe('Root');
  });

  it('returns not-ok for an unknown note', async () => {
    const result = await deleteNote('ghost', 'delete-subtree');
    expect(result.ok).toBe(false);
  });
});

describe('link <-> note references', () => {
  it('attaches a link to a note by reference, not by copy', async () => {
    const noteId = await mustCreate({ title: 'Binary Search' });
    const linkId = await mustLink();

    const reference = await attachLinkToNote(noteId, linkId, 'attached');
    expect(reference).not.toBeNull();
    expect(reference!.noteId).toBe(noteId);
    expect(reference!.linkId).toBe(linkId);
    expect(await linkIdsForNote(noteId)).toEqual([linkId]);
    expect(await noteIdsForLink(linkId)).toEqual([noteId]);
  });

  it('is idempotent: attaching twice keeps one reference', async () => {
    const noteId = await mustCreate({ title: 'Note' });
    const linkId = await mustLink();
    await attachLinkToNote(noteId, linkId, 'attached');
    const again = await attachLinkToNote(noteId, linkId, 'attached');
    expect(again).not.toBeNull();
    expect(await linkIdsForNote(noteId)).toHaveLength(1);
  });

  it('rejects attaching to a missing note or link', async () => {
    const linkId = await mustLink();
    expect(await attachLinkToNote('ghost', linkId, 'attached')).toBeNull();
    const noteId = await mustCreate({ title: 'Note' });
    expect(await attachLinkToNote(noteId, 'ghost-link', 'attached')).toBeNull();
  });

  it('orders multiple references by sortOrder', async () => {
    const noteId = await mustCreate({ title: 'Resources' });
    const first = await mustLink();
    const second = await mustLink();
    const third = await mustLink();
    await attachLinkToNote(noteId, first, 'attached');
    await attachLinkToNote(noteId, second, 'attached');
    await attachLinkToNote(noteId, third, 'attached');

    const resolved = await linksReferencedByNote(noteId);
    expect(resolved.map((link) => link.id)).toEqual([first, second, third]);
  });

  it('resolves notes referencing a link', async () => {
    const linkId = await mustLink();
    const noteA = await mustCreate({ title: 'A' });
    const noteB = await mustCreate({ title: 'B' });
    await attachLinkToNote(noteA, linkId, 'attached');
    await attachLinkToNote(noteB, linkId, 'created-from');

    const notes = await notesReferencingLink(linkId);
    expect(notes.map((note) => note.title).sort()).toEqual(['A', 'B']);
  });

  it('detaches without deleting the link or the note', async () => {
    const noteId = await mustCreate({ title: 'Note' });
    const linkId = await mustLink();
    await attachLinkToNote(noteId, linkId, 'attached');

    await detachLinkFromNote(noteId, linkId);
    expect(await linkIdsForNote(noteId)).toEqual([]);
    expect(await getNote(noteId)).not.toBeUndefined();
    expect((await listAllLinks()).some((link) => link.id === linkId)).toBe(true);
  });

  it('removing link references never touches notes', async () => {
    const noteId = await mustCreate({ title: 'Note' });
    const linkId = await mustLink();
    await attachLinkToNote(noteId, linkId, 'attached');

    expect(await removeLinkReferences(linkId)).toBe(1);
    expect(await getNote(noteId)).not.toBeUndefined();
    expect(await linkIdsForNote(noteId)).toEqual([]);
  });
});

describe('create note from link', () => {
  it('seeds a note from a saved link and references it', async () => {
    const link = await createLink({
      url: 'https://youtube.com/watch?v=abc',
      folderId: null,
      title: 'Binary Search Explained',
      userNote: 'Watch before the interview',
    });

    const result = await createNoteFromLink(link.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.note.title).toBe('Binary Search Explained');
    expect(result.note.content).toContain('[Binary Search Explained](https://youtube.com/watch?v=abc)');
    expect(result.note.content).toContain('Watch before the interview');
    expect(await linkIdsForNote(result.note.id)).toEqual([link.id]);
  });

  it('nests under a chosen parent note', async () => {
    const parent = await mustCreate({ title: 'ML' });
    const link = await createLink({ url: 'https://example.com/a', folderId: null });
    const result = await createNoteFromLink(link.id, { parentNoteId: parent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.parentNoteId).toBe(parent);
  });

  it('fails cleanly for a missing link', async () => {
    const result = await createNoteFromLink('ghost');
    expect(result.ok).toBe(false);
  });
});

describe('link deletion cascade', () => {
  it('deleting a saved link cleans up references but keeps notes', async () => {
    const noteId = await mustCreate({ title: 'Thinking' });
    const linkId = await mustLink();
    await attachLinkToNote(noteId, linkId, 'created-from');

    await deleteLinkPermanently(linkId);
    expect(await noteIdsForLink(linkId)).toEqual([]);
    expect(await getLink(linkId)).toBeUndefined();
    expect(await getNote(noteId)).not.toBeUndefined();
  });
});

describe('migration from a links-only vault', () => {
  it('upgrades a version-2 database to the current version without touching user rows', async () => {
    // Build a genuine v2 database with a plain Dexie instance declaring only
    // versions 1 and 2 -- exactly the schema a pre-notes build shipped.
    const legacy = new Dexie('legacy-v2-vault');
    legacy.version(1).stores({
      folders: 'id, parentId, name, sortOrder, updatedAt',
      links: 'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt',
      tags: 'id, &name',
      linkTags: '[linkId+tagId], linkId, tagId',
      meta: 'key',
    });
    legacy.version(2).stores({
      folders: 'id, parentId, name, sortOrder, updatedAt, [parentId+sortOrder]',
      links: 'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt, [folderId+createdAt]',
      tags: 'id, &name',
      linkTags: '[linkId+tagId], linkId, tagId',
      meta: 'key',
    });
    await legacy.open();
    expect(legacy.verno).toBe(2); // the file really is at v2
    await legacy.table('links').add({
      id: 'legacy-link',
      folderId: null,
      url: 'https://example.com/legacy',
      normalizedUrl: 'https://example.com/legacy',
      createdAt: 1,
      updatedAt: 1,
      isFavorite: true,
      isArchived: false,
    });
    await legacy.close();

    // Re-open through the current schema: every upgrade from v2 onward must run
    // additively, adding tables and clearing the retired archive flag without
    // rewriting or losing existing rows.
    const upgraded = new StashDatabase('legacy-v2-vault');
    await upgraded.open();
    expect(upgraded.verno).toBe(6);

    const rows = await upgraded.links.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('legacy-link');
    expect(rows[0]!.isFavorite).toBe(true); // untouched

    // New tables exist and are empty.
    expect(await upgraded.notes.toArray()).toEqual([]);
    expect(await upgraded.noteLinks.toArray()).toEqual([]);

    // The app can then write notes straight away.
    const noteId = await mustCreate({ title: 'After upgrade' });
    expect(await getNote(noteId)).not.toBeUndefined();

    upgraded.close();
  });
});
