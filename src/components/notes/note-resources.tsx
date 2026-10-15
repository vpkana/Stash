'use client';

import * as React from 'react';
import { Link2, X } from '@/components/ui/icons';
import type { SavedLink } from '@/db/types';
import { displayUrl } from '@/lib/format';
import { useLockState } from '@/lib/privacy/access';
import { useVaultStore } from '@/stores/vault-store';
import { LockedRow, useRevealLocked } from '@/components/privacy/locked-row';
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
 * A **locked** link keeps its row too. It used to be filtered out before it got
 * here, so locking a link made it disappear from the note that referenced it —
 * the same "it just vanished" problem the Library's list had, one screen over.
 * The row is the placeholder the rest of the app uses: its position, its age and
 * the word "locked", and nothing that was sealed.
 *
 * There is no "Attach a saved link" button here. Attaching is a *command*, and
 * the command is the **Link** button beside the note's title (see
 * `note-editor.tsx`), where it inserts the reference at the caret.
 *
 * The list is rendered **only when it has something in it**. An empty "No links
 * attached" paragraph under a note that refers to no links is a sentence about
 * nothing, repeated on every note — and the button above the text is what tells
 * the user the feature exists.
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
  if (links.length === 0) return null;

  return (
    <section className={cn('mt-6', className)}>
      <div className="flex items-baseline justify-between px-4 pb-1.5">
        <h2 className="flex items-center gap-1.5 text-label font-medium text-subtle">
          <Link2 size={12} strokeWidth={2.2} aria-hidden />
          Resources
          <span className="text-subtle/70">{links.length}</span>
        </h2>
      </div>

      <ul className="flex flex-col divide-y divide-hairline">
        {links.map((link) => (
          <ResourceRow
            key={link.id}
            link={link}
            readOnly={readOnly}
            onOpenLink={onOpenLink}
            onDetach={onDetach}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * One resource, which may be locked.
 *
 * Its own component because the lock check is a hook, and hooks cannot live in
 * a `map`: the number of rows depends on the data, the number of hooks must not.
 * The row subscribes to the lock state itself, so the list above cannot forget
 * to gate a protected item — the same rule every other row in the app follows.
 */
function ResourceRow({
  link,
  readOnly,
  onOpenLink,
  onDetach,
}: {
  link: SavedLink;
  readOnly: boolean;
  onOpenLink: (link: SavedLink) => void;
  onDetach: (linkId: string) => void;
}) {
  const access = useLockState('link', link.id);
  const { reveal, busy } = useRevealLocked();

  if (access.locked) {
    return (
      <li className="flex items-stretch">
        <LockedRow
          kind="link"
          busy={busy}
          className="min-w-0 flex-1"
          onReveal={() =>
            void reveal('link', link.id, () => {
              // The copy this row holds is the redacted one — its address is
              // blank by design — so the freshly readable link is re-read from
              // the vault before it is opened. With nothing readable to open,
              // nothing opens rather than an empty window.
              const fresh = useVaultStore.getState().links.find((candidate) => candidate.id === link.id);
              if (fresh?.url) onOpenLink(fresh);
            })
          }
        />
      </li>
    );
  }

  return (
    <li className="flex items-stretch">
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
  );
}
