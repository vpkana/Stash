'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Clock, Search as SearchIcon, SearchX, Tag as TagIcon, X } from '@/components/ui/icons';
import type { Note, SavedLink } from '@/db/types';
import { SEARCH_FILTERS, searchVault, type SearchFilter } from '@/lib/search';
import { pluralize } from '@/lib/format';
import { openExternal } from '@/lib/open-external';
import { useVaultStore, selectTagUsage } from '@/stores/vault-store';
import { ListSurface, PageHeader, Section } from '@/components/ui/page';
import { LinkRow } from '@/components/links/link-row';
import { LinkActionsSheet } from '@/components/links/link-actions-sheet';
import { FolderRow } from '@/components/folders/folder-row';
import { NoteRow } from '@/components/notes/note-row';
import { NoteActionsSheet } from '@/components/notes/note-actions-sheet';
import { cn } from '@/lib/utils';

/**
 * Search.
 *
 * Runs over the in-memory snapshot of IndexedDB, so it works in airplane mode,
 * returns instantly, and can search things a URL bar cannot: your own writing,
 * your tags, and the folder names you invented.
 *
 * Results come back in groups -- folders, notes, links -- rather than one merged
 * list. Mixing a subnote in among bookmark rows makes the list harder to read,
 * not easier, and it hides which kind of thing matched.
 */

const FILTER_IDS = new Set(SEARCH_FILTERS.map((filter) => filter.id));

function isFilter(value: string | null): value is SearchFilter {
  return value !== null && FILTER_IDS.has(value as SearchFilter);
}

function SearchView() {
  const params = useSearchParams();
  const router = useRouter();
  const initialFilter = params.get('filter');
  // `?q=` lets another screen hand a query over — the tag chips on Home do
  // exactly that, so tapping a tag is one tap rather than typing it again.
  const initialQuery = params.get('q') ?? '';

  const [query, setQuery] = React.useState(initialQuery);
  const [filter, setFilter] = React.useState<SearchFilter>(isFilter(initialFilter) ? initialFilter : 'all');
  const [activeLink, setActiveLink] = React.useState<SavedLink | null>(null);
  const [activeNote, setActiveNote] = React.useState<Note | null>(null);

  const folders = useVaultStore((state) => state.folders);
  const links = useVaultStore((state) => state.links);
  const tags = useVaultStore((state) => state.tags);
  const linkTags = useVaultStore((state) => state.linkTags);
  const notes = useVaultStore((state) => state.notes);
  const noteLinks = useVaultStore((state) => state.noteLinks);
  const hidden = useVaultStore((state) => state.hidden);
  const tagsInUse = useVaultStore(selectTagUsage);
  const toggleLinkFavorite = useVaultStore((state) => state.toggleLinkFavorite);
  const markLinkOpened = useVaultStore((state) => state.markLinkOpened);

  const inputRef = React.useRef<HTMLInputElement>(null);

  const searching = query.trim().length > 0;

  const outcome = React.useMemo(
    () =>
      searchVault(
        { folders, links, tags, linkTags, notes, noteLinks },
        {
          query,
          filter,
          limit: 120,
          folderLimit: searching ? 8 : 12,
          noteLimit: 80,
          // Browse shows folders too: the folder group is how a folder gets found
          // without walking the tree, and under the Favorites filter it is how
          // the starred folders appear alongside the starred links and notes.
          includeFolders: searching || filter === 'favorites',
          // Belt and braces: the collections above are already filtered, and the
          // search engine filters again from these sets. Two independent points
          // have to be wrong before a locked item can appear in a result.
          hidden,
        },
      ),
    [folders, links, tags, linkTags, notes, noteLinks, hidden, query, filter, searching],
  );

  // The tag shelf is a browsing aid, not a result: it only appears when the user
  // has typed nothing, so it never competes with what they were looking for.
  const showTags = !searching && filter === 'all' && tagsInUse.length > 0;

  const folderNameById = React.useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );

  const openLink = React.useCallback(
    (link: SavedLink) => {
      void markLinkOpened(link.id);
      void openExternal(link.url);
    },
    [markLinkOpened],
  );

  const showRecent = query.trim().length === 0;

  return (
    <>
      <PageHeader>
        <div className="relative">
          <SearchIcon
            size={17}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-subtle"
            aria-hidden
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search links, notes, folders…"
            aria-label="Search your vault"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className={cn(
              'h-12 w-full rounded-xl border border-border bg-surface-2 pr-10 pl-10 text-title text-fg',
              'placeholder:text-subtle focus:border-accent focus:bg-surface focus:outline-none',
            )}
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="tap absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-subtle active:bg-surface-3"
            >
              <X size={16} strokeWidth={2.2} aria-hidden />
            </button>
          ) : null}
        </div>

        <div className="-mx-1 mt-2.5 flex gap-1.5 overflow-x-auto px-1 pb-0.5 no-scrollbar">
          {SEARCH_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                setFilter(option.id);
                router.replace(option.id === 'all' ? '/search' : `/search?filter=${option.id}`, {
                  scroll: false,
                });
              }}
              aria-pressed={filter === option.id}
              className={cn(
                'tap shrink-0 rounded-full px-3 py-1.5 text-meta font-medium transition-colors',
                filter === option.id
                  ? 'bg-accent text-accent-fg'
                  : 'border border-border bg-surface text-muted active:bg-surface-2',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </PageHeader>

      {showTags ? (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1.5 px-4 pb-1">
            {tagsInUse.slice(0, 24).map((tag) => (
              <button
                key={tag.name}
                type="button"
                onClick={() => setQuery(tag.name)}
                className="tap flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 active:bg-surface-2"
              >
                <TagIcon size={12} strokeWidth={2.2} className="text-subtle" aria-hidden />
                <span className="text-meta font-medium text-fg">{tag.name}</span>
                <span className="text-label text-subtle">{tag.count}</span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      {outcome.folders.length > 0 ? (
        <Section title={filter === 'favorites' ? 'Favorite folders' : 'Folders'}>
          <ListSurface>
            {outcome.folders.map((hit) => (
              <FolderRow
                key={hit.folder.id}
                folder={hit.folder}
                subtitle={hit.path}
                onOpen={() => router.push(`/library?folder=${hit.folder.id}`)}
                onShowActions={() => router.push(`/library?folder=${hit.folder.id}`)}
              />
            ))}
          </ListSurface>
        </Section>
      ) : null}

      {outcome.notes.length > 0 ? (
        <Section
          title={
            showRecent
              ? 'Notes'
              : `${pluralize(outcome.notes.length, 'note')}${outcome.relaxed ? ' · loose match' : ''}`
          }
        >
          <ListSurface>
            {outcome.notes.map((hit) => (
              <NoteRow
                key={hit.note.id}
                note={hit.note}
                subtitle={searching ? hit.path : undefined}
                linkCount={hit.resourceTitles.length}
                highlight={searching}
                onOpen={() => router.push(`/notes?note=${hit.note.id}`)}
                onShowActions={() => setActiveNote(hit.note)}
              />
            ))}
          </ListSurface>
        </Section>
      ) : null}

      {outcome.links.length > 0 ? (
        <Section
          title={
            showRecent
              ? filter === 'favorites'
                ? 'Favorites'
                : 'Recently saved'
              : `${pluralize(outcome.links.length, 'result')}${outcome.relaxed ? ' · loose match' : ''}`
          }
        >
          <ListSurface>
            {outcome.links.map((hit) => (
              <LinkRow
                key={hit.link.id}
                link={hit.link}
                context={folderNameById.get(hit.link.folderId ?? '')}
                highlight={!showRecent}
                onOpen={() => openLink(hit.link)}
                onToggleFavorite={() => void toggleLinkFavorite(hit.link.id)}
                onShowActions={() => setActiveLink(hit.link)}
              />
            ))}
          </ListSurface>
        </Section>
      ) : null}

      {outcome.links.length === 0 && outcome.folders.length === 0 && outcome.notes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-8 py-14 text-center">
          <SearchX size={22} strokeWidth={1.7} className="mb-1 text-subtle" aria-hidden />
          <p className="text-row font-semibold text-fg">
            {query.trim()
              ? 'Nothing matches that'
              : filter === 'archived'
                ? 'Nothing is archived'
                : filter === 'favorites'
                  ? 'No favorites yet'
                  : filter === 'all'
                    ? 'Your vault is empty'
                    : 'Nothing here yet'}
          </p>
          <p className="max-w-xs text-meta leading-relaxed text-muted">
            {query.trim()
              ? 'Search covers link titles, addresses, your own notes and subnotes, tags and folder names. Everything is searched on this device.'
              : filter === 'archived'
                ? 'Archiving keeps a link or note without deleting it. Archived items are hidden from every other view, and this filter is the one place they show up — so they stay findable instead of gone.'
                : filter === 'favorites'
                  ? 'Star a link, a note or a folder and it appears here. Favoriting never moves anything, so your structure stays exactly as you built it.'
                  : 'Save a link or write a note and it will show up here, searchable offline.'}
          </p>
        </div>
      ) : null}

      {showRecent && filter === 'all' && (links.length > 0 || notes.length > 0) ? (
        <p className="flex items-center justify-center gap-1.5 px-4 py-6 text-meta text-subtle">
          <Clock size={13} strokeWidth={2} aria-hidden />
          Newest first · searched offline
        </p>
      ) : null}

      {filter === 'archived' && (outcome.links.length > 0 || outcome.notes.length > 0) ? (
        <p className="px-5 py-6 text-center text-meta leading-relaxed text-subtle">
          Archived items are hidden from Home, the Library and every other filter. Open one and choose
          &ldquo;Restore from archive&rdquo; to bring it back.
        </p>
      ) : null}

      <div className="h-4" />

      <LinkActionsSheet
        key={activeLink?.id ?? 'no-link'}
        link={activeLink}
        onClose={() => setActiveLink(null)}
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

export default function SearchPage() {
  return (
    <React.Suspense fallback={<div className="h-dvh bg-bg" />}>
      <SearchView />
    </React.Suspense>
  );
}

