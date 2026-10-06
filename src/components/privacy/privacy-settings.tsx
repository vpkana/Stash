'use client';

import * as React from 'react';
import { AlertTriangle, Fingerprint, Lock, LockKeyhole, Smartphone, Unlock } from '@/components/ui/icons';
import { pluralize } from '@/lib/format';
import { devicePromptName } from '@/lib/privacy/auth';
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
 * in a policy page. In particular: what is encrypted, what stays visible, when an
 * unlock expires, and the fact that the device prompt is the only way in — there
 * is no passcode of Stash's own, and therefore nothing to forget, reset or
 * recover.
 *
 * Locking is *not* a lock screen for the app, and the screen says so plainly:
 * Stash opens like any other app, locked items simply cannot be read, and tapping
 * one is what raises the system prompt.
 *
 * The passcode flows that used to live here are gone deliberately. A second
 * secret was a second thing to lose, and it weakened the story rather than
 * strengthening it: the system prompt is the same gate the rest of the phone
 * (or the computer) already trusts, and a person who cannot pass it has no
 * business reading the locked items. What remains for a vault created by an
 * older build is a read-only way to open it (see the legacy branch in
 * `lock-gate.tsx` and `keyring.ts`), never a way to create another passcode.
 */

type Mode = 'idle' | 'disable' | 'abandon';

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

  const createWithDevice = usePrivacyStore((state) => state.createWithDevice);
  const disable = usePrivacyStore((state) => state.disable);
  const abandonLock = usePrivacyStore((state) => state.abandonLock);
  const update = usePrivacyStore((state) => state.update);
  const armBiometrics = usePrivacyStore((state) => state.armBiometrics);
  const disarmBiometrics = usePrivacyStore((state) => state.disarmBiometrics);
  const lock = usePrivacyStore((state) => state.lock);

  const protection = useVaultStore((state) => state.protection);

  const [mode, setMode] = React.useState<Mode>('idle');
  /**
   * Kept for one case only: a vault whose only wrap was a passcode, created by
   * an older build before the device lock existed. Turning locking off has to
   * authorise itself somehow, and on that vault the passcode is the only thing
   * that can. Nothing writes a passcode any more.
   */
  const [passcode, setPasscode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const legacyPasscodeOnly = passcodeSet && !deviceUnlockReady;

  const lockedCounts = {
    folders: protection.folders.size,
    notes: protection.notes.size,
    links: protection.links.size,
  };
  const hasLocks = lockedCounts.folders + lockedCounts.notes + lockedCounts.links > 0;

  const reset = () => {
    setMode('idle');
    setPasscode('');
    setError(null);
  };

  /** Locking with the system prompt alone — the only setup there is. */
  const submitCreateWithDevice = async () => {
    const result = await createWithDevice();
    if (!result.ok) {
      setError(result.message ?? 'Could not turn on locking.');
      return;
    }
    reset();
    toast('Locking is on', { tone: 'success' });
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
                    ? `${pluralize(lockedCounts.notes, 'note')}, ${pluralize(lockedCounts.links, 'link')} and ${pluralize(lockedCounts.folders, 'folder')} protected · device lock only`
                    : 'No items are locked yet. Lock a folder, note or link to use this.'
                  : 'Turn this on, then lock any folder you want kept private. Its contents are encrypted at rest and open one folder at a time, with your device lock.'}
              </p>
              {keyringPresent ? (
                <p className="mt-1.5 text-meta leading-relaxed text-subtle">
                  A protected folder’s contents are encrypted at rest and withheld until you ask for them: opening the
                  folder asks for your device lock, and passing it opens that folder only. Opening Stash, browsing,
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
            <div className="border-t border-border px-3 py-3">
              {!keyringPresent ? (
                <div className="flex flex-col gap-2">
                  {/*
                    * The device prompt is offered first, because it is the
                    * setup that asks nothing of the user's memory. Its cost is
                    * stated in the same breath rather than discovered later.
                    */}
                  {deviceAuthAvailable ? (
                    <>
                      <Button
                        variant="accentSoft"
                        className="w-full"
                        onClick={() => void submitCreateWithDevice()}
                        disabled={busy}
                      >
                        <Fingerprint size={18} strokeWidth={1.9} aria-hidden />
                        Use {devicePromptName(deviceStoreKind)}
                      </Button>
                      <p className="px-0.5 text-meta leading-relaxed text-subtle">
                        Nothing to remember and nothing to type. Locked items open with that prompt and with nothing
                        else — Stash keeps no passcode of its own — so if this device is lost or the app&apos;s data
                        is cleared, they cannot be recovered.
                      </p>
                    </>
                  ) : (
                    <p className="px-0.5 text-meta leading-relaxed text-subtle">
                      {deviceStoreKind === 'web'
                        ? 'This computer cannot prompt for a device unlock yet. Set up Windows Hello or a PIN in Windows Settings, then come back — Stash has no passcode to fall back on.'
                        : 'This device has no screen lock or enrolled biometrics yet. Set one up, then come back — Stash has no passcode to fall back on.'}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="px-0.5 text-meta leading-relaxed text-subtle">
                    Locked items open with {deviceUnlockReady ? devicePromptName(deviceStoreKind) : 'your device lock'}{' '}
                    and nothing else. There is no Stash passcode to set, remember or reset.
                  </p>
                  <Button
                    variant="surface"
                    className="justify-start"
                    onClick={() => {
                      setMode('disable');
                    }}
                  >
                    <Unlock size={18} strokeWidth={1.9} aria-hidden />
                    Turn locking off
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          {mode === 'disable' ? (
            <div className="border-t border-border px-3 py-3">
              <div className="flex flex-col gap-3">
                <p className="rounded-xl border border-warning/30 bg-surface-2 px-3 py-2.5 text-meta leading-relaxed text-fg/85">
                  Turning locking off decrypts every locked item and stores it in the clear again.{' '}
                  {legacyPasscodeOnly ? 'The passcode is removed.' : 'The device lock is removed from this vault.'}
                </p>
                {legacyPasscodeOnly ? (
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
                    tone={error ? 'danger' : 'default'}
                    hint={error ?? undefined}
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
                    disabled={busy || (legacyPasscodeOnly && passcode.length === 0)}
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
          <Section title="Protection">
            <div className="mx-4 overflow-hidden card">
              <ToggleRow
                icon={<Smartphone size={17} strokeWidth={1.9} aria-hidden />}
                label="Block screenshots and app previews"
                description="Not recommended for everyday use: it also blocks screen recording while unlocked."
                checked={settings.secureScreen}
                onChange={(value) => void update({ secureScreen: value })}
                last
              />
            </div>
          </Section>

          <Section title="Device unlock">
            <div className="mx-4 overflow-hidden card">
              <ToggleRow
                icon={<Fingerprint size={17} strokeWidth={1.9} aria-hidden />}
                label={deviceStoreKind === 'web' ? 'Use Windows Hello' : 'Use fingerprint or face'}
                description={
                  deviceAuthAvailable
                    ? deviceStoreKind === 'web'
                      ? 'Unlocking asks Windows Hello (or your device PIN) and only then unwraps the vault key from this app’s own storage.'
                      : 'A device key in Android Keystore unwraps the vault key after a successful prompt.'
                    : deviceStoreKind === 'web'
                      ? 'This computer has no prompt available yet. Set up Windows Hello or a PIN, then reload Stash.'
                      : 'No biometrics or screen lock are set up on this device.'
                }
                checked={settings.biometric && deviceUnlockReady}
                disabled={!deviceAuthAvailable}
                onChange={(value) => {
                  if (!value) {
                    void disarmBiometrics();
                    return;
                  }
                  void armBiometrics().then((result) => {
                    if (!result.ok) {
                      toast(result.message ?? 'Could not turn on device unlock', { tone: 'danger' });
                    }
                  });
                }}
                last
              />
            </div>
            {legacyPasscodeOnly && settings.biometric && deviceAuthAvailable ? (
              <p className="px-5 pt-2 text-meta leading-relaxed text-subtle">
                Unlock once with the passcode this vault was created with to arm the fast path on this device.
              </p>
            ) : null}
            {keyringPresent ? (
              <p className="px-5 pt-2 text-meta leading-relaxed text-warning">
                There is no passcode and no reset. If this device can no longer prompt — or the app&apos;s data is
                cleared — every locked item stays unreadable, on this device and in any backup of it. Everything else
                in the vault keeps working normally.
              </p>
            ) : null}
          </Section>

          <Section title="What is protected">
            <div className="mx-4 card p-4">
              <ul className="flex flex-col gap-2 text-meta leading-relaxed text-muted">
                <li>
                  <span className="font-medium text-fg">Encrypted:</span> a locked item&apos;s note title and body,
                  a locked link&apos;s address and title, and a locked folder&apos;s name. Locking a folder covers
                  everything inside it.
                </li>
                <li>
                  <span className="font-medium text-fg">Still visible:</span> that a locked item exists and where it
                  sits — it keeps its row, its place in the tree, its counts and its timestamps, and shows as a
                  locked entry you can tap to unlock. Also visible: which app a link came from, and its tags.
                </li>
                <li>
                  <span className="font-medium text-fg">Key location:</span> the vault key is wrapped by the device
                  key and only the wrapped form is stored —{' '}
                  {deviceStoreKind === 'web'
                    ? 'in this app’s own storage on this computer'
                    : 'in Android Keystore-backed storage'}
                  . It is never in the backup file&apos;s plaintext, never in a browser store, never in the app&apos;s
                  code.
                </li>
                <li>
                  <span className="font-medium text-fg">After a restart:</span> nothing is unlocked. The key comes back
                  only from that prompt, and it does not outlive the session — switching tabs or leaving Stash locks
                  the items again. Nothing else opens one: not a passcode, not a recovery code, not us.
                </li>
              </ul>
            </div>
          </Section>

          <Section title="If the device prompt stops working" className="pb-10">
            <div className="mx-4 rounded-2xl border border-danger/30 bg-danger-soft p-4">
              <p className="flex items-center gap-2 text-row font-semibold text-danger">
                <AlertTriangle size={17} strokeWidth={2} aria-hidden />
                There is no recovery
              </p>
              <p className="mt-1.5 text-meta leading-relaxed text-fg/85">
                The device prompt is the only thing that opens locked items, and Stash keeps no second secret — no
                passcode, no recovery code, no escrow. Nothing else is deleted if you never unlock again: the rest of
                your vault keeps working normally.
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
