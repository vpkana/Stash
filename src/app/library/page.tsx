'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, FolderPlus, FolderTree, Layers, Lock, Star } from '@/components/ui/icons';
import type { Folder, Note, SavedLink } from '@/db/types';
import { breadcrumbOf, childrenOf, descendantIdsOf, folderPathLabel } from '@/lib/tree';
import { pluralize } from '@/lib/format';
import { openExternal } from '@/lib/open-external';
import { useFolderAccess } from '@/lib/privacy/access';
import {
  useVaultStore,
  selectFavoriteFolders,
  selectFavoriteNotes,
  selectTagUsage,
} from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import { EmptyState, ListSurface, PageHeader, Section } from '@/components/ui/page';
import { Icon, isIconName } from '@/components/ui/icon';
import { IdentityTile } from '@/components/ui/identity-tile';
import { identityColor } from '@/lib/identity-color';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useDragSort } from '@/hooks/use-drag-sort';

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
   * The list handed to the hook is exactly the run of children being rendered,
   * and that is what keeps a drag inside its own parent: there is no other list
   * for an index to resolve against, so a folder cannot be dropped into a parent
   * it was never next to. Moving *between* parents stays where it belongs — in
   * the folder's own sheet, as an explicit "Move to another folder".
   *
   * Like every other hook here it runs on every render, above the early return
   * for a locked folder, so the number of hooks never depends on the data.
   */
  const folderDrag = useDragSort({
    ids: subfolders.map((folder) => folder.id),
    noun: 'folder',
    labelOf: (id) => folders.find((folder) => folder.id === id)?.name ?? 'folder',
    onReorder: (next) => {
      void useVaultStore
        .getState()
        .setFolderOrder(currentId, next)
        .then((ok) => {
          if (!ok) toast('Could not save that order', { tone: 'danger' });
        });
    },
  });

  const folderLinks = React.useMemo(() => {
    const ids = new Set<string>();
    if (currentId) {
      ids.add(currentId);
      for (const id of descendantIdsOf(folders, currentId)) ids.add(id);
    }
    return links
      .filter(
        (link) =>
          !hidden.links.has(link.id) &&
          (currentId ? link.folderId !== null && ids.has(link.folderId) : true),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [currentId, folders, links, hidden]);

  const directLinks = currentId ? folderLinks.filter((link) => link.folderId === currentId) : folderLinks;
  const nestedCount = folderLinks.length - directLinks.length;

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

  const totalLinks = links.filter((link) => !hidden.links.has(link.id)).length;
  const favoriteLinks = links
    .filter((link) => link.isFavorite && !hidden.links.has(link.id))
    .slice(0, 4);
  const visibleFolders = folders.filter((folder) => !hidden.folders.has(folder.id));

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
              <h1 className="text-display truncate font-semibold text-fg">
                {currentFolder?.name ?? 'All folders'}
              </h1>
              {currentFolder?.isFavorite ? (
                <Star size={15} strokeWidth={2.2} className="shrink-0 fill-warning text-warning" aria-hidden />
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-meta text-muted">
              {currentId
                ? `${pluralize(directLinks.length, 'link')} here${nestedCount > 0 ? ` · ${nestedCount} below` : ''}${subfolders.length > 0 ? ` · ${pluralize(subfolders.length, 'subfolder')}` : ''}`
                : `${pluralize(visibleFolders.length, 'folder')} · ${pluralize(totalLinks, 'link')}`}
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
                onOpen={() => openLink(link)}
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

      {subfolders.length > 0 ? (
        <Section title={currentId === null ? 'Folders' : 'Subfolders'}>
          <ListSurface>
            {subfolders.map((folder, index) => {
              const stats = folderStats.get(folder.id);
              const drag = folderDrag.getRowProps(folder.id, index);
              return (
                <div key={folder.id} ref={drag.ref} className={drag.className} data-drop-edge={drag['data-drop-edge']}>
                  <FolderRow
                    folder={folder}
                    linkCount={(stats?.directLinks ?? 0) + (stats?.nestedLinks ?? 0)}
                    childCount={stats?.directChildren ?? 0}
                    onOpen={() => router.push(`/library?folder=${folder.id}`)}
                    onShowActions={() => setActiveFolder(folder)}
                    onToggleFavorite={() => void useVaultStore.getState().toggleFolderFavorite(folder.id)}
                    dragHandle={folderDrag.getHandleProps(folder.id, index)}
                  />
                </div>
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
            <p className="text-meta px-5 pt-2 text-subtle">Drag the grip to reorder.</p>
          ) : null}
        </Section>
      ) : null}

      {directLinks.length > 0 ? (
        <Section title={nestedCount > 0 ? 'Links here' : 'Links'}>
          <ListSurface>
            {directLinks.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                onOpen={() => openLink(link)}
                onToggleFavorite={() => void toggleLinkFavorite(link.id)}
                onShowActions={() => setActiveLink(link)}
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
