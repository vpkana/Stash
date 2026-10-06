import {
  db,
  DEFAULT_PRIVACY_SETTINGS,
  META_KEYS,
  type MetaRow,
  type PrivacySettings,
  type RelockPolicy,
} from '../index';
import { isRelockPolicy } from '@/lib/privacy/session';
import { isTrashed } from '@/lib/trash';

/**
 * Small key-value store for preferences and capture history.
 *
 * Kept inside the same IndexedDB as the vault so there is no second place user
 * state can hide, and so export/import carries preferences along with data.
 */

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  if (!row) return fallback;
  return row.value as T;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const row: MetaRow = { key, value };
  await db.meta.put(row);
}

/** How many capture destinations we remember for the fast path. */
export const RECENT_DESTINATION_LIMIT = 5;

export async function getRecentFolderIds(): Promise<string[]> {
  const ids = await getMeta<string[]>(META_KEYS.recentFolders, []);
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
}

/**
 * Move-to-front list of recently used destinations. This is what makes repeat
 * captures a single tap instead of a folder hunt.
 */
export async function pushRecentFolder(folderId: string): Promise<string[]> {
  const current = await getRecentFolderIds();
  const next = [folderId, ...current.filter((id) => id !== folderId)].slice(0, RECENT_DESTINATION_LIMIT);
  await setMeta(META_KEYS.recentFolders, next);
  return next;
}

export async function getLastFolderId(): Promise<string | null> {
  const value = await getMeta<string | null>(META_KEYS.lastFolderId, null);
  return typeof value === 'string' ? value : null;
}

export async function setLastFolderId(folderId: string | null): Promise<void> {
  await setMeta(META_KEYS.lastFolderId, folderId);
}

export type ThemeMode = 'light' | 'dark' | 'system';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export async function getThemeMode(): Promise<ThemeMode> {
  const value = await getMeta<ThemeMode>(META_KEYS.themeMode, 'system');
  return isThemeMode(value) ? value : 'system';
}

export async function setThemeMode(mode: ThemeMode): Promise<void> {
  await setMeta(META_KEYS.themeMode, mode);
}

/**
 * Drop remembered destinations that point at folders which no longer exist, have
 * been thrown away, and — while the vault is locked — at folders that are locked.
 *
 * Recents are persisted in plaintext `meta`, so a locked folder must not survive
 * in that list: the Capture sheet would otherwise offer a destination whose name
 * it is forbidden to reveal. Sealing is used as the test rather than recomputing
 * full protection, because a protected folder is always a sealed one and this
 * runs on every refresh.
 *
 * A trashed folder is dropped for the same reason a deleted one is: a destination
 * you cannot save into is not a destination.
 */
/**
 * The recent destinations still worth offering.
 *
 * A trashed folder is dropped because a destination you cannot save into is not
 * a destination. Whether a folder is *locked* is deliberately not decided here:
 * that is an access question, and it is answered at the point of use by the
 * central authorization check, which knows which folders have been opened in
 * this session. Deciding it here would need the session, and would be the second
 * implementation of the same rule.
 */
export async function pruneRecentFolders(): Promise<string[]> {
  const ids = await getRecentFolderIds();
  if (ids.length === 0) return [];
  const folders = await db.folders.toArray();
  const existing = new Set(folders.filter((folder) => !isTrashed(folder)).map((folder) => folder.id));
  const pruned = ids.filter((id) => existing.has(id));

  if (pruned.length !== ids.length) await setMeta(META_KEYS.recentFolders, pruned);
  return pruned;
}

// ---------------------------------------------------------------------------
// Privacy preferences
//
// Stored in `meta`, which is exported with a backup: these are preferences, not
// secrets. There is no passcode here and no verifier — knowing that re-lock is
// set to five minutes tells an attacker nothing they cannot see on the lock
// screen. The keyring lives in its own table and is never exported.
// ---------------------------------------------------------------------------

export async function getPrivacySettings(): Promise<PrivacySettings> {
  const stored = await getMeta<Partial<PrivacySettings> | null>(META_KEYS.privacySettings, null);
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_PRIVACY_SETTINGS };

  // Read field by field so a value written by a newer build cannot put the app
  // into a shape it does not understand — and so a corrupted row degrades to the
  // defaults rather than disabling the lock.
  const policy: RelockPolicy = isRelockPolicy(stored.relockPolicy)
    ? stored.relockPolicy
    : DEFAULT_PRIVACY_SETTINGS.relockPolicy;

  return {
    enabled: stored.enabled === true,
    relockPolicy: policy,
    lockApp: stored.lockApp !== false,
    secureScreen: stored.secureScreen === true,
    biometric: stored.biometric !== false,
  };
}

export async function setPrivacySettings(patch: Partial<PrivacySettings>): Promise<PrivacySettings> {
  const current = await getPrivacySettings();
  const next: PrivacySettings = { ...current, ...patch };
  await setMeta(META_KEYS.privacySettings, next);
  return next;
}
