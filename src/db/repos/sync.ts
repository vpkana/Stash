import { db } from '@/db';
import { newId } from '@/db/id';
import {
  SYNC_META_KEYS,
  type SyncAccount,
  type SyncBaseRow,
  type SyncConflictRow,
  type SyncErrorInfo,
  type SyncPeerRow,
} from '@/db/sync-types';
import { entityKey } from '@/lib/sync/protocol';
import type { SyncEntry } from '@/lib/sync/protocol';

/**
 * Read/write helpers for the local sync bookkeeping.
 *
 * Deliberately thin: the atomic commit in `engine.ts` needs to compose these
 * writes inside one Dexie transaction, so the heavy logic stays there. Nothing in
 * this file touches vault content except the read helpers, which never mutate.
 */

export async function readSyncMeta<T>(key: keyof typeof SYNC_META_KEYS): Promise<T | undefined> {
  const row = await db.syncMeta.get(SYNC_META_KEYS[key]);
  return row?.value as T | undefined;
}

export async function writeSyncMeta(
  key: keyof typeof SYNC_META_KEYS,
  value: unknown,
): Promise<void> {
  await db.syncMeta.put({ key: SYNC_META_KEYS[key], value });
}

export async function deleteSyncMeta(key: keyof typeof SYNC_META_KEYS): Promise<void> {
  await db.syncMeta.delete(SYNC_META_KEYS[key]);
}

export async function readSyncBase(): Promise<Map<string, SyncEntry>> {
  const rows = await db.syncBase.toArray();
  return new Map(rows.map((row) => [row.key, row.entry]));
}

export async function readSyncPeers(): Promise<Map<string, SyncPeerRow>> {
  const rows = await db.syncPeers.toArray();
  return new Map(rows.map((row) => [row.deviceId, row]));
}

export async function readSyncConflicts(): Promise<SyncConflictRow[]> {
  return db.syncConflicts.orderBy('detectedAt').reverse().toArray();
}

export async function deleteSyncConflict(id: string): Promise<void> {
  await db.syncConflicts.delete(id);
}

export async function countSyncConflicts(): Promise<number> {
  return db.syncConflicts.count();
}

export async function isSyncConnected(): Promise<boolean> {
  return (await readSyncMeta<boolean>('connected')) === true;
}

export async function readSyncAccount(): Promise<SyncAccount | null> {
  return (await readSyncMeta<SyncAccount>('account')) ?? null;
}

export async function readLastSyncError(): Promise<SyncErrorInfo | null> {
  return (await readSyncMeta<SyncErrorInfo>('lastError')) ?? null;
}

export async function readLastSuccessAt(): Promise<number | null> {
  return (await readSyncMeta<number>('lastSuccessAt')) ?? null;
}

/**
 * The stable identity of this installation.
 *
 * Generated once and never derived from a device name, an account or a folder.
 * Two installs with the same name are still two devices; renaming one later
 * cannot change which change log is whose.
 */
export async function ensureDeviceIdentity(preferredName?: string): Promise<{
  deviceId: string;
  deviceName: string;
}> {
  let deviceId = await readSyncMeta<string>('deviceId');
  if (!deviceId) {
    deviceId = newId();
    await writeSyncMeta('deviceId', deviceId);
  }
  const name = preferredName?.trim() || (await readSyncMeta<string>('deviceName')) || defaultName(deviceId);
  await writeSyncMeta('deviceName', name);
  return { deviceId, deviceName: name };
}

function defaultName(deviceId: string): string {
  const android =
    typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent ?? '');
  const platform = android ? 'Android app' : 'Web app';
  return `${platform} · ${deviceId.slice(0, 6)}`;
}

/**
 * Forget everything that describes a *sync history*, keeping the device identity
 * and the vault itself.
 *
 * Used when the signed-in Google account changes. Uploading the old account's
 * base/checkpoints into a new account would make the new account look like it
 * already contains entities it has never seen, and — worse — could upload a
 * tombstone into a fresh account for a row that only ever existed here. Starting
 * the bookkeeping clean means the local vault is treated as new work for the new
 * account, which is the safe, explainable behaviour.
 */
export async function resetSyncBookkeeping(): Promise<void> {
  await db.transaction('rw', db.syncBase, db.syncPeers, db.syncConflicts, db.syncMeta, async () => {
    await db.syncBase.clear();
    await db.syncPeers.clear();
    await db.syncConflicts.clear();
    const clearKeys = [
      'lastSuccessAt',
      'lastAttemptAt',
      'lastError',
      'lastResult',
      'ownSeq',
      'ownRevision',
      'ownFileId',
      'pendingCount',
      'lastKeyringFingerprint',
    ] as const;
    for (const key of clearKeys) await deleteSyncMeta(key);
  });
}

/** Erase sync configuration and history. The caller separately erases the vault. */
export async function eraseSyncState(): Promise<void> {
  await db.transaction(
    'rw',
    db.syncBase,
    db.syncPeers,
    db.syncConflicts,
    db.syncMeta,
    async () => {
      await db.syncBase.clear();
      await db.syncPeers.clear();
      await db.syncConflicts.clear();
      await db.syncMeta.clear();
    },
  );
}

export function baseRow(entry: SyncEntry, at: number): SyncBaseRow {
  return {
    key: entityKey(entry.kind, entry.id),
    kind: entry.kind,
    entityId: entry.id,
    entry,
    updatedAt: at,
  };
}
