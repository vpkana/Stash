import { db, SECURITY_KEYS, type ExportedKeyring, type KeyringRecord } from '@/db';
import {
  decryptString,
  encryptString,
  exportKeyBytes,
  fromBase64,
  generateVaultKey,
  importKeyBytes,
  isEncryptedPayload,
  randomBytes,
  toBase64,
} from './crypto';
import { getSecureStore } from './secure-store';
import { forgetDeviceCredential, hasDeviceCredential, enrollDeviceCredential } from './webauthn';

/**
 * The keyring: where the vault key lives, and how it is protected.
 *
 * Design, in one paragraph. A single random 256-bit AES key — the **vault key**
 * — encrypts every protected field. That key is never derived from a password
 * and never written anywhere in the clear. Instead it is *wrapped* (encrypted)
 * under a random key held in platform storage, and the resulting ciphertext is
 * the only thing persisted. Unwrapping, after the operating system has verified
 * the person holding the device, is what "unlock" means. This is standard
 * envelope encryption: it keeps the data key's strength independent of anything
 * a human has to remember, and it means nothing about the crypto depends on how
 * the person proved who they were.
 *
 * ## One wrap, and it is the device's
 *
 * `wrappedByDevice` is a random 256-bit key held in `secure-store.ts` —
 * Android's Keystore-backed storage on a phone, the app's own `security` table
 * on a desktop — released only after the OS prompt in `auth.ts` has run. There is
 * nothing to remember and nothing to type, and there is no secret of Stash's own
 * anywhere in the system. A locked folder opens the way a banking app opens: the
 * system asks, the system verifies, and Stash is told the answer.
 *
 * The one cost of that design is stated plainly wherever locking is offered, and
 * it is not hidden behind a vague sentence: **the key is bound to this device**.
 * A wiped phone or a restore onto a new one means the locked items stay locked,
 * because nothing on earth can unwrap them. Locking is a property of the device,
 * and the app says so rather than implying a recovery that does not exist.
 *
 * ## The legacy passcode wrap, and why it is still readable
 *
 * Earlier builds wrapped the vault key under a Stash passcode (PBKDF2-SHA256).
 * That system is gone: no screen creates one, no field accepts one, and nothing
 * unlocks with one. But the *records* are still out there, and a vault whose only
 * wrap was a passcode holds content that can be opened by exactly one thing. So
 * the shape stays readable — see `legacy-passcode.ts`, which exists purely to
 * convert such a vault to the device wrap once, with the passcode the owner
 * already knows, instead of making a year of notes permanently unreadable to save
 * a hundred lines. Deleting the reader would not delete the records.
 *
 * Where keys live:
 *
 *  - the **vault key**, unwrapped: only in this module's memory, for the length
 *    of an unlocked session. It is never put in IndexedDB, localStorage, a
 *    Zustand snapshot, a log line or the DOM.
 *  - the **wrapped** vault key: in the `security` table, which is excluded from
 *    export, from import and from the in-memory snapshot by construction.
 *  - the **device key**: platform storage, never exported, meaningless off-device.
 */

const DEVICE_KEY_NAME = 'stash.privacy.deviceKey';

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
 * Hold a vault key that was unwrapped somewhere else, writing nothing.
 *
 * One caller: the legacy passcode reader, which proves a passcode and hands back
 * the key it opens. Setting it here keeps the rule that "the session is unlocked"
 * has exactly one meaning — the key is in this module — instead of letting another
 * file keep a second copy of it.
 *
 * Writes nothing, on purpose. Whether the key ends up wrapped for this device is
 * a decision for the caller, and on a device whose prompt cannot be raised, the
 * answer is that it does not get wrapped at all.
 */
export function holdVaultKey(vault: CryptoKey): void {
  vaultKey = vault;
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
  const hasLegacyWrap = Boolean(record.kdf) && isEncryptedPayload(record.wrappedByPasscode);
  const hasDeviceWrap = isEncryptedPayload(record.wrappedByDevice);
  if (!hasLegacyWrap && !hasDeviceWrap) return null;
  return record as KeyringRecord;
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
 * Write a device wrap for `vault`, storing the key that opens it first.
 *
 * Key then record, never the other way round: the reverse order could leave a
 * keyring promising a device unlock with no key behind it, which is a lock nobody
 * can open. Returns the wrapped payload, or `null` when there is no usable
 * platform storage — in which case the caller must not write anything.
 */
async function wrapForDevice(vault: CryptoKey) {
  const store = await getSecureStore();
  if (!(await store.isAvailable())) return null;

  const deviceBytes = randomBytes(32);
  const deviceKey = await importKeyBytes(deviceBytes);
  const wrappedByDevice = await wrapBytes(deviceKey, await exportKeyBytes(vault));
  await store.set(DEVICE_KEY_NAME, toBase64(deviceBytes));
  return wrappedByDevice;
}

/**
 * Create the keyring. This is the setup path, and it is device-only.
 *
 * Nothing to choose and nothing to invent: locking a folder for the first time
 * lands here, a random device key goes into platform storage, and the vault key
 * is wrapped under it. The person is not asked to prove anything at this moment
 * because nothing is disclosed by creating a key — the proof is asked for when
 * somebody wants to *read* a locked item, which is the only moment it matters.
 *
 * Refuses if a keyring already exists: replacing one would make every
 * currently-sealed item permanently unreadable, so there is no code path that
 * does it implicitly.
 */
export async function createDeviceKeyring(): Promise<KeySetupResult> {
  if (await hasKeyring()) {
    return { ok: false, message: 'Locking is already set up for this vault.' };
  }

  const vault = await generateVaultKey();
  const wrappedByDevice = await wrapForDevice(vault);
  if (!wrappedByDevice) {
    return {
      ok: false,
      message: 'This device cannot store a key for a device lock, so nothing was changed.',
    };
  }

  const now = Date.now();
  await writeKeyring({ version: 1, wrappedByDevice, createdAt: now, updatedAt: now });
  vaultKey = vault;
  return { ok: true };
}

/**
 * Unlock through the device key.
 *
 * The system prompt in `auth.ts` is what makes this a deliberate act; this
 * function is the read that follows it. If the device key is gone — app data
 * cleared, restore on a new phone, keystore entry invalidated by a platform
 * update — this returns `null` and the locked items are not readable on this
 * device. Nothing is destroyed by its absence, and the app says which of those
 * two situations it is in rather than showing a dead end.
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
    // A stale device key is useless, not dangerous. Drop it so the next attempt
    // fails immediately and honestly instead of failing twice.
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
 * A `true` from less than all three would put a button on the lock gate that
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
 * Adopt an already-unwrapped vault key: keep it for this session and re-wrap it
 * for this device, dropping any legacy passcode wrap in the same write.
 *
 * The one caller is the passcode migration in `legacy-passcode.ts`, which has
 * just proved it can open the vault with the passcode the owner already knew. One
 * record write does the whole conversion, so there is no instant at which the
 * keyring holds a device wrap pointing at nothing, or a passcode wrap the user
 * has no field left to type into.
 *
 * Refuses when there is no usable platform storage. That matters more here than
 * anywhere else: writing the record without the key would discard the only
 * working wrap and strand the content behind it.
 */
export async function adoptVaultKeyForDevice(vault: CryptoKey): Promise<KeySetupResult> {
  const keyring = await readKeyring();
  if (!keyring) return { ok: false, message: 'This vault has no keyring to convert.' };

  const wrappedByDevice = await wrapForDevice(vault);
  if (!wrappedByDevice) {
    return {
      ok: false,
      message: 'This device cannot store a key for a device lock, so nothing was changed.',
    };
  }

  await writeKeyring({
    version: 1,
    wrappedByDevice,
    createdAt: keyring.createdAt,
    updatedAt: Date.now(),
  });
  vaultKey = vault;
  return { ok: true };
}

/**
 * Delete a legacy passcode wrap, leaving the device wrap as the only way in.
 *
 * Called the moment a device unlock has succeeded on a keyring that also carries
 * a passcode wrap — a vault set up by a build that offered both. The device path
 * has just been *demonstrated* to work, so the legacy wrap is dead weight: no
 * screen accepts a passcode any more, and a wrap nothing can open is a promise
 * the record cannot keep.
 *
 * Deliberately not called anywhere else. Dropping a wrap that has not just been
 * proven unnecessary would be the exact failure this whole design is trying to
 * make impossible, in reverse.
 */
export async function dropLegacyPasscodeWrap(): Promise<boolean> {
  const keyring = await readKeyring();
  if (!keyring) return false;
  if (!keyring.wrappedByPasscode && !keyring.kdf) return false;

  const next: KeyringRecord = { ...keyring, updatedAt: Date.now() };
  delete next.kdf;
  delete next.wrappedByPasscode;
  await writeKeyring(next);
  return true;
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
 * The exportable envelope: the legacy passcode wrap, when there is one.
 *
 * `null` for every vault this build creates. A device-locked vault has nothing
 * portable to hand over — the key is bound to the device on purpose — and
 * exporting a keyring without a key would promise the receiving device an unlock
 * it cannot perform. The import side already treats sealed rows it cannot open as
 * "locked", so the file stays honest either way; the export screen says so before
 * writing it.
 *
 * It survives for the files that need it: a backup written by an older build
 * carries a passcode wrap, and that wrap is the only portable key that content
 * will ever have. Reading such a file still has to export it back faithfully.
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
 * would orphan everything already sealed here. What it adopts is always the
 * legacy shape, because that is the only shape a backup can carry; the vault it
 * belongs to is then a passcode-only vault until the migration converts it, which
 * is one prompt rather than a lost subtree.
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

/**
 * Enrol a platform credential for a desktop prompt.
 *
 * Exported for the one caller that needs it: a vault being set up on a browser
 * has nothing for WebAuthn to challenge unless a credential is enrolled, and
 * enrolling is only meaningful after a prompt has already been shown. Not used on
 * a native platform, where the prompt works without an enrolment of ours.
 */
export async function ensureDeviceCredential(): Promise<boolean> {
  const store = await getSecureStore();
  if (store.kind !== 'web') return true;
  return (await enrollDeviceCredential()) !== null;
}
