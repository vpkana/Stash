'use client';

import * as React from 'react';
import { ChevronRight, Loader2, Lock } from '@/components/ui/icons';
import { requireAccess } from '@/lib/privacy/access';
import type { RevealKind } from '@/stores/privacy-store';
import { cn } from '@/lib/utils';

/**
 * A protected item, still in its list.
 *
 * The row keeps its place, its shape on screen and its position in the tree, and
 * gives up its content. Nothing here is derived from a secret: for a link or a
 * note the title was never stored, so there is nothing to leak even by accident.
 *
 * A **folder** is the deliberate exception. Its name is the label on the lock
 * rather than what is behind it, and without it the lock is unusable: every
 * protected folder would read "Locked folder", the user could not tell which one
 * they were about to open, and the share destination picker could not offer a
 * locked folder as a destination at all. So a locked folder shows its name and a
 * lock, and its *contents* stay exactly as unreadable as everything else.
 *
 * The second line says "Tap to unlock" rather than "unlock to read": the row is
 * asking for a gesture, and it is the only row in the app that does.
 */

export interface LockedRowProps {
  kind: RevealKind;
  /**
   * The folder's own name. Only ever passed for folders — a link or a note has no
   * readable label while it is locked, by construction.
   */
  label?: string;
  /** Only ever non-sensitive: timestamps and structure survive locking by design. */
  subtitle?: string;
  onReveal: () => void;
  busy?: boolean;
  className?: string;
}

const NOUNS: Record<RevealKind, string> = {
  folder: 'Locked folder',
  note: 'Locked note',
  link: 'Locked link',
};

export function LockedRow({ kind, label, subtitle, onReveal, busy = false, className }: LockedRowProps) {
  const title = label?.trim() ? label.trim() : NOUNS[kind];
  return (
    <div className={cn('flex items-stretch', className)}>
      <button
        type="button"
        onClick={onReveal}
        disabled={busy}
        aria-label={`${title} — unlock to open`}
        className="tap flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left active:bg-surface-2"
      >
        {/* The accent tile is the one visual difference between a locked row and
            an open one, and it is deliberately the *same* tile every other row
            uses — the accent stands after the identity tones (see
            `identity-color.ts`), so a locked row reads as "this belongs to the
            locked set" rather than as a differently-built row. */}
        <span className="tile bg-accent-soft text-accent">
          {busy ? (
            <Loader2 size={18} strokeWidth={2} className="animate-spin" aria-hidden />
          ) : (
            <Lock size={18} strokeWidth={2} aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-row block truncate font-medium text-fg">{title}</span>
          <span className="text-meta mt-0.5 block truncate text-subtle">
            {subtitle ? `${subtitle} · ` : ''}
            Tap to unlock
          </span>
        </span>
        <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Ask to cross a lock boundary.
 *
 * Returns whether access was actually granted. Callers pass the thing they were
 * about to do and have it run only on success, so a tap on a protected row either
 * opens the item or raises the prompt — never silently does nothing.
 *
 * The boundary is looked up from the item id, so a caller never has to know which
 * folder guards it, and cannot pass the wrong one.
 */
export function useRevealLocked() {
  const [busy, setBusy] = React.useState(false);

  const reveal = React.useCallback(
    async (kind: RevealKind, id: string, next?: () => void) => {
      setBusy(true);
      // `requireAccess` resolves `true` only when the boundary is open — the
      // device prompt answered yes, or one was never needed. Otherwise it has
      // queued the request so the gate can explain itself, and the caller's
      // `next` waits rather than opening something still unreadable.
      const ok = await requireAccess(kind, id);
      setBusy(false);
      if (ok) next?.();
      return ok;
    },
    [],
  );

  return { reveal, busy };
}
