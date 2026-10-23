/**
 * Canonical JSON, hashing and revisions.
 *
 * Sync needs one answer to "are these two rows the same?" that does not depend
 * on property insertion order, JSON formatting, or how a row happened to be
 * round-tripped through IndexedDB. Everything on the wire and everything stored
 * in `syncBase` is reduced through {@link stableStringify} before it is compared
 * or hashed, so the same vault state always produces the same bytes.
 */

/**
 * JSON with object keys sorted recursively.
 *
 * `undefined` members are dropped exactly as `JSON.stringify` drops them; that
 * matters because optional fields are represented by their absence, not by a
 * `null` placeholder, and the two must not produce different hashes.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const member = source[key];
      if (member === undefined) continue;
      out[key] = canonicalize(member);
    }
    return out;
  }
  return value;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    out += (bytes[index] as number).toString(16).padStart(2, '0');
  }
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** SHA-256 of the canonical form of a value. */
export async function hashValue(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}

/**
 * Deterministic UUID-shaped id for a derived record (a conflict copy).
 *
 * The version/variant nibbles are set the way UUIDv5 sets them, so the result is
 * a well-formed id that every code path treating ids as opaque strings accepts.
 * Same inputs on two devices → same id, which is what stops duplicated conflict
 * copies from being created as each device syncs.
 */
export async function derivedId(namespace: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(namespace)));
  const out = bytes.slice(0, 16);
  out[6] = ((out[6] as number) & 0x0f) | 0x50;
  out[8] = ((out[8] as number) & 0x3f) | 0x80;
  const hex = toHex(out);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const STAMP_DIGITS = 13;

/**
 * An opaque revision stamp: time first, then content, then origin.
 *
 * Time first preserves "newer wins" as the primary intuition; the content hash
 * makes the stamp change when the row changes, so two edits in the same
 * millisecond are still distinct; the device id makes the final tie-break
 * deterministic rather than dependent on iteration order. All three parts are
 * fixed-width where that matters, so plain string comparison is a correct
 * ordering.
 */
export function makeRevision(stamp: number, contentHash: string, origin: string): string {
  const time = Math.max(0, Math.trunc(stamp)).toString().padStart(STAMP_DIGITS, '0');
  return `${time}-${contentHash.slice(0, 16)}-${origin}`;
}

export function compareRevisions(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The device id embedded in a revision, used when re-deriving a merged row. */
export function revisionOrigin(rev: string): string {
  const first = rev.indexOf('-');
  if (first < 0) return 'unknown';
  const second = rev.indexOf('-', first + 1);
  if (second < 0) return 'unknown';
  return rev.slice(second + 1) || 'unknown';
}

/** "Now" is injectable in tests, but never used as the *only* ordering signal. */
export function now(): number {
  return Date.now();
}
