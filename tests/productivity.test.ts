import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import type { Folder, LinkTag, Note, NoteLink, SavedLink, Tag } from '@/db/types';
import { createFolder, deleteFolder } from '@/db/repos/folders';
import { createLink, moveLink, setLinkUnavailable } from '@/db/repos/links';
import { buildBackup } from '@/db/repos/backup';
import { getSnapshot } from '@/db/repos/vault';
import { getRecentFolderIds, pruneRecentFolders, pushRecentFolder } from '@/db/repos/settings';
import { trashLink } from '@/db/repos/trash';
import { parseBackup } from '@/lib/backup/validate';
import { computeFolderStats } from '@/lib/folder-stats';
import { SEARCH_FILTERS, searchFilterFrom, searchVault, type VaultSnapshot } from '@/lib/search';
import { breadcrumbOf, depthOf, descendantIdsOf, folderPathLabel } from '@/lib/tree';
import { inboxOf } from '@/stores/vault-store';

/**
 * The features that make the vault usable day to day, beyond capture itself:
 * the Inbox, recent destinations as a deterministic shortcut, link health as a
 * note the user keeps, and the scale at which the whole thing still has to feel
 * instant.
 *
 * The filter cases are pure, over a hand-built snapshot, because the rule being
 * tested is "which rows may this filter see" and a database would only add
 * ceremony. The Inbox, recents and health cases go through a real database,
 * because their rule is about what is *stored*, not what is scored.
 */

async function resetDatabase() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

beforeEach(async () => {
  await resetDatabase();
});

// ---------------------------------------------------------------------------
// Archived: a field the app no longer has
//
// These cases used to describe a filter that revealed what every other surface
// hid. That filter is gone and a migration restored the rows, so what is worth
// pinning down now is the opposite property: a row carrying the legacy flag is
// an ordinary row, visible under every filter that applies to it. If the flag
// ever started hiding things again, this is where it would show up.
// ---------------------------------------------------------------------------

function folder(id: string, name: string, parentId: string | null = null): Folder {
  return {
    id,
    parentId,
    name,
    createdAt: 1,
    updatedAt: 1,
    sortOrder: 0,
    isFavorite: false,
    isLocked: false,
  };
}

function link(partial: Partial<SavedLink> & { id: string; url: string }): SavedLink {
  return {
    folderId: null,
    normalizedUrl: partial.url,
    createdAt: 100,
    updatedAt: 100,
    isFavorite: false,
    isArchived: false,
    isLocked: false,
    ...partial,
  };
}

function note(id: string, title: string, partial: Partial<Note> = {}): Note {
  return {
    id,
    parentNoteId: null,
    title,
    content: '',
    createdAt: 1,
    updatedAt: 1,
    sortOrder: 0,
    isFavorite: false,
    isArchived: false,
    isLocked: false,
    ...partial,
  };
}

const LEGACY_FLAG_SNAPSHOT: VaultSnapshot = {
  folders: [folder('dev', 'Development')],
  links: [
    link({ id: 'live', url: 'https://example.com/live', title: 'Live link' }),
    link({ id: 'flagged', url: 'https://example.com/flagged', title: 'Flagged link', isArchived: true }),
    // The legacy flag *and* a lock. The lock is the stronger rule and still wins:
    // this row must not appear under any filter.
    link({ id: 'secret', url: 'https://example.com/secret', title: 'Secret link', isArchived: true }),
  ],
  notes: [
    note('live-note', 'Live note'),
    note('flagged-note', 'Flagged note', { isArchived: true }),
  ],
  tags: [] as Tag[],
  linkTags: [] as LinkTag[],
  noteLinks: [] as NoteLink[],
};

const LEGACY_FLAG_HIDDEN = {
  folders: new Set<string>(),
  notes: new Set<string>(),
  links: new Set<string>(['secret']),
};

describe('a transferred archive flag', () => {
  it('is an ordinary row under every filter', () => {
    for (const filter of ['all', 'links', 'notes', 'favorites', 'recent'] as const) {
      const outcome = searchVault(LEGACY_FLAG_SNAPSHOT, {
        query: '',
        filter,
        hidden: LEGACY_FLAG_HIDDEN,
      });
      const links = outcome.links.map((hit) => hit.link.id);
      if (filter === 'links' || filter === 'all' || filter === 'recent') {
        expect(links).toContain('flagged');
      } else {
        expect(links).not.toContain('flagged');
      }
    }
  });

  it('is found by search, exactly like any other link', () => {
    const outcome = searchVault(LEGACY_FLAG_SNAPSHOT, {
      query: 'flagged',
      filter: 'all',
      hidden: LEGACY_FLAG_HIDDEN,
    });
    expect(outcome.links.map((hit) => hit.link.id)).toEqual(['flagged']);
    expect(
      searchVault(LEGACY_FLAG_SNAPSHOT, { query: 'flagged', hidden: LEGACY_FLAG_HIDDEN }).notes.map(
        (hit) => hit.note.id,
      ),
    ).toEqual(['flagged-note']);
  });

  it('never reveals a row that is also locked', () => {
    for (const filter of ['all', 'links', 'recent'] as const) {
      const outcome = searchVault(LEGACY_FLAG_SNAPSHOT, {
        query: 'secret',
        filter,
        hidden: LEGACY_FLAG_HIDDEN,
      });
      const ids = [
        ...outcome.links.map((hit) => hit.link.id),
        ...outcome.notes.map((hit) => hit.note.id),
        ...outcome.folders.map((hit) => hit.folder.id),
      ];
      expect(ids).not.toContain('secret');
    }
  });
});

describe('searchFilterFrom', () => {
  it('accepts every filter this build has', () => {
    for (const entry of SEARCH_FILTERS) expect(searchFilterFrom(entry.id)).toBe(entry.id);
  });

  it('falls back to All for a removed or unknown filter instead of failing', () => {
    // `?filter=archived` is a real address — it was written into Settings, and it
    // is in the history of anyone who used the feature. It has to land somewhere.
    expect(searchFilterFrom('archived')).toBe('all');
    expect(searchFilterFrom('nonsense')).toBe('all');
    expect(searchFilterFrom(null)).toBe('all');
  });
});

// ---------------------------------------------------------------------------
// The Inbox: the absence of a folder
// ---------------------------------------------------------------------------

describe('the Inbox', () => {
  it('is every unfiled link — and nothing else', () => {
    const rows = [
      link({ id: 'unfiled', url: 'https://example.com/a', folderId: null }),
      link({ id: 'filed', url: 'https://example.com/b', folderId: 'dev' }),
      // Carries the legacy flag. An unfiled link is an Inbox link; there is no
      // longer a way for a saved link to be missing from the place it belongs.
      link({ id: 'flagged', url: 'https://example.com/c', folderId: null, isArchived: true }),
    ];
    expect(inboxOf(rows).map((row) => row.id).sort()).toEqual(['flagged', 'unfiled']);
  });

  it('orders newest first so a hurried save is the one you see', () => {
    const rows = [
      link({ id: 'old', url: 'https://example.com/old', createdAt: 10 }),
      link({ id: 'new', url: 'https://example.com/new', createdAt: 30 }),
      link({ id: 'mid', url: 'https://example.com/mid', createdAt: 20 }),
    ];
    expect(inboxOf(rows).map((row) => row.id)).toEqual(['new', 'mid', 'old']);
  });

  it('empties when a link is filed, without the link going anywhere', async () => {
    const target = await createFolder({ name: 'Development' });
    if (!target.ok) throw new Error('folder creation failed');
    const saved = await createLink({ url: 'https://example.com/a', folderId: null });

    let snapshot = await getSnapshot();
    expect(inboxOf(snapshot.links).map((row) => row.id)).toEqual([saved.id]);

    await moveLink(saved.id, target.folder.id);
    snapshot = await getSnapshot();
    expect(inboxOf(snapshot.links)).toEqual([]);
    // Filing is a move, so the link is still there — just somewhere else.
    expect(snapshot.links.find((row) => row.id === saved.id)!.folderId).toBe(target.folder.id);
  });

  it('loses a link to the trash, not to filing, when it is thrown away', async () => {
    const saved = await createLink({ url: 'https://example.com/a', folderId: null });
    await trashLink(saved.id);
    const snapshot = await getSnapshot();
    expect(snapshot.links.some((row) => row.id === saved.id)).toBe(false);
    expect(inboxOf(snapshot.links)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recent destinations: deterministic recency, no guessing
// ---------------------------------------------------------------------------

describe('recent destinations', () => {
  it('are a move-to-front list, so the last one used is the first offered', async () => {
    const a = await createFolder({ name: 'A' });
    const b = await createFolder({ name: 'B' });
    const c = await createFolder({ name: 'C' });
    if (!a.ok || !b.ok || !c.ok) throw new Error('folder creation failed');

    await pushRecentFolder(a.folder.id);
    await pushRecentFolder(b.folder.id);
    await pushRecentFolder(c.folder.id);
    expect(await getRecentFolderIds()).toEqual([c.folder.id, b.folder.id, a.folder.id]);

    await pushRecentFolder(a.folder.id);
    expect(await getRecentFolderIds()).toEqual([a.folder.id, c.folder.id, b.folder.id]);
  });

  it('forget a folder that has been thrown away, so it is never offered', async () => {
    const doomed = await createFolder({ name: 'Doomed' });
    const kept = await createFolder({ name: 'Kept' });
    if (!doomed.ok || !kept.ok) throw new Error('folder creation failed');

    await pushRecentFolder(doomed.folder.id);
    await pushRecentFolder(kept.folder.id);

    await deleteFolder(doomed.folder.id, 'delete-everything');

    expect(await pruneRecentFolders()).toEqual([kept.folder.id]);
    expect(await getRecentFolderIds()).toEqual([kept.folder.id]);
  });
});

// ---------------------------------------------------------------------------
// Link health: recorded by hand, honoured everywhere, never checked
// ---------------------------------------------------------------------------

describe('link health', () => {
  it('records when an address stopped working and clears it when it works again', async () => {
    const saved = await createLink({ url: 'https://example.com/gone', folderId: null });

    await setLinkUnavailable(saved.id, true);
    let row = (await getSnapshot()).links.find((candidate) => candidate.id === saved.id)!;
    expect(row.isUnavailable).toBe(true);
    expect(row.unavailableAt).toBeGreaterThan(0);

    await setLinkUnavailable(saved.id, false);
    row = (await getSnapshot()).links.find((candidate) => candidate.id === saved.id)!;
    expect(row.isUnavailable).toBe(false);
    // Removed outright rather than set to undefined, so "never unavailable" and
    // "unavailable, then cleared" cannot be confused.
    expect('unavailableAt' in row).toBe(false);
  });

  it('survives a backup and a restore, because it is something the user decided', async () => {
    const saved = await createLink({
      url: 'https://example.com/gone',
      folderId: null,
      title: 'Dead page',
    });
    await setLinkUnavailable(saved.id, true);

    const backup = await buildBackup({ mode: 'plaintext' });
    expect(backup.ok).toBe(true);
    if (!backup.text) throw new Error('expected backup text');

    const parsed = parseBackup(backup.text);
    if (parsed.kind !== 'ready') throw new Error(`expected a ready backup, got ${parsed.kind}`);

    const restored = parsed.data.links.find((row) => row.id === saved.id)!;
    expect(restored.isUnavailable).toBe(true);
    expect(restored.unavailableAt).toBeGreaterThan(0);
  });

  it('leaves trashed rows out of a backup rather than resurrecting them', async () => {
    const kept = await createLink({ url: 'https://example.com/kept', folderId: null });
    const thrown = await createLink({ url: 'https://example.com/thrown', folderId: null });
    await trashLink(thrown.id);

    const backup = await buildBackup({ mode: 'plaintext' });
    if (!backup.text) throw new Error('expected backup text');
    const parsed = parseBackup(backup.text);
    if (parsed.kind !== 'ready') throw new Error(`expected a ready backup, got ${parsed.kind}`);

    const ids = parsed.data.links.map((row) => row.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(thrown.id);
  });
});

// ---------------------------------------------------------------------------
// Scale: the shape of the data has to stop mattering
// ---------------------------------------------------------------------------

describe('deep nesting', () => {
  it('walks a very deep folder chain without recursing into a stack overflow', () => {
    const depth = 2000;
    const folders: Folder[] = [];
    for (let index = 0; index < depth; index += 1) {
      folders.push(folder(`f${index}`, `Level ${index}`, index === 0 ? null : `f${index - 1}`));
    }

    const leaf = `f${depth - 1}`;
    // An iterative walk handles a chain no recursive one could, which is the
    // whole reason the tree helpers are written the way they are.
    expect(descendantIdsOf(folders, 'f0')).toHaveLength(depth - 1);
    expect(depthOf(folders, leaf)).toBe(depth - 1);
    expect(breadcrumbOf(folders, leaf)).toHaveLength(depth);
    expect(folderPathLabel(folders, leaf)).toContain('Level 0 → Level 1');
  });

  it('stops instead of hanging when a corrupted cycle sneaks into the tree', () => {
    const folders: Folder[] = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    expect(descendantIdsOf(folders, 'a').length).toBeLessThanOrEqual(2);
    expect(breadcrumbOf(folders, 'a').length).toBeLessThanOrEqual(2);
    expect(depthOf(folders, 'a')).toBeLessThanOrEqual(2);
  });
});

describe('thousands of rows', () => {
  it('counts and searches a large vault in memory, quickly and correctly', async () => {
    const folderCount = 200;
    const linkCount = 2500;

    const folders: Folder[] = [];
    for (let index = 0; index < folderCount; index += 1) {
      folders.push({
        id: `folder-${index}`,
        parentId: index === 0 ? null : 'folder-0',
        name: `Folder ${index}`,
        createdAt: index,
        updatedAt: index,
        sortOrder: index,
        isFavorite: false,
        isLocked: false,
      });
    }

    const links: SavedLink[] = [];
    for (let index = 0; index < linkCount; index += 1) {
      const isNeedle = index === linkCount - 1;
      links.push({
        id: `link-${index}`,
        folderId: index % folderCount === 0 ? null : `folder-${index % folderCount}`,
        url: `https://example.com/${index}`,
        normalizedUrl: `https://example.com/${index}`,
        title: isNeedle ? 'Needle in a haystack' : `Link ${index}`,
        source: 'example.com',
        createdAt: index,
        updatedAt: index,
        isFavorite: false,
        isArchived: false,
        isLocked: false,
      });
    }

    await db.folders.bulkPut(folders);
    await db.links.bulkPut(links);

    const startedAt = Date.now();

    const snapshot = await getSnapshot();
    expect(snapshot.folders).toHaveLength(folderCount);
    expect(snapshot.links).toHaveLength(linkCount);

    const stats = computeFolderStats(snapshot.folders, snapshot.links);
    // Folder 0 is the root: its nested count is every *filed* link, because the
    // unfiled ones sit in the Inbox, which is not below any folder.
    const unfiled = links.filter((row) => row.folderId === null).length;
    expect(unfiled).toBeGreaterThan(0);
    expect(stats.get('folder-0')!.nestedLinks).toBe(linkCount - unfiled);
    expect(stats.get('folder-1')!.directLinks).toBe(
      links.filter((row) => row.folderId === 'folder-1').length,
    );

    const found = searchVault(snapshot as VaultSnapshot, { query: 'needle haystack' });
    expect(found.links.map((hit) => hit.link.id)).toEqual(['link-2499']);

    const elapsed = Date.now() - startedAt;
    // Deliberately loose: this is a guard against an accidental O(n^2), not a
    // benchmark. A regression that matters will blow past it by an order of
    // magnitude, and a slow machine will not trip it.
    expect(elapsed).toBeLessThan(4000);
  });
});
