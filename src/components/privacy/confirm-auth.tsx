'use client';

import * as React from 'react';
import { Fingerprint, Loader2, ShieldCheck } from '@/components/ui/icons';
import { devicePromptTitle } from '@/lib/privacy/auth';
import { usePrivacyStore } from '@/stores/privacy-store';
import { Button } from '@/components/ui/button';
import { PasscodeInput } from './passcode-input';

/**
 * Prove it is you, inline, before something irreversible.
 *
 * Erasing the vault, restoring a backup over it and destroying the lock are the
 * three acts in Stash that cannot be undone, and none of them may be one
 * unauthenticated tap — not on a phone someone else is holding, and not in a
 * browser tab left open on a shared machine. This component is the same proof the
 * lock gate asks for, in a smaller shape: the device prompt when it is armed, and
 * the passcode otherwise, with the passcode always available as the answer even
 * when the device prompt is what is in front.
 *
 * It is deliberately not a dialog of its own. It renders where the danger is — in
 * the card that describes the act — so the sentence being agreed to and the field
 * proving it are visible at the same time, and there is no chance of the warning
 * and the confirmation being on two different screens.
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
  const passcodeSet = usePrivacyStore((state) => state.passcodeSet);
  const deviceAuthAvailable = usePrivacyStore((state) => state.deviceAuthAvailable);
  const deviceUnlockReady = usePrivacyStore((state) => state.deviceUnlockReady);
  const deviceStoreKind = usePrivacyStore((state) => state.deviceStoreKind);
  const busy = usePrivacyStore((state) => state.busy);
  const authorize = usePrivacyStore((state) => state.authorize);

  const [passcode, setPasscode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);

  const devicePath = deviceAuthAvailable && deviceUnlockReady;

  const run = React.useCallback(
    async (code: string) => {
      setError(null);
      setRunning(true);
      const result = await authorize(code, reason);
      if (!result.ok) {
        setRunning(false);
        setPasscode('');
        setError(result.message ?? 'That did not match.');
        return;
      }
      await onAuthorized();
      setRunning(false);
    },
    [authorize, onAuthorized, reason],
  );

  const working = busy || running;

  return (
    <div className="mt-3 flex flex-col gap-2.5">
      {hint ? <div className="text-meta leading-relaxed text-fg/85">{hint}</div> : null}

      {devicePath ? (
        <Button
          variant="accentSoft"
          className="w-full"
          disabled={working}
          onClick={() => void run('')}
        >
          {working ? (
            <Loader2 size={18} strokeWidth={2.2} className="animate-spin" aria-hidden />
          ) : (
            <Fingerprint size={18} strokeWidth={1.9} aria-hidden />
          )}
          Confirm with {devicePromptTitle(deviceStoreKind)}
        </Button>
      ) : null}

      {passcodeSet ? (
        <>
          <PasscodeInput
            label={devicePath ? 'Or your passcode' : 'Your passcode'}
            value={passcode}
            onChange={(value) => {
              setPasscode(value);
              setError(null);
            }}
            onSubmit={() => void run(passcode)}
            disabled={working}
            {...(error ? { tone: 'danger' as const, hint: error } : {})}
          />
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            className="w-full"
            disabled={working || disabled || passcode.length === 0}
            onClick={() => void run(passcode)}
          >
            {working ? (
              <Loader2 size={18} strokeWidth={2.2} className="animate-spin" aria-hidden />
            ) : (
              <ShieldCheck size={18} strokeWidth={1.9} aria-hidden />
            )}
            {confirmLabel}
          </Button>
        </>
      ) : null}

      {!devicePath && !passcodeSet ? (
        <p className="text-meta leading-relaxed text-danger">
          This vault has no passcode and no device prompt here, so this cannot be authorised on this device.
          You can still clear Stash&apos;s data from your device&apos;s own settings.
        </p>
      ) : null}

      {error && !passcodeSet ? (
        <p className="text-meta leading-relaxed text-danger" role="status">
          {error}
        </p>
      ) : null}

      <Button variant="ghost" className="w-full" disabled={working} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
