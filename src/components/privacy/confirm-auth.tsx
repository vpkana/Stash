'use client';

import * as React from 'react';
import { Fingerprint, Loader2, ShieldCheck } from '@/components/ui/icons';
import { devicePromptName, devicePromptTitle } from '@/lib/privacy/auth';
import { usePrivacyStore } from '@/stores/privacy-store';
import { Button } from '@/components/ui/button';

/**
 * Prove it is you, inline, before something irreversible.
 *
 * Erasing the vault, restoring a backup over it and destroying the lock are the
 * three acts in Stash that cannot be undone, and none of them may be one
 * unauthenticated tap — not on a phone someone else is holding, and not in a
 * browser tab left open on a shared machine. This component is the same proof the
 * lock gate asks for, in a smaller shape: the device's own prompt, because that
 * is the only credential Stash has ever accepted. There is nothing else to offer,
 * and that is the point rather than a gap — the app has no password of its own to
 * fall back on.
 *
 * It is deliberately not a dialog of its own. It renders where the danger is — in
 * the card that describes the act — so the sentence being agreed to and the
 * button proving it are visible at the same time, and there is no chance of the
 * warning and the confirmation being on two different screens.
 *
 * Nothing here *performs* the act: it calls {@link ConfirmAuthProps.onAuthorized}
 * and the caller does the thing. That keeps the destructive code in one place per
 * feature instead of behind a generic "confirm" that could be pointed at anything.
 */
export interface ConfirmAuthProps {
  /** Sentence shown to the OS prompt, e.g. "Erase your Stash vault". */
  reason: string;
  /** Button label once the proof is in hand, e.g. "Erase vault". */
  confirmLabel: string;
  /** Runs only after a successful proof. */
  onAuthorized: () => void | Promise<void>;
  onCancel: () => void;
  /** `danger` styles the confirming button for an act that destroys data. */
  tone?: 'danger' | 'default';
  /** Blocks the confirming button for a caller-side precondition (a switch, a tick). */
  disabled?: boolean;
  /** Extra sentence above the fields. */
  hint?: React.ReactNode;
}

export function ConfirmAuth({
  reason,
  confirmLabel,
  onAuthorized,
  onCancel,
  tone = 'default',
  disabled = false,
  hint,
}: ConfirmAuthProps) {
  const deviceAuthAvailable = usePrivacyStore((state) => state.deviceAuthAvailable);
  const deviceUnlockReady = usePrivacyStore((state) => state.deviceUnlockReady);
  const deviceStoreKind = usePrivacyStore((state) => state.deviceStoreKind);
  const busy = usePrivacyStore((state) => state.busy);
  const authorize = usePrivacyStore((state) => state.authorize);

  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);

  const devicePath = deviceAuthAvailable && deviceUnlockReady;
  const working = busy || running;

  const run = React.useCallback(async () => {
    setError(null);
    setRunning(true);
    const result = await authorize(reason);
    if (!result.ok) {
      setRunning(false);
      setError(result.message ?? 'That did not succeed.');
      return;
    }
    await onAuthorized();
    setRunning(false);
  }, [authorize, onAuthorized, reason]);

  return (
    <div className="mt-3 flex flex-col gap-2.5">
      {hint ? <div className="text-meta leading-relaxed text-fg/85">{hint}</div> : null}

      {devicePath ? (
        <Button
          variant={tone === 'danger' ? 'danger' : 'accentSoft'}
          className="w-full"
          disabled={working || disabled}
          onClick={() => void run()}
        >
          {working ? (
            <Loader2 size={18} strokeWidth={2.2} className="animate-spin" aria-hidden />
          ) : (
            <Fingerprint size={18} strokeWidth={1.9} aria-hidden />
          )}
          {confirmLabel} with {devicePromptTitle(deviceStoreKind)}
        </Button>
      ) : null}

      {/*
        * No second way to prove it, and the sentence says why rather than leaving
        * the user to guess. Stash verifying anything itself — a password, a hash,
        * a pattern it drew — would be exactly the substitute this whole design
        * exists to remove.
        */}
      {!devicePath ? (
        <p className="text-meta leading-relaxed text-danger">
          This device cannot ask for an unlock, so this cannot be authorised here. Set up {devicePromptName(deviceStoreKind)}{' '}
          in your device settings and try again — nothing has been changed.
        </p>
      ) : null}

      {error ? (
        <p className="text-meta leading-relaxed text-danger" role="status">
          {error}
        </p>
      ) : null}

      <Button variant="ghost" className="w-full" disabled={working} onClick={onCancel}>
        <ShieldCheck size={17} strokeWidth={1.9} aria-hidden />
        Cancel
      </Button>
    </div>
  );
}
