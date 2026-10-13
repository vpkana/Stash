'use client';

import * as React from 'react';
import { Key, Loader2, ShieldCheck } from '@/components/ui/icons';
import { MIN_PASSCODE_LENGTH, MIN_PASSCODE_MESSAGE } from '@/lib/privacy/keyring';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useCaptureStore } from '@/stores/capture-store';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { PasscodeInput } from './passcode-input';

/**
 * Ask for a passcode the first time Stash opens without one.
 *
 * Two facts make this screen worth interrupting for, and both are failures the
 * app had before it existed:
 *
 *  - **A passcode the user never chose is a passcode they will not remember.**
 *    Locking used to be something you found in Settings, which meant the folders
 *    people marked private were protected by a lock they had never been asked to
 *    plan for;
 *  - **Without a passcode, the only way in is the device prompt** — and the
 *    operating system can withdraw that (a fingerprint removed, a screen lock
 *    switched off, an enrollment invalidated by an update). A vault with no
 *    passcode wrap is one settings change away from being unopenable, so this is
 *    the moment to close that gap rather than after the only key is gone.
 *
 * The device prompt stays **optional**, and the copy says so: a fingerprint or
 * Windows Hello is a convenience added on top of the passcode, never a
 * replacement for it. Everything here is skippable — "Not now" leaves the app
 * exactly as usable as it was, and the prompt comes back on the next launch
 * rather than being dismissed forever, because the gap it closes is still there.
 *
 * It sets nothing up on a vault that already has a passcode, and it never runs
 * behind a share or a capture: an incoming link is the user's intention, and a
 * modal over it would be the app arguing with them.
 */
export function PasscodeOnboarding() {
  const ready = usePrivacyStore((state) => state.ready);
  const passcodeSet = usePrivacyStore((state) => state.passcodeSet);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);
  const deviceUnlockReady = usePrivacyStore((state) => state.deviceUnlockReady);
  const createWithPasscode = usePrivacyStore((state) => state.createWithPasscode);
  const changePasscode = usePrivacyStore((state) => state.changePasscode);
  const captureStatus = useCaptureStore((state) => state.status);

  // Session-scoped on purpose: dismissing means "not right now", not "never".
  const [dismissed, setDismissed] = React.useState(false);
  const [passcode, setPasscode] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const open = ready && !passcodeSet && !dismissed && captureStatus === 'idle';

  const mismatch = confirm.length > 0 && passcode !== confirm;

  const submit = React.useCallback(async () => {
    if (passcode.length < MIN_PASSCODE_LENGTH) {
      setError(MIN_PASSCODE_MESSAGE);
      return;
    }
    if (passcode !== confirm) {
      setError('Those two passcodes are not the same.');
      return;
    }
    setError(null);
    setBusy(true);
    // Two different acts behind one button. With no keyring at all this *is* the
    // setup; on a vault that already exists (one created before a passcode was
    // required) it is the add-a-wrap path, which proves the current way in first.
    const result = keyringPresent ? await changePasscode('', passcode) : await createWithPasscode(passcode);
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? 'Could not set that passcode.');
      return;
    }
    setPasscode('');
    setConfirm('');
    setDismissed(true);
    toast(keyringPresent ? 'Passcode added' : 'Passcode set. Locking is on.', { tone: 'success' });
  }, [changePasscode, confirm, createWithPasscode, keyringPresent, passcode]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set a passcode for Stash"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-overlay px-6 py-10 pt-safe pb-safe"
    >
      <div className="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-5 shadow-raised">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Key size={22} strokeWidth={1.9} aria-hidden />
        </span>

        <h1 className="text-title mt-3 font-semibold tracking-tight text-fg">Set a passcode</h1>
        <p className="text-meta mt-1.5 leading-relaxed text-muted">
          {keyringPresent
            ? 'This vault opens with the device prompt alone. If that prompt becomes unavailable — a fingerprint removed, a screen lock switched off — nothing is left to open your locked items. A passcode closes that gap.'
            : 'A passcode is what locks the folders you mark private, and it is the one way in that nothing on this device can take away. Without one, locked items could be lost forever if your device lock changes.'}
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <PasscodeInput
            id="stash-onboarding-passcode"
            label={`Passcode · at least ${MIN_PASSCODE_LENGTH} characters`}
            value={passcode}
            onChange={(value) => {
              setPasscode(value);
              setError(null);
            }}
            onSubmit={() => void submit()}
            autoFocus
            disabled={busy}
            {...(error ? { tone: 'danger' as const, hint: error } : {})}
          />
          <PasscodeInput
            id="stash-onboarding-confirm"
            label="Repeat passcode"
            value={confirm}
            onChange={(value) => {
              setConfirm(value);
              setError(null);
            }}
            onSubmit={() => void submit()}
            disabled={busy}
            {...(mismatch
              ? { tone: 'danger' as const, hint: 'Those two passcodes are not the same.' }
              : {})}
          />
        </div>

        <p className="text-meta mt-3 flex items-start gap-2 leading-relaxed text-subtle">
          <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
          {deviceUnlockReady
            ? 'Your fingerprint, face or Windows Hello keeps working exactly as it does now, and stays available alongside it.'
            : 'Fingerprint, face or Windows Hello can be added afterwards in Settings. It is optional.'}
        </p>

        <Button
          variant="primary"
          size="lg"
          className="mt-4 w-full"
          disabled={busy || passcode.length < MIN_PASSCODE_LENGTH || mismatch}
          onClick={() => void submit()}
        >
          {busy ? (
            <Loader2 size={19} strokeWidth={2.2} className="animate-spin" aria-hidden />
          ) : (
            <Key size={19} strokeWidth={1.9} aria-hidden />
          )}
          {keyringPresent ? 'Add passcode' : 'Set passcode and continue'}
        </Button>
        <Button variant="ghost" className="mt-2 w-full" disabled={busy} onClick={() => setDismissed(true)}>
          Not now
        </Button>
      </div>
    </div>
  );
}
