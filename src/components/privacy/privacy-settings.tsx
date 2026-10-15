'use client';

import * as React from 'react';
import {
  AlertTriangle,
  Fingerprint,
  Lock,
  LockKeyhole,
  ShieldCheck,
  Smartphone,
} from '@/components/ui/icons';
import { pluralize } from '@/lib/format';
import { allLockRoots } from '@/lib/privacy/protection';
import { devicePromptName } from '@/lib/privacy/auth';
import {
  LEGACY_PASSCODE_EXPLANATION,
  LEGACY_PASSCODE_FIELD_LABEL,
  LEGACY_PASSCODE_HEADLINE,
} from '@/lib/privacy/legacy-passcode';
import { screenPrivacySupported } from '@/lib/privacy/screen';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Section } from '@/components/ui/page';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { PasscodeInput } from './passcode-input';
import { ConfirmAuth } from './confirm-auth';

/**
 * Privacy settings.
 *
 * Written to be read by someone deciding whether to trust the app with something
 * private, so the limitations are stated next to the controls rather than buried
 * in a policy page: what is encrypted, what stays visible, when an unlock
 * expires, and what opens the vault.
 *
 * ## How the vault opens, in one sentence
 *
 * Your device's own lock does it. There is no passcode to choose, remember or
 * lose, no hash stored anywhere, and nothing Stash verifies itself — the system
 * prompt asks, the system answers, and Stash is told. That is the same mechanism
 * a banking app uses; the difference is scope, because Stash locks a folder
 * rather than gating the whole app.
 *
 * The one cost is stated on this screen rather than implied: the key is bound to
 * this device. A wiped phone or a restore onto a new one leaves the locked items
 * locked, because nothing can unwrap them. Locking is a device property, and
 * pretending otherwise would be selling a recovery that does not exist.
 *
 * The single exception is a vault locked by an earlier build with a Stash
 * passcode. Nothing here can create one, but such a vault has to be *converted*
 * before anything else works, so the conversion appears in the one place the user
 * would look for it.
 */

type Mode = 'idle' | 'setup' | 'open-all' | 'abandon' | 'migrate';

export function PrivacySettings() {
  const ready = usePrivacyStore((state) => state.ready);
  const settings = usePrivacyStore((state) => state.settings);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);
  const legacyPasscodeOnly = usePrivacyStore((state) => state.legacyPasscodeOnly);
  const unlocked = usePrivacyStore((state) => state.unlocked);
  const deviceAuthAvailable = usePrivacyStore((state) => state.deviceAuthAvailable);
  const deviceUnlockReady = usePrivacyStore((state) => state.deviceUnlockReady);
  const deviceStoreKind = usePrivacyStore((state) => state.deviceStoreKind);
  const deviceSecurity = usePrivacyStore((state) => state.deviceSecurity);
  const busy = usePrivacyStore((state) => state.busy);

  const enableLocking = usePrivacyStore((state) => state.enableLocking);
  const unlockWithLegacyPasscode = usePrivacyStore((state) => state.unlockWithLegacyPasscode);
  const abandonLock = usePrivacyStore((state) => state.abandonLock);
  const update = usePrivacyStore((state) => state.update);
  const lock = usePrivacyStore((state) => state.lock);
  const unlockWithBiometrics = usePrivacyStore((state) => state.unlockWithBiometrics);
  const grantAll = usePrivacyStore((state) => state.grantAll);

  const protection = useVaultStore((state) => state.protection);

  const [mode, setMode] = React.useState<Mode>('idle');
  const [passcode, setPasscode] = React.useState('');
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
    setError(null);
  };

  const submitSetup = async () => {
    setError(null);
    const result = await enableLocking();
    if (!result.ok) {
      setError(result.message ?? 'Could not turn on locking.');
      return;
    }
    reset();
    toast('Locking is on. Lock any folder, note or link.', { tone: 'success' });
  };

  const submitMigration = async () => {
    const result = await unlockWithLegacyPasscode(passcode);
    setPasscode('');
    if (!result.ok) {
      setError(result.message ?? 'That passcode did not match.');
      return;
    }
    reset();
    toast('Moved to your device lock. The passcode is no longer needed.', { tone: 'success' });
  };

  /**
   * Open every boundary for this session, having authenticated first.
   *
   * The safe shape of "unlock everything": it grants what opening each folder in
   * turn would grant, it lasts exactly as long as the session lasts, and it
   * changes no setting. There is no path from here to a vault that is secretly
   * unlocked, and none to one whose protection was quietly removed.
   */
  const openEverything = async () => {
    setError(null);
    setOpening(true);
    const result = await unlockWithBiometrics();
    if (!result.ok) {
      setOpening(false);
      setError(result.message ?? 'That did not succeed.');
      return;
    }
    grantAll(everyRoot);
    setOpening(false);
    reset();
    toast('Every locked folder is open for this session', { tone: 'success' });
  };

  if (!ready) return null;

  /** The device prompt's own name, or an honest description when there is none. */
  const promptName = deviceStoreKind === 'web' ? 'Windows Hello' : 'your screen lock';

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
                    ? `${pluralize(lockedCounts.notes, 'note')}, ${pluralize(lockedCounts.links, 'link')} and ${pluralize(lockedCounts.folders, 'folder')} protected`
                    : 'Nothing is locked yet. Lock a folder, note or link to use this.'
                  : 'Turn this on, then lock any folder, note or link you want kept private. Its contents are encrypted at rest and open one item at a time.'}
              </p>
              {keyringPresent ? (
                <p className="mt-1.5 text-meta leading-relaxed text-subtle">
                  A protected folder’s contents are encrypted at rest and withheld until you ask for them:
                  opening the folder asks {promptName} for your unlock, and passing it opens that folder only.
                  Opening Stash, browsing, searching and saving links never ask for anything. Access ends when
                  you switch tabs or leave Stash.
                </p>
              ) : null}
            </div>
            {keyringPresent && unlocked && !legacyPasscodeOnly ? (
              <Button variant="surface" size="sm" onClick={() => lock()}>
                Lock now
              </Button>
            ) : null}
          </div>

          {/*
            * The conversion, and it is deliberately the first thing on the card.
            *
            * A vault in this state cannot be opened by anything else on the
            * screen: no device wrap, so no prompt, and every other action below
            * would have to refuse. Leading with the one thing that works is both
            * the clearest and the only honest ordering.
            */}
          {legacyPasscodeOnly ? (
            <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
              <div className="rounded-xl border border-warning/30 bg-surface-2 px-3 py-2.5">
                <p className="text-row font-medium text-fg">{LEGACY_PASSCODE_HEADLINE}</p>
                <p className="mt-0.5 text-meta leading-relaxed text-subtle">{LEGACY_PASSCODE_EXPLANATION}</p>
              </div>
              <PasscodeInput
                label={LEGACY_PASSCODE_FIELD_LABEL}
                value={passcode}
                onChange={(value) => {
                  setPasscode(value);
                  setError(null);
                }}
                onSubmit={() => void submitMigration()}
                disabled={busy}
                {...(error ? { tone: 'danger' as const, hint: error } : {})}
              />
              <Button
                variant="primary"
                className="w-full"
                disabled={busy || passcode.length === 0}
                onClick={() => void submitMigration()}
              >
                <ShieldCheck size={18} strokeWidth={1.9} aria-hidden />
                Move to my device lock
              </Button>
            </div>
          ) : null}

          {mode === 'idle' && !legacyPasscodeOnly ? (
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
                    <Fingerprint size={18} strokeWidth={1.9} aria-hidden />
                    Turn on locking
                  </Button>
                  <p className="px-0.5 pt-2 text-meta leading-relaxed text-subtle">
                    Locked items are encrypted with a key that lives in this device’s secure storage, and are
                    opened with {promptName} — your fingerprint, face, PIN, pattern or password, chosen inside
                    the system prompt. There is no Stash password to create or forget, and your vault is never
                    readable without that prompt.
                    {deviceSecurity === 'insecure'
                      ? ' This device has no screen lock yet, so set one up first — otherwise a lock here could never be opened.'
                      : deviceStoreKind === 'web'
                        ? ' This computer asks for Windows Hello or your device PIN.'
                        : ' The choice between a fingerprint and your PIN belongs to the system prompt: it is offered there, whether or not biometrics are enrolled.'}
                  </p>
                </>
              ) : (
                <div className="flex flex-col gap-2">
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
                  {/*
                    * There is deliberately no "turn locking off".
                    *
                    * It was the one action in the app that unsealed content: it
                    * decrypted every locked item back into the clear and removed
                    * both ways in — a single switch that undid the protection the
                    * user had asked for, on an unlocked phone. What a person
                    * actually needs from this screen is to open what is locked for
                    * a while (above), and the irreversible one is still here at
                    * the bottom, named for what it costs rather than for what it
                    * turns off.
                    */}
                </div>
              )}
            </div>
          ) : null}

          {mode === 'setup' ? (
            <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
              <p className="px-0.5 text-meta leading-relaxed text-subtle">
                Nothing to choose here: a random 256-bit key is generated for this vault, and a second one is
                stored in {deviceStoreKind === 'web' ? 'this machine' : 'this device'}’s secure storage to open
                it. Locked items are already protected the same way you are about to use — this only adds the
                key that opens them.
              </p>
              {error ? (
                <p className="px-0.5 text-meta leading-relaxed text-danger" role="status">
                  {error}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={reset} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  className="flex-[1.4]"
                  disabled={busy}
                  onClick={() => void submitSetup()}
                >
                  <Fingerprint size={18} strokeWidth={1.9} aria-hidden />
                  Turn on locking
                </Button>
              </div>
            </div>
          ) : null}

          {mode === 'open-all' ? (
            <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
              <p className="rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-meta leading-relaxed text-fg/85">
                This opens {pluralize(lockedCounts.folders, 'folder')} and everything inside them for this
                session. It does not turn locking off, does not decrypt anything on disk and does not change
                which folders are protected — leave Stash, and they are locked again.
              </p>
              {devicePath ? (
                <Button
                  variant="accentSoft"
                  className="w-full"
                  disabled={opening}
                  onClick={() => void openEverything()}
                >
                  <Fingerprint size={18} strokeWidth={1.9} aria-hidden />
                  Confirm with {devicePromptName(deviceStoreKind)}
                </Button>
              ) : (
                <p className="px-0.5 text-meta leading-relaxed text-danger">
                  This device cannot ask for an unlock, so nothing can be opened here.
                </p>
              )}
              {error ? (
                <p className="px-0.5 text-meta leading-relaxed text-danger" role="status">
                  {error}
                </p>
              ) : null}
              <Button variant="ghost" className="w-full" onClick={reset} disabled={opening}>
                Cancel
              </Button>
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
                  <span className="font-medium text-fg">How it opens:</span> the operating system verifies you —
                  a fingerprint, face, or the device PIN, pattern or password — and Stash never sees any of them.
                  Stash holds no password, stores no hash and cannot check a credential itself; the prompt&apos;s
                  answer releases a key from{' '}
                  {deviceStoreKind === 'web' ? 'this machine’s own storage' : 'Android’s Keystore-backed storage'},
                  and only that key decrypts a locked item.
                </li>
                <li>
                  <span className="font-medium text-fg">After a restart:</span> nothing is unlocked. A key comes back
                  only from the prompt, and it does not outlive the session — switching tabs or leaving Stash locks
                  the items again.
                </li>
              </ul>
            </div>
          </Section>

          <Section title="If you cannot unlock" className="pb-10">
            <div className="mx-4 rounded-2xl border border-danger/30 bg-danger-soft p-4">
              <p className="flex items-center gap-2 text-row font-semibold text-danger">
                <AlertTriangle size={17} strokeWidth={2} aria-hidden />
                The key is bound to this device
              </p>
              <p className="mt-1.5 text-meta leading-relaxed text-fg/85">
                There is no reset and no escrow, and no password to fall back on: the key that decrypts a locked
                item exists only in this device&apos;s secure storage, behind the system prompt. Wipe the phone,
                lose it, or restore your vault onto a new one, and those items stay unreadable there — everything
                else keeps working normally, and nothing is deleted.
              </p>
              <p className="mt-2 text-meta leading-relaxed text-fg/85">
                Removing the lock below destroys that key on purpose. It is the honest choice only when you would
                rather have an empty lock than a lock you cannot open.
              </p>
              {mode === 'abandon' ? (
                <div className="mt-3">
                  <ConfirmAuth
                    reason="Destroy the lock on your Stash vault"
                    confirmLabel="Remove the lock permanently"
                    tone="danger"
                    hint={
                      <>
                        Removing the lock destroys the key. Every locked note, link and folder becomes permanently
                        unreadable and cannot be recovered on any device. Your other content is untouched.
                      </>
                    }
                    onAuthorized={async () => {
                      await abandonLock();
                      reset();
                      toast('Lock removed. Locked items are now unreadable.', { tone: 'danger' });
                    }}
                    onCancel={reset}
                  />
                </div>
              ) : (
                <Button variant="surface" className="mt-3 w-full" onClick={() => setMode('abandon')}>
                  Remove the lock
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
