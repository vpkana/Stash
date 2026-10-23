import { describe, expect, it } from 'vitest';
import { mergeVaultState } from '@/lib/sync/merge';
import {
  entityKey,
  entryKey,
  linkTagId,
  noteLinkId,
  type CanonicalFolder,
  type CanonicalLink,
  type CanonicalNote,
  type CanonicalTag,
  type SyncEntry,
} from '@/lib/sync/protocol';

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';

function rev(stamp: number, device: string, tag = 'abc123'): string {
  return `${String(stamp).padStart(13, '0')}-${tag.padEnd(16, '0').slice(0, 16)}-${device}`;
}

function folder(
  id: string,
  stamp: number,
  device: string,
  overrides: Partial<CanonicalFolder> = {},
): SyncEntry {
  const row: CanonicalFolder = {
    id,
    parentId: null,
    name: 'Folder',
    createdAt: 1000,
    updatedAt: stamp,
    sortOrder: 0,
    isFavorite: false,
    isLocked: false,
    ...overrides,
  };
  return { kind: 'folder', id, rev: rev(stamp, device), row };
}

function note(
  id: string,
  stamp: number,
  device: string,
  overrides: Partial<CanonicalNote> = {},
): SyncEntry {
  const row: CanonicalNote = {
    id,
    parentNoteId: null,
    title: 'Note',
    content: 'Body',
    createdAt: 1000,
    updatedAt: stamp,
    sortOrder: 0,
    isFavorite: false,
    isLocked: false,
    ...overrides,
  };
  return { kind: 'note', id, rev: rev(stamp, device), row };
}

function link(
  id: string,
  stamp: number,
  device: string,
  overrides: Partial<CanonicalLink> = {},
): SyncEntry {
  const row: CanonicalLink = {
    id,
    folderId: null,
    url: 'https://example.com/a',
    normalizedUrl: 'https://example.com/a',
    createdAt: 1000,
    updatedAt: stamp,
    isFavorite: false,
    isLocked: false,
    ...overrides,
  };
  return { kind: 'link', id, rev: rev(stamp, device), row };
}

function tag(id: string, name: string, device = DEVICE_A): SyncEntry {
  const row: CanonicalTag = { id, name };
  return { kind: 'tag', id, rev: rev(0, device), row };
}

function linkTag(linkId: string, tagId: string, device = DEVICE_A): SyncEntry {
  const id = linkTagId(linkId, tagId);
  return { kind: 'linkTag', id, rev: rev(0, device), row: { linkId, tagId } };
}

function noteLink(noteId: string, linkId: string, device = DEVICE_A): SyncEntry {
  const id = noteLinkId(noteId, linkId);
  return {
    kind: 'noteLink',
    id,
    rev: rev(1000, device),
    row: { noteId, linkId, origin: 'attached', createdAt: 1000, sortOrder: 0 },
  };
}

function map(...entries: SyncEntry[]): Map<string, SyncEntry> {
  return new Map(entries.map((entry) => [entryKey(entry), entry]));
}

function remote(deviceId: string, entries: Map<string, SyncEntry>): Map<string, Map<string, SyncEntry>> {
  return new Map([[deviceId, entries]]);
}

async function merge(
  base: Map<string, SyncEntry>,
  local: Map<string, SyncEntry>,
  remotes: Map<string, Map<string, SyncEntry>>,
  deviceId = DEVICE_A,
) {
  return mergeVaultState({ base, local, remotes, deviceId, at: 5000 });
}

describe('three-way merge', () => {
  it('keeps independent offline creates from both devices', async () => {
    const local = map(folder('f-local', 2000, DEVICE_A), note('n-local', 2000, DEVICE_A));
    const peers = remote(DEVICE_B, map(folder('f-peer', 2000, DEVICE_B), link('l-peer', 2000, DEVICE_B)));

    const result = await merge(new Map(), local, peers);

    expect(result.entries.has(entityKey('folder', 'f-local'))).toBe(true);
    expect(result.entries.has(entityKey('folder', 'f-peer'))).toBe(true);
    expect(result.entries.has(entityKey('note', 'n-local'))).toBe(true);
    expect(result.entries.has(entityKey('link', 'l-peer'))).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('does not merge folders by name', async () => {
    const local = map(folder('f-a', 2000, DEVICE_A, { name: 'Projects' }));
    const peers = remote(DEVICE_B, map(folder('f-b', 2000, DEVICE_B, { name: 'Projects' })));

    const result = await merge(new Map(), local, peers);

    expect(result.entries.has(entityKey('folder', 'f-a'))).toBe(true);
    expect(result.entries.has(entityKey('folder', 'f-b'))).toBe(true);
  });

  it('does not collapse independently saved links with the same URL', async () => {
    const local = map(link('l-a', 2000, DEVICE_A));
    const peers = remote(DEVICE_B, map(link('l-b', 2000, DEVICE_B)));

    const result = await merge(new Map(), local, peers);

    expect(result.entries.has(entityKey('link', 'l-a'))).toBe(true);
    expect(result.entries.has(entityKey('link', 'l-b'))).toBe(true);
  });

  it('preserves both edits of a note as a visible conflict copy', async () => {
    const base = map(note('n', 1000, DEVICE_A, { title: 'Base', content: 'base body' }));
    const local = map(note('n', 3000, DEVICE_A, { title: 'Local title', content: 'local body' }));
    const peers = remote(
      DEVICE_B,
      map(note('n', 2000, DEVICE_B, { title: 'Remote title', content: 'remote body' })),
    );

    const result = await merge(base, local, peers);

    const notes = [...result.entries.values()].filter((entry) => entry.kind === 'note');
    expect(notes).toHaveLength(2);
    const bodies = notes.map((entry) => (entry.row as CanonicalNote).content).sort();
    expect(bodies).toEqual(['local body', 'remote body']);
    const copy = notes.find((entry) => entry.id !== 'n');
    // Local is newer, so it keeps the original id and the peer's edit becomes
    // the visible copy.
    expect((copy?.row as CanonicalNote).title).toBe('Remote title (conflict copy)');
    expect(result.conflicts[0]?.reason).toBe('note-copy');
    expect(result.conflicts[0]?.copyId).toBe(copy?.id);
  });

  it('is idempotent when re-run over its own result', async () => {
    const base = map(note('n', 1000, DEVICE_A, { title: 'Base', content: 'base body' }));
    const local = map(note('n', 3000, DEVICE_A, { title: 'Local', content: 'local body' }));
    const peerMap = map(note('n', 2000, DEVICE_B, { title: 'Remote', content: 'remote body' }));

    const first = await merge(base, local, remote(DEVICE_B, peerMap));
    // A successful sync advances the peer checkpoint, so the next run sees no
    // unconsumed peer entries at all.
    const second = await merge(first.entries, first.entries, new Map());

    expect([...second.entries.keys()].sort()).toEqual([...first.entries.keys()].sort());
    expect(second.conflicts).toHaveLength(0);
    expect(second.stats.localChanges).toBe(0);
    expect(second.stats.remoteChanges).toBe(0);
  });

  it('is deterministic across devices and clock skew', async () => {
    const base = map(note('n', 1000, DEVICE_A, { title: 'Base', content: 'base' }));
    const local = map(note('n', 9_999_999_999_999, DEVICE_A, { title: 'Skewed', content: 'from A' }));
    const peerMap = map(note('n', 2000, DEVICE_B, { title: 'Peer', content: 'from B' }));

    const fromA = await merge(base, local, remote(DEVICE_B, peerMap), DEVICE_A);
    const fromB = await merge(base, peerMap, remote(DEVICE_A, local), DEVICE_B);

    expect([...fromA.entries.keys()].sort()).toEqual([...fromB.entries.keys()].sort());
    const bodies = [...fromA.entries.values()]
      .filter((entry) => entry.kind === 'note')
      .map((entry) => (entry.row as CanonicalNote).content)
      .sort();
    expect(bodies).toEqual(['from A', 'from B']);
  });

  it('merges different fields from different devices', async () => {
    const base = map(
      folder('p', 1000, DEVICE_A, { name: 'Parent' }),
      folder('f', 1000, DEVICE_A, { name: 'Old name', parentId: null }),
    );
    const local = map(
      folder('p', 1000, DEVICE_A, { name: 'Parent' }),
      folder('f', 2000, DEVICE_A, { name: 'New name', parentId: null }),
    );
    const peers = remote(
      DEVICE_B,
      map(
        folder('p', 1000, DEVICE_B, { name: 'Parent' }),
        folder('f', 3000, DEVICE_B, { name: 'Old name', parentId: 'p' }),
      ),
    );

    const result = await merge(base, local, peers);
    const merged = result.entries.get(entityKey('folder', 'f'))?.row as CanonicalFolder;

    expect(merged.name).toBe('New name');
    expect(merged.parentId).toBe('p');
  });

  it('resurrects an edit rather than honouring a concurrent deletion', async () => {
    const base = map(note('n', 1000, DEVICE_A, { title: 'Base', content: 'base' }));
    const local = new Map<string, SyncEntry>(); // hard delete on this device
    const peers = remote(DEVICE_B, map(note('n', 2000, DEVICE_B, { title: 'Edited', content: 'kept' })));

    const result = await merge(base, local, peers);

    const kept = result.entries.get(entityKey('note', 'n'));
    expect(kept?.deleted).toBeUndefined();
    expect((kept?.row as CanonicalNote).content).toBe('kept');
    expect(result.conflicts[0]?.reason).toBe('delete-edit');
  });

  it('deletes when the other device did not change the row', async () => {
    const base = map(link('l', 1000, DEVICE_A));
    const result = await merge(base, new Map(), new Map());

    expect(result.entries.get(entityKey('link', 'l'))?.deleted).toBe(true);
  });

  it('agrees on a tombstone when both devices delete', async () => {
    const base = map(link('l', 1000, DEVICE_A));
    const deleted: SyncEntry = {
      kind: 'link',
      id: 'l',
      rev: rev(2000, DEVICE_B),
      deleted: true,
      deletedAt: 2000,
    };
    const result = await merge(base, new Map(), remote(DEVICE_B, map(deleted)));

    expect(result.entries.get(entityKey('link', 'l'))?.deleted).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('never writes plaintext for a sealed note conflict', async () => {
    const sealed = {
      v: 1 as const,
      alg: 'AES-GCM' as const,
      iv: 'aXYtYQ==',
      ct: 'Y2lwaGVydGV4dA==',
    };
    const base = map(note('n', 1000, DEVICE_A, { title: '', content: '', isLocked: true, enc: sealed }));
    const local = map(
      note('n', 3000, DEVICE_A, { title: '', content: '', isLocked: true, enc: { ...sealed, ct: 'bG9jYWw=' } }),
    );
    const peers = remote(
      DEVICE_B,
      map(note('n', 2000, DEVICE_B, { title: '', content: '', isLocked: true, enc: { ...sealed, ct: 'cGVlcg==' } })),
    );

    const result = await merge(base, local, peers);
    const notes = [...result.entries.values()].filter((entry) => entry.kind === 'note');

    expect(notes).toHaveLength(1);
    expect((notes[0]?.row as CanonicalNote).title).toBe('');
    expect(result.conflicts[0]?.label).toBe('Locked note');
    expect(result.conflicts[0]?.remote?.row).toBeTruthy();
  });

  it('deduplicates concurrent tags by name and rewrites relations', async () => {
    const local = map(tag('tag-b', 'rust'), link('l', 1000, DEVICE_A), linkTag('l', 'tag-b'));
    const peers = remote(
      DEVICE_B,
      map(tag('tag-a', 'rust', DEVICE_B), link('l', 1000, DEVICE_B), linkTag('l', 'tag-a', DEVICE_B)),
    );

    const result = await merge(new Map(), local, peers);

    const liveTags = [...result.entries.values()].filter(
      (entry) => entry.kind === 'tag' && !entry.deleted,
    );
    expect(liveTags).toHaveLength(1);
    expect(liveTags[0]?.id).toBe('tag-a');
    const liveRelations = [...result.entries.values()].filter(
      (entry) => entry.kind === 'linkTag' && !entry.deleted,
    );
    expect(liveRelations).toHaveLength(1);
    expect((liveRelations[0]?.row as { tagId: string }).tagId).toBe('tag-a');
  });

  it('drops relations whose endpoints no longer exist', async () => {
    const base = map(
      link('l', 1000, DEVICE_A),
      tag('t', 'rust'),
      linkTag('l', 't'),
      note('n', 1000, DEVICE_A),
      noteLink('n', 'l'),
    );
    const local = new Map<string, SyncEntry>();
    const result = await merge(base, local, new Map());

    expect(result.entries.get(entityKey('linkTag', linkTagId('l', 't')))?.deleted).toBe(true);
    expect(result.entries.get(entityKey('noteLink', noteLinkId('n', 'l')))?.deleted).toBe(true);
    expect(result.entries.get(entityKey('link', 'l'))?.deleted).toBe(true);
  });

  it('repairs a missing folder parent and keeps the child', async () => {
    const local = map(folder('f', 2000, DEVICE_A, { parentId: 'gone' }));
    const result = await merge(new Map(), local, new Map());
    const row = result.entries.get(entityKey('folder', 'f'))?.row as CanonicalFolder;

    expect(row.parentId).toBeNull();
  });

  it('re-homes a live child of a deleted folder instead of orphaning it', async () => {
    const base = map(
      folder('p', 1000, DEVICE_A, { name: 'Parent' }),
      folder('c', 1000, DEVICE_A, { parentId: 'p' }),
    );
    const local = map(folder('c', 1000, DEVICE_A, { parentId: 'p' }));
    const result = await merge(base, local, new Map());

    expect(result.entries.get(entityKey('folder', 'p'))?.deleted).toBe(true);
    expect(
      (result.entries.get(entityKey('folder', 'c'))?.row as CanonicalFolder).parentId,
    ).toBeNull();
  });

  it('breaks folder cycles deterministically', async () => {
    const local = map(
      folder('a', 2000, DEVICE_A, { parentId: 'b' }),
      folder('b', 2000, DEVICE_A, { parentId: 'a' }),
    );
    const result = await merge(new Map(), local, new Map());

    const a = result.entries.get(entityKey('folder', 'a'))?.row as CanonicalFolder;
    const b = result.entries.get(entityKey('folder', 'b'))?.row as CanonicalFolder;
    expect(a.parentId).toBeNull();
    expect(b.parentId).toBe('a');
  });

  it('merges notes and links that reference moved or renamed entities', async () => {
    const base = map(
      folder('f', 1000, DEVICE_A, { name: 'Old' }),
      link('l', 1000, DEVICE_A, { folderId: 'f' }),
      note('n', 1000, DEVICE_A, { title: 'Note' }),
      noteLink('n', 'l'),
    );
    const local = map(
      folder('f', 2000, DEVICE_A, { name: 'New' }),
      link('l', 1000, DEVICE_A, { folderId: 'f' }),
      note('n', 1000, DEVICE_A, { title: 'Note' }),
      noteLink('n', 'l'),
    );
    const peers = remote(
      DEVICE_B,
      map(
        folder('f', 1000, DEVICE_B, { name: 'Old' }),
        link('l', 2000, DEVICE_B, { folderId: null }),
      ),
    );

    const result = await merge(base, local, peers);

    expect((result.entries.get(entityKey('folder', 'f'))?.row as CanonicalFolder).name).toBe('New');
    expect((result.entries.get(entityKey('link', 'l'))?.row as CanonicalLink).folderId).toBeNull();
    expect(result.entries.get(entityKey('noteLink', noteLinkId('n', 'l')))?.deleted).toBeUndefined();
  });
});
