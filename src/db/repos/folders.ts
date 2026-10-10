import { newId } from '../id';
import { db, type Folder, type FolderDeletionImpact } from '../index';
import {
  canMoveFolder,
  descendantIdsOf,
  folderDeletionImpact,
  hasSiblingWithName,
  nextSortOrder,
} from '@/lib/tree';
import { computeFolderStats, type FolderStats } from '@/lib/folder-stats';
import { isFolderProtected } from '@/lib/privacy/context';
import { getVaultKey } from '@/lib/privacy/keyring';
import { openFolder } from '@/lib/privacy/protection';
import { trashFolder, trashFolderShell } from './trash';
import { reconcileProtection } from '@/lib/privacy/reconcile';

export type { FolderStats };

/**
 * Folder persistence. Every structural rule lives in `@/lib/tree`, so this
 * module only has to load data, validate, and write it back.
 *
 * ## Why the sealing paths are not wrapped in a Dexie transaction
 *
 * Dexie ends a transaction as soon as the callback yields to a promise it does
 * not own, and WebCrypto is exactly that — `crypto.subtle.encrypt` resolves on a
 * platform task outside Dexie's zone. Awaiting it inside `db.transaction`
 * therefore produces `PrematureCommitError: Transaction committed too early`,
 * and the write is lost.
 *
 * The two cannot be mixed, so the crypto happens *around* the database read and
 * write rather than inside them. The cost is that create and rename are no
 * longer a single atomic step; what is bought is that sealing actually happens.
 * A concurrent duplicate folder name is a harmless outcome — the vault tolerates
 * same-named siblings (ordering already falls back to the label) — whereas
 * silently failing to encrypt a locked row is not.
 */

export interface CreateFolderInput {
  name: string;
  parentId?: string | null;
  icon?: string;
}

export type CreateFolderResult =
  | { ok: true; folder: Folder }
  | { ok: false; reason: 'duplicate'; existing: Folder }
  | { ok: false; reason: 'invalid'; message: string };

export async function listFolders(): Promise<Folder[]> {
  return db.folders.toArray();
}

export async function getFolder(id: string): Promise<Folder | undefined> {
  return db.folders.get(id);
}

/** Trim + collapse internal whitespace; names are display-only, not paths. */
export function sanitizeFolderName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export async function createFolder(input: CreateFolderInput): Promise<CreateFolderResult> {
  const name = sanitizeFolderName(input.name);
  if (name.length === 0) return { ok: false, reason: 'invalid', message: 'Enter a folder name.' };

  const parentId = input.parentId ?? null;

  const folders = await db.folders.toArray();
  if (parentId && !folders.some((folder) => folder.id === parentId)) {
    return { ok: false, reason: 'invalid', message: 'The parent folder no longer exists.' };
  }
  // Compared in plaintext so a locked sibling's blanked name cannot make an
  // ordinary duplicate look free.
  const opened = await Promise.all(folders.map((candidate) => openFolder(candidate, getVaultKey())));
  const existing = opened.find(
    (folder) => folder.parentId === parentId && folder.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (existing) return { ok: false, reason: 'duplicate', existing };

  const now = Date.now();
  const folder: Folder = {
    id: newId(),
    parentId,
    name,
    createdAt: now,
    updatedAt: now,
    sortOrder: nextSortOrder(opened, parentId),
    isFavorite: false,
    isLocked: false,
  };
  if (input.icon) folder.icon = input.icon;
  // Folder names are stored in the clear even inside a locked folder: the name is
  // the label on the lock, and the content behind it is what stays sealed. See
  // `reconciliation` in `@/lib/privacy/protection` for why.
  await db.folders.add(folder);
  return { ok: true, folder };
}

export async function renameFolder(id: string, rawName: string): Promise<Folder | null> {
  const name = sanitizeFolderName(rawName);
  if (name.length === 0) return null;
  const raw = await db.folders.get(id);
  if (!raw) return null;
  // Compare against the plaintext names: siblings inside a locked folder have
  // blank names on disk, and a duplicate check against "" would be meaningless.
  const folders = await Promise.all(
    (await db.folders.toArray()).map((candidate) => openFolder(candidate, getVaultKey())),
  );
  const folder = folders.find((candidate) => candidate.id === id) ?? await openFolder(raw, getVaultKey());
  if (hasSiblingWithName(folders, folder.parentId, name, id)) return null;
  const updated: Folder = { ...folder, name, updatedAt: Date.now() };
  // The legacy ciphertext is dropped on the way out: `raw` may be a sealed row
  // from an earlier build, and the rename is the moment its name becomes
  // ordinary data again. Content inside it stays sealed.
  await db.folders.put(updated);
  return updated;
}

export type MoveResult = { ok: true; folder: Folder } | { ok: false; reason: string };

export async function moveFolder(id: string, targetParentId: string | null): Promise<MoveResult> {
  // Names are compared in plaintext, so a folder written by an earlier build
  // (whose name was ciphertext) is opened before the move and stays readable
  // afterwards.
  const raw = await db.folders.toArray();
  const folders = await Promise.all(raw.map((candidate) => openFolder(candidate, getVaultKey())));
  const folder = folders.find((candidate) => candidate.id === id);
  if (!folder) return { ok: false, reason: 'That folder no longer exists.' };

  const check = canMoveFolder(folders, id, targetParentId);
  if (!check.ok) return { ok: false, reason: check.reason };

  if (targetParentId && hasSiblingWithName(folders, targetParentId, folder.name, id)) {
    return { ok: false, reason: 'A folder with that name already exists there.' };
  }

  const updated: Folder = {
    ...folder,
    parentId: targetParentId,
    sortOrder: nextSortOrder(folders, targetParentId),
    updatedAt: Date.now(),
  };
  await db.folders.put(updated);
  const result: MoveResult = { ok: true, folder: updated };

  // The destination may be inside a locked folder (seal the subtree) or outside
  // one (open it again).
  if (result.ok) await reconcileProtection();
  return result;
}

/**
 * Write an explicit sibling order.
 *
 * This is what a drag produces: the whole list, in the order the user left it.
 * Storing positions rather than swaps is what makes the result the same after a
 * restart as it was on screen — every row in the run gets its index written, so
 * there is no half-applied state where two rows claim a position and the tie is
 * broken by a name comparison nobody asked for.
 *
 * Only rows that actually move are written, and `updatedAt` is deliberately left
 * alone: reordering is not editing. A folder list sorted by "recently changed"
 * would otherwise reshuffle itself the moment it was dragged, and "nothing about
 * my structure changed, I just moved it" is the honest record.
 *
 * Ids that do not exist, belong to another parent, or repeat are ignored, so a
 * stale list from a screen that was open across a sync cannot re-home anything.
 */
export async function setFolderOrder(parentId: string | null, orderedIds: readonly string[]): Promise<boolean> {
  return db.transaction('rw', db.folders, async () => {
    const siblings = await db.folders
      .filter((folder) => (folder.parentId ?? null) === (parentId ?? null))
      .toArray();
    const byId = new Map(siblings.map((folder) => [folder.id, folder]));

    const seen = new Set<string>();
    const placed: Array<{ id: string; sortOrder: number }> = [];
    for (const id of orderedIds) {
      const folder = byId.get(id);
      if (!folder || seen.has(id)) continue;
      seen.add(id);
      const index = placed.length;
      if (folder.sortOrder !== index) placed.push({ id, sortOrder: index });
    }

    // Anything the caller did not mention keeps a place after the ones it did,
    // rather than being dragged to the top by omission.
    const trailing = siblings.filter((folder) => !seen.has(folder.id));
    let next = placed.length;
    for (const folder of trailing) {
      if (folder.sortOrder !== next) placed.push({ id: folder.id, sortOrder: next });
      next += 1;
    }

    if (placed.length === 0) return false;
    await Promise.all(placed.map((entry) => db.folders.update(entry.id, { sortOrder: entry.sortOrder })));
    return true;
  });
}

/**
 * Shift a folder one slot up or down among its siblings.
 *
 * Kept for the notes-style step controls and for the keyboard path on the drag
 * handle; the visible "Move up / Move down" menu rows that used to call it are
 * gone, because a drag is what that gesture is.
 */
export async function reorderFolder(id: string, direction: 'up' | 'down'): Promise<boolean> {
  return db.transaction('rw', db.folders, async () => {
    const folders = await db.folders.toArray();
    const folder = folders.find((candidate) => candidate.id === id);
    if (!folder) return false;

    const siblings = folders
      .filter((candidate) => candidate.parentId === folder.parentId)
      .sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.name.localeCompare(b.name)));

    const index = siblings.findIndex((candidate) => candidate.id === id);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= siblings.length) return false;

    const reordered = siblings.slice();
    const [moved] = reordered.splice(index, 1);
    if (!moved) return false;
    reordered.splice(target, 0, moved);

    const now = Date.now();
    await Promise.all(
      reordered.map((candidate, position) =>
        db.folders.update(candidate.id, { sortOrder: position, updatedAt: now }),
      ),
    );
    return true;
  });
}

export async function setFolderFavorite(id: string, isFavorite: boolean): Promise<void> {
  await db.folders.update(id, { isFavorite, updatedAt: Date.now() });
}

/**
 * Lock or unlock one folder.
 *
 * A folder lock is inherited: every subfolder and every link beneath it is
 * protected too, and reconciliation seals the whole subtree. Unlocking releases
 * the subtree the same way. Nothing about the descendants is stored, so a later
 * move cannot leave a record hidden but readable.
 */
export async function setFolderLocked(id: string, isLocked: boolean): Promise<void> {
  await db.folders.update(id, { isLocked, updatedAt: Date.now() });
  await reconcileProtection();
}

/**
 * Whether clearing this folder's flag would actually release it. A subfolder of
 * a locked folder cannot be unlocked on its own.
 */
export async function isFolderLockInherited(id: string): Promise<boolean> {
  const folders = await db.folders.toArray();
  const folder = folders.find((candidate) => candidate.id === id);
  if (!folder || folder.isLocked || !folder.parentId) return false;
  return isFolderProtected(folder.parentId);
}

export async function setFolderIcon(id: string, icon: string | undefined): Promise<void> {
  const raw = await db.folders.get(id);
  if (!raw) return;
  const folder = await openFolder(raw, getVaultKey());
  const updated: Folder = { ...folder, updatedAt: Date.now() };
  if (icon) updated.icon = icon;
  else delete updated.icon;
  await db.folders.put(updated);
}

export async function getDeletionImpact(id: string): Promise<FolderDeletionImpact | null> {
  const [folders, links] = await Promise.all([db.folders.toArray(), db.links.toArray()]);
  return folderDeletionImpact(folders, links, id);
}

export type DeleteStrategy = 'move-contents-up' | 'delete-everything';

export interface DeleteFolderResult {
  ok: boolean;
  removedFolderCount: number;
  /**
   * Rows moved to the trash rather than destroyed. `delete-everything` is
   * recoverable now, so this is a count of what went to the trash, not a count
   * of what was lost.
   */
  removedLinkCount: number;
  /** Links re-homed into the parent folder (move-contents-up). */
  movedLinkCount: number;
}

/**
 * Removing a folder, with the contents accounted for either way.
 *
 * The two strategies mean different things and neither destroys data:
 *
 *  - `move-contents-up` is a *structural* act — the links and subfolders are
 *    re-homed upward, so nothing of theirs needs recovering, and the folder
 *    itself goes to the trash so its name is recoverable too;
 *  - `delete-everything` throws the folder and its contents into the trash as one
 *    batch. It used to be permanent; it is recoverable now, which is the whole
 *    point of having a trash, and the reason a folder can be got back in one
 *    piece rather than folder-by-folder.
 */
export async function deleteFolder(id: string, strategy: DeleteStrategy): Promise<DeleteFolderResult> {
  if (strategy === 'delete-everything') {
    const impact = await trashFolder(id);
    return {
      ok: impact.folders > 0,
      removedFolderCount: impact.folders,
      removedLinkCount: impact.links,
      movedLinkCount: 0,
    };
  }

  const result = await db.transaction('rw', db.folders, db.links, async () => {
    const folders = await db.folders.toArray();
    const folder = folders.find((candidate) => candidate.id === id);
    if (!folder) {
      return { ok: false, removedFolderCount: 0, removedLinkCount: 0, movedLinkCount: 0 };
    }

    const descendants = descendantIdsOf(folders, id);
    const doomedFolders = [id, ...descendants];
    const parentId = folder.parentId;

    // move-contents-up: links in this exact folder are re-homed; all deeper
    // folders are flattened into the parent so nothing is lost. Their links
    // follow them, which keeps the structure meaningful without deleting data.
    const links = await db.links.toArray();
    const movedLinks = links.filter((link) => link.folderId !== null && doomedFolders.includes(link.folderId));
    const now = Date.now();
    await Promise.all(
      movedLinks.map((link) => db.links.update(link.id, { folderId: parentId, updatedAt: now })),
    );

    const remaining = folders.filter((candidate) => !doomedFolders.includes(candidate.id));
    const baseOrder = nextSortOrder(remaining, parentId);
    const childrenInOrder = folders
      .filter((candidate) => descendantOrderRank(doomedFolders, candidate) >= 0)
      .sort((a, b) => descendantOrderRank(doomedFolders, a) - descendantOrderRank(doomedFolders, b));
    await Promise.all(
      childrenInOrder.map((candidate, index) =>
        db.folders.update(candidate.id, {
          parentId,
          sortOrder: baseOrder + index,
          updatedAt: now,
        }),
      ),
    );

    // The folder goes to the trash rather than being deleted, so even its name
    // is recoverable. Restoring it returns an empty folder to the level its
    // contents were re-homed into.
    await trashFolderShell(id);
    return {
      ok: true,
      removedFolderCount: 1,
      removedLinkCount: 0,
      movedLinkCount: movedLinks.length,
    };
  });

  // Flattening a deleted folder's children into its parent can lift them out of
  // a locked region, in which case they must be opened again.
  if (result.ok) await reconcileProtection();
  return result;
}

/** Stable ordering rank of a doomed descendant, used when flattening upward. */
function descendantOrderRank(doomed: readonly string[], candidate: Folder): number {
  const index = doomed.indexOf(candidate.id);
  return index < 0 ? -1 : index;
}

/**
 * Counts for every folder, with no filtering. The UI uses the pure
 * {@link computeFolderStats} directly so it can pass the lock-aware hidden sets;
 * this stays as the unfiltered database read for callers that just want totals.
 */
export async function getFolderStats(): Promise<Map<string, FolderStats>> {
  const [folders, links] = await Promise.all([db.folders.toArray(), db.links.toArray()]);
  return computeFolderStats(folders, links);
}
