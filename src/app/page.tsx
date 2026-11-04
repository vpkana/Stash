'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, FolderPlus, Inbox as InboxIcon, Share2 } from '@/components/ui/icons';
import type { Folder, Note, SavedLink } from '@/db/types';
import { childrenOf, folderPathLabel } from '@/lib/tree';
import { pluralize } from '@/lib/format';
import { openExternal } from '@/lib/open-external';
import {
  useVaultStore,
  selectFavoriteFolders,
  selectFavoriteNotes,
  selectInboxLinks,
  selectTagUsage,
} from '@/stores/vault-store';
import { EmptyState, GroupSurface, ListSurface, PageHeader, PageTitle, Section } from '@/components/ui/page';
import { LogoMark } from '@/components/ui/logo';
import { LinkRow } from '@/components/links/link-row';
import { LinkActionsSheet } from '@/components/links/link-actions-sheet';
import { NoteRow } from '@/components/notes/note-row';
import { NoteActionsSheet } from '@/components/notes/note-actions-sheet';
import { useOnboardingStore } from '@/stores/onboarding-store';
import { FolderRow } from '@/components/folders/folder-row';
import { FolderActionsSheet } from '@/components/folders/folder-actions-sheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useDragSort } from '@/hooks/use-drag-sort';
import { DropLockZone } from '@/components/ui/drop-lock-zone';
import { requireAccess, requireFolderAccess } from '@/lib/privacy/access';
import { usePrivacyStore } from '@/stores/privacy-store';

/**
 * Home combines the library's top-level organization with the inbox and recent
 * items, so the vault has one clear starting point.
 */
export default function HomePage() {
  const router = useRouter();
  const folders = useVaultStore((state) => state.folders);
  const links = useVaultStore((state) => state.links);
  const allNotes = useVaultStore((state) => state.visibleNotes);
  const inbox = useVaultStore(selectInboxLinks);
  const hidden = useVaultStore((state) => state.hidden);
  const folderStats = useVaultStore((state) => state.folderStats);
  const favoriteFolders = useVaultStore(selectFavoriteFolders);
  const favoriteNotes = useVaultStore(selectFavoriteNotes).slice(0, 3);
  const tags = useVaultStore(selectTagUsage);
  const toggleLinkFavorite = useVaultStore((state) => state.toggleLinkFavorite);
  const markLinkOpened = useVaultStore((state) => state.markLinkOpened);

  const [activeLink, setActiveLink] = React.useState<SavedLink | null>(null);
  const [activeNote, setActiveNote] = React.useState<Note | null>(null);
  const [activeFolder, setActiveFolder] = React.useState<Folder | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const openGuide = useOnboardingStore((state) => state.openGuide);

  const rootFolders = React.useMemo(() => childrenOf(folders, null), [folders]);
  const folderDrag = useDragSort({
    ids: rootFolders.map((folder) => folder.id),
    noun: 'folder',
    labelOf: (id) => folders.find((folder) => folder.id === id)?.name ?? 'folder',
    dropDwellMs: 550,
    onDropOn: (id, targetId) => void moveFolderIntoFolder(id, targetId),
    onDropLock: (id) => void lockFolderDropped(id),
    onReorder: (next) => {
      void useVaultStore
        .getState()
        .setFolderOrder(null, next)
        .then((ok) => {
          if (!ok) toast('Could not save that order', { tone: 'danger' });
        });
    },
  });
  /**
   * What just landed, newest first.
   *
   * Locked links are *in* this list and render as locked rows. They used to be
   * filtered out here on the argument that this section has no query to answer —
   * but recency is not content: the timestamp survives locking, and a saved link
   * missing from "what you saved lately" is the same "it vanished" problem in a
   * quieter form. The row gives up its address and title (the store redacted
   * them) and keeps everything else.
   */
  const recent = React.useMemo(() => collapseDuplicateLinks([...links].sort((a, b) => b.createdAt - a.createdAt)).slice(0, 5), [links]);

  /**
   * The two things a user actually wants to see beside "what just landed":
   * what they marked to keep, and what they wrote. Both are deliberately short
   * lists — Home is a summary, and every one of these has a screen of its own
   * one tap away.
   */
  const favoriteLinks = React.useMemo(
    () =>
      collapseDuplicateLinks(
        [...links].filter((link) => link.isFavorite).sort((a, b) => b.updatedAt - a.updatedAt),
      ).slice(0, 4),
    [links],
  );
  const recentNotes = React.useMemo(
    () => [...allNotes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4),
    [allNotes],
  );
  const noteChildCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of allNotes) {
      if (!note.parentNoteId) continue;
      counts.set(note.parentNoteId, (counts.get(note.parentNoteId) ?? 0) + 1);
    }
    return counts;
  }, [allNotes]);
  const openNote = React.useCallback((id: string) => router.push(`/notes?note=${id}`), [router]);

  const isEmpty = links.length === 0 && folders.length === 0 && allNotes.length === 0;

  const submitNewFolder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      setCreateError('Give the folder a name.');
      return;
    }
    setBusy(true);
    const result = await useVaultStore.getState().createFolder({ name, parentId: null });
    setBusy(false);
    if (!result.ok) {
      setCreateError(result.reason === 'duplicate' ? `“${result.existing.name}” already exists.` : result.message);
      return;
    }
    setNewName('');
    setCreateError(null);
    setCreating(false);
    toast(`Created “${result.folder.name}”`, { tone: 'success' });
  };

  const openLink = React.useCallback(
    (link: SavedLink) => {
      void markLinkOpened(link.id);
      void openExternal(link.url);
    },
    [markLinkOpened],
  );

  return (
    <>
      <PageHeader>
        <PageTitle
          subtitle={
            isEmpty
              ? 'Nothing saved yet'
              : `${pluralize(links.length, 'link')} saved · ${pluralize(folders.length, 'folder')}`
          }
        >
          Your vault
        </PageTitle>
      </PageHeader>

      <Section title="Inbox" action="Open" actionHref="/inbox" className="mt-4">
        <Link href="/inbox" className="tap card mx-4 flex items-center gap-3 px-4 py-3.5 active:bg-surface-2">
          <span className="tile bg-accent-soft text-accent">
            <InboxIcon size={19} strokeWidth={1.9} aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-row block font-semibold text-fg">
              {inbox.length > 0 ? `${pluralize(inbox.length, 'link')} waiting to be filed` : 'Inbox'}
            </span>
            <span className="text-meta mt-0.5 block truncate text-muted">
              {inbox.length > 0
                ? inbox
                    .slice(0, 2)
                    .map(
                      (link) =>
                        link.title?.trim() ||
                        link.source ||
                        link.url ||
                        (hidden.links.has(link.id) ? 'Locked link' : 'Untitled link'),
                    )
                    .join(' · ') + (inbox.length > 2 ? ` +${inbox.length - 2} more` : '')
                : 'No links waiting to be filed'}
            </span>
          </span>
          <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
        </Link>
      </Section>

      {favoriteFolders.length > 0 || favoriteLinks.length > 0 || favoriteNotes.length > 0 ? (
        <Section title="Favorites">
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
            {favoriteNotes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                childCount={noteChildCounts.get(note.id) ?? 0}
                onOpen={() => openNote(note.id)}
                onShowActions={() => setActiveNote(note)}
                onToggleFavorite={() => void useVaultStore.getState().toggleNoteFavorite(note.id)}
              />
            ))}
          </ListSurface>
        </Section>
      ) : null}

      {tags.length > 0 ? (
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

      {folderDrag.dragging ? (
        <div className="mx-4 mt-1 flex justify-end">
          <DropLockZone
            zoneProps={folderDrag.getLockZoneProps()}
            locked={folderDrag.state.draggingId
              ? (folders.find((folder) => folder.id === folderDrag.state.draggingId)?.isLocked ?? false)
              : false}
            visible
          />
        </div>
      ) : null}

      <Section title="Folders" onAction={() => setCreating((value) => !value)} action={creating ? 'Cancel' : 'New'}>
        {rootFolders.length > 0 ? (
          <ListSurface>
            {rootFolders.map((folder, index) => {
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
                  dropTarget={folderDrag.state.targetId === folder.id}
                />
              );
            })}
          </ListSurface>
        ) : (
          <p className="px-4 py-2 text-meta text-subtle">No folders yet.</p>
        )}
        {rootFolders.length > 1 ? (
          <p className="text-meta px-5 pt-2 text-subtle">Drag to reorder, or hold over a folder to move inside.</p>
        ) : null}
        {creating ? (
          <form onSubmit={(event) => void submitNewFolder(event)} className="card mx-4 mt-2 flex flex-col gap-2 p-3">
            <div className="flex gap-2">
              <Input
                autoFocus
                value={newName}
                onChange={(event) => {
                  setNewName(event.target.value);
                  setCreateError(null);
                }}
                placeholder="Folder name"
                aria-label="New folder name"
                maxLength={80}
              />
              <Button type="submit" variant="primary" size="icon" aria-label="Create folder" disabled={busy}>
                <FolderPlus size={19} strokeWidth={2.2} aria-hidden />
              </Button>
            </div>
            {createError ? <p className="text-meta text-danger">{createError}</p> : null}
          </form>
        ) : null}
      </Section>

      <Section title="Recent" action="See all" actionHref="/search">
        {recent.length > 0 ? (
          <ListSurface>
            {recent.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                context={folderNameFor(folders, link.folderId)}
                onOpen={openLink}
                onToggleFavorite={() => void toggleLinkFavorite(link.id)}
                onShowActions={() => setActiveLink(link)}
              />
            ))}
          </ListSurface>
        ) : (
          <p className="text-body px-4 py-4 text-muted">Nothing here yet.</p>
        )}
      </Section>

      {recentNotes.length > 0 ? (
        <Section title="Notes" action="All notes" actionHref="/notes">
          <ListSurface>
            {recentNotes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                childCount={noteChildCounts.get(note.id) ?? 0}
                onOpen={() => openNote(note.id)}
                onShowActions={() => setActiveNote(note)}
                onToggleFavorite={() => void useVaultStore.getState().toggleNoteFavorite(note.id)}
              />
            ))}
          </ListSurface>
        </Section>
      ) : null}

      {isEmpty ? (
        <>
          <EmptyState
            icon={<LogoMark size={22} />}
            title="Nothing saved yet"
            description="Save a link from any app, or add one with the + button. Your vault stays on this device."
          />
          <GroupSurface className="mt-2">
            <button
              type="button"
              onClick={openGuide}
              className="tap flex w-full items-start gap-3 px-4 py-3.5 text-left active:bg-surface-2"
            >
              <span className="tile bg-accent-soft text-accent">
                <Share2 size={19} strokeWidth={1.9} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-row block font-medium text-fg">Save a link from any app</span>
                <span className="text-meta mt-0.5 block leading-relaxed text-muted">
                  Tap Share and choose Stash.
                </span>
              </span>
              <ChevronRight size={16} strokeWidth={2} className="mt-1 shrink-0 text-subtle" aria-hidden />
            </button>
          </GroupSurface>
        </>
      ) : null}

      <LinkActionsSheet
        key={activeLink?.id ?? 'no-link'}
        link={activeLink}
        onClose={() => setActiveLink(null)}
      />
      <NoteActionsSheet
        key={activeNote?.id ?? 'no-note'}
        note={activeNote}
        onClose={() => setActiveNote(null)}
        onOpenNote={openNote}
      />
      <FolderActionsSheet
        key={activeFolder?.id ?? 'no-folder'}
        folder={activeFolder}
        onClose={() => setActiveFolder(null)}
      />
    </>
  );
}

async function moveFolderIntoFolder(folderId: string, targetId: string): Promise<void> {
  const vault = useVaultStore.getState();
  const target = vault.folders.find((folder) => folder.id === targetId);
  if (!target) return;
  if (!(await requireFolderAccess(targetId))) {
    toast('That folder stayed locked, so nothing moved.', { tone: 'danger' });
    return;
  }
  const result = await vault.moveFolder(folderId, targetId);
  if (!result.ok) {
    toast(result.reason, { tone: 'danger' });
    return;
  }
  toast(`Moved inside “${target.name}”`, { tone: 'success' });
}

async function lockFolderDropped(folderId: string): Promise<void> {
  const vault = useVaultStore.getState();
  const folder = vault.folders.find((candidate) => candidate.id === folderId);
  if (!folder) return;

  if (!folder.isLocked) {
    const ready = await usePrivacyStore.getState().ensureLocking();
    if (!ready.ok) {
      toast(ready.message ?? 'Locking is unavailable on this device', { tone: 'danger' });
      return;
    }
    await vault.toggleFolderLocked(folderId, true);
    toast('Folder locked', { tone: 'success' });
    return;
  }

  if (!(await requireAccess('folder', folderId))) {
    toast('Stayed locked.', { tone: 'danger' });
    return;
  }
  await vault.toggleFolderLocked(folderId, false);
  toast('Folder unlocked', { tone: 'success' });
}

/**
 * One row per address per folder, keeping the first in the order given.
 *
 * Saving the same page twice into the same place is allowed — the capture sheet
 * warns first, and "save anyway" is a real answer — but two identical rows in a
 * short list read as a bug rather than as two decisions, because the list is a
 * summary of what is here, not a log of every write. The caller sorts first and
 * the newest wins. The same address filed somewhere *else* is a different fact,
 * and stays where it is.
 */
function collapseDuplicateLinks(links: readonly SavedLink[]): SavedLink[] {
  const seen = new Set<string>();
  const unique: SavedLink[] = [];
  for (const link of links) {
    const key = `${link.folderId ?? 'inbox'}::${(link.normalizedUrl || link.url).trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(link);
  }
  return unique;
}

/** Where a recent link sits, shown as context on a row that is out of place. */
function folderNameFor(folders: readonly Folder[], folderId: string | null): string | undefined {
  if (!folderId) return undefined;
  return folders.find((folder) => folder.id === folderId)?.name;
}
