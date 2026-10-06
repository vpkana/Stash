'use client';

import * as React from 'react';
import { isHidden, lockRootOf, type ProtectedKind, type Protection, type HiddenIds } from './protection';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useVaultStore } from '@/stores/vault-store';

/**
 * Folder access, in one place.
 *
 * This module is the *only* thing in the app that answers "may this be read right
 * now", and the only thing that asks for it. Every route into protected content
 * goes through it — opening a folder, a deep link into one, search, recents,
 * favourites, the share destination picker, navigation restoration, a write into
 * a folder — so a screen added later inherits the rule instead of re-implementing
 * it. That is the whole point: the bug this replaces was not that one check was
 * wrong, it was that there were several checks and they disagreed.
 *
 * Two shapes are offered, because the two callers are different:
 *
 *  - {@link useLockState} / {@link useFolderAccess}, for components. Reactive, so
 *    a row flips from locked to readable the moment the vault is re-read;
 *  - {@link canAccessFolder} / {@link requireAccess}, for plain functions such as
 *    the capture store, which have no render pass to hang a subscription on.
 *
 * Both consult the same published sets. Nothing here duplicates a rule.
 */

export interface LockState {
  /** True when this item may not be read until its boundary is crossed. */
  locked: boolean;
  /**
   * The locked node guarding it — a folder id, or the item's own id for an
   * individually locked link or note. `null` when nothing protects it.
   */
  root: string | null;
}

const OPEN: LockState = { locked: false, root: null };

/**
 * The lock state of one item, from an already-computed protection and hidden set.
 *
 * Pure, so it can be unit-tested without React and so both the hook and the
 * non-React helpers are provably the same decision.
 */
export function lockStateFrom(
  protection: Protection,
  hidden: HiddenIds,
  kind: ProtectedKind,
  id: string | null | undefined,
): LockState {
  if (!id) return OPEN;
  if (!isHidden(hidden, kind, id)) return OPEN;
  return { locked: true, root: lockRootOf(protection, kind, id) };
}

/** Reactive lock state of one item. */
export function useLockState(kind: ProtectedKind, id: string | null | undefined): LockState {
  const protection = useVaultStore((state) => state.protection);
  const hidden = useVaultStore((state) => state.hidden);
  return React.useMemo(() => lockStateFrom(protection, hidden, kind, id), [protection, hidden, kind, id]);
}

/** Reactive "may I render this item's content". */
export function useCanAccess(kind: ProtectedKind, id: string | null | undefined): boolean {
  return !useLockState(kind, id).locked;
}

/**
 * The folder case, with the way to open it.
 *
 * `request` resolves `true` once the boundary is open and the vault has been
 * re-read, so a caller can `await` it and then do the thing it was going to do.
 * It resolves `false` when the prompt was refused, and a caller that ignores the
 * answer will find the folder still unreadable — the denial is in the data, not
 * in a flag the caller could skip.
 */
export function useFolderAccess(folderId: string | null | undefined) {
  const state = useLockState('folder', folderId);
  const request = React.useCallback(
    () => (folderId ? requireFolderAccess(folderId) : Promise.resolve(true)),
    [folderId],
  );
  return { ...state, request };
}

/**
 * May this folder's contents be rendered right now?
 *
 * The non-reactive twin of {@link useFolderAccess}. It reads the published sets,
 * which are the same ones every component sees.
 */
export function canAccessFolder(folderId: string | null | undefined): boolean {
  if (!folderId) return true;
  const { protection, hidden } = useVaultStore.getState();
  return !lockStateFrom(protection, hidden, 'folder', folderId).locked;
}

/** Lock state of a folder outside React. */
export function folderLockState(folderId: string | null | undefined): LockState {
  const { protection, hidden } = useVaultStore.getState();
  return lockStateFrom(protection, hidden, 'folder', folderId);
}

/**
 * Ensure one item may be read, prompting if it may not.
 *
 * Returns `true` when the content is readable afterwards — either because nothing
 * protected it, or because the prompt was passed. Returns `false` when it is not,
 * and in that case *nothing is opened*: there is no path from here to a folder
 * that stayed shut.
 *
 * The vault is re-read explicitly on success rather than waiting for the session
 * subscription to do it, because callers use the answer immediately (writing a
 * link into the folder they just unlocked) and a stale hidden set at that moment
 * would be a real bug rather than a render delay.
 */
export async function requireAccess(kind: ProtectedKind, id: string | null | undefined): Promise<boolean> {
  if (!id) return true;

  const before = useVaultStore.getState();
  const state = lockStateFrom(before.protection, before.hidden, kind, id);
  if (!state.locked || !state.root) return true;

  const result = await usePrivacyStore.getState().requestAccess({ kind, id, root: state.root });
  if (!result.ok) return false;

  await useVaultStore.getState().refresh();
  const after = useVaultStore.getState();
  return !lockStateFrom(after.protection, after.hidden, kind, id).locked;
}

/**
 * Ensure a folder may be opened.
 *
 * The named entry point every folder-opening route uses, so the intent reads the
 * same in the Library, in a deep link, in search and in the share destination
 * picker — and so there is one function to look at when asking whether a new
 * surface respects the lock.
 */
export async function requireFolderAccess(folderId: string | null | undefined): Promise<boolean> {
  return requireAccess('folder', folderId);
}
