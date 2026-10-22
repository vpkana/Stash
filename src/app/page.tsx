'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, FolderPlus, Inbox as InboxIcon, Share2 } from '@/components/ui/icons';
import type { Folder, Note, SavedLink } from '@/db/types';
import { pluralize } from '@/lib/format';
import { openExternal } from '@/lib/open-external';
import { useVaultStore, selectInboxLinks } from '@/stores/vault-store';
import { EmptyState, GroupSurface, ListSurface, PageHeader, PageTitle, Section } from '@/components/ui/page';
import { LogoMark } from '@/components/ui/logo';
import { LinkRow } from '@/components/links/link-row';
import { LinkActionsSheet } from '@/components/links/link-actions-sheet';
import { NoteRow } from '@/components/notes/note-row';
import { NoteActionsSheet } from '@/components/notes/note-actions-sheet';
import { ShareGuide, SHARE_GUIDE_SEEN_KEY } from '@/components/onboarding/share-guide';
import { getMeta, setMeta } from '@/db/repos/settings';

/**
 * Home is the *recency* surface, not a second Library.
 *
 * It answers two questions and stops: what is still waiting for me, and what did
 * I save lately. Structure — folders, favourites, tags — lives in the Library,
 * which is the only screen that shows the tree. They used to render the same
 * summary, which left nobody a reason to open the second one.
 *
 * No counters-as-dashboard, no streaks, no scores, and no widget invented purely
 * to make this screen look different from the other one.
 */
export default function HomePage() {
  const router = useRouter();
  const folders = useVaultStore((state) => state.folders);
  const links = useVaultStore((state) => state.links);
  const allNotes = useVaultStore((state) => state.visibleNotes);
  const inbox = useVaultStore(selectInboxLinks);
  const hidden = useVaultStore((state) => state.hidden);
  const toggleLinkFavorite = useVaultStore((state) => state.toggleLinkFavorite);
  const markLinkOpened = useVaultStore((state) => state.markLinkOpened);

  const status = useVaultStore((state) => state.status);
  const [activeLink, setActiveLink] = React.useState<SavedLink | null>(null);
  const [activeNote, setActiveNote] = React.useState<Note | null>(null);
  const [guideOpen, setGuideOpen] = React.useState(false);

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
  const favoriteNotes = React.useMemo(
    () => [...allNotes].filter((note) => note.isFavorite).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3),
    [allNotes],
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

  const closeGuide = React.useCallback(() => {
    setGuideOpen(false);
    void setMeta(SHARE_GUIDE_SEEN_KEY, true);
  }, []);
  const isEmpty = links.length === 0 && folders.length === 0 && allNotes.length === 0;

  /**
   * The share guide opens itself once, before the first link is saved.
   *
   * "First run" is measured by the absence of links, not by an empty vault: the
   * first boot seeds a handful of starter folders, so an empty-vault test would
   * never fire on the install it is meant for. A vault that already has links is
   * not new, and the guide stays out of its way — the settings row is there for
   * anyone who dismissed it or is curious later. The flag in `meta` travels with
   * an export and survives a restart.
   */
  React.useEffect(() => {
    if (status !== 'ready' || links.length > 0) return;
    let cancelled = false;
    void getMeta<boolean>(SHARE_GUIDE_SEEN_KEY, false).then((seen) => {
      if (!cancelled && !seen) setGuideOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [status, links.length]);

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
              ? 'Nothing saved yet'              : `${pluralize(links.length, 'link')} saved · ${pluralize(folders.length, 'folder')}`}
        >
          Your vault
        </PageTitle>
      </PageHeader>

      {/*
        The Inbox comes first, before anything saved, because it is the only part
        of Home that is asking for something. Everything below it is a list of
        things already dealt with.
      */}
      {!isEmpty && inbox.length > 0 ? (
        <Section title="Inbox" action="Organize" actionHref="/inbox" className="mt-4">
          {/*
            The one deliberate emphasis on Home: the Inbox is the only thing here
            asking the user to do something, so it gets the accent tile and the
            accent-soft icon — the same sentence the rest of the app says about
            the current thing — while the rows around it stay quiet.
          */}
          <Link href="/inbox" className="tap card mx-4 flex items-center gap-3 px-4 py-3.5 active:bg-surface-2">
            <span className="tile bg-accent-soft text-accent">
              <InboxIcon size={19} strokeWidth={1.9} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-row block font-semibold text-fg">
                {pluralize(inbox.length, 'link')} waiting to be filed
              </span>
              <span className="text-meta mt-0.5 block truncate text-muted">
                {inbox
                  .slice(0, 2)
                  // A locked link has no title to show, so it says what it is
                  // instead of leaving a gap in a sentence of names.
                  .map(
                    (link) =>
                      link.title?.trim() ||
                      link.source ||
                      link.url ||
                      (hidden.links.has(link.id) ? 'Locked link' : 'Untitled link'),
                  )
                  .join(' · ')}
                {inbox.length > 2 ? ` +${inbox.length - 2} more` : ''}
              </span>
            </span>
            <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
          </Link>
        </Section>
      ) : null}

      {isEmpty ? (
        <>
          <EmptyState
            icon={<LogoMark size={22} />}
            title="Nothing saved yet"
            description="Stash is a quiet place for the links and notes you mean to keep. Everything lives on this device — no account, no cloud, nothing to sync."
          />
          {/*
            Two things a new user has to know, said as two rows rather than a
            numbered manual: where links come from, and that nothing has to be
            filed. The + button and the share flow are the whole product, so this
            is the only onboarding there is.
          */}
          <GroupSurface className="mt-2">
            <button
              type="button"
              onClick={() => setGuideOpen(true)}
              className="tap flex w-full items-start gap-3 px-4 py-3.5 text-left active:bg-surface-2"
            >
              <span className="tile bg-accent-soft text-accent">
                <Share2 size={19} strokeWidth={1.9} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-row block font-medium text-fg">Save a link from any app</span>
                <span className="text-meta mt-0.5 block leading-relaxed text-muted">
                  Tap Share in the app you are reading in and choose Stash. The link arrives in your Inbox.
                </span>
              </span>
              <ChevronRight size={16} strokeWidth={2} className="mt-1 shrink-0 text-subtle" aria-hidden />
            </button>
            <div className="flex items-start gap-3 px-4 py-3.5">
              <span className="tile bg-surface-2 text-muted">
                <FolderPlus size={19} strokeWidth={1.9} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-row font-medium text-fg">Or add one by hand</p>
                <p className="text-meta mt-0.5 leading-relaxed text-muted">
                  The + button saves a link without filing it. Folders can wait.
                </p>
              </div>
            </div>
          </GroupSurface>
        </>
      ) : (
        <>
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

          {favoriteLinks.length > 0 || favoriteNotes.length > 0 ? (
            <Section title="Favorites">
              {/*
                Everything starred, in one list: a link and a note are different
                kinds of thing but the same answer to "what did I mean to come
                back to". Starred folders stay in the Library, where the tree is.
              */}
              <ListSurface>
                {favoriteLinks.map((link) => (
                  <LinkRow
                    key={link.id}
                    link={link}
                    context={folderNameFor(folders, link.folderId)}
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

          {recentNotes.length > 0 ? (
            <Section title="Notes" action="All notes" actionHref="/notes">
              {/*
                Names, not excerpts. Home is where you recognise something you
                wrote and go back to it; the writing itself belongs behind the
                tap, not in a two-line preview that makes every row a different
                height.
              */}
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

          {/*
            Where to go next, as two rows on one card — the only navigation here,
            and deliberately not a preview of the Library's contents. Home is what
            arrived; the Library is where it is kept.
          */}
          <Section title="Go to" className="pb-6 pt-1">
            <GroupSurface>
              <Link href="/inbox" className="tap flex items-center gap-3 px-4 py-3.5 active:bg-surface-2">
                <span className="tile bg-surface-2 text-muted">
                  <InboxIcon size={19} strokeWidth={1.9} aria-hidden />
                </span>
                <span className="text-row min-w-0 flex-1 truncate font-medium text-fg">Inbox</span>
                <span className="text-meta shrink-0 text-muted">
                  {inbox.length > 0 ? pluralize(inbox.length, 'link') : 'Empty'}
                </span>
                <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
              </Link>
              <Link href="/library" className="tap flex items-center gap-3 px-4 py-3.5 active:bg-surface-2">
                <span className="tile bg-surface-2 text-muted">
                  <FolderPlus size={19} strokeWidth={1.9} aria-hidden />
                </span>
                <span className="text-row min-w-0 flex-1 truncate font-medium text-fg">Library</span>
                <span className="text-meta shrink-0 text-muted">
                  {folders.length > 0 ? pluralize(folders.length, 'folder') : 'No folders'}
                </span>
                <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
              </Link>
            </GroupSurface>
          </Section>
        </>
      )}

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
      <ShareGuide open={guideOpen} onClose={closeGuide} />
    </>
  );
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
