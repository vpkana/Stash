import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import { createFolder, setFolderLocked } from '@/db/repos/folders';
import { createLink } from '@/db/repos/links';
import { createStaticAuthenticator, setDeviceAuthenticator } from '@/lib/privacy/auth';
import {
  createKeyring,
  enableDeviceUnlock,
  forgetVaultKey,
  isSessionLocked,
} from '@/lib/privacy/keyring';
import { isSealed } from '@/lib/privacy/protection';
import { setSecureStore, type SecureStore } from '@/lib/privacy/secure-store';
import { searchVault } from '@/lib/search';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';

/**
 * Locked items stay in the list, and tapping one asks for the prompt.
 *
 * That is a deliberate product choice with a privacy consequence, so both halves
 * are pinned here: the row survives with its shape intact, and *nothing* about
 * its content does — no title, no name, no address, and no match in search.
 */

const PASSCODE = 'open sesame 42';

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

const PRISTINE_VAULT = useVaultStore.getState();
const PRISTINE_PRIVACY = usePrivacyStore.getState();

async function resetDatabase() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

/** A locked folder with a link and a sibling folder that stays open. */
async function arrangeLockedFolder() {
  const parent = await createFolder({ name: 'Personal', parentId: null });
  if (!parent.ok) throw new Error('folder');
  const secret = await createFolder({ name: 'Divorce', parentId: parent.folder.id });
  if (!secret.ok) throw new Error('folder');
  const inside = await createLink({
    url: 'https://example.com/lawyer',
    folderId: secret.folder.id,
    title: 'Family lawyer — first consultation',
  });
  const open = await createFolder({ name: 'Development', parentId: null });
  if (!open.ok) throw new Error('folder');

  await setFolderLocked(secret.folder.id, true);
  return { parent: parent.folder.id, secret: secret.folder.id, inside: inside.id, open: open.folder.id };
}

beforeEach(async () => {
  await resetDatabase();
  forgetVaultKey();
  useVaultStore.setState({ ...PRISTINE_VAULT }, true);
  usePrivacyStore.setState({ ...PRISTINE_PRIVACY }, true);
  setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));
  setSecureStore(memorySecureStore());
  await createKeyring(PASSCODE);
});

describe('a locked folder in the tree', () => {
  it('keeps its place in the list and loses every readable field', async () => {
    const ids = await arrangeLockedFolder();
    forgetVaultKey();
    await useVaultStore.getState().refresh();

    const state = useVaultStore.getState();
    const locked = state.folders.find((folder) => folder.id === ids.secret);
    expect(locked).toBeDefined();
    // The name stays: it is the label on the lock, and without it the user could
    // not tell which protected folder a row was, or choose one as a destination.
    expect(locked?.name).toBe('Divorce');
    // It is published as hidden, so every content surface skips it and every
    // listing counts it as absent.
    expect(state.hidden.folders.has(ids.secret)).toBe(true);
    // What is *inside* is what an attacker would be reading, and none of it is
    // in the clear on disk: the folder's link is ciphertext with no URL, title or
    // note left to read.
    const storedLink = await db.links.get(ids.inside);
    expect(isSealed(storedLink ?? {})).toBe(true);
    expect(JSON.stringify(storedLink)).not.toContain('lawyer');
    expect(state.hidden.links.has(ids.inside)).toBe(true);

    // Unlocked items are untouched beside it.
    expect(state.folders.find((folder) => folder.id === ids.open)?.name).toBe('Development');
  });

  it('keeps its links listed as placeholders too', async () => {
    const ids = await arrangeLockedFolder();
    forgetVaultKey();
    await useVaultStore.getState().refresh();

    const state = useVaultStore.getState();
    const link = state.links.find((candidate) => candidate.id === ids.inside);
    expect(link).toBeDefined();
    expect(link?.title).toBeUndefined();
    expect(link?.url).toBe('');
    expect(isSealed(link ?? {})).toBe(true);
    expect(state.hidden.links.has(ids.inside)).toBe(true);
  });

  it('contributes no counts while its boundary is shut', async () => {
    const ids = await arrangeLockedFolder();
    forgetVaultKey();
    await useVaultStore.getState().refresh();

    // A count is a listing: "1 link" beside a folder the user cannot open tells
    // them something is in there and roughly how much. The locked folder gets no
    // entry at all rather than a row of zeroes, which would say the same thing
    // less precisely.
    const stats = useVaultStore.getState().folderStats;
    expect(stats.has(ids.secret)).toBe(false);
    // Its parent is visible, but the hidden child is not counted into it either.
    expect(stats.get(ids.parent)).toEqual({ directLinks: 0, nestedLinks: 0, directChildren: 0 });
    expect(stats.get(ids.open)).toEqual({ directLinks: 0, nestedLinks: 0, directChildren: 0 });
  });

  it('never appears in search, locked or not', async () => {
    await arrangeLockedFolder();
    forgetVaultKey();
    await useVaultStore.getState().refresh();

    const state = useVaultStore.getState();
    const outcome = searchVault(
      {
        folders: state.folders,
        links: state.links,
        tags: state.tags,
        linkTags: state.linkTags,
        notes: state.notes,
        noteLinks: state.noteLinks,
      },
      { query: 'lawyer', hidden: state.hidden },
    );
    expect(outcome.links).toHaveLength(0);
    expect(outcome.folders).toHaveLength(0);

    const byName = searchVault(
      {
        folders: state.folders,
        links: state.links,
        tags: state.tags,
        linkTags: state.linkTags,
        notes: state.notes,
        noteLinks: state.noteLinks,
      },
      { query: 'Divorce', hidden: state.hidden },
    );
    expect(byName.folders).toHaveLength(0);
  });

  it('becomes readable again after the boundary is crossed', async () => {
    const ids = await arrangeLockedFolder();
    forgetVaultKey();
    await useVaultStore.getState().refresh();
    expect(isSessionLocked()).toBe(true);

    // The request queues the gate, and the passcode answers it — the same path
    // a legacy vault takes, and the only path that grants anything.
    expect((await usePrivacyStore.getState().requestAccess({ kind: 'folder', id: ids.secret, root: ids.secret })).ok).toBe(false);
    expect((await usePrivacyStore.getState().unlock(PASSCODE)).ok).toBe(true);
    await useVaultStore.getState().refresh();

    const state = useVaultStore.getState();
    expect(state.hidden.folders.has(ids.secret)).toBe(false);
    expect(state.hidden.links.has(ids.inside)).toBe(false);
    // The sibling branch was never protected, so it never had to be opened.
    expect(state.hidden.folders.has(ids.open)).toBe(false);
  });
});

describe('tapping a locked row', () => {
  it('runs the device prompt and reports success when it answers', async () => {
    const ids = await arrangeLockedFolder();
    // Arm the device path while the vault is still open, then lock it.
    expect(await enableDeviceUnlock()).toBe(true);
    forgetVaultKey();
    await useVaultStore.getState().refresh();

    const result = await usePrivacyStore
      .getState()
      .requestAccess({ kind: 'folder', id: ids.secret, root: ids.secret });
    expect(result.ok).toBe(true);
    expect(isSessionLocked()).toBe(false);
    expect(usePrivacyStore.getState().revealRequest).toBeNull();
    // Only the boundary that was asked for opened.
    expect(usePrivacyStore.getState().grantedRoots).toEqual([ids.secret]);
  });

  it('queues the request when there is no device path, so the gate can ask', async () => {
    const ids = await arrangeLockedFolder();
    forgetVaultKey();
    // No device wrap was armed, so the prompt is the passcode.
    const result = await usePrivacyStore
      .getState()
      .requestAccess({ kind: 'folder', id: ids.secret, root: ids.secret });

    expect(result.ok).toBe(false);
    expect(isSessionLocked()).toBe(true);
    expect(usePrivacyStore.getState().revealRequest).toEqual({
      kind: 'folder',
      id: ids.secret,
      root: ids.secret,
    });

    // Using the passcode satisfies it: the queued request goes away with it.
    expect((await usePrivacyStore.getState().unlock(PASSCODE)).ok).toBe(true);
    expect(usePrivacyStore.getState().revealRequest).toBeNull();
  });

  it('never asks twice for a boundary that is already open', async () => {
    const ids = await arrangeLockedFolder();
    usePrivacyStore.getState().grant(ids.secret);

    const result = await usePrivacyStore
      .getState()
      .requestAccess({ kind: 'link', id: ids.inside, root: ids.secret });
    expect(result.ok).toBe(true);
    expect(usePrivacyStore.getState().revealRequest).toBeNull();
  });

  it('leaving the app ends every open boundary', async () => {
    const ids = await arrangeLockedFolder();
    usePrivacyStore.getState().grant(ids.secret);
    expect(usePrivacyStore.getState().grantedRoots).toEqual([ids.secret]);

    usePrivacyStore.getState().handleBackground();
    expect(usePrivacyStore.getState().grantedRoots).toEqual([]);
    expect(isSessionLocked()).toBe(true);
  });
});
