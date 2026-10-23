'use client';

import * as React from 'react';
import {
  AlertTriangle,
  ChevronRight,
  CloudArrowUp,
  CloudCheck,
  CloudSlash,
  Key,
  RefreshCw,
  Shield,
  SignOut,
} from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Section } from '@/components/ui/page';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { formatRelative, pluralize } from '@/lib/format';
import { useSyncStore } from '@/stores/sync-store';
import { cn } from '@/lib/utils';
import { ConflictDialog } from './conflict-dialog';
import { RecoveryDialog, type RecoveryMode } from './recovery-dialog';

/**
 * Google Drive sync, in settings.
 *
 * Two things are deliberately stated on this screen rather than left to a
 * privacy page: the permission is the narrow app-data one (Stash can only read
 * and write files it created), and the copy in Drive is the same vault — locked
 * items are uploaded as ciphertext, and signing in to Google never opens one.
 *
 * Everything here is optional. A vault that never connects behaves exactly as it
 * did before sync existed, which is why "Not connected" is a neutral state and
 * not a warning.
 */
export function SyncSettings() {
  const ready = useSyncStore((state) => state.ready);
  const connected = useSyncStore((state) => state.connected);
  const account = useSyncStore((state) => state.account);
  const autoSync = useSyncStore((state) => state.autoSync);
  const phase = useSyncStore((state) => state.phase);
  const syncing = useSyncStore((state) => state.syncing);
  const connecting = useSyncStore((state) => state.connecting);
  const pendingChanges = useSyncStore((state) => state.pendingChanges);
  const conflicts = useSyncStore((state) => state.conflicts);
  const lastSuccessAt = useSyncStore((state) => state.lastSuccessAt);
  const lastError = useSyncStore((state) => state.lastError);
  const lastSummary = useSyncStore((state) => state.lastSummary);
  const recoverySet = useSyncStore((state) => state.recoverySet);
  const recoveryKeyFingerprint = useSyncStore((state) => state.recoveryKeyFingerprint);

  const refresh = useSyncStore((state) => state.refresh);
  const connect = useSyncStore((state) => state.connect);
  const disconnect = useSyncStore((state) => state.disconnect);
  const syncNow = useSyncStore((state) => state.syncNow);
  const setAutoSync = useSyncStore((state) => state.setAutoSync);

  const [conflictsOpen, setConflictsOpen] = React.useState(false);
  const [recoveryOpen, setRecoveryOpen] = React.useState(false);
  const [recoveryMode, setRecoveryMode] = React.useState<RecoveryMode>('create');
  const [switchOpen, setSwitchOpen] = React.useState(false);

  // The runtime initialises at boot; this picks up anything that changed while
  // settings was closed, without starting a second scheduler.
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!ready) return null;

  const runConnect = async () => {
    const result = await connect();
    setSwitchOpen(false);
    if (!result.ok) {
      toast(result.message ?? 'Could not connect to Google Drive.', { tone: 'danger' });
      return;
    }
    toast(result.message ?? 'Connected to Google Drive.', { tone: 'success' });
  };

  const runDisconnect = async () => {
    await disconnect();
    toast('Disconnected. Your vault stays on this device.', { tone: 'success' });
  };

  const runSync = async () => {
    const outcome = await syncNow();
    if (!outcome) return;
    if (outcome.ok) {
      toast(outcome.noop ? 'Everything is up to date.' : 'Sync complete.', { tone: 'success' });
    } else if (!outcome.busy) {
      toast(outcome.error?.message ?? 'Sync did not finish.', { tone: 'danger' });
    }
  };

  const openRecovery = (mode: RecoveryMode) => {
    setRecoveryMode(mode);
    setRecoveryOpen(true);
  };

  const status = statusFor({
    connected,
    phase,
    syncing,
    connecting,
    lastSummary,
    lastError,
    lastSuccessAt,
  });

  return (
    <>
      <Section title="Google Drive sync">
        <div className="mx-4 overflow-hidden card">
          <div className="flex items-start justify-between gap-3 px-4 py-3.5">
            <div className="flex min-w-0 items-start gap-2.5">
              <StatusIcon connected={connected} phase={phase} syncing={syncing || connecting} />
              <div className="min-w-0">
                <p className="text-row font-medium text-fg">
                  {connected ? account?.name?.trim() || 'Google Drive' : 'Not connected'}
                </p>
                <p className="mt-0.5 truncate text-meta text-subtle">
                  {connected && account?.email
                    ? account.email
                    : 'Optional. Stash works fully offline without it.'}
                </p>
              </div>
            </div>
            {connected ? (
              <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-meta font-medium text-accent">
                Connected
              </span>
            ) : null}
          </div>

          {!connected ? (
            <div className="flex flex-col gap-2.5 border-t border-border px-3 py-3">
              <p className="px-0.5 text-meta leading-relaxed text-subtle">
                Sync this device with the Android app through Google Drive’s private app-data folder. Stash uses
                the narrow <span className="font-medium text-fg">drive.appdata</span> permission: it can read and
                write only the files it created, never the rest of your Drive.
              </p>
              <Button
                variant="accentSoft"
                className="w-full"
                disabled={connecting}
                onClick={() => void runConnect()}
              >
                <CloudArrowUp size={18} strokeWidth={1.9} aria-hidden />
                {connecting ? 'Connecting…' : 'Connect Google Drive'}
              </Button>
              {lastError ? (
                <p className="px-0.5 text-meta leading-relaxed text-danger" role="status">
                  {lastError.message}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="border-t border-border px-4 py-3">
                <p
                  className={cn(
                    'text-meta leading-relaxed',
                    status.tone === 'danger'
                      ? 'text-danger'
                      : status.tone === 'warning'
                        ? 'text-warning'
                        : 'text-muted',
                  )}
                  role="status"
                >
                  {status.text}
                </p>
                <p className="mt-1 text-meta text-subtle">
                  {lastSuccessAt
                    ? `Last synced ${formatRelative(lastSuccessAt)}`
                    : 'No completed sync yet'}
                  {pendingChanges > 0
                    ? ` · ${pluralize(pendingChanges, 'change')} waiting`
                    : ' · nothing waiting to send'}
                </p>

                <div className="mt-2.5 flex gap-2">
                  <Button
                    variant="surface"
                    className="flex-1"
                    disabled={syncing || connecting}
                    onClick={() => void runSync()}
                  >
                    <RefreshCw
                      size={17}
                      strokeWidth={1.9}
                      className={syncing ? 'animate-spin' : undefined}
                      aria-hidden
                    />
                    {syncing ? 'Syncing…' : 'Sync now'}
                  </Button>
                  {phase === 'auth-required' ? (
                    <Button
                      variant="accentSoft"
                      className="flex-1"
                      disabled={connecting || syncing}
                      onClick={() => void runConnect()}
                    >
                      Reconnect
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      disabled={syncing}
                      onClick={() => void runDisconnect()}
                    >
                      <SignOut size={17} strokeWidth={1.9} aria-hidden />
                      Disconnect
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex items-start justify-between gap-3 border-t border-border px-4 py-3">
                <div className="min-w-0">
                  <p className="text-row font-medium text-fg">Sync automatically</p>
                  <p className="mt-0.5 text-meta leading-relaxed text-subtle">
                    After startup, when you return to Stash and shortly after a change. It never runs while the
                    app is in the background.
                  </p>
                </div>
                <Switch
                  checked={autoSync}
                  onCheckedChange={(value) => void setAutoSync(value)}
                  aria-label="Sync automatically"
                />
              </div>

              {conflicts.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setConflictsOpen(true)}
                  className="tap flex w-full items-center gap-3 border-t border-border px-4 py-3 text-left active:bg-surface-2"
                >
                  <AlertTriangle size={17} strokeWidth={1.9} className="shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-row font-medium text-fg">
                      {pluralize(conflicts.length, 'change needs', 'changes need')} review
                    </span>
                    <span className="block text-meta text-subtle">
                      Both versions are kept until you choose.
                    </span>
                  </span>
                  <ChevronRight size={17} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
                </button>
              ) : null}

              <div className="border-t border-border px-4 py-3">
                <div className="flex items-start gap-2.5">
                  <Key
                    size={17}
                    strokeWidth={1.9}
                    className={cn('mt-0.5 shrink-0', recoverySet ? 'text-accent' : 'text-subtle')}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-row font-medium text-fg">
                      {recoverySet ? 'Recovery key set up' : 'No recovery key'}
                    </p>
                    <p className="mt-0.5 text-meta leading-relaxed text-subtle">
                      {recoverySet
                        ? `A copy wrapped by your key is in this Drive account${
                            recoveryKeyFingerprint
                              ? ` (${recoveryKeyFingerprint.slice(0, 8)}…)`
                              : ''
                          }. It lets another device install your vault key; it does not bypass the device prompt.`
                        : 'Without one, locked content stays unreadable on a new device or after this device’s secure storage is reset. Google sign-in alone cannot open it.'}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="surface" size="sm" onClick={() => openRecovery('create')}>
                        {recoverySet ? 'Create a new key' : 'Set up a key'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openRecovery('adopt')}>
                        Use a recovery key
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
                <p className="min-w-0 truncate text-meta text-subtle">
                  {account?.email ? `Signed in as ${account.email}` : 'Google Drive'}
                </p>
                <button
                  type="button"
                  onClick={() => setSwitchOpen(true)}
                  className="tap shrink-0 text-meta font-medium text-muted"
                >
                  Switch account
                </button>
              </div>

              {lastError ? (
                <details className="border-t border-border px-4 py-2.5">
                  <summary className="tap cursor-pointer text-meta text-subtle">Sync details</summary>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
                    <dt className="text-subtle">Last attempt</dt>
                    <dd className="text-muted">{formatRelative(lastError.at)}</dd>
                    <dt className="text-subtle">Reason</dt>
                    <dd className="font-mono text-muted">{lastError.code}</dd>
                    <dt className="text-subtle">Retry</dt>
                    <dd className="text-muted">
                      {lastError.retryable ? 'Automatic retry is scheduled' : 'Needs your attention'}
                    </dd>
                  </dl>
                </details>
              ) : null}
            </>
          )}
        </div>

        <p className="flex items-start gap-2 px-5 pt-2.5 text-meta leading-relaxed text-subtle">
          <Shield size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
          Your vault is never replaced by what is online: changes from this device and the other one are merged,
          and anything that disagrees is shown above instead of being picked silently. Locked items travel as
          ciphertext. Disconnecting revokes Stash’s access and leaves this device’s vault untouched.
        </p>
      </Section>

      <ConflictDialog open={conflictsOpen} onOpenChange={setConflictsOpen} />
      {/* Keyed so every opening starts from an empty form: a recovery key from a
          previous visit must not linger in state behind a closed dialog. */}
      <RecoveryDialog
        key={recoveryOpen ? `recovery-${recoveryMode}` : 'recovery-closed'}
        open={recoveryOpen}
        mode={recoveryMode}
        onOpenChange={setRecoveryOpen}
      />

      <Dialog open={switchOpen} onOpenChange={setSwitchOpen}>
        <DialogContent describedBy="switch-account-description">
          <DialogTitle>Use a different Google account?</DialogTitle>
          <DialogDescription id="switch-account-description">
            Your local vault stays exactly as it is. If you choose a different account, this device starts a
            fresh sync history for it and uploads your vault there. Nothing is deleted from the current account
            or from this device.
          </DialogDescription>
          <div className="mt-4 flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => setSwitchOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" className="flex-[1.3]" onClick={() => void runConnect()}>
              Choose account
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusIcon({
  connected,
  phase,
  syncing,
}: {
  connected: boolean;
  phase: ReturnType<typeof useSyncStore.getState>['phase'];
  syncing: boolean;
}) {
  if (syncing) {
    return <RefreshCw size={19} strokeWidth={1.9} className="mt-0.5 shrink-0 animate-spin text-accent" aria-hidden />;
  }
  if (!connected) {
    return <CloudSlash size={19} strokeWidth={1.9} className="mt-0.5 shrink-0 text-subtle" aria-hidden />;
  }
  if (phase === 'auth-required' || phase === 'error') {
    return <CloudSlash size={19} strokeWidth={1.9} className="mt-0.5 shrink-0 text-warning" aria-hidden />;
  }
  if (phase === 'offline') {
    return <CloudSlash size={19} strokeWidth={1.9} className="mt-0.5 shrink-0 text-muted" aria-hidden />;
  }
  return <CloudCheck size={19} strokeWidth={1.9} className="mt-0.5 shrink-0 text-success" aria-hidden />;
}

function statusFor({
  connected,
  phase,
  syncing,
  connecting,
  lastSummary,
  lastError,
  lastSuccessAt,
}: {
  connected: boolean;
  phase: ReturnType<typeof useSyncStore.getState>['phase'];
  syncing: boolean;
  connecting: boolean;
  lastSummary: string | null;
  lastError: ReturnType<typeof useSyncStore.getState>['lastError'];
  lastSuccessAt: number | null;
}): { text: string; tone: 'normal' | 'warning' | 'danger' } {
  if (connecting) return { text: 'Connecting to Google Drive…', tone: 'normal' };
  if (syncing) return { text: 'Syncing changes with your other devices…', tone: 'normal' };
  if (!connected) return { text: 'Not connected.', tone: 'normal' };
  if (phase === 'auth-required') {
    return {
      text: lastError?.message ?? 'Google sign-in needs your attention. Reconnect to continue syncing.',
      tone: 'danger',
    };
  }
  if (phase === 'offline') {
    return {
      text: lastError?.message ?? 'Offline. Changes will sync when you are back online.',
      tone: 'warning',
    };
  }
  if (phase === 'error') {
    return {
      text: lastError?.message ?? 'The last sync did not finish. Your local vault is unchanged.',
      tone: 'danger',
    };
  }
  if (phase === 'success' && lastSummary) return { text: lastSummary, tone: 'normal' };
  if (!lastSuccessAt) {
    return { text: 'Connected. The first sync has not completed yet.', tone: 'normal' };
  }
  return { text: 'Changes sync automatically. Nothing needs your attention.', tone: 'normal' };
}
