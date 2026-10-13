'use client';

import { create } from 'zustand';
import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettings } from '@/db/types';
import { getPrivacySettings, setPrivacySettings } from '@/db/repos/settings';
import { getDeviceAuthenticator } from '@/lib/privacy/auth';
import {
  createKeyring,
  destroyKeyring,
  disableDeviceUnlock,
  enableDeviceUnlock,
  forgetVaultKey,
  hasKeyring,
  hasPasscodeWrap,
  isDeviceUnlockReady,
  isSessionLocked,
  MIN_PASSCODE_LENGTH,
  MIN_PASSCODE_MESSAGE,
  removePasscodeWrap,
  setPasscodeWrap,
  unlockWithDevice,
  unlockWithPasscode,
} from '@/lib/privacy/keyring';
import { getSecureStore } from '@/lib/privacy/secure-store';
import { reconcileProtection as reconcile, unsealEverything } from '@/lib/privacy/reconcile';
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
 * is gated: what is protected is *content*, and the only things that ever ask for
 * a credential are crossing into a protected folder and the deliberate
 * "open everything" action in Settings. Launching, browsing Home, searching,
 * saving a link or arriving from the Android share sheet all happen with no
 * prompt at all, however many locked folders the vault contains.
 *
 * ## Two ways in, and the passcode is the one that cannot be taken away
 *
 * A vault is opened by a **passcode** and, when the device can prompt, by the
 * **device unlock** as well. Both are wraps of the same vault key, so either one
 * opens the vault; neither is required for the other to work.
 *
 * The passcode is the primary because it is the only one that survives the user's
 * own settings. A device key is held by the operating system, and the OS can
 * withdraw it: a fingerprint is removed, a screen lock is turned off, an
 * enrollment is invalidated by a platform update. When that was the *only* way in,
 * turning a biometric switch off locked someone out of their own folders — a
 * settings change that destroyed access. It cannot happen now: switching the
 * device prompt off removes a wrap and leaves the passcode exactly as it was.
 *
 * `grantedRoots` is the access model, and it is per folder. Passing the prompt
 * for `Private` opens `Private` and its descendants and leaves every other locked
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

export interface PrivacyState {
  ready: boolean;
  settings: PrivacySettings;
  /** True once a keyring row exists, i.e. privacy has been set up. */
  keyringPresent: boolean;
  /**
   * Whether a Stash passcode exists. `false` on a vault set up with the device
   * lock alone, which is a supported setup: the system prompt is the way in and
   * there is nothing to type. The UI says what that costs before it is chosen.
   */
  passcodeSet: boolean;
  /** Where the device key lives, so the copy can be specific rather than vague. */
  deviceStoreKind: DeviceStoreKind;
  unlocked: boolean;
  /** Whether this device can prompt for biometric or device-credential auth. */
  deviceAuthAvailable: boolean;
  /** Whether the biometric fast path is armed and its device key is present. */
  deviceUnlockReady: boolean;
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
   * Which locked folders have been opened in this session.
   *
   * This is the whole of Stash's access model, and it is deliberately a *set*:
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
   * Set by `requestReveal` so the gate can be raised for *this* reason — "open
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
   * Set up locking, starting with a passcode.
   *
   * A passcode first, because it is the wrap that cannot be withdrawn by the
   * platform — see the module note. The device prompt is armed afterwards, from
   * its own switch, which means a device that cannot prompt can still be locked
   * properly instead of being told locking is unavailable.
   */
  createWithPasscode: (passcode: string) => Promise<ActionResult>;
  /** Add or replace the passcode wrap. Requires an unlocked session. */
  setPasscode: (passcode: string) => Promise<ActionResult>;
  /**
   * Prove that the person at the device may act, before anything irreversible.
   *
   * One function, because there is one question — "is this the owner?" — and two
   * ways to answer it. The device prompt is tried first when it is armed (nothing
   * to type), and a typed passcode answers it otherwise. A *cancelled* prompt is
   * deliberately not the end of the attempt: it falls through to the passcode
   * field, because a stray tap on the system dialog must not be the last word.
   *
   * `passcode` may be empty when the caller knows the device path will answer; a
   * vault with no passcode wrap simply has nothing for it to check.
   */
  authorize: (passcode: string, reason: string) => Promise<ActionResult>;
  /**
   * Replace the passcode, having proved the current way in first.
   *
   * The old passcode is **not** the only accepted proof: a successful device
   * prompt does just as well, which is what makes "change my passcode" possible
   * on a phone whose passcode was long forgotten but whose fingerprint still
   * works. Either way the vault key is what is re-wrapped, so nothing already
   * encrypted changes and no data is at risk at any point.
   */
  changePasscode: (current: string, next: string) => Promise<ActionResult>;
  /**
   * Remove the passcode wrap, having proved the current passcode first.
   *
   * Refuses when the device prompt is not armed, because a keyring with no wrap
   * at all is a vault nothing can open.
   */
  removePasscode: (passcode: string) => Promise<ActionResult>;
  /**
   * Turn privacy off: opens everything, then removes the keyring. The device
   * prompt authorises it; `passcode` is read only on a vault created by an older
   * build whose only wrap was a passcode.
   */
  disable: (passcode: string) => Promise<ActionResult>;
  /**
   * Open a vault with a passcode.
   *
   * The passcode is the primary way in — the one wrap the operating system
   * cannot withdraw — and this is also the path a vault created by an earlier
   * build uses, where the passcode wrap is the only thing that can open it.
   */
  unlock: (passcode: string) => Promise<ActionResult>;
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
   * The deliberate, authenticated "open everything" — the replacement for the
   * unauthenticated recovery action that used to exist. It takes the roots to
   * grant from the caller so nothing here has to know about the vault's shape,
   * and it changes **no configuration**: no lock flag is cleared, no keyring is
   * touched, no sealed row is rewritten. Leaving the screen, switching tabs or
   * backgrounding the app ends it exactly like any other unlock.
   *
   * It is not a bypass: the caller must have authenticated first, and the
   * simplest way to see that it is safe is that it grants nothing a user could
   * not get by opening each locked folder in turn.
   */
  grantAll: (roots: readonly string[]) => void;
  /** End every folder access at once. Called on lock, tab change and background. */
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
   * Destroy the keyring without unsealing anything.
   *
   * The keyring is deleted and anything sealed stays sealed and permanently
   * unreadable — this is a *loss*, not a bypass, and it never reveals a locked
   * item. It is offered only as a described, deliberate last resort, and the
   * caller must have authorised it first: destroying the lock is a change to the
   * vault, and no change to the vault is a single unauthenticated tap.
   */
  abandonLock: () => Promise<void>;
  armBiometrics: () => Promise<ActionResult>;
  disarmBiometrics: () => Promise<void>;
  update: (patch: Partial<PrivacySettings>) => Promise<void>;
  clearMessage: () => void;
}

/**
 * The two facts the privacy UI needs to be specific about: is there a passcode,
 * and where does the device key live.
 *
 * Asked as a pair because they are read together and both answer "what would it
 * take to open this vault somewhere else".
 */
async function describeDevicePath(keyring: boolean): Promise<[boolean, DeviceStoreKind]> {
  const store = await getSecureStore();
  if (!keyring) return [false, store.kind];
  return [await hasPasscodeWrap(), store.kind];
}

/**
 * Screen privacy follows the session: always on while locked, and on while
 * unlocked only when the user asked for it.
 */
function syncScreenPrivacy(secureWhileUnlocked: boolean, unlocked: boolean): void {
  void applyScreenPrivacy(!unlocked || secureWhileUnlocked);
}

export const usePrivacyStore = create<PrivacyState>((set, get) => ({
  ready: false,
  settings: { ...DEFAULT_PRIVACY_SETTINGS },
  keyringPresent: false,
  passcodeSet: false,
  deviceStoreKind: 'unavailable',
  // Starts locked. On a cold start nothing is unlocked until the user says so,
  // which is what makes "after app restart the vault is locked" true by default
  // rather than by remembering to set a flag.
  unlocked: false,
  deviceAuthAvailable: false,
  deviceUnlockReady: false,
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
    // the switch can be offered at all. Reading the `biometric` setting here made
    // the switch depend on itself — off meant "not available", so it could never
    // be turned on.
    const deviceAuthAvailable = await authenticator.isAvailable();
    const deviceUnlockReady = keyring ? await isDeviceUnlockReady() : false;
    const [passcodeSet, deviceStoreKind] = await describeDevicePath(keyring);

    // With no keyring there is nothing to protect, so the session starts open.
    // With one, it starts locked: a cold start never inherits the last session's
    // key, which is what makes "locked after a restart" be the default rather
    // than something remembered.
    const unlocked = !keyring;

    set({
      ready: true,
      settings,
      keyringPresent: keyring,
      passcodeSet,
      deviceStoreKind,
      deviceAuthAvailable,
      deviceUnlockReady,
      unlocked,
      // Nothing was unlocked by a person here: a vault with no keyring starts
      // open because there is nothing to protect, not because it was opened. No
      // folder has been crossed into either, which is why the grants start empty
      // even when the key is present.
      unlockedAt: null,
      grantedRoots: [],
    });
    syncScreenPrivacy(settings.secureScreen, unlocked);
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
    const [passcodeSet, deviceStoreKind] = await describeDevicePath(keyring);

    set({
      ready: true,
      settings,
      keyringPresent: keyring,
      passcodeSet,
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
    const [passcodeSet, deviceStoreKind] = await describeDevicePath(get().keyringPresent);
    set({ deviceAuthAvailable, deviceUnlockReady: await isDeviceUnlockReady(), passcodeSet, deviceStoreKind });
  },

  createWithPasscode: async (passcode) => {
    set({ busy: true, message: null });

    const result = await createKeyring(passcode);
    if (!result.ok) {
      set({ busy: false, message: result.message ?? null });
      return { ok: false, message: result.message };
    }

    // The device prompt starts off and is offered as its own switch, so a device
    // that cannot prompt is never the reason locking is unavailable.
    const settings = await setPrivacySettings({ enabled: true, biometric: false });
    const [passcodeSet, deviceStoreKind] = await describeDevicePath(true);
    set({
      busy: false,
      settings,
      keyringPresent: true,
      passcodeSet,
      deviceStoreKind,
      deviceUnlockReady: false,
      unlocked: true,
      unlockedAt: Date.now(),
      message: null,
    });
    syncScreenPrivacy(settings.secureScreen, true);
    // Re-read the device capabilities now that a keyring exists: whether this
    // machine can prompt is a fact about the machine, and the settings screen has
    // to be able to offer the switch the moment locking is on — not one reload
    // later.
    await get().refreshCapabilities();
    return { ok: true };
  },

  setPasscode: async (passcode) => {
    if (passcode.length < MIN_PASSCODE_LENGTH) {
      return { ok: false, message: MIN_PASSCODE_MESSAGE };
    }
    const result = await setPasscodeWrap(passcode);
    if (!result.ok) return { ok: false, message: result.message };
    const [passcodeSet, deviceStoreKind] = await describeDevicePath(true);
    set({ passcodeSet, deviceStoreKind, message: null });
    return { ok: true };
  },

  removePasscode: async (passcode) => {
    set({ busy: true, message: null });
    // Verified by unwrapping, not by comparing against a stored value — the
    // AES-GCM tag on the wrapped key is the only verifier there has ever been.
    const opened = await unlockWithPasscode(passcode);
    if (!opened) {
      set({ busy: false, message: 'That passcode did not match.' });
      return { ok: false, message: 'That passcode did not match.' };
    }
    const result = await removePasscodeWrap();
    if (!result.ok) {
      set({ busy: false, message: result.message ?? null });
      return { ok: false, message: result.message };
    }
    const [passcodeSet, deviceStoreKind] = await describeDevicePath(true);
    set({ busy: false, passcodeSet, deviceStoreKind, message: null });
    return { ok: true };
  },

  disable: async (passcode) => {
    set({ busy: true, message: null });

    /*
     * Verify first: turning privacy off opens everything, and that must not be
     * something a passer-by can trigger on an unlocked phone. The device prompt
     * goes first because it is the only secret the app has left; a passcode is
     * accepted only as the fallback for a vault whose device key is gone (one
     * created by an older build, or restored from a backup onto this device).
     * There is no path where "turn locking off" is a single unauthenticated tap.
     */
    let authorised = false;

    if (await isDeviceUnlockReady()) {
      const authenticator = await getDeviceAuthenticator();
      const outcome = await authenticator.authenticate('Turn off locking for your Stash vault');
      if (!outcome.ok) {
        set({ busy: false, message: outcome.message ?? 'That did not succeed.' });
        return { ok: false, message: outcome.message };
      }
      authorised = Boolean(await unlockWithDevice());
    }

    if (!authorised && (await hasPasscodeWrap())) {
      const key = await unlockWithPasscode(passcode);
      if (!key) {
        set({ busy: false, message: 'That passcode did not match.' });
        return { ok: false, message: 'That passcode did not match.' };
      }
      authorised = true;
    }

    if (!authorised) {
      const message = 'This device can no longer open the vault, so locking cannot be turned off from here.';
      set({ busy: false, message });
      return { ok: false, message };
    }

    // Open every sealed row before the keyring goes, so nothing is left
    // ciphertext with no key in existence.
    await unsealEverything();
    await destroyKeyring();
    const settings = await setPrivacySettings({ enabled: false });

    set({
      busy: false,
      settings,
      keyringPresent: false,
      passcodeSet: false,
      unlocked: true,
      unlockedAt: null,
      grantedRoots: [],
      deviceUnlockReady: false,
      message: null,
    });
    syncScreenPrivacy(settings.secureScreen, true);
    return { ok: true };
  },

  unlock: async (passcode) => {
    set({ busy: true, message: null });
    // Asked of the keyring rather than of the cached flag: an import can adopt
    // a keyring underneath us, and the answer that matters is what is on disk.
    if (!(await hasPasscodeWrap())) {
      const message = 'This vault opens with the device lock, not a passcode.';
      set({ busy: false, passcodeSet: false, message });
      return { ok: false, message };
    }
    // `null` covers both "no keyring" and "the GCM tag did not verify", which are
    // the same answer to the user: this passcode does not open this vault.
    const key = await unlockWithPasscode(passcode);
    if (!key) {
      set({ busy: false, message: 'That passcode did not match.' });
      return { ok: false, message: 'That passcode did not match.' };
    }
    const settings = get().settings;
    // The passcode path opens the same boundary as the device path, and clears a
    // queued reveal too, so the gate steps aside the moment the item behind it
    // becomes readable.
    const opened = get().revealRequest?.root ?? null;
    set({
      busy: false,
      unlocked: true,
      unlockedAt: Date.now(),
      backgroundedAt: null,
      message: null,
      revealRequest: null,
    });
    if (opened) get().grant(opened);
    syncScreenPrivacy(settings.secureScreen, true);
    await get().reconcile();
    return { ok: true };
  },

  authorize: async (passcode, reason) => {
    set({ busy: true, message: null });

    // 1. The device prompt, when this device has one armed and working. A
    //    cancelled prompt is *not* an error: the passcode field is still there,
    //    and the caller may still answer with it.
    if (await isDeviceUnlockReady()) {
      const authenticator = await getDeviceAuthenticator();
      const outcome = await authenticator.authenticate(reason);
      if (outcome.ok) {
        const key = await unlockWithDevice();
        if (key) {
          set({
            busy: false,
            unlocked: true,
            unlockedAt: Date.now(),
            backgroundedAt: null,
            message: null,
          });
          await get().reconcile();
          return { ok: true };
        }
      }
    }

    // 2. The passcode, if this vault has one.
    if (!(await hasPasscodeWrap())) {
      const message = await isDeviceUnlockReady()
        ? 'That did not succeed. Try the device prompt again.'
        : 'This vault can only be opened with the device prompt, and it is not available here.';
      set({ busy: false, message });
      return { ok: false, message };
    }
    return get().unlock(passcode);
  },

  changePasscode: async (current, next) => {
    if (next.length < MIN_PASSCODE_LENGTH) {
      return { ok: false, message: MIN_PASSCODE_MESSAGE };
    }

    // Proving it is you comes first, and it is the same proof whichever way in
    // this vault has: the old passcode, or the device prompt. A "change" that
    // skipped this would be a way for someone holding an unlocked phone to set a
    // passcode the owner does not know.
    const verified = await get().authorize(current, 'Change the passcode for your Stash vault');
    if (!verified.ok) {
      return { ok: false, message: verified.message ?? 'That did not match.' };
    }

    const result = await setPasscodeWrap(next);
    if (!result.ok) return { ok: false, message: result.message };
    const [passcodeSet, deviceStoreKind] = await describeDevicePath(true);
    set({ passcodeSet, deviceStoreKind, message: null });
    return { ok: true };
  },

  /**
   * Cross a lock boundary.
   *
   * The order of the checks is the whole design:
   *
   *  1. nothing protects this item → there is no boundary, so there is nothing to
   *     ask. This is the branch that keeps a share, a launch, a search and an
   *     ordinary save silent no matter how many locked folders exist.
   *  2. this exact root is already open in this session and the key is here → the
   *     user is moving around inside a folder they already unlocked.
   *  3. no keyring exists at all → nothing is sealed, so nothing can be withheld.
   *  4. otherwise prompt. A cancelled prompt opens nothing and queues the gate so
   *     the refusal is explained rather than silent.
   */
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
    // takes over, with the passcode field already open.
    if (await isDeviceUnlockReady()) {
      const authenticator = await getDeviceAuthenticator();
      if (await authenticator.isAvailable()) {
        const result = await get().unlockWithBiometrics(root);
        if (result.ok) return result;
      }
    }

    set({ revealRequest: { kind, id, root } });
    return { ok: false, message: 'Unlock to open the protected folder you tapped.' };
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

    const outcome = await authenticator.authenticate('Unlock your Stash vault');
    if (!outcome.ok) {
      // A failed or cancelled prompt changes nothing: the vault stays locked and
      // the passcode field is still there. This is the whole failure-safety
      // story — there is no path from an auth failure to data loss.
      set({ busy: false, message: outcome.message ?? 'Authentication did not succeed.' });
      return { ok: false, message: outcome.message };
    }

    const key = await unlockWithDevice();
    if (!key) {
      // The prompt succeeded but the device key is gone (data cleared, restore
      // on a new phone, keystore entry invalidated). Fall back, do not damage.
      const deviceUnlockReady = await isDeviceUnlockReady();
      const message = (await hasPasscodeWrap())
        ? 'Your passcode is needed to open the vault on this device.'
        : 'This device can no longer open the vault, and no passcode was ever added. Locked items are unreadable.';
      set({ busy: false, deviceUnlockReady, message });
      return { ok: false, message };
    }

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
   * Leaving the foreground ends the session, always.
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
    const settings = await setPrivacySettings({ enabled: false });
    set({
      settings,
      keyringPresent: false,
      passcodeSet: false,
      unlocked: true,
      unlockedAt: null,
      grantedRoots: [],
      deviceUnlockReady: false,
      message: null,
    });
    syncScreenPrivacy(settings.secureScreen, true);
  },

  armBiometrics: async () => {
    const ok = await enableDeviceUnlock();
    if (!ok) {
      return { ok: false, message: 'This device could not set up the unlock prompt, so nothing was armed.' };
    }
    const settings = await setPrivacySettings({ biometric: true });
    set({ settings, deviceUnlockReady: true });
    return { ok: true };
  },

  disarmBiometrics: async () => {
    await disableDeviceUnlock();
    const settings = await setPrivacySettings({ biometric: false });
    set({ settings, deviceUnlockReady: false });
  },

  update: async (patch) => {
    const settings = await setPrivacySettings(patch);
    set({ settings });
    syncScreenPrivacy(settings.secureScreen, get().unlocked);
  },

  clearMessage: () => set({ message: null }),
}));
