import Dexie from 'dexie';
import { db, openDatabase, SECURITY_KEYS } from '@/db';
import { adoptVaultKeyForDevice, createDeviceKeyring, getVaultKey } from '@/lib/privacy/keyring';
import {
  deriveWrappingKey,
  encryptString,
  exportKeyBytes,
  fromBase64,
  importKeyBytes,
  newSalt,
  PBKDF2_ITERATIONS,
  toBase64,
} from '@/lib/privacy/crypto';
import { getSecureStore, type SecureStore } from '@/lib/privacy/secure-store';

/** The name `keyring.ts` stores the device key under. Unchanged since it was introduced. */
const DEVICE_KEY_NAME = 'stash.privacy.deviceKey';

/**
 * Shared fixtures for the privacy suites.
 *
 * Two vault shapes are needed across the tests and only two, so they live here
 * rather than being re-written in each file:
 *
 *  - **the device vault**, which is what this build sets up: one random key in
 *    platform storage, the vault key wrapped under it, nothing to choose;
 *  - **the legacy vault**, which is what an earlier build left behind: the vault
 *    key wrapped under a Stash passcode, with no device wrap at all. Tests use it
 *    for the state where *nothing* can prompt for the vault — the only state in
 *    which the gate has to ask a person for something. Two flavours are built
 *    from it: passcode-*only*, and the older shape that also kept a device wrap,
 *    which the app must never mistake for the first.
 *
 * The legacy keyring is written with the same primitives the old setup path used
 * rather than as a hand-shaped object. That matters: a fixture would be our guess
 * at the old format, and these tests exist to prove the reader works on the real
 * thing.
 */

/** Stands in for Keystore-backed storage (native) or the app's own table (web). */
export function memorySecureStore(kind: 'native' | 'web' = 'native'): SecureStore {
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

export async function resetDatabase(): Promise<void> {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

/** Create the setup this build makes, and leave the vault key in the session. */
export async function setupDeviceVault(): Promise<void> {
  const result = await createDeviceKeyring();
  if (!result.ok) throw new Error(`could not set up the device vault: ${result.message ?? 'unknown'}`);
}

/**
 * Rewrite the current keyring into the shape an earlier build wrote.
 *
 * Requires a session key, because the passcode wrap has to hold the *same* vault
 * key the vault is already encrypted with — which is what makes the result a real
 * legacy vault rather than an unrelated one. The device wrap is simply absent,
 * which is exactly the difference: after this, nothing can prompt for the vault.
 */
export async function makeKeyringPasscodeOnly(passcode: string): Promise<void> {
  const vault = getVaultKey();
  if (!vault) throw new Error('the session has no vault key to re-wrap');

  const salt = newSalt();
  const wrappingKey = await deriveWrappingKey(passcode, salt);
  const wrappedByPasscode = await encryptString(wrappingKey, toBase64(await exportKeyBytes(vault)));

  const existing = await db.security.get(SECURITY_KEYS.keyring);
  const createdAt =
    typeof (existing?.value as { createdAt?: unknown })?.createdAt === 'number'
      ? ((existing?.value as { createdAt: number }).createdAt as number)
      : Date.now();

  await db.security.put({
    key: SECURITY_KEYS.keyring,
    value: {
      version: 1,
      kdf: { algorithm: 'PBKDF2-SHA256', salt: toBase64(salt), iterations: PBKDF2_ITERATIONS },
      wrappedByPasscode,
      createdAt,
      updatedAt: Date.now(),
    },
  });
}

/** A vault whose only way in is a passcode an earlier build asked for. */
export async function setupLegacyPasscodeVault(passcode: string): Promise<void> {
  await setupDeviceVault();
  await makeKeyringPasscodeOnly(passcode);
}

/**
 * Put a device wrap *back* onto a passcode-wrapped vault, keeping both.
 *
 * This is the shape a build that offered a passcode and a device unlock side by
 * side left behind, and the one the product has to be able to tell apart from a
 * passcode-only vault: the device prompt opens it, so the leftover passcode wrap
 * is dead weight to be dropped silently rather than a field to put in front of
 * somebody. It has to be assembled here because nothing in this build writes a
 * keyring with two wraps — which is the point.
 *
 * Uses the device key the secure store already holds (from `setupDeviceVault`),
 * so the resulting wrap is a real one rather than a hand-shaped object.
 */
export async function addDeviceWrapKeepingPasscode(): Promise<void> {
  const vault = getVaultKey();
  if (!vault) throw new Error('the session has no vault key to wrap');

  const store = await getSecureStore();
  const stored = await store.get(DEVICE_KEY_NAME);
  if (!stored) throw new Error('the secure store holds no device key');

  const deviceKey = await importKeyBytes(fromBase64(stored));
  const wrappedByDevice = await encryptString(deviceKey, toBase64(await exportKeyBytes(vault)));

  const existing = await db.security.get(SECURITY_KEYS.keyring);
  await db.security.put({
    key: SECURITY_KEYS.keyring,
    value: { ...(existing?.value as object), wrappedByDevice, updatedAt: Date.now() },
  });
}

/**
 * Give the current vault a device wrap, using the key the session already holds.
 *
 * The equivalent of "arm the device prompt" on a vault that does not have one; it
 * converts the keyring, so the passcode — if there was one — is gone afterwards,
 * which is the same thing the product does when a device unlock succeeds.
 */
export async function armDeviceWrap(): Promise<boolean> {
  const vault = getVaultKey();
  if (!vault) throw new Error('the session has no vault key to wrap');
  return (await adoptVaultKeyForDevice(vault)).ok;
}
