import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { META_KEYS, StashDatabase, openDatabase, db, type ExportBundle } from '@/db';
import { ensureSeeded } from '@/db/seed';
import {
  createFolder,
  deleteFolder,
  getFolderStats,
  listFolders,
  moveFolder,
  renameFolder,
  reorderFolder,
  setFolderFavorite,
} from '@/db/repos/folders';
import {
  createLink,
  findDuplicates,
  listFavoriteLinks,
  listLinksInFolder,
  setLinkFavorite,
  updateLink,
} from '@/db/repos/links';
import { exportVault, getSnapshot, importVault, isValidBundle } from '@/db/repos/vault';
import { getRecentFolderIds, pruneRecentFolders, pushRecentFolder } from '@/db/repos/settings';
import { setLinkTags, tagsForLink } from '@/db/repos/tags';

/**
 * These run against a real Dexie database backed by fake-indexeddb, so
 * transactions, indexes, compound keys and version upgrades are exercised for
 * real rather than stubbed out.
 */

async function resetDatabase() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

beforeEach(async () => {
  await resetDatabase();
});

/** Create a folder and return its id, failing loudly if creation was rejected. */
async function mustCreate(input: { name: string; parentId?: string | null }): Promise<string> {
  const result = await createFolder(input);
  if (!result.ok) throw new Error(`createFolder("${input.name}") failed: ${result.reason}`);
  return result.folder.id;
}

describe('boot and persistence', () => {
  it('opens the vault', () => {
    expect(db.isOpen()).toBe(true);
  });

  it('seeds starter folders exactly once', async () => {
    expect(await ensureSeeded()).toBe(true);
    const first = await listFolders();
    expect(first.length).toBeGreaterThan(0);

    // A second boot must not duplicate the starters.
    expect(await ensureSeeded()).toBe(false);
    expect(await listFolders()).toHaveLength(first.length);
  });

  it('keeps the seeded flag in the meta table', async () => {
    await ensureSeeded();
    const row = await db.meta.get(META_KEYS.seeded);
    expect(row?.value).toBe(true);
  });

  it('survives a close and reopen without losing data', async () => {
    await mustCreate({ name: 'Kept' });
    db.close();
    await openDatabase();
    expect((await listFolders()).some((folder) => folder.name === 'Kept')).toBe(true);
  });
});

describe('folders', () => {
  it('creates arbitrary nested folders through parentId', async () => {
    const programming = await mustCreate({ name: 'Programming' });
    const web = await mustCreate({ name: 'Web Development', parentId: programming });
    const react = await mustCreate({ name: 'React', parentId: web });
    const tutorials = await mustCreate({ name: 'Tutorials', parentId: react });

    const store = (await listFolders()).find((folder) => folder.id === tutorials);
    expect(store?.parentId).toBe(react);
    expect(store?.name).toBe('Tutorials');
    // No path strings anywhere in storage: nesting is parentId only.
    expect(JSON.stringify(store)).not.toContain('Programming/Web');
  });

  it('rejects a duplicate name in the same parent and offers the existing one', async () => {
    await mustCreate({ name: 'Development' });
    const again = await createFolder({ name: 'development' });
    expect(again.ok).toBe(false);
    if (again.ok || again.reason !== 'duplicate') throw new Error('expected a duplicate rejection');
    expect(again.existing.name).toBe('Development');
  });

  it('allows the same name under different parents', async () => {
    const a = await mustCreate({ name: 'A' });
    const b = await mustCreate({ name: 'B' });
    expect((await createFolder({ name: 'Archive', parentId: a })).ok).toBe(true);
    expect((await createFolder({ name: 'Archive', parentId: b })).ok).toBe(true);
  });

  it('rejects an empty name', async () => {
    const result = await createFolder({ name: '   ' });
    expect(result.ok).toBe(false);
  });

  it('renames a folder and refuses a clashing name', async () => {
    await mustCreate({ name: 'Alpha' });
    const beta = await mustCreate({ name: 'Beta' });
    expect(await renameFolder(beta, 'Gamma')).not.toBeNull();
    expect(await renameFolder(beta, 'Alpha')).toBeNull();
  });

  it('moves a folder and refuses to create a cycle', async () => {
    const a = await mustCreate({ name: 'A' });
    const b = await mustCreate({ name: 'B', parentId: a });
    const c = await mustCreate({ name: 'C', parentId: b });

    expect((await moveFolder(a, c)).ok).toBe(false);
    expect((await moveFolder(c, a)).ok).toBe(true);
  });

  it('reorders siblings', async () => {
    await mustCreate({ name: 'First' });
    const second = await mustCreate({ name: 'Second' });
    expect(await reorderFolder(second, 'up')).toBe(true);

    const ordered = (await listFolders())
      .filter((folder) => folder.parentId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((folder) => folder.name);
    expect(ordered.indexOf('Second')).toBeLessThan(ordered.indexOf('First'));
  });

  it('toggles favorite state', async () => {
    const folder = await mustCreate({ name: 'Starred' });
    await setFolderFavorite(folder, true);
    expect((await listFolders()).find((candidate) => candidate.id === folder)?.isFavorite).toBe(true);
  });

  it('counts direct and nested links for every ancestor', async () => {
    const parent = await mustCreate({ name: 'Parent' });
    const child = await mustCreate({ name: 'Child', parentId: parent });
    await createLink({ url: 'https://example.com/a', folderId: parent });
    await createLink({ url: 'https://example.com/b', folderId: child });

    const stats = await getFolderStats();
    expect(stats.get(parent)).toMatchObject({ directLinks: 1, nestedLinks: 1, directChildren: 1 });
    expect(stats.get(child)).toMatchObject({ directLinks: 1, nestedLinks: 0 });
  });
});

describe('folder deletion never loses data silently', () => {
  it('move-contents-up keeps links and promotes subfolders', async () => {
    const root = await mustCreate({ name: 'Root' });
    const sub = await mustCreate({ name: 'Sub', parentId: root });
    await createLink({ url: 'https://example.com/a', folderId: root });
    await createLink({ url: 'https://example.com/b', folderId: sub });

    const result = await deleteFolder(root, 'move-contents-up');
    expect(result.ok).toBe(true);
    expect(result.removedLinkCount).toBe(0);
    expect(result.movedLinkCount).toBe(2);

    const snapshot = await getSnapshot();
    // Nothing is destroyed: both links survive and the subfolder is promoted to
    // where its parent used to sit (here, the top level).
    expect(snapshot.links).toHaveLength(2);
    expect(snapshot.folders.find((folder) => folder.name === 'Sub')?.parentId).toBeNull();
    expect(snapshot.links.every((link) => link.folderId === null)).toBe(true);
  });

  it('re-homes contents into the grandparent when there is one', async () => {
    const grandparent = await mustCreate({ name: 'Grandparent' });
    const parent = await mustCreate({ name: 'Parent', parentId: grandparent });
    await createLink({ url: 'https://example.com/a', folderId: parent });

    await deleteFolder(parent, 'move-contents-up');
    const snapshot = await getSnapshot();
    expect(snapshot.links[0]?.folderId).toBe(grandparent);
  });

  it('delete-everything removes the subtree and its links', async () => {
    const root = await mustCreate({ name: 'Doomed' });
    const sub = await mustCreate({ name: 'DoomedSub', parentId: root });
    await createLink({ url: 'https://example.com/a', folderId: root });
    await createLink({ url: 'https://example.com/b', folderId: sub });
    await createLink({ url: 'https://example.com/keep', folderId: null });

    const result = await deleteFolder(root, 'delete-everything');
    expect(result.removedFolderCount).toBe(2);
    expect(result.removedLinkCount).toBe(2);

    const snapshot = await getSnapshot();
    expect(snapshot.folders).toHaveLength(0);
    expect(snapshot.links).toHaveLength(1);
  });
});

describe('links and duplicate detection', () => {
  it('stores the original URL untouched and a normalized form separately', async () => {
    const link = await createLink({ url: 'https://WWW.Example.com/Post?utm_source=x', folderId: null });
    expect(link.url).toBe('https://WWW.Example.com/Post?utm_source=x');
    expect(link.normalizedUrl).toBe('https://example.com/Post');
  });

  it('derives the source domain when none is given', async () => {
    const link = await createLink({ url: 'https://www.youtube.com/watch?v=abc', folderId: null });
    expect(link.source).toBe('youtube.com');
  });

  it('detects an exact duplicate through aliases', async () => {
    const videos = await mustCreate({ name: 'Videos' });
    await createLink({ url: 'https://youtube.com/watch?v=abc', folderId: videos });

    const duplicates = await findDuplicates('https://youtu.be/abc');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.folderPath).toBe('Videos');
    expect(duplicates[0]?.exact).toBe(true);
  });

  it('does not flag a genuinely different resource', async () => {
    await createLink({ url: 'https://example.com/a?id=1', folderId: null });
    expect(await findDuplicates('https://example.com/a?id=2')).toHaveLength(0);
  });

  it('ignores its own record when editing', async () => {
    const link = await createLink({ url: 'https://example.com/a', folderId: null });
    expect(await findDuplicates(link.url, { excludeId: link.id })).toHaveLength(0);
  });

  it('reports the Inbox for links with no folder', async () => {
    await createLink({ url: 'https://example.com/loose', folderId: null });
    expect((await findDuplicates('https://example.com/loose'))[0]?.folderPath).toBe('Inbox');
  });

  it('lists Inbox links, which cannot be reached through the folderId index', async () => {
    await createLink({ url: 'https://example.com/a', folderId: null });
    const filed = await mustCreate({ name: 'Filed' });
    await createLink({ url: 'https://example.com/b', folderId: filed });

    expect((await listLinksInFolder(null)).map((link) => link.url)).toEqual(['https://example.com/a']);
    expect((await listLinksInFolder(filed)).map((link) => link.url)).toEqual(['https://example.com/b']);
  });

  it('can include nested links', async () => {
    const parent = await mustCreate({ name: 'P' });
    const child = await mustCreate({ name: 'C', parentId: parent });
    await createLink({ url: 'https://example.com/deep', folderId: child });

    expect(await listLinksInFolder(parent)).toHaveLength(0);
    expect(await listLinksInFolder(parent, { includeNested: true })).toHaveLength(1);
  });

  it('edits a link and clears empty fields', async () => {
    const link = await createLink({ url: 'https://example.com/a', folderId: null, userNote: 'first' });
    await updateLink(link.id, { userNote: 'second', title: 'Title' });
    const updated = await db.links.get(link.id);
    expect(updated?.userNote).toBe('second');
    expect(updated?.title).toBe('Title');

    await updateLink(link.id, { title: '   ' });
    expect((await db.links.get(link.id))?.title).toBeUndefined();
  });

  it('filters favorites with a scan, since IndexedDB cannot index booleans', async () => {
    const a = await createLink({ url: 'https://example.com/a', folderId: null });
    await createLink({ url: 'https://example.com/b', folderId: null });
    await setLinkFavorite(a.id, true);
    expect((await listFavoriteLinks()).map((link) => link.id)).toEqual([a.id]);
  });

  it('round-trips tags and normalizes their names', async () => {
    const link = await createLink({ url: 'https://example.com/a', folderId: null });
    await setLinkTags(link.id, ['#Deep Work', 'reading']);
    expect(await tagsForLink(link.id)).toEqual(['deep-work', 'reading']);
  });
});

describe('capture destinations', () => {
  it('remembers recently used folders, newest first and de-duplicated', async () => {
    const a = await mustCreate({ name: 'A' });
    const b = await mustCreate({ name: 'B' });
    await pushRecentFolder(a);
    await pushRecentFolder(b);
    await pushRecentFolder(a);
    expect(await getRecentFolderIds()).toEqual([a, b]);
  });

  it('drops destinations that no longer exist', async () => {
    const temporary = await mustCreate({ name: 'Temporary' });
    await pushRecentFolder(temporary);
    await deleteFolder(temporary, 'delete-everything');
    expect(await pruneRecentFolders()).toEqual([]);
  });
});

describe('export and import', () => {
  it('produces a self-describing bundle', async () => {
    await ensureSeeded();
    await createLink({ url: 'https://example.com/a', folderId: null, title: 'A' });
    const bundle = await exportVault();
    expect(bundle.format).toBe('stash-export');
    // Version 3 bundles carry notes, note references and the privacy keyring.
    expect(bundle.version).toBe(3);
    expect(bundle.links).toHaveLength(1);
    expect(bundle.notes).toEqual([]);
    expect(isValidBundle(bundle)).toBe(true);
  });

  it('rejects a foreign file', () => {
    expect(isValidBundle({ format: 'something-else' })).toBe(false);
    expect(isValidBundle(null)).toBe(false);
  });

  it('imports into a fresh vault, keeping folder relationships', async () => {
    const imported = await mustCreate({ name: 'Imported' });
    await createLink({ url: 'https://example.com/x', folderId: imported });
    const bundle = await exportVault();

    await resetDatabase();
    const result = await importVault(bundle, 'merge');
    expect(result.ok).toBe(true);
    expect(result.foldersImported).toBe(1);
    expect(result.linksImported).toBe(1);

    const snapshot = await getSnapshot();
    expect(snapshot.folders[0]?.name).toBe('Imported');
    expect(snapshot.links[0]?.folderId).toBe(snapshot.folders[0]?.id);
  });

  it('is idempotent: importing the same file twice changes nothing', async () => {
    await createLink({ url: 'https://example.com/x', folderId: null, title: 'Once' });
    const bundle = await exportVault();

    expect((await importVault(bundle, 'merge')).linksImported).toBe(0);
    expect((await importVault(bundle, 'merge')).linksSkipped).toBe(1);
    expect(await db.links.count()).toBe(1);
  });

  it('re-homes links whose folder is missing from the bundle', async () => {
    const bundle: ExportBundle = {
      format: 'stash-export',
      version: 1,
      exportedAt: Date.now(),
      folders: [],
      links: [
        {
          id: 'orphan',
          folderId: 'does-not-exist',
          url: 'https://example.com/orphan',
          normalizedUrl: 'https://example.com/orphan',
          createdAt: 1,
          updatedAt: 1,
          isFavorite: false,
          isArchived: false,
        },
      ],
      tags: [],
      linkTags: [],
      meta: [],
    };
    await importVault(bundle, 'merge');
    expect((await db.links.get('orphan'))?.folderId).toBeNull();
  });

  it('replace mode clears the vault first', async () => {
    await createLink({ url: 'https://example.com/old', folderId: null });
    const bundle: ExportBundle = {
      format: 'stash-export',
      version: 1,
      exportedAt: Date.now(),
      folders: [],
      links: [
        {
          id: 'new',
          folderId: null,
          url: 'https://example.com/new',
          normalizedUrl: 'https://example.com/new',
          createdAt: 1,
          updatedAt: 1,
          isFavorite: false,
          isArchived: false,
        },
      ],
      tags: [],
      linkTags: [],
      meta: [],
    };
    await importVault(bundle, 'replace');
    expect((await db.links.toArray()).map((link) => link.id)).toEqual(['new']);
  });
});

/**
 * An app update must never cost the user their vault. These two tests open a
 * database written with the previous schema and assert that Dexie's version
 * upgrade runs the migration and preserves every row.
 */
describe('schema migration', () => {
  async function createLegacyVault(name: string, setup: (db: Dexie) => Promise<void>) {
    await Dexie.delete(name);
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      folders: 'id, parentId, name, sortOrder, updatedAt',
      links: 'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt',
      tags: 'id, &name',
      linkTags: '[linkId+tagId], linkId, tagId',
      meta: 'key',
    });
    await legacy.open();
    await setup(legacy);
    legacy.close();
  }

  it('upgrades a version 1 vault to version 2 and backfills normalizedUrl', async () => {
    const name = 'stash-migration-test';
    await createLegacyVault(name, async (legacy) => {
      await legacy.table('links').bulkAdd([
        {
          id: 'old-1',
          folderId: null,
          url: 'https://WWW.Example.com/Page?utm_source=news',
          createdAt: 1,
          updatedAt: 1,
        },
        { id: 'old-2', folderId: null, url: 'https://youtu.be/abc', createdAt: 2, updatedAt: 2 },
      ]);
    });

    const upgraded = new StashDatabase(name);
    await upgraded.open();

    expect(await upgraded.links.count()).toBe(2);
    const migrated = await upgraded.links.get('old-1');
    expect(migrated).toBeDefined();
    expect(migrated?.normalizedUrl).toBe('https://example.com/Page');
    expect(migrated?.isArchived).toBe(false);
    expect(migrated?.isFavorite).toBe(false);
    expect((await upgraded.links.get('old-2'))?.normalizedUrl).toBe('https://youtube.com/watch?v=abc');

    upgraded.close();
    await Dexie.delete(name);
  });

  /**
   * The archive recovery, through real Dexie rather than a mock.
   *
   * A vault written by the previous build is opened by this one and the rows that
   * were archived have to come back — with their ids, folders, notes, timestamps
   * and hierarchy intact, because the whole reason the archive was recoverable is
   * that it never deleted anything. Losing a row here would be exactly the bug
   * this migration exists to end, so the test asserts on the rows themselves, not
   * on the count alone.
   */
  it('restores archived links and notes from a version 5 vault without losing any row', async () => {
    const name = 'stash-migration-archive-test';
    await Dexie.delete(name);
    const legacy = new Dexie(name);
    legacy.version(5).stores({
      folders: 'id, parentId, name, sortOrder, updatedAt, deletedAt, [parentId+sortOrder]',
      links:
        'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt, deletedAt, [folderId+createdAt]',
      tags: 'id, &name',
      linkTags: '[linkId+tagId], linkId, tagId',
      notes:
        'id, parentNoteId, title, sortOrder, createdAt, updatedAt, deletedAt, [parentNoteId+sortOrder]',
      noteLinks: '[noteId+linkId], noteId, linkId, createdAt',
      meta: 'key',
      security: 'key',
    });
    await legacy.open();

    await legacy.table('folders').bulkAdd([
      { id: 'f-dev', parentId: null, name: 'Developer', createdAt: 1, updatedAt: 1, sortOrder: 0, isFavorite: true, isLocked: true },
    ]);
    await legacy.table('links').bulkAdd([
      {
        id: 'l-live',
        folderId: 'f-dev',
        url: 'https://example.com/live',
        normalizedUrl: 'https://example.com/live',
        title: 'Live',
        userNote: 'kept',
        createdAt: 10,
        updatedAt: 10,
        isFavorite: false,
        isArchived: false,
        isLocked: false,
      },
      {
        id: 'l-archived',
        folderId: 'f-dev',
        url: 'https://example.com/archived',
        normalizedUrl: 'https://example.com/archived',
        title: 'Archived',
        userNote: 'the note I thought I had lost',
        createdAt: 20,
        updatedAt: 20,
        isFavorite: true,
        isArchived: true,
        isLocked: false,
      },
    ]);
    await legacy.table('notes').bulkAdd([
      {
        id: 'n-parent',
        parentNoteId: null,
        title: 'Parent',
        content: 'body',
        createdAt: 1,
        updatedAt: 1,
        sortOrder: 0,
        isFavorite: false,
        isArchived: true,
        isLocked: false,
      },
      {
        id: 'n-child',
        parentNoteId: 'n-parent',
        title: 'Child',
        content: 'inside',
        createdAt: 2,
        updatedAt: 2,
        sortOrder: 0,
        isFavorite: false,
        isArchived: false,
        isLocked: false,
      },
    ]);
    legacy.close();

    const upgraded = new StashDatabase(name);
    await upgraded.open();

    // Nothing was added or dropped.
    expect(await upgraded.links.count()).toBe(2);
    expect(await upgraded.folders.count()).toBe(1);
    expect(await upgraded.notes.count()).toBe(2);

    // The archived link is an ordinary link again, with everything about it intact.
    const restored = await upgraded.links.get('l-archived');
    expect(restored?.isArchived).toBe(false);
    expect(restored?.url).toBe('https://example.com/archived');
    expect(restored?.userNote).toBe('the note I thought I had lost');
    expect(restored?.folderId).toBe('f-dev');
    expect(restored?.createdAt).toBe(20);
    // Favourites, locks and folder names are untouched by the migration.
    expect(restored?.isFavorite).toBe(true);
    expect((await upgraded.folders.get('f-dev'))?.isLocked).toBe(true);
    expect((await upgraded.folders.get('f-dev'))?.name).toBe('Developer');

    // Note hierarchy survives, and the archived root comes back too.
    expect((await upgraded.notes.get('n-parent'))?.isArchived).toBe(false);
    expect((await upgraded.notes.get('n-child'))?.parentNoteId).toBe('n-parent');

    // The recovery is recorded, so "how many did this update bring back" is a
    // question the database can answer.
    const schemaInfo = (await upgraded.meta.get('db.schemaInfo'))?.value as {
      version: number;
      restoredFromArchive: { links: number; notes: number };
    };
    expect(schemaInfo.version).toBe(6);
    expect(schemaInfo.restoredFromArchive).toEqual({ links: 1, notes: 1 });

    upgraded.close();
    await Dexie.delete(name);
  });

  it('keeps unrelated preferences across a migration', async () => {
    const name = 'stash-migration-meta-test';
    await createLegacyVault(name, async (legacy) => {
      await legacy.table('meta').put({ key: 'theme.mode', value: 'dark' });
      await legacy.table('meta').put({ key: 'capture.recentFolders', value: ['keep-me'] });
    });

    const upgraded = new StashDatabase(name);
    await upgraded.open();
    expect((await upgraded.meta.get('theme.mode'))?.value).toBe('dark');
    expect((await upgraded.meta.get('capture.recentFolders'))?.value).toEqual(['keep-me']);
    upgraded.close();
    await Dexie.delete(name);
  });
});
