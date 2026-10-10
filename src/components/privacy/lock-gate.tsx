'use client';

import * as React from 'react';
import { Fingerprint, Loader2, Lock, Unlock } from '@/components/ui/icons';
import { devicePromptName, devicePromptTitle } from '@/lib/privacy/auth';
import { shouldPromptForReveal } from '@/lib/privacy/session';
import type { RevealKind } from '@/stores/privacy-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { Button } from '@/components/ui/button';
import { PasscodeInput } from './passcode-input';

/**
 * The unlock prompt.
 *
 * This is **not** a lock screen for the app, and deliberately so. Stash asks for
 * nothing to open: the vault is not hidden behind a gate. What is locked is
 * content — a protected folder's contents are ciphertext on disk, so they read as
 * locked rows and are simply not there to show.
 *
 * This dialog exists for exactly one moment: the user tried to cross into a
 * protected folder and it did not open. That happens when the prompt is
 * cancelled, when it fails, when the device has no prompt at all, or when the
 * device prompt has been switched off — and in all four cases the honest answer is
 * a way to get in, not a sentence explaining why there isn't one.
 *
 * ## Two ways in, both on screen
 *
 * The device button and the passcode field are shown **together** whenever both
 * exist, rather than one appearing after the other fails. That is the fix for the
 * bug this screen used to have: a vault whose five folders were locked and whose
 * biometric switch had been turned off showed a card that explained the device
 * could not prompt and then stopped, with the passcode field gated behind a flag
 * that only a vault created by an older build could set. A fallback you have to
 * qualify for is not a fallback.
 *
 * What it grants is one folder. The vault holds a single key, so the seal itself
 * is all-or-nothing, but access is decided per boundary: passing this for
 * `Private` opens `Private` and everything beneath it and leaves every other
 * locked folder exactly as shut as it was.
 */

const NOUNS: Record<RevealKind, string> = {
  folder: 'Locked folder',
  note: 'Locked note',
  link: 'Locked link',
};

export function LockGate() {
  const ready = usePrivacyStore((state) => state.ready);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);
  const passcodeSet = usePrivacyStore((state) => state.passcodeSet);
  const deviceAuthAvailable = usePrivacyStore((state) => state.deviceAuthAvailable);
  const deviceUnlockReady = usePrivacyStore((state) => state.deviceUnlockReady);
  const deviceStoreKind = usePrivacyStore((state) => state.deviceStoreKind);
  const revealRequest = usePrivacyStore((state) => state.revealRequest);
  const message = usePrivacyStore((state) => state.message);
  const busy = usePrivacyStore((state) => state.busy);
  const unlock = usePrivacyStore((state) => state.unlock);
  const unlockWithBiometrics = usePrivacyStore((state) => state.unlockWithBiometrics);
  const clearReveal = usePrivacyStore((state) => state.clearReveal);

  const [passcode, setPasscode] = React.useState('');

  // The only reason to show this: something the user tapped is locked and the
  // prompt did not answer for it. Nothing else raises it — not a cold start, not
  // a tab change, not the app coming back to the foreground, not a share.
  const blocking = shouldPromptForReveal({
    ready,
    keyringPresent,
    hasRevealRequest: revealRequest !== null,
  });
  const devicePath = deviceAuthAvailable && deviceUnlockReady;

  const submit = React.useCallback(async () => {
    if (passcode.length === 0) return;
    await unlock(passcode);
    // Cleared on failure as well as success: a rejected passcode should not sit
    // in a text field for the next person to see.
    setPasscode('');
  }, [passcode, unlock]);

  if (!blocking) return null;

  const noun = revealRequest ? NOUNS[revealRequest.kind] : 'Locked item';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${noun} — unlock to open`}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay px-6 py-10 pt-safe pb-safe"
    >
      <div className="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-5 shadow-raised">
        <Lock size={26} strokeWidth={1.7} className="text-accent" aria-hidden />

        <h1 className="text-title mt-3 font-semibold tracking-tight text-fg">{noun}</h1>
        <p className="text-meta mt-1.5 leading-relaxed text-muted">
          {devicePath && passcodeSet
            ? `Unlock with ${devicePromptName(deviceStoreKind)}, or type your passcode. This opens the folder you asked for and nothing else.`
            : passcodeSet
              ? 'Type your passcode to open it. This opens the folder you asked for and nothing else; the rest of Stash stays exactly as it was.'
              : devicePath
                ? `Unlock with ${devicePromptName(deviceStoreKind)} to open it. This opens the folder you asked for and nothing else; the rest of Stash stays exactly as it was.`
                : 'This vault has no passcode and this device cannot prompt, so this folder cannot be opened here. Everything else stays readable.'}
        </p>

        {devicePath ? (
          <Button
            variant={passcodeSet ? 'accentSoft' : 'primary'}
            size="lg"
            className="mt-4 w-full"
            disabled={busy}
            onClick={() => void unlockWithBiometrics()}
          >
            {busy ? (
              <Loader2 size={19} strokeWidth={2.2} className="animate-spin" aria-hidden />
            ) : (
              <Fingerprint size={19} strokeWidth={1.9} aria-hidden />
            )}
            Unlock with {devicePromptTitle(deviceStoreKind)}
          </Button>
        ) : null}

        {passcodeSet ? (
          <div className="mt-4">
            <PasscodeInput
              label="Passcode"
              value={passcode}
              onChange={(value) => setPasscode(value)}
              onSubmit={() => void submit()}
              autoFocus={!devicePath}
              disabled={busy}
              tone={message ? 'danger' : 'default'}
              hint={message ?? undefined}
            />
            <Button
              variant={devicePath ? 'surface' : 'primary'}
              size="lg"
              className="mt-3 w-full"
              disabled={busy || passcode.length === 0}
              onClick={() => void submit()}
            >
              {busy ? (
                <Loader2 size={19} strokeWidth={2.2} className="animate-spin" aria-hidden />
              ) : (
                <Unlock size={19} strokeWidth={1.9} aria-hidden />
              )}
              Unlock
            </Button>
          </div>
        ) : (
          <>
            {message ? (
              <p className="text-meta mt-3 leading-relaxed text-danger" role="status">
                {message}
              </p>
            ) : null}
            {/*
              * No passcode and no working device prompt. The one honest thing to
              * say is what is still reachable and what is not — and where to go
              * if the device prompt can be restored, because that is the only
              * thing that opens these rows.
              */}
            {keyringPresent && !devicePath ? (
              <p className="text-meta mt-3 leading-relaxed text-subtle">
                Re-enable the device prompt in your system settings (a screen lock, or fingerprint or face)
                and this vault opens again. Nothing has been deleted.
              </p>
            ) : null}
          </>
        )}

        <Button variant="ghost" className="mt-2 w-full" disabled={busy} onClick={() => clearReveal()}>
          Not now
        </Button>
      </div>
    </div>
  );
}
