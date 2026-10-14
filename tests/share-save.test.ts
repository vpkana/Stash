import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import { forgetVaultKey } from '@/lib/privacy/keyring';
import { setSecureStore } from '@/lib/privacy/secure-store';
import { createCapacitorShareBridge } from '@/lib/share/bridge';
import { parseShare } from '@/lib/share/parse';
import { useCaptureStore } from '@/stores/capture-store';
import { useVaultStore } from '@/stores/vault-store';
import { memorySecureStore, setupDeviceVault } from './privacy-fixtures';

/**
 * A link shared into Stash, all the way to the vault.
 *
 * The Android side of this is thin on purpose — Java hands over the text of an
 * `ACTION_SEND` intent and nothing else — so the half that can actually be
 * wrong lives here: the payload is parsed into a draft, the sheet saves it, and
 * the row is in the vault afterwards.
 *
 * The second case is the one that used to bite: a share arriving while locked
 * content exists. The share is not locked content, so saving one must never wait
 * on the unlock prompt — the capture surface is the whole screen and the device
 * prompt must not be standing in front of it.
 */

const PRISTINE_VAULT = useVaultStore.getState();
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
  useCaptureStore.setState({ ...PRISTINE_CAPTURE }, true);
  setSecureStore(memorySecureStore());
  await useVaultStore.getState().initialize();
});

describe('a share arrives', () => {
  it('becomes a draft and lands in the Inbox', async () => {
    // Exactly the shape the bridge produces: raw text in, normalized share out.
    // The store is handed the normalized one, which is the seam that used to
    // lose the payload entirely -- see the regression test below.
    await useCaptureStore
      .getState()
      .openFromShare(parseShare({ text: 'Binary Search Explained\nhttps://example.com/binary-search' }));

    const draft = useCaptureStore.getState().draft;
    expect(useCaptureStore.getState().unreadable).toBeNull();
    expect(draft?.url).toBe('https://example.com/binary-search');
    expect(draft?.domain).toBe('example.com');

    const outcome = await useCaptureStore.getState().saveToInbox();
    expect(outcome.ok).toBe(true);

    // The row is in the vault, and the Inbox is where it can be seen.
    const links = useVaultStore.getState().links;
    expect(links.map((link) => link.url)).toContain('https://example.com/binary-search');
    expect(useVaultStore.getState().inboxLinks.map((link) => link.url)).toContain(
      'https://example.com/binary-search',
    );

    // And the sheet is closed again, because the capture is finished.
    expect(useCaptureStore.getState().status).toBe('idle');
  });

  it('saves while the vault is locked, without raising the unlock prompt', async () => {
    // A locked vault, set up the way this build sets one up.
    await setupDeviceVault();
    // A cold start: the keyring is on disk, the key is not in memory.
    forgetVaultKey();
    await useVaultStore.getState().refresh();
    expect(useVaultStore.getState().sessionLocked).toBe(true);

    await useCaptureStore.getState().openFromShare(parseShare({ text: 'https://example.com/shared-while-locked' }));
    expect(useCaptureStore.getState().draft?.url).toBe('https://example.com/shared-while-locked');

    // A share is an ordinary link going to an ordinary folder. Nothing about it
    // asks the user to unlock anything, and no prompt is left queued behind it.
    expect(await useCaptureStore.getState().saveToInbox()).toMatchObject({ ok: true });

    const state = useVaultStore.getState();
    expect(state.inboxLinks.map((link) => link.url)).toContain('https://example.com/shared-while-locked');
    // Still locked: saving a link did not open the vault.
    expect(state.sessionLocked).toBe(true);
  });

  it('reads the payload the native plugin hands over', async () => {
    const payload = {
      text: 'Check this out https://example.com/from-android',
      subject: 'Example page',
      sourcePackage: 'com.android.chrome',
      receivedAt: 1_700_000_000_000,
    };

    // The JS seam only: `registerPlugin` is what the native bridge is reached
    // through, and this is the shape the Java side answers with.
    const bridge = createCapacitorShareBridge({
      registerPlugin: <T,>() =>
        ({
          getPendingShare: async () => ({ share: payload }),
          clearPendingShare: async () => undefined,
          shareOut: async () => undefined,
          addListener: async () => ({ remove: async () => undefined }),
        }) as unknown as T,
    });

    const share = await bridge.getPendingShare();
    expect(share?.urls).toEqual(['https://example.com/from-android']);
    expect(share?.sourcePackage).toBe('com.android.chrome');

    // The regression that made every shared link look empty: an already-parsed
    // share must survive a trip through the store untouched. Its text is called
    // `rawText`, so treating it as a raw payload found nothing to save.
    expect(share).not.toBeNull();
    await useCaptureStore.getState().openFromShare(share!);
    expect(useCaptureStore.getState().unreadable).toBeNull();
    expect(useCaptureStore.getState().draft?.url).toBe('https://example.com/from-android');
    expect(useCaptureStore.getState().draft?.appLabel).toBe('Chrome');
    expect(await useCaptureStore.getState().saveToInbox()).toMatchObject({ ok: true });
    expect(useVaultStore.getState().inboxLinks.map((link) => link.url)).toContain(
      'https://example.com/from-android',
    );
  });
});
