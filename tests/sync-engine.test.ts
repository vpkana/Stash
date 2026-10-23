import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase, SECURITY_KEYS } from '@/db';
import type {
  Folder,
  LinkTag,
  Note,
  NoteLink,
  SavedLink,
  Tag,
} from '@/db/types';
import type {
  SyncBaseRow,
  SyncConflictRow,
  SyncMetaKey,
  SyncPeerRow,
} from '@/db/sync-types';
import { readSyncMeta, readSyncBase, readSyncConflicts, readSyncPeers, resetSyncBookkeeping } from '@/db/repos/sync';
import { createFolder } from '@/db/repos/folders';
import { createLink } from '@/db/repos/links';
import { attachLinkToNote, createNote, setNoteLocked } from '@/db/repos/notes';
import { setLinkTags } from '@/db/repos/tags';
import { runSyncNow } from '@/lib/sync/engine';
import {
  CHUNK_PREFIX,
  KEYRING_PREFIX,
  MANIFEST_PREFIX,
  SYNC_PROTOCOL,
  SYNC_PROTOCOL_VERSION,
  SYNC_SCHEMA_VERSION,
  canonicalNote,
  manifestFileName,
  revisionForRow,
  type CanonicalNote,
  type SyncEntry,
} from '@/lib/sync/protocol';
import { sha256Hex } from '@/lib/sync/canonical';
import { SyncTransportError, type RemoteFileInfo, type SyncTransport, type UploadTextInput } from '@/lib/sync/transport';
import { createRecoveryKey, adoptRecoveryKey } from '@/lib/privacy/recovery';
import { createDeviceKeyring, forgetVaultKey, getVaultKey } from '@/lib/privacy/keyring';
import { setSecureStore, type SecureStore } from '@/lib/privacy/secure-store';
import { setDeviceAuthenticator, createStaticAuthenticator } from '@/lib/privacy/auth';
import { setPrivacyScreenPlugin } from '@/lib/privacy/screen';

/**
 * End-to-end sync over an in-memory Drive.
 *
 * This exercises the real Dexie schema, the real engine and the real commit
 * transaction. Only the network is simulated: two "devices" share one
 * `MemoryDrive`, and moving to the second device means resetting the local
 * database and letting the engine pull everything from scratch. A device is
 * restored by snapshotting all ten tables, so a returning device keeps its base,
 * checkpoints and identity exactly as it would after an app restart.
 */

interface FakeFile {
  id: string;
  name: string;
  content: string;
  modifiedAt: number;
}

class MemoryDrive implements SyncTransport {
  readonly files = new Map<string, FakeFile>();
  readonly uploads: string[] = [];
  readonly downloads: string[] = [];
  pageSize = 64;
  listCalls = 0;
  failList: SyncTransportError | null = null;
  beforeUpload?: (input: UploadTextInput) => Promise<void> | void;
  failUpload?: (input: UploadTextInput) => SyncTransportError | null;
  private nextId = 1;
  private clock = 10_000;

  async listFiles(): Promise<RemoteFileInfo[]> {
    this.listCalls += 1;
    if (this.failList) throw this.failList;
    const all = [...this.files.values()].sort((a, b) => a.name.localeCompare(b.name));
    // Page the underlying list so a caller that only reads the first page would
    // visibly miss files; the transport contract requires the full listing.
    const pages: RemoteFileInfo[][] = [];
    for (let index = 0; index < all.length; index += this.pageSize) {
      pages.push(all.slice(index, index + this.pageSize).map(toInfo));
    }
    return pages.flat();
  }

  async downloadText(fileId: string): Promise<string> {
    this.downloads.push(fileId);
    const file = this.files.get(fileId);
    if (!file) throw new SyncTransportError('network', 'The remote file disappeared.');
    return file.content;
  }

  async uploadText(input: UploadTextInput): Promise<RemoteFileInfo> {
    const failure = this.failUpload?.(input);
    if (failure) throw failure;
    await this.beforeUpload?.(input);
    this.uploads.push(input.name);

    let file = input.fileId ? this.files.get(input.fileId) : undefined;
    if (!file) {
      file = [...this.files.values()].find((candidate) => candidate.name === input.name);
    }
    if (!file) {
      file = { id: `file-${this.nextId++}`, name: input.name, content: '', modifiedAt: 0 };
      this.files.set(file.id, file);
    }
    file.content = input.content;
    file.modifiedAt = ++this.clock;
    return toInfo(file);
  }

  contents(prefix: string): string[] {
    return [...this.files.values()]
      .filter((file) => file.name.startsWith(prefix))
      .map((file) => file.content);
  }

  byPrefix(prefix: string): FakeFile[] {
    return [...this.files.values()].filter((file) => file.name.startsWith(prefix));
  }
}

function toInfo(file: FakeFile): RemoteFileInfo {
  return { id: file.id, name: file.name, modifiedAt: file.modifiedAt, size: file.content.length };
}

async function resetDatabase(): Promise<void> {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

function memorySecureStore(): SecureStore {
  const values = new Map<string, string>();
  return {
    kind: 'native',
    isAvailable: async () => true,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}

beforeEach(async () => {
  await resetDatabase();
  forgetVaultKey();
  setSecureStore(memorySecureStore());
  setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));
  setPrivacyScreenPlugin(null);
});

interface StateDump {
  folders: Folder[];
  links: SavedLink[];
  tags: Tag[];
  linkTags: LinkTag[];
  notes: Note[];
  noteLinks: NoteLink[];
  syncBase: SyncBaseRow[];
  syncPeers: SyncPeerRow[];
  syncConflicts: SyncConflictRow[];
  syncMeta: Array<{ key: SyncMetaKey; value: unknown }>;
}

async function dumpState(): Promise<StateDump> {
  const [
    folders,
    links,
    tags,
    linkTags,
    notes,
    noteLinks,
    syncBase,
    syncPeers,
    syncConflicts,
    syncMeta,
  ] = await Promise.all([
    db.folders.toArray(),
    db.links.toArray(),
    db.tags.toArray(),
    db.linkTags.toArray(),
    db.notes.toArray(),
    db.noteLinks.toArray(),
    db.syncBase.toArray(),
    db.syncPeers.toArray(),
    db.syncConflicts.toArray(),
    db.syncMeta.toArray(),
  ]);
  return { folders, links, tags, linkTags, notes, noteLinks, syncBase, syncPeers, syncConflicts, syncMeta };
}

async function restoreState(dump: StateDump): Promise<void> {
  await resetDatabase();
  await db.transaction(
    'rw',
    [
      db.folders,
      db.links,
      db.tags,
      db.linkTags,
      db.notes,
      db.noteLinks,
      db.syncBase,
      db.syncPeers,
      db.syncConflicts,
      db.syncMeta,
    ],
    async () => {
      await db.folders.bulkPut(dump.folders);
      await db.links.bulkPut(dump.links);
      await db.tags.bulkPut(dump.tags);
      await db.linkTags.bulkPut(dump.linkTags);
      await db.notes.bulkPut(dump.notes);
      await db.noteLinks.bulkPut(dump.noteLinks);
      await db.syncBase.bulkPut(dump.syncBase);
      await db.syncPeers.bulkPut(dump.syncPeers);
      await db.syncConflicts.bulkPut(dump.syncConflicts);
      await db.syncMeta.bulkPut(dump.syncMeta);
    },
  );
}

const T0 = Date.now() + 60 * 60 * 1_000;

async function seedVault() {
  const folder = await createFolder({ name: 'Reading' });
  if (!folder.ok) throw new Error(folder.reason);
  const child = await createFolder({ name: 'Papers', parentId: folder.folder.id });
  if (!child.ok) throw new Error(child.reason);

  const link = await createLink({
    url: 'https://example.com/design',
    folderId: folder.folder.id,
    title: 'Design notes',
  });
  await setLinkTags(link.id, ['design', 'reading']);

  const note = await createNote({ title: 'Stash sync', content: 'The initial body.' });
  if (!note.ok) throw new Error(note.message);
  const subnote = await createNote({
    title: 'Implementation',
    content: 'A subnote.',
    parentNoteId: note.note.id,
  });
  if (!subnote.ok) throw new Error(subnote.message);
  await attachLinkToNote(note.note.id, link.id);

  return {
    folderId: folder.folder.id,
    childFolderId: child.folder.id,
    linkId: link.id,
    noteId: note.note.id,
    subNoteId: subnote.note.id,
    noteUpdatedAt: note.note.updatedAt,
  };
}

function linkRow(index: number): SavedLink {
  const stamp = T0 + index;
  return {
    id: `bulk-link-${String(index).padStart(4, '0')}`,
    folderId: null,
    url: `https://example.com/item/${index}`,
    normalizedUrl: `https://example.com/item/${index}`,
    title: `Item ${index}`,
    createdAt: stamp,
    updatedAt: stamp,
    isFavorite: false,
    isArchived: false,
    isLocked: false,
  };
}

async function enableVaultKey(): Promise<void> {
  const result = await createDeviceKeyring();
  expect(result.ok).toBe(true);
  expect(getVaultKey()).not.toBeNull();
}

async function localManifestChunkContents(drive: MemoryDrive): Promise<string[]> {
  const deviceId = await readSyncMeta<string>('deviceId');
  const file = drive.byPrefix(MANIFEST_PREFIX).find((candidate) => candidate.name === manifestFileName(deviceId ?? ''));
  if (!file) return [];
  const manifest = JSON.parse(file.content) as { chunks: Array<{ fileId: string }> };
  return manifest.chunks.map((ref) => {
    const chunk = [...drive.files.values()].find((candidate) => candidate.id === ref.fileId);
    return chunk?.content ?? '';
  });
}

describe('sync engine over an in-memory Drive', () => {
  it('uploads the whole vault once and then converges to a no-op', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();

    const first = await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    expect(first.ok).toBe(true);
    expect(first.noop).toBe(false);
    expect(first.uploadedChunks).toBe(1);
    expect(first.uploadedEntries).toBeGreaterThanOrEqual(10);
    expect(first.error).toBeUndefined();

    const base = await readSyncBase();
    expect(base.size).toBe(first.uploadedEntries);
    expect(base.get(`link:${ids.linkId}`)?.row).toBeTruthy();
    expect(base.get(`note:${ids.noteId}`)?.row).toBeTruthy();

    const peers = await readSyncPeers();
    expect(peers.size).toBe(1);
    expect([...peers.values()][0]?.lastSeq).toBe(1);
    expect(await readSyncMeta<number>('lastSuccessAt')).toBe(T0);
    expect(await readSyncMeta('lastError')).toBeUndefined();

    const second = await runSyncNow(drive, { now: T0 + 1_000 });
    expect(second.ok).toBe(true);
    expect(second.noop).toBe(true);
    expect(second.uploadedChunks).toBe(0);
    expect(second.downloadedChunks).toBe(0);
    expect(second.appliedChanges).toBe(0);
  });

  it('materialises every entity and relationship on a second device', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });

    await resetDatabase();
    const pulled = await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });

    expect(pulled.ok).toBe(true);
    expect(pulled.downloadedChunks).toBe(1);
    expect(pulled.appliedChanges).toBeGreaterThan(0);

    expect((await db.folders.toArray()).map((row) => row.id).sort()).toEqual(
      [ids.folderId, ids.childFolderId].sort(),
    );
    expect((await db.folders.get(ids.childFolderId))?.parentId).toBe(ids.folderId);
    expect((await db.links.get(ids.linkId))?.folderId).toBe(ids.folderId);
    expect((await db.notes.get(ids.noteId))?.title).toBe('Stash sync');
    expect((await db.notes.get(ids.subNoteId))?.parentNoteId).toBe(ids.noteId);
    expect((await db.tags.toArray()).map((tag) => tag.name).sort()).toEqual(['design', 'reading']);
    expect(await db.linkTags.count()).toBe(2);
    expect(await db.noteLinks.get([ids.noteId, ids.linkId])).toBeTruthy();

    const again = await runSyncNow(drive, { now: T0 + 2_000 });
    expect(again.noop).toBe(true);
    expect(again.uploadedChunks).toBe(0);
  });

  it('propagates a hard deletion and prunes references to the deleted row', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    const deviceA = await dumpState();

    await resetDatabase();
    await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });
    await db.links.delete(ids.linkId);
    const deleted = await runSyncNow(drive, { now: T0 + 2_000 });
    expect(deleted.ok).toBe(true);

    await restoreState(deviceA);
    const applied = await runSyncNow(drive, { now: T0 + 3_000 });
    expect(applied.ok).toBe(true);
    expect(await db.links.get(ids.linkId)).toBeUndefined();
    expect(await db.noteLinks.get([ids.noteId, ids.linkId])).toBeUndefined();
    expect((await readSyncBase()).get(`link:${ids.linkId}`)?.deleted).toBe(true);
    expect((await readSyncBase()).get(`link:${ids.linkId}`)?.row).toBeUndefined();
  });

  it('propagates a trash state without deleting anything', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    const deviceA = await dumpState();

    await resetDatabase();
    await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });
    const trashedAt = T0 + 2_000;
    await db.links.update(ids.linkId, { deletedAt: trashedAt, trashBatch: 'batch-1', updatedAt: trashedAt });
    await runSyncNow(drive, { now: trashedAt });

    await restoreState(deviceA);
    await runSyncNow(drive, { now: T0 + 3_000 });
    const link = await db.links.get(ids.linkId);
    expect(link?.deletedAt).toBe(trashedAt);
    expect(link?.trashBatch).toBe('batch-1');
    expect(link?.url).toBe('https://example.com/design');
  });

  it('merges edits to different fields made on two devices', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    const deviceA0 = await dumpState();

    await resetDatabase();
    await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });
    const deviceB0 = await dumpState();

    await restoreState(deviceA0);
    const titleAt = T0 + 2_000;
    await db.links.update(ids.linkId, { title: 'Edited title on A', updatedAt: titleAt });
    await runSyncNow(drive, { now: titleAt });
    const deviceA1 = await dumpState();

    await restoreState(deviceB0);
    const descriptionAt = T0 + 3_000;
    await db.links.update(ids.linkId, {
      description: 'Edited description on B.',
      updatedAt: descriptionAt,
    });
    const merged = await runSyncNow(drive, { now: descriptionAt });
    expect(merged.ok).toBe(true);
    expect(merged.conflicts).toBe(0);

    const onB = await db.links.get(ids.linkId);
    expect(onB?.title).toBe('Edited title on A');
    expect(onB?.description).toBe('Edited description on B.');

    await restoreState(deviceA1);
    await runSyncNow(drive, { now: T0 + 4_000 });
    const onA = await db.links.get(ids.linkId);
    expect(onA?.title).toBe('Edited title on A');
    expect(onA?.description).toBe('Edited description on B.');

    expect((await runSyncNow(drive, { now: T0 + 5_000 })).noop).toBe(true);
  });

  it('keeps both concurrent note bodies as a visible conflict copy on every device', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    const deviceA0 = await dumpState();

    await resetDatabase();
    await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });
    const deviceB0 = await dumpState();

    await restoreState(deviceA0);
    const aAt = T0 + 2_000;
    await db.notes.update(ids.noteId, { content: 'Body written on A.', updatedAt: aAt });
    await runSyncNow(drive, { now: aAt });
    const deviceA1 = await dumpState();

    await restoreState(deviceB0);
    const bAt = T0 + 3_000;
    await db.notes.update(ids.noteId, { content: 'Body written on B.', updatedAt: bAt });
    const conflicted = await runSyncNow(drive, { now: bAt });
    expect(conflicted.ok).toBe(true);
    expect(conflicted.conflicts).toBe(1);

    const notesOnB = await db.notes.toArray();
    expect(notesOnB).toHaveLength(3);
    const bodies = notesOnB.map((note) => note.content).sort();
    expect(bodies).toEqual(['A subnote.', 'Body written on A.', 'Body written on B.']);
    const copy = notesOnB.find((note) => note.content === 'Body written on A.');
    expect(copy?.title).toContain('(conflict copy)');

    const conflicts = await readSyncConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe('note-copy');
    expect(conflicts[0]?.copyId).toBe(copy?.id);

    const stable = await runSyncNow(drive, { now: T0 + 4_000 });
    expect(stable.noop).toBe(true);
    expect(await db.notes.count()).toBe(3);

    await restoreState(deviceA1);
    await runSyncNow(drive, { now: T0 + 5_000 });
    expect(await db.notes.count()).toBe(3);
    expect((await db.notes.toArray()).map((note) => note.content).sort()).toEqual(
      ['A subnote.', 'Body written on A.', 'Body written on B.'],
    );
  });

  it('resurrects an edit that raced a deletion instead of losing it', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    const deviceA = await dumpState();

    await resetDatabase();
    await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });
    await db.notes.delete(ids.noteId);
    await runSyncNow(drive, { now: T0 + 2_000 });
    const deviceBAfterDelete = await dumpState();

    await restoreState(deviceA);
    const editAt = T0 + 3_000;
    await db.notes.update(ids.noteId, { title: 'Edited before the delete arrived', updatedAt: editAt });
    const resurrected = await runSyncNow(drive, { now: editAt });
    expect(resurrected.ok).toBe(true);
    expect(resurrected.conflicts).toBe(1);
    const note = await db.notes.get(ids.noteId);
    expect(note?.title).toBe('Edited before the delete arrived');
    expect((await readSyncConflicts())[0]?.reason).toBe('delete-edit');

    await restoreState(deviceBAfterDelete);
    await runSyncNow(drive, { now: T0 + 4_000 });
    expect((await db.notes.get(ids.noteId))?.title).toBe('Edited before the delete arrived');
  });

  it('aborts the local commit when the vault changes mid-sync, then recovers on retry', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    const editAt = T0 + 1_500;
    let edited = false;
    drive.beforeUpload = async (input) => {
      if (edited || !input.name.startsWith(MANIFEST_PREFIX)) return;
      edited = true;
      await db.notes.update(ids.noteId, { title: 'Edited during sync', updatedAt: editAt });
    };

    const aborted = await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    expect(aborted.ok).toBe(false);
    expect(aborted.error?.code).toBe('concurrent-change');
    expect((await readSyncBase()).size).toBe(0);
    expect((await readSyncPeers()).size).toBe(0);
    expect((await db.notes.get(ids.noteId))?.title).toBe('Edited during sync');
    expect(drive.byPrefix(MANIFEST_PREFIX)).toHaveLength(1);

    drive.beforeUpload = undefined;
    const recovered = await runSyncNow(drive, { now: T0 + 2_000 });
    expect(recovered.ok).toBe(true);
    expect((await db.notes.get(ids.noteId))?.title).toBe('Edited during sync');
    expect((await readSyncBase()).size).toBeGreaterThan(0);
    expect((await readSyncPeers()).size).toBe(1);

    const settled = await runSyncNow(drive, { now: T0 + 3_000 });
    expect(settled.ok).toBe(true);
    expect(settled.noop).toBe(true);
  });

  it('rejects a chunk whose checksum does not match and applies nothing', async () => {
    const drive = new MemoryDrive();
    await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    const chunk = drive.byPrefix(CHUNK_PREFIX)[0];
    expect(chunk).toBeTruthy();
    if (chunk) chunk.content += ' ';

    await resetDatabase();
    const outcome = await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('remote-invalid');
    expect(await db.notes.count()).toBe(0);
    expect(await db.links.count()).toBe(0);
    expect((await readSyncBase()).size).toBe(0);
    expect((await readSyncPeers()).size).toBe(0);
    expect((await readSyncConflicts()).length).toBe(0);
    expect(await readSyncMeta('lastSuccessAt')).toBeUndefined();
    expect((await readSyncMeta<{ code: string }>('lastError'))?.code).toBe('remote-invalid');
  });

  it('records a transport failure without changing the last success or the vault', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });

    drive.failList = new SyncTransportError('network', 'The connection was interrupted.');
    const offline = await runSyncNow(drive, { now: T0 + 1_000 });
    expect(offline.ok).toBe(false);
    expect(offline.error?.code).toBe('network');
    expect(offline.error?.retryable).toBe(true);
    expect(await readSyncMeta<number>('lastSuccessAt')).toBe(T0);
    expect((await readSyncMeta<{ code: string }>('lastError'))?.code).toBe('network');
    expect((await db.notes.get(ids.noteId))?.title).toBe('Stash sync');

    drive.failList = null;
    const recovered = await runSyncNow(drive, { now: T0 + 2_000 });
    expect(recovered.ok).toBe(true);
    expect(recovered.noop).toBe(true);
    expect(await readSyncMeta<number>('lastSuccessAt')).toBe(T0 + 2_000);
    expect(await readSyncMeta('lastError')).toBeUndefined();
  });

  it('splits a large vault into bounded chunks and reads a paged listing', async () => {
    const drive = new MemoryDrive();
    drive.pageSize = 2;
    await db.links.bulkPut(Array.from({ length: 520 }, (_unused, index) => linkRow(index)));

    const first = await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    expect(first.ok).toBe(true);
    expect(first.uploadedEntries).toBe(520);
    expect(first.uploadedChunks).toBe(2);
    expect(drive.byPrefix(MANIFEST_PREFIX)).toHaveLength(1);

    const manifestFile = drive.byPrefix(MANIFEST_PREFIX)[0];
    expect(manifestFile).toBeTruthy();
    const manifest = JSON.parse(manifestFile?.content ?? '{}') as { chunks: Array<{ entries: number }> };
    expect(manifest.chunks.map((chunk) => chunk.entries)).toEqual([500, 20]);

    await resetDatabase();
    const pulled = await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });
    expect(pulled.ok).toBe(true);
    expect(pulled.downloadedChunks).toBe(2);
    expect(await db.links.count()).toBe(520);
    expect(await db.links.get('bulk-link-0519')).toBeTruthy();
  });
});

describe('sync account and identity lifecycle', () => {
  it('keeps the device identity and vault when sync bookkeeping is reset for another account', async () => {
    const drive = new MemoryDrive();
    const ids = await seedVault();
    await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    const deviceIdBefore = await readSyncMeta<string>('deviceId');
    const baseBefore = (await readSyncBase()).size;
    expect(baseBefore).toBeGreaterThan(0);

    await resetSyncBookkeeping();

    expect(await readSyncMeta<string>('deviceId')).toBe(deviceIdBefore);
    expect((await readSyncBase()).size).toBe(0);
    expect((await readSyncPeers()).size).toBe(0);
    expect(await readSyncMeta('lastSuccessAt')).toBeUndefined();
    expect(await db.notes.get(ids.noteId)).toBeTruthy();
    expect(await db.links.get(ids.linkId)).toBeTruthy();

    const freshAccount = new MemoryDrive();
    const firstOnNewAccount = await runSyncNow(freshAccount, { now: T0 + 1_000 });
    expect(firstOnNewAccount.ok).toBe(true);
    expect(firstOnNewAccount.uploadedEntries).toBeGreaterThanOrEqual(10);
    expect(await readSyncMeta<string>('deviceId')).toBe(deviceIdBefore);
  });

  it('publishes a recovery-wrapped keyring and adopts it on a fresh device', async () => {
    await enableVaultKey();
    const created = await createRecoveryKey();
    expect(created.ok).toBe(true);
    expect(created.key).toBeTruthy();
    const key = created.key ?? '';

    const drive = new MemoryDrive();
    const synced = await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    expect(synced.ok).toBe(true);
    const files = drive.byPrefix(KEYRING_PREFIX);
    expect(files).toHaveLength(1);
    const published = JSON.parse(files[0]?.content ?? '{}') as {
      wrappedByRecovery?: { ct?: string };
      fingerprint?: string;
    };
    expect(published.wrappedByRecovery?.ct).toBeTruthy();
    expect(published.fingerprint).toBeTruthy();
    expect(files[0]?.content).not.toContain(key.replace(/-/g, ''));

    await resetDatabase();
    forgetVaultKey();
    expect(getVaultKey()).toBeNull();

    const adopted = await adoptRecoveryKey(drive, key);
    expect(adopted.ok).toBe(true);
    expect(getVaultKey()).not.toBeNull();
  });
});

describe('locking during sync', () => {
  it('never publishes device keys, enrolled credentials, or session access', async () => {
    const deviceValues = new Map<string, string>();
    setSecureStore({
      kind: 'native',
      isAvailable: async () => true,
      get: async (key) => deviceValues.get(key) ?? null,
      set: async (key, value) => {
        deviceValues.set(key, value);
      },
      remove: async (key) => {
        deviceValues.delete(key);
      },
    });
    await enableVaultKey();
    const note = await createNote({ title: 'Device secret title', content: 'Device secret body' });
    if (!note.ok) throw new Error(note.message);
    await setNoteLocked(note.note.id, true);

    // A credential row exists only on a desktop, but no platform may publish it.
    await db.security.put({
      key: SECURITY_KEYS.deviceCredential,
      value: { id: 'enrolled-credential-id', createdAt: 1 },
    });

    const drive = new MemoryDrive();
    const outcome = await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    expect(outcome.ok).toBe(true);

    const deviceKey = deviceValues.get('stash.privacy.deviceKey');
    expect(deviceKey).toBeTruthy();
    const published = [...drive.files.values()].map((file) => file.content).join('\n');
    expect(published).not.toContain(deviceKey as string);
    expect(published).not.toContain('enrolled-credential-id');
    expect(published).not.toContain('wrappedByDevice');
    expect(published).not.toContain('grantedRoots');
    expect(published).not.toContain('Device secret title');
    expect(published).not.toContain('Device secret body');

    // The unlocked session belongs to this device: what travels is ciphertext.
    const sealed = await db.notes.get(note.note.id);
    expect(sealed?.title).toBe('');
    expect(sealed?.content).toBe('');
    expect(sealed?.enc).toBeTruthy();
  });

  it('pulls locked content as ciphertext onto a device with no key', async () => {
    await enableVaultKey();
    const note = await createNote({ title: 'Synced secret', content: 'Synced body' });
    if (!note.ok) throw new Error(note.message);
    await setNoteLocked(note.note.id, true);

    const drive = new MemoryDrive();
    const sent = await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    expect(sent.ok).toBe(true);

    await resetDatabase();
    forgetVaultKey();

    const pulled = await runSyncNow(drive, { deviceName: 'Device B', now: T0 + 1_000 });
    expect(pulled.ok).toBe(true);
    expect(getVaultKey()).toBeNull();

    const received = await db.notes.get(note.note.id);
    expect(received?.isLocked).toBe(true);
    expect(received?.enc).toBeTruthy();
    expect(received?.title).toBe('');
    expect(received?.content).toBe('');
  });

  it('never uploads locked plaintext, even when the row on disk arrived unsealed', async () => {
    await enableVaultKey();
    const note = await createNote({ title: 'Secret title', content: 'Secret body' });
    if (!note.ok) throw new Error(note.message);

    // Put the lock flag on directly so the row is plaintext until reconciliation.
    await db.notes.put({ ...note.note, isLocked: true, updatedAt: note.note.updatedAt + 1 });
    const drive = new MemoryDrive();
    const outcome = await runSyncNow(drive, { deviceName: 'Device A', now: T0 });
    expect(outcome.ok).toBe(true);

    const chunks = (await localManifestChunkContents(drive)).join('\n');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks).not.toContain('Secret title');
    expect(chunks).not.toContain('Secret body');
    expect(chunks).toContain('"enc"');

    const stored = await db.notes.get(note.note.id);
    expect(stored?.title).toBe('');
    expect(stored?.content).toBe('');
    expect(stored?.enc).toBeTruthy();
  });

  it('seals a plaintext remote conflict payload before storing it for review', async () => {
    await enableVaultKey();
    const note = await createNote({ title: 'Local secret', content: 'Local body' });
    if (!note.ok) throw new Error(note.message);
    await setNoteLocked(note.note.id, true);
    const sealedLocal = await db.notes.get(note.note.id);
    if (!sealedLocal) throw new Error('missing sealed note');
    expect(sealedLocal.isLocked).toBe(true);
    expect(sealedLocal.enc).toBeTruthy();

    const drive = new MemoryDrive();
    const remoteNote: Note = {
      ...sealedLocal,
      title: 'Remote secret',
      content: 'Remote body',
      updatedAt: sealedLocal.updatedAt + 10_000,
      isLocked: true,
    };
    delete remoteNote.enc;
    const row: CanonicalNote = canonicalNote(remoteNote);
    const entry: SyncEntry = {
      kind: 'note',
      id: remoteNote.id,
      rev: await revisionForRow('note', row, 'legacy-device'),
      row,
    };
    const chunkContent = JSON.stringify({
      protocol: SYNC_PROTOCOL,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      schemaVersion: SYNC_SCHEMA_VERSION,
      deviceId: 'legacy-device',
      seq: 1,
      createdAt: T0,
      entries: [entry],
    });
    const hash = await sha256Hex(chunkContent);
    const chunkFile = await drive.uploadText({
      name: `${CHUNK_PREFIX}legacy-device-1-${hash.slice(0, 16)}.json`,
      content: chunkContent,
    });
    await drive.uploadText({
      name: manifestFileName('legacy-device'),
      content: JSON.stringify({
        protocol: SYNC_PROTOCOL,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        schemaVersion: SYNC_SCHEMA_VERSION,
        deviceId: 'legacy-device',
        deviceName: 'Legacy device',
        revision: 1,
        updatedAt: T0,
        chunks: [
          {
            fileId: chunkFile.id,
            name: chunkFile.name,
            hash,
            seq: 1,
            revision: 1,
            entries: 1,
            createdAt: T0,
          },
        ],
      }),
    });

    const outcome = await runSyncNow(drive, { deviceName: 'Device A', now: T0 + 20_000 });
    expect(outcome.ok).toBe(true);
    expect(outcome.conflicts).toBe(1);
    expect(outcome.sealedForUpload).toBe(1);

    const conflicts = await readSyncConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.label).toBe('Locked note');
    const storedConflicts = JSON.stringify(conflicts);
    expect(storedConflicts).not.toContain('Remote secret');
    expect(storedConflicts).not.toContain('Remote body');
    expect(storedConflicts).not.toContain('Local body');
    const localPayload = conflicts[0]?.local?.row;
    const remotePayload = conflicts[0]?.remote?.row;
    expect(localPayload && 'enc' in localPayload).toBe(true);
    expect(remotePayload && 'enc' in remotePayload).toBe(true);

    const stored = await db.notes.get(note.note.id);
    expect(stored?.title).toBe('');
    expect(stored?.enc).toBeTruthy();
    const uploaded = (await localManifestChunkContents(drive)).join('\n');
    expect(uploaded).not.toContain('Remote secret');
    expect(uploaded).not.toContain('Remote body');
  });
});
