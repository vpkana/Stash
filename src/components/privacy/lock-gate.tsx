'use client';

import * as React from 'react';
import { Fingerprint, Loader2, Lock, ShieldCheck, Unlock } from '@/components/ui/icons';
import { devicePromptName, devicePromptTitle } from '@/lib/privacy/auth';
import {
  LEGACY_PASSCODE_EXPLANATION,
  LEGACY_PASSCODE_HEADLINE,
} from '@/lib/privacy/legacy-passcode';
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
 * protected item and the system prompt did not answer for it. There is one button
 * because there is one way in — the device's own lock, offered by the operating
 * system, which is where the choice between a fingerprint and a PIN lives. Stash
 * does not draw that choice itself, because doing so would mean verifying a
 * credential itself, and it must never be in a position to.
 *
 * ## The one exception, and why it is not a password system
 *
 * A vault locked by an earlier build has no device wrap: its content can only be
 * opened by the passcode that build asked for. That prompt appears here, once,
 * and it does not *unlock* anything — it converts the vault to the device wrap so
 * the passcode is never needed again. After it, this dialog has one button on
 * every device. See `lib/privacy/legacy-passcode.ts`, which is the only code in
 * the app that can read a passcode at all.
 *
 * What the dialog grants is one item. The vault holds a single key, so the seal
 * itself is all-or-nothing, but access is decided per boundary: passing this for
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
  const revealRequest = usePrivacyStore((state) => state.revealRequest);

  // The only reason to show this: something the user tapped is locked and the
  // prompt did not answer for it. Nothing else raises it — not a cold start, not
  // a tab change, not the app coming back to the foreground, not a share.
  const blocking = shouldPromptForReveal({
    ready,
    keyringPresent,
    hasRevealRequest: revealRequest !== null,
  });

  if (!blocking) return null;

  /*
   * Keyed by what is being unlocked.
   *
   * A second locked folder is a *new question*, so it gets a fresh dialog: the
   * field is empty and a failed attempt does not leak into the next prompt. Doing
   * that with a key is what makes it true by construction — there is no effect
   * resetting anything, so there is no render in which the old attempt's state is
   * still on screen.
   */
  return <GateDialog key={`${revealRequest?.kind ?? 'item'}:${revealRequest?.id ?? 'none'}`} />;
}

function GateDialog() {
  const legacyPasscodeOnly = usePrivacyStore((state) => state.legacyPasscodeOnly);
  const deviceAuthAvailable = usePrivacyStore((state) => state.deviceAuthAvailable);
  const deviceUnlockReady = usePrivacyStore((state) => state.deviceUnlockReady);
  const deviceStoreKind = usePrivacyStore((state) => state.deviceStoreKind);
  const revealRequest = usePrivacyStore((state) => state.revealRequest);
  const message = usePrivacyStore((state) => state.message);
  const busy = usePrivacyStore((state) => state.busy);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);
  const unlockWithBiometrics = usePrivacyStore((state) => state.unlockWithBiometrics);
  const unlockWithLegacyPasscode = usePrivacyStore((state) => state.unlockWithLegacyPasscode);
  const clearReveal = usePrivacyStore((state) => state.clearReveal);

  const [passcode, setPasscode] = React.useState('');

  const devicePath = deviceAuthAvailable && deviceUnlockReady;
  const noun = revealRequest ? NOUNS[revealRequest.kind] : 'Locked item';

  const submit = React.useCallback(async () => {
    if (passcode.length === 0) return;
    await unlockWithLegacyPasscode(passcode);
    // Cleared on failure as well as success: a rejected passcode should not sit
    // in a text field for the next person to see.
    setPasscode('');
  }, [passcode, unlockWithLegacyPasscode]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${noun} — unlock to open`}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay px-6 py-10 pt-safe pb-safe"
    >
      <div className="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-5 shadow-raised">
        <Lock size={26} strokeWidth={1.7} className="text-accent" aria-hidden />

        {legacyPasscodeOnly ? (
          <>
            <h1 className="text-title mt-3 font-semibold tracking-tight text-fg">
              {LEGACY_PASSCODE_HEADLINE}
            </h1>
            <p className="text-meta mt-1.5 leading-relaxed text-muted">{LEGACY_PASSCODE_EXPLANATION}</p>

            <div className="mt-4">
              <PasscodeInput
                label="The passcode you used before"
                value={passcode}
                onChange={(value) => setPasscode(value)}
                onSubmit={() => void submit()}
                autoFocus
                disabled={busy}
                tone={message ? 'danger' : 'default'}
                hint={message ?? undefined}
              />
              <Button
                variant="primary"
                size="lg"
                className="mt-3 w-full"
                disabled={busy || passcode.length === 0}
                onClick={() => void submit()}
              >
                {busy ? (
                  <Loader2 size={19} strokeWidth={2.2} className="animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck size={19} strokeWidth={1.9} aria-hidden />
                )}
                Move to my device lock
              </Button>
            </div>

            <p className="text-meta mt-3 flex items-start gap-2 leading-relaxed text-subtle">
              <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
              Nothing is re-encrypted and nothing is removed. After this, only your fingerprint, face or
              screen lock opens it.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-title mt-3 font-semibold tracking-tight text-fg">{noun}</h1>
            <p className="text-meta mt-1.5 leading-relaxed text-muted">
              {devicePath
                ? `Unlock with ${devicePromptName(deviceStoreKind)} to open it. This opens the item you asked for and nothing else.`
                : 'This device cannot ask for an unlock right now, so this item cannot be opened here. Everything else stays readable, and nothing has been deleted.'}
            </p>

            {devicePath ? (
              <Button
                variant="primary"
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

            {message ? (
              <p className="text-meta mt-3 leading-relaxed text-danger" role="status">
                {message}
              </p>
            ) : null}

            {keyringPresent && !devicePath ? (
              <p className="text-meta mt-3 leading-relaxed text-subtle">
                A screen lock, fingerprint or face is what opens this vault now. Set one up in your device
                settings and it opens again — the items are still here, encrypted as they were.
              </p>
            ) : null}
          </>
        )}

        <Button variant="ghost" className="mt-2 w-full" disabled={busy} onClick={() => clearReveal()}>
          <Unlock size={17} strokeWidth={1.9} aria-hidden />
          Not now
        </Button>
      </div>
    </div>
  );
}
