'use client';

import * as React from 'react';
import { Link2, Plus, X } from '@/components/ui/icons';
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
 */

export interface NoteResourcesProps {
  links: readonly SavedLink[];
  onOpenLink: (link: SavedLink) => void;
  onDetach: (linkId: string) => void;
  onAttach: () => void;
  /** Hidden while the note is locked. */
  readOnly?: boolean;
  className?: string;
}

export function NoteResources({
  links,
  onOpenLink,
  onDetach,
  onAttach,
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
          No links attached. Attach a saved link to keep the source of a thought next to it.
        </p>
      )}

      {readOnly ? null : (
        <div className="px-4 pt-2">
          <button
            type="button"
            onClick={onAttach}
            className="tap text-row flex w-full items-center gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-left font-medium text-accent active:bg-surface-3"
          >
            <Plus size={17} strokeWidth={2.1} aria-hidden />
            Attach a saved link
          </button>
        </div>
      )}
    </section>
  );
}
