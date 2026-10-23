import { derivedId, revisionOrigin } from './canonical';
import {
  entityKey,
  entryKey,
  entryLabel,
  linkTagId,
  revisionForRow,
  revisionForTombstone,
  rowStamp,
  type CanonicalFolder,
  type CanonicalLink,
  type CanonicalNote,
  type CanonicalNoteLink,
  type CanonicalRow,
  type ConflictReason,
  type EntityKind,
  type SyncEntry,
} from './protocol';
import { stableStringify } from './canonical';

/**
 * The three-way merge engine.
 *
 * Pure with respect to React, Dexie and Drive: callers hand it three views of
 * the vault (the common ancestor, this device, and what every peer has
 * published) and get back the state that should exist, plus any conflicts that
 * a person has to see. Everything here is deterministic for the same inputs, so
 * two devices independently converge and a retried sync does not invent new
 * conflict copies.
 *
 * The one rule that outranks cleverness: **never lose content**. Where the
 * engine cannot know which value the owner meant, it keeps both — as a visible
 * copy for note bodies, as a local conflict record for ordinary fields, and by
 * resurrecting an edit rather than honouring a concurrent deletion.
 */

export interface MergeConflict {
  id: string;
  kind: EntityKind;
  entityId: string;
  reason: ConflictReason;
  label: string;
  /** This device's version at merge time. Never leaves the device. */
  local?: SyncEntry;
  /** The peer version. May itself be a different peer for remote-only conflicts. */
  remote?: SyncEntry;
  /** Fields that disagreed, for a short human explanation. */
  fields?: string[];
  copyId?: string;
}

export interface MergeResult {
  entries: Map<string, SyncEntry>;
  /** The aggregated peer view, before local changes were folded in. */
  remoteEntries: Map<string, SyncEntry>;
  conflicts: MergeConflict[];
  stats: {
    localChanges: number;
    remoteChanges: number;
    conflictCopies: number;
    repaired: number;
  };
}

export interface MergeInput {
  base: ReadonlyMap<string, SyncEntry>;
  local: ReadonlyMap<string, SyncEntry>;
  /** One sparse change map per peer, including this device's own published log. */
  remotes: ReadonlyMap<string, ReadonlyMap<string, SyncEntry>>;
  deviceId: string;
  /** Only used for tombstones created by structural repairs, never for ordering. */
  at?: number;
}

export async function mergeVaultState(input: MergeInput): Promise<MergeResult> {
  const at = input.at ?? Date.now();
  const conflicts = new Map<string, MergeConflict>();
  const extras = new Map<string, SyncEntry>();

  const local = await withDerivedTombstones(input.base, input.local, input.deviceId, at);

  // Each peer publishes only its own changes, so peer maps are sparse deltas,
  // not complete vaults. Aggregate them against the common ancestor first:
  // otherwise the final merge would see only one peer's edit when two peers
  // changed different fields of the same row.
  const remote = await aggregatePeers(input.base, input.remotes, input.deviceId, conflicts, extras);

  const keys = new Set<string>([...input.base.keys(), ...local.keys(), ...remote.entries.keys()]);
  const merged = new Map<string, SyncEntry>();

  for (const key of keys) {
    const base = input.base.get(key);
    const mine = local.get(key);
    const theirs = remote.entries.get(key);
    if (!base && !mine && !theirs) continue;

    const single = await mergeSingle(base, mine, theirs, input.deviceId);
    if (single.primary) merged.set(key, single.primary);
    if (single.conflict) remember(conflicts, single.conflict);
    for (const extra of single.extras) extras.set(entryKey(extra), extra);
  }

  for (const [key, extra] of extras) {
    if (!merged.has(key)) merged.set(key, extra);
  }

  const repaired = await repairStructure(merged, input.deviceId, at);
  const deduped = await dedupeTags(merged, input.deviceId, at);
  if (deduped > 0) await repairRelations(merged, input.deviceId, at);

  const localChanges = countChanges(input.base, local);
  const remoteChanges = countSparseChanges(input.base, remote.entries);

  return {
    entries: merged,
    remoteEntries: remote.entries,
    conflicts: [...conflicts.values()],
    stats: {
      localChanges,
      remoteChanges,
      conflictCopies: [...extras.values()].length,
      repaired: repaired + deduped,
    },
  };
}

function remember(conflicts: Map<string, MergeConflict>, conflict: MergeConflict): void {
  const existing = conflicts.get(conflict.id);
  if (!existing) {
    conflicts.set(conflict.id, conflict);
    return;
  }
  // A note copy is the strongest evidence of a real conflict; keep that over a
  // field-level diagnostic from another peer.
  if (existing.reason !== 'note-copy' && conflict.reason === 'note-copy') {
    conflicts.set(conflict.id, conflict);
  }
}

function countChanges(
  base: ReadonlyMap<string, SyncEntry>,
  side: ReadonlyMap<string, SyncEntry>,
): number {
  let count = 0;
  for (const key of new Set([...base.keys(), ...side.keys()])) {
    if (!entryEquals(base.get(key), side.get(key))) count += 1;
  }
  return count;
}

/** Remote maps are sparse: an absent key is silence, not a deletion. */
function countSparseChanges(
  base: ReadonlyMap<string, SyncEntry>,
  side: ReadonlyMap<string, SyncEntry>,
): number {
  let count = 0;
  for (const [key, entry] of side) {
    if (!entryEquals(base.get(key), entry)) count += 1;
  }
  return count;
}

function entryEquals(a: SyncEntry | undefined, b: SyncEntry | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (a.deleted === true || b.deleted === true) return a.deleted === true && b.deleted === true;
  return stableStringify(a.row) === stableStringify(b.row);
}

function isLive(entry: SyncEntry | undefined): entry is SyncEntry & { row: CanonicalRow } {
  return Boolean(entry && entry.deleted !== true && entry.row);
}

/**
 * A base row with no local counterpart is a hard deletion. Turning that into a
 * deterministic tombstone here means every caller gets the same answer, and the
 * tombstone is stable across retries instead of being invented by four
 * different delete paths.
 */
async function withDerivedTombstones(
  base: ReadonlyMap<string, SyncEntry>,
  local: ReadonlyMap<string, SyncEntry>,
  deviceId: string,
  at: number,
): Promise<Map<string, SyncEntry>> {
  const out = new Map(local);
  for (const [key, entry] of base) {
    if (entry.deleted || out.has(key)) continue;
    out.set(key, await tombstoneFor(entry, deviceId, at));
  }
  return out;
}

async function tombstoneFor(entry: SyncEntry, deviceId: string, at: number): Promise<SyncEntry> {
  return {
    kind: entry.kind,
    id: entry.id,
    rev: await revisionForTombstone(entry, at, deviceId),
    deleted: true,
    deletedAt: at,
  };
}

interface PairResult {
  primary?: SyncEntry;
  extras: SyncEntry[];
  conflict?: MergeConflict;
}

async function mergeSingle(
  base: SyncEntry | undefined,
  local: SyncEntry | undefined,
  remote: SyncEntry | undefined,
  deviceId: string,
): Promise<PairResult> {
  if (!local && !remote) return { extras: [] };
  if (!base) {
    if (!local) return { primary: remote, extras: [] };
    if (!remote) return { primary: local, extras: [] };
    if (entryEquals(local, remote)) return { primary: local, extras: [] };
    return bothChanged(undefined, local, remote);
  }

  // The local side is a complete vault, so a base row with no local counterpart
  // is a deletion. The remote side is a sparse log of peer *changes*: a peer
  // that simply never touched a row says nothing about it, so absence there
  // means "unchanged", not "deleted".
  const localSide = local ?? (await tombstoneFor(base, deviceId, base.deletedAt ?? 0));
  const remoteSide = remote ?? base;

  if (entryEquals(remoteSide, base)) return { primary: localSide, extras: [] };
  if (entryEquals(localSide, base)) return { primary: remoteSide, extras: [] };
  if (entryEquals(localSide, remoteSide)) return { primary: localSide, extras: [] };
  return bothChanged(base, localSide, remoteSide);
}

async function bothChanged(
  base: SyncEntry | undefined,
  local: SyncEntry,
  remote: SyncEntry,
): Promise<PairResult> {
  const localLive = isLive(local);
  const remoteLive = isLive(remote);
  const conflictId = entityKey(local.kind, local.id);

  if (!localLive && !remoteLive) {
    const deletedAt = Math.max(local.deletedAt ?? 0, remote.deletedAt ?? 0);
    return {
      primary: {
        kind: local.kind,
        id: local.id,
        rev: local.rev >= remote.rev ? local.rev : remote.rev,
        deleted: true,
        deletedAt,
      },
      extras: [],
    };
  }

  // Delete versus edit: the edit survives. A deletion that silently destroys a
  // change the owner made on another device is the one outcome this sync must
  // never produce.
  if (!localLive) {
    return {
      primary: remoteLive ? remote : undefined,
      extras: [],
      conflict: {
        id: conflictId,
        kind: local.kind,
        entityId: local.id,
        reason: 'delete-edit',
        label: entryLabel(remote),
        local,
        remote,
      },
    };
  }
  if (!remoteLive) {
    return {
      primary: local,
      extras: [],
      conflict: {
        id: conflictId,
        kind: local.kind,
        entityId: local.id,
        reason: 'delete-edit',
        label: entryLabel(local),
        local,
        remote,
      },
    };
  }

  const localRow = local.row as CanonicalRow;
  const remoteRow = remote.row as CanonicalRow;

  if (
    local.kind === 'note' &&
    noteBodyDiffers(localRow as CanonicalNote, remoteRow as CanonicalNote)
  ) {
    return mergeNoteConflict(base?.row as CanonicalNote | undefined, local, remote);
  }

  return mergeOrdinaryFields(base?.row as CanonicalRow | undefined, local, remote);
}

function noteBodyDiffers(local: CanonicalNote, remote: CanonicalNote): boolean {
  return (
    local.title !== remote.title ||
    local.content !== remote.content ||
    stableStringify(local.enc) !== stableStringify(remote.enc)
  );
}

async function mergeNoteConflict(
  base: CanonicalNote | undefined,
  local: SyncEntry,
  remote: SyncEntry,
): Promise<PairResult> {
  const localNote = local.row as CanonicalNote;
  const remoteNote = remote.row as CanonicalNote;
  const winner = local.rev >= remote.rev ? local : remote;
  const loser = winner === local ? remote : local;
  const winnerNote = winner.row as CanonicalNote;
  const loserNote = loser.row as CanonicalNote;

  const conflictId = entityKey('note', local.id);
  const sealed = Boolean(localNote.enc || remoteNote.enc);

  // A conflict copy of a sealed note must never carry plaintext the user locked.
  // With a seal on either side the loser stays in a local-only conflict record;
  // both ciphertexts (or the plaintext variant) are preserved there.
  if (sealed) {
    const mergedRow = mergeOrdinaryFields(
      base as CanonicalRow | undefined,
      winner,
      loser,
    );
    return {
      primary: mergedRow.primary,
      extras: [],
      conflict: {
        id: conflictId,
        kind: 'note',
        entityId: local.id,
        reason: 'fields',
        label: 'Locked note',
        local,
        remote,
        fields: ['title', 'content'],
      },
    };
  }

  const copyId = await derivedId(`stash-conflict-copy:${localNote.id}:${loser.rev}`);
  const copy: CanonicalNote = {
    ...loserNote,
    id: copyId,
    title: conflictTitle(loserNote.title),
    isFavorite: false,
    updatedAt: loserNote.updatedAt,
    sortOrder: loserNote.sortOrder + 0.5,
  };
  delete copy.deletedAt;
  delete copy.trashBatch;
  const copyEntry: SyncEntry = {
    kind: 'note',
    id: copyId,
    rev: await revisionForRow('note', copy, `conflict-copy`),
    row: copy,
  };

  // The winner keeps the original id; its other fields still merge field by field
  // so a move or a favourite on the losing side is not silently discarded.
  const merged = mergeOrdinaryFields(base as CanonicalRow | undefined, winner, loser);
  const primary = merged.primary ?? winner;

  return {
    primary,
    extras: [copyEntry],
    conflict: {
      id: conflictId,
      kind: 'note',
      entityId: local.id,
      reason: 'note-copy',
      label: conflictTitle(winnerNote.title),
      local,
      remote,
      fields: merged.conflict?.fields,
      copyId,
    },
  };
}

function conflictTitle(title: string): string {
  const trimmed = title.trim();
  const base = trimmed.length > 0 ? trimmed.slice(0, 119) : 'Untitled';
  return `${base} (conflict copy)`;
}

/**
 * Field-level three-way merge.
 *
 * For every field: unchanged on one side takes the other side; changed on both
 * takes the deterministic revision winner and records the disagreement. The
 * returned row is therefore never a whole-row "last write wins" — a move on one
 * device and a favourite on the other both survive.
 */
function mergeOrdinaryFields(
  base: CanonicalRow | undefined,
  local: SyncEntry,
  remote: SyncEntry,
): PairResult {
  const localRow = local.row as Record<string, unknown>;
  const remoteRow = remote.row as Record<string, unknown>;
  const baseRow = (base ?? {}) as Record<string, unknown>;
  const winner = local.rev >= remote.rev ? local : remote;
  const winnerRow = winner === local ? localRow : remoteRow;

  const merged: Record<string, unknown> = {};
  const conflictFields: string[] = [];
  const keys = new Set([...Object.keys(baseRow), ...Object.keys(localRow), ...Object.keys(remoteRow)]);
  keys.delete('id');

  for (const field of keys) {
    const bv = baseRow[field];
    const lv = localRow[field];
    const rv = remoteRow[field];
    if (same(lv, rv)) {
      if (lv !== undefined) merged[field] = lv;
      continue;
    }
    if (same(lv, bv)) {
      if (rv !== undefined) merged[field] = rv;
      continue;
    }
    if (same(rv, bv)) {
      if (lv !== undefined) merged[field] = lv;
      continue;
    }
    conflictFields.push(field);
    const chosen = winnerRow[field];
    if (chosen !== undefined) merged[field] = chosen;
  }

  const reviewableFields = conflictFields.filter((field) => !TIMESTAMP_FIELDS.has(field));

  keepSecretFieldsCoherent(local.kind, merged, localRow, remoteRow, winnerRow);
  const row = { ...merged, id: local.id } as CanonicalRow;
  // Move the stamp forward so a merged row is not older than either edit. This
  // is content, not clock: the hash part of the revision still carries identity.
  if ('updatedAt' in row) {
    row.updatedAt = Math.max(
      (localRow.updatedAt as number) ?? 0,
      (remoteRow.updatedAt as number) ?? 0,
    );
  }

  const primary =
    stableStringify(row) === stableStringify(winner.row)
      ? winner
      : {
          kind: local.kind,
          id: local.id,
          rev: makeMergedRev(local.kind, row, winner.rev),
          row,
        };

  return {
    primary,
    extras: [],
    conflict:
      reviewableFields.length > 0
        ? {
            id: entityKey(local.kind, local.id),
            kind: local.kind,
            entityId: local.id,
            reason: 'fields',
            label: entryLabel(winner),
            local,
            remote,
            fields: reviewableFields.sort(),
          }
        : undefined,
  };
}

/**
 * A merged row's revision keeps the winning side's timestamp and origin, but
 * changes its hash to the merged content. The origin makes it deterministic on
 * every device that computes the same merge.
 */
function makeMergedRev(kind: EntityKind, row: CanonicalRow, winnerRev: string): string {
  // The hash portion is filled by the caller when the row is written; a stable
  // placeholder would collide across different merges, so derive one quickly
  // from the content. Revisions are opaque to the merge; this only has to be
  // distinct and deterministic.
  const digest = simpleDigest(stableStringify({ kind, row }));
  return `${String(rowStamp(kind, row)).padStart(13, '0')}-${digest}-${revisionOrigin(winnerRev)}`;
}

/**
 * A non-cryptographic digest used only to keep two locally-materialised merged
 * rows from sharing a revision string in the same page load. The uploaded
 * revision is recomputed with SHA-256 by the outbox builder, which is where
 * uniqueness actually matters.
 */
function simpleDigest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b + code, 0x85ebca6b) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 16);
}

/**
 * Fields whose disagreement is an artefact of editing, not a decision to review.
 *
 * Two devices that change different fields necessarily write different
 * `updatedAt` values. Reporting that as a conflict would bury the conflicts a
 * person actually has to resolve, so the merged row still takes the later stamp
 * but the field is not listed for review.
 */
const TIMESTAMP_FIELDS = new Set(['createdAt', 'updatedAt']);

/**
 * Fields that only make sense as one representation.
 *
 * If one device has a sealed row and another has the same row in plaintext, a
 * field-by-field merge could happily take the ciphertext from one side and the
 * title from the other. That row would break the one invariant the lock depends
 * on: a sealed row must expose no plaintext. These fields therefore move as a
 * unit from the revision winner; the other side's representation is represented
 * only in the local conflict record, where the engine seals it before storing.
 */
const SECRET_FIELDS: Partial<Record<EntityKind, readonly string[]>> = {
  note: ['title', 'content', 'enc'],
  link: [
    'url',
    'normalizedUrl',
    'title',
    'description',
    'userNote',
    'rawText',
    'source',
    'enc',
  ],
};

function keepSecretFieldsCoherent(
  kind: EntityKind,
  merged: Record<string, unknown>,
  localRow: Record<string, unknown>,
  remoteRow: Record<string, unknown>,
  winnerRow: Record<string, unknown>,
): void {
  if (localRow.enc === undefined && remoteRow.enc === undefined) return;
  const fields = SECRET_FIELDS[kind];
  if (!fields) return;

  if (winnerRow.enc === undefined) {
    delete merged.enc;
    return;
  }
  for (const field of fields) {
    const value = winnerRow[field];
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Fold peer change maps into one remote view, with the base as ancestor. */
async function aggregatePeers(
  base: ReadonlyMap<string, SyncEntry>,
  remotes: ReadonlyMap<string, ReadonlyMap<string, SyncEntry>>,
  deviceId: string,
  conflicts: Map<string, MergeConflict>,
  extras: Map<string, SyncEntry>,
): Promise<{ entries: Map<string, SyncEntry> }> {
  const peerIds = [...remotes.keys()].sort();
  const allKeys = new Set<string>();
  for (const map of remotes.values()) for (const key of map.keys()) allKeys.add(key);

  const entries = new Map<string, SyncEntry>();
  for (const key of allKeys) {
    const ancestor = base.get(key);
    let aggregate: SyncEntry | undefined = ancestor;
    for (const peerId of peerIds) {
      const next = remotes.get(peerId)?.get(key);
      if (!next) continue;
      if (!aggregate) {
        aggregate = next;
        continue;
      }
      const single = await mergeSingle(ancestor, aggregate, next, deviceId);
      if (single.primary) aggregate = single.primary;
      if (single.conflict) remember(conflicts, single.conflict);
      for (const extra of single.extras) extras.set(entryKey(extra), extra);
    }
    if (!aggregate) continue;
    if (ancestor && entryEquals(aggregate, ancestor)) continue;
    entries.set(key, aggregate);
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// Structural repairs
//
// Hierarchy is data, and data can arrive inconsistent: a parent deleted on one
// device while the child was moved on another, a hand-edited backup, a truncated
// import. Repair is deterministic and conservative: keep the child alive and put
// it somewhere reachable rather than deleting it because its parent is gone.
// ---------------------------------------------------------------------------

async function repairStructure(
  entries: Map<string, SyncEntry>,
  deviceId: string,
  at: number,
): Promise<number> {
  let repaired = 0;
  const liveFolders = collectLive(entries, 'folder') as Map<string, CanonicalFolder>;
  const allFolders = collectAllRows(entries, 'folder') as Map<string, CanonicalFolder>;
  const liveFolderIds = new Set(liveFolders.keys());

  const folderParent = new Map<string, string | null>();
  for (const [id, folder] of liveFolders) folderParent.set(id, folder.parentId);

  // Cycles first: break at the smallest id in each cycle so every device picks
  // the same place to cut.
  for (const id of [...liveFolders.keys()].sort()) {
    const path = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !path.has(cursor)) {
      path.add(cursor);
      cursor = folderParent.get(cursor) ?? null;
    }
    if (!cursor) continue;
    const cycle: string[] = [];
    let walker: string | null = cursor;
    do {
      if (!walker) break;
      cycle.push(walker);
      walker = folderParent.get(walker) ?? null;
    } while (walker && walker !== cursor);
    const breakAt = cycle.sort()[0];
    if (breakAt && folderParent.get(breakAt) !== null) {
      folderParent.set(breakAt, null);
      await replaceRow(entries, 'folder', breakAt, { parentId: null }, deviceId);
      repaired += 1;
    }
  }

  // Re-home anything whose parent is not a live folder: the nearest live
  // ancestor if one exists, otherwise the root.
  for (const id of liveFolders.keys()) {
    const parent = folderParent.get(id) ?? null;
    if (parent === null || liveFolderIds.has(parent)) continue;
    const replacement = nearestLiveFolderAncestor(parent, allFolders, liveFolderIds);
    folderParent.set(id, replacement);
    await replaceRow(entries, 'folder', id, { parentId: replacement }, deviceId);
    repaired += 1;
  }

  const liveNotes = collectLive(entries, 'note') as Map<string, CanonicalNote>;
  const allNotes = collectAllRows(entries, 'note') as Map<string, CanonicalNote>;
  const liveNoteIds = new Set(liveNotes.keys());
  const noteParent = new Map<string, string | null>();
  for (const [id, note] of liveNotes) noteParent.set(id, note.parentNoteId);

  for (const id of [...liveNotes.keys()].sort()) {
    const path = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !path.has(cursor)) {
      path.add(cursor);
      cursor = noteParent.get(cursor) ?? null;
    }
    if (!cursor) continue;
    const cycle: string[] = [];
    let walker: string | null = cursor;
    do {
      if (!walker) break;
      cycle.push(walker);
      walker = noteParent.get(walker) ?? null;
    } while (walker && walker !== cursor);
    const breakAt = cycle.sort()[0];
    if (breakAt && noteParent.get(breakAt) !== null) {
      noteParent.set(breakAt, null);
      await replaceRow(entries, 'note', breakAt, { parentNoteId: null }, deviceId);
      repaired += 1;
    }
  }

  for (const id of liveNotes.keys()) {
    const parent = noteParent.get(id) ?? null;
    if (parent === null || liveNoteIds.has(parent)) continue;
    const replacement = nearestLiveNoteAncestor(parent, allNotes, liveNoteIds);
    noteParent.set(id, replacement);
    await replaceRow(entries, 'note', id, { parentNoteId: replacement }, deviceId);
    repaired += 1;
  }

  // A live link inside a folder that no longer exists goes to the nearest live
  // ancestor, or to the Inbox. It is never dropped.
  const liveLinks = collectLive(entries, 'link') as Map<string, CanonicalLink>;
  for (const [id, link] of liveLinks) {
    if (link.folderId === null || liveFolderIds.has(link.folderId)) continue;
    const replacement = nearestLiveFolderAncestor(link.folderId, allFolders, liveFolderIds);
    await replaceRow(entries, 'link', id, { folderId: replacement }, deviceId);
    repaired += 1;
  }

  repaired += await repairRelations(entries, deviceId, at);
  return repaired;
}

function collectLive(
  entries: Map<string, SyncEntry>,
  kind: EntityKind,
): Map<string, CanonicalRow> {
  const out = new Map<string, CanonicalRow>();
  for (const entry of entries.values()) {
    if (entry.kind !== kind || entry.deleted || !entry.row) continue;
    out.set(entry.id, entry.row);
  }
  return out;
}

function collectAllRows(
  entries: Map<string, SyncEntry>,
  kind: EntityKind,
): Map<string, CanonicalRow> {
  const out = new Map<string, CanonicalRow>();
  for (const entry of entries.values()) {
    if (entry.kind !== kind || !entry.row) continue;
    out.set(entry.id, entry.row);
  }
  return out;
}

function nearestLiveFolderAncestor(
  start: string,
  all: Map<string, CanonicalRow>,
  live: ReadonlySet<string>,
): string | null {
  const guard = new Set<string>();
  let cursor: string | null = start;
  while (cursor && !guard.has(cursor)) {
    if (live.has(cursor)) return cursor;
    guard.add(cursor);
    const row = all.get(cursor) as CanonicalFolder | undefined;
    cursor = row?.parentId ?? null;
  }
  return null;
}

function nearestLiveNoteAncestor(
  start: string,
  all: Map<string, CanonicalRow>,
  live: ReadonlySet<string>,
): string | null {
  const guard = new Set<string>();
  let cursor: string | null = start;
  while (cursor && !guard.has(cursor)) {
    if (live.has(cursor)) return cursor;
    guard.add(cursor);
    const row = all.get(cursor) as CanonicalNote | undefined;
    cursor = row?.parentNoteId ?? null;
  }
  return null;
}

async function repairRelations(
  entries: Map<string, SyncEntry>,
  deviceId: string,
  at: number,
): Promise<number> {
  let repaired = 0;
  const liveLinks = new Set(collectLive(entries, 'link').keys());
  const liveNotes = new Set(collectLive(entries, 'note').keys());
  const liveTags = new Set(collectLive(entries, 'tag').keys());

  for (const [key, entry] of [...entries]) {
    if (entry.deleted || !entry.row) continue;
    if (entry.kind === 'linkTag') {
      const row = entry.row as { linkId: string; tagId: string };
      if (liveLinks.has(row.linkId) && liveTags.has(row.tagId)) continue;
      entries.set(key, await tombstoneFrom(entry, deviceId, at));
      repaired += 1;
    } else if (entry.kind === 'noteLink') {
      const row = entry.row as CanonicalNoteLink;
      if (liveNotes.has(row.noteId) && liveLinks.has(row.linkId)) continue;
      entries.set(key, await tombstoneFrom(entry, deviceId, at));
      repaired += 1;
    }
  }
  return repaired;
}

/**
 * Tags are the documented exception to "identity is the id": a tag's name is
 * its whole meaning. Two devices that independently created `#rust` should end
 * up with one tag, not two. The winner is the lowest id, and relations are
 * rewritten so no link loses its tag.
 */
async function dedupeTags(
  entries: Map<string, SyncEntry>,
  deviceId: string,
  at: number,
): Promise<number> {
  const byName = new Map<string, string[]>();
  for (const [id, row] of collectLive(entries, 'tag')) {
    const name = (row as { name: string }).name;
    const list = byName.get(name) ?? [];
    list.push(id);
    byName.set(name, list);
  }

  let changed = 0;
  for (const ids of byName.values()) {
    if (ids.length < 2) continue;
    ids.sort();
    const winner = ids[0] as string;
    const losers = new Set(ids.slice(1));
    for (const loser of losers) {
      const key = entityKey('tag', loser);
      const entry = entries.get(key);
      if (entry) entries.set(key, await tombstoneFrom(entry, deviceId, at));
      changed += 1;
      for (const [relationKey, relation] of [...entries]) {
        if (relation.deleted || relation.kind !== 'linkTag' || !relation.row) continue;
        const row = relation.row as { linkId: string; tagId: string };
        if (row.tagId !== loser) continue;
        const nextKey = entityKey('linkTag', linkTagId(row.linkId, winner));
        const duplicate = entries.get(nextKey);
        entries.delete(relationKey);
        if (duplicate && !duplicate.deleted) {
          // The link already carries the winning tag; the loser's relation is
          // removed rather than materialised twice.
          entries.set(relationKey, await tombstoneFrom(relation, deviceId, at));
        } else {
          entries.set(nextKey, {
            kind: 'linkTag',
            id: linkTagId(row.linkId, winner),
            rev: await revisionForRow('linkTag', { linkId: row.linkId, tagId: winner }, deviceId),
            row: { linkId: row.linkId, tagId: winner },
          });
        }
      }
    }
  }
  return changed;
}

async function tombstoneFrom(
  entry: SyncEntry,
  deviceId: string,
  at: number,
): Promise<SyncEntry> {
  return {
    kind: entry.kind,
    id: entry.id,
    rev: await revisionForTombstone(entry, at, deviceId),
    deleted: true,
    deletedAt: at,
  };
}

/** Replace a row's fields and give it a revision that reflects the new content. */
async function replaceRow(
  entries: Map<string, SyncEntry>,
  kind: EntityKind,
  id: string,
  patch: Record<string, unknown>,
  deviceId: string,
): Promise<void> {
  const key = entityKey(kind, id);
  const entry = entries.get(key);
  if (!entry || entry.deleted || !entry.row) return;
  if (Object.entries(patch).every(([field, value]) => (entry.row as Record<string, unknown>)[field] === value)) {
    return;
  }
  const row = { ...entry.row, ...patch } as CanonicalRow;
  entries.set(key, { kind, id, rev: await revisionForRow(kind, row, deviceId), row });
}
