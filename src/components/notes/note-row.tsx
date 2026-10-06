'use client';

import * as React from 'react';
import { ChevronRight, FileText, Link2, Lock, MoreHorizontal, NotebookPen, Star } from '@/components/ui/icons';
import type { Note } from '@/db/types';
import { checklistProgress } from '@/lib/markdown';
import { formatRelative, pluralize } from '@/lib/format';
import { notePlainText } from '@/lib/notes';
import { useLockState } from '@/lib/privacy/access';
import { useLongPress } from '@/hooks/use-long-press';
import { useVaultStore } from '@/stores/vault-store';
import { LockedRow, useRevealLocked } from '@/components/privacy/locked-row';
import { IdentityTile } from '@/components/ui/identity-tile';
import { identityColor } from '@/lib/identity-color';
import { cn } from '@/lib/utils';

/**
 * A note in a list.
 *
 * Shows what distinguishes one note from another — how many subnotes it holds,
 * whether it has a checklist and how far through it is, how many links are
 * attached — without becoming a card. A note that is a container reads as a
 * container; a note with content shows its opening line.
 *
 * The leading tile carries the note's own identity tone, and its glyph says
 * whether the note is a *container* — a notebook for a note with subnotes, a
 * single page for one without. The tone is what makes the colour a label rather
 * than decoration; the glyph is what keeps the tile from being forty identical
 * squares in eight colours.
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
  className,
}: NoteRowProps) {
  const locked = useVaultStore((state) => state.protection.notes.has(note.id));
  // Hold a note for the same sheet its ⋯ button opens, so every list in the app
  // answers to the same gesture.
  const { handlers, consumeLongPress } = useLongPress(onShowActions);
  // See `LockedRow`: a protected note is a placeholder that asks for the prompt.
  // Asked of the central access check rather than of the ciphertext, because
  // "may I read this" and "is this encrypted on disk" are different questions
  // and only the first one belongs in a row.
  const access = useLockState('note', note.id);
  const { reveal, busy: revealing } = useRevealLocked();
  const checklist = React.useMemo(() => checklistProgress(note.content), [note.content]);
  const preview = React.useMemo(() => notePlainText(note.content, 80), [note.content]);
  // Derived from the id, so a note keeps its colour for as long as it exists.
  const tone = identityColor(note.id);

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
        className={className}
      />
    );
  }

  return (
    <div className={cn('flex items-stretch', highlight && 'bg-accent-soft/40', className)}>
      <button
        type="button"
        onClick={() => {
          if (consumeLongPress()) return;
          onOpen();
        }}
        {...handlers}
        className="tap flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left active:bg-surface-2"
      >
        <IdentityTile color={tone}>
          {childCount > 0 ? (
            <NotebookPen size={19} strokeWidth={1.8} aria-hidden />
          ) : (
            <FileText size={19} strokeWidth={1.8} aria-hidden />
          )}
        </IdentityTile>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-row min-w-0 truncate font-medium text-fg">{note.title}</span>
            {locked ? <Lock size={12} strokeWidth={2.4} className="shrink-0 text-accent" aria-label="Locked note" /> : null}
            {note.isFavorite ? (
              <Star size={12} strokeWidth={2.4} className="shrink-0 fill-warning text-warning" aria-label="Favorite" />
            ) : null}
          </span>
          <span className="text-meta mt-0.5 block truncate text-subtle">{subtitle ?? meta.join(' · ')}</span>
          {!subtitle && preview.length > 0 && childCount === 0 ? (
            <span className="text-meta mt-0.5 line-clamp-2 block text-muted">{preview}</span>
          ) : null}
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
          onClick={onShowActions}
          aria-label={`${note.title} actions`}
          className="tap flex size-10 items-center justify-center rounded-full text-muted active:bg-surface-2"
        >
          <MoreHorizontal size={19} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
