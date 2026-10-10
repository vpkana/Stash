'use client';

import { create } from 'zustand';
import type {
  Folder,
  FolderDeletionImpact,
  LinkTag,
  Note,
  NoteDeletionImpact,
  NoteLink,
  NoteLinkOrigin,
  SavedLink,
  Tag,
  TrashEntry,
  TrashImpact,
} from '@/db/types';
import { getSnapshot } from '@/db/repos/vault';
import { ensureSeeded } from '@/db/seed';
import { openDatabase } from '@/db';
import {
  createFolder as createFolderRepo,
  deleteFolder as deleteFolderRepo,
  getDeletionImpact,
  moveFolder as moveFolderRepo,
  renameFolder as renameFolderRepo,
  setFolderOrder as setFolderOrderRepo,
  setFolderFavorite,
  setFolderIcon,
  setFolderLocked,
  type CreateFolderResult,
  type DeleteStrategy,
  type MoveResult,
} from '@/db/repos/folders';
import {
  createLink as createLinkRepo,
  deleteLinkPermanently as discardLinkRepo,
  findDuplicates,
  listLinksInFolder,
  moveLink as moveLinkRepo,
  setLinkFavorite,
  setLinkLocked,
  setLinkUnavailable as setLinkUnavailableRepo,
  touchLinkOpened,
  updateLink as updateLinkRepo,
  type CreateLinkInput,
  type DuplicateMatch,
  type UpdateLinkInput,
} from '@/db/repos/links';
import {
  emptyTrash as emptyTrashRepo,
  listTrashGroups,
  purgeBatch as purgeBatchRepo,
  restoreAll as restoreAllRepo,
  restoreBatch as restoreBatchRepo,
  trashLink as trashLinkRepo,
} from '@/db/repos/trash';
import { getRecentFolderIds, pruneRecentFolders, pushRecentFolder, setLastFolderId } from '@/db/repos/settings';
import { listTags, setLinkTags } from '@/db/repos/tags';
import {
  attachLinkToNote as attachLinkToNoteRepo,
  createNote as createNoteRepo,
  createNoteFromLink as createNoteFromLinkRepo,
  deleteNote as deleteNoteRepo,
  detachLinkFromNote as detachLinkFromNoteRepo,
  moveNote as moveNoteRepo,
  getNoteDeletionImpact,
  renameNote as renameNoteRepo,
  reorderNote as reorderNoteRepo,
  setNoteFavorite,
  setNoteLocked,
  updateNote as updateNoteRepo,
  type CreateNoteInput,
  type CreateNoteResult,
  type MoveNoteResult,
  type NoteDeleteStrategy,
} from '@/db/repos/notes';
import { visibleNotes } from '@/lib/notes';
import { noteBreadcrumb, noteChildren, noteDescendantIds } from '@/lib/tree';
import { computeFolderStats, type FolderStats } from '@/lib/folder-stats';
import { isSessionLocked } from '@/lib/privacy/keyring';
import {
  EMPTY_PROTECTION,
  computeProtection,
  hiddenIds,
  emptyHidden,
  redactLink,
  redactNote,
  type HiddenIds,
  type Protection,
} from '@/lib/privacy/protection';
import { usePrivacyStore } from './privacy-store';

/**
 * The in-memory mirror of the vault.
 *
 * Every write goes through this store, which is what makes "IndexedDB is the
 * source of truth" enforceable: the store re-reads after a mutation instead of
 * inventing state that the database does not have. Reads never touch the
 * network, so the whole app is functional in airplane mode.
 */

export type VaultStatus = 'booting' | 'ready' | 'error';

export interface VaultState {
  status: VaultStatus;
  error?: string;
  /**
   * Hidden-while-locked items are already removed from every collection below.
   * A component that renders `state.folders` cannot leak a locked folder, because
   * a locked folder is not in `state.folders`.
   */
  folders: Folder[];
  links: SavedLink[];
  tags: Tag[];
  linkTags: LinkTag[];
  folderStats: Map<string, FolderStats>;
  recentFolderIds: string[];
  /** Every visible note. */
  notes: Note[];
  /**
   * Notes a browsing UI should show.
   *
   * Precomputed once per refresh so no component walks the tree to answer it, and
   * it is currently the same set as `notes`: the archive used to remove items
   * here, and nothing removes items any more. It stays a separate field because
   * "the notes to browse" is a question with a home, not because the two differ
   * today.
   */
  visibleNotes: Note[];
  /** Note-to-link references, the join between the two halves of the vault. */
  noteLinks: NoteLink[];
  /**
   * Which ids are locked, in their own right or through an ancestor, and which
   * locked folder each of them belongs to.
   *
   * Unlike the collections above this is *not* filtered: the UI needs it to show
   * a lock badge on a subtree that inherited a lock, and to explain why an item
   * cannot be unlocked on its own. It contains ids only — never content — and ids
   * of locked items are useless without the key.
   */
  protection: Protection;
  /** Which lock roots are currently open. Mirrors the privacy session. */
  grantedRoots: string[];
  /** Whether the vault key is absent, i.e. sealed rows cannot be decrypted. */
  sessionLocked: boolean;
  /**
   * Ids whose lock boundary has not been crossed. Every listing surface filters
   * or gates on this, and it is the only answer to "may this be shown now".
   *
   * It is empty only when nothing is protected or when every open boundary
   * covers everything — never merely because the vault key happens to be in
   * memory. That distinction is the fix for folders that were locked *after* the
   * app had already been unlocked: the key being present does not make an
   * unopened folder readable.
   */
  hidden: HiddenIds;
  /**
   * False when nothing is protected at all, so the common case costs no work.
   * Used to skip lock plumbing on a vault that has no locked folders.
   */
  hasProtection: boolean;
  /**
   * Live links that have no folder: the Inbox.
   *
   * Derived once per refresh rather than filtered in each screen, because Home,
   * Settings and the Inbox itself all ask the same question and none of them
   * should walk the link list to answer it.
   */
  inboxLinks: SavedLink[];
  /**
   * Derived collections, computed once per refresh.
   *
   * These exist as state rather than as selectors that build an array on the
   * spot, and that is a correctness requirement, not a micro-optimisation. A
   * zustand selector that returns a fresh array on every call breaks React's
   * store subscription: the snapshot never compares equal, so the component
   * re-renders in a loop and React refuses the update. Precomputing gives every
   * read the same reference until the vault actually changes, and it also means
   * no screen has to walk the link list to answer a question Home already asked.
   */
  favoriteFolders: Folder[];
  favoriteNotes: Note[];
  tagUsage: Array<{ name: string; count: number }>;
  /** Tag names per link. A Map so a lookup is O(1) and returns a stable ref. */
  tagsByLink: Map<string, string[]>;
  /**
   * What is in the trash, grouped into the acts that produced it.
   *
   * The trash is deliberately outside the snapshot: trash-aware filtering
   * everywhere else is what makes the rest of the app unable to show a deleted
   * row, and a surface that could see them would undo that. So it is read on
   * demand, by the one screen whose whole purpose is to show them.
   */
  trashGroups: TrashEntry[];
  trashLoaded: boolean;

  initialize: () => Promise<void>;
  refresh: () => Promise<void>;

  createFolder: (input: { name: string; parentId?: string | null; icon?: string }) => Promise<CreateFolderResult>;
  renameFolder: (id: string, name: string) => Promise<boolean>;
  moveFolder: (id: string, targetParentId: string | null) => Promise<MoveResult>;
  /**
   * Persist a new sibling order, as produced by dragging a folder.
   *
   * Takes the whole list rather than a from/to pair, because the order the user
   * left on screen *is* the order: a move expressed as two positions has to be
   * re-derived from a list that may have changed underneath it.
   */
  setFolderOrder: (parentId: string | null, orderedIds: readonly string[]) => Promise<boolean>;
  deleteFolder: (id: string, strategy: DeleteStrategy) => Promise<boolean>;
  toggleFolderFavorite: (id: string, value?: boolean) => Promise<void>;
  setFolderEmojiIcon: (id: string, icon: string | undefined) => Promise<void>;
  toggleFolderLocked: (id: string, value?: boolean) => Promise<void>;
  deletionImpact: (id: string) => Promise<FolderDeletionImpact | null>;

  saveLink: (input: CreateLinkInput) => Promise<SavedLink>;
  updateLink: (id: string, patch: UpdateLinkInput) => Promise<void>;
  moveLink: (id: string, folderId: string | null) => Promise<void>;
  toggleLinkFavorite: (id: string, value?: boolean) => Promise<void>;
  toggleLinkLocked: (id: string, value?: boolean) => Promise<void>;
  /** Moves a link to the trash: recoverable, and what every "Delete" button does. */
  deleteLink: (id: string) => Promise<void>;
  /** Permanently throws away a link created moments ago. The only undo path. */
  discardLink: (id: string) => Promise<void>;
  /** Record by hand that the address no longer works, or that it does again. */
  setLinkUnavailable: (id: string, value: boolean) => Promise<void>;
  markLinkOpened: (id: string) => Promise<void>;
  duplicatesFor: (url: string, excludeId?: string) => Promise<DuplicateMatch[]>;
  linksInFolder: (folderId: string | null, includeNested?: boolean) => Promise<SavedLink[]>;
  setTags: (linkId: string, names: string[]) => Promise<void>;

  // ---- Notes ---------------------------------------------------------------
  createNote: (input: CreateNoteInput) => Promise<CreateNoteResult>;
  /** Autosave path for title + body. Writes only those fields. */
  saveNoteDraft: (id: string, draft: { title: string; content: string }) => Promise<void>;
  renameNote: (id: string, title: string) => Promise<boolean>;
  moveNote: (id: string, targetParentNoteId: string | null) => Promise<MoveNoteResult>;
  reorderNote: (id: string, direction: 'up' | 'down') => Promise<boolean>;
  deleteNote: (id: string, strategy: NoteDeleteStrategy) => Promise<boolean>;
  toggleNoteFavorite: (id: string, value?: boolean) => Promise<void>;
  toggleNoteLocked: (id: string, value?: boolean) => Promise<void>;
  noteDeletionImpact: (id: string) => Promise<NoteDeletionImpact | null>;
  attachLink: (noteId: string, linkId: string, origin?: NoteLinkOrigin) => Promise<boolean>;
  detachLink: (noteId: string, linkId: string) => Promise<void>;
  createNoteFromLink: (linkId: string, parentNoteId?: string | null) => Promise<CreateNoteResult>;

  // ---- Trash ---------------------------------------------------------------
  /** Read the trash. Called by the Trash screen, not by `refresh`. */
  loadTrash: () => Promise<void>;
  restoreTrash: (batch: string) => Promise<TrashImpact>;
  restoreAllTrash: () => Promise<TrashImpact>;
  purgeTrash: (batch: string) => Promise<TrashImpact>;
  emptyTrashNow: () => Promise<TrashImpact>;
}

/**
 * Move live, unarchived links with no folder into the Inbox list.
 *
 * Sorted newest first: the Inbox is a queue of recent arrivals, so the thing you
 * just saved from another app is at the top, which is the whole point of saving
 * without filing.
 */
function inboxOf(links: readonly SavedLink[]): SavedLink[] {
  return links
    .filter((link) => link.folderId === null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * A shared "no tags" value.
 *
 * Returned for every untagged link so the answer is one stable reference rather
 * than a fresh empty array per read — the same reasoning as the derived
 * collections above. It is never written to.
 */
const NO_TAGS: string[] = [];

/** Tag names per link id, each list sorted so the display order is stable. */
function tagNamesByLink(tags: readonly Tag[], linkTags: readonly LinkTag[]): Map<string, string[]> {
  const namesById = new Map(tags.map((tag) => [tag.id, tag.name]));
  const byLink = new Map<string, string[]>();
  for (const row of linkTags) {
    const name = namesById.get(row.tagId);
    if (!name) continue;
    const bucket = byLink.get(row.linkId);
    if (bucket) bucket.push(name);
    else byLink.set(row.linkId, [name]);
  }
  for (const names of byLink.values()) names.sort();
  return byLink;
}

/** Tag names in use, with how many live links carry each, most used first. */
function tagUsageOf(tags: readonly Tag[], linkTags: readonly LinkTag[]): Array<{ name: string; count: number }> {
  const namesById = new Map(tags.map((tag) => [tag.id, tag.name]));
  const counts = new Map<string, number>();
  for (const row of linkTags) {
    const name = namesById.get(row.tagId);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)));
}

/**
 * Read the vault, then apply the lock filter once, centrally.
 *
 * This is the single place "what may be shown right now" is decided. Every
 * screen, picker and count downstream reads the same collections, so a new
 * surface inherits the lock rules instead of having to implement them.
 *
 * **A locked item is still listed; what it loses is everything but its shape.**
 * That is the product decision behind the placeholders: a locked note shows as a
 * locked row rather than vanishing, so tapping it can offer the device prompt —
 * which is how every other app with a screen lock behaves, and the only way
 * "open the locked thing" can be an interaction at all. What makes it safe is
 * that the row on disk is already ciphertext with its fields blanked: there is no
 * plaintext title, URL, name, snippet or note text left to leak, only the fact
 * that something exists there and where it sits.
 *
 * `hidden` is still published, and still means "do not treat this row as
 * content": search does not return it, dedupe does not match it, and pickers do
 * not offer it as a destination.
 */
async function loadEverything() {
  const [snapshot, recentFolderIds] = await Promise.all([getSnapshot(), pruneRecentFolders()]);
  const tags = await listTags();

  const protection = computeProtection(snapshot.folders, snapshot.notes, snapshot.links);
  const sessionLocked = isSessionLocked();
  const grantedRoots = usePrivacyStore.getState().grantedRoots;
  const hidden = hiddenIds(protection, new Set(grantedRoots));
  const hasProtection = protection.folders.size > 0 || protection.notes.size > 0 || protection.links.size > 0;

  /*
   * Withheld rows are *stripped*, not merely flagged.
   *
   * The vault key is one key, so the moment anything is open every sealed row in
   * the store has been decrypted — including the ones behind boundaries the user
   * has not crossed. `redact*` removes the readable fields here, at the single
   * point every screen reads from, which turns "do not show this" from a rule
   * each component has to remember into a fact about the data. A list that forgets
   * its check renders a blank row; it cannot render a URL, because there is none.
   *
   * Folder *names* survive, deliberately: a name is the label on the lock rather
   * than what is behind it, and it is what makes `Private` tappable instead of an
   * anonymous "Locked folder".
   */
  const folders = snapshot.folders;
  const links = snapshot.links.map((link) => (hidden.links.has(link.id) ? redactLink(link) : link));
  const notes = snapshot.notes.map((note) => (hidden.notes.has(note.id) ? redactNote(note) : note));
  const openNotes = visibleNotes(notes);

  /*
   * Every derived collection below is built from the same `hidden` sets.
   *
   * That is the point of doing it here rather than in each screen: a row that a
   * listing shows because it forgot to filter is a leak, and there is exactly one
   * place in the app that decides what a listing may contain. The raw collections
   * above are still published, because the UI has to be able to *show* a locked
   * folder in order to let the user open it — a screen that renders one does so
   * through the central access check, as a locked row, never as content.
   */
  const folderStats = computeFolderStats(folders, links, {
    hiddenFolderIds: hidden.folders,
    hiddenLinkIds: hidden.links,
  });

  // Tag counts are a listing too: "#therapy (3)" discloses the content of three
  // links, so a tag's count covers only links this session may read.
  const visibleLinkTags = snapshot.linkTags.filter((row) => !hidden.links.has(row.linkId));

  return {
    folders,
    links,
    tags,
    linkTags: snapshot.linkTags,
    folderStats,
    recentFolderIds,
    notes,
    visibleNotes: openNotes,
    noteLinks: snapshot.noteLinks,
    protection,
    grantedRoots,
    sessionLocked,
    hidden,
    hasProtection,
    inboxLinks: inboxOf(links.filter((link) => !hidden.links.has(link.id))),
    favoriteFolders: folders.filter((folder) => folder.isFavorite && !hidden.folders.has(folder.id)),
    favoriteNotes: [...openNotes]
      .filter((note) => note.isFavorite && !hidden.notes.has(note.id))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    tagUsage: tagUsageOf(tags, visibleLinkTags),
    tagsByLink: tagNamesByLink(tags, visibleLinkTags),
  };
}

export const useVaultStore = create<VaultState>((set, get) => ({
  status: 'booting',
  folders: [],
  links: [],
  tags: [],
  linkTags: [],
  folderStats: new Map(),
  recentFolderIds: [],
  notes: [],
  visibleNotes: [],
  noteLinks: [],
  protection: EMPTY_PROTECTION,
  grantedRoots: [],
  sessionLocked: false,
  hidden: emptyHidden(),
  hasProtection: false,
  inboxLinks: [],
  favoriteFolders: [],
  favoriteNotes: [],
  tagUsage: [],
  tagsByLink: new Map(),
  trashGroups: [],
  trashLoaded: false,

  initialize: async () => {
    if (get().status === 'ready') return;
    try {
      const opened = await openDatabase();
      if (!opened) throw new Error('IndexedDB is unavailable on this device.');
      await ensureSeeded();
      const data = await loadEverything();
      set({ status: 'ready', error: undefined, ...data });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not open the local vault.',
      });
    }
  },

  refresh: async () => {
    try {
      const data = await loadEverything();
      set({ ...data });
    } catch (error) {
      console.error('[stash] refresh failed', error);
    }
  },

  createFolder: async (input) => {
    const result = await createFolderRepo(input);
    await get().refresh();
    return result;
  },

  renameFolder: async (id, name) => {
    const updated = await renameFolderRepo(id, name);
    if (!updated) return false;
    await get().refresh();
    return true;
  },

  moveFolder: async (id, targetParentId) => {
    const result = await moveFolderRepo(id, targetParentId);
    if (result.ok) await get().refresh();
    return result;
  },

  setFolderOrder: async (parentId, orderedIds) => {
    const ok = await setFolderOrderRepo(parentId, orderedIds);
    if (ok) await get().refresh();
    return ok;
  },

  deleteFolder: async (id, strategy) => {
    const result = await deleteFolderRepo(id, strategy);
    if (!result.ok) return false;
    await get().refresh();
    return true;
  },

  toggleFolderFavorite: async (id, value) => {
    const current = get().folders.find((folder) => folder.id === id);
    const next = value ?? !(current?.isFavorite ?? false);
    // Optimistic: the star should respond to the tap, not to the transaction.
    set({
      folders: get().folders.map((folder) =>
        folder.id === id ? { ...folder, isFavorite: next, updatedAt: Date.now() } : folder,
      ),
    });
    await setFolderFavorite(id, next);
    await get().refresh();
  },

  setFolderEmojiIcon: async (id, icon) => {
    await setFolderIcon(id, icon);
    await get().refresh();
  },

  /**
   * Lock or unlock a folder and everything beneath it.
   *
   * Sealing the subtree happens in the repository, which re-derives it from the
   * flags, so a subfolder or link that inherits this lock becomes ciphertext at
   * rest without the store having to enumerate it.
   */
  toggleFolderLocked: async (id, value) => {
    const current = get().folders.find((folder) => folder.id === id);
    const next = value ?? !(current?.isLocked ?? false);
    await setFolderLocked(id, next);
    await get().refresh();
  },

  deletionImpact: (id) => getDeletionImpact(id),

  saveLink: async (input) => {
    const link = await createLinkRepo(input);
    // Only real folders become remembered destinations; the Inbox is not one.
    if (input.folderId) {
      await pushRecentFolder(input.folderId);
      await setLastFolderId(input.folderId);
    }
    await get().refresh();
    return link;
  },

  updateLink: async (id, patch) => {
    await updateLinkRepo(id, patch);
    await get().refresh();
  },

  moveLink: async (id, folderId) => {
    await moveLinkRepo(id, folderId);
    if (folderId) await pushRecentFolder(folderId);
    await get().refresh();
  },

  toggleLinkFavorite: async (id, value) => {
    const current = get().links.find((link) => link.id === id);
    const next = value ?? !(current?.isFavorite ?? false);
    set({
      links: get().links.map((link) =>
        link.id === id ? { ...link, isFavorite: next, updatedAt: Date.now() } : link,
      ),
    });
    await setLinkFavorite(id, next);
    await get().refresh();
  },

  toggleLinkLocked: async (id, value) => {
    const current = get().links.find((link) => link.id === id);
    const next = value ?? !(current?.isLocked ?? false);
    await setLinkLocked(id, next);
    await get().refresh();
  },

  deleteLink: async (id) => {
    await trashLinkRepo(id);
    await get().refresh();
  },

  /**
   * Throw away a link that was created moments ago, for good.
   *
   * The undo on a fresh capture is not the same act as changing your mind about
   * something you kept: the row is seconds old, nothing references it yet, and
   * sending it to the trash would fill a recovery surface with noise. The only
   * irreversible path in the product, reachable in exactly one place.
   */
  discardLink: async (id) => {
    await discardLinkRepo(id);
    await get().refresh();
  },

  setLinkUnavailable: async (id, value) => {
    const now = Date.now();
    // Optimistic: marking a dead address is a judgement the user just made by
    // hand, and the badge should appear with the tap, not with the write.
    set({
      links: get().links.map((link) =>
        link.id === id
          ? value
            ? { ...link, isUnavailable: true, unavailableAt: now }
            : { ...link, isUnavailable: false }
          : link,
      ),
    });
    set({ inboxLinks: inboxOf(get().links) });
    await setLinkUnavailableRepo(id, value);
    await get().refresh();
  },

  markLinkOpened: async (id) => {
    await touchLinkOpened(id);
    set({
      links: get().links.map((link) => (link.id === id ? { ...link, lastOpenedAt: Date.now() } : link)),
    });
  },

  duplicatesFor: (url, excludeId) => findDuplicates(url, excludeId ? { excludeId } : {}),

  linksInFolder: (folderId, includeNested = false) => listLinksInFolder(folderId, { includeNested }),

  setTags: async (linkId, names) => {
    await setLinkTags(linkId, names);
    await get().refresh();
  },

  // ---- Notes ---------------------------------------------------------------

  createNote: async (input) => {
    const result = await createNoteRepo(input);
    if (result.ok) await get().refresh();
    return result;
  },

  /**
   * The autosave path.
   *
   * Deliberately does not call `refresh()`: re-reading the whole vault on every
   * debounce tick while someone types a paragraph would be wasteful. Only the
   * touched fields are patched in memory, and they are the same fields the write
   * just changed, so the mirror cannot drift.
   */
  saveNoteDraft: async (id, draft) => {
    const updated = await updateNoteRepo(id, { title: draft.title, content: draft.content });
    if (!updated) return;
    set({
      notes: get().notes.map((note) => (note.id === id ? updated : note)),
    });
  },

  renameNote: async (id, title) => {
    const updated = await renameNoteRepo(id, title);
    if (!updated) return false;
    set({ notes: get().notes.map((note) => (note.id === id ? updated : note)) });
    return true;
  },

  moveNote: async (id, targetParentNoteId) => {
    const result = await moveNoteRepo(id, targetParentNoteId);
    if (result.ok) await get().refresh();
    return result;
  },

  reorderNote: async (id, direction) => {
    const ok = await reorderNoteRepo(id, direction);
    if (ok) await get().refresh();
    return ok;
  },

  deleteNote: async (id, strategy) => {
    const result = await deleteNoteRepo(id, strategy);
    if (!result.ok) return false;
    await get().refresh();
    return true;
  },

  toggleNoteFavorite: async (id, value) => {
    const current = get().notes.find((note) => note.id === id);
    const next = value ?? !(current?.isFavorite ?? false);
    // Optimistic: a star should answer the tap, not the transaction.
    set({
      notes: get().notes.map((note) =>
        note.id === id ? { ...note, isFavorite: next, updatedAt: Date.now() } : note,
      ),
    });
    await setNoteFavorite(id, next);
    await get().refresh();
  },

  toggleNoteLocked: async (id, value) => {
    const current = get().notes.find((note) => note.id === id);
    const next = value ?? !(current?.isLocked ?? false);
    await setNoteLocked(id, next);
    await get().refresh();
  },

  noteDeletionImpact: (id) => getNoteDeletionImpact(id),

  attachLink: async (noteId, linkId, origin = 'attached') => {
    const created = await attachLinkToNoteRepo(noteId, linkId, origin);
    if (!created) return false;
    await get().refresh();
    return true;
  },

  detachLink: async (noteId, linkId) => {
    await detachLinkFromNoteRepo(noteId, linkId);
    await get().refresh();
  },

  createNoteFromLink: async (linkId, parentNoteId = null) => {
    const result = await createNoteFromLinkRepo(linkId, { parentNoteId });
    if (result.ok) await get().refresh();
    return result;
  },

  loadTrash: async () => {
    const trashGroups = await listTrashGroups();
    set({ trashGroups, trashLoaded: true });
  },

  restoreTrash: async (batch) => {
    const impact = await restoreBatchRepo(batch);
    // The vault changed underneath the trash, so both sides are re-read: the
    // trash because rows left it, the mirror because restored rows are now
    // ordinary content that every screen must see.
    await get().refresh();
    await get().loadTrash();
    return impact;
  },

  restoreAllTrash: async () => {
    const impact = await restoreAllRepo();
    await get().refresh();
    await get().loadTrash();
    return impact;
  },

  purgeTrash: async (batch) => {
    const impact = await purgeBatchRepo(batch);
    await get().refresh();
    await get().loadTrash();
    return impact;
  },

  emptyTrashNow: async () => {
    const impact = await emptyTrashRepo();
    await get().refresh();
    await get().loadTrash();
    return impact;
  },
}));

// ---------------------------------------------------------------------------
// Selectors
//
// Pure derivations over the mirror. Components use these instead of rebuilding
// the same maps and filters on every render.
// ---------------------------------------------------------------------------

/** Direct subnotes of `parentNoteId` (`null` = root notes), in display order. */
export function selectChildNotes(state: VaultState, parentNoteId: string | null): Note[] {
  return noteChildren(state.visibleNotes, parentNoteId).filter(
    (note) => !state.hidden.notes.has(note.id),
  );
}

/** Ancestors from the root down to the note itself, for breadcrumbs. */
export function selectNoteTrail(state: VaultState, noteId: string): Note[] {
  return noteBreadcrumb(state.notes, noteId);
}

/**
 * How many notes live below this one, so a parent note reads as a container.
 *
 * Withheld descendants are not counted. A count is a listing: "3 notes below" on
 * a note the user can read, where those three are locked, says something the lock
 * was meant to keep quiet.
 */
export function selectDescendantNoteCount(state: VaultState, noteId: string): number {
  return noteDescendantIds(state.notes, noteId).filter((id) => !state.hidden.notes.has(id)).length;
}

/**
 * Saved links referenced by a note, in the order they were attached.
 *
 * Withheld links are dropped rather than shown as a locked row: an attached
 * reference is a *summary* of the note, and a summary that lists "Locked link"
 * rows tells an onlooker how much protected content a note points at. The note
 * itself still opens; it simply does not enumerate what it cannot read.
 */
export function selectLinksForNote(state: VaultState, noteId: string): SavedLink[] {
  const byId = new Map(state.links.map((link) => [link.id, link]));
  return state.noteLinks
    .filter((row) => row.noteId === noteId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => byId.get(row.linkId))
    .filter(
      (link): link is SavedLink => Boolean(link) && !state.hidden.links.has(link!.id),
    );
}

/** Notes that reference a saved link. Powers "Referenced in" on a link. */
export function selectNotesForLink(state: VaultState, linkId: string): Note[] {
  const byId = new Map(state.notes.map((note) => [note.id, note]));
  return state.noteLinks
    .filter((row) => row.linkId === linkId)
    .map((row) => byId.get(row.noteId))
    .filter((note): note is Note => Boolean(note) && !state.hidden.notes.has(note!.id));
}

/**
 * Notes the user edited most recently, newest first.
 *
 * Withheld notes are left out: a "recently edited" shelf is a recency listing,
 * and a recency listing that shows a locked placeholder leaks the timing of
 * private activity. Browsing a locked note is still possible from Notes itself,
 * where the row is reachable on purpose.
 */
export function selectRecentNotes(state: VaultState, limit = 4): Note[] {
  return [...state.visibleNotes]
    .filter((note) => !state.hidden.notes.has(note.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** Note ids referenced by any note, used to badge links in lists. */
export function selectReferencedLinkIds(state: VaultState): Set<string> {
  return new Set(state.noteLinks.map((row) => row.linkId));
}

/**
 * Recent destinations that still exist and may be filed into right now.
 *
 * A withheld folder is skipped rather than returned: this list is what the
 * capture sheet pre-selects and offers first, and offering a destination the
 * session cannot read would put a lock prompt in front of a save the user never
 * asked to unlock anything for.
 */
export function selectRecentDestinations(state: VaultState): Folder[] {
  const byId = new Map(state.folders.map((folder) => [folder.id, folder]));
  return state.recentFolderIds
    .map((id) => byId.get(id))
    .filter((folder): folder is Folder => Boolean(folder) && !state.hidden.folders.has(folder!.id));
}

/**
 * The Inbox, newest first.
 *
 * Already filtered by lock and by live-only at the snapshot boundary, so this
 * needs no further guard: a list that reads it cannot leak anything.
 */
export function selectInboxLinks(state: VaultState): SavedLink[] {
  return state.inboxLinks;
}

/** Links the user marked as no longer working, for a "needs attention" count. */
export function selectUnavailableLinks(state: VaultState): SavedLink[] {
  return state.links.filter(
    (link) => link.isUnavailable && !state.hidden.links.has(link.id),
  );
}

/** Favorite notes, newest first. Precomputed, so the reference is stable. */
export function selectFavoriteNotes(state: VaultState): Note[] {
  return state.favoriteNotes;
}

/** Favorite folders, in the order the library shows them. Precomputed. */
export function selectFavoriteFolders(state: VaultState): Folder[] {
  return state.favoriteFolders;
}

/**
 * Tag names in use, with how many live links carry each one. Precomputed.
 *
 * Returns the same array until the vault changes, which is what lets a screen
 * subscribe to it directly — see the note on the derived collections in
 * {@link VaultState}.
 */
export function selectTagUsage(state: VaultState): Array<{ name: string; count: number }> {
  return state.tagUsage;
}

/** Tag names for one link, alphabetically. A stable lookup, never a new array. */
export function selectTagsForLink(state: VaultState, linkId: string): string[] {
  return state.tagsByLink.get(linkId) ?? NO_TAGS;
}

export { getRecentFolderIds, inboxOf };
