import { describe, expect, it } from 'vitest';
import type { Folder, LinkTag, Note, NoteLink, SavedLink, Tag } from '@/db/types';
import { searchVault, tokenize, type VaultSnapshot } from '@/lib/search';

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

const folders: Folder[] = [folder('dev', 'Development'), folder('react', 'React', 'dev')];
const tags: Tag[] = [{ id: 't1', name: 'binary-search' }];
const linkTags: LinkTag[] = [{ linkId: 'l1', tagId: 't1' }];

const links: SavedLink[] = [
  link({
    id: 'l1',
    url: 'https://youtube.com/watch?v=abc',
    title: 'Binary Search Explained',
    folderId: 'react',
    source: 'youtube.com',
    userNote: 'watch before the interview',
    createdAt: 500,
  }),
  link({
    id: 'l2',
    url: 'https://example.com/indexing',
    title: 'How database indexes work',
    folderId: 'dev',
    source: 'example.com',
    createdAt: 400,
  }),
  link({
    id: 'l3',
    url: 'https://example.com/recipes',
    title: 'Slow roast lamb',
    source: 'example.com',
    isFavorite: true,
    createdAt: 300,
  }),
  link({
    id: 'l4',
    url: 'https://example.com/archived',
    title: 'Archived thing',
    isArchived: true,
    createdAt: 200,
  }),
];

const notes: Note[] = [
  {
    id: 'n-ml',
    parentNoteId: null,
    title: 'Machine Learning',
    content: 'Notes from the SVM lecture series',
    createdAt: 300,
    updatedAt: 300,
    sortOrder: 0,
    isFavorite: false,
    isArchived: false,
    isLocked: false,
  },
];

const noteLinks: NoteLink[] = [{ noteId: 'n-ml', linkId: 'l1', origin: 'attached', createdAt: 300, sortOrder: 0 }];

const snapshot: VaultSnapshot = { folders, links, tags, linkTags, notes, noteLinks };

function ids(query: string, filter?: Parameters<typeof searchVault>[1]['filter']) {
  return searchVault(snapshot, { query, ...(filter ? { filter } : {}) }).links.map((hit) => hit.link.id);
}

describe('tokenize', () => {
  it('splits on whitespace and punctuation and lower-cases', () => {
    expect(tokenize('  Binary, Search  ')).toEqual(['binary', 'search']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('searchVault', () => {
  it('finds by title', () => {
    expect(ids('binary')).toEqual(['l1']);
  });

  it('finds by URL and by domain', () => {
    expect(ids('indexing')).toEqual(['l2']);
    expect(ids('youtube.com')).toContain('l1');
  });

  it('finds by the user note', () => {
    expect(ids('interview')).toEqual(['l1']);
  });

  it('finds by tag', () => {
    expect(ids('binary-search')).toContain('l1');
  });

  it('finds by folder name, including ancestors', () => {
    expect(ids('development')).toEqual(expect.arrayContaining(['l1', 'l2']));
  });

  it('ranks a title match above a weak body match', () => {
    const results = searchVault(snapshot, { query: 'indexes' }).links;
    expect(results[0]?.link.id).toBe('l2');
  });

  it('requires all tokens, then relaxes rather than returning nothing', () => {
    const strict = searchVault(snapshot, { query: 'binary interview' });
    expect(strict.relaxed).toBe(false);
    expect(strict.links.map((h) => h.link.id)).toEqual(['l1']);

    const relaxed = searchVault(snapshot, { query: 'binary nonexistentterm' });
    expect(relaxed.relaxed).toBe(true);
    expect(relaxed.links.map((h) => h.link.id)).toEqual(['l1']);
  });

  it('returns a link carrying the legacy archive flag like any other', () => {
    // Archiving used to be a state the app could enter; it cannot any more, and
    // the migration clears it. A row that still carries the flag — an imported
    // backup from an older build, say — must be findable rather than lost.
    expect(ids('archived thing')).toEqual(['l4']);
  });

  it('reports which fields matched', () => {
    const hit = searchVault(snapshot, { query: 'binary' }).links[0];
    expect(hit?.matched).toContain('title');
  });

  it('resolves the folder path for each hit', () => {
    const hit = searchVault(snapshot, { query: 'binary' }).links[0];
    expect(hit?.folderPath).toBe('Development → React');
    expect(hit?.tagNames).toEqual(['binary-search']);
  });

  it('finds folders by name and by path', () => {
    const byName = searchVault(snapshot, { query: 'react' }).folders.map((hit) => hit.folder.id);
    expect(byName).toContain('react');
    const byPath = searchVault(snapshot, { query: 'development react' }).folders.map((hit) => hit.folder.id);
    expect(byPath).toContain('react');
  });

  it('returns recents newest-first for an empty query', () => {
    // `l4` carries the legacy archive flag and is an ordinary result, which is
    // the property that replaced "archived links are never returned".
    expect(ids('')).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('applies the favorites filter', () => {
    expect(ids('', 'favorites')).toEqual(['l3']);
  });

  it('applies the notes filter: notes surface, links step aside', () => {
    expect(ids('', 'notes')).toEqual([]);
    const noteHits = searchVault(snapshot, { query: '', filter: 'notes' }).notes;
    expect(noteHits.map((hit) => hit.note.id)).toEqual(['n-ml']);
  });

  it('searches notes by title and content, with attachment titles', () => {
    const byTitle = searchVault(snapshot, { query: 'machine' }).notes;
    expect(byTitle.map((hit) => hit.note.id)).toEqual(['n-ml']);

    const byContent = searchVault(snapshot, { query: 'svm lecture' }).notes;
    expect(byContent.map((hit) => hit.note.id)).toEqual(['n-ml']);

    const hit = byTitle[0];
    expect(hit?.resourceTitles).toContain('Binary Search Explained');
  });

  it('finds a link through a note that references it, and vice versa', () => {
    // The note's content mentions the lecture; the attached link still matches its own fields.
    const linkHit = searchVault(snapshot, { query: 'binary' }).links[0];
    expect(linkHit?.link.id).toBe('l1');
  });

  it('sorts the recent filter purely by date', () => {
    const recent = searchVault(snapshot, { query: 'e', filter: 'recent' }).links;
    const dates = recent.map((hit) => hit.link.createdAt);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it('honours the result limit', () => {
    expect(searchVault(snapshot, { query: '', limit: 2 }).links).toHaveLength(2);
  });

  it('can skip folder results for a lightweight query', () => {
    const outcome = searchVault(snapshot, { query: 'dev', includeFolders: false });
    expect(outcome.folders).toEqual([]);
  });
});
