import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import { createFolder } from '@/db/repos/folders';
import { createLink, setLinkOrder } from '@/db/repos/links';

/**
 * The order a drag leaves behind.
 *
 * Dragging a link is only worth anything if the position is still there after a
 * reload, so this pins the write rather than the gesture: the whole list the user
 * left on screen becomes the stored order, and nothing else moves.
 */

async function reset() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

describe('explicit link order', () => {
  let folderId: string;
  let ids: string[];

  beforeEach(async () => {
    await reset();
    const folder = await createFolder({ name: 'Reading', parentId: null });
    if (!folder.ok) throw new Error('folder');
    folderId = folder.folder.id;

    ids = [];
    for (const name of ['a', 'b', 'c']) {
      const link = await createLink({ url: `https://example.com/${name}`, folderId, title: name });
      ids.push(link.id);
    }
  });

  it('writes a position for every row, in the order it was given', async () => {
    const reversed = [...ids].reverse();
    expect(await setLinkOrder(folderId, reversed)).toBe(true);

    const stored = await db.links.where('folderId').equals(folderId).toArray();
    const byPosition = stored
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((link) => link.id);
    expect(byPosition).toEqual(reversed);
  });

  it('ignores ids from another folder, so a stale list cannot re-home anything', async () => {
    const elsewhere = await createLink({ url: 'https://example.com/other', folderId: null });

    expect(await setLinkOrder(folderId, [elsewhere.id, ...ids])).toBe(true);

    // The Inbox row was not given a position in this folder, and the folder's own
    // rows were ordered as if it had never been mentioned.
    expect((await db.links.get(elsewhere.id))?.sortOrder).toBeUndefined();
    const stored = await db.links.where('folderId').equals(folderId).toArray();
    const byPosition = stored
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((link) => link.id);
    expect(byPosition).toEqual(ids);
  });

  it('orders one folder without touching another', async () => {
    const other = await createFolder({ name: 'Work', parentId: null });
    if (!other.ok) throw new Error('folder');
    const kept = await createLink({ url: 'https://example.com/w', folderId: other.folder.id });

    await setLinkOrder(folderId, [...ids].reverse());

    expect((await db.links.get(kept.id))?.sortOrder).toBeUndefined();
    expect((await db.links.get(kept.id))?.folderId).toBe(other.folder.id);
  });
});
