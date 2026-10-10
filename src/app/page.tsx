'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, FolderPlus, Inbox as InboxIcon, Share2 } from '@/components/ui/icons';
import type { Folder, SavedLink } from '@/db/types';
import { pluralize } from '@/lib/format';
import { openExternal } from '@/lib/open-external';
import { useVaultStore, selectInboxLinks } from '@/stores/vault-store';
import { EmptyState, GroupSurface, ListSurface, PageHeader, PageTitle, Section } from '@/components/ui/page';
import { LogoMark } from '@/components/ui/logo';
import { LinkRow } from '@/components/links/link-row';
import { LinkActionsSheet } from '@/components/links/link-actions-sheet';

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
  const folders = useVaultStore((state) => state.folders);
  const links = useVaultStore((state) => state.links);
  const inbox = useVaultStore(selectInboxLinks);
  const hidden = useVaultStore((state) => state.hidden);
  const toggleLinkFavorite = useVaultStore((state) => state.toggleLinkFavorite);
  const markLinkOpened = useVaultStore((state) => state.markLinkOpened);

  const [activeLink, setActiveLink] = React.useState<SavedLink | null>(null);

  const activeLinks = React.useMemo(
    () => links.filter((link) => !hidden.links.has(link.id)),
    [links, hidden],
  );

  /**
   * What just landed, newest first.
   *
   * Built from the already-filtered link list, so a protected link cannot appear
   * here even though this is a listing with no query: the vault store removed it
   * before this screen ever saw it.
   */
  const recent = React.useMemo(
    () => [...activeLinks].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
    [activeLinks],
  );
  const isEmpty = activeLinks.length === 0 && folders.length === 0;

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
              : `${pluralize(activeLinks.length, 'link')} saved · ${pluralize(folders.length, 'folder')}`
          }
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
                  .map((link) => link.title?.trim() || link.source || link.url)
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
            <div className="flex items-start gap-3 px-4 py-3.5">
              <span className="tile bg-accent-soft text-accent">
                <Share2 size={19} strokeWidth={1.9} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-row font-medium text-fg">Save a link from any app</p>
                <p className="text-meta mt-0.5 leading-relaxed text-muted">
                  Tap Share in the app you are reading in and choose Stash. The link arrives in your Inbox.
                </p>
              </div>
            </div>
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
                    onOpen={() => openLink(link)}
                    onToggleFavorite={() => void toggleLinkFavorite(link.id)}
                    onShowActions={() => setActiveLink(link)}
                  />
                ))}
              </ListSurface>
            ) : (
              <p className="text-body px-4 py-4 text-muted">Nothing here yet.</p>
            )}
          </Section>

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
    </>
  );
}

/** Where a recent link sits, shown as context on a row that is out of place. */
function folderNameFor(folders: readonly Folder[], folderId: string | null): string | undefined {
  if (!folderId) return undefined;
  return folders.find((folder) => folder.id === folderId)?.name;
}
