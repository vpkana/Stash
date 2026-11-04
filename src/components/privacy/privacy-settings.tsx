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
import { allLockRoots, isSealed } from '@/lib/privacy/protection';
import { devicePromptName } from '@/lib/privacy/auth';
import {
  LEGACY_PASSCODE_EXPLANATION,
  LEGACY_PASSCODE_FIELD_LABEL,
  LEGACY_PASSCODE_HEADLINE,
} from '@/lib/privacy/legacy-passcode';
import { screenPrivacySupported } from '@/lib/privacy/screen';
import { GOOGLE_SYNC_ENABLED } from '@/lib/sync/availability';
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
 * The cost is stated on this screen rather than implied: the device wrap is bound
 * to this device, so a wiped phone or a restore onto a new one cannot open the
 * locked items by itself. The way back is the optional recovery key — held only
 * by the user, published as ciphertext to their own Drive when sync is on — and
 * it still does not bypass the device prompt. Locking that has neither a recovery
 * key nor this device is a real dead end, and the screen says that in those
 * words rather than selling a recovery that does not exist.
 *
 * The single exception is a vault locked by an earlier build with a Stash
 * passcode. Nothing here can create one, but such a vault has to be *converted*
 * before anything else works, so the conversion appears in the one place the user
 * would look for it.
 */

type Mode = 'idle' | 'setup' | 'open-all' | 'remove-all' | 'migrate';

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
  const disable = usePrivacyStore((state) => state.disable);
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

  /**
   * Rows that are still ciphertext in the vault.
   *
   * While the session is locked that is every locked row, so this is only
   * meaningful while a key is in hand — then it means exactly one thing: content
   * sealed under a key this device does not have, which no prompt here can open.
   * Said out loud instead of leaving the user tapping a locked row that will never
   * open, or worse, wondering where their links went.
   */
  const unreadable = useVaultStore(
    (state) => state.links.filter(isSealed).length + state.notes.filter(isSealed).length,
  );
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
                <>
                  <p className="mt-1.5 text-meta leading-relaxed text-subtle">
                    A protected folder’s contents are encrypted at rest and withheld until you ask for them:
                    opening the folder asks {promptName} for your unlock, and passing it opens that folder only.
                    Opening Stash, browsing, searching and saving links never ask for anything.
                  </p>
                  <div role="radiogroup" aria-label="Keep unlocked" className="mt-3 grid gap-2">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={settings.sessionEndPolicy === 'tab-change'}
                      onClick={() => void update({ sessionEndPolicy: 'tab-change' })}
                      className={cn(
                        'w-full rounded-xl border px-3 py-2.5 text-left transition-colors',
                        settings.sessionEndPolicy === 'tab-change'
                          ? 'border-accent bg-accent-soft'
                          : 'border-border bg-surface-2',
                      )}
                    >
                      <span className="block text-row font-medium text-fg">Until you change tabs</span>
                      <span className="mt-0.5 block text-meta leading-relaxed text-subtle">
                        Locks when you switch sections or leave Stash.
                      </span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={settings.sessionEndPolicy === 'app-close'}
                      onClick={() => void update({ sessionEndPolicy: 'app-close' })}
                      className={cn(
                        'w-full rounded-xl border px-3 py-2.5 text-left transition-colors',
                        settings.sessionEndPolicy === 'app-close'
                          ? 'border-accent bg-accent-soft'
                          : 'border-border bg-surface-2',
                      )}
                    >
                      <span className="block text-row font-medium text-fg">Until you close Stash</span>
                      <span className="mt-0.5 block text-meta leading-relaxed text-subtle">
                        Stays unlocked across tabs and in the background. Locks when Stash restarts.
                      </span>
                    </button>
                  </div>
                </>
              ) : null}
              {unlocked && unreadable > 0 ? (
                <p className="mt-1.5 text-meta leading-relaxed text-warning">
                  {unreadable} item(s) here are locked with a key this device does not have — they arrived in a
                  backup from another device. Unlocking cannot open them, and they are kept rather than deleted.
                </p>
              ) : null}
            </div>
            {/* {keyringPresent && unlocked && !legacyPasscodeOnly ? (
              <Button variant="surface" size="sm" onClick={() => lock()}>
                Lock now
              </Button>
            ) : null} */}
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
                    Locked items are encrypted on this device and unlocked with {promptName}. No Stash password
                    needed.
                    {deviceSecurity === 'insecure'
                      ? ' Set up a screen lock first to use this feature.'
                      : deviceStoreKind === 'web'
                        ? ' Use Windows Hello or your device PIN to unlock.'
                        : ' Your system prompt determines the available unlock methods.'}
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

          <Section title="" className="pb-10">
            <div className="mx-4 rounded-2xl border border-danger/30 bg-danger-soft p-4">
              <p className="flex items-center gap-2 text-row font-semibold text-danger">
                <AlertTriangle size={17} strokeWidth={2} aria-hidden />
                Unlock Every Lock in this app
              </p>
              <p className="mt-1.5 text-meta leading-relaxed text-fg/85">
                Locked items need this device&apos;s secure storage. Without it or a recovery key, they can&apos;t be
                opened on another device.
              </p>
              {GOOGLE_SYNC_ENABLED ? (
                <p className="mt-2 text-meta leading-relaxed text-fg/85">
                  Set up a recovery key in Google Drive sync before you need it. Keep it safe; Stash can&apos;t
                  recover it.
                </p>
              ) : null}
              <p className="mt-2 text-meta leading-relaxed text-fg/85">
                Remove locks from items this device can unlock. Content stays unchanged; items encrypted with
                another key remain locked.
              </p>
              {mode === 'remove-all' ? (
                <div className="mt-3">
                  <ConfirmAuth
                    reason="Remove every lock from your Stash vault"
                    confirmLabel="Unlock everything and remove the locks"
                    tone="danger"
                    hint={
                      <>
                        Your device prompt opens every locked folder, note and link, and the locks are removed. Your
                        content keeps its address, title and place — nothing is deleted.
                      </>
                    }
                    onAuthorized={async () => {
                      const result = await disable();
                      reset();
                      if (result.ok) {
                        toast('Every lock is removed. Your folders, notes and links are readable again.', {
                          tone: 'success',
                        });
                      } else {
                        toast(result.message ?? 'The locks were removed, but some items could not be opened.', {
                          tone: 'danger',
                        });
                      }
                    }}
                    onCancel={reset}
                  />
                </div>
              ) : (
                <Button variant="surface" className="mt-3 w-full" onClick={() => setMode('remove-all')}>
                  Remove every lock
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
