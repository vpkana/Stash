'use client';

import * as React from 'react';
import { Check, Link2, Search } from '@/components/ui/icons';
import type { SavedLink } from '@/db/types';
import { displayUrl } from '@/lib/format';
import { folderPathLabel } from '@/lib/tree';
import { useBackDismiss } from '@/hooks/use-back-dismiss';
import { useVaultStore } from '@/stores/vault-store';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/**
 * Pick a saved link to reference from a note.
 *
 * Scoped to what is already in the vault: attaching is a linking action, not a
 * second way to save. Anything really new should be captured first, so that
 * duplicate detection and folder choice still apply.
 */

export interface LinkPickerSheetProps {
  open: boolean;
  onClose: () => void;
  onPick: (link: SavedLink) => void;
  /** Already attached, shown as selected and disabled. */
  attachedIds?: readonly string[];
  title?: string;
}

const RESULT_LIMIT = 120;

export function LinkPickerSheet({ open, onClose, onPick, attachedIds, title = 'Attach a link' }: LinkPickerSheetProps) {
  const links = useVaultStore((state) => state.links);
  const folders = useVaultStore((state) => state.folders);
  const hidden = useVaultStore((state) => state.hidden);
  const [query, setQuery] = React.useState('');

  const attached = React.useMemo(() => new Set(attachedIds ?? []), [attachedIds]);

  // The query is cleared on close rather than in an effect on open: resetting
  // state during the close handler keeps it off the render path entirely.
  const close = React.useCallback(() => {
    setQuery('');
    onClose();
  }, [onClose]);
  useBackDismiss(open, close);

  const results = React.useMemo(() => {
    // A picker is a listing, and a listing never offers protected content. A link
    // the session cannot read is not something to attach: attaching it would put
    // a reference to private content inside an ordinary note.
    const active = links.filter((link) => !hidden.links.has(link.id));
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered =
      tokens.length === 0
        ? active
        : active.filter((link) => {
            const haystack = `${link.title ?? ''} ${link.url} ${link.source ?? ''} ${link.userNote ?? ''}`.toLowerCase();
            return tokens.every((token) => haystack.includes(token));
          });
    return filtered.sort((a, b) => b.createdAt - a.createdAt).slice(0, RESULT_LIMIT);
  }, [links, query, hidden]);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <p className="mt-0.5 text-meta text-subtle">Links already in your vault. Nothing is copied.</p>
        </SheetHeader>

        <div className="px-3 pb-2">
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
              placeholder="Search your links"
              aria-label="Search your links"
              enterKeyHint="search"
              autoComplete="off"
              className={cn(
                'h-11 w-full rounded-xl border border-border bg-surface-2 pr-3 pl-9 text-row text-fg',
                'placeholder:text-subtle focus:border-accent focus:bg-surface focus:outline-none',
              )}
            />
          </div>
        </div>

        <SheetBody>
          {results.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-8 py-10 text-center">
              <Link2 size={20} strokeWidth={1.7} className="text-subtle" aria-hidden />
              <p className="text-body text-muted">
                {links.length === 0 ? 'No saved links yet' : 'No link matches that'}
              </p>
              <p className="text-meta text-subtle">
                Save it from another app first, then attach it to a note.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-hairline">
              {results.map((link) => {
                const isAttached = attached.has(link.id);
                return (
                  <li key={link.id}>
                    <button
                      type="button"
                      disabled={isAttached}
                      onClick={() => onPick(link)}
                      className={cn(
                        'tap flex w-full items-center px-3 py-3 text-left active:bg-surface-2',
                        isAttached && 'opacity-45',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="text-row block truncate font-medium text-fg">
                          {link.title?.trim() || displayUrl(link.url, 48)}
                        </span>
                        <span className="text-meta mt-0.5 block truncate text-subtle">
                          {folderPathLabel(folders, link.folderId)} · {link.source ?? displayUrl(link.url, 32)}
                        </span>
                      </span>
                      {isAttached ? (
                        <Check size={17} strokeWidth={2.4} className="shrink-0 text-accent" aria-hidden />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
