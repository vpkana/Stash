import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import type { Note } from '@/db/types';
import { canonicalNote, revisionForRow, type SyncEntry } from '@/lib/sync/protocol';
import { countPendingChanges } from '@/lib/sync/pending';
import { baseRow } from '@/db/repos/sync';
import { conflictSummary, resolveConflict } from '@/db/repos/sync-conflicts';
import { forgetVaultKey } from '@/lib/privacy/keyring';

/**
 * The local half of conflict handling: what "keep this device's version" and
 * "use the other device's version" actually do to the database.
 *
 * These tests run against real Dexie transactions. They deliberately do not go
 * through the merge engine — the engine's own suite covers how a conflict is
 * detected; this covers what a person's decision does afterwards.
 */

async function resetDatabase(): Promise<void> {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
  forgetVaultKey();
}

function note(overrides: Partial<Note> & { id: string }): Note {
  return {
    parentNoteId: null,
    title: 'Untitled',
    content: '',
    createdAt: 1_000,
    updatedAt: 1_000,
    sortOrder: 0,
    isFavorite: false,
    isArchived: false,
    isLocked: false,
    ...overrides,
  };
}

async function entryFor(row: Note, device = 'device-a'): Promise<SyncEntry> {
  return { kind: 'note', id: row.id, rev: await revisionForRow('note', canonicalNote(row), device), row: canonicalNote(row) };
}

beforeEach(async () => {
  await resetDatabase();
});

describe('countPendingChanges', () => {
  it('is zero for an empty vault', async () => {
    expect(await countPendingChanges()).toBe(0);
  });

  it('counts new rows, including relationships, until they are in the base', async () => {
    await db.folders.put({
      id: 'folder-1',
      parentId: null,
      name: 'Reading',
      createdAt: 1,
      updatedAt: 1,
      sortOrder: 0,
      isFavorite: false,
      isLocked: false,
    });
    const row = note({ id: 'note-1', title: 'A note' });
    await db.notes.put(row);
    await db.tags.put({ id: 'tag-1', name: 'rust' });
    await db.linkTags.put({ linkId: 'link-1', tagId: 'tag-1' });
    await db.noteLinks.put({ noteId: 'note-1', linkId: 'link-1', origin: 'attached', createdAt: 5, sortOrder: 0 });

    expect(await countPendingChanges()).toBe(5);

    const baseTime = 10_000;
    await db.syncBase.put(
      baseRow(
        {
          kind: 'folder',
          id: 'folder-1',
          rev: '0',
          row: {
            id: 'folder-1',
            parentId: null,
            name: 'Reading',
            createdAt: 1,
            updatedAt: 1,
            sortOrder: 0,
            isFavorite: false,
            isLocked: false,
          },
        },
        baseTime,
      ),
    );
    await db.syncBase.put(baseRow({ kind: 'note', id: 'note-1', rev: '0', row: canonicalNote(row) }, baseTime));
    await db.syncBase.put(baseRow({ kind: 'tag', id: 'tag-1', rev: '0', row: { id: 'tag-1', name: 'rust' } }, baseTime));
    await db.syncBase.put(
      baseRow({ kind: 'linkTag', id: 'link-1~tag-1', rev: '0', row: { linkId: 'link-1', tagId: 'tag-1' } }, baseTime),
    );
    await db.syncBase.put(
      baseRow(
        {
          kind: 'noteLink',
          id: 'note-1~link-1',
          rev: '0',
          row: { noteId: 'note-1', linkId: 'link-1', origin: 'attached', createdAt: 5, sortOrder: 0 },
        },
        baseTime,
      ),
    );

    expect(await countPendingChanges()).toBe(0);
  });

  it('reports an edit and a deletion, and ignores a base tombstone with no row', async () => {
    const row = note({ id: 'note-1', title: 'Before' });
    await db.notes.put(row);
    await db.syncBase.put(baseRow(await entryFor(row), 1));

    const changed = { ...row, title: 'After', updatedAt: 2_000 };
    await db.notes.put(changed);
    expect(await countPendingChanges()).toBe(1);

    await db.notes.delete('note-1');
    expect(await countPendingChanges()).toBe(1);

    await db.syncBase.put(
      baseRow({ kind: 'note', id: 'note-1', rev: '0', deleted: true, deletedAt: 3_000 }, 2),
    );
    expect(await countPendingChanges()).toBe(0);
  });
});

describe('resolveConflict', () => {
  const conflictId = 'note:note-1';

  async function setup(localRow: Note, remoteRow: Note) {
    await db.notes.put(localRow);
    const local = await entryFor(localRow);
    const remote = await entryFor(remoteRow, 'device-b');
    await db.syncConflicts.put({
      id: conflictId,
      kind: 'note',
      entityId: localRow.id,
      reason: 'fields',
      label: 'The note',
      detectedAt: 5_000,
      local,
      remote,
      fields: ['title', 'content'],
    });
    return { local, remote };
  }

  it('keeps this device’s version and records the remote version as the new base', async () => {
    const localRow = note({ id: 'note-1', title: 'Mine', content: 'mine' });
    const remoteRow = note({ id: 'note-1', title: 'Theirs', content: 'theirs' });
    const { remote } = await setup(localRow, remoteRow);

    const result = await resolveConflict(conflictId, 'local');
    expect(result.ok).toBe(true);

    const stored = await db.notes.get('note-1');
    expect(stored?.title).toBe('Mine');
    expect(stored?.content).toBe('mine');
    expect(await db.syncConflicts.get(conflictId)).toBeUndefined();

    const base = await db.syncBase.get(conflictId);
    expect(base?.entry).toEqual(remote);
  });

  it('uses the other device’s version and makes it stable', async () => {
    const localRow = note({ id: 'note-1', title: 'Mine', content: 'mine' });
    const remoteRow = note({ id: 'note-1', title: 'Theirs', content: 'theirs' });
    const { remote } = await setup(localRow, remoteRow);

    const result = await resolveConflict(conflictId, 'remote');
    expect(result.ok).toBe(true);

    const stored = await db.notes.get('note-1');
    expect(stored?.title).toBe('Theirs');
    expect(stored?.content).toBe('theirs');
    expect(await db.syncConflicts.get(conflictId)).toBeUndefined();

    const base = await db.syncBase.get(conflictId);
    expect(base?.entry).toEqual(remote);
    // Vault equals the new base, so this resolution publishes no further change.
    expect(await countPendingChanges()).toBe(0);
  });

  it('keeps both versions when dismissed, and changes no vault row', async () => {
    const localRow = note({ id: 'note-1', title: 'Mine' });
    const remoteRow = note({ id: 'note-1', title: 'Theirs' });
    await setup(localRow, remoteRow);
    await db.syncBase.put(baseRow(await entryFor(localRow), 1));
    const before = await db.syncBase.get(conflictId);

    const result = await resolveConflict(conflictId, 'dismiss');
    expect(result.ok).toBe(true);

    expect((await db.notes.get('note-1'))?.title).toBe('Mine');
    expect(await db.syncConflicts.get(conflictId)).toBeUndefined();
    expect(await db.syncBase.get(conflictId)).toEqual(before);
  });

  it('applies a deletion from the other device without resurrecting the row', async () => {
    const localRow = note({ id: 'note-1', title: 'Still here' });
    await db.notes.put(localRow);
    const local = await entryFor(localRow);
    const remote: SyncEntry = {
      kind: 'note',
      id: 'note-1',
      rev: '0000000002000-0123456789abcdef-device-b',
      deleted: true,
      deletedAt: 2_000,
    };
    await db.syncConflicts.put({
      id: conflictId,
      kind: 'note',
      entityId: 'note-1',
      reason: 'fields',
      label: 'The note',
      detectedAt: 3_000,
      local,
      remote,
    });

    const result = await resolveConflict(conflictId, 'remote');
    expect(result.ok).toBe(true);
    expect(await db.notes.get('note-1')).toBeUndefined();
    expect((await db.syncBase.get(conflictId))?.entry).toEqual(remote);
  });

  it('leaves fields outside the sync schema, such as the legacy archive flag, alone', async () => {
    const localRow = note({ id: 'note-1', title: 'Mine', isArchived: true });
    const remoteRow = note({ id: 'note-1', title: 'Theirs' });
    await setup(localRow, remoteRow);

    await resolveConflict(conflictId, 'local');
    expect((await db.notes.get('note-1'))?.isArchived).toBe(true);
  });

  it('defaults a recreated note to not archived', async () => {
    const remoteRow = note({ id: 'note-1', title: 'From elsewhere' });
    const remote = await entryFor(remoteRow, 'device-b');
    await db.syncConflicts.put({
      id: conflictId,
      kind: 'note',
      entityId: 'note-1',
      reason: 'fields',
      label: 'The note',
      detectedAt: 3_000,
      remote,
    });

    await resolveConflict(conflictId, 'remote');
    expect((await db.notes.get('note-1'))?.isArchived).toBe(false);
  });

  it('refuses a choice whose version is no longer in the record', async () => {
    await db.syncConflicts.put({
      id: conflictId,
      kind: 'note',
      entityId: 'note-1',
      reason: 'fields',
      label: 'The note',
      detectedAt: 3_000,
    });

    const result = await resolveConflict(conflictId, 'remote');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no longer available');
    expect(await db.syncConflicts.get(conflictId)).toBeDefined();
  });
});

describe('conflictSummary', () => {
  it('explains the two informational reasons without reading a row', () => {
    expect(
      conflictSummary({
        id: 'note:1',
        kind: 'note',
        entityId: '1',
        reason: 'note-copy',
        label: 'A note',
        detectedAt: 1,
      }),
    ).toContain('copy');

    expect(
      conflictSummary({
        id: 'link:1',
        kind: 'link',
        entityId: '1',
        reason: 'delete-edit',
        label: 'A link',
        detectedAt: 1,
      }),
    ).toContain('edit was kept');
  });
});
