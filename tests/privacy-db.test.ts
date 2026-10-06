import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
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
  createKeyring,
  destroyKeyring,
  disableDeviceUnlock,
  enableDeviceUnlock,
  forgetVaultKey,
  hasKeyring,
  isDeviceUnlockReady,
  isSessionLocked,
  readKeyring,
  unlockWithPasscode,
} from '@/lib/privacy/keyring';
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
 */

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
  setDeviceAuthenticator(NO_DEVICE_AUTH);
  setSecureStore(null);
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

/** Turn privacy on and leave the session unlocked. */
async function enablePrivacy(passcode = PASSCODE): Promise<void> {
  const result = await createKeyring(passcode);
  expect(result.ok).toBe(true);
}

/**
 * A vault set up the way an older build set one up: a passcode is the only key.
 *
 * The app no longer offers this — locking is turned on with the device prompt,
 * and Stash keeps no passcode of its own — but the shape still matters for two
 * reasons, both about not losing data: an existing user's vault looks like this,
 * and a backup written by an older build adopts exactly this keyring. So the
 * passcode paths stay exercised here even though nothing creates one.
 */
async function enableLegacyPasscodeVault(passcode = PASSCODE): Promise<void> {
  await enablePrivacy(passcode);
  const settings = await setPrivacySettings({ enabled: true });
  usePrivacyStore.setState({
    settings,
    keyringPresent: true,
    passcodeSet: true,
    deviceUnlockReady: false,
    unlocked: true,
    unlockedAt: Date.now(),
    message: null,
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

  it('finds everything again once the passcode is entered', async () => {
    await enablePrivacy();
    const folder = await mustFolder('Private');
    const noteId = await mustNote('Therapy');
    await mustLink('https://secret.example/notes', folder);
    await setNoteLocked(noteId, true);
    await setFolderLocked(folder, true);

    forgetVaultKey();
    await unlockWithPasscode(PASSCODE);
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
  it('starts locked after a restart and opens with the passcode', async () => {
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

    expect(await unlockWithPasscode('wrong passcode')).toBeNull();
    expect(isSessionLocked()).toBe(true);
    expect(isSealed((await db.notes.get(id)) ?? {})).toBe(true);

    expect(await unlockWithPasscode(PASSCODE)).not.toBeNull();
    expect((await getSnapshot()).notes.find((note) => note.id === id)?.title).toBe('Therapy');
  });

  it('adds a device wrap beside a legacy passcode wrap without re-encrypting anything', async () => {
    await enablePrivacy();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);
    const sealed = (await db.notes.get(id))?.content;
    const before = (await readKeyring())?.wrappedByPasscode?.ct;

    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));
    setSecureStore(memorySecureStore());
    expect(await enableDeviceUnlock()).toBe(true);

    // Two ways in, one key: the passcode wrap is untouched, and the sealed row is
    // the same ciphertext it was before.
    expect((await readKeyring())?.wrappedByPasscode?.ct).toBe(before);
    forgetVaultKey();
    expect(await unlockWithPasscode(PASSCODE)).not.toBeNull();
    expect((await db.notes.get(id))?.content).toBe(sealed);
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
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);

    usePrivacyStore.getState().lock();
    expect(usePrivacyStore.getState().unlocked).toBe(false);

    const result = await usePrivacyStore.getState().unlock(PASSCODE);
    expect(result.ok).toBe(true);
    expect(usePrivacyStore.getState().unlocked).toBe(true);
    expect((await getSnapshot()).notes.find((note) => note.id === id)?.title).toBe('Therapy');
  });

  it('reports a wrong passcode without changing the vault', async () => {
    await enableLegacyPasscodeVault();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);
    usePrivacyStore.getState().lock();

    const result = await usePrivacyStore.getState().unlock('nope');
    expect(result.ok).toBe(false);
    expect(usePrivacyStore.getState().message).toBe('That passcode did not match.');
    expect(isSessionLocked()).toBe(true);
    expect(await db.notes.count()).toBe(1);
    expect(isSealed((await db.notes.get(id)) ?? {})).toBe(true);
  });
});

describe('device unlock', () => {
  it('opens the vault when the device prompt succeeds', async () => {
    setSecureStore(memorySecureStore());
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    await enableDeviceUnlock();
    forgetVaultKey();

    const result = await usePrivacyStore.getState().unlockWithBiometrics();
    expect(result.ok).toBe(true);
    expect(isSessionLocked()).toBe(false);
  });

  it('leaves the vault locked and every byte intact when the prompt fails', async () => {
    setSecureStore(memorySecureStore());
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    await enableDeviceUnlock();
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

    // And the passcode still works, which is the whole recovery story.
    const recovered = await usePrivacyStore.getState().unlock(PASSCODE);
    expect(recovered.ok).toBe(true);
    expect((await getSnapshot()).notes.find((note) => note.id === id)?.title).toBe('Therapy');
  });

  it('falls back to the passcode when the device key has gone', async () => {
    const store = memorySecureStore();
    setSecureStore(store);
    setDeviceAuthenticator(createStaticAuthenticator({ ok: true }));
    await enablePrivacy();
    await enableDeviceUnlock();
    forgetVaultKey();

    // A restore onto a new phone, or cleared app data: the wrapped key survives
    // but the Keystore entry it was wrapped for does not.
    await store.remove('stash.privacy.deviceKey');

    const result = await usePrivacyStore.getState().unlockWithBiometrics();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('passcode');
    expect(isSessionLocked()).toBe(true);
    expect(await unlockWithPasscode(PASSCODE)).not.toBeNull();
  });

  it('keeps the passcode wrap when the device wrap is removed again', async () => {
    setSecureStore(memorySecureStore());
    await enablePrivacy();
    expect(await enableDeviceUnlock()).toBe(true);
    // Rewriting a keyring must never drop the other wrap: this is the same
    // clobbering risk the passcode-change round trip used to guard.
    await disableDeviceUnlock();
    expect(await isDeviceUnlockReady()).toBe(false);
    forgetVaultKey();
    expect(await unlockWithPasscode(PASSCODE)).not.toBeNull();
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

    await enableLegacyPasscodeVault();
    expect(usePrivacyStore.getState().unlocked).toBe(true);
    calls.length = 0;

    // Device locked / app backgrounded: the recents thumbnail must be blank.
    usePrivacyStore.getState().lock();
    await settle();
    expect(calls.at(-1)).toBe(true);

    // Unlocked, with screen privacy left off as the default, screenshots work.
    await usePrivacyStore.getState().unlock(PASSCODE);
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
  it('exports locked rows as ciphertext plus the passcode wrap, never the device wrap', async () => {
    setSecureStore(memorySecureStore());
    await enablePrivacy();
    await enableDeviceUnlock();
    const folder = await mustFolder('Private');
    const id = await mustLink('https://secret.example/court', folder);
    await setFolderLocked(folder, true);

    const bundle = await exportVault();
    expect(bundle.version).toBe(3);
    expect(isValidBundle(bundle)).toBe(true);

    // The address is nowhere in the file in the clear.
    expect(JSON.stringify(bundle)).not.toContain('secret.example');
    expect(isSealed(bundle.links.find((link) => link.id === id) ?? {})).toBe(true);

    // The passcode wrap travels; the device wrap does not, because it only means
    // something on the device that created it.
    expect(bundle.security?.keyring?.wrappedByPasscode.ct).toBeTruthy();
    expect(JSON.stringify(bundle.security)).not.toContain('wrappedByDevice');

    // Folders are never sealed: their names are labels, and the protected
    // content inside them is what travels as ciphertext.
    expect(describeBundleLocks(bundle)).toEqual({
      sealedFolders: 0,
      sealedNotes: 0,
      sealedLinks: 1,
      hasKeyring: true,
    });

    // Preferences travel, secrets do not.
    expect(bundle.meta.some((row) => row.key === 'db.schemaInfo')).toBe(false);
    expect(bundle.meta.some((row) => row.key === 'privacy.keyring')).toBe(false);
  });

  it('restores a locked vault on another device, opened by the original passcode', async () => {
    await enablePrivacy();
    const noteId = await mustNote('Therapy');
    await setNoteLocked(noteId, true);
    const bundle = await exportVault();

    // A brand-new installation.
    await resetDatabase();
    forgetVaultKey();

    const result = await importVault(bundle, 'merge');
    expect(result.ok).toBe(true);
    expect(result.keyringAdopted).toBe(true);
    expect(result.lockedImported).toBe(1);
    expect(isSealed((await db.notes.get(noteId)) ?? {})).toBe(true);

    expect(await unlockWithPasscode(PASSCODE)).not.toBeNull();
    expect((await getSnapshot()).notes.find((note) => note.id === noteId)?.title).toBe('Therapy');
  });

  it('keeps sealed rows locked, rather than losing them, when no keyring arrives', async () => {
    await enablePrivacy();
    const noteId = await mustNote('Therapy');
    await setNoteLocked(noteId, true);
    const bundle = await exportVault();
    // A file someone stripped the keyring out of, or an older export tool.
    delete bundle.security;

    await resetDatabase();
    forgetVaultKey();

    const result = await importVault(bundle, 'merge');
    expect(result.ok).toBe(true);
    expect(result.keyringAdopted).toBe(false);
    expect(result.lockedImported).toBe(1);

    // Present, sealed, and honest: hidden rather than shown blank.
    expect(await db.notes.count()).toBe(1);
    expect(isSealed((await db.notes.get(noteId)) ?? {})).toBe(true);
    expect((await getSnapshot()).notes.find((note) => note.id === noteId)?.title).toBe('');
  });

  it('never replaces a keyring that already exists on the device', async () => {
    await enablePrivacy();
    const bundle = await exportVault();
    const original = (await readKeyring())?.wrappedByPasscode?.ct;

    // Still on the same device, which has since wrapped the same key for its own
    // device prompt as well.
    setSecureStore(memorySecureStore());
    expect(await enableDeviceUnlock()).toBe(true);
    const result = await importVault(bundle, 'merge');

    expect(result.keyringAdopted).toBe(false);
    // The local keyring is the one still in force: neither wrap was replaced.
    expect((await readKeyring())?.wrappedByPasscode?.ct).toBe(original);
    expect(await isDeviceUnlockReady()).toBe(true);
    expect(await unlockWithPasscode(PASSCODE)).not.toBeNull();
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
    await enableLegacyPasscodeVault();
    const folder = await mustFolder('Private');
    const id = await mustLink('https://secret.example', folder);
    await setFolderLocked(folder, true);

    const result = await usePrivacyStore.getState().disable(PASSCODE);
    expect(result.ok).toBe(true);
    expect(await hasKeyring()).toBe(false);
    expect((await db.links.get(id))?.url).toBe('https://secret.example');
    expect((await db.folders.get(folder))?.name).toBe('Private');
    expect(await countSealed()).toEqual({ folders: 0, notes: 0, links: 0 });
  });

  it('refuses to turn off with the wrong passcode', async () => {
    await enablePrivacy();
    const id = await mustNote('Therapy');
    await setNoteLocked(id, true);

    const result = await usePrivacyStore.getState().disable('the wrong one');
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
    });

    await setPrivacySettings({ relockPolicy: '15m', secureScreen: true });
    expect(await getPrivacySettings()).toMatchObject({ relockPolicy: '15m', secureScreen: true });

    // A corrupted row degrades to the defaults instead of disabling the lock.
    await db.meta.put({ key: 'privacy.settings', value: { relockPolicy: 'nonsense' } });
    const recovered = await getPrivacySettings();
    expect(recovered.relockPolicy).toBe('immediate');
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
