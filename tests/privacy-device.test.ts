import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import { createNote, setNoteLocked } from '@/db/repos/notes';
import { exportVault } from '@/db/repos/vault';
import {
  createStaticAuthenticator,
  devicePromptName,
  getDeviceAuthenticator,
  messageFor,
  setDeviceAuthenticator,
} from '@/lib/privacy/auth';
import { hasDeviceCredential } from '@/lib/privacy/webauthn';
import * as keyring from '@/lib/privacy/keyring';
import {
  adoptVaultKeyForDevice,
  createDeviceKeyring,
  dropLegacyPasscodeWrap,
  ensureDeviceCredential,
  forgetVaultKey,
  getVaultKey,
  hasKeyring,
  isDeviceUnlockReady,
  isSessionLocked,
  readKeyring,
  toExportedKeyring,
  unlockWithDevice,
} from '@/lib/privacy/keyring';
import {
  hasLegacyPasscodeWrap,
  isPasscodeOnlyVault,
  openWithLegacyPasscode,
} from '@/lib/privacy/legacy-passcode';
import { isSealed } from '@/lib/privacy/protection';
import { setSecureStore, UNAVAILABLE_SECURE_STORE } from '@/lib/privacy/secure-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import {
  addDeviceWrapKeepingPasscode,
  makeKeyringPasscodeOnly,
  memorySecureStore,
  setupDeviceVault,
  setupLegacyPasscodeVault,
} from './privacy-fixtures';

/**
 * Locking that asks the device instead of Stash.
 *
 * This is the whole system: nothing to invent, nothing to type, the same shape as
 * a banking app asking for the phone's own lock — with one difference that is the
 * product's reason for existing, which is that the lock is on a folder rather
 * than on the app. What these tests pin down is that it is a *whole* lock: the key
 * really is only reachable through the device wrap, the content really is
 * ciphertext at rest, and there is no second secret anywhere.
 *
 * The legacy shape is covered here too, because it is the one thing that can make
 * that content unreachable: a vault an earlier build wrapped under a passcode has
 * to keep opening, and has to convert.
 */

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
  it('creates a keyring that has a device wrap and no passcode fields at all', async () => {
    expect(await createDeviceKeyring()).toMatchObject({ ok: true });

    const record = await readKeyring();
    expect(record?.wrappedByDevice).toBeTruthy();
    expect(record?.wrappedByPasscode).toBeUndefined();
    expect(record?.kdf).toBeUndefined();

    expect(await hasKeyring()).toBe(true);
    expect(await hasLegacyPasscodeWrap()).toBe(false);
    expect(isSessionLocked()).toBe(false);
  });

  it('has no passcode API left in the module at all', () => {
    /*
     * A structural assertion, and it is the point of the change rather than a
     * curiosity: the reported problem was a lock system that asked for a password.
     * Every function that could create, set, remove or verify one is gone from the
     * keyring, so there is no code path — and no *reachable* code path in a later
     * refactor — that could reintroduce a second secret without deleting this
     * test first.
     */
    for (const name of [
      'createKeyring',
      'unlockWithPasscode',
      'setPasscodeWrap',
      'removePasscodeWrap',
      'hasPasscodeWrap',
      'createKeyringWithDevice',
      'enableDeviceUnlock',
      'disableDeviceUnlock',
    ]) {
      expect(Object.keys(keyring)).not.toContain(name);
    }
  });

  it('opens with the device and nothing else can open it', async () => {
    await createDeviceKeyring();
    forgetVaultKey();
    expect(isSessionLocked()).toBe(true);

    expect(await unlockWithDevice()).not.toBeNull();
    forgetVaultKey();

    // There is no passcode, so no input opens it — including a guess that would
    // have been right on a passcode-locked vault.
    expect(await openWithLegacyPasscode('')).toBeNull();
    expect(await openWithLegacyPasscode('open sesame 42')).toBeNull();
    expect(isSessionLocked()).toBe(true);
  });

  it('reports the device path as ready, so the gate can offer it', async () => {
    await createDeviceKeyring();
    expect(await isDeviceUnlockReady()).toBe(true);
  });

  it('refuses a second setup rather than replacing a key that is in use', async () => {
    await createDeviceKeyring();
    expect(await createDeviceKeyring()).toMatchObject({ ok: false });
    expect(await hasKeyring()).toBe(true);
  });

  it('will not lock the vault when the platform cannot store a device key', async () => {
    setSecureStore(UNAVAILABLE_SECURE_STORE);
    const result = await createDeviceKeyring();
    expect(result.ok).toBe(false);
    // Nothing was written, so there is no keyring promising an unlock nothing can
    // perform.
    expect(await hasKeyring()).toBe(false);
  });

  it('has nothing to drop when the vault never had a passcode wrap', async () => {
    await createDeviceKeyring();
    expect(await dropLegacyPasscodeWrap()).toBe(false);
  });
});

/**
 * The same guard, from the other side — and the distinction the guard turns on.
 *
 * A build that offered a passcode and a device unlock together left keyrings with
 * *both* wraps. The device prompt opens those, so they are ordinary vaults: they
 * take new locks, and the leftover passcode wrap is dropped silently the moment
 * the device path works (`unlockWithBiometrics`). Treating "has a passcode wrap"
 * as "the passcode is the way in" is what would put an unnecessary password field
 * in front of someone who never needed one.
 */
describe('a vault left with a device wrap beside a passcode', () => {
  async function build(): Promise<void> {
    await setupDeviceVault();
    await makeKeyringPasscodeOnly('open sesame 42');
    await addDeviceWrapKeepingPasscode();
  }

  it('reports the passcode as a fallback and not as the way in', async () => {
    await build();
    // `reload` is the honest way in: it reads the keyring and derives both facts
    // from it, which is what a cold start does.
    await usePrivacyStore.getState().reload();

    const state = usePrivacyStore.getState();
    expect(state.keyringPresent).toBe(true);
    expect(state.legacyPasscodeAvailable).toBe(true);
    expect(state.legacyPasscodeOnly).toBe(false);
    expect(state.deviceUnlockReady).toBe(true);
  });

  it('still takes new locks, because the device opens what they seal', async () => {
    await build();
    expect(await usePrivacyStore.getState().ensureLocking()).toEqual({ ok: true });
  });

  it('drops the leftover passcode wrap on the first device unlock, asking nothing', async () => {
    await build();
    forgetVaultKey();

    const unlocked = await usePrivacyStore.getState().unlockWithBiometrics();
    expect(unlocked.ok).toBe(true);

    // Gone from the record, not merely forgotten by the screen: the next start
    // has nothing left to offer a passcode field for.
    expect(await hasLegacyPasscodeWrap()).toBe(false);
    await usePrivacyStore.getState().reload();
    expect(usePrivacyStore.getState().legacyPasscodeAvailable).toBe(false);
    expect(usePrivacyStore.getState().legacyPasscodeOnly).toBe(false);
  });
});

describe('a device-locked vault has no passcode', () => {
  it('wraps the key once, under the device key, and nothing else', async () => {
    await createDeviceKeyring();

    const record = await readKeyring();
    expect(record?.wrappedByDevice).toBeTruthy();
    // The whole point of the change: there is no second secret to lose, so a vault
    // set up today has nothing for a passcode field to open.
    expect(record?.wrappedByPasscode).toBeUndefined();
    expect(record?.kdf).toBeUndefined();
    expect(await hasLegacyPasscodeWrap()).toBe(false);

    forgetVaultKey();
    expect(await unlockWithDevice()).not.toBeNull();
    expect(await openWithLegacyPasscode('anything at all')).toBeNull();
  });

  it('still seals content, so what locking protects is really encrypted', async () => {
    await createDeviceKeyring();
    const note = await createNote({ title: 'Passport scan', content: 'private', parentNoteId: null });
    if (!note.ok) throw new Error('note');
    await setNoteLocked(note.note.id, true);

    const stored = await db.notes.get(note.note.id);
    expect(isSealed(stored ?? {})).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('Passport scan');
  });
});

describe('a vault an earlier build locked with a passcode', () => {
  it('opens with the passcode it was locked with, and is not changed by reading it', async () => {
    await setupLegacyPasscodeVault('open sesame 42');
    const before = (await readKeyring())?.wrappedByPasscode?.ct;

    forgetVaultKey();
    // No device wrap exists, so the prompt has nothing to release.
    expect(await isDeviceUnlockReady()).toBe(false);
    expect(await unlockWithDevice()).toBeNull();

    // The passcode is the one input that reaches it — and reading changes nothing.
    const wrong = await openWithLegacyPasscode('not the one');
    expect(wrong).toBeNull();
    expect((await readKeyring())?.wrappedByPasscode?.ct).toBe(before);

    const key = await openWithLegacyPasscode('open sesame 42');
    expect(key).not.toBeNull();
    expect((await readKeyring())?.wrappedByPasscode?.ct).toBe(before);
    expect(await hasLegacyPasscodeWrap()).toBe(true);
  });

  it('converts to the device lock, keeping the same vault key', async () => {
    await setupLegacyPasscodeVault('open sesame 42');
    const before = getVaultKey();
    expect(before).not.toBeNull();
    forgetVaultKey();

    const key = await openWithLegacyPasscode('open sesame 42');
    if (!key) throw new Error('the passcode did not open its own vault');
    expect(await adoptVaultKeyForDevice(key)).toMatchObject({ ok: true });

    // One write, both facts: the device wrap is there and the passcode is gone, so
    // there is no instant where the record promises a way in that does not exist.
    const record = await readKeyring();
    expect(record?.wrappedByDevice).toBeTruthy();
    expect(record?.wrappedByPasscode).toBeUndefined();
    expect(record?.kdf).toBeUndefined();
    expect(await hasLegacyPasscodeWrap()).toBe(false);

    // The key itself is the same key, which is why nothing had to be re-encrypted.
    forgetVaultKey();
    expect(await unlockWithDevice()).not.toBeNull();
    expect(await openWithLegacyPasscode('open sesame 42')).toBeNull();
  });

  it('refuses to convert when this device cannot store a key, leaving the vault openable', async () => {
    await setupLegacyPasscodeVault('open sesame 42');
    forgetVaultKey();
    setSecureStore(UNAVAILABLE_SECURE_STORE);

    const key = await openWithLegacyPasscode('open sesame 42');
    if (!key) throw new Error('the passcode did not open its own vault');
    const converted = await adoptVaultKeyForDevice(key);
    expect(converted.ok).toBe(false);

    // This is the failure that would lose the content, so it is checked with the
    // vault reloaded: the passcode wrap is untouched and still opens it. Writing
    // the record without the key would have discarded the only working wrap.
    forgetVaultKey();
    setSecureStore(memorySecureStore());
    expect(await openWithLegacyPasscode('open sesame 42')).not.toBeNull();
    expect(await hasLegacyPasscodeWrap()).toBe(true);
  });
});

describe('locking new items in a vault that is still passcode-only', () => {
  /*
   * The reported bug, pinned at the layer that caused it.
   *
   * A vault left behind by the earlier build keeps its locks, and the app has to
   * respect them. What it must not do is quietly accept *new* locks into it: the
   * user would set a lock, and the next tap would ask for a passcode they never
   * chose. Refusing, with a sentence that names the situation, is the only honest
   * answer, and it is what stops the dead end from being reachable at all.
   */
  it('refuses, so nothing new is sealed behind a passcode the user never set', async () => {
    await setupLegacyPasscodeVault('open sesame 42');
    usePrivacyStore.setState({ keyringPresent: true });

    const result = await usePrivacyStore.getState().ensureLocking();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('old Stash passcode');
  });

  it('is a no-op on the vault this build creates', async () => {
    await createDeviceKeyring();
    usePrivacyStore.setState({ keyringPresent: true, legacyPasscodeOnly: false });
    expect(await usePrivacyStore.getState().ensureLocking()).toEqual({ ok: true });
  });

  it('distinguishes a passcode-only vault from one that merely still carries a passcode wrap', async () => {
    await createDeviceKeyring();
    // Device-only: the prompt opens it, so the passcode is dead weight rather
    // than the only way in.
    expect(await isPasscodeOnlyVault()).toBe(false);

    await makeKeyringPasscodeOnly('open sesame 42');
    expect(await isPasscodeOnlyVault()).toBe(true);
    expect(await hasLegacyPasscodeWrap()).toBe(true);
  });
});

describe('exporting a device-locked vault', () => {
  it('hands over no keyring, because there is nothing portable to hand over', async () => {
    await createDeviceKeyring();
    const record = await readKeyring();
    expect(record).not.toBeNull();
    expect(toExportedKeyring(record!)).toBeNull();

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
    await setupLegacyPasscodeVault('a portable secret');

    const record = await readKeyring();
    const exported = toExportedKeyring(record!);
    expect(exported?.wrappedByPasscode).toBeTruthy();
    expect(JSON.stringify(exported)).not.toContain('wrappedByDevice');

    const bundle = await exportVault();
    expect(bundle.security?.keyring?.wrappedByPasscode).toBeTruthy();
  });
});

describe('capability versus enrollment on a desktop', () => {
  /**
   * The reported failure, at the layer where it lived.
   *
   * On a desktop the device prompt is WebAuthn, so "can this machine prompt?" and
   * "has Stash enrolled a credential here?" are two different questions. Reading
   * the second one to decide whether the feature can be *offered* is a deadlock:
   * the credential is created by enrolling, and enrolling is refused while the
   * feature reads as unavailable. A machine with Windows Hello configured has to
   * answer "yes, I can prompt" before anything has been enrolled.
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
      expect(await hasDeviceCredential()).toBe(false);
      /*
       * And the question that decides whether locks get removed answers
       * `'unknown'` here, never `'insecure'`. A page cannot see the operating
       * system's screen lock, and a guess in that direction would delete
       * protection the user asked for on a machine that may be perfectly secure.
       */
      expect(await authenticator.security()).toBe('unknown');
    } finally {
      globals.window = realWindow;
      globals.PublicKeyCredential = realPublicKeyCredential;
      setDeviceAuthenticator(null);
    }
  });

  it('does not need an enrolment of its own on a native platform', async () => {
    setSecureStore(memorySecureStore('native'));
    await createDeviceKeyring();
    expect(await ensureDeviceCredential()).toBe(true);
  });
});

describe('what the prompt is called', () => {
  it('names the platform dialog rather than saying "biometrics"', () => {
    expect(devicePromptName('web')).toContain('Windows Hello');
    expect(devicePromptName('native')).toContain('fingerprint');
    expect(devicePromptName('unavailable')).toContain('fingerprint');
  });

  /**
   * The requirement, stated as something that cannot regress by accident: no
   * outcome of authentication tells the user to reach for a Stash passcode, because
   * there is no such thing any more. Every message names the device instead.
   */
  it('never sends anyone to a passcode', () => {
    for (const reason of ['cancelled', 'unavailable', 'failed', 'lockout'] as const) {
      for (const kind of ['native', 'web'] as const) {
        expect(messageFor(reason, kind).toLowerCase()).not.toContain('passcode');
      }
    }
    // And the failure to be most careful about says what to do instead.
    expect(messageFor('unavailable')).toContain('screen lock');
  });
});
