'use client';

import * as React from 'react';
import { Check, ChevronDown, Fingerprint, Loader2, Lock, Unlock } from '@/components/ui/icons';
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
 * protected folder and it did not open.
 *
 * ## Two ways in, one of them in front
 *
 * Both ways in work, and the dialog shows **one at a time** with a dropdown to
 * switch. That is the whole point of the control: a device with a fingerprint
 * should ask for the fingerprint and get out of the way, and the same person
 * should be able to say "I want to type it this time" without a second dialog or
 * a second code appearing over the first.
 *
 * The choice is *remembered* (`privacy.primaryUnlock`), because a preference
 * expressed at the moment of unlocking is the preference the user means. The
 * other method is never more than a tap away, so the preference decides the
 * default and nothing else.
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

type Method = 'device' | 'passcode';

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
   * passcode field is empty, the dropdown is closed, and a one-off method switch
   * does not leak into the next prompt. Doing that with a key is what makes it
   * true by construction — there is no effect resetting anything, so there is no
   * render in which the old attempt's state is still on screen.
   */
  return <GateDialog key={`${revealRequest?.kind ?? 'item'}:${revealRequest?.id ?? 'none'}`} />;
}

function GateDialog() {
  const passcodeSet = usePrivacyStore((state) => state.passcodeSet);
  const deviceAuthAvailable = usePrivacyStore((state) => state.deviceAuthAvailable);
  const deviceUnlockReady = usePrivacyStore((state) => state.deviceUnlockReady);
  const deviceStoreKind = usePrivacyStore((state) => state.deviceStoreKind);
  const primaryUnlock = usePrivacyStore((state) => state.settings.primaryUnlock);
  const revealRequest = usePrivacyStore((state) => state.revealRequest);
  const message = usePrivacyStore((state) => state.message);
  const busy = usePrivacyStore((state) => state.busy);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);
  const unlock = usePrivacyStore((state) => state.unlock);
  const unlockWithBiometrics = usePrivacyStore((state) => state.unlockWithBiometrics);
  const clearReveal = usePrivacyStore((state) => state.clearReveal);
  const update = usePrivacyStore((state) => state.update);

  const [passcode, setPasscode] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  /**
   * The method chosen *for this attempt*, or `null` to follow the saved
   * preference.
   */
  const [choice, setChoice] = React.useState<Method | null>(null);

  const devicePath = deviceAuthAvailable && deviceUnlockReady;

  /**
   * Which control is in front.
   *
   * The saved preference decides, and anything it asks for that is not actually
   * available falls back — a preference is not a button that cannot work.
   */
  const method: Method =
    choice ?? (primaryUnlock === 'device' && devicePath ? 'device' : passcodeSet ? 'passcode' : 'device');

  const submit = React.useCallback(async () => {
    if (passcode.length === 0) return;
    await unlock(passcode);
    // Cleared on failure as well as success: a rejected passcode should not sit
    // in a text field for the next person to see.
    setPasscode('');
  }, [passcode, unlock]);

  const noun = revealRequest ? NOUNS[revealRequest.kind] : 'Locked item';
  const showDevice = method === 'device' && devicePath;
  const showPasscode = method === 'passcode' && passcodeSet;

  const options: Array<{ id: Method; label: string; hint: string }> = [];
  if (devicePath) {
    options.push({
      id: 'device',
      label: devicePromptTitle(deviceStoreKind),
      hint: devicePromptName(deviceStoreKind),
    });
  }
  if (passcodeSet) options.push({ id: 'passcode', label: 'Passcode', hint: 'The one you chose' });

  const currentLabel = method === 'device' ? devicePromptTitle(deviceStoreKind) : 'Passcode';

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
            ? 'This opens the folder you asked for and nothing else; the rest of Stash stays exactly as it was.'
            : passcodeSet
              ? 'Type your passcode to open it. This opens the folder you asked for and nothing else.'
              : devicePath
                ? `Unlock with ${devicePromptName(deviceStoreKind)} to open it. This opens the folder you asked for and nothing else.`
                : 'This vault has no passcode and this device cannot prompt, so this folder cannot be opened here. Everything else stays readable.'}
        </p>

        {/* The dropdown. One method is in front, the other is one tap away, and
            nothing is asked twice. */}
        {options.length > 1 ? (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              aria-expanded={pickerOpen}
              aria-haspopup="listbox"
              className="tap flex w-full items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-left text-meta active:bg-surface-3"
            >
              <span className="text-subtle">Unlock with</span>
              <span className="font-medium text-fg">{currentLabel}</span>
              <ChevronDown
                size={15}
                strokeWidth={2.3}
                className={`ml-auto shrink-0 text-subtle transition-transform duration-150 ${pickerOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>

            {pickerOpen ? (
              <ul role="listbox" className="mt-1.5 overflow-hidden rounded-xl border border-border bg-surface">
                {options.map((option) => {
                  const active = option.id === method;
                  return (
                    <li key={option.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          setChoice(option.id);
                          setPickerOpen(false);
                          // Remembered, so the next locked folder asks the same
                          // way. It changes no key and removes neither way in.
                          void update({ primaryUnlock: option.id });
                        }}
                        className="tap flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left active:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-row block font-medium text-fg">{option.label}</span>
                          <span className="text-meta block text-subtle">{option.hint}</span>
                        </span>
                        {active ? (
                          <Check size={15} strokeWidth={2.4} className="shrink-0 text-accent" aria-hidden />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}

        {showDevice ? (
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

        {showPasscode ? (
          <div className="mt-4">
            <PasscodeInput
              label="Passcode"
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
                <Unlock size={19} strokeWidth={1.9} aria-hidden />
              )}
              Unlock
            </Button>
          </div>
        ) : null}

        {/*
          * Nothing to offer: no passcode wrap and no working device prompt. The
          * one honest thing to say is what is still reachable and what is not.
          */}
        {!showDevice && !showPasscode ? (
          <>
            {message ? (
              <p className="text-meta mt-3 leading-relaxed text-danger" role="status">
                {message}
              </p>
            ) : null}
            {keyringPresent && !devicePath ? (
              <p className="text-meta mt-3 leading-relaxed text-subtle">
                Re-enable the device prompt in your system settings (a screen lock, or fingerprint or face)
                and this vault opens again. Nothing has been deleted.
              </p>
            ) : null}
          </>
        ) : null}

        <Button variant="ghost" className="mt-2 w-full" disabled={busy} onClick={() => clearReveal()}>
          Not now
        </Button>
      </div>
    </div>
  );
}
