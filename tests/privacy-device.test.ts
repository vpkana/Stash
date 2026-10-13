import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import { createNote, setNoteLocked } from '@/db/repos/notes';
import { exportVault } from '@/db/repos/vault';
import {
  createStaticAuthenticator,
  devicePromptName,
  getDeviceAuthenticator,
  setDeviceAuthenticator,
} from '@/lib/privacy/auth';
import { hasDeviceCredential } from '@/lib/privacy/webauthn';
import {
  createKeyring,
  createKeyringWithDevice,
  enableDeviceUnlock,
  forgetVaultKey,
  hasKeyring,
  hasPasscodeWrap,
  isDeviceUnlockReady,
  isSessionLocked,
  readKeyring,
  toExportedKeyring,
  unlockWithDevice,
  unlockWithPasscode,
} from '@/lib/privacy/keyring';
import { isSealed } from '@/lib/privacy/protection';
import { setSecureStore, type SecureStore } from '@/lib/privacy/secure-store';
import { usePrivacyStore } from '@/stores/privacy-store';

/**
 * Locking that asks for the device instead of a passcode.
 *
 * This is the setup the user described: nothing to invent, nothing to type —
 * the same shape as a banking app asking for the phone's own lock. What these
 * tests pin down is that it is a *whole* vault lock rather than a decoration:
 * the key really is only reachable through the device wrap, a passcode can be
 * added later without re-encrypting anything, and the absent passcode is
 * reported honestly instead of pretending a recovery path exists.
 */

/** Stands in for Keystore-backed storage (native) or the app's own table (web). */
function memorySecureStore(kind: 'native' | 'web' = 'native'): SecureStore {
  const values = new Map<string, string>();
  return {
    kind,
    isAvailable: async () => true,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}

const PRISTINE = usePrivacyStore.getState();

async function resetDatabase() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

beforeEach(async () => {
  await resetDatabase();
  forgetVaultKey();
  usePrivacyStore.setState({ ...PRISTINE }, true);
  setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));
  setSecureStore(memorySecureStore());
});

describe('setting up with the device lock alone', () => {
  it('creates a keyring that has a device wrap and no passcode wrap', async () => {
    expect(await createKeyringWithDevice()).toMatchObject({ ok: true });

    const keyring = await readKeyring();
    expect(keyring?.wrappedByDevice).toBeTruthy();
    expect(keyring?.wrappedByPasscode).toBeUndefined();
    expect(keyring?.kdf).toBeUndefined();

    expect(await hasKeyring()).toBe(true);
    expect(await hasPasscodeWrap()).toBe(false);
    expect(isSessionLocked()).toBe(false);
  });

  it('opens with the device and refuses every passcode', async () => {
    await createKeyringWithDevice();
    forgetVaultKey();
    expect(isSessionLocked()).toBe(true);

    expect(await unlockWithDevice()).not.toBeNull();
    forgetVaultKey();

    // There is no passcode, so no input opens it — including a guess that would
    // have been right on a passcode-locked vault.
    expect(await unlockWithPasscode('')).toBeNull();
    expect(await unlockWithPasscode('open sesame 42')).toBeNull();
    expect(isSessionLocked()).toBe(true);
  });

  it('reports the device path as ready, so the lock screen can offer it', async () => {
    await createKeyringWithDevice();
    expect(await isDeviceUnlockReady()).toBe(true);
  });

  it('refuses a second setup rather than replacing a key that is in use', async () => {
    await createKeyringWithDevice();
    expect(await createKeyringWithDevice()).toMatchObject({ ok: false });
    expect(await createKeyring('a passcode')).toMatchObject({ ok: false });
  });

  it('will not lock the vault when the platform cannot store a device key', async () => {
    setSecureStore({
      kind: 'unavailable',
      isAvailable: async () => false,
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
    });
    const result = await createKeyringWithDevice();
    expect(result.ok).toBe(false);
    expect(await hasKeyring()).toBe(false);
  });
});

describe('a device-locked vault has no passcode', () => {
  it('wraps the key once, under the device key, and nothing else', async () => {
    await createKeyringWithDevice();

    const keyring = await readKeyring();
    expect(keyring?.wrappedByDevice).toBeTruthy();
    // The whole point of the change: there is no second secret to lose, so a
    // vault set up today has nothing for a passcode field to open.
    expect(keyring?.wrappedByPasscode).toBeUndefined();
    expect(keyring?.kdf).toBeUndefined();
    expect(await hasPasscodeWrap()).toBe(false);

    forgetVaultKey();
    expect(await unlockWithDevice()).not.toBeNull();
    expect(await unlockWithPasscode('anything at all')).toBeNull();
  });

  it('still seals content, so what locking protects is really encrypted', async () => {
    await createKeyringWithDevice();
    const note = await createNote({ title: 'Passport scan', content: 'private', parentNoteId: null });
    if (!note.ok) throw new Error('note');
    await setNoteLocked(note.note.id, true);

    const stored = await db.notes.get(note.note.id);
    expect(isSealed(stored ?? {})).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('Passport scan');
  });
});

describe('exporting a device-locked vault', () => {
  it('hands over no keyring, because there is nothing portable to hand over', async () => {
    await createKeyringWithDevice();
    const keyring = await readKeyring();
    expect(keyring).not.toBeNull();
    expect(toExportedKeyring(keyring!)).toBeNull();

    const bundle = await exportVault();
    expect(bundle.security?.keyring).toBeUndefined();
  });

  /**
   * The interop half of the same rule. A vault created by an earlier build — or
   * restored from a backup one of those wrote — carries a passcode wrap, and that
   * wrap is the only portable key there is. It has to keep exporting, and keep
   * opening, or that content becomes unreachable.
   */
  it('hands over the passcode wrap when the vault has one', async () => {
    await createKeyring('a portable secret');

    const keyring = await readKeyring();
    const exported = toExportedKeyring(keyring!);
    expect(exported?.wrappedByPasscode).toBeTruthy();
    expect(JSON.stringify(exported)).not.toContain('wrappedByDevice');

    const bundle = await exportVault();
    expect(bundle.security?.keyring?.wrappedByPasscode).toBeTruthy();
  });
});

describe('arming the device path on a passcode vault', () => {
  it('adds a device wrap beside the passcode wrap, and the passcode still works', async () => {
    await createKeyring('open sesame 42');
    expect(await enableDeviceUnlock()).toBe(true);

    expect(await hasPasscodeWrap()).toBe(true);
    expect(await isDeviceUnlockReady()).toBe(true);

    forgetVaultKey();
    expect(await unlockWithDevice()).not.toBeNull();
    forgetVaultKey();
    expect(await unlockWithPasscode('open sesame 42')).not.toBeNull();
  });

  it('reports the device path as unusable when the stored key is gone', async () => {
    await createKeyring('open sesame 42');
    await enableDeviceUnlock();
    // A cleared app: the wrap in the keyring survives, the secure store does not.
    setSecureStore(memorySecureStore());
    expect(await isDeviceUnlockReady()).toBe(false);
    // And unlocking falls back rather than failing twice.
    expect(await unlockWithDevice()).toBeNull();
    expect(await unlockWithPasscode('open sesame 42')).not.toBeNull();
  });
});

describe('capability versus enrollment on a desktop', () => {
  /**
   * The reported failure, at the layer where it lived.
   *
   * On a desktop the device prompt is WebAuthn, so "can this machine prompt?" and
   * "has Stash enrolled a credential here?" are two different questions. Reading
   * the second one to decide whether the feature can be *offered* is a deadlock:
   * the credential is created by arming, and arming is refused while the feature
   * reads as unavailable. A machine with Windows Hello configured has to answer
   * "yes, I can prompt" before anything has been enrolled — that is what makes the
   * settings switch tappable at all.
   */
  it('answers yes on a machine that can prompt, with nothing enrolled', async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const realWindow = globals.window;
    const realPublicKeyCredential = globals.PublicKeyCredential;

    // A browser on a desktop with a platform authenticator, and no credential
    // stored by Stash yet.
    globals.window = { isSecureContext: true, PublicKeyCredential: function () {} };
    globals.PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    };
    setDeviceAuthenticator(null);

    try {
      const authenticator = await getDeviceAuthenticator();
      expect(authenticator.kind).toBe('web');
      expect(await authenticator.isAvailable()).toBe(true);
      // Nothing is enrolled, so this is capability alone — which is the point.
      expect(await hasDeviceCredential()).toBe(false);
    } finally {
      globals.window = realWindow;
      globals.PublicKeyCredential = realPublicKeyCredential;
      setDeviceAuthenticator(null);
    }
  });
});

describe('naming the prompt', () => {
  it('names the platform dialog rather than saying "biometrics"', () => {
    expect(devicePromptName('web')).toContain('Windows Hello');
    expect(devicePromptName('native')).toContain('fingerprint');
    expect(devicePromptName('unavailable')).toContain('fingerprint');
  });
});
