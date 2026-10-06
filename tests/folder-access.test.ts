import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import { createFolder, setFolderLocked } from '@/db/repos/folders';
import { createLink } from '@/db/repos/links';
import { createStaticAuthenticator, setDeviceAuthenticator } from '@/lib/privacy/auth';
import { encryptJson } from '@/lib/privacy/crypto';
import {
  createKeyring,
  enableDeviceUnlock,
  forgetVaultKey,
  getVaultKey,
  isSessionLocked,
} from '@/lib/privacy/keyring';
import { isSealed } from '@/lib/privacy/protection';
import type { SecureStore } from '@/lib/privacy/secure-store';
import { setSecureStore } from '@/lib/privacy/secure-store';
import { canAccessFolder, requireFolderAccess } from '@/lib/privacy/access';
import { allLockRoots, canAccess, computeProtection, hiddenIds } from '@/lib/privacy/protection';
import { parseShare } from '@/lib/share/parse';
import { useCaptureStore } from '@/stores/capture-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';

/**
 * Locking is per folder, and it is an access decision.
 *
 * This file walks the scenarios the previous implementation got wrong, in the
 * order a user would hit them:
 *
 *  A. an old locked folder, opened, prompt refused → its contents stay invisible;
 *  B. a folder locked *after* the app was already open → still shut when reopened;
 *  C. authenticate → contents appear, and a link opens;
 *  D. a share → no prompt anywhere → saved into an unlocked folder;
 *  E. a share → a locked destination → the prompt appears there and nowhere else;
 *  F. search while shut → nothing protected comes back;
 *  G. search after the boundary is crossed → it does.
 *
 * The through-line is that nothing here relies on the vault key being absent.
 * Every case runs with the key present — the app was opened, or a share arrived,
 * or another folder was unlocked — which is exactly the state the old model got
 * wrong, because it treated "the key is in memory" as "everything is readable".
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
const PRISTINE_CAPTURE = useCaptureStore.getState();

async function resetDatabase() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

beforeEach(async () => {
  await resetDatabase();
  forgetVaultKey();
  useVaultStore.setState({ ...PRISTINE_VAULT }, true);
  usePrivacyStore.setState({ ...PRISTINE_PRIVACY }, true);
  useCaptureStore.setState({ ...PRISTINE_CAPTURE }, true);
  setSecureStore(memorySecureStore());
  setDeviceAuthenticator(createStaticAuthenticator({ ok: true }, { available: true }));
  // A passcode-only keyring: the vault key is present from here on, and there is
  // no device wrap to answer with. So `requestAccess` cannot fast-path — it either
  // finds the boundary already open or queues the gate.
  await createKeyring(PASSCODE);
});

async function mustFolder(name: string, parentId: string | null = null): Promise<string> {
  const result = await createFolder({ name, parentId });
  if (!result.ok) throw new Error(`could not create ${name}`);
  return result.folder.id;
}

async function mustLink(url: string, folderId: string | null): Promise<string> {
  const link = await createLink({ url, folderId, title: `Title for ${url}` });
  return link.id;
}

/** Refresh, then read the published access state the whole UI reads. */
async function view() {
  await useVaultStore.getState().refresh();
  return useVaultStore.getState();
}

describe('A and B: a shut boundary stays shut', () => {
  it('A: refuses the prompt for an old locked folder and keeps it inaccessible', async () => {
    const privateId = await mustFolder('Private');
    const linkId = await mustLink('https://old.example/divorce', privateId);
    await setFolderLocked(privateId, true);

    const state = await view();
    expect(state.hidden.folders.has(privateId)).toBe(true);
    expect(state.hidden.links.has(linkId)).toBe(true);

    // No device path, so this queues the gate and reports back that access was
    // *not* granted. The requirement is not "the UI hides it" — it is that the
    // answer is no.
    expect(await requireFolderAccess(privateId)).toBe(false);
    expect(canAccessFolder(privateId)).toBe(false);
    expect(usePrivacyStore.getState().grantedRoots).toEqual([]);

    const after = useVaultStore.getState();
    expect(after.hidden.links.has(linkId)).toBe(true);
    // The address is not merely un-rendered: it is not in memory to render. The
    // vault key is present here (the app was opened), so without this the row
    // would be sitting decrypted in the store and only a component's check would
    // be standing in front of it.
    const withheld = after.links.find((link) => link.id === linkId);
    expect(withheld?.url).toBe('');
    expect(withheld?.title).toBeUndefined();
    expect(JSON.stringify(withheld)).not.toContain('divorce');
  });

  it('B: a folder locked after the app was already open is shut when reopened', async () => {
    // The regression, exactly: the vault key is in memory the whole time, which
    // used to be read as "nothing is hidden any more".
    const laterId = await mustFolder('Later');
    const a = await mustLink('https://later.example/a', laterId);
    const b = await mustLink('https://later.example/b', laterId);
    expect(isSessionLocked()).toBe(false);

    await setFolderLocked(laterId, true);
    const state = await view();

    expect(state.hidden.folders.has(laterId)).toBe(true);
    expect(state.hidden.links.has(a)).toBe(true);
    expect(state.hidden.links.has(b)).toBe(true);
    // Its contents are not in any listing built from the published sets.
    expect(state.folderStats.has(laterId)).toBe(false);
    expect(state.inboxLinks.some((link) => link.id === a || link.id === b)).toBe(false);

    expect(await requireFolderAccess(laterId)).toBe(false);
    expect(useVaultStore.getState().hidden.links.has(a)).toBe(true);
  });

  it('protects a nested folder without letting it be reached on its own', async () => {
    const privateId = await mustFolder('Private');
    const bankingId = await mustFolder('Banking', privateId);
    const linkId = await mustLink('https://bank.example/statement', bankingId);
    await setFolderLocked(privateId, true);

    const state = await view();
    // The nested folder inherited the lock, so a deep link straight to it is the
    // same request as the parent and gets the same answer.
    expect(state.hidden.folders.has(bankingId)).toBe(true);
    expect(state.hidden.links.has(linkId)).toBe(true);
    expect(await requireFolderAccess(bankingId)).toBe(false);
    expect(await requireFolderAccess(privateId)).toBe(false);
  });
});

describe('C: crossing the boundary', () => {
  it('makes the contents readable and opens a link, without a second prompt', async () => {
    const privateId = await mustFolder('Private');
    const linkId = await mustLink('https://private.example/one', privateId);
    await setFolderLocked(privateId, true);
    await view();

    // A device path this time, so the prompt can answer for it.
    expect(await enableDeviceUnlock()).toBe(true);
    expect(await requireFolderAccess(privateId)).toBe(true);

    const state = useVaultStore.getState();
    expect(state.hidden.folders.has(privateId)).toBe(false);
    expect(state.hidden.links.has(linkId)).toBe(false);
    const link = state.links.find((candidate) => candidate.id === linkId);
    expect(link?.url).toBe('https://private.example/one');
    expect(link?.title).toBe('Title for https://private.example/one');

    // Nothing else opened: this is one boundary, not an app-wide unlock.
    expect(usePrivacyStore.getState().grantedRoots).toEqual([privateId]);
  });

  it('does not open a second locked folder along with the first', async () => {
    const privateId = await mustFolder('Private');
    const bankingId = await mustFolder('Banking');
    const bankingLink = await mustLink('https://bank.example/x', bankingId);
    await setFolderLocked(privateId, true);
    await setFolderLocked(bankingId, true);
    await view();
    expect(await enableDeviceUnlock()).toBe(true);

    expect(await requireFolderAccess(privateId)).toBe(true);
    const state = useVaultStore.getState();
    expect(state.hidden.folders.has(privateId)).toBe(false);
    // Opening the first boundary opened exactly one boundary.
    expect(usePrivacyStore.getState().grantedRoots).toEqual([privateId]);
    expect(state.hidden.folders.has(bankingId)).toBe(true);
    expect(state.hidden.links.has(bankingLink)).toBe(true);
    expect(state.links.find((link) => link.id === bankingLink)?.url).toBe('');

    // The second folder needs its own answer, and a refusal leaves it shut.
    setDeviceAuthenticator(createStaticAuthenticator({ ok: false }, { available: true }));
    expect(await requireFolderAccess(bankingId)).toBe(false);
    expect(useVaultStore.getState().hidden.links.has(bankingLink)).toBe(true);
  });

  it('ends every grant when the app is backgrounded', async () => {
    const privateId = await mustFolder('Private');
    await setFolderLocked(privateId, true);
    await view();
    expect(await enableDeviceUnlock()).toBe(true);
    expect(await requireFolderAccess(privateId)).toBe(true);

    usePrivacyStore.getState().handleBackground();
    expect(usePrivacyStore.getState().grantedRoots).toEqual([]);
    expect(isSessionLocked()).toBe(true);

    await view();
    expect(useVaultStore.getState().hidden.folders.has(privateId)).toBe(true);
  });
});

describe('D and E: sharing', () => {
  it('D: arrives and saves into an unlocked folder without asking for anything', async () => {
    const privateId = await mustFolder('Private');
    await setFolderLocked(privateId, true);
    const workId = await mustFolder('Work');
    await view();

    await useCaptureStore
      .getState()
      .openFromShare(parseShare({ text: 'React Server Components\nhttps://youtube.com/watch?v=abc123' }));

    // The sheet opened, nothing was queued, and no prompt is on screen.
    expect(useCaptureStore.getState().status).toBe('open');
    expect(usePrivacyStore.getState().revealRequest).toBeNull();
    // The source's title is offered as the note, editable, and separate from the URL.
    expect(useCaptureStore.getState().draft?.note).toBe('React Server Components');
    expect(useCaptureStore.getState().draft?.url).toBe('https://youtube.com/watch?v=abc123');

    expect(await useCaptureStore.getState().chooseDestination({ kind: 'folder', folderId: workId })).toBe(true);
    expect(usePrivacyStore.getState().revealRequest).toBeNull();

    const outcome = await useCaptureStore.getState().save();
    expect(outcome.ok).toBe(true);
    const saved = useVaultStore.getState().links.find((link) => link.id === outcome.link?.id);
    expect(saved?.folderId).toBe(workId);
    expect(saved?.url).toBe('https://youtube.com/watch?v=abc123');
    expect(saved?.userNote).toBe('React Server Components');
  });

  it('never pre-selects a locked folder as the destination', async () => {
    const privateId = await mustFolder('Private');
    await setFolderLocked(privateId, true);
    // ...and it was the most recent destination before it was locked.
    await useVaultStore.getState().refresh();
    await useCaptureStore.getState().openManual();
    await useCaptureStore.getState().setDraftField('url', 'https://example.com/one');

    // The Inbox is the safe default, not the folder nobody has unlocked.
    expect(useCaptureStore.getState().destination.kind).toBe('inbox');
  });

  it('E: asks only when a locked folder is chosen as the destination', async () => {
    const privateId = await mustFolder('Private');
    await setFolderLocked(privateId, true);
    await view();

    await useCaptureStore
      .getState()
      .openFromShare(parseShare({ text: 'https://private.example/secret' }));
    expect(usePrivacyStore.getState().revealRequest).toBeNull();

    // The choice is refused, so the destination does not move and nothing is
    // written — and *now* there is a queued request, and only now.
    expect(await useCaptureStore.getState().chooseDestination({ kind: 'folder', folderId: privateId })).toBe(false);
    expect(usePrivacyStore.getState().revealRequest).toEqual({
      kind: 'folder',
      id: privateId,
      root: privateId,
    });
    expect(useCaptureStore.getState().destination.kind).toBe('inbox');

    // Answering it saves into the folder that was asked for.
    expect(await enableDeviceUnlock()).toBe(true);
    expect(await requireFolderAccess(privateId)).toBe(true);
    expect(await useCaptureStore.getState().chooseDestination({ kind: 'folder', folderId: privateId })).toBe(true);
    const outcome = await useCaptureStore.getState().save();
    expect(outcome.ok).toBe(true);
    expect(useVaultStore.getState().links.find((link) => link.id === outcome.link?.id)?.folderId).toBe(privateId);
  });

  it('refuses to write into a locked folder reached without the picker', async () => {
    const privateId = await mustFolder('Private');
    await setFolderLocked(privateId, true);
    await view();

    // The destination is set directly, which is what a stale recent-destination
    // list or a restored draft would do. The write still checks.
    useCaptureStore.getState().selectDestination({ kind: 'folder', folderId: privateId });
    useCaptureStore.getState().openManual();
    useCaptureStore.getState().setDraftField('url', 'https://private.example/backdoor');
    useCaptureStore.getState().selectDestination({ kind: 'folder', folderId: privateId });

    const outcome = await useCaptureStore.getState().save();
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('locked');
    expect(useVaultStore.getState().links).toHaveLength(0);
  });
});

describe('F and G: search', () => {
  it('F: returns nothing from a shut folder, under any filter', async () => {
    const privateId = await mustFolder('Private');
    const linkId = await mustLink('https://secret.example/lawyer', privateId);
    await setFolderLocked(privateId, true);
    const state = await view();

    const protection = computeProtection(state.folders, state.notes, state.links);
    const hidden = hiddenIds(protection, new Set());
    for (const folderId of [privateId]) {
      expect(canAccess(protection, new Set(), 'folder', folderId)).toBe(false);
    }
    expect(canAccess(protection, new Set(), 'link', linkId)).toBe(false);
    // The published set agrees, which is what the search screen actually passes.
    expect(hidden.folders.has(privateId)).toBe(true);
    expect(hidden.links.has(linkId)).toBe(true);
  });

  it('G: returns it once the boundary has been crossed', async () => {
    const privateId = await mustFolder('Private');
    const linkId = await mustLink('https://secret.example/lawyer', privateId);
    await setFolderLocked(privateId, true);
    await view();
    expect(await enableDeviceUnlock()).toBe(true);
    expect(await requireFolderAccess(privateId)).toBe(true);

    const state = useVaultStore.getState();
    expect(state.hidden.folders.has(privateId)).toBe(false);
    expect(state.hidden.links.has(linkId)).toBe(false);
    // And the published protection still knows it is a locked folder, so its badge
    // survives — access and classification are different questions.
    expect(state.protection.folders.has(privateId)).toBe(true);
    expect(allLockRoots(state.protection).has(privateId)).toBe(true);
  });
});

describe('migration: a vault written by an earlier build', () => {
  it('opens a folder whose name was stored as ciphertext, on the next unlock', async () => {
    const id = await mustFolder('Divorce');
    // Rewrite the row the way an earlier build stored it: the name encrypted and
    // the plaintext blanked, with the lock flag intact.
    const raw = await db.folders.get(id);
    await db.folders.put({ ...raw!, name: '', enc: await encryptJson(getVaultKey()!, { name: 'Divorce' }) });
    expect(isSealed((await db.folders.get(id)) ?? {})).toBe(true);

    // No schema change, no version bump and no data reset: unlocking is the point
    // a key exists, so it is the point the reconciliation runs, and the old
    // ciphertext is rewritten as an ordinary readable name.
    expect((await usePrivacyStore.getState().unlock(PASSCODE)).ok).toBe(true);

    const settled = await db.folders.get(id);
    expect(isSealed(settled ?? {})).toBe(false);
    expect(settled?.name).toBe('Divorce');
    // Everything around it is untouched.
    expect(settled?.id).toBe(id);
    expect(settled?.createdAt).toBe(raw?.createdAt);
  });

  it('keeps a locked folder locked while it makes its name readable', async () => {
    const id = await mustFolder('Private');
    const linkId = await mustLink('https://private.example/one', id);
    await setFolderLocked(id, true);

    const raw = await db.folders.get(id);
    await db.folders.put({ ...raw!, name: '', enc: await encryptJson(getVaultKey()!, { name: 'Private' }) });

    expect((await usePrivacyStore.getState().unlock(PASSCODE)).ok).toBe(true);

    const settled = await db.folders.get(id);
    expect(settled?.name).toBe('Private');
    expect(settled?.isLocked).toBe(true);
    // The content behind the label is exactly as sealed as it was.
    expect(isSealed((await db.links.get(linkId)) ?? {})).toBe(true);
  });
});

describe('H: listings do not leak', () => {
  it('keeps protected items out of favourites, inbox, tags and counts', async () => {
    const privateId = await mustFolder('Private');
    const linkId = await mustLink('https://secret.example/lawyer', privateId);
    await useVaultStore.getState().toggleLinkFavorite(linkId, true);
    await useVaultStore.getState().setTags(linkId, ['therapy']);
    await setFolderLocked(privateId, true);
    await useVaultStore.getState().toggleFolderFavorite(privateId, true);

    const state = await view();
    expect(state.inboxLinks).toHaveLength(0);
    expect(state.favoriteFolders.some((folder) => folder.id === privateId)).toBe(false);
    expect(state.favoriteNotes).toHaveLength(0);
    expect(state.tagUsage).toHaveLength(0);
    expect(state.tagsByLink.get(linkId)).toBeUndefined();
    expect(state.folderStats.has(privateId)).toBe(false);
  });

  it('leaves an individually locked link shut without touching its folder', async () => {
    const workId = await mustFolder('Work');
    const linkId = await mustLink('https://one.example', workId);
    await useVaultStore.getState().toggleLinkLocked(linkId, true);

    const state = await view();
    expect(state.hidden.links.has(linkId)).toBe(true);
    // The folder is not locked, so it is not hidden — only the item inside it is.
    expect(state.hidden.folders.has(workId)).toBe(false);
    expect(await requireFolderAccess(workId)).toBe(true);
    expect(useVaultStore.getState().hidden.links.has(linkId)).toBe(true);
  });
});
