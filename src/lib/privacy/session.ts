import type { RelockPolicy } from '@/db/types';

/**
 * How long an unlocked session lasts.
 *
 * Unlocking is a **session**, not a setting. It ends when the user moves to
 * another tab, and it ends the moment Stash stops being the visible app — which
 * is what "lock the phone" looks like from inside the app. There is nothing to
 * configure, because the only honest choice is the short one: a key that is still
 * in memory an hour later is a key that was never really protected.
 *
 * Both rules are pure functions of two timestamps, so the whole timing model is
 * testable without a device while the React layer only has to report what
 * happened — a navigation, `visibilitychange`, `appStateChange`.
 *
 * The `RelockPolicy` list and its helpers below are read but no longer offered:
 * they exist so a vault written by an earlier build (and the `relockPolicy` field
 * its backups carry) still validates, and so `shouldRelock` keeps its documented
 * meaning for those files. Nothing in the app sets a policy any more.
 */
export interface RelockPolicyOption {
  id: RelockPolicy;
  label: string;
  description: string;
  /** How long the app may stay backgrounded before the key is dropped. */
  delayMs: number;
}

export const RELOCK_POLICIES: ReadonlyArray<RelockPolicyOption> = [
  {
    id: 'immediate',
    label: 'Immediately',
    description: 'The moment Stash leaves the screen.',
    delayMs: 0,
  },
  {
    id: '1m',
    label: 'After 1 minute',
    description: 'A quick app switch stays unlocked.',
    delayMs: 60_000,
  },
  {
    id: '5m',
    label: 'After 5 minutes',
    description: 'Comfortable for copying links between apps.',
    delayMs: 300_000,
  },
  {
    id: '15m',
    label: 'After 15 minutes',
    description: 'Longest window. Least private.',
    delayMs: 900_000,
  },
];

export function isRelockPolicy(value: unknown): value is RelockPolicy {
  return typeof value === 'string' && RELOCK_POLICIES.some((option) => option.id === value);
}

export function relockDelayMs(policy: RelockPolicy): number {
  return RELOCK_POLICIES.find((option) => option.id === policy)?.delayMs ?? 0;
}

export function relockPolicyLabel(policy: RelockPolicy): string {
  return RELOCK_POLICIES.find((option) => option.id === policy)?.label ?? 'Immediately';
}

/**
 * Whether the unlock prompt is on screen.
 *
 * There is exactly one reason it ever is: the user tried to cross a lock boundary
 * and the system prompt did not answer for it. Stash has no password of its own
 * and no lock screen, so a cold start, a tab change, the app coming back to the
 * foreground and a share arriving all leave this `false` — the app is simply
 * opened, and protected content stays unreadable inside it.
 *
 * Note what is **not** a condition: whether the vault key happens to be in memory.
 * Access is per folder, so being inside one open boundary says nothing about the
 * next one; a refusal on *this* boundary has to be visible even when the key is
 * present, or the second locked folder the user taps would silently do nothing.
 *
 * Separate from the component that draws it so the rule can be pinned by a test
 * rather than by reading a conditional: "the app never asks for a password to
 * open" is the requirement, and this is the whole of it.
 */
export function shouldPromptForReveal(state: {
  ready: boolean;
  keyringPresent: boolean;
  hasRevealRequest: boolean;
}): boolean {
  return state.ready && state.keyringPresent && state.hasRevealRequest;
}

/**
 * How long after an unlock a tab change is read as part of the same act.
 *
 * Opening a locked folder from Home is *one* intention that happens to move the
 * user between tabs: the unlock answers, then the folder opens. Without this
 * beat, the navigation that followed the unlock would immediately re-lock the
 * thing that was just opened, which is the same as never having unlocked it.
 *
 * It is deliberately short. It is not a grace period for the session — the key is
 * dropped on the next tab change either way — only a rule that the navigation
 * caused by a reveal does not count as leaving.
 */
export const UNLOCK_NAVIGATION_GRACE_MS = 2_000;

/**
 * Whether moving to another tab ends the session.
 *
 * `unlockedAt === null` means nothing is unlocked, so there is nothing to end.
 * A clock that appears to move backwards is treated as expired rather than as
 * safe, for the same reason `shouldRelock` does: elapsed time cannot be reasoned
 * about, and locking costs one unlock while not locking costs the feature.
 */
export function shouldLockOnTabChange(unlockedAt: number | null, now: number): boolean {
  if (unlockedAt === null) return false;
  if (now < unlockedAt) return true;
  return now - unlockedAt >= UNLOCK_NAVIGATION_GRACE_MS;
}

/**
 * Whether the key must be dropped, given when the app was backgrounded.
 *
 * `backgroundedAt === null` means the app never left the foreground, so there is
 * nothing to expire. A clock that appears to move backwards (a manual device
 * time change, or a suspend) is treated as expired rather than as safe: `now`
 * before `backgroundedAt` means we cannot reason about elapsed time, and the
 * conservative answer is to lock.
 */
export function shouldRelock(policy: RelockPolicy, backgroundedAt: number | null, now: number): boolean {
  if (backgroundedAt === null) return false;
  if (now < backgroundedAt) return true;
  return now - backgroundedAt >= relockDelayMs(policy);
}

/**
 * Whether the key should be dropped the instant the app is backgrounded.
 *
 * Returned separately from {@link shouldRelock} because `immediate` must not wait
 * for the app to come back: on Android the process may be killed while
 * backgrounded, and "locked on resume" would then be a promise the app was never
 * alive to keep. Locking at background time makes the guarantee hold even if it
 * never resumes.
 */
export function shouldLockOnBackground(policy: RelockPolicy): boolean {
  return relockDelayMs(policy) === 0;
}
