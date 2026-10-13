'use client';

import * as React from 'react';
import { ChevronRight, FilePlus2, NotebookPen, Search } from '@/components/ui/icons';
import type { Note } from '@/db/types';
import { useBackDismiss } from '@/hooks/use-back-dismiss';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/**
 * Add a subnote, deliberately.
 *
 * The Note button beside a title used to *make a note* the instant it was pressed:
 * an untitled "New subnote" appeared, with a reference to it in the middle of the
 * sentence being written. The button was doing two jobs at once — decide, then
 * write — and only the second one is the user's, so the first was done for them,
 * badly: a name nobody chose, and a subnote they then had to go and rename.
 *
 * This is the missing decision, and it is a small one. Name the subnote and it is
 * created with that name; or take one of the notes you already have and put it
 * here instead. Nothing is created until one of those is chosen, and neither
 * action navigates away — the reference lands at the caret, in the sentence the
 * user was writing when they asked.
 */

export interface SubnoteSheetProps {
  open: boolean;
  onClose: () => void;
  /** Create a subnote with this name and reference it at the caret. */
  onCreate: (title: string) => void;
  /** Take an existing note as a subnote of this one, and reference it. */
  onNest: (note: Note) => void;
  /** The notes that could be nested here: not this one, not already below it. */
  candidates: readonly Note[];
  /** The note being written, named in the description. */
  parentTitle: string;
  busy?: boolean;
}

export function SubnoteSheet({
  open,
  onClose,
  onCreate,
  onNest,
  candidates,
  parentTitle,
  busy = false,
}: SubnoteSheetProps) {
  const [title, setTitle] = React.useState('');
  const [query, setQuery] = React.useState('');

  const close = React.useCallback(() => {
    setTitle('');
    setQuery('');
    onClose();
  }, [onClose]);
  useBackDismiss(open, close);

  const tokens = React.useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const matches = React.useMemo(() => {
    if (tokens.length === 0) return candidates.slice(0, 40);
    return candidates
      .filter((note) => tokens.every((token) => note.title.toLowerCase().includes(token)))
      .slice(0, 40);
  }, [candidates, tokens]);

  const name = title.trim();

  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add a subnote</SheetTitle>
          <p className="mt-0.5 text-meta leading-relaxed text-subtle">
            A subnote lives under {parentTitle ? `“${parentTitle}”` : 'this note'}. Either name a new one, or bring an
            existing note in — and a reference to it is written where your cursor is.
          </p>
        </SheetHeader>

        <div className="flex items-end gap-2 px-3 pb-2">
          <input
            value={title}
            autoFocus={open}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name.length > 0) {
                event.preventDefault();
                onCreate(name);
              }
              if (event.key === 'Escape') close();
            }}
            placeholder="Name the new subnote"
            aria-label="Name the new subnote"
            maxLength={120}
            autoComplete="off"
            enterKeyHint="done"
            className={cn(
              'h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface-2 px-3 text-row text-fg',
              'placeholder:text-subtle focus:border-accent focus:bg-surface focus:outline-none',
            )}
          />
          <Button
            variant="primary"
            className="h-11 shrink-0"
            disabled={busy || name.length === 0}
            onClick={() => onCreate(name)}
          >
            <FilePlus2 size={17} strokeWidth={2} aria-hidden />
            Create
          </Button>
        </div>

        <SheetBody>
          {candidates.length === 0 ? null : (
            <>
              <div className="px-3 pt-2 pb-2">
                <p className="pb-2 text-label font-medium text-subtle">Or nest a note you already have</p>
                <div className="relative">
                  <Search
                    size={16}
                    strokeWidth={2}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
                    aria-hidden
                  />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search your notes"
                    aria-label="Search your notes"
                    enterKeyHint="search"
                    autoComplete="off"
                    className={cn(
                      'h-11 w-full rounded-xl border border-border bg-surface-2 pr-3 pl-9 text-row text-fg',
                      'placeholder:text-subtle focus:border-accent focus:bg-surface focus:outline-none',
                    )}
                  />
                </div>
              </div>

              {matches.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 px-8 py-8 text-center">
                  <NotebookPen size={20} strokeWidth={1.7} className="text-subtle" aria-hidden />
                  <p className="text-body text-muted">No note matches that</p>
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-hairline">
                  {matches.map((note) => (
                    <li key={note.id}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onNest(note)}
                        className="tap flex w-full items-center gap-2 px-3 py-3 text-left active:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-row block break-words font-medium text-fg">{note.title}</span>
                          <span className="text-meta mt-0.5 block text-subtle">Becomes a subnote here</span>
                        </span>
                        <ChevronRight size={16} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
