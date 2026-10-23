import type { RecoveryWrap } from '@/db/types';
import { writeSyncMeta } from '@/db/repos/sync';
import {
  decryptString,
  deriveWrappingKey,
  encryptString,
  exportKeyBytes,
  fromBase64,
  importKeyBytes,
  keyFingerprint,
  newSalt,
  PBKDF2_ITERATIONS,
  randomBytes,
  toBase64,
} from '@/lib/privacy/crypto';
import {
  ensureDeviceCredential,
  getVaultKey,
  installVaultKeyFromRecovery,
  readKeyring,
  writeRecoveryWrap,
  type KeySetupResult,
} from '@/lib/privacy/keyring';
import {
  KEYRING_PREFIX,
  SYNC_PROTOCOL,
  SYNC_PROTOCOL_VERSION,
  keyringFileName,
  validateKeyringFile,
} from '@/lib/sync/protocol';
import type { SyncTransport } from '@/lib/sync/transport';

/**
 * The portable half of the key story.
 *
 * Device biometrics / WebAuthn decide *who may ask* for the vault key. This file
 * decides how a second device can *hold* it: a 160-bit recovery key, shown once,
 * that wraps the same vault key. The two are deliberately separate. Google
 * sign-in moves ciphertext, the device prompt gates each locked folder, and the
 * recovery key is only needed to establish the vault key on a new device.
 *
 * There is no short password anywhere in this design, and nothing here weakens
 * the per-folder prompt: entering the recovery key installs a device wrap, after
 * which the ordinary BiometricPrompt / WebAuthn gate still applies.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_BYTES = 20; // 160 bits
const CHECK_BITS = 20;
const DATA_CHARS = 32;
const CHECK_CHARS = 4;
const KEY_CHARS = DATA_CHARS + CHECK_CHARS;

export interface RecoveryKeyMaterial {
  /** Grouped for reading aloud / writing down. Displayed exactly once. */
  formatted: string;
  /** Canonical 36-character Crockford form used as KDF input. */
  canonical: string;
}

export async function generateRecoveryKey(): Promise<RecoveryKeyMaterial> {
  const data = randomBytes(DATA_BYTES);
  const checksum = await checksumFor(data);
  const canonical = encodeBits(data, checksum);
  return { formatted: formatRecoveryKey(canonical), canonical };
}

/**
 * Accept the key as a person would type it: any case, with or without grouping,
 * with the usual Crockford confusions (O→0, I/L→1). Rejects U, which the
 * alphabet deliberately omits.
 */
export function normalizeRecoveryKey(input: string): RecoveryKeyMaterial | null {
  const compact = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (compact.length !== KEY_CHARS) return null;
  if (compact.includes('U')) return null;
  for (const char of compact) if (ALPHABET.indexOf(char) < 0) return null;
  return { formatted: formatRecoveryKey(compact), canonical: compact };
}

/** Decode and verify the checksum without deriving a key. */
export async function decodeRecoveryKey(input: string): Promise<RecoveryKeyMaterial | null> {
  const normalized = normalizeRecoveryKey(input);
  if (!normalized) return null;
  const compact = normalized.canonical;
  const bits = valuesToBits(compact);
  const dataBits = bits.slice(0, DATA_BYTES * 8);
  const checkBits = bits.slice(DATA_BYTES * 8);
  const data = bitsToBytes(dataBits);
  const expected = await checksumFor(data);
  const provided = parseInt(checkBits, 2);
  if (provided !== expected) return null;
  return normalized;
}

function formatRecoveryKey(canonical: string): string {
  return canonical.match(/.{1,4}/g)?.join('-') ?? canonical;
}

function valuesToBits(compact: string): string {
  let bits = '';
  for (const char of compact) {
    const value = ALPHABET.indexOf(char);
    bits += value.toString(2).padStart(5, '0');
  }
  return bits;
}

function encodeBits(data: Uint8Array, checksum: number): string {
  let bits = '';
  for (const byte of data) bits += byte.toString(2).padStart(8, '0');
  bits += checksum.toString(2).padStart(CHECK_BITS, '0');
  let out = '';
  for (let index = 0; index < KEY_CHARS; index += 1) {
    out += ALPHABET[parseInt(bits.slice(index * 5, index * 5 + 5), 2)] as string;
  }
  return out;
}

function bitsToBytes(bits: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  return bytes;
}

async function checksumFor(data: Uint8Array): Promise<number> {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy));
  return ((digest[0] as number) << 12) | ((digest[1] as number) << 4) | ((digest[2] as number) >> 4);
}

export interface RecoverySetupResult {
  ok: boolean;
  message?: string;
  /** Present only at creation. It is not recoverable later. */
  key?: string;
}

/**
 * Create (or rotate) the recovery wrap. Requires the vault key in memory, which
 * in practice means the user has just crossed a device prompt.
 */
export async function createRecoveryKey(): Promise<RecoverySetupResult> {
  const vault = getVaultKey();
  if (!vault) {
    return { ok: false, message: 'Unlock a locked folder first, then set up a recovery key.' };
  }
  const keyring = await readKeyring();
  if (!keyring) {
    return { ok: false, message: 'This vault has no keyring to protect.' };
  }

  const material = await generateRecoveryKey();
  const salt = newSalt();
  const wrappingKey = await deriveWrappingKey(material.canonical, salt);
  const bytes = await exportKeyBytes(vault);
  const now = Date.now();
  const recovery: RecoveryWrap = {
    version: 1,
    fingerprint: await keyFingerprint(bytes),
    kdf: {
      algorithm: 'PBKDF2-SHA256',
      salt: toBase64(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    wrappedByRecovery: await encryptString(wrappingKey, toBase64(bytes)),
    createdAt: keyring.recovery?.createdAt ?? now,
    updatedAt: now,
  };

  const written = await writeRecoveryWrap(recovery);
  if (!written) return { ok: false, message: 'The keyring disappeared before it could be updated.' };
  return { ok: true, key: material.formatted };
}

export async function hasRecoveryKey(): Promise<boolean> {
  const keyring = await readKeyring();
  return Boolean(keyring?.recovery);
}

export async function recoveryFingerprint(): Promise<string | null> {
  const keyring = await readKeyring();
  return keyring?.recovery?.fingerprint ?? null;
}

function recoveryFileFromWrap(recovery: RecoveryWrap) {
  return {
    protocol: SYNC_PROTOCOL,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    fingerprint: recovery.fingerprint,
    createdAt: recovery.createdAt,
    updatedAt: recovery.updatedAt,
    kdf: recovery.kdf,
    wrappedByRecovery: recovery.wrappedByRecovery,
  } as const;
}

/**
 * Publish the recovery file. Ciphertext only, and named by the public key
 * fingerprint so multiple vault keys can coexist without overwriting each other.
 */
export async function uploadRecoveryKeyring(transport: SyncTransport): Promise<void> {
  const keyring = await readKeyring();
  const recovery = keyring?.recovery;
  if (!recovery) return;
  const name = keyringFileName(recovery.fingerprint);
  const files = await transport.listFiles();
  const existing = files
    .filter((file) => file.name === name)
    .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))[0];
  await transport.uploadText({
    name,
    content: JSON.stringify(recoveryFileFromWrap(recovery)),
    fileId: existing?.id,
  });
  await writeSyncMeta('lastKeyringFingerprint', recovery.fingerprint);
}

export interface RecoveryAdoptResult extends KeySetupResult {
  fingerprint?: string;
}

/**
 * Try the entered key against every recovery file in the account.
 *
 * This does not need the vault unlocked: it derives the wrapping key, unwraps the
 * vault key, verifies the public fingerprint, and installs a device wrap. If none
 * of the files open, the answer is a clean refusal rather than a fallback that
 * pretends the content is empty.
 */
export async function adoptRecoveryKey(
  transport: SyncTransport,
  input: string,
): Promise<RecoveryAdoptResult> {
  const material = await decodeRecoveryKey(input);
  if (!material) {
    return { ok: false, message: 'That recovery key is not valid. Check for missing or extra characters.' };
  }

  const files = await transport.listFiles();
  const candidates = files
    .filter((file) => file.name.startsWith(KEYRING_PREFIX) && file.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length === 0) {
    return {
      ok: false,
      message: 'No recovery key has been published to this Google account yet. Set one up on a device that can already open the locked content.',
    };
  }

  for (const file of candidates) {
    try {
      const text = await transport.downloadText(file.id);
      const parsed = validateKeyringFile(JSON.parse(text));
      if (keyringFileName(parsed.fingerprint) !== file.name) continue;
      const wrappingKey = await deriveWrappingKey(
        material.canonical,
        fromBase64(parsed.kdf.salt),
        parsed.kdf.iterations,
      );
      const bytes = fromBase64(await decryptString(wrappingKey, parsed.wrappedByRecovery));
      if (bytes.length !== 32) continue;
      const fingerprint = await keyFingerprint(bytes);
      if (fingerprint !== parsed.fingerprint) continue;

      const vault = await importKeyBytes(bytes);
      const recovery: RecoveryWrap = {
        version: 1,
        fingerprint: parsed.fingerprint,
        kdf: parsed.kdf,
        wrappedByRecovery: parsed.wrappedByRecovery,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };

      /*
       * A browser cannot raise its prompt until a credential exists for this
       * origin, so one is enrolled before the keyring is written. Always — not
       * only on a fresh device: the credential is also the thing that could have
       * been lost while the wrapped key stayed on disk (Windows Hello reset,
       * a new OS user profile), and this is the moment the user has proved they
       * hold the portable key and can prove it to the platform again. Failing
       * here writes nothing, so the device is never left with a keyring that
       * nothing can open.
       */
      if (!(await ensureDeviceCredential())) {
        return {
          ok: false,
          message:
            'The recovery key is valid, but this computer could not set up its unlock prompt, so nothing was changed.',
        };
      }

      /*
       * `replaceMatching` is what makes a lost prompt recoverable. With an
       * existing keyring and no key in memory, the only safe replacement is one
       * whose public fingerprint matches the recovery wrap already recorded
       * here; a different vault key is refused rather than silently orphaning
       * everything sealed under the old one.
       */
      const installed = await installVaultKeyFromRecovery(vault, recovery, { replaceMatching: true });
      if (!installed.ok) return installed;
      return { ok: true, fingerprint };
    } catch {
      // A file that does not open is not proof of a wrong key — there may be
      // another vault key file — so keep trying without surfacing raw errors.
      continue;
    }
  }

  return { ok: false, message: 'That recovery key does not open any vault synced to this account.' };
}
