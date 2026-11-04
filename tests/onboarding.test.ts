import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import type { SavedLink } from '@/db/types';
import { getMeta } from '@/db/repos/settings';
import { SHARE_GUIDE_SEEN_KEY, useOnboardingStore } from '@/stores/onboarding-store';
import { useVaultStore } from '@/stores/vault-store';

/**
 * The first-run guide, and when it is allowed to appear.
 *
 * It used to be decided on the Home page by "the vault has no links yet", and the
 * seen flag was only written when the sheet was closed. Both halves were wrong in
 * ways a user notices: launching into a share (or any non-Home route) skipped it,
 * deleting every link brought it back, and killing the app mid-guide replayed it.
 *
 * The three rules asserted here:
 *
 *  1. a genuinely new install sees it once, on the first launch;
 *  2. a launch after that never shows it automatically, however empty the vault;
 *  3. an existing vault on an upgraded install is not treated as new.
 */

type GuideState = { guideOpen: boolean; firstRun: Promise<void> | null };

async function reset(firstRun: GuideState['firstRun'] = null): Promise<void> {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
  useOnboardingStore.setState({ guideOpen: false, firstRun });
  useVaultStore.setState({ links: [], visibleNotes: [] });
}

/** Simulates closing and reopening the app: in-memory state gone, vault kept. */
function relaunch(): void {
  useOnboardingStore.setState({ guideOpen: false, firstRun: null });
}

function savedLink(id: string): SavedLink {
  const at = Date.now();
  return {
    id,
    url: 'https://example.com/kept',
    normalizedUrl: 'example.com/kept',
    title: 'A kept page',
    source: 'example.com',
    folderId: null,
    isFavorite: false,
    isLocked: false,
    isPinned: false,
    isArchived: false,
    isTrashed: false,
    createdAt: at,
    updatedAt: at,
  } as SavedLink;
}

describe('first-run share guide', () => {
  beforeEach(async () => {
    await reset();
  });

  it('opens once on a new install and records that it was shown', async () => {
    await useOnboardingStore.getState().startFirstRun();

    expect(useOnboardingStore.getState().guideOpen).toBe(true);
    // Written before it is shown, so a kill mid-guide cannot replay it.
    const seen = await getMeta<unknown>(SHARE_GUIDE_SEEN_KEY, false);
    expect(seen).toBeTruthy();
  });

  it('never opens itself again, even with an empty vault', async () => {
    await useOnboardingStore.getState().startFirstRun();
    useOnboardingStore.getState().closeGuide();

    relaunch();
    await useOnboardingStore.getState().startFirstRun();

    expect(useOnboardingStore.getState().guideOpen).toBe(false);
  });

  it('does not treat an existing vault on an upgraded install as a first run', async () => {
    useVaultStore.setState({ links: [savedLink('link-1')], visibleNotes: [] });

    await useOnboardingStore.getState().startFirstRun();

    expect(useOnboardingStore.getState().guideOpen).toBe(false);
    expect(await getMeta<unknown>(SHARE_GUIDE_SEEN_KEY, false)).toBeTruthy();
  });

  it('still opens when the user asks after the first run', async () => {
    await useOnboardingStore.getState().startFirstRun();
    useOnboardingStore.getState().closeGuide();

    useOnboardingStore.getState().openGuide();
    expect(useOnboardingStore.getState().guideOpen).toBe(true);

    useOnboardingStore.getState().closeGuide();
    expect(useOnboardingStore.getState().guideOpen).toBe(false);
  });

  it('asks the first-run question only once per launch', async () => {
    const first = useOnboardingStore.getState().startFirstRun();
    const again = useOnboardingStore.getState().startFirstRun();
    expect(again).toBe(first);
  });
});
