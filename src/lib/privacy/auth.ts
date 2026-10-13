/**
 * Device authentication: fingerprint, face, iris, or the device PIN/pattern/
 * password.
 *
 * Stash does not verify a biometric itself — it cannot, and it must not try. On
 * Android it hands the request to `BiometricPrompt` (via the Capacitor plugin),
 * which is why the plugin is configured with `allowDeviceCredential`: a phone
 * with no enrolled finger still gets the system PIN/pattern/password dialog
 * rather than a dead end. On a desktop it hands the request to the platform
 * authenticator through WebAuthn (`webauthn.ts`), which is what raises Windows
 * Hello — face, fingerprint or the Windows PIN.
 *
 * The result of a successful prompt is used as an *authorisation to unseal*, not
 * as a key. The vault key is unwrapped from platform storage afterwards, so the
 * security of the data rests on that storage and the OS prompt in front of it,
 * rather than on a boolean this code returns.
 *
 * Failure is always recoverable: every outcome below simply leaves the vault
 * locked and the passcode available. Nothing here can delete or corrupt data,
 * and the failure is reported as a sentence rather than as a code.
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
}

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

function messageFor(reason: AuthFailureReason, kind: 'native' | 'web' = 'native'): string {
  if (kind === 'web') {
    switch (reason) {
      case 'cancelled':
        return 'The device prompt was dismissed. Your vault is still locked.';
      case 'unavailable':
        return 'This computer cannot prompt for a device unlock. Set up Windows Hello or a PIN, or use your Stash passcode.';
      case 'lockout':
        return 'Too many attempts. The device prompt is paused — use your Stash passcode.';
      case 'failed':
      default:
        return 'That did not match. Use your Stash passcode.';
    }
  }

  switch (reason) {
    case 'cancelled':
      return 'Authentication was cancelled. Your vault is still locked.';
    case 'unavailable':
      return 'This device has no biometric or screen lock set up. Use your Stash passcode.';
    case 'lockout':
      return 'Too many attempts. Biometrics are paused — use your Stash passcode.';
    case 'failed':
    default:
      return 'That did not match. Use your Stash passcode.';
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
    authenticate: async (reason) => {
      try {
        // The plugin requires `checkBiometry()` to have run at least once before
        // `authenticate()`, so the prompt is always preceded by a capability read.
        await BiometricAuth.checkBiometry();
        await BiometricAuth.authenticate({
          reason,
          cancelTitle: 'Cancel',
          // The device PIN/pattern/password is offered inside the system dialog,
          // which is the "device credential integration" path.
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
  options: { available?: boolean } = {},
): DeviceAuthenticator {
  return {
    kind: 'native',
    isAvailable: async () => options.available ?? true,
    authenticate: async () => outcome,
  };
}
