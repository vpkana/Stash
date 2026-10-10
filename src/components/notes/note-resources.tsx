'use client';

import * as React from 'react';
import { Link2, X } from '@/components/ui/icons';
import type { SavedLink } from '@/db/types';
import { displayUrl } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The links a note refers to.
 *
 * Rows point at the one canonical SavedLink record rather than a copy, so a
 * resource keeps its real title and folder, and detaching it here removes only
 * the reference -- never the saved link.
 *
 * Rows are hairline-separated and monochrome, matching every other list in the
 * app. This list used to give each resource a letter tile coloured from a hash
 * of its domain: six different hues that distinguished nothing, made a short
 * list look decorative, and clashed with the accent's meaning elsewhere.
 *
 * There is no "Attach a saved link" button here any more. Attaching is a
 * *command* and this is a *list*, so the command moved up into the note's
 * secondary actions (see `note-editor.tsx`) where it stops competing with the
 * text being written. The list stays, because what a note refers to is part of
 * reading it.
 */

export interface NoteResourcesProps {
  links: readonly SavedLink[];
  onOpenLink: (link: SavedLink) => void;
  onDetach: (linkId: string) => void;
  /** Hidden while the note is locked. */
  readOnly?: boolean;
  className?: string;
}

export function NoteResources({
  links,
  onOpenLink,
  onDetach,
  readOnly = false,
  className,
}: NoteResourcesProps) {
  return (
    <section className={cn('mt-6', className)}>
      <div className="flex items-baseline justify-between px-4 pb-1.5">
        <h2 className="flex items-center gap-1.5 text-label font-medium text-subtle">
          <Link2 size={12} strokeWidth={2.2} aria-hidden />
          Resources
          {links.length > 0 ? <span className="text-subtle/70">{links.length}</span> : null}
        </h2>
      </div>

      {links.length > 0 ? (
        <ul className="flex flex-col divide-y divide-hairline">
          {links.map((link) => (
            <li key={link.id} className="flex items-stretch">
              <button
                type="button"
                onClick={() => onOpenLink(link)}
                className="tap flex min-w-0 flex-1 items-center px-4 py-3 text-left active:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-row block truncate font-medium text-fg">
                    {link.title?.trim() || displayUrl(link.url, 48)}
                  </span>
                  <span className="text-meta mt-0.5 block truncate text-subtle">
                    {link.source ?? displayUrl(link.url, 32)}
                  </span>
                </span>
              </button>
              {readOnly ? null : (
                <button
                  type="button"
                  onClick={() => onDetach(link.id)}
                  aria-label={`Detach ${link.title ?? 'link'}`}
                  className="tap mr-1 flex w-10 shrink-0 items-center justify-center rounded-full text-subtle active:bg-surface-2"
                >
                  <X size={16} strokeWidth={2.2} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 pb-1 text-meta leading-relaxed text-subtle">
          No links attached. Use “Subnotes and links” above the text to attach the source of a thought to this
          note.
        </p>
      )}
    </section>
  );
}
