'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A heading you can rename by clicking it.
 *
 * This is the Notion behaviour, and the point of it is that there is no *mode*:
 * the title on the page **is** the field. One click puts a caret where it landed,
 * typing changes the name, and the change is kept when the caret leaves — no
 * dialog, no Rename action, no Save button, and no second place a folder's name
 * can be edited. The old flow was a sheet with a text box and a "Save changes"
 * button, for a single word.
 *
 * ## Why there is no effect syncing the prop into state
 *
 * `editing` is `null` whenever the field is not being typed in, and the value it
 * shows is then the real one straight from the vault. That makes \"the vault is the
 * truth\" true by construction rather than by an effect: a rename from elsewhere
 * appears immediately, and the field can never hold a stale copy. While the user
 * *is* typing, the draft wins, so a background refresh cannot pull the text out
 * from under the caret.
 *
 * Three more details are deliberate:
 *
 *  - **It looks like a title until you touch it.** No border and no field
 *    background at rest, so the header still reads as a header; focus brings in a
 *    soft surface, which is the only signal that it is editable.
 *  - **Empty is not a name.** Committing a blank reverts, because silently
 *    rejecting it is nicer than a folder called \"\".
 *  - **A refusal reverts too.** `onCommit` returns whether the write landed, so a
 *    duplicate name snaps back to the real one instead of showing a name the
 *    vault does not have.
 */
export interface InlineTitleProps {
  value: string;
  /** Persist the new name. Return `false` to reject it (e.g. a duplicate). */
  onCommit: (next: string) => Promise<boolean>;
  ariaLabel: string;
  className?: string;
  maxLength?: number;
}

export function InlineTitle({
  value,
  onCommit,
  ariaLabel,
  className,
  maxLength = 80,
}: InlineTitleProps) {
  /** The in-progress text, or `null` while the field is showing the real name. */
  const [draft, setDraft] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const shown = draft ?? value;

  const commit = React.useCallback(async () => {
    const typed = draft;
    setDraft(null);
    if (typed === null) return;
    const next = typed.replace(/\s+/g, ' ').trim();
    if (next.length === 0 || next === value.trim()) return;
    setBusy(true);
    await onCommit(next);
    setBusy(false);
  }, [draft, onCommit, value]);

  return (
    <input
      value={shown}
      aria-label={ariaLabel}
      disabled={busy}
      maxLength={maxLength}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          // Put the real name back and leave the field. Nothing was written, so
          // Escape needs no undo.
          event.preventDefault();
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
      className={cn(
        'w-full min-w-0 -mx-1 truncate rounded-control bg-transparent px-1 outline-none',
        'transition-colors duration-150 focus:bg-surface-2',
        'disabled:opacity-70',
        className,
      )}
    />
  );
}
