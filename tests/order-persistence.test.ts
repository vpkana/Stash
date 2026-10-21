import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import { createFolder, setFolderOrder } from '@/db/repos/folders';
import { createLink, setLinkOrder } from '@/db/repos/links';
import { createNote, setNoteOrder } from '@/db/repos/notes';

/**
 * The order a drag writes has to be the order that comes back.
 *
 * These pin a bug that only showed up after a *second* drag: positions were
 * written as "how many rows have I written so far" instead of "where this row
 * sits in the list I was given". The moment an unchanged row came before a moved
 * one, every later row was written one slot too high, two rows ended up sharing a
 * position, and the list reloaded in an order nobody had chosen — a dropped row
 * appearing to refuse to move, or to jump back past its neighbour.
 */

async function reset() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

async function folderPositions(): Promise<string[]> {
  const stored = await db.folders.toArray();
  return stored
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
    .map((folder) => folder.name);
}

async function linkPositions(folderId: string | null): Promise<string[]> {
  const stored = await db.links
    .filter((link) => (link.folderId ?? null) === folderId)
    .toArray();
  return stored
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.url.localeCompare(b.url))
    .map((link) => link.url.replace('https://example.com/', ''));
}

describe('sibling order persists exactly as dropped', () => {
  beforeEach(reset);

  it('keeps the first row in place and still writes the real positions of the others', async () => {
    const alpha = await createFolder({ name: 'Alpha', parentId: null });
    const beta = await createFolder({ name: 'Beta', parentId: null });
    const gamma = await createFolder({ name: 'Gamma', parentId: null });
    if (!alpha.ok || !beta.ok || !gamma.ok) throw new Error('folders');

    // Alpha is already first, so only Beta and Gamma need a write. That is the
    // case that used to collapse two rows onto position 0.
    expect(await setFolderOrder(null, [alpha.folder.id, gamma.folder.id, beta.folder.id])).toBe(true);
    expect(await folderPositions()).toEqual(['Alpha', 'Gamma', 'Beta']);

    const orders = (await db.folders.toArray()).map((folder) => folder.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('honours a drag that moves two rows past the end', async () => {
    const ids: string[] = [];
    for (const name of ['One', 'Two', 'Three', 'Four']) {
      const folder = await createFolder({ name, parentId: null });
      if (!folder.ok) throw new Error('folder');
      ids.push(folder.folder.id);
    }

    // [Two, Three, Four, One] — every row after the first moved.
    expect(await setFolderOrder(null, [ids[1]!, ids[2]!, ids[3]!, ids[0]!])).toBe(true);
    expect(await folderPositions()).toEqual(['Two', 'Three', 'Four', 'One']);
  });

  it('reports success when the stored order already matches', async () => {
    const folder = await createFolder({ name: 'Solo', parentId: null });
    if (!folder.ok) throw new Error('folder');

    // Nothing needs writing. It is not a failure, so the screen must not warn
    // that the order could not be saved.
    expect(await setFolderOrder(null, [folder.folder.id])).toBe(true);
  });

  it('writes the same contract for links', async () => {
    const folder = await createFolder({ name: 'Reading', parentId: null });
    if (!folder.ok) throw new Error('folder');
    const folderId = folder.folder.id;

    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const link = await createLink({ url: `https://example.com/${name}`, folderId, title: name });
      ids.push(link.id);
    }

    // `a` stays at index 0; b and c swap around it.
    expect(await setLinkOrder(folderId, [ids[0]!, ids[2]!, ids[1]!])).toBe(true);
    expect(await linkPositions(folderId)).toEqual(['a', 'c', 'b']);

    const orders = (await db.links.where('folderId').equals(folderId).toArray()).map(
      (link) => link.sortOrder,
    );
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('keeps the first note in place without collapsing the positions after it', async () => {
    const ids: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      const note = await createNote({ title, content: '' });
      if (!note.ok) throw new Error('note');
      ids.push(note.note.id);
    }

    expect(await setNoteOrder(null, [ids[0]!, ids[2]!, ids[1]!])).toBe(true);
    const stored = (await db.notes.toArray())
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((note) => note.title);
    expect(stored).toEqual(['One', 'Three', 'Two']);

    const orders = (await db.notes.toArray()).map((note) => note.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('leaves a link that was not mentioned last, without rewriting its position twice', async () => {
    const folder = await createFolder({ name: 'Mixed', parentId: null });
    if (!folder.ok) throw new Error('folder');
    const folderId = folder.folder.id;
    const first = await createLink({ url: 'https://example.com/one', folderId, title: 'one' });
    const second = await createLink({ url: 'https://example.com/two', folderId, title: 'two' });

    // A stale screen offering only one of the two rows: the caller's order wins
    // for the row it names, and the unnamed row keeps a place after it.
    expect(await setLinkOrder(folderId, [second.id])).toBe(true);
    expect(await linkPositions(folderId)).toEqual(['two', 'one']);
    expect((await db.links.get(first.id))?.sortOrder).toBe(1);
  });
});
