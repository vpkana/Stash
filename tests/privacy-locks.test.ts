import { describe, expect, it } from 'vitest';
import type { Folder, Note, SavedLink } from '@/db/types';
import { computeFolderStats } from '@/lib/folder-stats';
import {
  allLockRoots,
  canAccess,
  computeProtection,
  hiddenIds,
  isHidden,
  isSealed,
  lockRootOf,
  openFolder,
  openLink,
  openNote,
  openVault,
  sealLink,
  sealNote,
} from '@/lib/privacy/protection';
import { generateVaultKey } from '@/lib/privacy/crypto';
import { searchVault } from '@/lib/search';

/**
 * The lock model, tested on plain objects.
 *
 * Two things are being asserted here and they are different questions:
 *
 *  - **inheritance**: which ids are protected, and therefore hidden from every
 *    listing while the session is locked;
 *  - **sealing**: which secret fields stop existing in plaintext in the record
 *    that goes to disk.
 *
 * Getting only the first right would be the "lock icon that hides UI" that the
 * feature exists to avoid, so each scenario below checks both.
 */

function folder(id: string, name: string, parentId: string | null = null, isLocked = false): Folder {
  return {
    id,
    parentId,
    name,
    createdAt: 1,
    updatedAt: 1,
    sortOrder: 0,
    isFavorite: false,
    isLocked,
  };
}

function note(id: string, title: string, parentNoteId: string | null = null, isLocked = false): Note {
  return {
    id,
    parentNoteId,
    title,
    content: `${title} body`,
    createdAt: 1,
    updatedAt: 1,
    sortOrder: 0,
    isFavorite: false,
    isArchived: false,
    isLocked,
  };
}

function link(id: string, url: string, folderId: string | null = null, isLocked = false): SavedLink {
  return {
    id,
    folderId,
    url,
    normalizedUrl: url,
    title: `Title of ${id}`,
    createdAt: 1,
    updatedAt: 1,
    isFavorite: false,
    isArchived: false,
    isLocked,
  };
}

describe('protection inheritance', () => {
  it('protects a locked folder and everything beneath it', () => {
    const folders = [
      folder('private', 'Private', null, true),
      folder('tax', 'Tax', 'private'),
      folder('2026', '2026', 'tax'),
      folder('dev', 'Development'),
    ];
    const links = [
      link('l-private', 'https://a.example', 'private'),
      link('l-tax', 'https://b.example', 'tax'),
      link('l-deep', 'https://c.example', '2026'),
      link('l-inbox', 'https://d.example', null),
      link('l-dev', 'https://e.example', 'dev'),
    ];

    const protection = computeProtection(folders, [], links);

    // Nested locked folder: three levels deep, all covered.
    expect([...protection.folders].sort()).toEqual(['2026', 'private', 'tax']);
    expect(protection.links.has('l-private')).toBe(true);
    expect(protection.links.has('l-tax')).toBe(true);
    expect(protection.links.has('l-deep')).toBe(true);
    // Untouched branches are untouched.
    expect(protection.links.has('l-inbox')).toBe(false);
    expect(protection.links.has('l-dev')).toBe(false);
    expect(protection.folders.has('dev')).toBe(false);
  });

  it('protects a locked root note and its subnotes', () => {
    const notes = [
      note('journal', 'Journal', null, true),
      note('august', 'August', 'journal'),
      note('aug-12', '12 August', 'august'),
      note('ideas', 'Ideas'),
    ];
    const protection = computeProtection([], notes, []);
    expect([...protection.notes].sort()).toEqual(['aug-12', 'august', 'journal']);
    expect(protection.notes.has('ideas')).toBe(false);
  });

  it('protects a locked subnote without touching its parent or siblings', () => {
    const notes = [
      note('health', 'Health'),
      note('bloods', 'Blood results', 'health', true),
      note('diet', 'Diet', 'health'),
      note('under', 'Under the results', 'bloods'),
    ];
    const protection = computeProtection([], notes, []);
    expect([...protection.notes].sort()).toEqual(['bloods', 'under']);
    expect(protection.notes.has('health')).toBe(false);
    expect(protection.notes.has('diet')).toBe(false);
  });

  it('protects a locked link on its own, outside any locked folder', () => {
    const protection = computeProtection([folder('dev', 'Development')], [], [link('l', 'https://x.example', 'dev', true)]);
    expect(protection.links.has('l')).toBe(true);
    expect(protection.folders.size).toBe(0);
  });

  it('terminates on a corrupted parent cycle', () => {
    const folders = [folder('a', 'A', 'b', true), folder('b', 'B', 'a')];
    const protection = computeProtection(folders, [], []);
    expect(protection.folders.has('a')).toBe(true);
    expect(protection.folders.has('b')).toBe(true);
  });

  it('withholds every protected id until its own boundary is crossed', () => {
    const folders = [folder('private', 'Private', null, true)];
    const notes = [note('journal', 'Journal', null, true)];
    const links = [link('l', 'https://a.example', 'private')];
    const protection = computeProtection(folders, notes, links);

    // Nothing granted: the whole protected set is withheld.
    const locked = hiddenIds(protection, new Set());
    expect(isHidden(locked, 'folder', 'private')).toBe(true);
    expect(isHidden(locked, 'note', 'journal')).toBe(true);
    expect(isHidden(locked, 'link', 'l')).toBe(true);

    // Every boundary open: the same ids are ordinary content again.
    const open = hiddenIds(protection, allLockRoots(protection));
    expect(isHidden(open, 'folder', 'private')).toBe(false);
    expect(isHidden(open, 'note', 'journal')).toBe(false);
    expect(isHidden(open, 'link', 'l')).toBe(false);
  });

  it('opens one locked folder without opening another', () => {
    // The regression this whole model exists for: two locked folders, one of them
    // opened, and the other must stay exactly as shut as it was.
    const folders = [
      folder('private', 'Private', null, true),
      folder('banking', 'Banking', null, true),
      folder('bank-statements', 'Statements', 'banking'),
      folder('work', 'Work'),
    ];
    const links = [
      link('l-private', 'https://a.example', 'private'),
      link('l-bank', 'https://b.example', 'bank-statements'),
      link('l-work', 'https://c.example', 'work'),
    ];
    const protection = computeProtection(folders, [], links);
    const granted = new Set(['private']);

    expect(canAccess(protection, granted, 'folder', 'private')).toBe(true);
    expect(canAccess(protection, granted, 'folder', 'banking')).toBe(false);
    // Inheritance is decided on the root, so the child of a still-locked folder is
    // still locked even though it was never locked itself.
    expect(lockRootOf(protection, 'folder', 'bank-statements')).toBe('banking');
    expect(canAccess(protection, granted, 'folder', 'bank-statements')).toBe(false);
    expect(canAccess(protection, granted, 'link', 'l-bank')).toBe(false);

    // Inside the opened folder, and in unprotected branches, everything is fine.
    expect(canAccess(protection, granted, 'link', 'l-private')).toBe(true);
    expect(canAccess(protection, granted, 'link', 'l-work')).toBe(true);
    expect(canAccess(protection, granted, 'folder', 'work')).toBe(true);

    const hidden = hiddenIds(protection, granted);
    expect([...hidden.folders].sort()).toEqual(['bank-statements', 'banking']);
    expect([...hidden.links].sort()).toEqual(['l-bank']);
  });
});

describe('sealing', () => {
  it('removes a note title and body from the record that is stored', async () => {
    const key = await generateVaultKey();
    const original = note('n1', 'Therapy notes');
    const sealed = await sealNote(original, key);

    expect(sealed.title).toBe('');
    expect(sealed.content).toBe('');
    expect(isSealed(sealed)).toBe(true);
    // The sensitive words are gone from the row that IndexedDB will hold.
    expect(JSON.stringify(sealed)).not.toContain('Therapy');

    const opened = await openNote(sealed, key);
    expect(opened.title).toBe('Therapy notes');
    expect(opened.content).toBe('Therapy notes body');
    expect(isSealed(opened)).toBe(false);
  });

  it('removes a link address, title and note from the record that is stored', async () => {
    const key = await generateVaultKey();
    const original: SavedLink = {
      ...link('l1', 'https://clinic.example/results/1234', null, true),
      userNote: 'Ask about the dosage',
      source: 'clinic.example',
      rawText: 'shared from the clinic app',
    };
    const sealed = await sealLink(original, key);

    expect(sealed.url).toBe('');
    expect(sealed.normalizedUrl).toBe('');
    expect(sealed.title).toBeUndefined();
    expect(sealed.userNote).toBeUndefined();
    expect(sealed.source).toBeUndefined();
    expect(sealed.rawText).toBeUndefined();
    // Nothing sensitive survives anywhere in the stored JSON.
    const stored = JSON.stringify(sealed);
    for (const secret of ['clinic.example', 'dosage', '1234', 'shared from']) {
      expect(stored).not.toContain(secret);
    }
    // Structural fields stay, so the tree and the counts still work.
    expect(sealed.id).toBe('l1');
    expect(sealed.isLocked).toBe(true);
    expect(sealed.createdAt).toBe(1);

    const opened = await openLink(sealed, key);
    expect(opened.url).toBe('https://clinic.example/results/1234');
    expect(opened.userNote).toBe('Ask about the dosage');
    expect(opened.source).toBe('clinic.example');
    expect(opened.rawText).toBe('shared from the clinic app');
  });

  it('keeps a folder name readable while sealing what is inside it', async () => {
    // The name is the label on the lock, not the content behind it. Without it a
    // protected folder is indistinguishable from every other protected folder —
    // including in the share destination picker, where the user has to say which
    // one a link is going into.
    const key = await generateVaultKey();
    const name = 'Divorce';
    const stored = folder('f1', name, null, true);
    expect(stored.name).toBe(name);

    // A row written by an earlier build still holds a sealed name. Without a key
    // it stays blank — the app has nothing to show and says so — and reconcile
    // opens it once a key is available, which is the migration.
    const legacy: Folder = {
      ...folder('f2', '', null, true),
      enc: { v: 1, alg: 'AES-GCM', iv: 'AAAA', ct: 'AAAA' },
    };
    expect(isSealed(legacy)).toBe(true);
    expect((await openFolder(legacy, null)).name).toBe('');
    expect((await openFolder(legacy, null)).enc).toBeDefined();
    // A folder that was never sealed is untouched by either direction.
    const plain = folder('f3', 'Work');
    expect(await openFolder(plain, key)).toBe(plain);
  });

  it('produces blank fields, not an error, when there is no key', async () => {
    const key = await generateVaultKey();
    const sealed = await sealNote(note('n1', 'Private'), key);
    const parked = await openNote(sealed, null);
    expect(parked.title).toBe('');
    // The ciphertext is kept: opening is not something that can be "skipped
    // over" without losing the ability to open it later.
    expect(isSealed(parked)).toBe(true);
  });

  it('refuses to seal content without a key rather than writing plaintext', async () => {
    await expect(sealNote(note('n1', 'Private'), null)).rejects.toThrow();
    await expect(sealLink(link('l1', 'https://x.example'), null)).rejects.toThrow();
  });

  it('is idempotent: sealing an already-sealed row is a no-op', async () => {
    const key = await generateVaultKey();
    const plain = note('n1', 'Ordinary');
    const sealed = await sealNote(plain, key);
    // Re-sealing must return the same row rather than encrypting the ciphertext
    // again, which would make the payload unreadable after a second pass.
    expect(await sealNote(sealed, key)).toBe(sealed);
  });

  it('leaves an unsealed row untouched when it is opened', async () => {
    const key = await generateVaultKey();
    const plain = note('n1', 'Ordinary');
    expect(await openNote(plain, key)).toBe(plain);
    expect(await openNote(plain, null)).toBe(plain);
  });

  it('skips a row it cannot decrypt instead of failing the whole read', async () => {
    const key = await generateVaultKey();
    const foreign = await sealNote(note('foreign', 'From another device'), await generateVaultKey());
    const ours = await sealNote(note('ours', 'Ours'), key);

    const opened = await openVault({ folders: [], links: [], notes: [foreign, ours] }, key);
    // The readable row opens; the foreign one is surfaced as locked rather than
    // taking the vault down with it.
    expect(opened.notes.find((entry) => entry.id === 'ours')?.title).toBe('Ours');
    const parked = opened.notes.find((entry) => entry.id === 'foreign');
    expect(parked?.title).toBe('');
    expect(isSealed(parked ?? {})).toBe(true);
  });
});

describe('counts and search while locked', () => {
  const folders = [
    folder('private', 'Private', null, true),
    folder('tax', 'Tax', 'private'),
    folder('dev', 'Development'),
  ];
  const notes = [note('journal', 'Journal', null, true), note('ideas', 'Ideas')];
  const links = [
    link('l-private', 'https://secret.example', 'private'),
    link('l-dev', 'https://docs.example', 'dev'),
  ];
  const protection = computeProtection(folders, notes, links);
  const locked = hiddenIds(protection, new Set());

  it('excludes locked ids from folder counts', () => {
    const stats = computeFolderStats(folders, links, {
      hiddenFolderIds: locked.folders,
      hiddenLinkIds: locked.links,
    });
    // A hidden folder gets no entry at all: a row of zeroes would still say
    // "something is here".
    expect(stats.has('private')).toBe(false);
    expect(stats.has('tax')).toBe(false);
    expect(stats.get('dev')).toEqual({ directLinks: 1, nestedLinks: 0, directChildren: 0 });
  });

  it('counts the same folders normally while unlocked', () => {
    const stats = computeFolderStats(folders, links, {});
    expect(stats.get('private')).toEqual({ directLinks: 1, nestedLinks: 0, directChildren: 1 });
    expect(stats.get('tax')).toEqual({ directLinks: 0, nestedLinks: 0, directChildren: 0 });
    expect(stats.get('dev')).toEqual({ directLinks: 1, nestedLinks: 0, directChildren: 0 });
  });

  it('returns no search hit for locked content, under any filter', () => {
    const snapshot = { folders, notes, links, tags: [], linkTags: [], noteLinks: [] };
    for (const filter of ['all', 'notes', 'links', 'favorites', 'recent'] as const) {
      for (const query of ['Journal', 'secret.example', 'Private', 'Tax']) {
        const outcome = searchVault(snapshot, { query, filter, hidden: locked });
        expect(outcome.links, `${filter}/${query}`).toHaveLength(0);
        expect(outcome.notes, `${filter}/${query}`).toHaveLength(0);
        expect(outcome.folders, `${filter}/${query}`).toHaveLength(0);
      }
    }
  });

  it('finds the same content once unlocked', () => {
    const snapshot = { folders, notes, links, tags: [], linkTags: [], noteLinks: [] };
    const outcome = searchVault(snapshot, { query: 'Journal', hidden: hiddenIds(protection, allLockRoots(protection)) });
    expect(outcome.notes.map((hit) => hit.note.id)).toEqual(['journal']);
  });

  it('does not reveal a locked item through a recency listing with an empty query', () => {
    const snapshot = { folders, notes, links, tags: [], linkTags: [], noteLinks: [] };
    const outcome = searchVault(snapshot, { query: '', filter: 'all', hidden: locked });
    expect(outcome.links.map((hit) => hit.link.id)).toEqual(['l-dev']);
    expect(outcome.notes.map((hit) => hit.note.id)).toEqual(['ideas']);
    expect(outcome.folders.map((hit) => hit.folder.id)).toEqual(['dev']);
  });

  it('does not leak a locked folder through its path labels in search', () => {
    const snapshot = { folders, notes, links, tags: [], linkTags: [], noteLinks: [] };
    // "Tax" is only reachable through the locked "Private" folder.
    const outcome = searchVault(snapshot, { query: 'Tax', hidden: locked, includeFolders: true });
    expect(outcome.folders).toHaveLength(0);
  });
});
