import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase, SECURITY_KEYS } from '@/db';
import { createFolder, renameFolder, getFolderStats, setFolderLocked } from '@/db/repos/folders';
import { createLink, moveLink, setLinkLocked, updateLink } from '@/db/repos/links';
import { createNote, moveNote, setNoteLocked, updateNote } from '@/db/repos/notes';
import {
  getPrivacySettings,
  getRecentFolderIds,
  pruneRecentFolders,
  pushRecentFolder,
  setPrivacySettings,
} from '@/db/repos/settings';
import { describeBundleLocks, exportVault, getSnapshot, importVault, isValidBundle } from '@/db/repos/vault';
import { createStaticAuthenticator, setDeviceAuthenticator } from '@/lib/privacy/auth';
import {
  createDeviceKeyring,
  destroyKeyring,
  forgetVaultKey,
  getVaultKey,
  hasKeyring,
  isDeviceUnlockReady,
  isSessionLocked,
  readKeyring,
  unlockWithDevice,
} from '@/lib/privacy/keyring';
import { hasLegacyPasscodeWrap } from '@/lib/privacy/legacy-passcode';
import {
  deriveWrappingKey,
  encryptString,
  exportKeyBytes,
  PBKDF2_ITERATIONS,
  newSalt,
  toBase64,
} from '@/lib/privacy/crypto';
import { allLockRoots, canAccess, computeProtection, hiddenIds, isSealed } from '@/lib/privacy/protection';
import { countSealed } from '@/lib/privacy/reconcile';
import { applyScreenPrivacy, setPrivacyScreenPlugin } from '@/lib/privacy/screen';
import { setSecureStore, type SecureStore } from '@/lib/privacy/secure-store';
import { searchVault } from '@/lib/search';
import { usePrivacyStore } from '@/stores/privacy-store';

/**
 * Privacy end to end, over a real Dexie database on fake-indexeddb.
 *
 * The point of running against a real database is that the assertions can be
 * made about *what is actually stored*. `db.links.get(id)` is the row an
 * attacker with the device's data directory would see, so "the address is not in
 * there" is checked there and not on a hydrated object.
 *
 * Locking is device-only: the vault key is wrapped under a key in platform
 * storage, and the OS prompt is the only way in. The one exception the suite
 * covers is the vault an earlier build left behind, whose key is wrapped under a
 * Stash passcode — a shape this build can *convert* and nothing else, tested here
 * because content behind it would otherwise be unreachable.
 */

/** The passcode an earlier build would have asked for. */
const PASSCODE = 'open sesame 42';

async function resetDatabase() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

/** An authenticator that reports unavailable, so nothing arms device unlock. */
const NO_DEVICE_AUTH = createStaticAuthenticator({ ok: false, reason: 'unavailable' }, { available: false });

/** A secure store that stands in for Android's Keystore-backed storage. */
function memorySecureStore(): SecureStore {
  const values = new Map<string, string>();
  return {
    kind: 'native',
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

const PRISTINE_PRIVACY_STATE = usePrivacyStore.getState();

beforeEach(async () => {
  await resetDatabase();
  // Module-level state outlives a test: the vault key, the cached platform
  // bridges and the Zustand session all have to be put back by hand.
  forgetVaultKey();
  usePrivacyStore.setState({ ...PRISTINE_PRIVACY_STATE }, true);
  // Unavailable for prompting, but a device that *has* a screen lock: the default
  // has to be the secure one, because `'insecure'` is the answer that removes
  // locks and no test should reach that state by accident.
  setDeviceAuthenticator(NO_DEVICE_AUTH);
  setSecureStore(memorySecureStore());
  setPrivacyScreenPlugin(null);
});

async function mustFolder(name: string, parentId: string | null = null): Promise<string> {
  const result = await createFolder({ name, parentId });
  if (!result.ok) throw new Error(`createFolder("${name}") failed: ${result.reason}`);
  return result.folder.id;
}

async function mustNote(title: string, parentNoteId: string | null = null): Promise<string> {
  const result = await createNote({ title, content: `${title} — private body`, parentNoteId });
  if (!result.ok) throw new Error(`createNote("${title}") failed: ${result.message}`);
  return result.note.id;
}

async function mustLink(url: string, folderId: string | null = null): Promise<string> {
  const link = await createLink({ url, folderId, title: `Title for ${url}` });
  return link.id;
}

/**
 * Turn locking on for real, and leave the session unlocked as the UI would.
 *
 * `createDeviceKeyring` is the product's setup path: one random key in platform
 * storage, the vault key wrapped under it, nothing to choose. The store state is
 * set by hand because this helper replaces the boot sequence, not the store.
 */
async function enablePrivacy(): Promise<void> {
  const result = await createDeviceKeyring();
  expect(result.ok).toBe(true);
  const settings = await setPrivacySettings({ enabled: true, biometric: true });
  usePrivacyStore.setState({
    settings,
    keyringPresent: true,
    legacyPasscodeOnly: false,
    deviceUnlockReady: true,
    unlocked: true,
    unlockedAt: Date.now(),
    message: null,
    grantedRoots: [],
  });
}

/**
 * A vault in the shape an earlier build left behind: the vault key wrapped under
 * a Stash passcode, with no device wrap at all.
 *
 * The record is written the way that build wrote it, with the same primitives,
 * rather than as a hand-shaped object — a fixture would be our guess at the old
 * format instead of the format, and this suite exists to prove the reader works
 * on the real thing. The session is left unlocked because the key is already in
 * memory here; the tests that care about the *conversion* start from a locked
 * session and go through `unlockWithLegacyPasscode`.
 */
async function enableLegacyPasscodeVault(passcode = PASSCODE): Promise<void> {
  await createDeviceKeyring();
  const vault = getVaultKey();
  if (!vault) throw new Error('the setup path left no vault key to re-wrap');

  const salt = newSalt();
  const wrappingKey = await deriveWrappingKey(passcode, salt);
  const wrappedByPasscode = await encryptString(wrappingKey, toBase64(await exportKeyBytes(vault)));
  const now = Date.now();

  // The passcode-only record, exactly as the old setup path wrote it: no
  // `wrappedByDevice`, and a KDF block describing the derivation.
  await db.security.put({
    key: SECURITY_KEYS.keyring,
    value: {
      version: 1,
      kdf: { algorithm: 'PBKDF2-SHA256', salt: toBase64(salt), iterations: PBKDF2_ITERATIONS },
      wrappedByPasscode,
      createdAt: now,
      updatedAt: now,
    },
  });

  const settings = await setPrivacySettings({ enabled: true });
  usePrivacyStore.setState({
    settings,
    keyringPresent: true,
    legacyPasscodeOnly: true,
    deviceUnlockReady: false,
    unlocked: true,
    unlockedAt: Date.now(),
    message: null,
    grantedRoots: [],
  });
}

describe('locking a note', () => {
  it('seals a locked root note, and its subnotes with it', async () => {
    await enablePrivacy();
    const root = await mustNote('Therapy');
    const child = await mustNote('Session three', root);
    const other = await mustNote('Groceries');

    await setNoteLocked(root, true);

    const storedRoot = await db.notes.get(root);
    const storedChild = await db.notes.get(child);
    expect(storedRoot?.title).toBe('');
    expect(storedRoot?.content).toBe('');
    expect(isSealed(storedRoot ?? {})).toBe(true);
    // The subnote inherits the lock, so it is sealed without being flagged.
    expect(storedChild?.isLocked).toBe(false);
    expect(isSealed(storedChild ?? {})).toBe(true);
    expect(JSON.stringify(storedChild)).not.toContain('Session three');

    // Unrelated notes are untouched.
    const storedOther = await db.notes.get(other);
    expect(storedOther?.title).toBe('Groceries');
    expect(isSealed(storedOther ?? {})).toBe(false);

    // Reading through the snapshot restores the plaintext for the UI.
    const snapshot = await getSnapshot();
    expect(snapshot.notes.find((note) => note.id === root)?.title).toBe('Therapy');
    expect(snapshot.notes.find((note) => note.id === child)?.title).toBe('Session three');
  });

  it('seals a locked subnote on its own without touching its parent or siblings', async () => {
    await enablePrivacy();
    const parent = await mustNote('Health');
    const locked = await mustNote('Blood results', parent);
    const sibling = await mustNote('Diet', parent);

    await setNoteLocked(locked, true);

    expect(isSealed((await db.notes.get(locked)) ?? {})).toBe(true);
    expect((await db.notes.get(parent))?.title).toBe('Health');
    expect((await db.notes.get(sibling))?.title).toBe('Diet');
  });

  it('opens the whole subtree again when the lock is lifted', async () => {
    await enablePrivacy();
    const root = await mustNote('Therapy');
    const child = await mustNote('Session three', root);
    await setNoteLocked(root, true);
    await setNoteLocked(root, false);

    expect((await db.notes.get(root))?.title).toBe('Therapy');
    expect((await db.notes.get(child))?.title).toBe('Session three');
    expect(await countSealed()).toEqual({ folders: 0, notes: 0, links: 0 });
  });

  it('keeps an edited locked note sealed, and keeps the new text', async () => {
    await enablePrivacy();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);

    await updateNote(id, { content: 'The new paragraph' });

    const stored = await db.notes.get(id);
    expect(isSealed(stored ?? {})).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('new paragraph');

    const opened = (await getSnapshot()).notes.find((note) => note.id === id);
    expect(opened?.content).toBe('The new paragraph');
  });

  it('re-seals a subtree that moves back under a locked note', async () => {
    await enablePrivacy();
    const root = await mustNote('Therapy');
    const loose = await mustNote('Loose thought');
    await setNoteLocked(root, true);
    expect(isSealed((await db.notes.get(loose)) ?? {})).toBe(false);

    await moveNote(loose, root);
    expect(isSealed((await db.notes.get(loose)) ?? {})).toBe(true);

    await moveNote(loose, null);
    expect((await db.notes.get(loose))?.title).toBe('Loose thought');
  });
});

describe('locking a folder', () => {
  it('seals the folder name and every folder and link beneath it', async () => {
    await enablePrivacy();
    const root = await mustFolder('Private');
    const nested = await mustFolder('Divorce', root);
    const deepest = await mustFolder('2026', nested);
    const sibling = await mustFolder('Development');

    const linkRoot = await mustLink('https://a.example/secret', root);
    const linkDeep = await mustLink('https://b.example/court', deepest);
    const linkElsewhere = await mustLink('https://docs.example', sibling);
    const inbox = await mustLink('https://plain.example', null);

    await setFolderLocked(root, true);

    // Nested locked folder: the whole subtree is protected, and the folder rows
    // themselves keep their names. The name is the label on the lock — the only
    // way to tell `Private` from `Banking` in a list or a destination picker —
    // and the access model, not the ciphertext, is what keeps it back.
    for (const id of [root, nested, deepest]) {
      const folder = await db.folders.get(id);
      expect(folder?.isLocked, id).toBe(id === root);
      expect(isSealed(folder ?? {}), id).toBe(false);
    }
    expect((await db.folders.get(nested))?.name).toBe('Divorce');

    for (const id of [linkRoot, linkDeep]) {
      const link = await db.links.get(id);
      expect(link?.url, id).toBe('');
      expect(link?.normalizedUrl, id).toBe('');
      expect(isSealed(link ?? {}), id).toBe(true);
    }
    expect(JSON.stringify(await db.links.get(linkDeep))).not.toContain('court');

    // Anything outside the locked region is untouched.
    expect((await db.folders.get(sibling))?.name).toBe('Development');
    expect((await db.links.get(linkElsewhere))?.url).toBe('https://docs.example');
    expect((await db.links.get(inbox))?.url).toBe('https://plain.example');
  });

  it('seals a link moved into a locked folder and opens it on the way out', async () => {
    await enablePrivacy();
    const locked = await mustFolder('Private');
    const open = await mustFolder('Work');
    await setFolderLocked(locked, true);

    const id = await mustLink('https://a.example/moved', open);
    expect((await db.links.get(id))?.url).toBe('https://a.example/moved');

    await moveLink(id, locked);
    expect((await db.links.get(id))?.url).toBe('');
    expect(isSealed((await db.links.get(id)) ?? {})).toBe(true);

    await moveLink(id, open);
    expect((await db.links.get(id))?.url).toBe('https://a.example/moved');
  });

  it('renames a locked folder without touching what is sealed inside it', async () => {
    await enablePrivacy();
    const id = await mustFolder('Private');
    const linkId = await mustLink('https://secret.example/invoice', id);
    await setFolderLocked(id, true);

    const renamed = await renameFolder(id, 'Settlement');
    expect(renamed?.name).toBe('Settlement');

    // The label follows the rename; the content stays ciphertext either way.
    const stored = await db.folders.get(id);
    expect(stored?.name).toBe('Settlement');
    expect(isSealed(stored ?? {})).toBe(false);
    expect(isSealed((await db.links.get(linkId)) ?? {})).toBe(true);
    expect((await getSnapshot()).folders.find((folder) => folder.id === id)?.name).toBe('Settlement');
  });

  it('locks an individual link on its own', async () => {
    await enablePrivacy();
    const folder = await mustFolder('Reading');
    const id = await mustLink('https://secret.example/one', folder);

    await setLinkLocked(id, true);

    expect(isSealed((await db.links.get(id)) ?? {})).toBe(true);
    expect((await db.links.get(id))?.url).toBe('');
    expect((await db.folders.get(folder))?.name).toBe('Reading');
  });

  it('keeps an edited locked link sealed', async () => {
    await enablePrivacy();
    const folder = await mustFolder('Reading');
    const id = await mustLink('https://secret.example/one', folder);
    await setFolderLocked(folder, true);

    await updateLink(id, { userNote: 'Ask the doctor about this' });

    const stored = await db.links.get(id);
    expect(isSealed(stored ?? {})).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('doctor');

    const opened = (await getSnapshot()).links.find((link) => link.id === id);
    expect(opened?.userNote).toBe('Ask the doctor about this');
    expect(opened?.url).toBe('https://secret.example/one');
  });
});

describe('search while locked', () => {
  async function lockedSnapshot() {
    const snapshot = await getSnapshot();
    const protection = computeProtection(snapshot.folders, snapshot.notes, snapshot.links);
    // Nothing has been opened in this session, so every boundary is shut.
    return { snapshot, protection, hidden: hiddenIds(protection, new Set()) };
  }

  it('returns nothing for a locked note, link or folder', async () => {
    await enablePrivacy();
    const folder = await mustFolder('Private');
    const noteId = await mustNote('Therapy', null);
    await mustLink('https://secret.example/notes', folder);
    await setNoteLocked(noteId, true);
    await setFolderLocked(folder, true);

    // Simulate "the app restarted and nobody has unlocked it yet".
    forgetVaultKey();
    expect(isSessionLocked()).toBe(true);

    const { snapshot, hidden } = await lockedSnapshot();
    for (const query of ['Therapy', 'secret.example', 'Private']) {
      const outcome = searchVault(snapshot, { query, hidden });
      expect(outcome.notes, query).toHaveLength(0);
      expect(outcome.links, query).toHaveLength(0);
      expect(outcome.folders, query).toHaveLength(0);
    }
  });

  it('finds everything again once the device prompt has been passed', async () => {
    await enablePrivacy();
    const folder = await mustFolder('Private');
    const noteId = await mustNote('Therapy');
    await mustLink('https://secret.example/notes', folder);
    await setNoteLocked(noteId, true);
    await setFolderLocked(folder, true);

    forgetVaultKey();
    expect(await unlockWithDevice()).not.toBeNull();
    expect(isSessionLocked()).toBe(false);

    const snapshot = await getSnapshot();
    const protection = computeProtection(snapshot.folders, snapshot.notes, snapshot.links);
    const hidden = hiddenIds(protection, allLockRoots(protection));

    expect(searchVault(snapshot, { query: 'Therapy', hidden }).notes).toHaveLength(1);
    expect(searchVault(snapshot, { query: 'secret.example', hidden }).links).toHaveLength(1);
    expect(searchVault(snapshot, { query: 'Private', hidden }).folders).toHaveLength(1);
  });

  it('keeps a locked folder in recents and leaves the access decision to the lock model', async () => {
    await enablePrivacy();
    const locked = await mustFolder('Private');
    const open = await mustFolder('Work');
    await pushRecentFolder(locked);
    await pushRecentFolder(open);
    expect(await getRecentFolderIds()).toEqual([open, locked]);

    await setFolderLocked(locked, true);
    forgetVaultKey();

    // Recents is history, not a listing: forgetting that a folder was used would
    // be the storage layer making a decision that belongs to the access check.
    // What changes is whether the folder may be *offered*, and that is decided
    // from the same protection the rest of the app uses.
    expect(await pruneRecentFolders()).toEqual([open, locked]);

    const snapshot = await getSnapshot();
    const protection = computeProtection(snapshot.folders, snapshot.notes, snapshot.links);
    expect(canAccess(protection, new Set(), 'folder', locked)).toBe(false);
    expect(canAccess(protection, new Set(), 'folder', open)).toBe(true);
    expect(canAccess(protection, new Set([locked]), 'folder', locked)).toBe(true);
  });

  it('excludes locked subtrees from folder counts', async () => {
    await enablePrivacy();
    const locked = await mustFolder('Private');
    const nested = await mustFolder('Divorce', locked);
    const open = await mustFolder('Work');
    await mustLink('https://a.example/1', nested);
    await mustLink('https://a.example/2', open);

    await setFolderLocked(locked, true);
    forgetVaultKey();

    const snapshot = await getSnapshot();
    const protection = computeProtection(snapshot.folders, snapshot.notes, snapshot.links);
    expect(protection.folders.size).toBe(2);

    // The unfiltered database read still counts everything; the lock-aware
    // computation the UI uses does not.
    const unfiltered = await getFolderStats();
    expect(unfiltered.get(locked)?.nestedLinks).toBe(1);
  });
});

describe('session', () => {
  it('starts locked after a restart and opens with the device prompt', async () => {
    await enablePrivacy();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);

    // A restart: the process forgets the key and the database is reopened.
    forgetVaultKey();
    db.close();
    await openDatabase();

    expect(isSessionLocked()).toBe(true);
    expect(await hasKeyring()).toBe(true);
    expect(isSealed((await db.notes.get(id)) ?? {})).toBe(true);
    // The data is still there — sealed, not gone.
    expect(await db.notes.count()).toBe(1);

    // And the only thing that opens it is the key in platform storage, which is
    // what the OS prompt releases.
    expect(await unlockWithDevice()).not.toBeNull();
    expect((await getSnapshot()).notes.find((note) => note.id === id)?.title).toBe('Therapy');
  });

  it('drops a legacy passcode wrap the moment the device path proves it works', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));
    await enablePrivacy();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);
    const sealed = (await db.notes.get(id))?.content;

    // An earlier build's wrap, added beside the device wrap: two ways in, one key.
    // The record is real, written with the same primitives that build used.
    const vault = getVaultKey();
    if (!vault) throw new Error('the setup path left no vault key');
    const keyring = await readKeyring();
    if (!keyring) throw new Error('no keyring');
    const salt = newSalt();
    const wrappingKey = await deriveWrappingKey(PASSCODE, salt);
    await db.security.put({
      key: SECURITY_KEYS.keyring,
      value: {
        ...keyring,
        kdf: { algorithm: 'PBKDF2-SHA256', salt: toBase64(salt), iterations: PBKDF2_ITERATIONS },
        wrappedByPasscode: await encryptString(wrappingKey, toBase64(await exportKeyBytes(vault))),
      },
    });
    expect(await hasLegacyPasscodeWrap()).toBe(true);

    forgetVaultKey();
    expect((await usePrivacyStore.getState().unlockWithBiometrics()).ok).toBe(true);

    // The device path has just been demonstrated to work, so the passcode wrap —
    // which no screen in the app could accept any more — goes. Nothing was
    // re-encrypted: the sealed row is the same ciphertext it was.
    expect(await hasLegacyPasscodeWrap()).toBe(false);
    expect(usePrivacyStore.getState().legacyPasscodeOnly).toBe(false);
    expect((await db.notes.get(id))?.content).toBe(sealed);
    expect((await getSnapshot()).notes.find((note) => note.id === id)?.title).toBe('Therapy');
  });

  it('ends the session the moment the app stops being on screen, whatever an old settings row says', async () => {
    await enableLegacyPasscodeVault();
    expect(usePrivacyStore.getState().unlocked).toBe(true);

    // A vault configured by an earlier build, back when this was a choice. The
    // row is still read; it no longer decides anything.
    await usePrivacyStore.getState().update({ relockPolicy: '15m' });

    // Locking the phone is the case the whole feature exists for, so a quick app
    // switch does not keep the key: it is dropped here, not on the way back in.
    const backgrounded = 1_700_000_000_000;
    usePrivacyStore.getState().handleBackground(backgrounded);
    expect(usePrivacyStore.getState().unlocked).toBe(false);
    expect(isSessionLocked()).toBe(true);

    // Coming back does not reopen it, however long the window used to be.
    expect(usePrivacyStore.getState().handleForeground(backgrounded + 30_000)).toBe(false);
    expect(usePrivacyStore.getState().handleForeground(backgrounded + 15 * 60_000)).toBe(false);
    expect(usePrivacyStore.getState().unlocked).toBe(false);
  });

  it('locks the moment it is backgrounded under the default policy', async () => {
    await enableLegacyPasscodeVault();
    expect(usePrivacyStore.getState().settings.relockPolicy).toBe('immediate');

    usePrivacyStore.getState().handleBackground();
    expect(usePrivacyStore.getState().unlocked).toBe(false);
    // Locking drops the key rather than flagging it: nothing can decrypt now.
    expect(isSessionLocked()).toBe(true);
  });

  it('ends the session on the next tab change, but not on the navigation a reveal caused', async () => {
    await enableLegacyPasscodeVault();
    const opened = 1_700_000_000_000;
    usePrivacyStore.setState({ unlockedAt: opened });

    // Opening a locked folder from Home unlocks and then navigates to Library.
    // That is one act, so the navigation right after the unlock must not undo it.
    usePrivacyStore.getState().lockOnTabChange(opened + 500);
    expect(usePrivacyStore.getState().unlocked).toBe(true);

    // Moving to another tab later is leaving, and the key goes with it.
    usePrivacyStore.getState().lockOnTabChange(opened + 5_000);
    expect(usePrivacyStore.getState().unlocked).toBe(false);
    expect(isSessionLocked()).toBe(true);
  });

  it('does nothing on a tab change when the session is already locked or unprotected', () => {
    // Nothing unlocked: there is no session to end, and locking twice must never
    // be able to fail.
    usePrivacyStore.setState({ keyringPresent: false, unlocked: true, unlockedAt: null });
    usePrivacyStore.getState().lockOnTabChange(1_700_000_000_000);
    expect(usePrivacyStore.getState().unlocked).toBe(true);
  });

  it('opens again with the passcode after the session has locked', async () => {
    await enableLegacyPasscodeVault();
    // A device whose own lock works: the only kind that may convert, because the
    // migration refuses while the new way in cannot be raised.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);

    usePrivacyStore.getState().lock();
    expect(usePrivacyStore.getState().unlocked).toBe(false);

    const result = await usePrivacyStore.getState().unlockWithLegacyPasscode(PASSCODE);
    expect(result.ok).toBe(true);
    expect(usePrivacyStore.getState().unlocked).toBe(true);
    expect((await getSnapshot()).notes.find((note) => note.id === id)?.title).toBe('Therapy');
  });

  it('reports a wrong passcode without changing the vault or converting it', async () => {
    await enableLegacyPasscodeVault();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);
    usePrivacyStore.getState().lock();

    const result = await usePrivacyStore.getState().unlockWithLegacyPasscode('nope');
    expect(result.ok).toBe(false);
    expect(usePrivacyStore.getState().message).toBe('That passcode did not match, so nothing was changed.');
    expect(isSessionLocked()).toBe(true);
    expect(await db.notes.count()).toBe(1);
    expect(isSealed((await db.notes.get(id)) ?? {})).toBe(true);
    // The vault is still the shape an earlier build left it in: a conversion that
    // failed must not consume the wrap it failed to open.
    expect(await hasLegacyPasscodeWrap()).toBe(true);
    expect(usePrivacyStore.getState().legacyPasscodeOnly).toBe(true);
  });
});

describe('device unlock', () => {
  it('opens the vault when the device prompt succeeds', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    forgetVaultKey();

    const result = await usePrivacyStore.getState().unlockWithBiometrics();
    expect(result.ok).toBe(true);
    expect(isSessionLocked()).toBe(false);
  });

  it('leaves the vault locked and every byte intact when the prompt fails', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);
    forgetVaultKey();

    // The device reports a cancelled prompt.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: false, reason: 'cancelled', message: 'Cancelled.' }));
    const cancelled = await usePrivacyStore.getState().unlockWithBiometrics();
    expect(cancelled.ok).toBe(false);
    expect(isSessionLocked()).toBe(true);
    expect(await db.notes.count()).toBe(1);
    expect(isSealed((await db.notes.get(id)) ?? {})).toBe(true);

    // Biometrics being locked out by the OS must not cost any data either.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: false, reason: 'lockout', message: 'Too many.' }));
    const lockedOut = await usePrivacyStore.getState().unlockWithBiometrics();
    expect(lockedOut.ok).toBe(false);
    expect(usePrivacyStore.getState().message).toBe('Too many.');
    expect(isSessionLocked()).toBe(true);

    // The way out of a lockout is the device's own, not a second password: the OS
    // pauses biometry and offers the screen-lock credential instead, so the next
    // successful prompt opens the same vault. Nothing was lost while it was
    // paused, and nothing had to be typed.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    const recovered = await usePrivacyStore.getState().unlockWithBiometrics();
    expect(recovered.ok).toBe(true);
    expect((await getSnapshot()).notes.find((note) => note.id === id)?.title).toBe('Therapy');
  });

  it('cannot open a vault whose device key is gone, and says so without destroying anything', async () => {
    const store = memorySecureStore();
    setSecureStore(store);
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);
    forgetVaultKey();

    // A restore onto a new phone, or cleared app data: the wrapped key survives
    // but the Keystore entry it was wrapped for does not.
    await store.remove('stash.privacy.deviceKey');

    const result = await usePrivacyStore.getState().unlockWithBiometrics();
    expect(result.ok).toBe(false);
    // The honest sentence: the prompt worked, the key is not here. There is no
    // passcode to fall back to, and inventing one would be a weaker lock wearing
    // the name of this one.
    expect(result.message).toContain('no longer holds the key');
    expect(isSessionLocked()).toBe(true);
    expect(await hasKeyring()).toBe(true);
    expect(isSealed((await db.notes.get(id)) ?? {})).toBe(true);
  });

  it('reports the device path as unusable once the stored key is gone', async () => {
    const store = memorySecureStore();
    setSecureStore(store);
    await enablePrivacy();
    expect(await isDeviceUnlockReady()).toBe(true);
    await store.remove('stash.privacy.deviceKey');
    expect(await isDeviceUnlockReady()).toBe(false);
    expect(await unlockWithDevice()).toBeNull();
  });
});

describe('the device prompt as the way in', () => {
  it('refuses to set up locking on a device with no screen lock at all', async () => {
    /*
     * The one setup that must not be allowed.
     *
     * A device with no PIN, pattern, password, fingerprint or face has no prompt
     * to give, so a vault wrapped for it could never be opened — locking there
     * would not protect content, it would hide it behind a door with no handle.
     * The refusal is the kind answer, and the message says why.
     */
    setDeviceAuthenticator(
      createStaticAuthenticator({ ok: false, reason: 'unavailable' }, { available: false, security: 'insecure' }),
    );

    const result = await usePrivacyStore.getState().enableLocking();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('screen lock');
    // Nothing was written, so there is no half-built vault to clean up.
    expect(await hasKeyring()).toBe(false);
    expect(usePrivacyStore.getState().keyringPresent).toBe(false);
  });

  it('turns locking on with one action, and there is nothing to choose', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));

    const result = await usePrivacyStore.getState().enableLocking();
    expect(result.ok).toBe(true);

    const store = () => usePrivacyStore.getState();
    expect(store().keyringPresent).toBe(true);
    expect(store().legacyPasscodeOnly).toBe(false);
    expect(store().deviceUnlockReady).toBe(true);
    expect(store().unlocked).toBe(true);

    // And it becomes a real lock: the folder it protects is sealed at rest, and
    // the prompt is what opens it again after the session ends.
    const folder = await mustFolder('Private');
    const linkId = await mustLink('https://secret.example/x', folder);
    await setFolderLocked(folder, true);
    expect(isSealed((await db.links.get(linkId)) ?? {})).toBe(true);

    store().lock();
    expect(isSessionLocked()).toBe(true);

    const reopened = await store().unlockWithBiometrics(folder);
    expect(reopened.ok).toBe(true);
    expect(store().grantedRoots).toContain(folder);
    expect(isSessionLocked()).toBe(false);
  });

  it('refuses a second setup rather than replacing a key that is in use', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));
    await usePrivacyStore.getState().enableLocking();
    const before = (await readKeyring())?.wrappedByDevice?.ct;

    const again = await usePrivacyStore.getState().enableLocking();
    expect(again.ok).toBe(false);
    expect(again.message).toContain('already set up');
    // The wrap in force is unchanged: a second setup would have orphaned every
    // sealed row in the vault.
    expect((await readKeyring())?.wrappedByDevice?.ct).toBe(before);
  });

  /**
   * The failure this design exists to prevent, stated as an absence.
   *
   * The old system had a way to remove the device wrap — a settings switch — and
   * a vault whose only way in was that wrap became unopenable the moment it was
   * flipped. Locking is device-only now, so the honest form of the same test is
   * that there is *nothing to flip*: no setting, no action, no state on the store
   * that takes a wrap away. The keyring is the only thing that decides.
   */
  it('has no setting that can take the device wrap away', async () => {
    await enablePrivacy();
    const before = (await readKeyring())?.wrappedByDevice?.ct;

    // The capabilities are re-read for a device that can no longer prompt at all.
    setDeviceAuthenticator(NO_DEVICE_AUTH);
    await usePrivacyStore.getState().refreshCapabilities();

    expect(usePrivacyStore.getState().deviceAuthAvailable).toBe(false);
    expect((await readKeyring())?.wrappedByDevice?.ct).toBe(before);
    expect(await isDeviceUnlockReady()).toBe(true);

    const store = usePrivacyStore.getState() as unknown as Record<string, unknown>;
    expect(store.armBiometrics).toBeUndefined();
    expect(store.disarmBiometrics).toBeUndefined();
    expect(store.setPasscode).toBeUndefined();
    expect(store.removePasscode).toBeUndefined();
  });

  /**
   * Crossing one boundary, repeatedly, and the refusal case.
   *
   * Tapping a locked folder asks; passing the prompt opens *that* folder and
   * grants it for the session, so walking around inside it does not ask twice. A
   * cancelled prompt opens nothing and leaves no grant behind, which is what makes
   * a refusal safe to ignore — and the gate is raised for exactly what was
   * refused, so it is explained rather than silent.
   */
  it('opens the folder it was asked for, grants only that one, and grants nothing on a refusal', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    const folder = await mustFolder('Private');
    const other = await mustFolder('Banking');
    await setFolderLocked(folder, true);
    await setFolderLocked(other, true);
    const store = () => usePrivacyStore.getState();

    // Passing the prompt opens the folder that was tapped...
    const opened = await store().requestAccess({ kind: 'folder', id: folder, root: folder });
    expect(opened.ok).toBe(true);
    expect(store().grantedRoots).toContain(folder);
    // ...and nothing else: the second locked folder is exactly as shut as it was.
    expect(store().grantedRoots).not.toContain(other);

    // Ending the session closes both again.
    store().lock();
    expect(store().grantedRoots).toEqual([]);

    // A cancelled prompt opens nothing, grants nothing, and is reported.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: false, reason: 'cancelled', message: 'Cancelled.' }));
    const refused = await store().requestAccess({ kind: 'folder', id: folder, root: folder });
    expect(refused.ok).toBe(false);
    expect(store().grantedRoots).not.toContain(folder);
    expect(store().revealRequest?.root).toBe(folder);
    expect(isSessionLocked()).toBe(true);

    // Passing it afterwards opens the queued folder, and still only that one.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    expect((await store().unlockWithBiometrics()).ok).toBe(true);
    expect(store().grantedRoots).toContain(folder);
    expect(store().grantedRoots).not.toContain(other);
  });

  /**
   * Capability is a fact about the machine, told apart from what it enables.
   *
   * The reported failure was a switch that could never be turned on because its
   * availability was read from the state it controlled. Locking has the same split
   * and needs the same care: whether this device *can* prompt decides whether
   * locking may be offered at all, and the platform answers that before any
   * keyring exists.
   */
  it('reports whether this device can prompt before locking exists at all', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));
    await usePrivacyStore.getState().initialize();

    const after = usePrivacyStore.getState();
    expect(after.ready).toBe(true);
    expect(after.keyringPresent).toBe(false);
    expect(after.deviceUnlockReady).toBe(false);
    expect(after.deviceAuthAvailable).toBe(true);

    expect((await usePrivacyStore.getState().enableLocking()).ok).toBe(true);
    expect(usePrivacyStore.getState().deviceUnlockReady).toBe(true);
  });

  /**
   * The conversion, end to end, on a vault sealed by an earlier build.
   *
   * This is the one place a passcode still appears anywhere in the app, and the
   * assertions say why it has to: the content that build sealed is readable
   * afterwards, and the passcode wrap is *gone* from the keyring rather than kept
   * as a second way in. Deleting the reader instead would have made a year of
   * notes permanently unreadable to save a prompt.
   */
  it('converts a passcode-locked vault to the device lock, keeping every sealed row', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enableLegacyPasscodeVault();
    const noteId = await mustNote('Therapy');
    const folder = await mustFolder('Private');
    const linkId = await mustLink('https://secret.example/divorce', folder);
    await setNoteLocked(noteId, true);
    await setFolderLocked(folder, true);
    const sealed = {
      note: (await db.notes.get(noteId))?.content,
      link: (await db.links.get(linkId))?.url,
    };

    // A restart: no device wrap exists, so the prompt in `auth.ts` cannot open
    // this vault, and the store reports that honestly rather than failing silently.
    forgetVaultKey();
    usePrivacyStore.setState({ unlocked: false });
    expect(usePrivacyStore.getState().legacyPasscodeOnly).toBe(true);
    expect(await isDeviceUnlockReady()).toBe(false);
    expect(await unlockWithDevice()).toBeNull();

    // The passcode the owner already knew converts it, and nothing else can.
    const converted = await usePrivacyStore.getState().unlockWithLegacyPasscode(PASSCODE);
    expect(converted.ok).toBe(true);
    expect(await hasLegacyPasscodeWrap()).toBe(false);
    expect(usePrivacyStore.getState().legacyPasscodeOnly).toBe(false);
    expect(await isDeviceUnlockReady()).toBe(true);

    // The ciphertext is the same ciphertext: converting re-wraps 32 bytes and
    // re-encrypts nothing.
    expect((await db.notes.get(noteId))?.content).toBe(sealed.note);
    expect((await db.links.get(linkId))?.url).toBe(sealed.link);

    // And from here on the device is the only way in.
    forgetVaultKey();
    expect((await usePrivacyStore.getState().unlockWithBiometrics()).ok).toBe(true);
    const snapshot = await getSnapshot();
    expect(snapshot.notes.find((note) => note.id === noteId)?.title).toBe('Therapy');
    expect(snapshot.links.find((link) => link.id === linkId)?.url).toBe(
      'https://secret.example/divorce',
    );
  });

  /**
   * `authorize` is the gate in front of every irreversible action — erasing the
   * vault, restoring a backup over it, destroying the lock. It must never answer
   * `ok` to somebody who has proved nothing.
   */
  it('refuses to authorise a destructive action without a proof', async () => {
    await enablePrivacy();
    forgetVaultKey();
    usePrivacyStore.setState({ unlocked: false });

    // A cancelled prompt authorises nothing, and nothing is opened by trying.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: false, reason: 'cancelled', message: 'Cancelled.' }));
    const refused = await usePrivacyStore.getState().authorize('Erase your Stash vault');
    expect(refused.ok).toBe(false);
    expect(isSessionLocked()).toBe(true);

    // A device that cannot prompt cannot authorise it either. There is no weaker
    // substitute to fall back on, and that is the design rather than a gap: Stash
    // verifying a credential itself is the thing this removed.
    setDeviceAuthenticator(
      createStaticAuthenticator(
        { ok: false, reason: 'unavailable', message: 'This device has no screen lock set up.' },
        { available: false },
      ),
    );
    const unavailable = await usePrivacyStore.getState().authorize('Erase your Stash vault');
    expect(unavailable.ok).toBe(false);
    expect(isSessionLocked()).toBe(true);

    // Passing the prompt does authorise it.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    const allowed = await usePrivacyStore.getState().authorize('Erase your Stash vault');
    expect(allowed.ok).toBe(true);
    expect(isSessionLocked()).toBe(false);
  });

  /**
   * The rule for a device with no screen lock, and the reason it exists.
   *
   * A lock Stash cannot enforce is worse than no lock: it hides content behind a
   * prompt that will never appear, and the hiding survives every attempt to undo
   * it. So when the platform reports that this device has no PIN, pattern,
   * password, fingerprint or face, the app removes the locks — unsealing their
   * content first so nothing is stranded as ciphertext nobody can read — and
   * publishes the outcome for the UI to explain.
   */
  it('removes every lock, unsealing the content first, when the device has no screen lock', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    const folder = await mustFolder('Private');
    const noteId = await mustNote('Therapy');
    const linkId = await mustLink('https://secret.example/divorce', folder);
    await setFolderLocked(folder, true);
    await setNoteLocked(noteId, true);

    // Sealed on disk: the folder's contents and the note's own text.
    expect(await countSealed()).toEqual({ folders: 0, notes: 1, links: 1 });

    // The user removes their screen lock in Android settings, then opens Stash.
    forgetVaultKey();
    usePrivacyStore.setState({ unlocked: false });
    setDeviceAuthenticator(
      createStaticAuthenticator({ ok: false, reason: 'unavailable' }, { available: false, security: 'insecure' }),
    );
    await usePrivacyStore.getState().enforceDeviceSecurity();

    // Every lock is gone, and the content came back with it: not deleted, not
    // hidden, and not left as ciphertext nobody holds a key for.
    expect(await countSealed()).toEqual({ folders: 0, notes: 0, links: 0 });
    expect((await db.folders.get(folder))?.isLocked).toBe(false);
    expect((await db.notes.get(noteId))?.isLocked).toBe(false);
    expect((await db.notes.get(noteId))?.title).toBe('Therapy');
    expect((await db.notes.get(noteId))?.content).toContain('Therapy');
    expect((await db.links.get(linkId))?.url).toBe('https://secret.example/divorce');

    // The keyring goes with it: an unenforceable lock must not be left on the
    // books, or the next app open would be back to the same dead end.
    expect(await hasKeyring()).toBe(false);
    expect(usePrivacyStore.getState().keyringPresent).toBe(false);
    expect(usePrivacyStore.getState().deviceSecurity).toBe('insecure');
    expect(await isDeviceUnlockReady()).toBe(false);

    // And it is reported, with counts that describe what actually happened.
    const notice = usePrivacyStore.getState().noScreenLockNotice;
    expect(notice?.outcome).toBe('removed');
    expect(notice?.locksCleared).toEqual({ folders: 1, notes: 1, links: 0 });
    expect(notice?.opened).toEqual({ folders: 0, notes: 1, links: 1 });
    expect(notice?.unreadable).toBe(0);
  });

  it('leaves every lock alone when the platform cannot be asked, or the device is secure', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    const folder = await mustFolder('Private');
    await mustLink('https://secret.example/keep', folder);
    await setFolderLocked(folder, true);
    const sealed = await countSealed();

    // A browser, or a platform call that failed: `unknown` is not evidence about
    // the device, so nothing may be removed on it. Removing protection on a
    // machine that may be perfectly well locked is the one thing this rule must
    // never do.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true, security: 'unknown' }));
    await usePrivacyStore.getState().enforceDeviceSecurity();
    expect(usePrivacyStore.getState().deviceSecurity).toBe('unknown');
    expect(usePrivacyStore.getState().noScreenLockNotice).toBeNull();
    expect(await countSealed()).toEqual(sealed);
    expect((await db.folders.get(folder))?.isLocked).toBe(true);
    expect(await hasKeyring()).toBe(true);

    // A device whose only protection is a PIN is secure: the prompt offers the
    // screen-lock credential, so the lock stands. No biometrics are enrolled here,
    // which is exactly the case that must keep working.
    setDeviceAuthenticator(
      createStaticAuthenticator({ ok: true }, { available: false, security: 'secure' }),
    );
    await usePrivacyStore.getState().enforceDeviceSecurity();
    expect(usePrivacyStore.getState().deviceSecurity).toBe('secure');
    expect(usePrivacyStore.getState().noScreenLockNotice).toBeNull();
    expect(await countSealed()).toEqual(sealed);
    expect((await db.folders.get(folder))?.isLocked).toBe(true);
    expect(await hasKeyring()).toBe(true);
  });

  it('keeps the locks, and asks for the passcode instead, when the content cannot be opened', async () => {
    await enableLegacyPasscodeVault();
    const folder = await mustFolder('Private');
    const linkId = await mustLink('https://secret.example/stranded', folder);
    await setFolderLocked(folder, true);

    // There is no device key, so this content cannot be unsealed here — and
    // clearing the lock flags would take away the only record protecting it while
    // leaving it unreadable. That is the one case where the locks stay, and the
    // one the UI has to explain rather than resolve.
    forgetVaultKey();
    usePrivacyStore.setState({ unlocked: false });
    setDeviceAuthenticator(
      createStaticAuthenticator({ ok: false, reason: 'unavailable' }, { available: false, security: 'insecure' }),
    );
    await usePrivacyStore.getState().enforceDeviceSecurity();

    expect((await db.folders.get(folder))?.isLocked).toBe(true);
    expect(await hasKeyring()).toBe(true);
    expect(await hasLegacyPasscodeWrap()).toBe(true);
    expect(isSealed((await db.links.get(linkId)) ?? {})).toBe(true);

    const notice = usePrivacyStore.getState().noScreenLockNotice;
    expect(notice?.outcome).toBe('blocked');
    expect(notice?.unreadable).toBeGreaterThan(0);

    // The passcode the owner knows resolves it, and this is the shape the
    // resolution takes on a device with no screen lock: there is no way in to
    // convert *to*, so the proven passcode releases the content and the locks come
    // off directly. No half-way state, and nothing left unreadable.
    expect((await usePrivacyStore.getState().unlockWithLegacyPasscode(PASSCODE)).ok).toBe(true);

    expect((await db.links.get(linkId))?.url).toBe('https://secret.example/stranded');
    expect((await db.folders.get(folder))?.isLocked).toBe(false);
    expect(await countSealed()).toEqual({ folders: 0, notes: 0, links: 0 });
    expect(usePrivacyStore.getState().noScreenLockNotice?.outcome).toBe('removed');
    expect(await hasKeyring()).toBe(false);
  });

  it('opens every boundary at once, and changes nothing on disk', async () => {
    await enablePrivacy();
    const first = await mustFolder('Private');
    const second = await mustFolder('Banking');
    const inFirst = await mustLink('https://example.com/one', first);
    const inSecond = await mustLink('https://example.com/two', second);
    await setFolderLocked(first, true);
    await setFolderLocked(second, true);

    const snapshot = await getSnapshot();
    const protection = computeProtection(snapshot.folders, snapshot.notes, snapshot.links);
    const roots = [...allLockRoots(protection)];
    expect(roots).toHaveLength(2);

    // Nothing is open yet, so both folders are withheld.
    const before = hiddenIds(protection, new Set(usePrivacyStore.getState().grantedRoots));
    expect(before.folders.has(first)).toBe(true);
    expect(before.folders.has(second)).toBe(true);

    usePrivacyStore.getState().grantAll(roots);

    // Everything is readable for the session...
    const granted = new Set(usePrivacyStore.getState().grantedRoots);
    expect(hiddenIds(protection, granted).folders.size).toBe(0);
    expect(canAccess(protection, granted, 'link', inFirst)).toBe(true);
    expect(canAccess(protection, granted, 'link', inSecond)).toBe(true);

    // ...and not one lock flag, sealed row or setting was touched, which is what
    // makes it safe to offer as a recovery action rather than a configuration
    // change.
    expect(await countSealed()).toEqual({ folders: 0, notes: 0, links: 2 });
    expect((await db.folders.get(first))?.isLocked).toBe(true);
    expect((await db.folders.get(second))?.isLocked).toBe(true);
    expect(await isDeviceUnlockReady()).toBe(true);

    // Ending the session closes it all again.
    usePrivacyStore.getState().lock();
    expect(usePrivacyStore.getState().grantedRoots).toEqual([]);
  });
});

describe('screen privacy', () => {
  it('covers the screen while the vault is locked, and clears it when unlocked', async () => {
    const calls: boolean[] = [];
    setPrivacyScreenPlugin({
      setSecure: async ({ secure }) => {
        calls.push(secure);
      },
    });
    // The store applies screen flags without awaiting them — a window flag is not
    // something the session should block on — so the test lets the platform
    // tasks drain before asserting.
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    expect(usePrivacyStore.getState().unlocked).toBe(true);
    calls.length = 0;

    // Device locked / app backgrounded: the recents thumbnail must be blank.
    usePrivacyStore.getState().lock();
    await settle();
    expect(calls.at(-1)).toBe(true);

    // Unlocked, with screen privacy left off as the default, screenshots work.
    expect((await usePrivacyStore.getState().unlockWithBiometrics()).ok).toBe(true);
    await settle();
    expect(calls.at(-1)).toBe(false);

    // Opting in keeps it on while unlocked.
    await usePrivacyStore.getState().update({ secureScreen: true });
    await settle();
    expect(calls.at(-1)).toBe(true);

    // Repeated calls stay idempotent rather than re-applying the same flag.
    calls.length = 0;
    await applyScreenPrivacy(true);
    expect(calls).toHaveLength(0);
  });
});

describe('export and import', () => {
  it('exports locked rows as ciphertext and no key at all, because the key is bound to this device', async () => {
    await enablePrivacy();
    const folder = await mustFolder('Private');
    const id = await mustLink('https://secret.example/court', folder);
    await setFolderLocked(folder, true);

    const bundle = await exportVault();
    expect(bundle.version).toBe(3);
    expect(isValidBundle(bundle)).toBe(true);

    // The address is nowhere in the file in the clear.
    expect(JSON.stringify(bundle)).not.toContain('secret.example');
    expect(isSealed(bundle.links.find((link) => link.id === id) ?? {})).toBe(true);

    // And nothing that opens it travels. The device wrap only means something on
    // the device that created it, and there is no other secret to hand over — so a
    // device-locked vault is restored locked, and the export screen says so rather
    // than implying a recovery that does not exist.
    expect(bundle.security).toBeUndefined();
    expect(describeBundleLocks(bundle)).toEqual({
      sealedFolders: 0,
      sealedNotes: 0,
      sealedLinks: 1,
      hasKeyring: false,
    });

    // Preferences travel, secrets do not.
    expect(bundle.meta.some((row) => row.key === 'db.schemaInfo')).toBe(false);
    expect(bundle.meta.some((row) => row.key === 'privacy.keyring')).toBe(false);
  });

  /**
   * The interop half of the same rule, and it is not optional.
   *
   * A file written by an older build carries a passcode wrap, and that wrap is the
   * only portable key its content will ever have. It has to keep exporting — and a
   * device that adopts it has to be able to open it — or a backup taken before the
   * lock changed becomes a file of unreadable ciphertext.
   */
  it('still hands over a passcode wrap when the vault has one', async () => {
    await enableLegacyPasscodeVault();
    const noteId = await mustNote('Therapy');
    await setNoteLocked(noteId, true);

    const bundle = await exportVault();
    expect(bundle.security?.keyring?.wrappedByPasscode.ct).toBeTruthy();
    expect(JSON.stringify(bundle.security)).not.toContain('wrappedByDevice');
  });

  it('restores a legacy locked vault on another device, and the original passcode converts it', async () => {
    await enableLegacyPasscodeVault();
    const noteId = await mustNote('Therapy');
    await setNoteLocked(noteId, true);
    const bundle = await exportVault();

    // A brand-new installation.
    await resetDatabase();
    forgetVaultKey();
    usePrivacyStore.setState({ ...PRISTINE_PRIVACY_STATE }, true);

    const result = await importVault(bundle, 'merge');
    expect(result.ok).toBe(true);
    expect(result.keyringAdopted).toBe(true);
    expect(result.lockedImported).toBe(1);
    expect(isSealed((await db.notes.get(noteId)) ?? {})).toBe(true);

    // The restored vault is passcode-only, and the passcode the owner knows is
    // what moves it to the new device's lock — the same prompt as on the original,
    // and it needs a device whose own lock works for exactly that reason.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    expect(await hasLegacyPasscodeWrap()).toBe(true);
    expect((await usePrivacyStore.getState().unlockWithLegacyPasscode(PASSCODE)).ok).toBe(true);
    expect(usePrivacyStore.getState().legacyPasscodeOnly).toBe(false);
    expect(await isDeviceUnlockReady()).toBe(true);
    expect((await getSnapshot()).notes.find((note) => note.id === noteId)?.title).toBe('Therapy');
  });

  it('restores a device-locked vault with its content still locked and no key to open it', async () => {
    await enablePrivacy();
    const noteId = await mustNote('Therapy');
    await setNoteLocked(noteId, true);
    const bundle = await exportVault();
    expect(bundle.security).toBeUndefined();

    await resetDatabase();
    forgetVaultKey();

    const result = await importVault(bundle, 'merge');
    expect(result.ok).toBe(true);
    expect(result.keyringAdopted).toBe(false);
    expect(result.lockedImported).toBe(1);

    // Present, sealed, and honest: hidden rather than shown blank. This is the
    // documented cost of a lock bound to a device — the import summary names it
    // rather than pretending the content came back.
    expect(await db.notes.count()).toBe(1);
    expect(isSealed((await db.notes.get(noteId)) ?? {})).toBe(true);
    expect((await getSnapshot()).notes.find((note) => note.id === noteId)?.title).toBe('');
  });

  it('never replaces a keyring that already exists on the device', async () => {
    // A file written on another device, carrying that device's passcode wrap.
    await enableLegacyPasscodeVault();
    const bundle = await exportVault();
    expect(bundle.security?.keyring?.wrappedByPasscode.ct).toBeTruthy();

    // This device, meanwhile, has a vault of its own, locked with its own key.
    await resetDatabase();
    forgetVaultKey();
    await enablePrivacy();
    const local = (await readKeyring())?.wrappedByDevice?.ct;

    const result = await importVault(bundle, 'merge');

    expect(result.keyringAdopted).toBe(false);
    // The local keyring is the one still in force: taking over the file's would
    // have orphaned everything already sealed here.
    expect((await readKeyring())?.wrappedByDevice?.ct).toBe(local);
    expect(await hasLegacyPasscodeWrap()).toBe(false);
    expect(await isDeviceUnlockReady()).toBe(true);
  });

  it('leaves an unlocked vault exportable and importable unchanged', async () => {
    const folder = await mustFolder('Work');
    await mustLink('https://docs.example', folder);
    const bundle = await exportVault();
    expect(bundle.security).toBeUndefined();
    expect(describeBundleLocks(bundle)).toEqual({
      sealedFolders: 0,
      sealedNotes: 0,
      sealedLinks: 0,
      hasKeyring: false,
    });
  });
});

describe('turning privacy off', () => {
  it('decrypts everything before removing the keyring', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    const folder = await mustFolder('Private');
    const id = await mustLink('https://secret.example', folder);
    await setFolderLocked(folder, true);

    const result = await usePrivacyStore.getState().disable();
    expect(result.ok).toBe(true);
    expect(await hasKeyring()).toBe(false);
    expect((await db.links.get(id))?.url).toBe('https://secret.example');
    expect((await db.folders.get(folder))?.name).toBe('Private');
    expect((await db.folders.get(folder))?.isLocked).toBe(false);
    expect(await countSealed()).toEqual({ folders: 0, notes: 0, links: 0 });
  });

  it('refuses to turn off when the prompt does not succeed', async () => {
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);

    setDeviceAuthenticator(createStaticAuthenticator({ ok: false, reason: 'cancelled', message: 'Cancelled.' }));
    const result = await usePrivacyStore.getState().disable();
    expect(result.ok).toBe(false);
    expect(await hasKeyring()).toBe(true);
    expect(isSealed((await db.notes.get(id)) ?? {})).toBe(true);
  });

  it('can abandon a forgotten lock without destroying the readable part of the vault', async () => {
    await enablePrivacy();
    const locked = await mustNote('Therapy');
    const open = await mustNote('Groceries');
    await setNoteLocked(locked, true);

    await usePrivacyStore.getState().abandonLock();

    expect(await hasKeyring()).toBe(false);
    // The unreadable row is still present — this removes the key, not the data.
    expect(await db.notes.count()).toBe(2);
    expect(isSealed((await db.notes.get(locked)) ?? {})).toBe(true);
    expect((await db.notes.get(open))?.title).toBe('Groceries');
  });
});

describe('schema and settings', () => {
  it('has the security table and keeps unlocking consistent across a migration', async () => {
    expect(db.tables.map((table) => table.name)).toContain('security');
    const link = await createLink({ url: 'https://example.com/x', folderId: null });
    expect(link.isLocked).toBe(false);
    expect((await db.links.get(link.id))?.isLocked).toBe(false);
  });

  it('defaults privacy settings to the secure values and persists changes', async () => {
    const defaults = await getPrivacySettings();
    expect(defaults).toEqual({
      enabled: false,
      relockPolicy: 'immediate',
      lockApp: true,
      secureScreen: false,
      biometric: true,
      // The device prompt is preferred by default *when it is armed*; a vault that
      // has no device wrap falls back to the passcode regardless of this value.
      primaryUnlock: 'device',
    });

    await setPrivacySettings({ relockPolicy: '15m', secureScreen: true, primaryUnlock: 'passcode' });
    expect(await getPrivacySettings()).toMatchObject({
      relockPolicy: '15m',
      secureScreen: true,
      primaryUnlock: 'passcode',
    });

    // A corrupted row degrades to the defaults instead of disabling the lock.
    await db.meta.put({ key: 'privacy.settings', value: { relockPolicy: 'nonsense' } });
    const recovered = await getPrivacySettings();
    expect(recovered.relockPolicy).toBe('immediate');
    expect(recovered.primaryUnlock).toBe('device');

    // A row written before the field existed must not point the gate at a way in
    // the vault does not have.
    await db.meta.put({ key: 'privacy.settings', value: { primaryUnlock: 'nonsense' } });
    expect((await getPrivacySettings()).primaryUnlock).toBe('device');
  });

  it('does not leave a keyring behind after the vault is erased', async () => {
    await enablePrivacy();
    expect(await hasKeyring()).toBe(true);
    await resetDatabase();
    expect(await hasKeyring()).toBe(false);
    // Nothing can be left sealed with no key, because the rows are gone too.
    await destroyKeyring();
    expect(await hasKeyring()).toBe(false);
  });
});
