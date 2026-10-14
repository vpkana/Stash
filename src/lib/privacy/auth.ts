/**
 * Device authentication: fingerprint, face, iris, or the device PIN/pattern/
 * password.
 *
 * This is the **only** way into a locked item. Stash has no password of its own
 * and no passcode to forget: locking a folder asks the operating system to verify
 * the person holding the device, exactly as a banking app does, and the only
 * difference from those apps is scope — Stash locks a folder rather than gating
 * the whole app.
 *
 * Stash does not verify a biometric itself — it cannot, and it must not try. On
 * Android it hands the request to `BiometricPrompt` (via the Capacitor plugin),
 * which is why the plugin is configured with `allowDeviceCredential`: the system
 * dialog offers the enrolled fingerprint *and* its own button for the device
 * PIN, pattern or password, so somebody who wants to use their screen lock
 * instead of their fingerprint gets the platform's own control for it rather
 * than having to turn biometrics off in Android settings. That combination is
 * mandatory here, not a nicety: it is the requirement, and it is the platform
 * doing the drawing. On a desktop the prompt is the platform authenticator
 * through WebAuthn (`webauthn.ts`), which raises Windows Hello — face,
 * fingerprint or the Windows PIN.
 *
 * The result of a successful prompt is used as an *authorisation to unseal*, not
 * as a key. The vault key is unwrapped from platform storage afterwards, so the
 * security of the data rests on that storage and the OS prompt in front of it,
 * rather than on a boolean this code returns.
 *
 * Failure is always recoverable: every outcome below simply leaves the vault
 * locked. Nothing here can delete or corrupt data, and the failure is reported as
 * a sentence rather than as a code.
 *
 * ## And one question that is not about unlocking
 *
 * {@link DeviceAuthenticator.security} answers "does this device have a screen
 * lock at all" — any of fingerprint, face, PIN, pattern or password, as opposed
 * to none. It exists for one product rule: on a device with no screen lock, a
 * Stash lock cannot be enforced by anyone, so the app removes the locks it can no
 * longer stand behind and says so. See `stores/privacy-store.ts`.
 */
export type AuthFailureReason =
  | 'cancelled'
  | 'unavailable'
  | 'failed'
  /** Too many attempts: the OS has temporarily suspended biometry. */
  | 'lockout';

export interface AuthOutcome {
  ok: boolean;
  reason?: AuthFailureReason;
  /** Short, human-readable explanation for the lock screen. */
  message?: string;
}

/**
 * What to call the prompt on this platform.
 *
 * Named specifically wherever it is offered — "Windows Hello or your device
 * PIN" tells someone what is about to appear on their screen, and "your
 * fingerprint, face or phone PIN" does the same on a phone. Vague words like
 * "biometrics" are what make a security dialog feel like a trap.
 */
export function devicePromptName(storeKind: 'native' | 'web' | 'unavailable'): string {
  return storeKind === 'web' ? 'Windows Hello or your device PIN' : 'your fingerprint, face or phone PIN';
}

/** The short form, for a button label. */
export function devicePromptTitle(storeKind: 'native' | 'web' | 'unavailable'): string {
  return storeKind === 'web' ? 'Windows Hello' : 'your device';
}

export interface DeviceAuthenticator {
  readonly kind: 'native' | 'web';
  /** Whether device authentication could ever succeed on this device. */
  isAvailable(): Promise<boolean>;
  /** Prompt, and report what happened. Never throws. */
  authenticate(reason: string): Promise<AuthOutcome>;
  /**
   * Whether this device is protected by a screen lock of *any* kind.
   *
   * Not the same question as {@link isAvailable}, and the difference is the
   * whole point: a phone with no PIN, no pattern, no password and no enrolled
   * biometric answers `false` to `isAvailable` *and* `'insecure'` here, while a
   * phone whose only protection is a PIN answers `'secure'` with no biometric -
   * authentication available at all. The first case means a Stash lock has no
   * foundation to stand on; the second is perfectly lockable.
   */
  security(): Promise<DeviceSecurity>;
}

/**
 * What this device's own screen lock amounts to.
 *
 * `'unknown'` is a real answer and it is treated carefully: a browser cannot
 * enumerate the operating system's screen lock, and a platform call that failed
 * tells us nothing about the device. Neither is allowed to be read as
 * `'insecure'`, because acting on `'insecure'` removes locks — and removing locks
 * on a guess would delete protection the user asked for, on a device that may
 * have been perfectly secure the whole time.
 */
export type DeviceSecurity = 'secure' | 'insecure' | 'unknown';

/**
 * Browsers, and the desktop builds that are one.
 *
 * **Availability is a capability question, not a state question.** It asks
 * "could this machine raise a platform prompt?" — Windows Hello configured, a
 * PIN set, a Mac with Touch ID — and deliberately says nothing about whether
 * Stash has already enrolled a credential.
 *
 * That distinction is the fix for a real deadlock: this used to require an
 * enrolled credential, and the credential is only created by *arming* the
 * feature, which the settings switch refuses to do while availability is false.
 * The switch was therefore permanently disabled on a machine that could prompt
 * perfectly well, and the only way to arm it was to arm it. Asking the
 * platform — {@link import('./webauthn').isDevicePromptSupported} — instead of
 * asking our own keyring breaks the loop: the switch becomes tappable, arming
 * enrols the credential, and `isDeviceUnlockReady()` is what reports the armed
 * state afterwards.
 */
const WEB_AUTHENTICATOR: DeviceAuthenticator = {
  kind: 'web',
  isAvailable: async () => {
    try {
      const { isDevicePromptSupported } = await import('./webauthn');
      return await isDevicePromptSupported();
    } catch {
      return false;
    }
  },
  /*
   * `'unknown'`, always, and deliberately not a guess.
   *
   * A browser has no API for "is there a screen lock on this machine" —
   * `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` says
   * whether one *could* be used, not whether the OS is protected, and a desktop
   * account with no password at all is not something a page can detect. The rule
   * that reads this value removes locks, so "I could not tell" has to stay
   * distinguishable from "there is nothing there". The lock is left alone.
   */
  security: async () => 'unknown',
  // No `reason` argument: WebAuthn's dialog is drawn by the OS, which does not
  // accept a message from the page the way `BiometricPrompt` does.
  authenticate: async () => {
    try {
      const { promptDeviceCredential } = await import('./webauthn');
      const outcome = await promptDeviceCredential();
      if (outcome === 'ok') return { ok: true };
      const failure: AuthFailureReason =
        outcome === 'cancelled' ? 'cancelled' : outcome === 'unavailable' ? 'unavailable' : 'failed';
      return { ok: false, reason: failure, message: messageFor(failure, 'web') };
    } catch {
      return {
        ok: false,
        reason: 'unavailable',
        message: messageFor('unavailable', 'web'),
      };
    }
  },
};

function mapErrorCode(code: string | undefined): AuthFailureReason {
  switch (code) {
    case 'userCancel':
    case 'appCancel':
    case 'systemCancel':
    case 'userFallback':
      return 'cancelled';
    case 'biometryLockout':
      return 'lockout';
    case 'biometryNotAvailable':
    case 'biometryNotEnrolled':
    case 'noDeviceCredential':
    case 'passcodeNotSet':
      return 'unavailable';
    default:
      return 'failed';
  }
}

export function messageFor(reason: AuthFailureReason, kind: 'native' | 'web' = 'native'): string {
  if (kind === 'web') {
    switch (reason) {
      case 'cancelled':
        return 'The device prompt was dismissed, so nothing was opened.';
      case 'unavailable':
        return 'This computer cannot prompt for a device unlock. Set up Windows Hello or a device PIN, then try again.';
      case 'lockout':
        return 'Too many attempts. The device prompt is paused — try again in a moment.';
      case 'failed':
      default:
        return 'That did not match, so nothing was opened.';
    }
  }

  switch (reason) {
    case 'cancelled':
      return 'Authentication was cancelled, so nothing was opened.';
    case 'unavailable':
      return 'This device has no screen lock set up. Add a PIN, pattern, password, fingerprint or face in Android settings, then try again.';
    case 'lockout':
      return 'Too many attempts. Biometrics are paused — try again in a moment, or use your screen lock.';
    case 'failed':
    default:
      return 'That did not match, so nothing was opened.';
  }
}

function createNativeAuthenticator(module: {
  BiometricAuth: {
    checkBiometry(): Promise<{ isAvailable: boolean; deviceIsSecure: boolean }>;
    authenticate(options: Record<string, unknown>): Promise<void>;
  };
}): DeviceAuthenticator {
  const { BiometricAuth } = module;

  return {
    kind: 'native',
    isAvailable: async () => {
      try {
        const info = await BiometricAuth.checkBiometry();
        // Either enrolled biometry, or a device credential we can fall back to.
        return Boolean(info.isAvailable || info.deviceIsSecure);
      } catch {
        return false;
      }
    },
    /*
     * `deviceIsSecure` is `KeyguardManager.isDeviceSecure()` underneath: true
     * when the phone has a PIN, pattern **or** password. Swipe-only answers
     * false, which is exactly the case the app has to act on — there is nothing
     * the OS can ask a person for, so there is nothing a Stash lock can require.
     *
     * `isAvailable` is OR'd in as insurance rather than as the primary signal.
     * On Android the two cannot disagree in the "biometrics but no screen lock"
     * direction — enrolling a fingerprint requires a secure lock screen first —
     * but the cost of being wrong in that direction is a removed lock on a device
     * that could have kept it, and the cost of the OR being redundant is nothing.
     *
     * A thrown error is `'unknown'`, never `'insecure'`: a plugin call that failed
     * is not evidence about the device's security, and the caller removes locks on
     * `'insecure'`.
     */
    security: async () => {
      try {
        const info = await BiometricAuth.checkBiometry();
        return info.deviceIsSecure || info.isAvailable ? 'secure' : 'insecure';
      } catch {
        return 'unknown';
      }
    },
    authenticate: async (reason) => {
      try {
        // The plugin requires `checkBiometry()` to have run at least once before
        // `authenticate()`, so the prompt is always preceded by a capability read.
        await BiometricAuth.checkBiometry();
        await BiometricAuth.authenticate({
          reason,
          cancelTitle: 'Cancel',
          /*
           * `allowDeviceCredential` is what makes the PIN/pattern/password a
           * *choice* rather than a fallback of last resort.
           *
           * On Android this sets the authenticator set to
           * `BIOMETRIC_WEAK | DEVICE_CREDENTIAL`, and the system dialog Android
           * draws then presents the enrolled biometric and a system-supplied
           * button that switches to the device credential. So a user with a
           * fingerprint enrolled can still pick their PIN deliberately, without
           * turning biometrics off in Android settings — which is the requirement
           * this flag exists for, and it is the platform's own UI doing it. It is
           * also what makes a phone with **no** biometrics enrolled work at all,
           * which is the other half of the same requirement.
           *
           * Two Android constraints were checked in the plugin's native
           * `AuthActivity` before relying on this combination, because getting
           * either wrong is a crash rather than a degraded prompt:
           *
           *  - a negative button may **not** be combined with device
           *    credentials, so the plugin deliberately skips
           *    `setNegativeButtonText` whenever this flag is set. Passing
           *    `cancelTitle` above is therefore harmless, not a conflict;
           *  - `BIOMETRIC_STRONG | DEVICE_CREDENTIAL` is rejected on API 28–29, so
           *    the plugin downgrades to `BIOMETRIC_WEAK` on exactly those two
           *    versions.
           *
           * The strength left at its default (`weak`) is deliberate. `strong`
           * would mean Class-3 only, and on the many phones whose face unlock is
           * Class 2 that would silently take face away and push the user to the
           * PIN — the opposite of "the system may offer biometric authentication"
           * for the fingerprint or face they actually enrolled. Weak biometrics
           * plus a device credential is also what Android's own `BiometricPrompt`
           * guidance sanctions for this kind of app-level gate, and the vault key
           * does not rest on this prompt: the prompt releases platform storage,
           * and the data is encrypted regardless.
           */
          allowDeviceCredential: true,
          androidTitle: 'Unlock Stash',
          androidSubtitle: reason,
        });
        return { ok: true };
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : undefined;
        const mapped = mapErrorCode(code === '' ? undefined : code);
        return { ok: false, reason: mapped, message: messageFor(mapped) };
      }
    },
  };
}

let cached: DeviceAuthenticator | null = null;

export async function getDeviceAuthenticator(): Promise<DeviceAuthenticator> {
  if (cached) return cached;

  if (typeof window !== 'undefined') {
    try {
      const core = await import('@capacitor/core');
      if (core.Capacitor.isNativePlatform()) {
        const biometric = await import('@aparajita/capacitor-biometric-auth');
        cached = createNativeAuthenticator(biometric);
        return cached;
      }
    } catch (error) {
      console.warn('[stash] device authentication unavailable', error);
    }
  }

  cached = WEB_AUTHENTICATOR;
  return cached;
}

/** Test seam. */
export function setDeviceAuthenticator(authenticator: DeviceAuthenticator | null): void {
  cached = authenticator;
}

/** Build a fake authenticator, used by tests to model success and failure. */
export function createStaticAuthenticator(
  outcome: AuthOutcome,
  options: { available?: boolean; security?: DeviceSecurity } = {},
): DeviceAuthenticator {
  return {
    kind: 'native',
    isAvailable: async () => options.available ?? true,
    authenticate: async () => outcome,
    // A fake device defaults to having a screen lock, which is the honest default
    // for a test: a phone with none is the case a test has to ask for explicitly,
    // because it is the case that removes locks.
    security: async () => options.security ?? 'secure',
  };
}
