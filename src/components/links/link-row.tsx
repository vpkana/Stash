'use client';

import * as React from 'react';
import { Link2Off, Lock, MoreHorizontal, Star } from '@/components/ui/icons';
import type { SavedLink } from '@/db/types';
import { displayUrl, formatRelative } from '@/lib/format';
import { linkPrimaryLabel, linkDomain } from '@/lib/link-label';
import { domainColor } from '@/lib/identity-color';
import { useLockState } from '@/lib/privacy/access';
import { useLongPress } from '@/hooks/use-long-press';
import { useVaultStore, selectTagsForLink } from '@/stores/vault-store';
import { LockedRow, useRevealLocked } from '@/components/privacy/locked-row';
import { MonogramTile } from '@/components/ui/identity-tile';
import { cn } from '@/lib/utils';

/**
 * A saved link, sized for scanning.
 *
 * The **note is the row**. A saved link's job on screen is recognition — "that
 * video about Docker networking" — and a URL is the single worst thing to
 * recognise it by: long, truncated to the point of being identical to its
 * neighbours, and impossible to skim. So the first line is the user's own words
 * (falling back to the source's title, then to the address when there is nothing
 * better), and the address is demoted to context on the second line, where it is
 * still available without being the thing you have to read.
 *
 * ## The tile
 *
 * The leading tile is the app's substitute for a favicon, which an offline app
 * cannot fetch: the source's first letter on that source's identity colour, so
 * YouTube is the red Y in the Library, on Home, in search and in the capture
 * sheet. It is the same *shape* as a folder's tile (see `identity-tile.tsx`), and
 * that sameness is the point — one tile vocabulary, where the glyph says what kind
 * of thing it is and the tone says which one.
 *
 * An earlier version of this row had no tile at all, and argued that colouring a
 * row by a hash of its domain was a rainbow carrying no information. That argument
 * was right about *arbitrary* colour and wrong about *stable* colour: a hue that is
 * pinned to the source and never changes is a label the user learns, which is a
 * different thing from variety for its own sake.
 *
 * There is still no thumbnail, no preview card and no oversized title. A row is a
 * tile, a title, where it came from, and when it landed.
 */

export interface LinkRowProps {
  link: SavedLink;
  /** Shown as the secondary line when the row is not inside its folder. */
  context?: string;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onShowActions: () => void;
  /** Highlighted because it matched the current search. */
  highlight?: boolean;
  className?: string;
}

export function LinkRow({
  link,
  context,
  onOpen,
  onToggleFavorite,
  onShowActions,
  highlight = false,
  className,
}: LinkRowProps) {
  // The row subscribes to the access decision rather than taking a prop, so a new
  // list cannot forget to gate a protected item: it either renders this row or it
  // is drawing something of its own.
  const access = useLockState('link', link.id);
  // Same reason: tags ride along with the row instead of every caller having to
  // thread them through, so a list added later shows them for free.
  const tags = useVaultStore((state) => selectTagsForLink(state, link.id));

  // Long press is a shortcut to the same sheet the ⋯ button opens, for anyone
  // who reaches for it; the visible button keeps it discoverable.
  const { handlers, consumeLongPress } = useLongPress(onShowActions);
  // A protected row is unreadable in this session: it renders as a placeholder
  // that asks for the prompt, and the caller's `onOpen` runs only once the
  // boundary is crossed.
  const { reveal, busy } = useRevealLocked();

  const handleOpen = () => {
    if (consumeLongPress()) return;
    onOpen();
  };

  if (access.locked) {
    return (
      <LockedRow
        kind="link"
        subtitle={formatRelative(link.createdAt)}
        busy={busy}
        onReveal={() => void reveal('link', link.id, onOpen)}
        className={className}
      />
    );
  }

  const label = linkPrimaryLabel(link);
  const hasLabel = label.kind !== 'url';
  const domain = linkDomain(link);
  const tone = domainColor(domain ?? label.text);

  return (
    <div className={cn('flex items-stretch', highlight && 'bg-accent-soft/40', className)}>
      <button
        type="button"
        onClick={handleOpen}
        {...handlers}
        className="tap flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left active:bg-surface-2"
      >
        {/*
          The monogram is the source's initial, and it never changes: the same site
          always shows the same letter on the same colour, which is what makes it
          readable at a glance instead of something to decode.
        */}
        <MonogramTile color={tone} value={domain ?? label.text} />

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn('text-row min-w-0 truncate font-medium', hasLabel ? 'text-fg' : 'text-muted')}>
              {label.text}
            </span>
            {access.root ? (
              <Lock size={12} strokeWidth={2.4} className="shrink-0 text-accent" aria-label="Locked" />
            ) : null}
            {link.isFavorite ? (
              <Star size={12} strokeWidth={2.4} className="shrink-0 text-warning" aria-label="Favorite" />
            ) : null}
            {link.isUnavailable ? (
              <Link2Off
                size={12}
                strokeWidth={2.4}
                className="shrink-0 text-danger"
                aria-label="Marked as no longer working"
              />
            ) : null}
          </span>
          <span className="text-meta mt-0.5 flex items-center gap-1.5 text-subtle">
            {/*
              The address, always, as context. When the primary line already *is*
              the address (nothing else was captured) it is not repeated.
            */}
            {hasLabel ? (
              <>
                {/* The source carries the identity colour too, so the tile and
                    the word agree about which site this is. */}
                <span className={cn('shrink-0 font-medium', tone.text)}>
                  {link.source ?? displayUrl(link.url, 26)}
                </span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            {/* Tags ride on the metadata line rather than their own row: a list is
                for scanning, and a second line of chips on tagged items would make
                the rows uneven for the sake of something the ⋯ sheet shows in full. */}
            {tags.length > 0 ? (
              <>
                <span className="shrink-0 truncate text-accent">
                  {tags.slice(0, 2).join(', ')}
                  {tags.length > 2 ? ` +${tags.length - 2}` : ''}
                </span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            {context ? (
              <>
                <span className="truncate">{context}</span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            <span className="shrink-0">{formatRelative(link.createdAt)}</span>
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center pr-1">
        <button
          type="button"
          onClick={onToggleFavorite}
          aria-label={link.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={link.isFavorite}
          className="tap flex size-10 items-center justify-center rounded-full active:bg-surface-2"
        >
          <Star
            size={18}
            strokeWidth={1.9}
            className={cn('transition-colors', link.isFavorite ? 'fill-warning text-warning' : 'text-muted')}
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={onShowActions}
          aria-label="Link actions"
          className="tap flex size-10 items-center justify-center rounded-full text-muted active:bg-surface-2"
        >
          <MoreHorizontal size={19} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
