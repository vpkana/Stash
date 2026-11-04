import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import type { SavedLink } from '@/db/types';
import { createFolder, setFolderLocked } from '@/db/repos/folders';
import { createLink } from '@/db/repos/links';
import { applyImport, buildBackup, readVaultRaw } from '@/db/repos/backup';
import { getSnapshot } from '@/db/repos/vault';
import { indexExisting, planImport } from '@/lib/backup/merge';
import { parseBackup } from '@/lib/backup/validate';
import { createStaticAuthenticator, setDeviceAuthenticator } from '@/lib/privacy/auth';
import { encryptJson, generateVaultKey } from '@/lib/privacy/crypto';
import { forgetVaultKey, hasKeyring } from '@/lib/privacy/keyring';
import { isSealed } from '@/lib/privacy/protection';
import { clearEveryLock, countSealed, reconcileProtection } from '@/lib/privacy/reconcile';
import { setSecureStore } from '@/lib/privacy/secure-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';
import { memorySecureStore, setupDeviceVault } from './privacy-fixtures';

/**
 * Lock removal, and what a locked row looks like when this device cannot open it.
 *
 * The bug this suite pins down: importing a `sealed` backup taken on a device-only
 * vault produced rows sealed under a key nothing here holds. Unlocking one removed
 * it from the withheld set — so it stopped rendering as a locked row and started
 * rendering as an *empty* one, its address blanked by sealing and never restored.
 * That is what "all my links disappeared after unlocking" was, and "remove the
 * lock" made it permanent by destroying the keyring on top of it.
 *
 * Two rules are asserted:
 *
 *  1. a row that is still ciphertext is withheld whatever the session has been
 *     granted, so it stays an honest locked row rather than a blank one;
 *  2. removing every lock opens everything it can and reports the rest, instead
 *     of destroying the key and leaving blank rows behind.
 */

const PRISTINE_PRIVACY = usePrivacyStore.getState();

async function reset(): Promise<void> {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
  forgetVaultKey();
  usePrivacyStore.setState({ ...PRISTINE_PRIVACY }, true);
  setSecureStore(memorySecureStore());
  setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
}

async function mustFolder(name: string): Promise<string> {
  const result = await createFolder({ name });
  if (!result.ok) throw new Error(`createFolder("${name}") failed: ${result.reason}`);
  return result.folder.id;
}

async function mustLink(url: string, folderId: string | null): Promise<string> {
  const link = await createLink({ url, folderId });
  return link.id;
}

beforeEach(reset);

/** A locked folder with two links, exported as a `sealed` file. */
async function sealedExportOfLockedVault(): Promise<string> {
  await setupDeviceVault();
  const folder = await mustFolder('Private');
  await mustLink('https://a.example/one', folder);
  await mustLink('https://b.example/two', folder);
  await setFolderLocked(folder, true);
  const built = await buildBackup({ mode: 'sealed' });
  if (!built.ok || !built.text) throw new Error(built.message);
  return built.text;
}

/** Import that file into a *different* device vault, as a user restoring backup would. */
async function importIntoNewDevice(text: string): Promise<void> {
  const parsed = parseBackup(text);
  if (parsed.kind !== 'ready') throw new Error(`expected a ready backup, got ${parsed.kind}`);
  const plan = planImport({
    data: parsed.data,
    existing: indexExisting(await readVaultRaw()),
    mode: 'replace',
    backupHasKeyring: Boolean(parsed.backup.security?.keyring),
    deviceHasKeyring: await hasKeyring(),
  });
  const outcome = await applyImport(plan, { keyring: parsed.backup.security?.keyring ?? null });
  if (!outcome.ok) throw new Error(outcome.message ?? 'import failed');
}

describe('a row this device cannot decrypt', () => {
  it('stays withheld after an unlock instead of rendering as an empty link', async () => {
    const text = await sealedExportOfLockedVault();

    await reset();
    await setupDeviceVault();
    await importIntoNewDevice(text);

    /* The restore left the rows sealed: the file carried no key this device could
     * use, which is documented on the review screen. Clear the lock flags, as an
     * earlier "remove the lock" would, so nothing is protected by a boundary any
     * more — the rows are still ciphertext and must still not be offered as
     * content. */
    await clearEveryLock();
    const rows = await db.links.toArray();
    expect(rows.every((row) => isSealed(row))).toBe(true);

    const snapshot = await getSnapshot();
    // The read is honest: no address, because there is none in the clear.
    expect(snapshot.links.every((row) => row.url === '')).toBe(true);

    await useVaultStore.getState().initialize();
    await useVaultStore.getState().refresh();
    const hiddenLinks = useVaultStore.getState().hidden.links;

    // Every unreadable row is withheld, so a list renders a locked row rather
    // than a blank one the user reads as a lost link.
    for (const row of rows) expect(hiddenLinks.has(row.id)).toBe(true);
  });
});

describe('removing every lock', () => {
  it('opens every link and folder, and keeps every address', async () => {
    await setupDeviceVault();
    usePrivacyStore.setState({ keyringPresent: true, deviceUnlockReady: true, unlocked: true });

    const folder = await mustFolder('Private');
    const a = await mustLink('https://a.example/one', folder);
    const b = await mustLink('https://b.example/two', folder);
    const loose = await mustLink('https://c.example/loose', null);
    await setFolderLocked(folder, true);

    const result = await usePrivacyStore.getState().disable();

    expect(result.ok).toBe(true);
    expect(await hasKeyring()).toBe(false);
    expect(usePrivacyStore.getState().keyringPresent).toBe(false);
    expect(await countSealed()).toEqual({ folders: 0, notes: 0, links: 0 });

    for (const id of [a, b, loose]) {
      const row = await db.links.get(id);
      expect(row?.isLocked).toBe(false);
      expect(isSealed(row ?? {})).toBe(false);
      expect(row?.url).toMatch(/^https:\/\//);
    }
    expect((await db.folders.get(folder))?.isLocked).toBe(false);
  });

  it('reports items sealed under another key instead of blanking them', async () => {
    // A row dropped in from another device's backup: valid ciphertext, a key
    // nobody here has.
    const foreignKey = await generateVaultKey();
    const foreign: SavedLink = {
      id: 'foreign-link',
      folderId: null,
      url: '',
      normalizedUrl: '',
      createdAt: 1,
      updatedAt: 1,
      isFavorite: false,
      isArchived: false,
      isLocked: true,
      enc: await encryptJson(foreignKey, { url: 'https://elsewhere.example/secret', normalizedUrl: '' }),
    };
    await db.links.add(foreign);

    await setupDeviceVault();
    usePrivacyStore.setState({ keyringPresent: true, deviceUnlockReady: true, unlocked: true });
    const readable = await mustLink('https://here.example/kept', null);
    // Sealed the ordinary way: locked, then reconciled at rest.
    await db.links.update(readable, { isLocked: true });
    await reconcileProtection();

    const result = await usePrivacyStore.getState().disable();

    // Nothing was destroyed and nothing was blanked: the links this device can
    // read are readable, the one it cannot is reported, and the keyring is gone
    // because the locks are gone.
    expect(result.ok).toBe(false);
    expect(result.message).toContain('1 item(s)');
    expect(await hasKeyring()).toBe(false);
    const kept = await db.links.get(readable);
    expect(kept?.url).toBe('https://here.example/kept');
    expect(kept?.isLocked).toBe(false);
    // The foreign row is still there, still ciphertext — untouched, not deleted.
    expect(await db.links.get('foreign-link')).toBeTruthy();
    expect(isSealed((await db.links.get('foreign-link')) ?? {})).toBe(true);
  });
});
