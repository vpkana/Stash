'use client';

import { create } from 'zustand';
import { getMeta, setMeta } from '@/db/repos/settings';
import { useVaultStore } from './vault-store';

/**
 * The share guide, and whether it is this install's first run.
 *
 * The guide used to open itself from the Home page whenever the vault had no
 * links, which made it feel random rather than welcome:
 *
 *  1. it lived on Home, so a cold start that landed anywhere else — a share from
 *     another app, a restored route — skipped it entirely, and then it turned up
 *     later, on the first Home visit after everything was deleted;
 *  2. the "seen" flag was written when the sheet was *closed*, so killing the app
 *     while it was open replayed it on the next launch;
 *  3. "new" was measured by an empty vault, so deleting your links made the app
 *     decide you were a new user.
 *
 * So the decision is made here, once per launch, from a record that is written
 * before anything is shown:
 *
 *  - it runs from the app shell, so the route does not matter;
 *  - the flag is written the moment the guide is presented, so it can appear at
 *    most once;
 *  - a vault that already holds links or notes is treated as a returning user —
 *    the upgrade case, and also the case of someone who erased everything and
 *    started over, who does not need the tour again.
 *
 * Opening the guide by hand ("How sharing works", the Home empty-state row) is
 * always allowed and never touches the flag: it is the user asking.
 */
export const SHARE_GUIDE_SEEN_KEY = 'onboarding.shareGuide';

interface OnboardingState {
  guideOpen: boolean;
  /**
   * The in-flight (or finished) first-run decision, so it is asked once per
   * launch however often the shell re-renders. Kept in state rather than in a
   * module variable so a test can put the store back to its starting shape.
   */
  firstRun: Promise<void> | null;
  /** Open the guide because the user asked for it. */
  openGuide: () => void;
  closeGuide: () => void;
  /**
   * The first-run decision, for the app shell to call once the vault is readable.
   */
  startFirstRun: () => Promise<void>;
}

const PRISTINE_ONBOARDING = { guideOpen: false, firstRun: null };

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  ...PRISTINE_ONBOARDING,

  openGuide: () => set({ guideOpen: true }),
  closeGuide: () => set({ guideOpen: false }),

  startFirstRun: () => {
    const running = get().firstRun;
    if (running) return running;

    const run = (async () => {
      // Anything truthy is "already answered": this build writes an object, an
      // earlier one wrote `true`, and a restored backup can carry either.
      const seen = await getMeta<unknown>(SHARE_GUIDE_SEEN_KEY, false);
      if (seen) return;

      const { links, visibleNotes } = useVaultStore.getState();
      const returning = links.length > 0 || visibleNotes.length > 0;

      // Written before it is shown. A user who reads half of it and swipes the
      // app away has seen it; a second automatic showing is the bug, not a
      // second chance — the row on Home and the settings entry both open it.
      await setMeta(SHARE_GUIDE_SEEN_KEY, { firstRunAt: Date.now() });

      if (!returning) set({ guideOpen: true });
    })().catch(() => {
      // A vault that cannot be written to is already reported by `BootGate`.
      // Let a later launch try again rather than latching a failed attempt.
      set({ firstRun: null });
    });

    set({ firstRun: run });
    return run;
  },
}));
