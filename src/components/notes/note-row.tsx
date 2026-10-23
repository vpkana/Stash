'use client';

import * as React from 'react';
import { ChevronRight, Link2, Lock, MoreHorizontal, NotebookPen, Star } from '@/components/ui/icons';
import type { Note } from '@/db/types';
import { checklistProgress } from '@/lib/markdown';
import { formatRelative, pluralize } from '@/lib/format';
import { noteTitleText } from '@/lib/notes';
import { useLockState } from '@/lib/privacy/access';
import type { DragRowProps } from '@/hooks/use-drag-sort';
import { DragGrip } from '@/components/ui/drag-grip';
import { useVaultStore } from '@/stores/vault-store';
import { LockedRow, useRevealLocked } from '@/components/privacy/locked-row';
import { cn } from '@/lib/utils';

/**
 * A note in a list.
 *
 * Shows what distinguishes one note from another — how many subnotes it holds,
 * whether it has a checklist and how far through it is, how many links are
 * attached — without becoming a card. A note that is a container reads as a
 * container; a note with content shows its opening line.
 *
 * Notes are the one list without an identity tone. A folder's colour is a label
 * the user chose and a link's is derived from its source; a note is just writing,
 * and forty notes in eight arbitrary colours said nothing except that the colours
 * were arbitrary. One quiet glyph for every note in the list — a subnote count
 * and the chevron still mark a container, because that is information.
 */
export interface NoteRowProps {
  note: Note;
  childCount?: number;
  linkCount?: number;
  /** Override the secondary line entirely, e.g. to show a full path in search. */
  subtitle?: string;
  onOpen: () => void;
  onShowActions: () => void;
  onToggleFavorite?: () => void;
  /** Marked because it matched the current query. */
  highlight?: boolean;
  /** Row props from {@link useDragSort}, when this list is reorderable. */
  dragRow?: DragRowProps;
  /** The companion to `dragRow`: true once, for the click that ends a lift. */
  consumeDrag?: () => boolean;
  className?: string;
}

export function NoteRow({
  note,
  childCount = 0,
  linkCount = 0,
  subtitle,
  onOpen,
  onShowActions,
  onToggleFavorite,
  highlight = false,
  dragRow,
  consumeDrag,
  className,
}: NoteRowProps) {
  const locked = useVaultStore((state) => state.protection.notes.has(note.id));
  // See `LockedRow`: a protected note is a placeholder that asks for the prompt.
  // Asked of the central access check rather than of the ciphertext, because
  // "may I read this" and "is this encrypted on disk" are different questions
  // and only the first one belongs in a row.
  const access = useLockState('note', note.id);
  const { reveal, busy: revealing } = useRevealLocked();
  const checklist = React.useMemo(() => checklistProgress(note.content), [note.content]);

  const meta: string[] = [];
  if (childCount > 0) meta.push(pluralize(childCount, 'subnote'));
  if (linkCount > 0) meta.push(pluralize(linkCount, 'link'));
  if (checklist) meta.push(`${checklist.done}/${checklist.total}`);
  meta.push(formatRelative(note.updatedAt));

  if (access.locked) {
    return (
      <LockedRow
        kind="note"
        subtitle={formatRelative(note.updatedAt)}
        busy={revealing}
        onReveal={() => void reveal('note', note.id, onOpen)}
        {...(dragRow ? { dragRow } : {})}
        {...(consumeDrag ? { consumeDrag } : {})}
        className={className}
      />
    );
  }

  return (
    <div {...dragRow} className={cn('flex items-stretch', highlight && 'bg-accent-soft/40', dragRow?.className, className)}>
      {/* The handle appears only where the list can actually be reordered. */}
      {dragRow ? <DragGrip /> : null}
      <button
        type="button"
        onClick={() => {
          if (consumeDrag?.()) return;
          onOpen();
        }}
        className="tap flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left active:bg-surface-2"
      >
        {/* Sized like the tiles the other lists use, so titles line up across
            screens; drawn in `subtle` so it is a marker, not a badge. */}
        <span className="flex size-10 shrink-0 items-center justify-center text-subtle" aria-hidden>
          <NotebookPen size={20} strokeWidth={1.7} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-row min-w-0 truncate font-medium text-fg">
              {noteTitleText(note.title)}
            </span>
            {locked ? <Lock size={12} strokeWidth={2.4} className="shrink-0 text-accent" aria-label="Locked note" /> : null}
            {note.isFavorite ? (
              <Star size={12} strokeWidth={2.4} className="shrink-0 fill-warning text-warning" aria-label="Favorite" />
            ) : null}
          </span>
          {/*
            * The name, and what it holds — never a slice of the body.
            *
            * A note preview used to be printed here, and it made the list read
            * like three half-sentences stacked on top of each other: the title of
            * one note, the opening line of the next, with no rule between them.
            * The row's job is to be found by name; the words are one tap away.
            */}
          <span className="text-meta mt-0.5 block truncate text-subtle">{subtitle ?? meta.join(' · ')}</span>
        </span>
        {childCount > 0 ? (
          <span className="text-meta flex shrink-0 items-center gap-1 text-subtle">
            {childCount}
            <ChevronRight size={15} strokeWidth={2} aria-hidden />
          </span>
        ) : null}
      </button>

      <div className="flex shrink-0 items-center pr-1">
        {linkCount > 0 ? (
          <span
            className="text-meta flex items-center gap-1 pr-1 text-subtle"
            aria-label={pluralize(linkCount, 'linked resource')}
          >
            <Link2 size={13} strokeWidth={2} aria-hidden />
            {linkCount}
          </span>
        ) : null}
        {onToggleFavorite ? (
          <button
            type="button"
          data-no-drag
          onClick={onToggleFavorite}
          aria-label={note.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-pressed={note.isFavorite}
            className="tap flex size-10 items-center justify-center rounded-full active:bg-surface-2"
          >
            <Star
              size={18}
              strokeWidth={1.9}
              className={cn('transition-colors', note.isFavorite ? 'fill-warning text-warning' : 'text-muted')}
              aria-hidden
            />
          </button>
        ) : null}
        <button
          type="button"
          data-no-drag
          onClick={onShowActions}
          aria-label={`${noteTitleText(note.title)} actions`}
          className="tap flex size-10 items-center justify-center rounded-full text-muted active:bg-surface-2"
        >
          <MoreHorizontal size={19} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
