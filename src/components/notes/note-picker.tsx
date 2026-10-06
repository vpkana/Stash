'use client';

import * as React from 'react';
import { Home, Star } from '@/components/ui/icons';
import type { Note } from '@/db/types';
import { canMoveNote, flattenNotes, noteDepth, noteDescendantIds } from '@/lib/tree';
import { TreePickerList, type TreePickerItem } from '@/components/ui/tree-picker';

/**
 * Choosing a parent note.
 *
 * Reuses the same indented-tree interaction as the folder picker, so "where does
 * this go" behaves identically across the app. Notes that cannot legally accept
 * the moved note are disabled rather than hidden: an option that has silently
 * disappeared is harder to understand than one that is visibly unavailable.
 */

export const NOTE_ROOT_KEY = 'note:__root__';

export interface NotePickerProps {
  notes: readonly Note[];
  selectedNoteId: string | null;
  onSelect: (parentNoteId: string | null) => void;
  /** The note being moved, so it and its own subtree are excluded. */
  movingNoteId?: string;
  alwaysFilterable?: boolean;
  filterPlaceholder?: string;
  className?: string;
  footer?: React.ReactNode;
}

export function NotePicker({
  notes,
  selectedNoteId,
  onSelect,
  movingNoteId,
  alwaysFilterable = false,
  filterPlaceholder = 'Find a note',
  className,
  footer,
}: NotePickerProps) {
  const { items, disabledKeys } = React.useMemo(() => {
    const rows: TreePickerItem[] = [
      {
        key: NOTE_ROOT_KEY,
        label: 'Top level',
        path: '',
        depth: 0,
        hint: 'Not inside another note',
        icon: <Home size={17} strokeWidth={1.9} aria-hidden />,
      },
    ];

    const blocked = new Set<string>();
    if (movingNoteId) {
      blocked.add(movingNoteId);
      for (const id of noteDescendantIds(notes, movingNoteId)) blocked.add(id);
    }

    for (const entry of flattenNotes(notes)) {
      rows.push({
        key: `note:${entry.node.id}`,
        label: entry.node.title,
        path: entry.path,
        depth: noteDepth(notes, entry.node.id),
        badge: entry.node.isFavorite ? (
          <Star size={13} strokeWidth={2} className="shrink-0 text-warning" aria-label="Favorite note" />
        ) : undefined,
      });
    }

    // Reject anything that would create a cycle or exceed the depth cap.
    const disabled = new Set<string>();
    if (movingNoteId) {
      for (const entry of flattenNotes(notes)) {
        const check = canMoveNote(notes, movingNoteId, entry.node.id);
        if (!check.ok) disabled.add(`note:${entry.node.id}`);
      }
    }

    return { items: rows, disabledKeys: [...disabled] };
  }, [notes, movingNoteId]);

  const handleSelect = React.useCallback(
    (key: string) => {
      if (key === NOTE_ROOT_KEY) onSelect(null);
      else if (key.startsWith('note:')) onSelect(key.slice('note:'.length));
    },
    [onSelect],
  );

  const selectedKey = selectedNoteId ? `note:${selectedNoteId}` : NOTE_ROOT_KEY;

  return (
    <TreePickerList
      items={items}
      selectedKey={selectedKey}
      onSelect={handleSelect}
      disabledKeys={disabledKeys}
      alwaysFilterable={alwaysFilterable}
      filterPlaceholder={filterPlaceholder}
      emptyTitle={notes.length === 0 ? 'No notes yet' : 'Nothing here yet'}
      {...(footer ? { footer } : {})}
      {...(className ? { className } : {})}
    />
  );
}
