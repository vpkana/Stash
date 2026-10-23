import type { EncryptedPayload, Folder, LinkTag, Note, NoteLink, SavedLink, Tag } from '@/db/types';
import { isEncryptedPayload } from '@/lib/privacy/crypto';
import { makeRevision, stableStringify } from './canonical';

/**
 * The sync wire format.
 *
 * Everything here is versioned and validated before it is allowed to touch the
 * database. The local vault is the source of truth; a remote file is an
 * untrusted message from another installation, so "it parsed as JSON" is not
 * enough to write it.
 */

export const SYNC_PROTOCOL = 'stash-sync';
export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_SCHEMA_VERSION = 7;

export const MANIFEST_PREFIX = 'stash-sync-v1-device-';
export const CHUNK_PREFIX = 'stash-sync-v1-chunk-';
export const KEYRING_PREFIX = 'stash-sync-v1-keyring-';

/** Chunk limits. A chunk is a unit of upload retry, not a database dump. */
export const MAX_CHUNK_ENTRIES = 500;
export const MAX_CHUNK_BYTES = 1_500_000;
/** Ceiling on one stored row, before it is split into its own chunk. */
export const MAX_ROW_BYTES = 2_000_000;
export const MAX_MANIFEST_CHUNKS = 20_000;

export type EntityKind = 'folder' | 'link' | 'note' | 'tag' | 'linkTag' | 'noteLink';

export type ConflictReason = 'fields' | 'delete-edit' | 'note-copy';

export const ENTITY_KINDS: readonly EntityKind[] = [
  'folder',
  'link',
  'note',
  'tag',
  'linkTag',
  'noteLink',
];

/** A full current row, or a tombstone saying the row is gone. */
export interface SyncEntry {
  kind: EntityKind;
  id: string;
  /**
   * Opaque, ordered. See `makeRevision` — timestamp, content hash prefix and
   * origin device. Never regenerated for unchanged content.
   */
  rev: string;
  deleted?: true;
  /** When the hard deletion happened, for tombstone diagnostics/GC. */
  deletedAt?: number;
  row?: CanonicalRow;
}

export type CanonicalFolder = Pick<
  Folder,
  | 'id'
  | 'parentId'
  | 'name'
  | 'icon'
  | 'createdAt'
  | 'updatedAt'
  | 'sortOrder'
  | 'isFavorite'
  | 'isLocked'
  | 'enc'
  | 'deletedAt'
  | 'trashBatch'
>;

export type CanonicalLink = Pick<
  SavedLink,
  | 'id'
  | 'folderId'
  | 'url'
  | 'normalizedUrl'
  | 'title'
  | 'description'
  | 'userNote'
  | 'source'
  | 'sourcePackage'
  | 'rawText'
  | 'createdAt'
  | 'updatedAt'
  | 'lastOpenedAt'
  | 'sortOrder'
  | 'isFavorite'
  | 'isUnavailable'
  | 'unavailableAt'
  | 'isLocked'
  | 'enc'
  | 'deletedAt'
  | 'trashBatch'
>;

export type CanonicalNote = Pick<
  Note,
  | 'id'
  | 'parentNoteId'
  | 'title'
  | 'content'
  | 'createdAt'
  | 'updatedAt'
  | 'sortOrder'
  | 'isFavorite'
  | 'isLocked'
  | 'enc'
  | 'deletedAt'
  | 'trashBatch'
>;

export type CanonicalTag = Pick<Tag, 'id' | 'name'>;
export type CanonicalLinkTag = LinkTag;
export type CanonicalNoteLink = NoteLink;

export type CanonicalRow =
  | CanonicalFolder
  | CanonicalLink
  | CanonicalNote
  | CanonicalTag
  | CanonicalLinkTag
  | CanonicalNoteLink;

export interface SyncChunk {
  protocol: typeof SYNC_PROTOCOL;
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  schemaVersion: number;
  deviceId: string;
  seq: number;
  createdAt: number;
  entries: SyncEntry[];
}

export interface ManifestChunkRef {
  fileId: string;
  name: string;
  hash: string;
  seq: number;
  revision: number;
  entries: number;
  createdAt: number;
}

export interface DeviceManifest {
  protocol: typeof SYNC_PROTOCOL;
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  schemaVersion: number;
  deviceId: string;
  deviceName: string;
  revision: number;
  updatedAt: number;
  chunks: ManifestChunkRef[];
}

/**
 * The portable keyring envelope in Drive.
 *
 * Ciphertext only: a recovery-wrapped vault key plus the public KDF parameters
 * needed to derive the wrapping key. No vault key, no device wrap, no token.
 */
export interface SyncKeyringFile {
  protocol: typeof SYNC_PROTOCOL;
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  kdf: { algorithm: 'PBKDF2-SHA256'; salt: string; iterations: number };
  wrappedByRecovery: EncryptedPayload;
}

export class SyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncValidationError';
  }
}

export function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

export function entryKey(entry: SyncEntry): string {
  return entityKey(entry.kind, entry.id);
}

/** Composite ids use `~`, which never appears in a UUID. */
export function linkTagId(linkId: string, tagId: string): string {
  return `${linkId}~${tagId}`;
}

export function noteLinkId(noteId: string, linkId: string): string {
  return `${noteId}~${linkId}`;
}

export function splitCompositeId(id: string): [string, string] | null {
  const at = id.indexOf('~');
  if (at <= 0 || at === id.length - 1) return null;
  return [id.slice(0, at), id.slice(at + 1)];
}

// ---------------------------------------------------------------------------
// Canonical rows
//
// The canonical form is an allow-list. A field that is not named here does not
// sync, which makes "did we accidentally upload UI state?" answerable by reading
// one function rather than auditing every caller.
// ---------------------------------------------------------------------------

export function canonicalFolder(folder: Folder): CanonicalFolder {
  return copyDefined({
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    icon: folder.icon,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    sortOrder: folder.sortOrder,
    isFavorite: folder.isFavorite,
    isLocked: folder.isLocked,
    enc: folder.enc,
    deletedAt: folder.deletedAt,
    trashBatch: folder.trashBatch,
  });
}

export function canonicalLink(link: SavedLink): CanonicalLink {
  return copyDefined({
    id: link.id,
    folderId: link.folderId,
    url: link.url,
    normalizedUrl: link.normalizedUrl,
    title: link.title,
    description: link.description,
    userNote: link.userNote,
    source: link.source,
    sourcePackage: link.sourcePackage,
    rawText: link.rawText,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    lastOpenedAt: link.lastOpenedAt,
    sortOrder: link.sortOrder,
    isFavorite: link.isFavorite,
    isUnavailable: link.isUnavailable,
    unavailableAt: link.unavailableAt,
    isLocked: link.isLocked,
    enc: link.enc,
    deletedAt: link.deletedAt,
    trashBatch: link.trashBatch,
  });
}

export function canonicalNote(note: Note): CanonicalNote {
  return copyDefined({
    id: note.id,
    parentNoteId: note.parentNoteId,
    title: note.title,
    content: note.content,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    sortOrder: note.sortOrder,
    isFavorite: note.isFavorite,
    isLocked: note.isLocked,
    enc: note.enc,
    deletedAt: note.deletedAt,
    trashBatch: note.trashBatch,
  });
}

export function canonicalTag(tag: Tag): CanonicalTag {
  return { id: tag.id, name: tag.name };
}

export function canonicalLinkTag(linkTag: LinkTag): CanonicalLinkTag {
  return { linkId: linkTag.linkId, tagId: linkTag.tagId };
}

export function canonicalNoteLink(noteLink: NoteLink): CanonicalNoteLink {
  return {
    noteId: noteLink.noteId,
    linkId: noteLink.linkId,
    origin: noteLink.origin,
    createdAt: noteLink.createdAt,
    sortOrder: noteLink.sortOrder,
  };
}

function copyDefined<T extends object>(value: T): T {
  const out = {} as Record<string, unknown>;
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) out[key] = member;
  }
  return out as T;
}

/** The timestamp a revision is built from. Relations have no `updatedAt`. */
export function rowStamp(kind: EntityKind, row: CanonicalRow): number {
  if (kind === 'tag') return 0;
  if (kind === 'linkTag') return 0;
  if (kind === 'noteLink') return (row as CanonicalNoteLink).createdAt;
  return (row as CanonicalFolder | CanonicalLink | CanonicalNote).updatedAt;
}

export async function revisionForRow(
  kind: EntityKind,
  row: CanonicalRow,
  deviceId: string,
): Promise<string> {
  const canonical = stableStringify({ kind, row });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const bytes = new Uint8Array(digest);
  let hash = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hash += (bytes[index] as number).toString(16).padStart(2, '0');
  }
  return makeRevision(rowStamp(kind, row), hash, deviceId);
}

/** Tombstone revision derived from the row it replaces, so retries are stable. */
export async function revisionForTombstone(
  replaced: SyncEntry,
  deletedAt: number,
  deviceId: string,
): Promise<string> {
  const canonical = stableStringify({
    kind: replaced.kind,
    id: replaced.id,
    deletedFrom: replaced.rev,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const bytes = new Uint8Array(digest);
  let hash = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hash += (bytes[index] as number).toString(16).padStart(2, '0');
  }
  return makeRevision(deletedAt, hash, deviceId);
}

export function rowEquals(a: SyncEntry, b: SyncEntry): boolean {
  if (a.deleted === true || b.deleted === true) return a.deleted === true && b.deleted === true;
  return stableStringify(a.row) === stableStringify(b.row);
}

export function entryEquals(a: SyncEntry | undefined, b: SyncEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.id === b.id && rowEquals(a, b);
}

/** Public alias with a name that reads well at call sites outside the engine. */
export const syncEntriesEqual = entryEquals;

/** Every entry in a set of rows, with a revision that reuses `base` when equal. */
export async function entriesFromRows(
  kind: EntityKind,
  rows: readonly CanonicalRow[],
  deviceId: string,
  base: ReadonlyMap<string, SyncEntry>,
): Promise<Map<string, SyncEntry>> {
  const out = new Map<string, SyncEntry>();
  for (const row of rows) {
    const id = rowIdentity(row);
    const key = entityKey(kind, id);
    const previous = base.get(key);
    if (previous && !previous.deleted && previous.row) {
      const previousRow = previous.row;
      if (stableStringify(previousRow) === stableStringify(row)) {
        out.set(key, previous);
        continue;
      }
    }
    out.set(key, {
      kind,
      id,
      rev: await revisionForRow(kind, row, deviceId),
      row,
    });
  }
  return out;
}

/** Relations carry their identity in two columns rather than an `id`. */
export function rowIdentity(row: CanonicalRow): string {
  if ('tagId' in row && 'linkId' in row) return linkTagId(row.linkId, row.tagId);
  if ('noteId' in row) return noteLinkId(row.noteId, row.linkId);
  return (row as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Validation
//
// Messages are deliberately generic. A validation failure must be reportable
// without echoing note content, URLs, or ciphertext into a log or the UI.
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new SyncValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.length > max) fail(`${field} is too long`);
  return value;
}

function readOptionalString(value: unknown, field: string, max = 20_000): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, field, max);
}

function readFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} must be a number`);
  return value;
}

function readBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`);
  return value;
}

function readOptionalFinite(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  return readFinite(value, field);
}

function readEnc(value: unknown): EncryptedPayload | undefined {
  if (value === undefined) return undefined;
  if (!isEncryptedPayload(value)) fail('enc is not a valid encrypted payload');
  const payload = value as EncryptedPayload;
  if (payload.iv.length > 128 || payload.ct.length > 6_000_000) fail('enc is too large');
  return { v: 1, alg: 'AES-GCM', iv: payload.iv, ct: payload.ct };
}

function readId(value: unknown, field: string): string {
  const id = readString(value, field, 200);
  if (id.trim().length === 0) fail(`${field} is empty`);
  return id;
}

function validateSealedInvariants(kind: EntityKind, row: Record<string, unknown>): void {
  const enc = row.enc as EncryptedPayload | undefined;
  if (!enc) return;
  // A sealed row may have `isLocked:false`: sealing is inherited from a locked
  // ancestor, and the flag only records a lock on the row itself. What must hold
  // is that no plaintext secret survives beside the ciphertext.
  if (kind === 'note') {
    if (row.title !== '' || row.content !== '') fail('a sealed note exposes plaintext');
  } else if (kind === 'link') {
    if (row.url !== '' || row.normalizedUrl !== '') fail('a sealed link exposes plaintext');
    for (const field of ['title', 'description', 'userNote', 'rawText', 'source']) {
      if (row[field] !== undefined) fail('a sealed link exposes plaintext');
    }
  } else if (kind === 'folder') {
    if (row.name !== '') fail('a sealed folder exposes its name');
  }
}

function validateFolderRow(value: unknown): CanonicalFolder {
  if (!isRecord(value)) fail('folder row must be an object');
  const row = {
    id: readId(value.id, 'id'),
    parentId: value.parentId === null ? null : readId(value.parentId, 'parentId'),
    name: readString(value.name, 'name', 500),
    icon: readOptionalString(value.icon, 'icon', 100),
    createdAt: readFinite(value.createdAt, 'createdAt'),
    updatedAt: readFinite(value.updatedAt, 'updatedAt'),
    sortOrder: readFinite(value.sortOrder, 'sortOrder'),
    isFavorite: readBool(value.isFavorite, 'isFavorite'),
    isLocked: readBool(value.isLocked, 'isLocked'),
    enc: readEnc(value.enc),
    deletedAt: readOptionalFinite(value.deletedAt, 'deletedAt'),
    trashBatch: readOptionalString(value.trashBatch, 'trashBatch', 200),
  };
  validateSealedInvariants('folder', row);
  return copyDefined(row);
}

function validateLinkRow(value: unknown): CanonicalLink {
  if (!isRecord(value)) fail('link row must be an object');
  const row = {
    id: readId(value.id, 'id'),
    folderId: value.folderId === null ? null : readId(value.folderId, 'folderId'),
    url: readString(value.url, 'url', 20_000),
    normalizedUrl: readString(value.normalizedUrl, 'normalizedUrl', 20_000),
    title: readOptionalString(value.title, 'title', 2_000),
    description: readOptionalString(value.description, 'description', 40_000),
    userNote: readOptionalString(value.userNote, 'userNote', 200_000),
    source: readOptionalString(value.source, 'source', 500),
    sourcePackage: readOptionalString(value.sourcePackage, 'sourcePackage', 300),
    rawText: readOptionalString(value.rawText, 'rawText', 200_000),
    createdAt: readFinite(value.createdAt, 'createdAt'),
    updatedAt: readFinite(value.updatedAt, 'updatedAt'),
    lastOpenedAt: readOptionalFinite(value.lastOpenedAt, 'lastOpenedAt'),
    sortOrder: readOptionalFinite(value.sortOrder, 'sortOrder'),
    isFavorite: readBool(value.isFavorite, 'isFavorite'),
    isUnavailable: value.isUnavailable === undefined ? undefined : readBool(value.isUnavailable, 'isUnavailable'),
    unavailableAt: readOptionalFinite(value.unavailableAt, 'unavailableAt'),
    isLocked: readBool(value.isLocked, 'isLocked'),
    enc: readEnc(value.enc),
    deletedAt: readOptionalFinite(value.deletedAt, 'deletedAt'),
    trashBatch: readOptionalString(value.trashBatch, 'trashBatch', 200),
  };
  validateSealedInvariants('link', row);
  return copyDefined(row);
}

function validateNoteRow(value: unknown): CanonicalNote {
  if (!isRecord(value)) fail('note row must be an object');
  const row = {
    id: readId(value.id, 'id'),
    parentNoteId: value.parentNoteId === null ? null : readId(value.parentNoteId, 'parentNoteId'),
    title: readString(value.title, 'title', 2_000),
    content: readString(value.content, 'content', MAX_ROW_BYTES),
    createdAt: readFinite(value.createdAt, 'createdAt'),
    updatedAt: readFinite(value.updatedAt, 'updatedAt'),
    sortOrder: readFinite(value.sortOrder, 'sortOrder'),
    isFavorite: readBool(value.isFavorite, 'isFavorite'),
    isLocked: readBool(value.isLocked, 'isLocked'),
    enc: readEnc(value.enc),
    deletedAt: readOptionalFinite(value.deletedAt, 'deletedAt'),
    trashBatch: readOptionalString(value.trashBatch, 'trashBatch', 200),
  };
  validateSealedInvariants('note', row);
  return copyDefined(row);
}

function validateTagRow(value: unknown): CanonicalTag {
  if (!isRecord(value)) fail('tag row must be an object');
  return {
    id: readId(value.id, 'id'),
    name: readString(value.name, 'name', 100),
  };
}

function validateLinkTagRow(value: unknown, id: string): CanonicalLinkTag {
  if (!isRecord(value)) fail('linkTag row must be an object');
  const [linkId, tagId] = splitCompositeId(id) ?? fail('linkTag id is malformed');
  if (value.linkId !== linkId || value.tagId !== tagId) fail('linkTag row does not match its id');
  return { linkId, tagId };
}

function validateNoteLinkRow(value: unknown, id: string): CanonicalNoteLink {
  if (!isRecord(value)) fail('noteLink row must be an object');
  const [noteId, linkId] = splitCompositeId(id) ?? fail('noteLink id is malformed');
  if (value.noteId !== noteId || value.linkId !== linkId) fail('noteLink row does not match its id');
  if (value.origin !== 'created-from' && value.origin !== 'attached') fail('noteLink origin is invalid');
  return {
    noteId,
    linkId,
    origin: value.origin,
    createdAt: readFinite(value.createdAt, 'createdAt'),
    sortOrder: readFinite(value.sortOrder, 'sortOrder'),
  };
}

export function validateEntry(value: unknown): SyncEntry {
  if (!isRecord(value)) fail('entry must be an object');
  if (!ENTITY_KINDS.includes(value.kind as EntityKind)) fail('unknown entity kind');
  const kind = value.kind as EntityKind;
  const id = validateEntryId(kind, value.id);
  const rev = readString(value.rev, 'rev', 300);
  if (!/^\d{13}-[0-9a-f]{16}-[A-Za-z0-9_-]{1,140}$/.test(rev)) fail('revision is malformed');

  if (value.deleted === true) {
    if (value.row !== undefined) fail('a tombstone must not carry a row');
    return copyDefined({
      kind,
      id,
      rev,
      deleted: true as const,
      deletedAt: value.deletedAt === undefined ? undefined : readFinite(value.deletedAt, 'deletedAt'),
    });
  }

  const row = validateRow(kind, value.row, id);
  return { kind, id, rev, row };
}

function validateEntryId(kind: EntityKind, value: unknown): string {
  const id = readId(value, 'id');
  if (kind === 'linkTag' || kind === 'noteLink') {
    const pair = splitCompositeId(id);
    if (!pair) fail('composite id is malformed');
    if (kind === 'noteLink' && pair[0] === pair[1]) fail('a note cannot link to itself');
  } else if (id.includes('~')) {
    fail('id contains a reserved separator');
  }
  return id;
}

function validateRow(kind: EntityKind, value: unknown, id: string): CanonicalRow {
  if (kind === 'folder') {
    const row = validateFolderRow(value);
    if (row.id !== id) fail('row id does not match entry id');
    return row;
  }
  if (kind === 'link') {
    const row = validateLinkRow(value);
    if (row.id !== id) fail('row id does not match entry id');
    return row;
  }
  if (kind === 'note') {
    const row = validateNoteRow(value);
    if (row.id !== id) fail('row id does not match entry id');
    return row;
  }
  if (kind === 'tag') {
    const row = validateTagRow(value);
    if (row.id !== id) fail('row id does not match entry id');
    return row;
  }
  if (kind === 'linkTag') return validateLinkTagRow(value, id);
  return validateNoteLinkRow(value, id);
}

export function validateChunk(value: unknown): SyncChunk {
  if (!isRecord(value)) fail('chunk must be an object');
  if (value.protocol !== SYNC_PROTOCOL) fail('not a Stash sync chunk');
  if (value.protocolVersion !== SYNC_PROTOCOL_VERSION) fail('unsupported sync protocol version');
  const schemaVersion = readFinite(value.schemaVersion, 'schemaVersion');
  if (schemaVersion > SYNC_SCHEMA_VERSION) fail('this vault was written by a newer Stash version');
  const deviceId = readId(value.deviceId, 'deviceId');
  const seq = readFinite(value.seq, 'seq');
  if (seq < 1) fail('chunk sequence is invalid');
  if (!Array.isArray(value.entries)) fail('chunk entries must be an array');
  if (value.entries.length > MAX_CHUNK_ENTRIES) fail('chunk has too many entries');
  const entries = value.entries.map(validateEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entryKey(entry);
    if (seen.has(key)) fail('chunk contains the same entity twice');
    seen.add(key);
  }
  return {
    protocol: SYNC_PROTOCOL,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    schemaVersion,
    deviceId,
    seq,
    createdAt: readFinite(value.createdAt, 'createdAt'),
    entries,
  };
}

export function validateManifest(value: unknown): DeviceManifest {
  if (!isRecord(value)) fail('manifest must be an object');
  if (value.protocol !== SYNC_PROTOCOL) fail('not a Stash sync manifest');
  if (value.protocolVersion !== SYNC_PROTOCOL_VERSION) fail('unsupported sync protocol version');
  const schemaVersion = readFinite(value.schemaVersion, 'schemaVersion');
  if (schemaVersion > SYNC_SCHEMA_VERSION) fail('this vault was written by a newer Stash version');
  const deviceId = readId(value.deviceId, 'deviceId');
  const revision = readFinite(value.revision, 'revision');
  if (revision < 0) fail('manifest revision is invalid');
  if (!Array.isArray(value.chunks)) fail('manifest chunks must be an array');
  if (value.chunks.length > MAX_MANIFEST_CHUNKS) fail('manifest has too many chunks');
  const chunks: ManifestChunkRef[] = [];
  for (let index = 0; index < value.chunks.length; index += 1) {
    const chunk = value.chunks[index];
    if (!isRecord(chunk)) fail('manifest chunk reference must be an object');
    const seq = readFinite(chunk.seq, 'chunk.seq');
    if (seq < 1) fail('chunk sequence is invalid');
    const ref: ManifestChunkRef = {
      fileId: readString(chunk.fileId, 'chunk.fileId', 500),
      name: readString(chunk.name, 'chunk.name', 300),
      hash: readString(chunk.hash, 'chunk.hash', 64),
      seq,
      revision: readFinite(chunk.revision, 'chunk.revision'),
      entries: readFinite(chunk.entries, 'chunk.entries'),
      createdAt: readFinite(chunk.createdAt, 'chunk.createdAt'),
    };
    if (!ref.name.startsWith(CHUNK_PREFIX) || !ref.name.endsWith('.json')) {
      fail('chunk name is not a Stash sync chunk');
    }
    if (!/^[0-9a-f]{64}$/.test(ref.hash)) fail('chunk hash is malformed');
    if (ref.entries < 0 || ref.entries > MAX_CHUNK_ENTRIES) fail('chunk entry count is invalid');
    const previous = chunks[index - 1];
    if (previous && seq <= previous.seq) fail('manifest chunk order is invalid');
    chunks.push(ref);
  }
  return {
    protocol: SYNC_PROTOCOL,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    schemaVersion,
    deviceId,
    deviceName: readString(value.deviceName, 'deviceName', 200),
    revision,
    updatedAt: readFinite(value.updatedAt, 'updatedAt'),
    chunks,
  };
}

export function validateKeyringFile(value: unknown): SyncKeyringFile {
  if (!isRecord(value)) fail('keyring file must be an object');
  if (value.protocol !== SYNC_PROTOCOL) fail('not a Stash sync keyring');
  if (value.protocolVersion !== SYNC_PROTOCOL_VERSION) fail('unsupported sync protocol version');
  const kdf = value.kdf;
  if (!isRecord(kdf) || kdf.algorithm !== 'PBKDF2-SHA256') fail('keyring KDF is invalid');
  if (typeof kdf.salt !== 'string' || kdf.salt.length > 64) fail('keyring salt is invalid');
  const iterations = readFinite(kdf.iterations, 'kdf.iterations');
  if (iterations < 100_000 || iterations > 2_000_000) fail('keyring KDF strength is invalid');
  const wrapped = readEnc(value.wrappedByRecovery);
  if (!wrapped) fail('keyring is missing its wrapped key');
  const fingerprint = readString(value.fingerprint, 'fingerprint', 128);
  if (!/^[0-9a-f]{16,64}$/.test(fingerprint)) fail('keyring fingerprint is malformed');
  return {
    protocol: SYNC_PROTOCOL,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    fingerprint,
    createdAt: readFinite(value.createdAt, 'createdAt'),
    updatedAt: readFinite(value.updatedAt, 'updatedAt'),
    kdf: { algorithm: 'PBKDF2-SHA256', salt: kdf.salt, iterations },
    wrappedByRecovery: wrapped,
  };
}

export function manifestFileName(deviceId: string): string {
  return `${MANIFEST_PREFIX}${deviceId}.json`;
}

export function keyringFileName(fingerprint: string): string {
  return `${KEYRING_PREFIX}${fingerprint}.json`;
}

/** A safe, content-free label for an entity, used only in local UI records. */
export function entryLabel(entry: SyncEntry): string {
  if (entry.deleted) return 'Deleted item';
  const row = entry.row;
  if (!row) return 'Item';
  if ('enc' in row && row.enc) return 'Locked item';
  if (entry.kind === 'folder') return (row as CanonicalFolder).name || 'Untitled folder';
  if (entry.kind === 'note') return (row as CanonicalNote).title || 'Untitled note';
  if (entry.kind === 'link') {
    const link = row as CanonicalLink;
    return link.title || link.url || 'Untitled link';
  }
  if (entry.kind === 'tag') return `#${(row as CanonicalTag).name}`;
  return 'Relationship';
}
