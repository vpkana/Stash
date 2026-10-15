'use client';

import { create } from 'zustand';
import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettings } from '@/db/types';
import { getPrivacySettings, setPrivacySettings } from '@/db/repos/settings';
import { getDeviceAuthenticator, type DeviceSecurity } from '@/lib/privacy/auth';
import {
  adoptVaultKeyForDevice,
  createDeviceKeyring,
  destroyKeyring,
  dropLegacyPasscodeWrap,
  ensureDeviceCredential,
  forgetVaultKey,
  hasKeyring,
  isDeviceUnlockReady,
  isSessionLocked,
  unlockWithDevice,
} from '@/lib/privacy/keyring';
import {
  hasLegacyPasscodeWrap,
  isPasscodeOnlyVault,
  openWithLegacyPasscode,
} from '@/lib/privacy/legacy-passcode';
import { getSecureStore } from '@/lib/privacy/secure-store';
import { clearEveryLock, countLocks, countSealed, reconcileProtection as reconcile, unsealEverything } from '@/lib/privacy/reconcile';
import { applyScreenPrivacy } from '@/lib/privacy/screen';
import { shouldLockOnTabChange, shouldRelock } from '@/lib/privacy/session';

/**
 * The privacy session.
 *
 * Everything here is a *statement about the current process*, never persisted:
 * whether a keyring exists, whether the vault key is currently in memory, when
 * the app was last backgrounded. The key itself is not in this store — it lives
 * inside `keyring.ts`, module-scoped, so a state dump or a devtools snapshot
 * cannot reach it. `unlocked` here is a mirror for rendering, and the authority
 * is always `isSessionLocked()`.
 *
 * Stash has no lock screen over the app. The app always opens, and nothing in it
 * is gated: what is protected is *content*, and the only thing that ever asks for
 * a credential is crossing into a protected folder or item. Launching, browsing
 * Home, searching, saving a link or arriving from the Android share sheet all
 * happen with no prompt at all, however many locked folders the vault contains.
 *
 * ## One way in, and the device owns it
 *
 * A locked item is opened by the operating system, not by Stash. There is no
 * passcode, no hash, no verifier and no second secret anywhere in the app: the
 * prompt is `BiometricPrompt` (or Windows Hello on a desktop) configured with
 * `allowDeviceCredential`, which is what gives the person a fingerprint or face
 * **and** a button for their own screen-lock credential inside one system dialog
 * — including when biometrics are enrolled and they would rather type their PIN.
 * See `auth.ts`, which documents that choice and the plugin constraints behind it.
 *
 * ## The rule for a device with no screen lock
 *
 * A lock Stash cannot enforce is worse than no lock: it hides content behind a
 * prompt that will never appear, so an unrecoverable lockout is one settings
 * change away. So on every app open the app asks the platform whether this device
 * has any kind of screen lock at all — fingerprint, face, PIN, pattern or
 * password, as opposed to none — and when the answer is no, it *removes* the
 * locks it can no longer stand behind, unsealing their content first so nothing
 * is stranded, and says so. {@link enforceDeviceSecurity} is that policy.
 *
 * `grantedRoots` is the access model, and it is per item. Passing the prompt for
 * `Private` opens `Private` and its descendants and leaves every other locked
 * folder exactly as closed as it was. The vault key is one key — so the seal is
 * all-or-nothing at rest — but *access* is decided one boundary at a time, which
 * is what makes the lock a property of a folder rather than of the app.
 *
 * The session is deliberately short-lived: it ends on the next tab change and the
 * moment the app stops being visible (see `handleBackground` / `lockOnTabChange`).
 * Locking is cheap and idempotent, and it can never destroy data — the keyring is
 * untouched.
 */

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export type DeviceStoreKind = 'native' | 'web' | 'unavailable';
export type RevealKind = 'folder' | 'note' | 'link';

export interface RevealRequest {
  kind: RevealKind;
  id: string;
  /**
   * The locked node this request is asking to cross into.
   *
   * Carried with the request because it is the thing the gate grants on success:
   * one vault key exists, so "unlock" is technically all-or-nothing, but what the
   * user asked for is *this* folder, and granting anything else would open content
   * they never asked to see.
   */
  root: string | null;
}

/** What a caller is asking for when it wants to see a protected item. */
export interface AccessRequest {
  kind: RevealKind;
  id: string;
  /** `lockRootOf(protection, kind, id)`, or `null` when nothing protects it. */
  root: string | null;
}

/**
 * The message shown after the app removes locks a device can no longer enforce.
 *
 * `removed` is the outcome the policy is designed to reach, and it is not the
 * only possible one, which is why this is a description rather than a sentence.
 * `blocked` means there was locked content on a device with no screen lock and no
 * device key that could open it — the one case where removing the locks would
 * destroy the content behind them, so the app keeps the locks and asks for the
 * legacy passcode once instead. Both are reported honestly; neither is silent.
 */
export interface NoScreenLockNotice {
  outcome: 'removed' | 'blocked';
  /** Lock flags that were cleared. */
  locksCleared: { folders: number; notes: number; links: number };
  /** Sealed rows whose content was decrypted back into the clear. */
  opened: { folders: number; notes: number; links: number };
  /** Rows that could not be opened. Non-zero only on `blocked`, and never lost. */
  unreadable: number;
}

export interface PrivacyState {
  ready: boolean;
  settings: PrivacySettings;
  /** True once a keyring row exists, i.e. locking has been set up. */
  keyringPresent: boolean;
  /**
   * True when this vault can be opened by one thing only: the passcode an earlier
   * build asked for. Not a state the app can enter — see `legacy-passcode.ts` —
   * only one it can be found in, and the gate offers to convert it.
   */
  legacyPasscodeOnly: boolean;
  /**
   * Whether this vault still carries *any* old passcode wrap — including one
   * alongside a device wrap.
   *
   * Deliberately a different fact from {@link legacyPasscodeOnly}. A keyring with
   * both wraps is opened by the device prompt, and `unlockWithDevice` drops the
   * passcode wrap silently the moment that path works; this flag exists only so
   * the gate can offer the passcode as a *fallback* when the device path is
   * unavailable or has just failed. Reading it as "the passcode is the way in" is
   * the mistake that made an unlock ask for a password it did not need.
   */
  legacyPasscodeAvailable: boolean;
  /** Where the device key lives, so the copy can be specific rather than vague. */
  deviceStoreKind: DeviceStoreKind;
  unlocked: boolean;
  /** Whether this device can prompt for biometric or device-credential auth. */
  deviceAuthAvailable: boolean;
  /** Whether the device wrap is in place and its key is present here. */
  deviceUnlockReady: boolean;
  /** What this device's own screen lock amounts to. See `enforceDeviceSecurity`. */
  deviceSecurity: DeviceSecurity;
  /** The removal that the last app-open check performed, if it performed one. */
  noScreenLockNotice: NoScreenLockNotice | null;
  /** When the app went to the background, for the re-lock policy. */
  backgroundedAt: number | null;
  /**
   * When the session was last unlocked, or `null` while it is locked.
   *
   * Read for exactly one decision — whether a navigation belongs to the unlock
   * that just happened or is the user moving on (see `lockOnTabChange`).
   */
  unlockedAt: number | null;
  /**
   * Which locked boundaries have been opened in this session.
   *
   * That is the whole of Stash's access model, and it is deliberately a *set*:
   * passing the prompt for `Private` opens `Private` and everything inside it,
   * and leaves `Banking` — a different locked folder — exactly as closed as it
   * was. There is no app-wide unlock, so a locked folder somewhere in the vault
   * can never be the reason a capture, a search or a launch asks for anything.
   *
   * A new array on every grant, so a subscriber can compare by reference.
   */
  grantedRoots: string[];
  /** Explanation of the last failed unlock, shown on the gate. */
  message: string | null;
  /**
   * Something the user tapped while it was locked.
   *
   * Set by `requestAccess` so the gate can be raised for *this* reason — "open
   * the locked thing you tapped" — even when locking is configured not to cover
   * the whole app, which is the case where nothing else would prompt.
   */
  revealRequest: RevealRequest | null;
  busy: boolean;

  initialize: () => Promise<void>;
  /**
   * Re-read everything after the vault changed underneath us — an import that
   * replaced the keyring, or installed a locked subtree. Starts locked.
   */
  reload: () => Promise<void>;
  /** Re-read capabilities after they could have changed (resume, settings). */
  refreshCapabilities: () => Promise<void>;
  /**
   * Turn locking on.
   *
   * There is nothing to choose: a 256-bit key goes into this device's secure
   * storage and the vault key is wrapped under it. Refuses when this device has
   * no screen lock at all, because a lock created there could never be opened —
   * the one moment where saying no is the kind thing.
   */
  enableLocking: () => Promise<ActionResult>;
  /**
   * Make sure locking exists, for the first time something is locked.
   *
   * Idempotent, and deliberately separate from {@link enableLocking}: that one is
   * the settings switch and refuses when locking is already on, because a silent
   * second setup would replace a key in use. This one is what the "Lock this
   * folder" action calls, where the user has expressed no interest in the
   * mechanics — if locking is already set up it does nothing at all, and if it is
   * not, the folder they just asked to lock is the reason to set it up.
   */
  ensureLocking: () => Promise<ActionResult>;
  /**
   * Convert a vault that an earlier build locked with a Stash passcode.
   *
   * The passcode is used once to unwrap the vault key, which is immediately
   * re-wrapped for this device and has its passcode wrap deleted. Afterwards the
   * passcode does nothing and is never asked for again. Present because deleting
   * the reader would have made that content permanently unreadable, not because
   * there is a password system: no screen in the app can create a passcode.
   */
  unlockWithLegacyPasscode: (passcode: string) => Promise<ActionResult>;
  /**
   * Prove that the person at the device may act, before anything irreversible.
   *
   * One function, because there is one question — "is this the owner?" — and one
   * way to answer it: the system prompt. A vault this device cannot prompt for is
   * a vault whose destructive actions cannot be authorised here, and the answer
   * says so rather than offering a weaker substitute.
   */
  authorize: (reason: string) => Promise<ActionResult>;
  /**
   * End locking: opens every sealed row, then removes the keyring.
   *
   * A change to the vault, so the caller must have authorised it. Distinct from
   * `abandonLock`, and the distinction is the whole point: this one preserves the
   * content and removes the protection, while that one removes the protection by
   * destroying the content.
   */
  disable: () => Promise<ActionResult>;
  /**
   * Pass the system prompt and open one lock boundary.
   *
   * `root` is the locked node the user asked for. Omit it to open the queued
   * reveal request instead, which is what the gate's own button does.
   */
  unlockWithBiometrics: (root?: string | null) => Promise<ActionResult>;
  /**
   * Ask to cross a lock boundary: prompt the device if it can, otherwise queue
   * the request so the gate opens for it. Resolves `ok` only when access was
   * actually granted, which is the caller's signal to continue with what it was
   * doing — and the reason a failed prompt opens nothing.
   */
  requestAccess: (request: AccessRequest) => Promise<ActionResult>;
  /** Remember that one locked node has been opened for this session. */
  grant: (root: string) => void;
  /**
   * Open every lock boundary at once, for this session only.
   *
   * The deliberate, authenticated "open everything". It takes the roots to grant
   * from the caller so nothing here has to know about the vault's shape, and it
   * changes **no configuration**: no lock flag is cleared, no keyring is touched,
   * no sealed row is rewritten. Leaving the screen, switching tabs or
   * backgrounding the app ends it exactly like any other unlock.
   *
   * It is not a bypass: the caller must have authenticated first, and the
   * simplest way to see that it is safe is that it grants nothing a user could
   * not get by opening each locked folder in turn.
   */
  grantAll: (roots: readonly string[]) => void;
  /** End every open boundary at once. Called on lock, tab change and background. */
  clearGrants: () => void;
  /** Bring the database's encryption back in step with the lock flags. */
  reconcile: () => Promise<void>;
  clearReveal: () => void;
  lock: () => void;
  /**
   * End the unlocked session when the user moves to another tab.
   *
   * Called by the shell on every top-level navigation. Opening the thing a reveal
   * just unlocked is not leaving — the grace in `session.ts` covers that one
   * navigation — but going to a different tab always ends the session.
   */
  lockOnTabChange: (now?: number) => void;
  handleBackground: (now?: number) => void;
  /** Returns true when the policy expired the session on the way back in. */
  handleForeground: (now?: number) => boolean;
  /**
   * The rule for a device with no screen lock: remove what cannot be enforced.
   *
   * Run on every app open and on every return to the foreground. When the device
   * has no screen lock of any kind, locks and sealed content are unsealed and
   * released, and the outcome is published in {@link noScreenLockNotice} for the
   * UI to explain. Unsealing first is what makes this safe: the only failure that
   * matters — clearing a lock flag for content that is still ciphertext — cannot
   * happen, because the lock is only cleared after the plaintext is back.
   *
   * Never fires on `'unknown'`. A browser cannot see the OS screen lock, and a
   * failed platform call is not evidence of anything, so neither is allowed to
   * destroy protection.
   */
  enforceDeviceSecurity: () => Promise<void>;
  dismissNoScreenLockNotice: () => void;
  /**
   * Destroy the keyring without unsealing anything.
   *
   * The keyring is deleted and anything sealed stays sealed and permanently
   * unreadable — this is a *loss*, not a bypass, and it never reveals a locked
   * item. It is offered only as a described, deliberate last resort, and the
   * caller must have authorised it first: destroying the lock is a change to the
   * vault, and no change to the vault is a single unauthenticated tap.
   */
  abandonLock: () => Promise<void>;
  update: (patch: Partial<PrivacySettings>) => Promise<void>;
  clearMessage: () => void;
}

/**
 * What would it take to open this vault: is the old passcode the *only* way in,
 * is there one at all, and where does the device key live.
 *
 * Asked together because they are read together. The first two are not the same
 * question, and telling them apart is the whole fix for a lock that asked for a
 * password the user never set: only a passcode-*only* keyring justifies leading
 * with the conversion prompt. A vault that has a device wrap as well is opened by
 * the device, and its leftover passcode wrap is dropped on the next successful
 * device unlock rather than being put in front of anyone.
 */
async function describeKeyring(
  present: boolean,
): Promise<[legacyPasscodeOnly: boolean, legacyPasscodeAvailable: boolean, deviceStoreKind: DeviceStoreKind]> {
  const store = await getSecureStore();
  if (!present) return [false, false, store.kind];
  const [onlyWayIn, anyPasscodeWrap] = await Promise.all([
    isPasscodeOnlyVault(),
    hasLegacyPasscodeWrap(),
  ]);
  return [onlyWayIn, anyPasscodeWrap, store.kind];
}

/**
 * Screen privacy follows the session: always on while locked, and on while
 * unlocked only when the user asked for it.
 */
function syncScreenPrivacy(secureWhileUnlocked: boolean, unlocked: boolean): void {
  void applyScreenPrivacy(!unlocked || secureWhileUnlocked);
}

/**
 * Open every sealed row, clear every lock flag, and drop the keyring.
 *
 * The shared ending of the two situations where a lock has to go: the user asked
 * for it, and the device cannot enforce it. Same three writes in the same order,
 * for the same reason — unseal first, so a cleared flag can never point at content
 * that is still ciphertext — and one implementation, so the two cannot drift into
 * disagreeing about what "the locks are off" means.
 *
 * The counts are returned rather than logged: both callers report them.
 */
async function releaseEveryLock(): Promise<{
  cleared: { folders: number; notes: number; links: number };
  opened: { folders: number; notes: number; links: number };
} | null> {
  const unsealed = await unsealEverything();
  const still = await countSealed();
  // Returning before anything is written is the whole safety property of this
  // function: no flag is cleared and no keyring is destroyed while a row is still
  // ciphertext, because that combination is a lock that is *gone* while its
  // content is unreachable — strictly worse than either state on its own.
  if (still.folders + still.notes + still.links > 0) return null;

  const cleared = await clearEveryLock();
  await destroyKeyring();
  return { cleared, opened: unsealed.opened };
}

export const usePrivacyStore = create<PrivacyState>((set, get) => ({
  ready: false,
  settings: { ...DEFAULT_PRIVACY_SETTINGS },
  keyringPresent: false,
  legacyPasscodeOnly: false,
  legacyPasscodeAvailable: false,
  deviceStoreKind: 'unavailable',
  // Starts locked. On a cold start nothing is unlocked until the user says so,
  // which is what makes "after app restart the vault is locked" true by default
  // rather than by remembering to set a flag.
  unlocked: false,
  deviceAuthAvailable: false,
  deviceUnlockReady: false,
  deviceSecurity: 'unknown',
  noScreenLockNotice: null,
  backgroundedAt: null,
  unlockedAt: null,
  grantedRoots: [],
  message: null,
  revealRequest: null,
  busy: false,

  initialize: async () => {
    if (get().ready) return;
    let settings: PrivacySettings;
    let keyring: boolean;
    try {
      [settings, keyring] = await Promise.all([getPrivacySettings(), hasKeyring()]);
    } catch (error) {
      // The vault itself could not be read; `BootGate` is already reporting that.
      // Marking the session ready keeps the boot from waiting on a promise that
      // will never resolve. Defaults are the safe ones: no keyring is assumed,
      // but the vault read decided what is visible, not this flag.
      console.warn('[stash] privacy settings unavailable', error);
      set({ ready: true, settings: { ...DEFAULT_PRIVACY_SETTINGS } });
      return;
    }

    const authenticator = await getDeviceAuthenticator();
    // A capability, not a setting: "this machine could prompt" decides whether
    // locking can be offered at all.
    const deviceAuthAvailable = await authenticator.isAvailable();
    const deviceUnlockReady = keyring ? await isDeviceUnlockReady() : false;
    const [legacyPasscodeOnly, legacyPasscodeAvailable, deviceStoreKind] = await describeKeyring(keyring);

    // With no keyring there is nothing to protect, so the session starts open.
    // With one, it starts locked: a cold start never inherits the last session's
    // key, which is what makes "locked after a restart" be the default rather
    // than something remembered.
    const unlocked = !keyring;

    set({
      ready: true,
      settings,
      keyringPresent: keyring,
      legacyPasscodeOnly,
      legacyPasscodeAvailable,
      deviceStoreKind,
      deviceAuthAvailable,
      deviceUnlockReady,
      unlocked,
      // Nothing was unlocked by a person here: a vault with no keyring starts
      // open because there is nothing to protect, not because it was opened. No
      // boundary has been crossed either, which is why the grants start empty
      // even when the key is present.
      unlockedAt: null,
      grantedRoots: [],
    });
    syncScreenPrivacy(settings.secureScreen, unlocked);

    // Every app open asks whether this device can still enforce a lock. Awaited
    // rather than fired and forgotten, so the state a screen reads on its first
    // render is already the post-check one.
    await get().enforceDeviceSecurity();
  },

  reload: async () => {
    // The bytes that were encrypted in memory belong to the vault that was just
    // replaced, so they are dropped before anything is re-read. Starting locked
    // is the conservative direction: the worst case is one extra unlock.
    forgetVaultKey();

    const [settings, keyring] = await Promise.all([getPrivacySettings(), hasKeyring()]);
    const authenticator = await getDeviceAuthenticator();
    const deviceAuthAvailable = await authenticator.isAvailable();
    const deviceUnlockReady = keyring ? await isDeviceUnlockReady() : false;
    const [legacyPasscodeOnly, legacyPasscodeAvailable, deviceStoreKind] = await describeKeyring(keyring);

    set({
      ready: true,
      settings,
      keyringPresent: keyring,
      legacyPasscodeOnly,
      legacyPasscodeAvailable,
      deviceStoreKind,
      deviceAuthAvailable,
      deviceUnlockReady,
      unlocked: !keyring,
      backgroundedAt: null,
      unlockedAt: null,
      grantedRoots: [],
      // A queued reveal belongs to the vault that was just replaced. Carrying it
      // over would raise the gate for an item that may not exist any more.
      revealRequest: null,
      message: null,
    });
    syncScreenPrivacy(settings.secureScreen, !keyring);
  },

  /**
   * Settle the database's encryption against the lock flags, once a key exists.
   *
   * Called on every path where the vault key becomes available. It is what keeps
   * "locked means sealed on disk" true for a vault this build did not write —
   * most visibly, folder names that an earlier build stored as ciphertext are
   * rewritten in the clear here, because a folder name is now the label on the
   * lock rather than part of the secret.
   *
   * Never allowed to fail the unlock: the key is already in memory and the vault
   * is already readable, so a reconciliation problem is a deferred tidy-up, not a
   * reason to refuse the user.
   */
  reconcile: async () => {
    try {
      await reconcile();
    } catch (error) {
      console.warn('[stash] could not settle the lock state after unlocking', error);
    }
  },

  refreshCapabilities: async () => {
    const authenticator = await getDeviceAuthenticator();
    const deviceAuthAvailable = await authenticator.isAvailable();
    const [legacyPasscodeOnly, legacyPasscodeAvailable, deviceStoreKind] = await describeKeyring(get().keyringPresent);
    set({
      deviceAuthAvailable,
      deviceUnlockReady: await isDeviceUnlockReady(),
      legacyPasscodeOnly,
      legacyPasscodeAvailable,
      deviceStoreKind,
    });
    /*
     * Back from the background: this is the moment a screen lock could have been
     * removed in Android settings while Stash was in the task switcher, so the
     * question is asked again.
     *
     * Skipped when a notice is already on screen, because a modal that reappears
     * every time somebody switches apps is not a warning, it is a nuisance — and
     * the state it describes has not changed since they read it.
     */
    if (get().noScreenLockNotice === null) await get().enforceDeviceSecurity();
  },

  enforceDeviceSecurity: async () => {
    const authenticator = await getDeviceAuthenticator();
    const security = await authenticator.security();
    set({ deviceSecurity: security });

    // `'unknown'` and `'secure'` both mean "leave the locks alone". The first is
    // a platform that cannot be asked, and acting on it would remove protection
    // on a machine that may be perfectly well locked.
    if (security !== 'insecure') return;

    /*
     * Nothing to enforce a lock against. An installer that failed leaves the
     * keyring unreadable while the settings row still says locking is on, and in
     * that case there are no lock flags left to clear either.
     */
    const locks = await countLocks();
    const locksTotal = locks.folders + locks.notes + locks.links;
    if (!get().keyringPresent && locksTotal === 0) return;

    /*
     * Open the vault before touching a single lock flag.
     *
     * No prompt is attempted — there is no screen lock, so the OS has nothing to
     * ask with, and calling it would produce a failure that says nothing about
     * the data. The device key is read directly; on a vault that has one, that is
     * enough to reach the plaintext.
     */
    const key = await unlockWithDevice();

    if (key) {
      // One pass, and its report is the one that gets published: a second would
      // find nothing left to open and quietly report zeroes for content it had
      // just released. `null` means a row would not open, and then nothing at all
      // has been changed — see `releaseEveryLock`.
      const released = await releaseEveryLock();
      if (!released) {
        const still = await countSealed();
        set({
          noScreenLockNotice: {
            outcome: 'blocked',
            locksCleared: { folders: 0, notes: 0, links: 0 },
            opened: { folders: 0, notes: 0, links: 0 },
            unreadable: still.folders + still.notes + still.links,
          },
        });
        return;
      }

      const settings = get().settings;

      set({
        keyringPresent: false,
        legacyPasscodeOnly: false,
        legacyPasscodeAvailable: false,
        deviceUnlockReady: false,
        unlocked: true,
        unlockedAt: null,
        // A fresh array, so the vault's subscription re-reads: the rows that were
        // hidden a moment ago are ordinary content now, and every listing has to
        // be told rather than waiting for a navigation.
        grantedRoots: [],
        revealRequest: null,
        message: null,
        noScreenLockNotice: {
          outcome: 'removed',
          locksCleared: released.cleared,
          opened: released.opened,
          unreadable: 0,
        },
      });
      syncScreenPrivacy(settings.secureScreen, true);
      return;
    }

    /*
     * No device key, and something is locked or sealed. That combination has
     * exactly one honest answer: the content is sitting behind a passcode an
     * earlier build asked for, and this device cannot open it by itself. The
     * locks are *kept* — removing them here would destroy what they protect — and
     * the user is asked for that passcode once, which converts the vault and
     * makes the question go away for good.
     */
    set({
      noScreenLockNotice: {
        outcome: 'blocked',
        locksCleared: { folders: 0, notes: 0, links: 0 },
        opened: { folders: 0, notes: 0, links: 0 },
        unreadable: locksTotal,
      },
    });
  },

  dismissNoScreenLockNotice: () => set({ noScreenLockNotice: null }),

  enableLocking: async () => {
    set({ busy: true, message: null });

    /*
     * Refused on a device with no screen lock, and this is the guard the whole
     * policy rests on: a vault wrapped for this device can only be opened by the
     * device prompt, so creating one where the prompt cannot appear would seal
     * content behind a door with no handle. Saying no now costs nothing.
     */
    const authenticator = await getDeviceAuthenticator();
    if (!(await authenticator.isAvailable())) {
      const message =
        await authenticator.security() === 'insecure'
          ? 'Add a screen lock to this device first — a PIN, pattern, password, fingerprint or face. Without one, nothing could open a locked item.'
          : 'This device cannot prompt for an unlock, so locking cannot be set up here.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    const result = await createDeviceKeyring();
    if (!result.ok) {
      set({ busy: false, message: result.message ?? null });
      return { ok: false, message: result.message };
    }

    // On a desktop the prompt is a WebAuthn credential and nothing can be asked
    // for until one is enrolled, so arming the key includes enrolling it. A
    // platform that cannot enrol leaves the vault locked with no way in, so it is
    // undone rather than left half-built.
    const enrolled = await ensureDeviceCredential();
    if (!enrolled) {
      await destroyKeyring();
      const message = 'This computer could not enrol Windows Hello or a device PIN, so nothing was set up.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    const settings = await setPrivacySettings({ enabled: true, biometric: true });
    set({
      busy: false,
      settings,
      keyringPresent: true,
      legacyPasscodeOnly: false,
      legacyPasscodeAvailable: false,
      deviceUnlockReady: true,
      unlocked: true,
      unlockedAt: Date.now(),
      message: null,
    });
    syncScreenPrivacy(settings.secureScreen, true);
    await get().refreshCapabilities();
    return { ok: true };
  },

  ensureLocking: async () => {
    // Asked of the keyring rather than the cached flag: an import can install a
    // keyring underneath us, and "is there anything to set up" is a fact about
    // the key, not about the last render.
    if (get().keyringPresent || (await hasKeyring())) {
      /*
       * A vault whose old passcode wrap is still the only thing that opens it
       * must not take on *new* locks.
       *
       * Reusing such a keyring would seal the item the user just asked to lock
       * under that passcode — so the very next tap asks them for a secret they
       * never chose, which is the dead end this guard exists to prevent. The
       * vault is converted once (the gate and Settings both offer exactly that)
       * and locking works normally afterwards.
       *
       * The test is the *pair*, not the passcode wrap on its own: a keyring that
       * still carries a passcode wrap next to a device wrap is opened by the
       * device, so it is an ordinary vault and new locks are openable here. On a
       * machine where the device path is not ready — a keyring restored from a
       * backup, say — the passcode would be the only way in, and that is the case
       * this refuses.
       */
      if ((await hasLegacyPasscodeWrap()) && !(await isDeviceUnlockReady())) {
        const message =
          'This vault is still locked by the old Stash passcode. Open one locked item to move it to your device lock, then you can lock new things here.';
        return { ok: false, message };
      }
      return { ok: true };
    }
    return get().enableLocking();
  },

  unlockWithLegacyPasscode: async (passcode) => {
    set({ busy: true, message: null });

    /*
     * Nothing is written until the new way in is known to work.
     *
     * The conversion deletes the passcode wrap, so it may only happen on a device
     * that can actually open the result: a prompt that can be raised, and — on a
     * desktop — a credential enrolled for it. Checking first is the whole safety
     * story of this path. Refusing costs nothing, and converting on a device that
     * cannot prompt would leave content that nothing in the app can reach.
     */
    const key = await openWithLegacyPasscode(passcode);
    if (!key) {
      const message = 'That passcode did not match, so nothing was changed.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    const authenticator = await getDeviceAuthenticator();
    const security = await authenticator.security();

    if (!(await authenticator.isAvailable())) {
      /*
       * No way in to convert *to*.
       *
       * On a device with no screen lock at all there is nothing the OS could ever
       * ask for, so the policy for such a device applies directly — and the
       * passcode has just proved the content belongs to whoever is holding it. The
       * content is released in full and the locks come off: the one ending that
       * leaves the user able to read everything and no lock standing that could
       * never be opened.
       */
      if (security === 'insecure') {
        const released = await releaseEveryLock();
        const settings = get().settings;

        // A row that would not open: nothing has been changed, and the passcode
        // still opens everything. Reported rather than forced through.
        if (!released) {
          const still = await countSealed();
          const message =
            'Some locked items could not be opened, so nothing was changed — your passcode still opens them.';
          set({
            busy: false,
            message,
            noScreenLockNotice: {
              outcome: 'blocked',
              locksCleared: { folders: 0, notes: 0, links: 0 },
              opened: { folders: 0, notes: 0, links: 0 },
              unreadable: still.folders + still.notes + still.links,
            },
          });
          return { ok: false, message };
        }

        set({
          busy: false,
          keyringPresent: false,
          legacyPasscodeOnly: false,
          legacyPasscodeAvailable: false,
          deviceUnlockReady: false,
          unlocked: true,
          unlockedAt: null,
          grantedRoots: [],
          revealRequest: null,
          message: null,
          noScreenLockNotice: {
            outcome: 'removed',
            locksCleared: released.cleared,
            opened: released.opened,
            unreadable: 0,
          },
        });
        syncScreenPrivacy(settings.secureScreen, true);
        return { ok: true };
      }

      // A device that *has* a screen lock but cannot raise the prompt here — a
      // missing desktop credential, a plugin that failed to load. Nothing is
      // touched, because the passcode is still the only way into these items.
      const message =
        'This device cannot ask for an unlock just now, so nothing was changed and your passcode still opens these items.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    // A desktop prompt needs a credential of its own enrolled before it can ask
    // for anything. Still nothing written: a failure here leaves the vault's only
    // working way in exactly where it was.
    if (!(await ensureDeviceCredential())) {
      const message =
        'This device could not set up its unlock prompt, so nothing was changed and your passcode still works.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    // One write does the whole conversion: the vault key is wrapped for this
    // device and the passcode wrap is dropped together, so there is no instant
    // where the record promises a way in that does not exist.
    const converted = await adoptVaultKeyForDevice(key);
    if (!converted.ok) {
      const message = converted.message ?? 'This device cannot store the key that converts the vault.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    const settings = get().settings;
    const opened = get().revealRequest?.root ?? null;
    set({
      busy: false,
      legacyPasscodeOnly: false,
      unlocked: true,
      unlockedAt: Date.now(),
      backgroundedAt: null,
      message: null,
      revealRequest: null,
    });
    if (opened) get().grant(opened);
    syncScreenPrivacy(settings.secureScreen, true);
    await get().reconcile();
    // Asked rather than assumed: `deviceUnlockReady` means the prompt can be
    // raised *here*, and on a desktop that is a separate fact from the wrap
    // having been written.
    await get().refreshCapabilities();
    return { ok: true };
  },

  authorize: async (reason) => {
    set({ busy: true, message: null });

    if (!(await isDeviceUnlockReady())) {
      const message = 'This device can no longer prompt for an unlock, so this cannot be authorised here.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    const authenticator = await getDeviceAuthenticator();
    const outcome = await authenticator.authenticate(reason);
    if (!outcome.ok) {
      set({ busy: false, message: outcome.message ?? 'That did not succeed.' });
      return { ok: false, message: outcome.message };
    }

    const key = await unlockWithDevice();
    if (!key) {
      const message = 'The prompt succeeded but this device no longer holds the key for the vault.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    set({ busy: false, unlocked: true, unlockedAt: Date.now(), backgroundedAt: null, message: null });
    await get().reconcile();
    return { ok: true };
  },

  disable: async () => {
    set({ busy: true, message: null });

    /*
     * Verify first: turning locking off opens everything, and that must not be
     * something a passer-by can trigger on an unlocked phone. There is no path
     * where this is a single unauthenticated tap.
     */
    const authorised = await get().authorize('Turn off locking for your Stash vault');
    if (!authorised.ok) {
      set({ busy: false, message: authorised.message ?? null });
      return authorised;
    }

    // Open every sealed row before the keyring goes, so nothing is left
    // ciphertext with no key in existence — and clear the flags only after that,
    // for the same reason the removal policy does.
    const released = await releaseEveryLock();
    if (!released) {
      const message = 'Some locked items could not be opened, so nothing was changed.';
      set({ busy: false, message });
      return { ok: false, message };
    }
    const settings = await setPrivacySettings({ enabled: false, biometric: false });

    set({
      busy: false,
      settings,
      keyringPresent: false,
      legacyPasscodeOnly: false,
      legacyPasscodeAvailable: false,
      unlocked: true,
      unlockedAt: null,
      grantedRoots: [],
      deviceUnlockReady: false,
      message: null,
    });
    syncScreenPrivacy(settings.secureScreen, true);
    return { ok: true };
  },

  requestAccess: async ({ kind, id, root }) => {
    if (!root) return { ok: true };
    if (!isSessionLocked() && get().grantedRoots.includes(root)) return { ok: true };
    // Asked of the keyring rather than of the cached flag: an import can replace
    // the keyring underneath us, and "is there anything to unlock" is a fact about
    // the key, not about the last render.
    if (!(await hasKeyring())) {
      get().grant(root);
      return { ok: true };
    }

    // The device prompt first, because it is one deliberate act with nothing to
    // type. A cancelled prompt is *not* an error here: it just means the gate
    // takes over and explains what happened.
    if (await isDeviceUnlockReady()) {
      const authenticator = await getDeviceAuthenticator();
      if (await authenticator.isAvailable()) {
        const result = await get().unlockWithBiometrics(root);
        if (result.ok) return result;
      }
    }

    set({ revealRequest: { kind, id, root } });
    return { ok: false, message: 'Unlock to open the protected item you tapped.' };
  },

  grant: (root) => {
    const current = get().grantedRoots;
    if (current.includes(root)) return;
    set({ grantedRoots: [...current, root] });
  },

  grantAll: (roots) => {
    const merged = new Set(get().grantedRoots);
    for (const root of roots) merged.add(root);
    const next = [...merged];
    // A new array even when nothing changed, so the vault's subscription (a
    // reference check) re-reads and the newly readable content appears.
    set({ grantedRoots: next, message: null });
  },

  clearGrants: () => {
    if (get().grantedRoots.length === 0) return;
    set({ grantedRoots: [] });
  },

  clearReveal: () => set({ revealRequest: null }),

  unlockWithBiometrics: async (root) => {
    set({ busy: true, message: null });
    const authenticator = await getDeviceAuthenticator();

    const outcome = await authenticator.authenticate('Unlock a protected item in Stash');
    if (!outcome.ok) {
      // A failed or cancelled prompt changes nothing: the vault stays locked and
      // the gate stays up. This is the whole failure-safety story — there is no
      // path from an auth failure to data loss.
      set({ busy: false, message: outcome.message ?? 'Authentication did not succeed.' });
      return { ok: false, message: outcome.message };
    }

    const key = await unlockWithDevice();
    if (!key) {
      // The prompt succeeded but the device key is gone (data cleared, restore on
      // a new phone, keystore entry invalidated). Report it; change nothing.
      const deviceUnlockReady = await isDeviceUnlockReady();
      const message =
        get().legacyPasscodeOnly || (await hasLegacyPasscodeWrap())
          ? 'This vault still needs the passcode it was locked with before, which will move it to your device lock.'
          : 'This device no longer holds the key for the vault, so its locked items cannot be opened here.';
      set({ busy: false, deviceUnlockReady, message });
      return { ok: false, message };
    }

    /*
     * The vault key is in hand, so a legacy passcode wrap on this keyring has
     * just been proven unnecessary: the device path demonstrably works, and no
     * screen in the app accepts a passcode any more. Dropping it here is the
     * silent half of the migration — a vault that had both wraps becomes
     * device-only without the user ever being asked anything, because they were
     * never relying on the passcode in the first place.
     */
    const dropped = await dropLegacyPasscodeWrap();

    const settings = get().settings;
    // The boundary the user actually asked to cross is the boundary that opens.
    // A queued reveal is satisfied by the unlock it was waiting for: whatever
    // asked for it re-renders with real data one refresh later.
    const opened = root ?? get().revealRequest?.root ?? null;
    set({
      busy: false,
      unlocked: true,
      unlockedAt: Date.now(),
      backgroundedAt: null,
      message: null,
      revealRequest: null,
      /*
       * Both facts, because a successful device unlock consumes the wrap:
       * leaving `legacyPasscodeAvailable` set would leave the gate offering a
       * passcode field for a wrap that is no longer there.
       */
      ...(dropped ? { legacyPasscodeOnly: false, legacyPasscodeAvailable: false } : {}),
    });
    if (opened) get().grant(opened);
    syncScreenPrivacy(settings.secureScreen, true);
    // A key exists now, so the database can be brought back in step with the lock
    // flags — which is also the migration for a vault written by an earlier build.
    await get().reconcile();
    return { ok: true };
  },

  lock: () => {
    // No keyring and nothing open means there is no session to end, and locking
    // would only produce a gate with no way through.
    if (!get().keyringPresent && get().grantedRoots.length === 0) return;
    // Drop the key. That is the mechanism behind the seal — no plaintext is hidden
    // behind a boolean, the material to decrypt simply stops existing here — and
    // drop the grants, which is the mechanism behind the boundary.
    forgetVaultKey();
    const settings = get().settings;
    set({ unlocked: false, unlockedAt: null, backgroundedAt: null, grantedRoots: [], message: null });
    syncScreenPrivacy(settings.secureScreen, false);
  },

  lockOnTabChange: (now = Date.now()) => {
    const state = get();
    // Nothing to end when there is no keyring (nothing is protected) and nothing
    // has been opened. The reveal grace is what keeps an unlock and the
    // navigation it caused from cancelling each other out.
    if (!state.keyringPresent || (!state.unlocked && state.grantedRoots.length === 0)) return;
    if (!shouldLockOnTabChange(state.unlockedAt, now)) return;
    get().lock();
  },

  /**
   * Leaving the foreground ends the session.
   *
   * This is what "the user locked the phone or the computer" looks like from
   * inside the app, and it is the whole point of unlocking per session: the same
   * person picking the phone back up has to pass the prompt again.
   *
   * The lock happens here rather than on resume because Android may kill the
   * process while it is backgrounded — a promise kept only on resume is one the
   * app was never alive to keep.
   *
   * `relockPolicy` is deliberately ignored: it exists so a vault written by an
   * earlier build still loads, not to make this decision any more.
   */
  handleBackground: (now = Date.now()) => {
    const state = get();
    if (!state.unlocked && state.grantedRoots.length === 0) return;
    set({ backgroundedAt: now });
    get().lock();
  },

  handleForeground: (now = Date.now()) => {
    const state = get();
    if (!state.unlocked || state.backgroundedAt === null) return false;
    if (!shouldRelock(state.settings.relockPolicy, state.backgroundedAt, now)) {
      set({ backgroundedAt: null });
      return false;
    }
    get().lock();
    return true;
  },

  abandonLock: async () => {
    // No unsealing, no verification: this is the path for a vault whose key is
    // unreachable. Locked items are not deleted — they become ciphertext nobody
    // holds a key for. That is data loss, which is why the UI says so in those
    // words.
    await destroyKeyring();
    const settings = await setPrivacySettings({ enabled: false, biometric: false });
    set({
      settings,
      keyringPresent: false,
      legacyPasscodeOnly: false,
      legacyPasscodeAvailable: false,
      unlocked: true,
      unlockedAt: null,
      grantedRoots: [],
      deviceUnlockReady: false,
      message: null,
    });
    syncScreenPrivacy(settings.secureScreen, true);
  },

  update: async (patch) => {
    const settings = await setPrivacySettings(patch);
    set({ settings });
    syncScreenPrivacy(settings.secureScreen, get().unlocked);
  },

  clearMessage: () => set({ message: null }),
}));
