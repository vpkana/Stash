'use client';

import * as React from 'react';
import {
  AlertTriangle,
  Fingerprint,
  Key,
  Lock,
  LockKeyhole,
  ShieldCheck,
  Smartphone,
  Unlock,
} from '@/components/ui/icons';
import { pluralize } from '@/lib/format';
import { allLockRoots } from '@/lib/privacy/protection';
import { MIN_PASSCODE_LENGTH, MIN_PASSCODE_MESSAGE } from '@/lib/privacy/keyring';
import { devicePromptName } from '@/lib/privacy/auth';
import { screenPrivacySupported } from '@/lib/privacy/screen';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Section } from '@/components/ui/page';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { PasscodeInput } from './passcode-input';

/**
 * Privacy settings.
 *
 * Written to be read by someone deciding whether to trust the app with something
 * private, so the limitations are stated next to the switches rather than buried
 * in a policy page: what is encrypted, what stays visible, when an unlock
 * expires, and how the vault opens.
 *
 * ## A passcode first, and why that ordering is the point
 *
 * Locking used to be device-only: nothing to invent, nothing to forget, and one
 * failure mode that is not a trade-off but a trap — a device key can be withdrawn
 * by the operating system, and a vault whose only wrap is a device key becomes
 * unopenable the moment a biometric setting changes. That is what this screen no
 * longer allows. Locking starts with a passcode, and the device prompt is armed
 * afterwards as a convenience on top of it. Nothing the platform does to an
 * enrollment can take the passcode away, so no settings change can lock someone
 * out of their own folders.
 *
 * Locking is still *not* a lock screen for the app: Stash opens like any other
 * app, locked items simply cannot be read, and what asks for a credential is
 * either tapping a locked folder or the deliberate "open everything" below.
 */

type Mode = 'idle' | 'setup' | 'disable' | 'abandon' | 'passcode' | 'remove-passcode' | 'open-all';

export function PrivacySettings() {
  const ready = usePrivacyStore((state) => state.ready);
  const settings = usePrivacyStore((state) => state.settings);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);
  const passcodeSet = usePrivacyStore((state) => state.passcodeSet);
  const unlocked = usePrivacyStore((state) => state.unlocked);
  const deviceAuthAvailable = usePrivacyStore((state) => state.deviceAuthAvailable);
  const deviceUnlockReady = usePrivacyStore((state) => state.deviceUnlockReady);
  const deviceStoreKind = usePrivacyStore((state) => state.deviceStoreKind);
  const busy = usePrivacyStore((state) => state.busy);

  const createWithPasscode = usePrivacyStore((state) => state.createWithPasscode);
  // Named apart from the local field setter below: this one writes the keyring,
  // that one types a character.
  const savePasscode = usePrivacyStore((state) => state.setPasscode);
  const removePasscode = usePrivacyStore((state) => state.removePasscode);
  const disable = usePrivacyStore((state) => state.disable);
  const abandonLock = usePrivacyStore((state) => state.abandonLock);
  const update = usePrivacyStore((state) => state.update);
  const armBiometrics = usePrivacyStore((state) => state.armBiometrics);
  const disarmBiometrics = usePrivacyStore((state) => state.disarmBiometrics);
  const lock = usePrivacyStore((state) => state.lock);
  const unlock = usePrivacyStore((state) => state.unlock);
  const unlockWithBiometrics = usePrivacyStore((state) => state.unlockWithBiometrics);
  const grantAll = usePrivacyStore((state) => state.grantAll);

  const protection = useVaultStore((state) => state.protection);

  const [mode, setMode] = React.useState<Mode>('idle');
  const [passcode, setPasscode] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState(false);

  /**
   * Whether this build can actually block a screenshot.
   *
   * Asked once when the screen opens, so the switch can be offered where it works
   * and *explained* where it does not. A switch that silently does nothing is
   * worse than no switch: the user would believe their vault is protected from
   * the one thing — a photograph of the screen — that no amount of encryption can
   * undo.
   */
  const [screenPrivacy, setScreenPrivacy] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void screenPrivacySupported().then((supported) => {
      if (!cancelled) setScreenPrivacy(supported);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const devicePath = deviceAuthAvailable && deviceUnlockReady;
  /** No device prompt to authorise with, so the passcode has to do it. */
  const passcodeAuthorisesDisable = !deviceUnlockReady;

  const lockedCounts = {
    folders: protection.folders.size,
    notes: protection.notes.size,
    links: protection.links.size,
  };
  const hasLocks = lockedCounts.folders + lockedCounts.notes + lockedCounts.links > 0;
  /** Every distinct boundary there is, so "open everything" is expressible. */
  const everyRoot = React.useMemo(() => [...allLockRoots(protection)], [protection]);

  const reset = () => {
    setMode('idle');
    setPasscode('');
    setConfirm('');
    setError(null);
  };

  const mismatch = confirm.length > 0 && passcode !== confirm;

  const submitSetup = async () => {
    if (passcode.length < MIN_PASSCODE_LENGTH) {
      setError(MIN_PASSCODE_MESSAGE);
      return;
    }
    if (mismatch) {
      setError('Those two passcodes are not the same.');
      return;
    }
    const result = await createWithPasscode(passcode);
    if (!result.ok) {
      setError(result.message ?? 'Could not turn on locking.');
      return;
    }
    reset();
    toast('Locking is on', { tone: 'success' });
  };

  const submitPasscode = async () => {
    if (passcode.length < MIN_PASSCODE_LENGTH) {
      setError(MIN_PASSCODE_MESSAGE);
      return;
    }
    if (mismatch) {
      setError('Those two passcodes are not the same.');
      return;
    }
    const result = await savePasscode(passcode);
    if (!result.ok) {
      setError(result.message ?? 'Could not save that passcode.');
      return;
    }
    reset();
    toast(passcodeSet ? 'Passcode changed' : 'Passcode added', { tone: 'success' });
  };

  const submitRemovePasscode = async () => {
    const result = await removePasscode(passcode);
    if (!result.ok) {
      setError(result.message ?? 'Could not remove the passcode.');
      return;
    }
    reset();
    toast('Passcode removed. The device prompt is now the only way in.', { tone: 'success' });
  };

  const submitDisable = async () => {
    const result = await disable(passcode);
    if (!result.ok) {
      setError(result.message ?? 'Could not turn locking off.');
      return;
    }
    reset();
    toast('Locking is off. Everything is readable again.', { tone: 'success' });
  };

  /**
   * Open every boundary for this session, having authenticated first.
   *
   * The safe shape of "unlock everything": it grants what opening each folder in
   * turn would grant, it lasts exactly as long as the session lasts, and it
   * changes no setting. There is no path from here to a vault that is secretly
   * unlocked, and none to one whose protection was quietly removed.
   */
  const openEverything = async (withPasscode: boolean) => {
    setError(null);
    setOpening(true);
    if (withPasscode) {
      if (passcode.length === 0) {
        setOpening(false);
        return;
      }
      const result = await unlock(passcode);
      setPasscode('');
      if (!result.ok) {
        setOpening(false);
        setError(result.message ?? 'That passcode did not match.');
        return;
      }
    } else {
      const result = await unlockWithBiometrics();
      if (!result.ok) {
        setOpening(false);
        setError(result.message ?? 'That did not succeed.');
        return;
      }
    }
    grantAll(everyRoot);
    setOpening(false);
    reset();
    toast('Every locked folder is open for this session', { tone: 'success' });
  };

  if (!ready) return null;

  return (
    <>
      <Section title="Locking">
        <div className="mx-4 overflow-hidden card">
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-row font-medium text-fg">
                {keyringPresent ? (
                  <LockKeyhole size={17} strokeWidth={1.9} className="shrink-0 text-accent" aria-hidden />
                ) : (
                  <Lock size={17} strokeWidth={1.9} className="shrink-0 text-subtle" aria-hidden />
                )}
                {keyringPresent ? (unlocked ? 'Unlocked' : 'Locked') : 'Not set up'}
              </p>
              <p className="mt-0.5 text-meta leading-relaxed text-subtle">
                {keyringPresent
                  ? hasLocks
                    ? `${pluralize(lockedCounts.notes, 'note')}, ${pluralize(lockedCounts.links, 'link')} and ${pluralize(lockedCounts.folders, 'folder')} protected${passcodeSet ? ' · passcode' : ''}${devicePath ? ' + device lock' : ''}`
                    : 'No items are locked yet. Lock a folder, note or link to use this.'
                  : 'Turn this on with a passcode, then lock any folder you want kept private. Its contents are encrypted at rest and open one folder at a time.'}
              </p>
              {keyringPresent ? (
                <p className="mt-1.5 text-meta leading-relaxed text-subtle">
                  A protected folder’s contents are encrypted at rest and withheld until you ask for them: opening
                  the folder asks for your unlock, and passing it opens that folder only. Opening Stash, browsing,
                  searching and saving links never ask for anything. Access ends when you switch tabs or leave Stash.
                </p>
              ) : null}
            </div>
            {keyringPresent && unlocked ? (
              <Button variant="surface" size="sm" onClick={() => lock()}>
                Lock now
              </Button>
            ) : null}
          </div>

          {mode === 'idle' ? (
            <div className="flex flex-col border-t border-border px-3 py-3">
              {!keyringPresent ? (
                <>
                  <Button
                    variant="accentSoft"
                    className="w-full"
                    onClick={() => {
                      reset();
                      setMode('setup');
                    }}
                  >
                    <Key size={18} strokeWidth={1.9} aria-hidden />
                    Turn on locking
                  </Button>
                  <p className="px-0.5 pt-2 text-meta leading-relaxed text-subtle">
                    You choose a passcode with {MIN_PASSCODE_LENGTH}+ characters. It is the one way in that nothing
                    on this device can take away, and it is never stored — the passcode unlocks a key, and only the
                    locked key is written down. Once locking is on you can also add the device prompt, which is
                    quicker but never required.
                  </p>
                </>
              ) : (
                <div className="flex flex-col gap-2">
                  {/*
                    * The gap this whole change exists to close: a vault that was
                    * locked before a passcode was required has no passcode wrap,
                    * and its device prompt can be switched off. Saying so in the
                    * place the user would come to fix it is the whole remedy.
                    */}
                  {!passcodeSet ? (
                    <div className="rounded-xl border border-warning/30 bg-surface-2 px-3 py-2.5">
                      <p className="text-row font-medium text-fg">Add a passcode</p>
                      <p className="mt-0.5 text-meta leading-relaxed text-subtle">
                        This vault still opens with the device lock alone. If that prompt becomes unavailable — a
                        fingerprint removed, a screen lock switched off — there is nothing left to open it with.
                        A passcode closes that gap and does not change any of your folders.
                      </p>
                    </div>
                  ) : null}
                  <ActionButton
                    icon={<Key size={18} strokeWidth={1.9} aria-hidden />}
                    label={passcodeSet ? 'Change the passcode' : 'Add a passcode'}
                    disabled={!unlocked}
                    hint={unlocked ? undefined : 'Unlock the vault first.'}
                    onClick={() => {
                      reset();
                      setMode('passcode');
                    }}
                  />
                  {hasLocks ? (
                    <ActionButton
                      icon={<ShieldCheck size={18} strokeWidth={1.9} aria-hidden />}
                      label="Open every locked folder for this session"
                      hint="Asks for your unlock first. Changes no settings, and ends when you leave Stash."
                      onClick={() => {
                        reset();
                        setMode('open-all');
                      }}
                    />
                  ) : null}
                  <ActionButton
                    icon={<Unlock size={18} strokeWidth={1.9} aria-hidden />}
                    label="Turn locking off"
                    onClick={() => {
                      reset();
                      setMode('disable');
                    }}
                  />
                </div>
              )}
            </div>
          ) : null}

          {mode === 'setup' || mode === 'passcode' ? (
            <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
              <p className="px-0.5 text-meta leading-relaxed text-subtle">
                {mode === 'setup'
                  ? `At least ${MIN_PASSCODE_LENGTH} characters. Stash does not store this passcode and cannot show it to you later; if you forget it, the device prompt (once armed) is the remaining way in.`
                  : 'The new passcode replaces the old one. Your folders, notes and links are untouched — the same key is simply wrapped in a new one.'}
              </p>
              <PasscodeInput
                id="stash-passcode-new"
                label="Passcode"
                value={passcode}
                onChange={(value) => {
                  setPasscode(value);
                  setError(null);
                }}
                onSubmit={() => void (mode === 'setup' ? submitSetup() : submitPasscode())}
                autoFocus
                disabled={busy}
                {...(error ? { tone: 'danger' as const, hint: error } : {})}
              />
              <PasscodeInput
                id="stash-passcode-confirm"
                label="Repeat passcode"
                value={confirm}
                onChange={(value) => {
                  setConfirm(value);
                  setError(null);
                }}
                onSubmit={() => void (mode === 'setup' ? submitSetup() : submitPasscode())}
                disabled={busy}
                {...(mismatch
                  ? { tone: 'danger' as const, hint: 'Those two passcodes are not the same.' }
                  : {})}
              />
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={reset} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  className="flex-[1.4]"
                  disabled={busy || passcode.length < MIN_PASSCODE_LENGTH || mismatch}
                  onClick={() => void (mode === 'setup' ? submitSetup() : submitPasscode())}
                >
                  {mode === 'setup' ? 'Turn on locking' : 'Save passcode'}
                </Button>
              </div>
            </div>
          ) : null}

          {mode === 'open-all' ? (
            <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
              <p className="rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-meta leading-relaxed text-fg/85">
                This opens {pluralize(lockedCounts.folders, 'folder')} and everything inside them for this session.
                It does not turn locking off, does not decrypt anything on disk and does not change which folders
                are protected — leave Stash, and they are locked again.
              </p>
              {devicePath ? (
                <Button
                  variant="accentSoft"
                  className="w-full"
                  disabled={opening}
                  onClick={() => void openEverything(false)}
                >
                  <Fingerprint size={18} strokeWidth={1.9} aria-hidden />
                  Confirm with {devicePromptName(deviceStoreKind)}
                </Button>
              ) : null}
              {passcodeSet ? (
                <PasscodeInput
                  label="Passcode"
                  value={passcode}
                  onChange={(value) => {
                    setPasscode(value);
                    setError(null);
                  }}
                  onSubmit={() => void openEverything(true)}
                  disabled={opening}
                  {...(error ? { tone: 'danger' as const, hint: error } : {})}
                />
              ) : null}
              {passcodeSet ? (
                <Button
                  variant={devicePath ? 'surface' : 'primary'}
                  className="w-full"
                  disabled={opening || passcode.length === 0}
                  onClick={() => void openEverything(true)}
                >
                  <Unlock size={18} strokeWidth={1.9} aria-hidden />
                  Open everything
                </Button>
              ) : null}
              <Button variant="ghost" className="w-full" onClick={reset} disabled={opening}>
                Cancel
              </Button>
            </div>
          ) : null}

          {mode === 'remove-passcode' ? (
            <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
              <p className="text-meta leading-relaxed text-muted">
                Removing the passcode leaves the device prompt as the only way into this vault. If that prompt
                becomes unavailable, nothing can open the locked items.
              </p>
              <PasscodeInput
                label="Current passcode"
                value={passcode}
                onChange={(value) => {
                  setPasscode(value);
                  setError(null);
                }}
                onSubmit={() => void submitRemovePasscode()}
                autoFocus
                disabled={busy}
                {...(error ? { tone: 'danger' as const, hint: error } : {})}
              />
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={reset} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="surface"
                  className="flex-1"
                  disabled={busy || passcode.length === 0}
                  onClick={() => void submitRemovePasscode()}
                >
                  Remove passcode
                </Button>
              </div>
            </div>
          ) : null}

          {mode === 'disable' ? (
            <div className="border-t border-border px-3 py-3">
              <div className="flex flex-col gap-3">
                <p className="rounded-xl border border-warning/30 bg-surface-2 px-3 py-2.5 text-meta leading-relaxed text-fg/85">
                  Turning locking off decrypts every locked item and stores it in the clear again, and removes both
                  ways in. {passcodeAuthorisesDisable ? 'Your passcode confirms it.' : 'The device lock confirms it.'}
                </p>
                {passcodeAuthorisesDisable ? (
                  <PasscodeInput
                    label="Passcode"
                    value={passcode}
                    onChange={(value) => {
                      setPasscode(value);
                      setError(null);
                    }}
                    onSubmit={() => void submitDisable()}
                    autoFocus
                    disabled={busy}
                    {...(error ? { tone: 'danger' as const, hint: error } : {})}
                  />
                ) : (
                  <p className="text-meta leading-relaxed text-muted">
                    {devicePromptName(deviceStoreKind)} confirms it instead.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button variant="ghost" className="flex-1" onClick={reset} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    variant="surface"
                    className="flex-1"
                    disabled={busy || (passcodeAuthorisesDisable && passcode.length === 0)}
                    onClick={() => void submitDisable()}
                  >
                    Turn off and decrypt
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </Section>

      {keyringPresent ? (
        <>
          <Section title="Screen privacy">
            <div className="mx-4 overflow-hidden card">
              <ToggleRow
                icon={<Smartphone size={17} strokeWidth={1.9} aria-hidden />}
                label="Hide content in the app switcher and block screenshots"
                description={
                  screenPrivacy === false
                    ? 'Android only. A browser cannot reliably stop a screenshot, so this has no effect here — Stash in a browser still shows its content if the screen is captured. Install the Android app for this one.'
                    : 'Android only. Blocks screenshots and screen recording of Stash, and replaces the thumbnail Android shows in the app switcher with a blank card.'
                }
                checked={screenPrivacy === false ? false : settings.secureScreen}
                disabled={screenPrivacy === false}
                onChange={(value) => void update({ secureScreen: value })}
                last
              />
            </div>
            <p className="px-5 pt-2 text-meta leading-relaxed text-subtle">
              {screenPrivacy === false ? (
                <>
                  This is an Android window setting, so it is offered only in the Android app. Nothing else about
                  your vault changes: the same content is encrypted, and the same unlock still guards it.
                </>
              ) : (
                <>
                  Screenshot blocking is enforced by Android, so it holds in the app and cannot be guaranteed
                  anywhere else — no browser can promise it. Stash also applies it by itself whenever the vault is
                  locked, whatever this switch says. It is a separate setting from locking: switching it on turns
                  nothing on and gates nothing.
                </>
              )}
            </p>
          </Section>

          <Section title="Device unlock">
            <div className="mx-4 overflow-hidden card">
              <ToggleRow
                icon={<Fingerprint size={17} strokeWidth={1.9} aria-hidden />}
                label={deviceStoreKind === 'web' ? 'Use Windows Hello' : 'Use fingerprint or face'}
                description={
                  !unlocked
                    ? 'Unlock the vault first, then this can be armed.'
                    : deviceAuthAvailable
                      ? deviceStoreKind === 'web'
                        ? 'Unlocking can ask Windows Hello (or your device PIN) instead of the passcode. The passcode keeps working either way.'
                        : 'Unlocking can ask for your fingerprint or face instead of the passcode. The passcode keeps working either way.'
                      : deviceStoreKind === 'web'
                        ? 'This computer has no prompt available yet. Set up Windows Hello or a PIN, then reload Stash. The passcode works in the meantime.'
                        : 'No biometrics or screen lock are set up on this device. The passcode works in the meantime.'
                }
                checked={settings.biometric && deviceUnlockReady}
                disabled={!deviceAuthAvailable || !unlocked}
                onChange={(value) => {
                  if (!value) {
                    // Removes one wrap. The passcode wrap is untouched, which is
                    // why turning this off can never cost access to a folder.
                    void disarmBiometrics().then(() => {
                      toast('Device unlock off. Your passcode still opens everything.', {
                        tone: 'success',
                      });
                    });
                    return;
                  }
                  void armBiometrics().then((result) => {
                    if (!result.ok) {
                      toast(result.message ?? 'Could not turn on device unlock', { tone: 'danger' });
                    } else {
                      toast('Device unlock ready', { tone: 'success' });
                    }
                  });
                }}
                last
              />
            </div>
            <p className="px-5 pt-2 text-meta leading-relaxed text-subtle">
              Both ways in unwrap the same key, and either one opens a locked folder on its own. Turning this off
              removes only the device wrap — it never changes, weakens or removes your passcode.
            </p>
          </Section>

          <Section title="What is protected">
            <div className="mx-4 card p-4">
              <ul className="flex flex-col gap-2 text-meta leading-relaxed text-muted">
                <li>
                  <span className="font-medium text-fg">Encrypted:</span> a locked item&apos;s note title and body,
                  a locked link&apos;s address and title, and everything inside a locked folder. Locking a folder
                  covers everything beneath it.
                </li>
                <li>
                  <span className="font-medium text-fg">Still visible:</span> that a locked item exists and where it
                  sits — it keeps its row, its place in the tree, its counts and its timestamps, and shows as a
                  locked entry you can open. Also visible: a folder&apos;s name, which is the label on the lock
                  rather than the contents behind it.
                </li>
                <li>
                  <span className="font-medium text-fg">How it opens:</span> a passcode unwraps the vault key by
                  deriving a key from it with PBKDF2-SHA256 and 210,000 iterations. The passcode itself is never
                  stored, never logged and never written anywhere — a wrong one simply fails to unwrap.
                  {devicePath ? ' The device prompt unwraps the same key through a separate key held by Android.' : ''}
                </li>
                <li>
                  <span className="font-medium text-fg">After a restart:</span> nothing is unlocked. A key comes back
                  only from the passcode or the device prompt, and it does not outlive the session — switching tabs
                  or leaving Stash locks the items again.
                </li>
              </ul>
            </div>
          </Section>

          <Section title="If you cannot unlock" className="pb-10">
            <div className="mx-4 rounded-2xl border border-danger/30 bg-danger-soft p-4">
              <p className="flex items-center gap-2 text-row font-semibold text-danger">
                <AlertTriangle size={17} strokeWidth={2} aria-hidden />
                Locked items cannot be recovered without one of the two ways in
              </p>
              <p className="mt-1.5 text-meta leading-relaxed text-fg/85">
                There is no reset and no escrow: the key that decrypts a locked folder exists only wrapped by your
                passcode and, if armed, by this device. Lose both and those items stay unreadable — everything else
                in the vault keeps working normally, and nothing is deleted.
              </p>
              <p className="mt-2 text-meta leading-relaxed text-fg/85">
                Removing the lock below destroys that key on purpose. It is the honest choice only when you would
                rather have an empty lock than a lock you cannot open.
              </p>
              {mode === 'abandon' ? (
                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-meta leading-relaxed text-danger">
                    Removing the lock destroys the key. Every locked note, link and folder becomes permanently
                    unreadable and cannot be recovered on any device.
                  </p>
                  <Button
                    variant="danger"
                    className="w-full"
                    onClick={() => {
                      void abandonLock();
                      reset();
                      toast('Lock removed. Locked items are now unreadable.', { tone: 'danger' });
                    }}
                  >
                    Remove the lock permanently
                  </Button>
                  <Button variant="ghost" className="w-full" onClick={reset}>
                    Keep my lock
                  </Button>
                </div>
              ) : (
                <Button variant="surface" className="mt-3 w-full" onClick={() => setMode('abandon')}>
                  Remove the lock without unlocking
                </Button>
              )}
            </div>
          </Section>
        </>
      ) : null}
    </>
  );
}

/**
 * A settings row that is an action rather than a switch.
 *
 * `hint` is optional because most of these do not need one; the ones that do are
 * the ones where the button will legitimately be unavailable.
 */
function ActionButton({
  icon,
  label,
  hint,
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <Button variant="surface" className="justify-start" onClick={onClick} disabled={disabled}>
        {icon}
        {label}
      </Button>
      {hint ? <p className="px-1 pt-1 text-meta leading-relaxed text-subtle">{hint}</p> : null}
    </div>
  );
}

function ToggleRow({
  icon,
  label,
  description,
  checked,
  onChange,
  disabled = false,
  last = false,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  last?: boolean;
}) {
  return (
    <div className={cn('flex items-start gap-3 px-4 py-3.5', !last && 'border-b border-border')}>
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-row font-medium text-fg">{label}</p>
        <p className="mt-0.5 text-meta leading-relaxed text-subtle">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
        className="mt-1 shrink-0"
      />
    </div>
  );
}
