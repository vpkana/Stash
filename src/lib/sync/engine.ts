import { db } from '@/db';
import {
  SYNC_META_KEYS,
  type SyncConflictRow,
  type SyncErrorInfo,
  type SyncPeerRow,
} from '@/db/sync-types';
import type { LinkTag, NoteLink } from '@/db/types';
import { baseRow, ensureDeviceIdentity, readSyncMeta, readSyncPeers, writeSyncMeta } from '@/db/repos/sync';
import { reconcileProtection } from '@/lib/privacy/reconcile';
import { getVaultKey } from '@/lib/privacy/keyring';
import {
  computeProtection,
  redactLink,
  redactNote,
  sealLink,
  sealNote,
  type Protection,
} from '@/lib/privacy/protection';
import type { Folder, Note, SavedLink } from '@/db/types';
import {
  canonicalFolder,
  canonicalLink,
  canonicalLinkTag,
  canonicalNote,
  canonicalNoteLink,
  canonicalTag,
  entriesFromRows,
  entityKey,
  entryKey,
  manifestFileName,
  revisionForRow,
  revisionForTombstone,
  rowIdentity,
  syncEntriesEqual,
  validateChunk,
  validateManifest,
  CHUNK_PREFIX,
  MANIFEST_PREFIX,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_ENTRIES,
  SYNC_PROTOCOL,
  SYNC_PROTOCOL_VERSION,
  SYNC_SCHEMA_VERSION,
  SyncValidationError,
  type CanonicalRow,
  type DeviceManifest,
  type ManifestChunkRef,
  type SyncEntry,
} from './protocol';
import { sha256Hex, stableStringify } from './canonical';
import { mergeVaultState, type MergeConflict } from './merge';
import { uploadRecoveryKeyring } from '@/lib/privacy/recovery';
import { SyncTransportError, type RemoteFileInfo, type SyncTransport } from './transport';

/**
 * One sync, in order, with every step able to fail safely.
 *
 *   1. read local vault + base + peer checkpoints
 *   2. list and validate remote manifests, download unseen chunks
 *   3. merge in memory (pure engine)
 *   4. encrypt any protected plaintext before it can be uploaded
 *   5. upload immutable chunks, then rewrite *this device's* manifest
 *   6. apply the merged state and advance checkpoints in one Dexie transaction
 *
 * Drive has no multi-file transaction, so the per-device manifest is the commit
 * point: if the process dies after it is written, the next run downloads its own
 * new chunk (the checkpoint is still behind) and applies it. Nothing is ever
 * marked processed before it is durably local.
 */

export interface SyncOutcome {
  ok: boolean;
  noop: boolean;
  busy?: boolean;
  uploadedChunks: number;
  uploadedEntries: number;
  downloadedChunks: number;
  appliedChanges: number;
  sealedForUpload: number;
  conflicts: number;
  error?: SyncErrorInfo;
  warning?: string;
}

export interface SyncOptions {
  deviceName?: string;
  /** Injectable for tests; never used as the sole ordering signal. */
  now?: number;
}

class SyncFailure extends Error {
  readonly info: SyncErrorInfo;
  constructor(info: SyncErrorInfo) {
    super(info.message);
    this.name = 'SyncFailure';
    this.info = info;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Serialise syncs in this tab, then take a browser-wide lock where one exists.
 * A second tab skips rather than waiting indefinitely — a sync can take a while,
 * and silently queueing one behind it is not what "Sync now" should do.
 */
export function runSyncNow(transport: SyncTransport, options: SyncOptions = {}): Promise<SyncOutcome> {
  const run = queue.then(() => withBrowserLock(transport, options));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withBrowserLock(
  transport: SyncTransport,
  options: SyncOptions,
): Promise<SyncOutcome> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    return locks.request('stash-sync', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return busyOutcome();
      return execute(transport, options);
    });
  }
  return execute(transport, options);
}

function busyOutcome(): SyncOutcome {
  return {
    ok: true,
    noop: true,
    busy: true,
    uploadedChunks: 0,
    uploadedEntries: 0,
    downloadedChunks: 0,
    appliedChanges: 0,
    sealedForUpload: 0,
    conflicts: 0,
  };
}

async function execute(transport: SyncTransport, options: SyncOptions): Promise<SyncOutcome> {
  const at = options.now ?? Date.now();
  const identity = await ensureDeviceIdentity(options.deviceName);
  await writeSyncMeta('lastAttemptAt', at);

  const outcome: SyncOutcome = {
    ok: false,
    noop: false,
    uploadedChunks: 0,
    uploadedEntries: 0,
    downloadedChunks: 0,
    appliedChanges: 0,
    sealedForUpload: 0,
    conflicts: 0,
  };

  try {
    // Sealing state is derived, not bookkept; reconcile before reading so the
    // snapshot this sync reasons about is the same one the app would show.
    await reconcileProtection().catch(() => undefined);

    const base = await readSyncBaseMap();
    const peers = await readSyncPeers();

    const remote = await discoverRemote(transport, peers);
    outcome.downloadedChunks = remote.downloadedChunks;

    const local = await readLocalEntries(base, identity.deviceId, at);
    const merged = await mergeVaultState({
      base,
      local: local.entries,
      remotes: remote.entriesByDevice,
      deviceId: identity.deviceId,
      at,
    });
    outcome.conflicts = merged.conflicts.length;

    const protectedState = await protectBeforeUpload(merged.entries, identity.deviceId);
    outcome.sealedForUpload = protectedState.sealed;
    const conflicts = await sanitizeConflicts(
      merged.conflicts,
      protectedState.protection,
      identity.deviceId,
    );

    const effectiveRemote = new Map(base);
    for (const [key, entry] of merged.remoteEntries) effectiveRemote.set(key, entry);

    const outgoing: SyncEntry[] = [];
    for (const [key, entry] of protectedState.entries) {
      if (syncEntriesEqual(entry, effectiveRemote.get(key))) continue;
      outgoing.push(entry);
    }
    outgoing.sort((a, b) => entryKey(a).localeCompare(entryKey(b)));

    const ownState = remote.manifests.get(identity.deviceId);
    const ownManifest = ownState?.manifest ?? null;
    const ownFile = ownState?.file ?? null;
    const previousSeq = Math.max(
      ownManifest?.chunks[ownManifest.chunks.length - 1]?.seq ?? 0,
      (await readSyncMeta<number>('ownSeq')) ?? 0,
    );
    const previousRevision = Math.max(
      ownManifest?.revision ?? 0,
      (await readSyncMeta<number>('ownRevision')) ?? 0,
    );

    let manifest = ownManifest;
    let ownFileId = ownFile?.id;
    if (outgoing.length > 0) {
      const nextRevision = previousRevision + 1;
      const refs = await uploadChunks(
        transport,
        identity.deviceId,
        outgoing,
        previousSeq,
        nextRevision,
        at,
      );
      outcome.uploadedChunks = refs.length;
      outcome.uploadedEntries = outgoing.length;

      manifest = {
        protocol: SYNC_PROTOCOL,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        schemaVersion: SYNC_SCHEMA_VERSION,
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        revision: nextRevision,
        updatedAt: at,
        chunks: [...(ownManifest?.chunks ?? []), ...refs],
      };
      // The remote commit point. Everything before this is an orphan chunk at
      // worst; everything after it is recoverable by re-reading our own log.
      const uploaded = await transport.uploadText({
        name: manifestFileName(identity.deviceId),
        content: JSON.stringify(manifest),
        fileId: ownFile?.id,
      });
      ownFileId = uploaded.id;
    }

    const processedPeers: SyncPeerRow[] = [...remote.manifests.values()].map((state) => ({
      deviceId: state.manifest.deviceId,
      deviceName: state.manifest.deviceName,
      revision: state.manifest.revision,
      lastSeq: state.lastSeq,
      updatedAt: at,
    }));
    if (manifest) {
      const ownPeer: SyncPeerRow = {
        deviceId: identity.deviceId,
        deviceName: manifest.deviceName,
        revision: manifest.revision,
        lastSeq: manifest.chunks[manifest.chunks.length - 1]?.seq ?? 0,
        updatedAt: at,
      };
      const existingIndex = processedPeers.findIndex((peer) => peer.deviceId === identity.deviceId);
      if (existingIndex >= 0) processedPeers[existingIndex] = ownPeer;
      else processedPeers.push(ownPeer);
    }

    const applied = await commitMergedState({
      merged: protectedState.entries,
      base,
      localSerialized: local.serialized,
      conflicts: conflicts.map<SyncConflictRow>((conflict) => ({
        id: conflict.id,
        kind: conflict.kind,
        entityId: conflict.entityId,
        reason: conflict.reason,
        label: conflict.label,
        detectedAt: at,
        local: conflict.local,
        remote: conflict.remote,
        fields: conflict.fields,
        copyId: conflict.copyId,
      })),
      processedPeers,
      ownSeq: manifest?.chunks[manifest.chunks.length - 1]?.seq ?? previousSeq,
      ownRevision: manifest?.revision ?? previousRevision,
      ownFileId,
      at,
    });
    outcome.appliedChanges = applied;

    // Sealing state can change when a merged lock flag moves a row across a
    // boundary. Reconciling after apply keeps the vault honest; if this changes
    // rows, the next sync uploads the sealed/opened form rather than leaking.
    await reconcileProtection().catch(() => undefined);

    const keyringWarning = await uploadRecoveryKeyring(transport).catch(() => 'recovery-keyring');

    outcome.ok = true;
    outcome.noop =
      outcome.uploadedChunks === 0 &&
      outcome.downloadedChunks === 0 &&
      outcome.appliedChanges === 0 &&
      outcome.conflicts === 0;
    if (keyringWarning) outcome.warning = 'Recovery key file could not be updated; the next sync will retry.';
    await writeSyncMeta('lastResult', {
      at,
      uploadedChunks: outcome.uploadedChunks,
      downloadedChunks: outcome.downloadedChunks,
      conflicts: outcome.conflicts,
      noop: outcome.noop,
    }).catch(() => undefined);
    return outcome;
  } catch (error) {
    const info = toErrorInfo(error, at);
    outcome.error = info;
    await writeSyncMeta('lastError', info).catch(() => undefined);
    return outcome;
  }
}

async function readSyncBaseMap(): Promise<Map<string, SyncEntry>> {
  const rows = await db.syncBase.toArray();
  return new Map(rows.map((row) => [row.key, row.entry]));
}

interface RemoteState {
  file: RemoteFileInfo;
  manifest: DeviceManifest;
  lastSeq: number;
}

interface DiscoveredRemote {
  manifests: Map<string, RemoteState>;
  entriesByDevice: Map<string, Map<string, SyncEntry>>;
  downloadedChunks: number;
}

async function discoverRemote(
  transport: SyncTransport,
  peers: ReadonlyMap<string, SyncPeerRow>,
): Promise<DiscoveredRemote> {
  const files = await transport.listFiles();
  const manifests = new Map<string, RemoteState>();
  const entriesByDevice = new Map<string, Map<string, SyncEntry>>();
  let downloadedChunks = 0;

  const manifestFiles = files
    .filter((file) => file.name.startsWith(MANIFEST_PREFIX) && file.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const chosen = new Map<string, { file: RemoteFileInfo; manifest: DeviceManifest }>();
  for (const file of manifestFiles) {
    const text = await transport.downloadText(file.id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidRemote('A sync manifest is not valid JSON.');
    }
    const manifest = validateManifest(parsed);
    if (manifestFileName(manifest.deviceId) !== file.name) {
      throw invalidRemote('A sync manifest is named for a different device.');
    }
    const existing = chosen.get(file.name);
    if (
      !existing ||
      manifest.revision > existing.manifest.revision ||
      (manifest.revision === existing.manifest.revision &&
        (file.modifiedAt ?? 0) > (existing.file.modifiedAt ?? 0))
    ) {
      chosen.set(file.name, { file, manifest });
    }
  }

  for (const { file, manifest } of [...chosen.values()].sort((a, b) =>
    a.manifest.deviceId.localeCompare(b.manifest.deviceId),
  )) {
    const checkpoint = peers.get(manifest.deviceId);
    // A manifest revision that moved backwards means the publishing device was
    // reinitialised (for example, app data cleared and sync reconnected). Its
    // new log must be read from the beginning rather than trusting a checkpoint
    // that refers to a history that no longer exists.
    let lastSeq = checkpoint?.lastSeq ?? 0;
    if (checkpoint && manifest.revision < checkpoint.revision) lastSeq = 0;

    const entries = new Map<string, SyncEntry>();
    for (const ref of manifest.chunks) {
      if (ref.seq <= lastSeq) continue;
      const text = await transport.downloadText(ref.fileId);
      const hash = await sha256Hex(text);
      if (hash !== ref.hash) throw invalidRemote('A sync chunk failed its checksum.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw invalidRemote('A sync chunk is not valid JSON.');
      }
      const chunk = validateChunk(parsed);
      if (chunk.deviceId !== manifest.deviceId) {
        throw invalidRemote('A sync chunk does not belong to its manifest.');
      }
      if (chunk.seq !== ref.seq) throw invalidRemote('A sync chunk sequence does not match its manifest.');
      if (chunk.entries.length !== ref.entries) {
        throw invalidRemote('A sync chunk does not match its manifest entry count.');
      }
      for (const entry of chunk.entries) entries.set(entryKey(entry), entry);
      downloadedChunks += 1;
      lastSeq = Math.max(lastSeq, ref.seq);
    }
    manifests.set(manifest.deviceId, { file, manifest, lastSeq });
    entriesByDevice.set(manifest.deviceId, entries);
  }

  return { manifests, entriesByDevice, downloadedChunks };
}

function invalidRemote(message: string): SyncFailure {
  return new SyncFailure({
    code: 'remote-invalid',
    message,
    at: Date.now(),
    retryable: true,
  });
}

function toErrorInfo(error: unknown, at: number): SyncErrorInfo {
  if (error instanceof SyncFailure) return error.info;
  if (error instanceof SyncTransportError) {
    return {
      code: error.code,
      message: error.message,
      at,
      retryable: error.retryable,
    };
  }
  if (error instanceof SyncValidationError) {
    return {
      code: 'remote-invalid',
      message: error.message,
      at,
      retryable: true,
    };
  }
  // Deliberately not the raw message: an unexpected provider or database error
  // can contain a URL or a row value, and this record is shown in the UI.
  return {
    code: 'internal',
    message: 'Sync stopped because of an unexpected error. Your local vault was not replaced.',
    at,
    retryable: true,
  };
}

// ---------------------------------------------------------------------------
// Local snapshot
// ---------------------------------------------------------------------------

interface LocalSnapshot {
  entries: Map<string, SyncEntry>;
  serialized: Map<string, string>;
}

async function readLocalEntries(
  base: ReadonlyMap<string, SyncEntry>,
  deviceId: string,
  at: number,
): Promise<LocalSnapshot> {
  const entries = new Map<string, SyncEntry>();
  const serialized = new Map<string, string>();

  const kinds: Array<{ kind: 'folder' | 'link' | 'note' | 'tag' | 'linkTag' | 'noteLink'; rows: CanonicalRow[] }> = [
    { kind: 'folder', rows: (await db.folders.toArray()).map(canonicalFolder) },
    { kind: 'link', rows: (await db.links.toArray()).map(canonicalLink) },
    { kind: 'note', rows: (await db.notes.toArray()).map(canonicalNote) },
    { kind: 'tag', rows: (await db.tags.toArray()).map(canonicalTag) },
    { kind: 'linkTag', rows: (await db.linkTags.toArray()).map(canonicalLinkTag) },
    { kind: 'noteLink', rows: (await db.noteLinks.toArray()).map(canonicalNoteLink) },
  ];

  for (const { kind, rows } of kinds) {
    const built = await entriesFromRows(kind, rows, deviceId, base);
    for (const [key, entry] of built) {
      entries.set(key, entry);
      serialized.set(key, stableStringify(entry.row));
    }
  }

  // Hard deletions are not rows anywhere. The base is the only record that the
  // entity ever existed, so a base row with no local counterpart becomes a
  // deterministic tombstone every time it is needed — until the sync that
  // publishes it moves that tombstone into the base itself.
  for (const [key, entry] of base) {
    if (entry.deleted || entries.has(key)) continue;
    const deletedAt = at;
    entries.set(key, {
      kind: entry.kind,
      id: entry.id,
      rev: await revisionForTombstone(entry, deletedAt, deviceId),
      deleted: true,
      deletedAt,
    });
  }

  return { entries, serialized };
}

async function readCanonicalVault(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const add = (kind: SyncEntry['kind'], row: CanonicalRow) => {
    out.set(entityKey(kind, rowIdentity(row)), stableStringify(row));
  };
  for (const row of await db.folders.toArray()) add('folder', canonicalFolder(row));
  for (const row of await db.links.toArray()) add('link', canonicalLink(row));
  for (const row of await db.notes.toArray()) add('note', canonicalNote(row));
  for (const row of await db.tags.toArray()) add('tag', canonicalTag(row));
  for (const row of await db.linkTags.toArray()) add('linkTag', canonicalLinkTag(row));
  for (const row of await db.noteLinks.toArray()) add('noteLink', canonicalNoteLink(row));
  return out;
}

// ---------------------------------------------------------------------------
// Privacy guard before upload
// ---------------------------------------------------------------------------

interface ProtectedEntries {
  entries: Map<string, SyncEntry>;
  sealed: number;
  protection: Protection | null;
}

/**
 * Seal anything that inherited protection but arrived as plaintext, and refuse
 * to upload a protected plaintext row if we cannot seal it.
 *
 * This is the one place where an old or foreign client could otherwise cause a
 * leak: moving a plaintext link into a locked folder is a lock change expressed
 * in metadata, and the content has to follow. Unlocking once repairs it; the
 * alternative — uploading readable content behind a lock — is not offered.
 */
async function protectBeforeUpload(
  entries: Map<string, SyncEntry>,
  deviceId: string,
): Promise<ProtectedEntries> {
  const folders: Folder[] = [];
  const notes: Note[] = [];
  const links: SavedLink[] = [];
  for (const entry of entries.values()) {
    if (entry.deleted || !entry.row) continue;
    if (entry.kind === 'folder') folders.push(entry.row as Folder);
    else if (entry.kind === 'note') notes.push(entry.row as Note);
    else if (entry.kind === 'link') links.push(entry.row as SavedLink);
  }
  if (notes.length === 0 && links.length === 0) return { entries, sealed: 0, protection: null };

  const protection = computeProtection(folders, notes, links);
  if (protection.notes.size === 0 && protection.links.size === 0) {
    return { entries, sealed: 0, protection };
  }

  const key = getVaultKey();
  const out = new Map(entries);
  let sealed = 0;

  const seal = async (kind: 'note' | 'link', entry: SyncEntry): Promise<SyncEntry | null> => {
    const protectedIds = kind === 'note' ? protection.notes : protection.links;
    if (!protectedIds.has(entry.id)) return entry;
    const row = entry.row as Note | SavedLink;
    if (row.enc) return entry;
    if (!key) return null;
    const sealedRow = kind === 'note'
      ? canonicalNote(await sealNote(row as Note, key))
      : canonicalLink(await sealLink(row as SavedLink, key));
    sealed += 1;
    return {
      kind,
      id: entry.id,
      rev: await revisionForRow(kind, sealedRow, deviceId),
      row: sealedRow,
    };
  };

  for (const [keyName, entry] of entries) {
    if (entry.deleted || !entry.row) continue;
    if (entry.kind !== 'note' && entry.kind !== 'link') continue;
    const next = await seal(entry.kind, entry);
    if (next === null) {
      throw new SyncFailure({
        code: 'key-mismatch',
        message:
          'Locked content needs this vault unlocked once before it can sync safely. Unlock a locked folder, then sync again.',
        at: Date.now(),
        retryable: true,
      });
    }
    if (next !== entry) out.set(keyName, next);
  }

  return { entries: out, sealed, protection };
}

/**
 * Conflict records are local review material, but they live in IndexedDB just
 * like rows do, so a protected payload must not be stored there in plaintext.
 *
 * Payloads that are already ciphertext stay as they are. A plaintext payload for
 * a protected note or link is sealed with the vault key; if there is no key the
 * content is redacted instead, and the conflict remains a structural record the
 * user can act on after unlocking. The label is generic for the same reason: a
 * title is content, and a conflict list is visible before a folder is opened.
 */
async function sanitizeConflicts(
  conflicts: readonly MergeConflict[],
  protection: Protection | null,
  deviceId: string,
): Promise<MergeConflict[]> {
  if (!protection) return [...conflicts];
  if (protection.notes.size === 0 && protection.links.size === 0) return [...conflicts];

  const key = getVaultKey();
  const out: MergeConflict[] = [];
  for (const conflict of conflicts) {
    if (conflict.kind !== 'note' && conflict.kind !== 'link') {
      out.push(conflict);
      continue;
    }
    const ids = conflict.kind === 'note' ? protection.notes : protection.links;
    if (!ids.has(conflict.entityId)) {
      out.push(conflict);
      continue;
    }
    out.push({
      ...conflict,
      label: conflict.kind === 'note' ? 'Locked note' : 'Locked link',
      local: await sanitizeConflictEntry(conflict.local, conflict.kind, key, deviceId),
      remote: await sanitizeConflictEntry(conflict.remote, conflict.kind, key, deviceId),
    });
  }
  return out;
}

async function sanitizeConflictEntry(
  entry: SyncEntry | undefined,
  kind: 'note' | 'link',
  key: CryptoKey | null,
  deviceId: string,
): Promise<SyncEntry | undefined> {
  if (!entry || entry.deleted || !entry.row) return entry;
  const row = entry.row as Note | SavedLink;
  if (row.enc) return entry;
  if (!key) {
    const redacted = kind === 'note' ? redactNote(row as Note) : redactLink(row as SavedLink);
    return {
      ...entry,
      row: kind === 'note'
        ? canonicalNote(redacted as Note)
        : canonicalLink(redacted as SavedLink),
    };
  }
  const sealedRow = kind === 'note'
    ? canonicalNote(await sealNote(row as Note, key))
    : canonicalLink(await sealLink(row as SavedLink, key));
  return {
    ...entry,
    rev: await revisionForRow(kind, sealedRow, deviceId),
    row: sealedRow,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function uploadChunks(
  transport: SyncTransport,
  deviceId: string,
  entries: readonly SyncEntry[],
  previousSeq: number,
  revision: number,
  at: number,
): Promise<ManifestChunkRef[]> {
  const groups = splitChunks(entries);
  const refs: ManifestChunkRef[] = [];
  let seq = previousSeq;
  for (const group of groups) {
    seq += 1;
    const chunk = {
      protocol: SYNC_PROTOCOL,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      schemaVersion: SYNC_SCHEMA_VERSION,
      deviceId,
      seq,
      createdAt: at,
      entries: group,
    };
    const content = JSON.stringify(chunk);
    const hash = await sha256Hex(content);
    const name = `${CHUNK_PREFIX}${deviceId}-${seq}-${hash.slice(0, 16)}.json`;
    const file = await transport.uploadText({ name, content });
    refs.push({
      fileId: file.id,
      name,
      hash,
      seq,
      revision,
      entries: group.length,
      createdAt: at,
    });
  }
  return refs;
}

function splitChunks(entries: readonly SyncEntry[]): SyncEntry[][] {
  const groups: SyncEntry[][] = [];
  let current: SyncEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = stableStringify(entry).length;
    if (
      current.length > 0 &&
      (current.length >= MAX_CHUNK_ENTRIES || bytes + size > MAX_CHUNK_BYTES)
    ) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// ---------------------------------------------------------------------------
// Local commit
// ---------------------------------------------------------------------------

type EntityBuckets<T> = {
  folder: T[];
  link: T[];
  note: T[];
  tag: T[];
  linkTag: T[];
  noteLink: T[];
};

interface CommitInput {
  merged: Map<string, SyncEntry>;
  base: ReadonlyMap<string, SyncEntry>;
  localSerialized: ReadonlyMap<string, string>;
  conflicts: SyncConflictRow[];
  processedPeers: SyncPeerRow[];
  ownSeq: number;
  ownRevision: number;
  ownFileId?: string;
  at: number;
}

async function commitMergedState(input: CommitInput): Promise<number> {
  return db.transaction(
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
      // Optimistic concurrency. If the vault changed after the snapshot this
      // merge was computed from, abort rather than overwrite the newer edit.
      // Nothing has been marked processed: the checkpoint update is below.
      const current = await readCanonicalVault();
      const checkKeys = new Set([...input.localSerialized.keys(), ...input.merged.keys()]);
      for (const key of checkKeys) {
        const before = input.localSerialized.get(key) ?? null;
        const now = current.get(key) ?? null;
        if (before !== now) {
          throw new SyncFailure({
            code: 'concurrent-change',
            message: 'The vault changed while sync was running. Nothing was overwritten; sync again.',
            at: input.at,
            retryable: true,
          });
        }
      }

      const deletes: EntityBuckets<string | [string, string]> = {
        folder: [],
        link: [],
        note: [],
        tag: [],
        linkTag: [],
        noteLink: [],
      };
      const puts: EntityBuckets<CanonicalRow> = {
        folder: [],
        link: [],
        note: [],
        tag: [],
        linkTag: [],
        noteLink: [],
      };

      for (const [key, entry] of input.merged) {
        const before = input.localSerialized.get(key) ?? null;
        const after = entry.deleted ? null : stableStringify(entry.row);
        if (before === after) continue;
        if (entry.deleted) {
          deletes[entry.kind]?.push(primaryKey(entry));
        } else if (entry.row) {
          puts[entry.kind]?.push(entry.row);
        }
      }

      const relationDeletes = (kind: 'linkTag' | 'noteLink') =>
        deletes[kind] as Array<[string, string]>;

      if (deletes.linkTag.length) await db.linkTags.bulkDelete(relationDeletes('linkTag'));
      if (deletes.noteLink.length) await db.noteLinks.bulkDelete(relationDeletes('noteLink'));
      if (deletes.link.length) await db.links.bulkDelete(deletes.link as string[]);
      if (deletes.note.length) await db.notes.bulkDelete(deletes.note as string[]);
      if (deletes.folder.length) await db.folders.bulkDelete(deletes.folder as string[]);
      if (deletes.tag.length) await db.tags.bulkDelete(deletes.tag as string[]);

      if (puts.folder.length) await db.folders.bulkPut(puts.folder as Folder[]);
      if (puts.link.length) await db.links.bulkPut(puts.link as SavedLink[]);
      if (puts.note.length) await db.notes.bulkPut(puts.note as Note[]);
      if (puts.tag.length) {
        await db.tags.bulkPut(puts.tag as Array<{ id: string; name: string }>);
      }
      if (puts.linkTag.length) await db.linkTags.bulkPut(puts.linkTag as LinkTag[]);
      if (puts.noteLink.length) await db.noteLinks.bulkPut(puts.noteLink as NoteLink[]);

      // Base becomes the merged state, but only rows that actually differ are
      // written. Tombstones stay here forever; they are the durable record that
      // lets a deletion propagate after the row itself is gone.
      const basePuts = [];
      for (const [key, entry] of input.merged) {
        const previous = input.base.get(key);
        if (previous && syncEntriesEqual(previous, entry)) continue;
        basePuts.push(baseRow(entry, input.at));
      }
      const baseDeletes: string[] = [];
      for (const key of input.base.keys()) {
        if (!input.merged.has(key)) baseDeletes.push(key);
      }
      if (baseDeletes.length) await db.syncBase.bulkDelete(baseDeletes);
      if (basePuts.length) await db.syncBase.bulkPut(basePuts);

      if (input.processedPeers.length) await db.syncPeers.bulkPut(input.processedPeers);

      if (input.conflicts.length) {
        const existing = await db.syncConflicts.toArray();
        const byId = new Map(existing.map((row) => [row.id, row]));
        for (const conflict of input.conflicts) byId.set(conflict.id, conflict);
        await db.syncConflicts.clear();
        await db.syncConflicts.bulkPut([...byId.values()]);
      }

      const metaEntries: Array<{ key: (typeof SYNC_META_KEYS)[keyof typeof SYNC_META_KEYS]; value: unknown }> = [
        { key: SYNC_META_KEYS.lastSuccessAt, value: input.at },
        { key: SYNC_META_KEYS.lastAttemptAt, value: input.at },
        { key: SYNC_META_KEYS.ownSeq, value: input.ownSeq },
        { key: SYNC_META_KEYS.ownRevision, value: input.ownRevision },
        { key: SYNC_META_KEYS.pendingCount, value: 0 },
      ];
      if (input.ownFileId) metaEntries.push({ key: SYNC_META_KEYS.ownFileId, value: input.ownFileId });
      await db.syncMeta.bulkPut(metaEntries);
      await db.syncMeta.delete(SYNC_META_KEYS.lastError);

      return Object.values(puts).reduce((sum, rows) => sum + rows.length, 0) +
        Object.values(deletes).reduce((sum, rows) => sum + rows.length, 0);
    },
  );
}

function primaryKey(entry: SyncEntry): string | [string, string] {
  if (entry.kind === 'linkTag') {
    const row = entry.row as { linkId: string; tagId: string } | undefined;
    if (row) return [row.linkId, row.tagId];
    const at = entry.id.indexOf('~');
    return [entry.id.slice(0, at), entry.id.slice(at + 1)];
  }
  if (entry.kind === 'noteLink') {
    const row = entry.row as { noteId: string; linkId: string } | undefined;
    if (row) return [row.noteId, row.linkId];
    const at = entry.id.indexOf('~');
    return [entry.id.slice(0, at), entry.id.slice(at + 1)];
  }
  return entry.id;
}
