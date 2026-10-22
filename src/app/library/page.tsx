'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, FolderPlus, FolderTree, Layers, Lock, Star } from '@/components/ui/icons';
import type { Folder, Note, SavedLink } from '@/db/types';
import { breadcrumbOf, childrenOf, descendantIdsOf, folderPathLabel, orderedLinks } from '@/lib/tree';
import { pluralize } from '@/lib/format';
import { openExternal } from '@/lib/open-external';
import { requireAccess, requireFolderAccess, useFolderAccess } from '@/lib/privacy/access';
import {
  useVaultStore,
  selectFavoriteFolders,
  selectFavoriteNotes,
  selectTagUsage,
} from '@/stores/vault-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { Button } from '@/components/ui/button';
import { EmptyState, ListSurface, PageHeader, Section } from '@/components/ui/page';
import { DropOutZone } from '@/components/ui/drop-out-zone';
import { DropLockZone } from '@/components/ui/drop-lock-zone';
import { InlineTitle } from '@/components/folders/inline-title';
import { linkPrimaryLabel } from '@/lib/link-label';
import { Icon, isIconName } from '@/components/ui/icon';
import { IdentityTile } from '@/components/ui/identity-tile';
import { identityColor } from '@/lib/identity-color';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { mergeOutZones, useDragSort } from '@/hooks/use-drag-sort';

import { LinkRow } from '@/components/links/link-row';
import { LinkActionsSheet } from '@/components/links/link-actions-sheet';
import { FolderRow } from '@/components/folders/folder-row';
import { FolderActionsSheet } from '@/components/folders/folder-actions-sheet';
import { NoteRow } from '@/components/notes/note-row';
import { NoteActionsSheet } from '@/components/notes/note-actions-sheet';

/**
 * Library: the saved content, one level at a time.
 *
 * This is the *structure* surface — folders, favourites and tags — as opposed to
 * Home, which is the *recency* surface (what is waiting to be filed, what just
 * landed). They used to show the same summary twice, which gave nobody a reason
 * to open the second one; now each answers a question the other does not.
 *
 * Unlike the capture sheet (which flattens everything for speed), browsing is
 * deliberately level-by-level: it matches how people think about their own
 * structure, keeps each screen short, and makes the breadcrumb meaningful.
 */
function LibraryView() {
  const router = useRouter();
  const params = useSearchParams();
  const folderParam = params.get('folder');
  const currentId = folderParam && folderParam.length > 0 ? folderParam : null;

  const folders = useVaultStore((state) => state.folders);
  const links = useVaultStore((state) => state.links);
  const folderStats = useVaultStore((state) => state.folderStats);
  const hidden = useVaultStore((state) => state.hidden);
  const favoriteFolders = useVaultStore(selectFavoriteFolders);
  const favoriteNotes = useVaultStore(selectFavoriteNotes);
  const tags = useVaultStore(selectTagUsage);
  const toggleLinkFavorite = useVaultStore((state) => state.toggleLinkFavorite);
  const markLinkOpened = useVaultStore((state) => state.markLinkOpened);

  /**
   * The one authorization check on this route.
   *
   * `?folder=` is reachable from anywhere — a search result, a favourite chip, a
   * restored navigation, a hand-typed URL — so the page cannot assume the user
   * arrived by walking in through the parent. Asking here covers every entrance at
   * once, and covers a folder that was locked *while its own screen was open*,
   * which is the case the previous implementation got wrong.
   */
  const access = useFolderAccess(currentId);

  const [activeLink, setActiveLink] = React.useState<SavedLink | null>(null);
  const [activeFolder, setActiveFolder] = React.useState<Folder | null>(null);
  const [activeNote, setActiveNote] = React.useState<Note | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const trail = React.useMemo(() => (currentId ? breadcrumbOf(folders, currentId) : []), [folders, currentId]);
  const subfolders = React.useMemo(() => childrenOf(folders, currentId), [folders, currentId]);

  const currentFolder = currentId ? folders.find((folder) => folder.id === currentId) ?? null : null;

  /*
   * Dragging a folder to reorder it, scoped to the siblings on this screen.
   *
   * The gesture lives on the row itself: press and hold a folder and it lifts and
   * follows the pointer. The list handed to the hook is exactly the run of
   * children being rendered, and that is what keeps a drag inside its own parent:
   * there is no other list for an index to resolve against, so a folder cannot be
   * dropped into a parent it was never next to. Moving *between* parents stays
   * where it belongs — in the folder's own sheet, as an explicit "Move to another
   * folder".
   *
   * Like every other hook here it runs on every render, above the early return
   * for a locked folder, so the number of hooks never depends on the data.
   */
  const folderDrag = useDragSort({
    ids: subfolders.map((folder) => folder.id),
    noun: 'folder',
    labelOf: (id) => folders.find((folder) => folder.id === id)?.name ?? 'folder',
    /*
     * Resting on a folder turns it into a destination. A quick drag is still a
     * reorder — the gap opens and the row drops into it — and only the hold says
     * "inside this one", which is the distinction the two gestures need to share
     * one finger.
     */
    dropDwellMs: DROP_DWELL_MS,
    onDropOn: (id, targetId) => void moveIntoFolder(id, targetId, 'folder'),
    onDropLock: (id) => void lockDropped('folder', id),
    onReorder: (next) => {
      void useVaultStore
        .getState()
        .setFolderOrder(currentId, next)
        .then((ok) => {
          if (!ok) toast('Could not save that order', { tone: 'danger' });
        });
    },
    // Only inside a folder: at the top level there is nowhere further out.
    ...(currentId
      ? {
          onDropOut: (folderId: string) => {
            const parentId = currentFolder?.parentId ?? null;
            void moveOut(() => useVaultStore.getState().moveFolder(folderId, parentId));
          },
        }
      : {}),
  });

  /*
   * Every link under the current folder, locked ones included.
   *
   * Locked links used to be filtered out here, and that was the bug the user hit:
   * lock one link and it simply disappeared, with no way to tell whether it was
   * hidden or gone. Withheld rows now stay in the list and render as locked rows
   * (their content is already stripped to nothing in the store), so the row keeps
   * its place and a tap is what raises the prompt.
   */
  const folderLinks = React.useMemo(() => {
    const ids = new Set<string>();
    if (currentId) {
      ids.add(currentId);
      for (const id of descendantIdsOf(folders, currentId)) ids.add(id);
    }
    return links.filter((link) =>
      currentId ? link.folderId !== null && ids.has(link.folderId) : true,
    );
  }, [currentId, folders, links]);

  const directLinks = React.useMemo(
    () =>
      currentId
        ? orderedLinks(folderLinks.filter((link) => link.folderId === currentId))
        : folderLinks,
    [currentId, folderLinks],
  );
  const nestedCount = folderLinks.length - directLinks.length;

  /*
   * Links drag the same way folders do — the same hook, the same handle, the same
   * drop-out target — because "I can reorder the folders but not the links" is a
   * rule with no reason behind it.
   */
  const linkDrag = useDragSort({
    ids: directLinks.map((link) => link.id),
    noun: 'link',
    labelOf: (id) => {
      const link = directLinks.find((candidate) => candidate.id === id);
      return link ? linkPrimaryLabel(link).text : 'link';
    },
    dropDwellMs: DROP_DWELL_MS,
    // A link is filed into a folder — never into another link — so its drop
    // targets are the folder rows rendered by the other list. See
    // `externalTargetSelector`.
    dropOnRows: false,
    externalTargetSelector: '[data-drop-target-kind="folder"]',
    onDropOn: (id, targetId) => void moveIntoFolder(id, targetId, 'link'),
    onDropLock: (id) => void lockDropped('link', id),
    onReorder: (next) => {
      void useVaultStore
        .getState()
        .setLinkOrder(currentId, next)
        .then((ok) => {
          if (!ok) toast('Could not save that order', { tone: 'danger' });
        });
    },
    ...(currentId
      ? {
          onDropOut: (linkId: string) => {
            const parentId = currentFolder?.parentId ?? null;
            void moveOut(() => useVaultStore.getState().moveLink(linkId, parentId));
          },
        }
      : {}),
  });

  /*
   * One way out, even though there are two lists.
   *
   * Subfolders and links drag independently, so each hook owns a hit target —
   * but showing both produced two identical "Move out to …" bars stacked above
   * the same screen, and only the one belonging to the list in your hand
   * responded. Merged, the bar is as wide as the screen and answers either drag.
   */
  const outZone = mergeOutZones(folderDrag.getOutZoneProps(), linkDrag.getOutZoneProps());
  /**
   * The way out is a drop target, so it exists only while a drop is in progress.
   *
   * At rest it used to sit above the list saying "Move out to …", which reads as a
   * button that does nothing until something is dragged — a permanent control for
   * a gesture nobody is making. It appears with the lift and disappears with the
   * drop, which is the only moment it can be used.
   */
  const dragging = folderDrag.dragging || linkDrag.dragging;

  /*
   * The lock target follows the thing in your hand: the same tile means "lock"
   * for an open folder and "unlock" for a protected one, so there is one place
   * to drop either, and no second control to read.
   */
  const lockZone = folderDrag.dragging ? folderDrag.getLockZoneProps() : linkDrag.getLockZoneProps();
  const draggedLocked = folderDrag.state.draggingId
    ? (folders.find((folder) => folder.id === folderDrag.state.draggingId)?.isLocked ?? false)
    : linkDrag.state.draggingId
      ? (links.find((link) => link.id === linkDrag.state.draggingId)?.isLocked ?? false)
      : false;

  const openLink = React.useCallback(
    (link: SavedLink) => {
      void markLinkOpened(link.id);
      void openExternal(link.url);
    },
    [markLinkOpened],
  );

  const submitNewFolder = async () => {
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      setCreateError('Give the folder a name.');
      return;
    }
    setBusy(true);
    const result = await useVaultStore.getState().createFolder({ name: trimmed, parentId: currentId });
    setBusy(false);
    if (result.ok) {
      setNewName('');
      setCreating(false);
      setCreateError(null);
      toast(`Created “${result.folder.name}”`, { tone: 'success' });
      return;
    }
    setCreateError(
      result.reason === 'duplicate' ? `“${result.existing.name}” already exists here.` : result.message,
    );
  };

  /** Where "move out" lands: the parent of the folder being viewed, or the top. */
  const parentLabel = currentFolder?.parentId
    ? folderPathLabel(folders, currentFolder.parentId)
    : 'the top level';

  /*
   * Everything saved counts, and every row is present — locked ones included.
   *
   * These used to filter out withheld items, which meant a locked link could be
   * listed in the folder and still be missing from the totals and the favourites
   * above it: the same "it vanished" problem, wearing a smaller hat. The rows
   * gate their own content (a locked link's address and title are already blank
   * in the store), so a filter here only ever removed the *row*.
   */
  const totalLinks = links.length;
  // Like every derived view, favourites summarise what the session may read, so
  // a locked favourite is left to the tree (where it has a locked row) rather
  // than repeated here — see `favoriteFolders` in the vault store.
  const favoriteLinks = links
    .filter((link) => link.isFavorite && !hidden.links.has(link.id))
    .slice(0, 4);
  const folderCount = folders.length;

  /*
   * A protected folder the session has not stepped into renders as a notice, not
   * as a page with its contents blurred out. There is no third state: either the
   * contents may be read, or they may not, and if they may not then nothing of
   * them is drawn — no subfolder names, no links, no counts.
   */
  if (currentId && access.locked) {
    return (
      <>
        <PageHeader>
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-meta text-subtle">
            <Link href="/library" className="tap rounded px-1 py-0.5 active:bg-surface-2">
              Library
            </Link>
            {trail.slice(0, -1).map((folder) => (
              <React.Fragment key={folder.id}>
                <ChevronRight size={12} strokeWidth={2.2} className="shrink-0 text-subtle" aria-hidden />
                <Link
                  href={`/library?folder=${folder.id}`}
                  className="tap max-w-[7rem] truncate rounded px-1 py-0.5 active:bg-surface-2"
                >
                  {folder.name}
                </Link>
              </React.Fragment>
            ))}
          </nav>
          <h1 className="text-display mt-1 truncate font-semibold text-fg">
            {currentFolder?.name ?? 'Protected folder'}
          </h1>
          <p className="mt-0.5 flex items-center gap-1.5 text-meta text-muted">
            <Lock size={12} strokeWidth={2.4} className="text-accent" aria-hidden />
            Protected
          </p>
        </PageHeader>

        <div className="px-4 py-2">
          <div className="card flex flex-col items-start gap-3 px-4 py-5">
            <p className="text-row font-semibold text-fg">This folder is locked</p>
            <p className="text-meta leading-relaxed text-muted">
              Its contents stay unreadable until you unlock it. Nothing else in Stash is affected.
            </p>
            <Button
              variant="accentSoft"
              size="sm"
              onClick={() => void access.request()}
            >
              Unlock to open it
            </Button>
            <Button variant="ghost" size="sm" onClick={() => router.push('/library')}>
              Back to Library
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-meta text-subtle">
              <Link href="/library" className="tap rounded px-1 py-0.5 active:bg-surface-2">
                Library
              </Link>
              {trail.slice(0, -1).map((folder) => (
                <React.Fragment key={folder.id}>
                  <ChevronRight size={12} strokeWidth={2.2} className="shrink-0 text-subtle" aria-hidden />
                  <Link
                    href={`/library?folder=${folder.id}`}
                    className="tap max-w-[7rem] truncate rounded px-1 py-0.5 active:bg-surface-2"
                  >
                    {folder.name}
                  </Link>
                </React.Fragment>
              ))}
            </nav>
            {/*
              The folder's own tile, in the folder's own colour, beside the
              heading.

              An earlier version left it out, on the argument that the row the
              user tapped already showed it. That argument only holds when the
              user arrived by tapping the row — and this screen is reachable from
              a search result, a favourite chip and a restored navigation, where
              the colour is the fastest possible answer to "which of my folders is
              this". It is the same tile the list uses, so the two screens agree.
            */}
            <div className="mt-2 flex items-center gap-2.5">
              {currentFolder ? (
                <IdentityTile color={identityColor(currentFolder.id)} size={34} radius={11}>
                  <Icon
                    name={isIconName(currentFolder.icon) ? currentFolder.icon : 'folder'}
                    size={17}
                    strokeWidth={1.9}
                  />
                </IdentityTile>
              ) : null}
              {/*
                The name is the field.

                Clicking it puts a caret in it — no sheet, no Rename row, no Save
                button — and leaving the field keeps the change. Renaming used to be
                a four-step detour for one word, which is why it is now the same
                gesture Notion uses for a page title.
              */}
              {currentFolder ? (
                <InlineTitle
                  value={currentFolder.name}
                  ariaLabel="Folder name"
                  className="text-display font-semibold text-fg"
                  onCommit={async (next) => {
                    const ok = await useVaultStore
                      .getState()
                      .renameFolder(currentFolder.id, next);
                    if (!ok) toast('Another folder here already uses that name', { tone: 'danger' });
                    return ok;
                  }}
                />
              ) : (
                <h1 className="text-display truncate font-semibold text-fg">All folders</h1>
              )}
              {currentFolder?.isFavorite ? (
                <Star size={15} strokeWidth={2.2} className="shrink-0 fill-warning text-warning" aria-hidden />
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-meta text-muted">
              {currentId
                ? `${pluralize(directLinks.length, 'link')} here${nestedCount > 0 ? ` · ${nestedCount} below` : ''}${subfolders.length > 0 ? ` · ${pluralize(subfolders.length, 'subfolder')}` : ''}`
                : `${pluralize(folderCount, 'folder')} · ${pluralize(totalLinks, 'link')}`}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {currentFolder ? (
              <>
                <button
                  type="button"
                  onClick={() => setActiveFolder(currentFolder)}
                  aria-label="Folder options"
                  className="tap flex size-10 items-center justify-center rounded-full text-subtle active:bg-surface-2"
                >
                  <Layers size={18} strokeWidth={1.9} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    router.push(currentFolder.parentId ? `/library?folder=${currentFolder.parentId}` : '/library')
                  }
                  aria-label="Go up one level"
                  className="tap flex size-10 items-center justify-center rounded-full text-subtle active:bg-surface-2"
                >
                  <ChevronLeft size={19} strokeWidth={2} aria-hidden />
                </button>
              </>
            ) : null}
            <Button
              variant="accentSoft"
              size="icon"
              aria-label="New folder"
              onClick={() => {
                setCreating(true);
                setCreateError(null);
              }}
            >
              <FolderPlus size={19} strokeWidth={2} aria-hidden />
            </Button>
          </div>
        </div>

        {creating ? (
          <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-2.5">
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                autoFocus
                onChange={(event) => {
                  setNewName(event.target.value);
                  setCreateError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitNewFolder();
                  }
                }}
                /*
                 * Just a name. Where the folder will land is not asked for here
                 * and is not part of the field's label either — the line under
                 * the input says so, and the screen the user is looking at
                 * already says it a third time. Spelling the destination into
                 * the placeholder as well is what made the old "New folder
                 * inside X" read as a second, different action.
                 */
                placeholder="Folder name"
                aria-label="New folder name"
                enterKeyHint="done"
                maxLength={80}
              />
              <Button variant="primary" size="icon" aria-label="Create folder" onClick={() => void submitNewFolder()} disabled={busy}>
                <FolderPlus size={19} strokeWidth={2.2} aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Cancel"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                  setCreateError(null);
                }}
              >
                <span className="text-display leading-none">×</span>
              </Button>
            </div>
            {createError ? (
              <p className="px-1 text-meta text-danger">{createError}</p>
            ) : (
              <p className="px-1 text-meta text-subtle">
                Saves into {currentId ? folderPathLabel(folders, currentId) : 'the top level'}.
              </p>
            )}
          </div>
        ) : null}
      </PageHeader>

      {currentId === null && (favoriteFolders.length > 0 || favoriteLinks.length > 0 || favoriteNotes.length > 0) ? (
        <Section title="Favorites" className="mt-2">
          {/* Everything the user starred, in one place — folders, links and notes
              are different kinds of thing but they answer the same question, and
              this is the only screen that answers it. */}
          <ListSurface>
            {favoriteFolders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                subtitle={folderPathLabel(folders, folder.id)}
                onOpen={() => router.push(`/library?folder=${folder.id}`)}
                onShowActions={() => setActiveFolder(folder)}
                onToggleFavorite={() => void useVaultStore.getState().toggleFolderFavorite(folder.id)}
              />
            ))}
            {favoriteLinks.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                context={folderPathLabel(folders, link.folderId)}
                onOpen={openLink}
                onToggleFavorite={() => void toggleLinkFavorite(link.id)}
                onShowActions={() => setActiveLink(link)}
              />
            ))}
            {favoriteNotes.slice(0, 3).map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                onOpen={() => router.push(`/notes?note=${note.id}`)}
                onShowActions={() => setActiveNote(note)}
                onToggleFavorite={() => void useVaultStore.getState().toggleNoteFavorite(note.id)}
              />
            ))}
          </ListSurface>
        </Section>
      ) : null}

      {currentId === null && tags.length > 0 ? (
        <Section title="Tags" action="Search" actionHref="/search">
          <div className="scroll-area flex flex-wrap gap-2 overflow-x-auto px-4">
            {tags.slice(0, 12).map((tag) => (
              <Link
                key={tag.name}
                href={`/search?q=${encodeURIComponent(tag.name)}`}
                className="tap text-body bg-surface-2 flex shrink-0 items-baseline gap-1.5 rounded-full px-3.5 py-2 font-medium text-fg active:bg-surface-3"
              >
                <span>
                  <span className="text-subtle">#</span>
                  {tag.name}
                </span>
                <span className="text-meta text-subtle">{tag.count}</span>
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {/*
        The way out of this folder, above the lists so a row dragged upward meets
        it on the way. It names the destination rather than the gesture: "Move out
        to Development" is a sentence the user can check before they let go.
        Rendered once for both lists — see `outZone` above.
      */}
      {(subfolders.length > 0 || directLinks.length > 0) && (currentId !== null || lockZone) ? (
        <div className="mx-4 mt-1 flex items-stretch gap-2">
          {currentId !== null && outZone ? (
            <DropOutZone
              zoneProps={outZone}
              label={`Move out to ${parentLabel}`}
              visible={dragging}
              className="mx-0 mt-0 min-w-0 flex-1"
            />
          ) : null}
          {lockZone ? (
            <DropLockZone
              zoneProps={lockZone}
              locked={draggedLocked}
              visible={dragging}
              className={currentId === null ? 'ml-auto' : undefined}
            />
          ) : null}
        </div>
      ) : null}

      {subfolders.length > 0 ? (
        <Section title={currentId === null ? 'Folders' : 'Subfolders'}>
          <ListSurface>
            {subfolders.map((folder, index) => {
              const stats = folderStats.get(folder.id);
              return (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  linkCount={(stats?.directLinks ?? 0) + (stats?.nestedLinks ?? 0)}
                  childCount={stats?.directChildren ?? 0}
                  onOpen={() => router.push(`/library?folder=${folder.id}`)}
                  onShowActions={() => setActiveFolder(folder)}
                  onToggleFavorite={() => void useVaultStore.getState().toggleFolderFavorite(folder.id)}
                  dragRow={folderDrag.getRowProps(folder.id, index)}
                  consumeDrag={folderDrag.consumeDrag}
                  // Lit while a *link* is resting on it: the destination can be
                  // rendered by the other list, so its highlight is passed down
                  // rather than applied by the drag that owns the row.
                  dropTarget={linkDrag.state.targetId === folder.id}
                />
              );
            })}
          </ListSurface>
          {/*
           * The one place in the app that names the gesture, and only while the
           * list is long enough for the order to be worth choosing. It is a
           * sentence rather than a permanent toolbar: the grips on the rows are
           * the real signpost, and instructions that outlive their moment are
           * just clutter.
           */}
          {subfolders.length > 1 ? (
            <p className="text-meta px-5 pt-2 text-subtle">
              Drag a row by its handle to reorder it.
            </p>
          ) : null}
        </Section>
      ) : null}

      {/*
       * Links belong to a folder, not to the root of the Library.
       *
       * The root used to list every saved link in the vault under a "Links"
       * heading — a second, worse copy of Home's recent list on the one screen
       * whose job is structure. Inside a folder it is the opposite: those are the
       * links that live *there*, and hiding them is what made a locked one look
       * lost. So the section exists only when the user has stepped into a folder.
       */}
      {currentId !== null && directLinks.length > 0 ? (
        <Section title={nestedCount > 0 ? 'Links here' : 'Links'}>
          <ListSurface>
            {directLinks.map((link, index) => (
              <LinkRow
                key={link.id}
                link={link}
                onOpen={openLink}
                onToggleFavorite={() => void toggleLinkFavorite(link.id)}
                onShowActions={() => setActiveLink(link)}
                dragRow={linkDrag.getRowProps(link.id, index)}
                consumeDrag={linkDrag.consumeDrag}
              />
            ))}
          </ListSurface>
        </Section>
      ) : null}

      {subfolders.length === 0 && directLinks.length === 0 ? (
        <div className="px-4">
          <EmptyState
            icon={<FolderTree size={22} strokeWidth={1.7} />}
            title={currentId ? 'This folder is empty' : 'No folders yet'}
            description={
              currentId
                ? 'Add a subfolder, or share a link from another app and save it here.'
                : 'Create your first folder. Sharing a link into Stash can also create one on the spot.'
            }
            action={
              <Button variant="accentSoft" size="sm" onClick={() => setCreating(true)}>
                <FolderPlus size={16} strokeWidth={2} aria-hidden />
                New folder
              </Button>
            }
          />
        </div>
      ) : null}

      <div className="h-6" />

      <LinkActionsSheet
        key={activeLink?.id ?? 'no-link'}
        link={activeLink}
        onClose={() => setActiveLink(null)}
      />
      <FolderActionsSheet
        key={activeFolder?.id ?? 'no-folder'}
        folder={activeFolder}
        onClose={() => setActiveFolder(null)}
        onDeleted={(folderId) => {
          if (folderId === currentId) router.push('/library');
        }}
      />
      <NoteActionsSheet
        key={activeNote?.id ?? 'no-note'}
        note={activeNote}
        onClose={() => setActiveNote(null)}
        onOpenNote={(id) => router.push(`/notes?note=${id}`)}
      />
    </>
  );
}

export default function LibraryPage() {
  return (
    <React.Suspense fallback={<div className="h-dvh bg-bg" />}>
      <LibraryView />
    </React.Suspense>
  );
}

/**
 * How long a finger has to rest on a folder before the drop means "inside it".
 *
 * Short enough that a deliberate hold feels like the row noticed, long enough
 * that a reorder passing over two rows on its way down never triggers one. The
 * drag itself keeps working throughout: the gap preview is still opening while
 * the clock runs, which is what makes the hold feel like an addition rather than
 * a modal state.
 */
const DROP_DWELL_MS = 550;

/**
 * Put a folder or link inside the folder it was dropped on.
 *
 * Checked against the destination's lock at the *write*, exactly like every other
 * route into a protected folder: a destination that stayed shut leaves the item
 * where it was, rather than filing it somewhere the session cannot read.
 */
async function moveIntoFolder(id: string, targetId: string, kind: 'folder' | 'link'): Promise<void> {
  const vault = useVaultStore.getState();
  const target = vault.folders.find((folder) => folder.id === targetId);
  if (!target) return;

  if (!(await requireFolderAccess(targetId))) {
    toast('That folder stayed locked, so nothing moved.', { tone: 'danger' });
    return;
  }

  if (kind === 'folder') {
    const result = await vault.moveFolder(id, targetId);
    if (!result.ok) {
      toast(result.reason, { tone: 'danger' });
      return;
    }
  } else {
    await vault.moveLink(id, targetId);
  }
  toast(`Moved inside “${target.name}”`, { tone: 'success' });
}

/**
 * Lock or unlock what was dropped on the lock tile.
 *
 * Locking is a decision the user just made with their hand and asks nothing.
 * Unlocking removes protection from something the session could not read, so it
 * proves identity first through the same central check every other unlock uses —
 * passcode or the device prompt — and does nothing when that is refused.
 */
async function lockDropped(kind: 'folder' | 'link', id: string): Promise<void> {
  const vault = useVaultStore.getState();
  const locked =
    kind === 'folder'
      ? (vault.folders.find((folder) => folder.id === id)?.isLocked ?? false)
      : (vault.links.find((link) => link.id === id)?.isLocked ?? false);

  if (!locked) {
    /*
     * Setting the flag is only half of locking: without a keyring there is no
     * key to seal the content with, and the folder would say "locked" over
     * plaintext. `ensureLocking` is the same first-use setup the folder's own
     * Lock row calls, so the gesture cannot create a lock that protects nothing.
     */
    const ready = await usePrivacyStore.getState().ensureLocking();
    if (!ready.ok) {
      toast(ready.message ?? 'Locking is unavailable on this device', { tone: 'danger' });
      return;
    }
    if (kind === 'folder') await vault.toggleFolderLocked(id, true);
    else await vault.toggleLinkLocked(id, true);
    toast(kind === 'folder' ? 'Folder locked' : 'Link locked', { tone: 'success' });
    return;
  }

  if (!(await requireAccess(kind, id))) {
    toast('Stayed locked.', { tone: 'danger' });
    return;
  }

  if (kind === 'folder') await vault.toggleFolderLocked(id, false);
  else await vault.toggleLinkLocked(id, false);
  toast(kind === 'folder' ? 'Folder unlocked' : 'Link unlocked', { tone: 'success' });
}

/**
 * Run a drag-out move and report it.
 *
 * Wrapped so the two drop targets share one piece of feedback: a move that the
 * vault refused — a name clash, a folder that is its own ancestor — has to say so
 * rather than leaving the row where it was with no explanation.
 */
async function moveOut(move: () => Promise<unknown>): Promise<void> {
  const outcome = await move();
  const failed = typeof outcome === 'object' && outcome !== null && 'ok' in outcome && !outcome.ok;
  if (failed) {
    const reason = (outcome as { reason?: string }).reason;
    toast(reason ?? 'Could not move that', { tone: 'danger' });
    return;
  }
  toast('Moved out one level', { tone: 'success' });
}
