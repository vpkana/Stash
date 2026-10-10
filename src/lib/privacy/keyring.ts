import { db, SECURITY_KEYS, type ExportedKeyring, type KeyringRecord } from '@/db';
import {
  decryptString,
  deriveWrappingKey,
  encryptString,
  exportKeyBytes,
  fromBase64,
  generateVaultKey,
  importKeyBytes,
  isEncryptedPayload,
  newSalt,
  PBKDF2_ITERATIONS,
  randomBytes,
  toBase64,
} from './crypto';
import { getSecureStore } from './secure-store';
import { enrollDeviceCredential, forgetDeviceCredential, hasDeviceCredential } from './webauthn';

/**
 * The keyring: where the vault key lives, and how it is protected.
 *
 * Design, in one paragraph. A single random 256-bit AES key — the **vault key**
 * — encrypts every protected field. That key is never derived from a passcode
 * and never written anywhere in the clear. Instead it is *wrapped* (encrypted)
 * under one or two wrapping keys, and the resulting ciphertext is the only thing
 * persisted. Unwrapping is what "unlock" means. This is standard envelope
 * encryption: it keeps the data key's strength independent of any human secret,
 * and it makes changing a passcode a 32-byte re-wrap rather than a full-vault
 * re-encryption.
 *
 * **Two wraps, and they are alternatives.**
 *
 *  - `wrappedByPasscode` — a key derived from a Stash passcode via
 *    PBKDF2-SHA256. Portable: this is the wrap that travels in a backup, and the
 *    one that survives losing the device.
 *  - `wrappedByDevice` — a random 256-bit key held in platform storage, released
 *    only after the OS has verified the person holding the device (fingerprint,
 *    face, phone PIN, Windows Hello). Convenient: nothing to remember, nothing to
 *    type. Device-bound: never exported.
 *
 * A vault may have either, or both. **Device lock alone is a supported setup**
 * — locking that asks for the system prompt instead of a passcode you had to
 * invent — and its one cost is stated plainly wherever it is offered: with no
 * passcode wrap, a wiped device or a lost phone means the locked items are gone,
 * because nothing on earth can unwrap them. Adding a passcode later is a
 * Settings action, and it is what makes the vault portable again.
 *
 * Where keys live:
 *
 *  - the **vault key**, unwrapped: only in this module's memory, for the length
 *    of an unlocked session. It is never put in IndexedDB, localStorage, a
 *    Zustand snapshot, a log line or the DOM.
 *  - the **passcode**, as typed: never stored, never cached, never hashed for
 *    storage. It exists for the duration of one function call, and only its
 *    PBKDF2 output is used.
 *  - the **wrapped** vault key: in the `security` table, which is excluded from
 *    export, from import and from the in-memory snapshot by construction.
 *  - the **device key**: a random 256-bit key in platform storage — the Android
 *    Keystore on a phone, the app's own `security` table on a desktop (see
 *    `secure-store.ts`, which is explicit about the difference).
 */

const DEVICE_KEY_NAME = 'stash.privacy.deviceKey';

/**
 * Shortest passcode the app will accept.
 *
 * PBKDF2 at 210,000 iterations is what stands between a stolen keyring and an
offline guess, and that cost is paid per candidate. A six-character passcode over
 * a realistic alphabet is past the point where guessing is cheaper than the
 * alternatives an attacker already has; anything shorter starts to lean on the
 * iteration count to do work it cannot do. This is a floor, not advice — the field
 * accepts anything longer.
 */
export const MIN_PASSCODE_LENGTH = 6;

export const MIN_PASSCODE_MESSAGE = `Use at least ${MIN_PASSCODE_LENGTH} characters.`;

/**
 * The unwrapped vault key, in memory only.
 *
 * Module scope rather than a store so that nothing serialises it by accident: a
 * Zustand devtools snapshot or a React state dump cannot reach it.
 */
let vaultKey: CryptoKey | null = null;

export function getVaultKey(): CryptoKey | null {
  return vaultKey;
}

/** Clears the key. Called on lock, and on sign-out of the session. */
export function forgetVaultKey(): void {
  vaultKey = null;
}

/**
 * Whether the vault is currently unreadable.
 *
 * This is the app-wide "is the session locked" test, and it is deliberately a
 * statement about the key rather than about a flag someone could forget to
 * update: if we cannot decrypt, we are locked.
 */
export function isSessionLocked(): boolean {
  return vaultKey === null;
}

export async function readKeyring(): Promise<KeyringRecord | null> {
  const row = await db.security.get(SECURITY_KEYS.keyring);
  const value = row?.value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<KeyringRecord>;
  if (record.version !== 1) return null;
  // A keyring with no wrap at all would be a promise to unlock that nothing can
  // keep, so it is treated as absent rather than as a broken lock.
  const hasPasscodeWrap = Boolean(record.kdf) && isEncryptedPayload(record.wrappedByPasscode);
  const hasDeviceWrap = isEncryptedPayload(record.wrappedByDevice);
  if (!hasPasscodeWrap && !hasDeviceWrap) return null;
  return record as KeyringRecord;
}

/** Whether this vault can be opened without the device it was locked on. */
export async function hasPasscodeWrap(): Promise<boolean> {
  const keyring = await readKeyring();
  return Boolean(keyring?.wrappedByPasscode && keyring.kdf);
}

async function writeKeyring(record: KeyringRecord): Promise<void> {
  await db.security.put({ key: SECURITY_KEYS.keyring, value: record });
}

export async function hasKeyring(): Promise<boolean> {
  return (await readKeyring()) !== null;
}

/** Wrap `bytes` with `wrappingKey`, returning ciphertext only. */
async function wrapBytes(wrappingKey: CryptoKey, bytes: Uint8Array) {
  // The plaintext here is a base64 rendering of exactly 32 random bytes. It is
  // never derived from anything human, and it never leaves this function.
  return encryptString(wrappingKey, toBase64(bytes));
}

async function unwrapBytes(wrappingKey: CryptoKey, payload: Parameters<typeof decryptString>[1]) {
  return fromBase64(await decryptString(wrappingKey, payload));
}

export interface KeySetupResult {
  ok: boolean;
  message?: string;
}

/**
 * Create a keyring whose first wrap is a passcode.
 *
 * This is the setup path again, and there is one sentence behind that: a vault
 * must not be able to become unreachable because a *setting* changed. Locking
 * used to be device-only — no passcode, nothing to remember — and the cost was
 * exactly the failure the user hit: turn the biometric option off and the locked
 * folders have no door left. So locking now starts with a passcode, and the
 * device prompt is an *addition* to it rather than a replacement for it. Nothing
 * the OS does to an enrollment can take a passcode away.
 *
 * It also stays the path a vault created by an earlier build is opened with, and
 * the one a backup restored onto another device uses.
 *
 * Refuses if a keyring already exists: replacing one would make every
 * currently-sealed item permanently unreadable, so there is no code path that
 * does it implicitly.
 */
export async function createKeyring(passcode: string): Promise<KeySetupResult> {
  if (await hasKeyring()) {
    return { ok: false, message: 'This vault is already locked.' };
  }
  // The length floor lives here as well as in the store, because this is the
  // function that actually writes the wrap: a caller added later should not be
  // able to create a vault whose only way in is four characters long.
  if (passcode.length < MIN_PASSCODE_LENGTH) {
    return { ok: false, message: MIN_PASSCODE_MESSAGE };
  }
  const vault = await generateVaultKey();
  const salt = newSalt();
  const wrappingKey = await deriveWrappingKey(passcode, salt);
  const wrappedByPasscode = await wrapBytes(wrappingKey, await exportKeyBytes(vault));

  const now = Date.now();
  const record: KeyringRecord = {
    version: 1,
    kdf: { algorithm: 'PBKDF2-SHA256', salt: toBase64(salt), iterations: PBKDF2_ITERATIONS },
    wrappedByPasscode,
    createdAt: now,
    updatedAt: now,
  };
  await writeKeyring(record);
  vaultKey = vault;
  return { ok: true };
}

/**
 * Create a keyring wrapped by a device key alone.
 *
 * **Not the setup path any more, and deliberately kept.** A vault whose only wrap
 * is a device key is one biometric setting away from being unopenable, which is
 * the bug the passcode exists to remove — so locking now starts with a passcode
 * and arms this afterwards, through {@link enableDeviceUnlock}.
 *
 * Nothing in the app calls this. It stays because a keyring in the shape it
 * writes is still a valid keyring: it could have been written by an earlier
 * build, and code that reads a vault has to be able to talk about the shape it is
 * reading. Deleting the writer would not delete the readers.
 */
export async function createKeyringWithDevice(): Promise<KeySetupResult> {
  if (await hasKeyring()) {
    return { ok: false, message: 'Locking is already set up for this vault.' };
  }

  const store = await getSecureStore();
  if (!(await store.isAvailable())) {
    return { ok: false, message: 'This device cannot store a key for a device lock.' };
  }

  const vault = await generateVaultKey();
  const deviceBytes = randomBytes(32);
  const deviceKey = await importKeyBytes(deviceBytes);
  const wrappedByDevice = await wrapBytes(deviceKey, await exportKeyBytes(vault));

  const now = Date.now();
  // Key first, then the record that refers to it: the other order could leave a
  // keyring promising a device unlock with no key behind it.
  await store.set(DEVICE_KEY_NAME, toBase64(deviceBytes));
  await writeKeyring({ version: 1, wrappedByDevice, createdAt: now, updatedAt: now });
  vaultKey = vault;
  return { ok: true };
}

/**
 * Unlock with the passcode.
 *
 * A wrong passcode produces `null` rather than an exception: the AES-GCM tag is
 * what tells us, and a failed tag is a routine outcome here, not an error. Data
 * is untouched either way — this function writes nothing. A vault with no
 * passcode wrap answers `null` for the same reason a wrong passcode does: this
 * way in is not available.
 */
export async function unlockWithPasscode(passcode: string): Promise<CryptoKey | null> {
  const keyring = await readKeyring();
  if (!keyring?.wrappedByPasscode || !keyring.kdf) return null;

  try {
    const wrappingKey = await deriveWrappingKey(
      passcode,
      fromBase64(keyring.kdf.salt),
      keyring.kdf.iterations,
    );
    const bytes = await unwrapBytes(wrappingKey, keyring.wrappedByPasscode);
    const vault = await importKeyBytes(bytes);
    vaultKey = vault;
    return vault;
  } catch {
    return null;
  }
}

/**
 * Unlock through the device key.
 *
 * This is convenience, not a second security tier: the device key sits in
 * platform storage, and reaching it already requires an unlocked device. The
 * system prompt — `BiometricPrompt` on a phone, Windows Hello on a desktop — is
 * what turns that into a deliberate act. If the device key is gone (app data
 * cleared, restore on a new device, keystore entry invalidated) this returns
 * `null` and the passcode is the way in. Nothing is destroyed by its absence,
 * and a vault that was set up device-only says so before the user relies on it.
 */
export async function unlockWithDevice(): Promise<CryptoKey | null> {
  const keyring = await readKeyring();
  if (!keyring?.wrappedByDevice) return null;

  const store = await getSecureStore();
  if (!(await store.isAvailable())) return null;
  const stored = await store.get(DEVICE_KEY_NAME);
  if (!stored) return null;

  try {
    const deviceKey = await importKeyBytes(fromBase64(stored));
    const bytes = await unwrapBytes(deviceKey, keyring.wrappedByDevice);
    const vault = await importKeyBytes(bytes);
    vaultKey = vault;
    return vault;
  } catch {
    // A stale device key (for example after a passcode reset elsewhere) is
    // useless, not dangerous. Drop it so the next attempt goes straight to the
    // passcode instead of failing twice.
    await store.remove(DEVICE_KEY_NAME);
    return null;
  }
}

/**
 * Whether the device fast path is currently usable here.
 *
 * Three things have to hold, and each of them can fail independently: there is a
 * device wrap in the keyring, the platform storage still has the key that opens
 * it, and — on a desktop — this machine still has the credential to prompt with.
 * A `true` from less than all three would put a button on the lock screen that
 * cannot work.
 */
export async function isDeviceUnlockReady(): Promise<boolean> {
  const store = await getSecureStore();
  if (!(await store.isAvailable())) return false;
  const keyring = await readKeyring();
  if (!keyring?.wrappedByDevice) return false;
  if ((await store.get(DEVICE_KEY_NAME)) === null) return false;
  if (store.kind === 'web') return hasDeviceCredential();
  return true;
}

/**
 * Arm the biometric fast path. Requires an unlocked session, since the vault key
 * has to be re-wrapped for the device.
 */
export async function enableDeviceUnlock(): Promise<boolean> {
  const keyring = await readKeyring();
  if (!keyring || !vaultKey) return false;

  const store = await getSecureStore();
  if (!(await store.isAvailable())) return false;

  const deviceBytes = randomBytes(32);
  const deviceKey = await importKeyBytes(deviceBytes);
  const wrappedByDevice = await wrapBytes(deviceKey, await exportKeyBytes(vaultKey));

  // Store the device key before recording the wrap: the reverse order could
  // leave a keyring promising a fast path that has no key behind it.
  await store.set(DEVICE_KEY_NAME, toBase64(deviceBytes));
  await writeKeyring({ ...keyring, wrappedByDevice, updatedAt: Date.now() });

  // On a desktop the prompt is a WebAuthn credential, and enrolling it is part
  // of arming the fast path: without it there is nothing for the OS to ask
  // about. A platform that cannot enrol leaves the device path unarmed, which
  // the passcode covers.
  if (store.kind === 'web') {
    const credential = await enrollDeviceCredential();
    if (!credential) {
      await store.remove(DEVICE_KEY_NAME);
      const current = await readKeyring();
      if (current) {
        const next: KeyringRecord = { ...current, updatedAt: Date.now() };
        delete next.wrappedByDevice;
        await writeKeyring(next);
      }
      return false;
    }
  }

  return true;
}

export async function disableDeviceUnlock(): Promise<void> {
  const store = await getSecureStore();
  await store.remove(DEVICE_KEY_NAME);
  await forgetDeviceCredential();
  const keyring = await readKeyring();
  if (!keyring) return;
  const next: KeyringRecord = { ...keyring, updatedAt: Date.now() };
  delete next.wrappedByDevice;
  await writeKeyring(next);
}

/** Remove the keyring. Only valid once every sealed row has been opened. */
export async function destroyKeyring(): Promise<void> {
  const store = await getSecureStore();
  await store.remove(DEVICE_KEY_NAME);
  // The enrolled WebAuthn credential goes with it: leaving it behind would keep
  // a prompt on this machine that unlocks nothing.
  await forgetDeviceCredential();
  await db.security.delete(SECURITY_KEYS.keyring);
  vaultKey = null;
}

/**
 * Add a passcode wrap to a vault that is already locked.
 *
 * This is the safety net the device prompt cannot be. A device key can stop
 * working for reasons that have nothing to do with the user's memory — the
 * platform invalidates it, the enrollment is removed, a biometric setting is
 * switched off — and on a vault whose only wrap was that key, the content behind
 * it becomes unreachable. A passcode wrap does not have that failure mode: it
 * depends on one thing the user knows and one algorithm that will still be here
 * in ten years.
 *
 * Requires an **unlocked session**, because the vault key itself has to be in
 * memory to be re-wrapped. That is not a limitation to work around: it is the
 * reason setting a passcode is a screen you reach while the vault is open, and
 * the reason the app says so plainly instead of offering a button that would have
 * to fail.
 *
 * Replacing an existing wrap is the same operation — a new salt, a new PBKDF2
 * derivation, a fresh ciphertext of the same 32 bytes. The vault key does not
 * change, so nothing already encrypted needs re-encrypting and no data is at risk
 * at any point in the change.
 */
export async function setPasscodeWrap(passcode: string): Promise<KeySetupResult> {
  if (!vaultKey) {
    return { ok: false, message: 'Unlock the vault first, then set a passcode.' };
  }
  if (passcode.length < MIN_PASSCODE_LENGTH) {
    return { ok: false, message: MIN_PASSCODE_MESSAGE };
  }

  const keyring = await readKeyring();
  if (!keyring) {
    return { ok: false, message: 'This vault has no keyring to add a passcode to.' };
  }

  const salt = newSalt();
  const wrappingKey = await deriveWrappingKey(passcode, salt);
  const wrappedByPasscode = await wrapBytes(wrappingKey, await exportKeyBytes(vaultKey));

  await writeKeyring({
    ...keyring,
    kdf: { algorithm: 'PBKDF2-SHA256', salt: toBase64(salt), iterations: PBKDF2_ITERATIONS },
    wrappedByPasscode,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

/**
 * Remove the passcode wrap, leaving whatever other wraps exist.
 *
 * The mirror image of {@link setPasscodeWrap}, and it has the same precondition
 * for the same reason: the caller has to prove it can open the vault before it
 * may take a way in away. The UI enforces that by requiring the current passcode
 * or a successful device prompt first; this only refuses the case that cannot
 * work at all.
 *
 * Refuses when the passcode is the *only* wrap, because that would leave a
 * keyring with no way in — every sealed row would become ciphertext nobody holds
 * a key for. Changing a passcode is the supported way to rotate it; there is no
 * supported way to end up with nothing.
 */
export async function removePasscodeWrap(): Promise<KeySetupResult> {
  if (!vaultKey) {
    return { ok: false, message: 'Unlock the vault first, then change how it opens.' };
  }
  const keyring = await readKeyring();
  if (!keyring) return { ok: false, message: 'This vault has no keyring.' };
  if (!isEncryptedPayload(keyring.wrappedByDevice)) {
    return {
      ok: false,
      message: 'The passcode is the only way into this vault, so it cannot be removed.',
    };
  }

  const next: KeyringRecord = { ...keyring, updatedAt: Date.now() };
  delete next.kdf;
  delete next.wrappedByPasscode;
  await writeKeyring(next);
  return { ok: true };
}

/**
 * The exportable envelope: the passcode wrap only, never the device wrap.
 *
 * `null` when there is no passcode wrap — a device-locked vault has nothing
 * portable to hand over, and exporting a keyring without a key would promise the
 * receiving device an unlock it cannot perform. The import side already treats
 * sealed rows it cannot open as "locked", so the file stays honest either way;
 * the export screen says so before writing it.
 */
export function toExportedKeyring(keyring: KeyringRecord): ExportedKeyring | null {
  if (!keyring.kdf || !keyring.wrappedByPasscode) return null;
  return {
    version: 1,
    kdf: keyring.kdf,
    wrappedByPasscode: keyring.wrappedByPasscode,
  };
}

/**
 * Adopt a keyring that arrived in a backup.
 *
 * Only ever called when this device has none — taking over an existing keyring
 * would orphan everything already sealed here. The passcode from the original
 * device is what unlocks the adopted vault, and Stash says so before doing it.
 */
export async function adoptExportedKeyring(exported: ExportedKeyring | undefined): Promise<boolean> {
  if (!exported || !isEncryptedPayload(exported.wrappedByPasscode)) return false;
  if (await hasKeyring()) return false;

  const now = Date.now();
  await writeKeyring({
    version: 1,
    kdf: exported.kdf,
    wrappedByPasscode: exported.wrappedByPasscode,
    createdAt: now,
    updatedAt: now,
  });
  return true;
}
