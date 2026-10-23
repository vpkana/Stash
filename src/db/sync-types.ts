import type { ConflictReason, EntityKind, SyncEntry } from '@/lib/sync/protocol';

/**
 * Local sync bookkeeping.
 *
 * These tables live beside the vault and are erased with it. They are *not*
 * synced: `syncBase` is this device's common ancestor, `syncPeers` is what this
 * device has consumed, and `syncConflicts` is review material that only the
 * person at this device can resolve.
 */

export interface SyncBaseRow {
  /** `${kind}:${id}`, the same key used on the wire. */
  key: string;
  kind: EntityKind;
  entityId: string;
  entry: SyncEntry;
  updatedAt: number;
}

export interface SyncPeerRow {
  deviceId: string;
  deviceName: string;
  /** Highest manifest revision consumed from this device. */
  revision: number;
  /** Highest chunk sequence consumed. */
  lastSeq: number;
  updatedAt: number;
}

export interface SyncConflictRow {
  id: string;
  kind: EntityKind;
  entityId: string;
  reason: ConflictReason;
  label: string;
  detectedAt: number;
  local?: SyncEntry;
  remote?: SyncEntry;
  fields?: string[];
  copyId?: string;
}

export interface SyncAccount {
  /** Google's stable subject id. The email is a display detail, not identity. */
  sub: string;
  email: string;
  name?: string;
}

export interface SyncErrorInfo {
  code:
    | 'offline'
    | 'auth-cancelled'
    | 'auth-required'
    | 'auth-revoked'
    | 'missing-config'
    | 'quota'
    | 'rate-limited'
    | 'network'
    | 'remote-invalid'
    | 'schema-newer'
    | 'key-mismatch'
    | 'concurrent-change'
    | 'internal';
  /** Sanitised. Never contains tokens, note content, URLs or config. */
  message: string;
  at: number;
  retryable: boolean;
}

export const SYNC_META_KEYS = {
  deviceId: 'sync.deviceId',
  deviceName: 'sync.deviceName',
  account: 'sync.account',
  connected: 'sync.connected',
  autoSync: 'sync.autoSync',
  lastSuccessAt: 'sync.lastSuccessAt',
  lastAttemptAt: 'sync.lastAttemptAt',
  lastError: 'sync.lastError',
  lastResult: 'sync.lastResult',
  ownSeq: 'sync.ownSeq',
  ownRevision: 'sync.ownRevision',
  ownFileId: 'sync.ownFileId',
  pendingCount: 'sync.pendingCount',
  lastKeyringFingerprint: 'sync.keyringFingerprint',
} as const;

export type SyncMetaKey = (typeof SYNC_META_KEYS)[keyof typeof SYNC_META_KEYS];
