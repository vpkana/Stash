'use client';

import { create } from 'zustand';
import { countPendingChanges } from '@/lib/sync/pending';
import { createGoogleAuthSession, type GoogleAccount, type GoogleAuthSession } from '@/lib/sync/google-auth';
import { GoogleDriveTransport } from '@/lib/sync/google-drive';
import { runSyncNow, type SyncOutcome } from '@/lib/sync/engine';
import { SyncTransportError, type SyncTransport } from '@/lib/sync/transport';
import {
  countSyncConflicts,
  eraseSyncState,
  readLastSuccessAt,
  readSyncAccount,
  readSyncMeta,
  readSyncConflicts,
  resetSyncBookkeeping,
  writeSyncMeta,
} from '@/db/repos/sync';
import {
  resolveConflict,
  type ConflictChoice,
  type ResolveConflictResult,
} from '@/db/repos/sync-conflicts';
import type { SyncAccount, SyncConflictRow, SyncErrorInfo } from '@/db/sync-types';
import { hasRecoveryKey, recoveryFingerprint } from '@/lib/privacy/recovery';
import { adoptRecoveryKey, createRecoveryKey } from '@/lib/privacy/recovery';
import { uploadRecoveryKeyring } from '@/lib/privacy/recovery';
import type { RecoveryAdoptResult, RecoverySetupResult } from '@/lib/privacy/recovery';
import { useVaultStore } from './vault-store';
import { usePrivacyStore } from './privacy-store';

/**
 * Sync, as the rest of the app sees it.
 *
 * The rules this file exists to keep:
 *
 *  - local is the source of truth. A sync is a *read of the vault*, a merge in
 *    memory, and a transactional apply. Nothing here replaces the database;
 *  - automatic work is bounded. It happens after startup, on resume, and after a
 *    local edit has settled — never in a tight loop, never while the app is in
 *    the background, and never indefinitely after a failure;
 *  - a dropped connection is not an error state to shout about. Being offline is
 *    normal for this app, and the UI says "will sync when online" rather than
 *    showing a failure;
 *  - credentials never enter this store's persisted state. The auth session keeps
 *    the access token in memory, and on Android the refresh token lives only in
 *    platform secure storage.
 *
 * The scheduler lives here rather than in a component so that a remount cannot
 * produce a second timer, and so `syncNow` has one implementation whether it was
 * tapped or timed.
 */

const AUTO_DEBOUNCE_MS = 2_500;
const STARTUP_DELAY_MS = 1_500;
const RESUME_DELAY_MS = 900;
const MAX_AUTO_RETRIES = 5;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 5 * 60_000;
const SETTLE_MS = 8_000;

export type SyncPhase =
  | 'disconnected'
  | 'idle'
  | 'syncing'
  | 'success'
  | 'offline'
  | 'auth-required'
  | 'error';

export interface ConnectResult {
  ok: boolean;
  message?: string;
  switched?: boolean;
}

export interface SyncState {
  ready: boolean;
  connected: boolean;
  account: SyncAccount | null;
  autoSync: boolean;
  phase: SyncPhase;
  syncing: boolean;
  connecting: boolean;
  pendingChanges: number;
  conflicts: SyncConflictRow[];
  lastSuccessAt: number | null;
  lastError: SyncErrorInfo | null;
  /** One line describing the last completed sync. Never contains vault content. */
  lastSummary: string | null;
  recoverySet: boolean;
  recoveryKeyFingerprint: string | null;

  initialize: () => Promise<void>;
  /** Re-read bookkeeping and pending counts. Safe to call often. */
  refresh: () => Promise<void>;
  connect: () => Promise<ConnectResult>;
  disconnect: () => Promise<void>;
  syncNow: () => Promise<SyncOutcome | null>;
  setAutoSync: (enabled: boolean) => Promise<void>;
  resolve: (id: string, choice: ConflictChoice) => Promise<ResolveConflictResult>;
  createRecovery: () => Promise<RecoverySetupResult>;
  adoptRecovery: (key: string) => Promise<RecoveryAdoptResult>;
  /** A local edit settled; debounce a sync if there is anything to publish. */
  noteLocalChange: () => void;
  /** The app became visible/active again. */
  handleResume: () => void;
  handleOnline: () => void;
  /** The vault was erased. Forget sync configuration and revoke the grant. */
  resetAfterErase: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Module-level runtime
//
// One session, one transport, at most one pending timer of each kind. None of
// this is React state; it must survive a component remount untouched.
// ---------------------------------------------------------------------------

let session: GoogleAuthSession | null = null;
let transport: SyncTransport | null = null;
let autoTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function authSession(): GoogleAuthSession {
  if (!session) session = createGoogleAuthSession();
  return session;
}

function syncTransport(): SyncTransport {
  if (!transport) transport = new GoogleDriveTransport(authSession());
  return transport;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

function clearScheduledWork(): void {
  autoTimer = clearTimer(autoTimer);
  retryTimer = clearTimer(retryTimer);
  settleTimer = clearTimer(settleTimer);
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function errorInfo(
  code: SyncErrorInfo['code'],
  message: string,
  retryable: boolean,
): SyncErrorInfo {
  return { code, message, at: Date.now(), retryable };
}

function fromThrown(error: unknown, fallback: string): SyncErrorInfo {
  if (error instanceof SyncTransportError) {
    return errorInfo(error.code, error.message, error.retryable);
  }
  return errorInfo('internal', fallback, true);
}

function authErrorCodes(code: SyncErrorInfo['code']): boolean {
  return (
    code === 'auth-required' ||
    code === 'auth-revoked' ||
    code === 'auth-cancelled' ||
    code === 'missing-config'
  );
}

function summaryFor(outcome: SyncOutcome): string {
  if (outcome.busy) return 'Another Stash window is syncing.';
  const parts: string[] = [];
  if (outcome.uploadedEntries > 0) parts.push(`sent ${outcome.uploadedEntries}`);
  if (outcome.downloadedChunks > 0) parts.push('received changes');
  if (outcome.appliedChanges > 0) parts.push(`updated ${outcome.appliedChanges} local ${outcome.appliedChanges === 1 ? 'item' : 'items'}`);
  if (outcome.conflicts > 0) parts.push(`${outcome.conflicts} ${outcome.conflicts === 1 ? 'conflict needs' : 'conflicts need'} review`);
  if (parts.length === 0) return 'Everything is up to date.';
  const sentence = parts.join(', ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** A sanitised account for the UI: email and name, never a token or subject id. */
function displayAccount(account: GoogleAccount): SyncAccount {
  const value: SyncAccount = { sub: account.sub, email: account.email };
  if (account.name) value.name = account.name;
  return value;
}

async function readOverview(): Promise<{
  connected: boolean;
  account: SyncAccount | null;
  autoSync: boolean;
  lastSuccessAt: number | null;
  conflicts: SyncConflictRow[];
  pendingChanges: number;
  recoverySet: boolean;
  recoveryKeyFingerprint: string | null;
}> {
  const [connected, account, autoRaw, lastSuccessAt, conflicts, pendingChanges, recovery, fingerprint] =
    await Promise.all([
      readSyncMeta<boolean>('connected'),
      readSyncAccount(),
      readSyncMeta<boolean>('autoSync'),
      readLastSuccessAt(),
      readSyncConflicts(),
      countPendingChanges().catch(() => 0),
      hasRecoveryKey().catch(() => false),
      recoveryFingerprint().catch(() => null),
    ]);
  return {
    connected: connected === true,
    account,
    autoSync: autoRaw !== false,
    lastSuccessAt,
    conflicts,
    pendingChanges,
    recoverySet: recovery,
    recoveryKeyFingerprint: fingerprint,
  };
}

export const useSyncStore = create<SyncState>((set, get) => {
  /**
   * Schedule an automatic sync, replacing any earlier request.
   *
   * `requirePending` is the distinction between the two reasons to sync:
   * after a local edit there is no point asking Drive if nothing actually
   * changed (and that check is what stops a sync's own refresh from scheduling
   * another sync), while startup, resume and reconnecting to the network must
   * still run to *pull* changes made elsewhere.
   */
  const scheduleAuto = (delay: number, requirePending = false): void => {
    if (!get().connected || !get().autoSync) return;
    if (isHidden()) return;
    autoTimer = clearTimer(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      const state = get();
      if (!state.connected || !state.autoSync || isHidden()) return;
      if (state.syncing) {
        scheduleAuto(3_000, requirePending);
        return;
      }
      void (async () => {
        if (requirePending) {
          await get().refresh();
          if (get().pendingChanges === 0) return;
        }
        await get().syncNow();
      })();
    }, delay);
  };

  const scheduleRetry = (): void => {
    if (!get().connected || !get().autoSync || retryAttempt >= MAX_AUTO_RETRIES) return;
    retryAttempt += 1;
    const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (retryAttempt - 1));
    // Jitter so several devices resuming together do not hit Drive in lockstep.
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    retryTimer = clearTimer(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!get().connected || !get().autoSync) return;
      if (isHidden()) return;
      void get().syncNow();
    }, delay);
  };

  const settle = (): void => {
    settleTimer = clearTimer(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (get().phase === 'success') set({ phase: 'idle' });
    }, SETTLE_MS);
  };

  const finishWithError = async (info: SyncErrorInfo): Promise<void> => {
    set({ lastError: info, lastSummary: null });
    if (authErrorCodes(info.code)) {
      set({ phase: 'auth-required' });
      return;
    }
    set({ phase: info.code === 'offline' ? 'offline' : 'error' });
    if (info.retryable) scheduleRetry();
  };

  return {
    ready: false,
    connected: false,
    account: null,
    autoSync: true,
    phase: 'disconnected',
    syncing: false,
    connecting: false,
    pendingChanges: 0,
    conflicts: [],
    lastSuccessAt: null,
    lastError: null,
    lastSummary: null,
    recoverySet: false,
    recoveryKeyFingerprint: null,

    initialize: async () => {
      if (get().ready) return;
      try {
        const overview = await readOverview();
        set({
          ready: true,
          ...overview,
          phase: overview.connected ? 'idle' : 'disconnected',
        });
        if (overview.connected && overview.autoSync) {
          // Startup is a pull opportunity even when nothing changed locally.
          scheduleAuto(STARTUP_DELAY_MS);
        }
      } catch {
        // Sync bookkeeping being unreadable must not stop the local vault from
        // working; the settings screen will offer Connect from a clean state.
        set({ ready: true, phase: 'idle' });
      }
    },

    refresh: async () => {
      try {
        const overview = await readOverview();
        set((state) => ({
          ...overview,
          phase:
            state.syncing
              ? 'syncing'
              : overview.connected
                ? state.phase === 'success' || state.phase === 'error' || state.phase === 'offline' || state.phase === 'auth-required'
                  ? state.phase
                  : 'idle'
                : 'disconnected',
        }));
      } catch {
        /* keep the last known overview */
      }
    },

    connect: async () => {
      if (get().connecting || get().syncing) {
        return { ok: false, message: 'A sync is already running.' };
      }
      set({ connecting: true, lastError: null, lastSummary: null });
      try {
        const account = displayAccount(await authSession().connect());
        const previous = get().account;
        const switched = Boolean(previous && previous.sub !== account.sub);

        if (switched) {
          // Never carry one account's checkpoints into another: the new account
          // has never seen these entities, and a stale tombstone could delete a
          // row there. The vault itself is untouched and is uploaded as new work.
          await resetSyncBookkeeping();
        }

        await writeSyncMeta('account', account);
        await writeSyncMeta('connected', true);
        if ((await readSyncMeta<boolean>('autoSync')) === undefined) {
          await writeSyncMeta('autoSync', true);
        }

        retryAttempt = 0;
        set({
          connected: true,
          account,
          autoSync: (await readSyncMeta<boolean>('autoSync')) !== false,
          phase: 'idle',
          conflicts: switched ? [] : get().conflicts,
          lastSuccessAt: switched ? null : get().lastSuccessAt,
        });
        await get().refresh();

        const outcome = await get().syncNow();
        const message = switched
          ? `Connected as ${account.email}. Sync history was reset for this account; this device’s vault will be uploaded.`
          : outcome?.ok
            ? `Connected as ${account.email}. ${summaryFor(outcome)}`
            : `Connected as ${account.email}. ${outcome?.error?.message ?? 'The first sync did not finish; Sync now will retry.'}`;
        return { ok: true, message, switched };
      } catch (error) {
        const info = fromThrown(error, 'Could not connect to Google Drive.');
        await writeSyncMeta('lastError', info).catch(() => undefined);
        set({ connecting: false, lastError: info, phase: 'auth-required' });
        return { ok: false, message: info.message };
      } finally {
        set({ connecting: false });
      }
    },

    disconnect: async () => {
      if (get().syncing) return;
      clearScheduledWork();
      retryAttempt = 0;
      await authSession().disconnect().catch(() => undefined);
      await writeSyncMeta('connected', false).catch(() => undefined);
      set({
        connected: false,
        phase: 'disconnected',
        syncing: false,
        lastSummary: 'Disconnected. Your vault stays on this device.',
        lastError: null,
      });
    },

    syncNow: async () => {
      if (!get().connected) return null;
      if (get().syncing) return null;
      if (isOffline()) {
        await finishWithError(
          errorInfo('offline', 'You are offline. Stash will sync when the connection returns.', true),
        );
        return null;
      }

      autoTimer = clearTimer(autoTimer);
      settleTimer = clearTimer(settleTimer);
      set({ syncing: true, phase: 'syncing' });
      let outcome: SyncOutcome | null = null;

      try {
        const auth = authSession();
        try {
          await auth.accessToken();
        } catch (error) {
          const info = fromThrown(error, 'Google sign-in needs your attention.');
          await writeSyncMeta('lastError', info).catch(() => undefined);
          await finishWithError(info);
          return null;
        }

        // A token is not proof of *which* account. Verify before writing, so a
        // Google account switched outside Stash can never receive this vault's
        // changes by accident.
        const signedIn = await auth.silentAccount().catch(() => null);
        if (!signedIn) {
          const info = errorInfo(
            'network',
            'Could not confirm the signed-in Google account. Will retry.',
            true,
          );
          await writeSyncMeta('lastError', info).catch(() => undefined);
          await finishWithError(info);
          return null;
        }
        const expected = get().account;
        if (expected && signedIn.sub !== expected.sub) {
          const info = errorInfo(
            'auth-required',
            'The Google account signed in has changed. Use Connect to choose the account to sync with.',
            false,
          );
          await writeSyncMeta('lastError', info).catch(() => undefined);
          await finishWithError(info);
          return null;
        }

        outcome = await runSyncNow(syncTransport());
        if (outcome.ok) {
          retryAttempt = 0;
          const summary = summaryFor(outcome);
          await get().refresh();
          if (useVaultStore.getState().status === 'ready') {
            // Applying a remote change is a database write like any other; the
            // local-change debounce sees it and the pending check keeps it from
            // bouncing back as an upload.
            await useVaultStore.getState().refresh();
          }
          await get().refresh();
          set({ phase: 'success', lastSummary: summary, lastError: null });
          settle();
        } else if (outcome.busy) {
          set({ phase: 'idle', lastSummary: summaryFor(outcome) });
        } else {
          const info = outcome.error ?? errorInfo('internal', 'Sync did not finish.', true);
          await finishWithError(info);
        }
        return outcome;
      } catch (error) {
        const info = fromThrown(error, 'Sync stopped because of an unexpected error.');
        await writeSyncMeta('lastError', info).catch(() => undefined);
        await finishWithError(info);
        return null;
      } finally {
        set({ syncing: false });
      }
    },

    setAutoSync: async (enabled) => {
      await writeSyncMeta('autoSync', enabled);
      set({ autoSync: enabled });
      if (!enabled) {
        clearScheduledWork();
      } else if (get().connected) {
        scheduleAuto(RESUME_DELAY_MS);
      }
    },

    resolve: async (id, choice) => {
      const result = await resolveConflict(id, choice);
      if (result.ok) {
        await get().refresh();
        if (useVaultStore.getState().status === 'ready') await useVaultStore.getState().refresh();
      }
      return result;
    },

    createRecovery: async () => {
      const result = await createRecoveryKey();
      if (!result.ok) return result;
      // Publishing immediately means a second device can adopt it without
      // waiting for the next scheduled sync. Failure is not fatal: the engine
      // uploads the keyring at the end of every successful sync.
      if (get().connected) {
        try {
          await uploadRecoveryKeyring(syncTransport());
        } catch {
          /* next sync retries */
        }
      }
      await get().refresh();
      return result;
    },

    adoptRecovery: async (key) => {
      if (!get().connected) {
        return {
          ok: false,
          message: 'Connect to Google Drive first, then enter the recovery key.',
        };
      }
      try {
        const result = await adoptRecoveryKey(syncTransport(), key);
        if (result.ok) {
          // The keyring changed underneath the privacy store; reload it so the
          // session key, the locked rows and the vault snapshot agree.
          await usePrivacyStore.getState().reload();
          if (useVaultStore.getState().status === 'ready') await useVaultStore.getState().refresh();
          await get().refresh();
        }
        return result;
      } catch (error) {
        const info = fromThrown(error, 'Could not read the recovery file from Google Drive.');
        return { ok: false, message: info.message };
      }
    },

    noteLocalChange: () => {
      if (!get().ready || !get().connected || !get().autoSync) return;
      scheduleAuto(AUTO_DEBOUNCE_MS, true);
    },

    handleResume: () => {
      if (!get().ready || !get().connected || !get().autoSync) return;
      if (isHidden()) return;
      retryAttempt = 0;
      retryTimer = clearTimer(retryTimer);
      scheduleAuto(RESUME_DELAY_MS);
    },

    handleOnline: () => {
      if (!get().ready || !get().connected || !get().autoSync) return;
      if (isHidden()) return;
      retryAttempt = 0;
      retryTimer = clearTimer(retryTimer);
      scheduleAuto(RESUME_DELAY_MS);
    },

    resetAfterErase: async () => {
      clearScheduledWork();
      retryAttempt = 0;
      await authSession().disconnect().catch(() => undefined);
      await eraseSyncState().catch(() => undefined);
      set({
        ready: true,
        connected: false,
        account: null,
        autoSync: true,
        phase: 'disconnected',
        syncing: false,
        connecting: false,
        pendingChanges: 0,
        conflicts: [],
        lastSuccessAt: null,
        lastError: null,
        lastSummary: null,
        recoverySet: false,
        recoveryKeyFingerprint: null,
      });
    },
  };
});

/**
 * Test seam: drop the cached session/transport and any pending timers.
 * Never called by app code.
 */
export function resetSyncStoreForTests(): void {
  clearScheduledWork();
  session = null;
  transport = null;
  retryAttempt = 0;
  useSyncStore.setState({
    ready: false,
    connected: false,
    account: null,
    autoSync: true,
    phase: 'disconnected',
    syncing: false,
    connecting: false,
    pendingChanges: 0,
    conflicts: [],
    lastSuccessAt: null,
    lastError: null,
    lastSummary: null,
    recoverySet: false,
    recoveryKeyFingerprint: null,
  });
}

export { countSyncConflicts };
