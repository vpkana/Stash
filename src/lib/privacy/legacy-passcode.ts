import { deriveWrappingKey, decryptString, fromBase64, importKeyBytes, isEncryptedPayload } from './crypto';
import { holdVaultKey, readKeyring } from './keyring';

/**
 * The old Stash passcode: read once, converted, then gone.
 *
 * This module exists for exactly one reason, and it is a data-safety reason
 * rather than a feature. Locking used to wrap the vault key under a passcode
 * derived with PBKDF2-SHA256. That system is removed: nothing creates a passcode,
 * nothing stores one, and no part of the product unlocks with one. But a vault
 * sealed by a build that had it is still out there, and its ciphertext can be
 * opened by precisely one input. Without the reader below, that content would
 * become permanently unreadable the moment the feature was deleted — a year of
 * notes lost to a tidy-up.
 *
 * So there is one prompt, it appears only when a vault cannot be opened any other
 * way, and it does not unlock anything: it *converts*. The passcode is used once
 * to unwrap the vault key, the key is immediately re-wrapped under this device's
 * key, and the passcode wrap is deleted in the same record write
 * (`adoptVaultKeyForDevice`). After that this module is inert on that device
 * forever, and the user never sees a passcode field again.
 *
 * ## Why this is not "keeping the password system"
 *
 * The distinction that matters is who verifies the credential and what survives
 * it. Here Stash is reading its own legacy ciphertext, once, to hand the content
 * over to the platform's authentication; the passcode is not stored, not hashed,
 * not remembered and not required for anything afterwards. Normal locked-item
 * access never touches this file. A vault set up today cannot reach it at all,
 * because it has no passcode wrap to convert.
 */

/**
 * What a user sees when a vault cannot be opened any other way.
 *
 * It names the situation rather than the mechanism: this is someone who locked
 * folders months ago and has no idea that a lock could be "a passcode wrap".
 */
export const LEGACY_PASSCODE_HEADLINE = 'Unlock this vault once';
export const LEGACY_PASSCODE_EXPLANATION =
  'These locked items were encrypted with the Stash passcode you used before your device lock became the way in. Enter it once to move them to your fingerprint, face or screen lock — it will not be needed again, and nothing is re-encrypted or changed.';

/** Whether this vault still carries a passcode wrap that has to be converted. */
export async function hasLegacyPasscodeWrap(): Promise<boolean> {
  const keyring = await readKeyring();
  return Boolean(keyring?.wrappedByPasscode && keyring.kdf);
}

/**
 * Whether the device path is the *only* way in.
 *
 * The complement of the above, said as a positive because that is how a screen
 * needs it: a vault that is device-only is a working vault, while the shapes that
 * are not need to be described differently.
 */
export async function isDeviceOnlyVault(): Promise<boolean> {
  const keyring = await readKeyring();
  return Boolean(keyring?.wrappedByDevice) && !(await hasLegacyPasscodeWrap());
}

/**
 * Unwrap the vault key with a legacy passcode, or report that this input is not
 * the one.
 *
 * `null` covers both "this vault has no passcode wrap" and "the AES-GCM tag did
 * not verify", which are the same answer to the person typing: this passcode is
 * not the way in. Data is untouched either way — this function writes nothing, and
 * a failure leaves the keyring exactly as it found it.
 *
 * On success the key becomes the session's key, because that is what unlocking
 * means for the rest of the app, and the caller then decides what to do about it:
 * wrap it for this device, or — on a device that cannot prompt at all — release
 * the content and take the locks off. The key is also returned so either caller
 * can act on it directly.
 */
export async function openWithLegacyPasscode(passcode: string): Promise<CryptoKey | null> {
  const keyring = await readKeyring();
  if (!keyring?.wrappedByPasscode || !keyring.kdf) return null;

  // Guarded before the derivation, not after: PBKDF2 at 210,000 iterations is the
  // cost that stands between a stolen keyring and an offline guess, and it is
  // also a real cost to pay per keystroke. An empty field is not a guess.
  if (passcode.length === 0) return null;

  try {
    const wrappingKey = await deriveWrappingKey(
      passcode,
      fromBase64(keyring.kdf.salt),
      keyring.kdf.iterations,
    );
    const payload = keyring.wrappedByPasscode;
    if (!isEncryptedPayload(payload)) return null;
    const bytes = fromBase64(await decryptString(wrappingKey, payload));
    const vault = await importKeyBytes(bytes);
    holdVaultKey(vault);
    return vault;
  } catch {
    return null;
  }
}

/**
 * Whether the ciphertext in a vault like this one is at risk.
 *
 * True when there is sealed content, no device wrap, and a passcode wrap — the
 * combination where the migration prompt is the last remaining door. Used to
 * decide how loudly the UI should be talking, and by tests to state the case.
 */
export async function isLegacyPasscodeOnlyVault(hasDeviceWrap: boolean): Promise<boolean> {
  if (hasDeviceWrap) return false;
  return hasLegacyPasscodeWrap();
}
