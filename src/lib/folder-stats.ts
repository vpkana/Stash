import type { Folder, SavedLink } from '@/db/types';

/**
 * Per-folder counts, computed in memory.
 *
 * Counts are one of the places a lock can leak: "3 links" on a folder that is
 * meant to be invisible tells an onlooker that something is in there, and how
 * much. So the same hidden sets that drive filtering also drive counting, and a
 * hidden folder gets no entry at all rather than a row of zeroes.
 *
 * Pure, so the counting rules are testable without a database and identical
 * everywhere they are used.
 */
export interface FolderStats {
  /** Direct, non-archived, visible links. */
  directLinks: number;
  /** Non-archived, visible links anywhere below this folder. */
  nestedLinks: number;
  directChildren: number;
}

export interface FolderStatsOptions {
  /** Folders to leave out entirely, and whose links must not be counted. */
  hiddenFolderIds?: ReadonlySet<string>;
  /** Links to leave out of every count. */
  hiddenLinkIds?: ReadonlySet<string>;
}

export function computeFolderStats(
  folders: readonly Folder[],
  links: readonly SavedLink[],
  options: FolderStatsOptions = {},
): Map<string, FolderStats> {
  const hiddenFolders = options.hiddenFolderIds ?? new Set<string>();
  const hiddenLinks = options.hiddenLinkIds ?? new Set<string>();

  const stats = new Map<string, FolderStats>();
  for (const folder of folders) {
    if (hiddenFolders.has(folder.id)) continue;
    stats.set(folder.id, { directLinks: 0, nestedLinks: 0, directChildren: 0 });
  }

  for (const folder of folders) {
    if (hiddenFolders.has(folder.id) || !folder.parentId) continue;
    const parentStats = stats.get(folder.parentId);
    if (parentStats) parentStats.directChildren += 1;
  }

  const parentOf = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  for (const link of links) {
    if (!link.folderId) continue;
    if (hiddenLinks.has(link.id) || hiddenFolders.has(link.folderId)) continue;
    const own = stats.get(link.folderId);
    if (own) own.directLinks += 1;

    // Walk up the chain so nested counts are correct at every visible ancestor.
    // A locked ancestor stops the walk: its count is not ours to increment.
    const guard = new Set<string>();
    let current = parentOf.get(link.folderId) ?? null;
    while (current && !guard.has(current)) {
      guard.add(current);
      if (hiddenFolders.has(current)) break;
      const ancestor = stats.get(current);
      if (ancestor) ancestor.nestedLinks += 1;
      current = parentOf.get(current) ?? null;
    }
  }

  return stats;
}
