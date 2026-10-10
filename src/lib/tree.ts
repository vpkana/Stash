import type { Folder, FolderDeletionImpact, Note, NoteDeletionImpact, SavedLink } from '@/db/types';

/**
 * Tree operations, generic over any parent-linked entity.
 *
 * Folders form a forest with `parentId` and `name`; notes form the same shape
 * with `parentNoteId` and `title`. Rather than duplicate a hundred lines of
 * traversal, the rules live here once and each entity supplies a
 * {@link TreeAccessor} telling the core how to read a node's parent and label.
 *
 * Every function is pure, so the rules are unit-testable without a database and
 * the React layer never walks a tree by hand.
 */

/** How to read the two fields the tree core needs. */
export interface TreeAccessor<T> {
  parentOf: (node: T) => string | null;
  labelOf: (node: T) => string;
}

export type MoveCheck = { ok: true } | { ok: false; reason: string };

export interface FlatNode<T> {
  node: T;
  /** 0 for roots. */
  depth: number;
  /** Full `A → B → C` path, precomputed for display and filtering. */
  path: string;
}

export interface MoveMessages {
  intoSelf: string;
  missingTarget: string;
  intoOwnSubtree: string;
  tooDeep: string;
}

/** Options for the guarded move check. Type comes from the accessor. */
export interface MoveOptions {
  /** Nesting cap. A guard rail against runaway imports, not a product rule. */
  maxDepth: number;
  messages: MoveMessages;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Ascending display order: explicit sortOrder first, then the label. */
export function compareNodes<T>(a: T, b: T, accessor: TreeAccessor<T>): number {
  const orderA = (a as { sortOrder?: number }).sortOrder ?? 0;
  const orderB = (b as { sortOrder?: number }).sortOrder ?? 0;
  if (orderA !== orderB) return orderA - orderB;
  return collator.compare(accessor.labelOf(a), accessor.labelOf(b));
}

/** Children of `parentId` (`null` = roots), ordered for display. */
export function treeChildren<T>(nodes: readonly T[], parentId: string | null, accessor: TreeAccessor<T>): T[] {
  return nodes
    .filter((node) => accessor.parentOf(node) === parentId)
    .sort((a, b) => compareNodes(a, b, accessor));
}

/**
 * Group children by parent in one pass, so rendering a whole tree is O(n)
 * rather than O(n^2) from repeatedly filtering the array.
 */
export function treeGroupByParent<T>(
  nodes: readonly T[],
  accessor: TreeAccessor<T>,
): Map<string | null, T[]> {
  const map = new Map<string | null, T[]>();
  for (const node of nodes) {
    const key = accessor.parentOf(node);
    const bucket = map.get(key);
    if (bucket) bucket.push(node);
    else map.set(key, [node]);
  }
  for (const bucket of map.values()) bucket.sort((a, b) => compareNodes(a, b, accessor));
  return map;
}

/**
 * Ancestors from the root down to (and including) `nodeId`.
 *
 * A corrupted cycle (only reachable through hand-edited or imported data) stops
 * the walk instead of hanging the app.
 */
export function treeBreadcrumb<T>(nodes: readonly T[], nodeId: string, accessor: TreeAccessor<T>): T[] {
  const byId = new Map<string, T>();
  for (const node of nodes) byId.set((node as { id: string }).id, node);

  const chain: T[] = [];
  const guard = new Set<string>();
  let current: string | null = nodeId;
  while (current) {
    if (guard.has(current)) break;
    guard.add(current);
    const node = byId.get(current);
    if (!node) break;
    chain.unshift(node);
    current = accessor.parentOf(node);
  }
  return chain;
}

/** Every descendant id of `nodeId`, excluding the node itself. */
export function treeDescendantIds<T>(nodes: readonly T[], nodeId: string, accessor: TreeAccessor<T>): string[] {
  const childMap = new Map<string | null, T[]>();
  for (const node of nodes) {
    const key = accessor.parentOf(node);
    const bucket = childMap.get(key);
    if (bucket) bucket.push(node);
    else childMap.set(key, [node]);
  }

  const result: string[] = [];
  const queue: string[] = [nodeId];
  const seen = new Set<string>([nodeId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childMap.get(current) ?? []) {
      const id = (child as { id: string }).id;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(id);
      queue.push(id);
    }
  }
  return result;
}

/** True when `candidateId` is `ancestorId` or sits beneath it. */
export function treeIsDescendant<T>(
  nodes: readonly T[],
  candidateId: string,
  ancestorId: string,
  accessor: TreeAccessor<T>,
): boolean {
  if (candidateId === ancestorId) return true;
  return treeDescendantIds(nodes, ancestorId, accessor).includes(candidateId);
}

/** Depth of a node, with roots at 0. */
export function treeDepth<T>(nodes: readonly T[], nodeId: string, accessor: TreeAccessor<T>): number {
  return Math.max(0, treeBreadcrumb(nodes, nodeId, accessor).length - 1);
}

/** The deepest nesting level present anywhere in the forest. */
export function treeMaxDepth<T>(nodes: readonly T[], accessor: TreeAccessor<T>): number {
  let max = 0;
  for (const node of nodes) {
    max = Math.max(max, treeDepth(nodes, (node as { id: string }).id, accessor));
  }
  return max;
}

/** Next free ordering slot among the children of `parentId`. */
export function treeNextSortOrder<T>(nodes: readonly T[], parentId: string | null, accessor: TreeAccessor<T>): number {
  const siblings = nodes.filter((node) => accessor.parentOf(node) === parentId);
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((node) => (node as { sortOrder?: number }).sortOrder ?? 0)) + 1;
}

/**
 * Case-insensitive duplicate-label check within one parent, so users do not end
 * up with two indistinguishable siblings side by side.
 */
export function treeHasSiblingLabel<T>(
  nodes: readonly T[],
  parentId: string | null,
  label: string,
  accessor: TreeAccessor<T>,
  ignoreId?: string,
): boolean {
  const target = label.trim().toLowerCase();
  return nodes.some(
    (node) =>
      accessor.parentOf(node) === parentId &&
      (node as { id: string }).id !== ignoreId &&
      accessor.labelOf(node).trim().toLowerCase() === target,
  );
}

/** Rejects the two moves that would corrupt the forest: self and own subtree. */
export function treeCanMove<T>(
  nodes: readonly T[],
  nodeId: string,
  targetParentId: string | null,
  accessor: TreeAccessor<T>,
  options: MoveOptions,
): MoveCheck {
  if (targetParentId === null) return { ok: true };
  if (targetParentId === nodeId) return { ok: false, reason: options.messages.intoSelf };
  if (!nodes.some((node) => (node as { id: string }).id === targetParentId)) {
    return { ok: false, reason: options.messages.missingTarget };
  }
  if (treeIsDescendant(nodes, targetParentId, nodeId, accessor)) {
    return { ok: false, reason: options.messages.intoOwnSubtree };
  }
  if (treeDepth(nodes, targetParentId, accessor) + 1 >= options.maxDepth) {
    return { ok: false, reason: options.messages.tooDeep };
  }
  return { ok: true };
}

/** Human-readable path, e.g. `Development → React → Tutorials`. */
export function treePathLabel<T>(
  nodes: readonly T[],
  nodeId: string | null,
  accessor: TreeAccessor<T>,
  fallback: string,
  separator = ' → ',
): string {
  if (!nodeId) return fallback;
  const chain = treeBreadcrumb(nodes, nodeId, accessor);
  if (chain.length === 0) return fallback;
  return chain.map(accessor.labelOf).join(separator);
}

/**
 * Depth-first flattening of the forest, preserving sibling order.
 *
 * This is what lets a deeply nested structure stay one tap deep on a phone:
 * instead of drilling down level by level, the picker lists everything with
 * indentation and a filter.
 */
export function treeFlatten<T>(
  nodes: readonly T[],
  accessor: TreeAccessor<T>,
  options: { parentId?: string | null } = {},
): FlatNode<T>[] {
  const grouped = treeGroupByParent(nodes, accessor);
  const rootId = options.parentId ?? null;
  const result: FlatNode<T>[] = [];
  const visited = new Set<string>();

  const walk = (parentId: string | null, depth: number, ancestors: readonly string[]) => {
    for (const node of grouped.get(parentId) ?? []) {
      const id = (node as { id: string }).id;
      if (visited.has(id)) continue; // corrupt cycle: skip the repeat
      visited.add(id);
      const chain = [...ancestors, accessor.labelOf(node)];
      result.push({ node, depth, path: chain.join(' → ') });
      walk(id, depth + 1, chain);
    }
  };

  walk(rootId, 0, []);
  return result;
}

/** Every query token must appear somewhere in the label or the path. */
function matchesTokens(haystack: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const lower = haystack.toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Flattened nodes whose label or path matches every query token. */
export function treeFilterFlat<T>(
  flat: readonly FlatNode<T>[],
  query: string,
  accessor: TreeAccessor<T>,
): FlatNode<T>[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [...flat];
  return flat.filter((entry) => matchesTokens(`${accessor.labelOf(entry.node)} ${entry.path}`, tokens));
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export const folderAccessor: TreeAccessor<Folder> = {
  parentOf: (folder) => folder.parentId,
  labelOf: (folder) => folder.name,
};

export function compareFolders(a: Folder, b: Folder): number {
  return compareNodes(a, b, folderAccessor);
}

export function childrenOf(folders: readonly Folder[], parentId: string | null): Folder[] {
  return treeChildren(folders, parentId, folderAccessor);
}

export function groupByParent(folders: readonly Folder[]): Map<string | null, Folder[]> {
  return treeGroupByParent(folders, folderAccessor);
}

export function findFolder(folders: readonly Folder[], id: string): Folder | undefined {
  return folders.find((folder) => folder.id === id);
}

export function breadcrumbOf(folders: readonly Folder[], folderId: string): Folder[] {
  return treeBreadcrumb(folders, folderId, folderAccessor);
}

export function descendantIdsOf(folders: readonly Folder[], folderId: string): string[] {
  return treeDescendantIds(folders, folderId, folderAccessor);
}

export function isDescendantOf(folders: readonly Folder[], candidateId: string, ancestorId: string): boolean {
  return treeIsDescendant(folders, candidateId, ancestorId, folderAccessor);
}

export function depthOf(folders: readonly Folder[], folderId: string): number {
  return treeDepth(folders, folderId, folderAccessor);
}

export function maxDepth(folders: readonly Folder[]): number {
  return treeMaxDepth(folders, folderAccessor);
}

/**
 * Nesting is unbounded by design, but a runaway import could create a deep
 * chain that is awkward to navigate. This is a guard rail, not a product rule.
 */
export const MAX_FOLDER_DEPTH = 12;

export const FOLDER_MOVE_MESSAGES: MoveMessages = {
  intoSelf: 'A folder cannot be moved inside itself.',
  missingTarget: 'The destination folder no longer exists.',
  intoOwnSubtree: 'A folder cannot be moved inside one of its own subfolders.',
  tooDeep: `Folders can be nested up to ${MAX_FOLDER_DEPTH} levels deep.`,
};

export function canMoveFolder(
  folders: readonly Folder[],
  folderId: string,
  targetParentId: string | null,
): MoveCheck {
  return treeCanMove(folders, folderId, targetParentId, folderAccessor, {
    maxDepth: MAX_FOLDER_DEPTH,
    messages: FOLDER_MOVE_MESSAGES,
  });
}

export function folderPathLabel(folders: readonly Folder[], folderId: string | null, separator = ' → '): string {
  return treePathLabel(folders, folderId, folderAccessor, 'Inbox', separator);
}

/**
 * What deleting a folder would actually cost the user. The UI uses these
 * numbers to explain consequences before anything is removed.
 */
export function folderDeletionImpact(
  folders: readonly Folder[],
  links: readonly SavedLink[],
  folderId: string,
): FolderDeletionImpact | null {
  const folder = findFolder(folders, folderId);
  if (!folder) return null;

  const descendants = descendantIdsOf(folders, folderId);
  const descendantSet = new Set(descendants);
  let directLinkCount = 0;
  let descendantLinkCount = 0;
  for (const link of links) {
    if (link.folderId === folderId) directLinkCount += 1;
    else if (link.folderId && descendantSet.has(link.folderId)) descendantLinkCount += 1;
  }

  return {
    folderId,
    folderName: folder.name,
    childFolderCount: folders.filter((candidate) => candidate.parentId === folderId).length,
    descendantFolderCount: descendants.length,
    directLinkCount,
    descendantLinkCount,
    newParentId: folder.parentId,
  };
}

export function nextSortOrder(folders: readonly Folder[], parentId: string | null): number {
  return treeNextSortOrder(folders, parentId, folderAccessor);
}

/** Sibling ids in display order, useful for drag-free reorder controls. */
export function orderedSiblingIds(folders: readonly Folder[], parentId: string | null): string[] {
  return childrenOf(folders, parentId).map((folder) => folder.id);
}

export function hasSiblingWithName(
  folders: readonly Folder[],
  parentId: string | null,
  name: string,
  ignoreId?: string,
): boolean {
  return treeHasSiblingLabel(folders, parentId, name, folderAccessor, ignoreId);
}

/** Kept for the capture sheet: a folder plus its position in the tree. */
export interface FlatFolder {
  folder: Folder;
  depth: number;
  path: string;
}

export function flattenFolders(
  folders: readonly Folder[],
  options: { parentId?: string | null } = {},
): FlatFolder[] {
  return treeFlatten(folders, folderAccessor, options).map((entry) => ({
    folder: entry.node,
    depth: entry.depth,
    path: entry.path,
  }));
}

/** Flattened folders whose name or path matches every query token. */
export function filterFlatFolders(flat: readonly FlatFolder[], query: string): FlatFolder[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [...flat];
  return flat.filter((entry) => matchesTokens(`${entry.folder.name} ${entry.path}`, tokens));
}

/** Folder ids that are the folder itself plus its ancestors (for lock checks). */
export function selfAndAncestorIds(folders: readonly Folder[], folderId: string): string[] {
  return breadcrumbOf(folders, folderId).map((folder) => folder.id);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const noteAccessor: TreeAccessor<Note> = {
  parentOf: (note) => note.parentNoteId,
  labelOf: (note) => note.title,
};

export function compareNotes(a: Note, b: Note): number {
  return compareNodes(a, b, noteAccessor);
}

export function noteChildren(notes: readonly Note[], parentNoteId: string | null): Note[] {
  return treeChildren(notes, parentNoteId, noteAccessor);
}

export function noteGroupByParent(notes: readonly Note[]): Map<string | null, Note[]> {
  return treeGroupByParent(notes, noteAccessor);
}

export function noteBreadcrumb(notes: readonly Note[], noteId: string): Note[] {
  return treeBreadcrumb(notes, noteId, noteAccessor);
}

export function noteDescendantIds(notes: readonly Note[], noteId: string): string[] {
  return treeDescendantIds(notes, noteId, noteAccessor);
}

export function noteIsDescendant(notes: readonly Note[], candidateId: string, ancestorId: string): boolean {
  return treeIsDescendant(notes, candidateId, ancestorId, noteAccessor);
}

export function noteDepth(notes: readonly Note[], noteId: string): number {
  return treeDepth(notes, noteId, noteAccessor);
}

export function noteMaxDepth(notes: readonly Note[]): number {
  return treeMaxDepth(notes, noteAccessor);
}

/** Notes may nest far deeper than folders: the tree is the product. */
export const MAX_NOTE_DEPTH = 24;

export const NOTE_MOVE_MESSAGES: MoveMessages = {
  intoSelf: 'A note cannot be moved inside itself.',
  missingTarget: 'The destination note no longer exists.',
  intoOwnSubtree: 'A note cannot be moved inside one of its own subnotes.',
  tooDeep: `Notes can be nested up to ${MAX_NOTE_DEPTH} levels deep.`,
};

export function canMoveNote(notes: readonly Note[], noteId: string, targetParentId: string | null): MoveCheck {
  return treeCanMove(notes, noteId, targetParentId, noteAccessor, {
    maxDepth: MAX_NOTE_DEPTH,
    messages: NOTE_MOVE_MESSAGES,
  });
}

export function notePathLabel(notes: readonly Note[], noteId: string | null, separator = ' → '): string {
  return treePathLabel(notes, noteId, noteAccessor, 'Notes', separator);
}

export function nextNoteSortOrder(notes: readonly Note[], parentNoteId: string | null): number {
  return treeNextSortOrder(notes, parentNoteId, noteAccessor);
}

export function flattenNotes(notes: readonly Note[]): FlatNode<Note>[] {
  return treeFlatten(notes, noteAccessor);
}

export function filterFlatNotes(flat: readonly FlatNode<Note>[], query: string): FlatNode<Note>[] {
  return treeFilterFlat(flat, query, noteAccessor);
}

export function hasSiblingNoteWithTitle(
  notes: readonly Note[],
  parentNoteId: string | null,
  title: string,
  ignoreId?: string,
): boolean {
  return treeHasSiblingLabel(notes, parentNoteId, title, noteAccessor, ignoreId);
}

/**
 * What deleting a note would cost.
 *
 * `referencedLinkCount` counts links that would become *unreferenced* rather
 * than deleted: removing a note never removes a saved link, and the
 * confirmation dialog says so explicitly.
 */
export function noteDeletionImpact(
  notes: readonly Note[],
  linksByNote: ReadonlyMap<string, readonly string[]>,
  noteId: string,
): NoteDeletionImpact | null {
  const note = notes.find((candidate) => candidate.id === noteId);
  if (!note) return null;

  const descendants = noteDescendantIds(notes, noteId);
  const referenced = new Set<string>();
  for (const id of [noteId, ...descendants]) {
    for (const linkId of linksByNote.get(id) ?? []) referenced.add(linkId);
  }

  return {
    noteId,
    noteTitle: note.title,
    childNoteCount: notes.filter((candidate) => candidate.parentNoteId === noteId).length,
    descendantNoteCount: descendants.length,
    referencedLinkCount: referenced.size,
    newParentId: note.parentNoteId,
  };
}
