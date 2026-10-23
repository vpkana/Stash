import type { EncryptedPayload } from '@/db/types';

/**
 * Authenticated encryption, using only the platform's crypto.
 *
 * Nothing in this file is a cipher. Every primitive is `crypto.subtle`:
 * AES-256-GCM for confidentiality *and* integrity, PBKDF2-SHA256 for turning a
 * human passcode into a key. Stash picks parameters and composes established
 * primitives; it does not invent an algorithm, and it does not implement
 * anything itself.
 *
 * Two different AES-GCM keys are in play and it matters which is which:
 *
 *  - the *vault key* — a random 256-bit key that actually encrypts notes, link
 *    fields and folder names. It is never derived from anything a human types,
 *    so its strength does not depend on passcode quality;
 *  - a *wrapping key* — derived from the passcode via PBKDF2, used only to seal
 *    and unseal the vault key. This is the standard envelope (key-wrapping)
 *    shape, and it is why changing the passcode re-wraps 32 bytes instead of
 *    re-encrypting the whole vault.
 *
 * GCM's authentication tag is what makes this "authenticated": a modified
 * ciphertext, a swapped IV or a truncated payload fails to decrypt with an
 * exception rather than yielding plausible-looking garbage. Callers therefore
 * treat a decryption failure as "this data is not ours", never as "empty".
 */

/** AES-GCM's standard nonce length. 96 bits avoids GHASH pre-computation. */
const IV_BYTES = 12;

/** AES-256. */
const KEY_BITS = 256;

/** Salt length for PBKDF2. 128 bits is well past the point of collisions. */
const SALT_BYTES = 16;

/**
 * PBKDF2-SHA256 iteration count.
 *
 * Deliberately expensive: this is the only barrier between a stolen keyring row
 * and an offline guessing attack on a short numeric passcode. The figure is the
 * current OWASP guidance for PBKDF2-HMAC-SHA256, and it is stored in the keyring
 * so a future increase keeps old keyrings readable.
 */
export const PBKDF2_ITERATIONS = 210_000;

export const VAULT_KEY_BYTES = KEY_BITS / 8;

export const AES_GCM = 'AES-GCM' as const;

/**
 * A random AES-256-GCM key.
 *
 * Extractable because the keyring has to wrap it; the extracted bytes only ever
 * exist in memory for the duration of a wrap or unwrap.
 */
export async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: AES_GCM, length: KEY_BITS }, true, ['encrypt', 'decrypt']);
}

/** Raw key bytes, for wrapping. Only used in memory. */
export async function exportKeyBytes(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

/** Turn raw bytes back into a usable AES-GCM key. */
export async function importKeyBytes(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(bytes), { name: AES_GCM }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Derive a wrapping key from a passcode.
 *
 * A fresh random salt must be supplied per keyring; reusing one across
 * passcode changes would let two keyrings be attacked together. The passcode is
 * used as raw key material (not hashed first) because PBKDF2 already performs
 * the hashing, and it is never stored or logged anywhere.
 */
export async function deriveWrappingKey(
  passcode: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passcode),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: AES_GCM, length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a UTF-8 string. A fresh random IV is generated on every call. */
export async function encryptString(key: CryptoKey, plaintext: string): Promise<EncryptedPayload> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM, iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(plaintext)),
  );
  return { v: 1, alg: AES_GCM, iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) };
}

/**
 * Decrypt a payload.
 *
 * Throws when the payload is malformed or the authentication tag does not
 * verify. Callers must handle that as a refusal, never as an empty value: a
 * failed tag means the data is not authentic, and returning `''` here would
 * quietly present forged content as if it were the user's.
 */
export async function decryptString(key: CryptoKey, payload: EncryptedPayload): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: AES_GCM, iv: toArrayBuffer(fromBase64(payload.iv)) },
    key,
    toArrayBuffer(fromBase64(payload.ct)),
  );
  return new TextDecoder().decode(plaintext);
}

/** Encrypt a JSON-serialisable value. */
export async function encryptJson<T>(key: CryptoKey, value: T): Promise<EncryptedPayload> {
  return encryptString(key, JSON.stringify(value));
}

export async function decryptJson<T>(key: CryptoKey, payload: EncryptedPayload): Promise<T> {
  const text = await decryptString(key, payload);
  return JSON.parse(text) as T;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function newSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

/**
 * A public identifier for a vault key: SHA-256 of its raw bytes, truncated.
 *
 * Used to name recovery files and to tell "this recovery key opens that vault"
 * from "it does not" without attempting to decrypt vault content. Being a hash of
 * a 256-bit random key, it reveals nothing useful about the key.
 */
export async function keyFingerprint(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let index = 0; index < 16; index += 1) {
    hex += (view[index] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Structural check, used to tell a sealed row from a legacy plaintext one. */
export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EncryptedPayload>;
  return (
    candidate.v === 1 &&
    candidate.alg === AES_GCM &&
    typeof candidate.iv === 'string' &&
    candidate.iv.length > 0 &&
    typeof candidate.ct === 'string' &&
    candidate.ct.length > 0
  );
}

// ---------------------------------------------------------------------------
// Encoding helpers
//
// Kept private and tiny. Everything crossing the database boundary is base64
// text so a payload survives structured clone, JSON export and a WebView
// round-trip without ever being reinterpreted as something else.
// ---------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] as number);
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * A `Uint8Array` view can be a slice of a larger buffer, and WebCrypto will
 * happily read the whole buffer. Copying into a right-sized `ArrayBuffer`
 * guarantees the primitive sees exactly the bytes we intend.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
