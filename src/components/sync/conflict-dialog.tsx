'use client';

import * as React from 'react';
import { AlertTriangle, LockKeyhole } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { conflictSummary } from '@/db/repos/sync-conflicts';
import type { SyncConflictRow } from '@/db/sync-types';
import type { ConflictChoice } from '@/db/repos/sync-conflicts';
import { formatRelative, pluralize } from '@/lib/format';
import { useSyncStore } from '@/stores/sync-store';
import { cn } from '@/lib/utils';

/**
 * Conflict review.
 *
 * The two versions are already in the vault: one on the row, one either as the
 * "(conflict copy)" note or as the value stored in this record. So the dialog
 * never asks the user to retype anything, and every action here is reversible in
 * the sense that matters — it chooses between two records that both already
 * exist.
 *
 * Locked items are described by the generic label the engine produced. Their
 * payloads are ciphertext (or were redacted when the vault could not be unlocked
 * while syncing), so this screen deliberately has no preview path at all: there
 * is no code here that could accidentally render a locked title.
 */

/**
 * Whether a side still exists in a form worth writing back.
 *
 * A locked conflict is normally stored as ciphertext on both sides. The one
 * exception is a sync that ran while this vault could not be unlocked: the
 * payload was redacted rather than kept readable, and writing it back would blank
 * the row. Such a side is not offered at all.
 */
function canApply(conflict: SyncConflictRow, entry: SyncConflictRow['local']): boolean {
  if (!entry) return false;
  if (entry.deleted) return true;
  if (!conflict.label.startsWith('Locked ')) return true;
  const row = entry.row as { enc?: unknown } | undefined;
  return Boolean(row?.enc);
}

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  content: 'body',
  name: 'name',
  parentId: 'folder',
  parentNoteId: 'parent note',
  folderId: 'folder',
  sortOrder: 'order',
  isFavorite: 'favourite',
  isLocked: 'lock',
  url: 'address',
  normalizedUrl: 'address',
  description: 'description',
  userNote: 'your note',
  deletedAt: 'trash',
};

export function ConflictDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const conflicts = useSyncStore((state) => state.conflicts);
  const resolve = useSyncStore((state) => state.resolve);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const descriptionId = React.useId();

  const apply = async (conflict: SyncConflictRow, choice: ConflictChoice) => {
    setBusyId(conflict.id);
    const result = await resolve(conflict.id, choice);
    setBusyId(null);
    if (!result.ok) {
      toast(result.message ?? 'That conflict could not be resolved.', { tone: 'danger' });
      return;
    }
    toast(choice === 'dismiss' ? 'Conflict closed. Both versions are still in your vault.' : 'Conflict resolved.', {
      tone: 'success',
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent describedBy={descriptionId} className="flex max-h-[82dvh] flex-col">
        <DialogTitle>Changes made on both devices</DialogTitle>
        <DialogDescription id={descriptionId}>
          {conflicts.length === 0
            ? 'Nothing needs your attention.'
            : `${pluralize(conflicts.length, 'item')} changed in two places. Nothing was thrown away — choose what should stay on this device.`}
        </DialogDescription>

        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
          {conflicts.map((conflict) => {
            const busy = busyId === conflict.id;
            const informational = conflict.reason === 'note-copy' || conflict.reason === 'delete-edit';
            const sealed = conflict.label.startsWith('Locked ');
            const localUsable = canApply(conflict, conflict.local);
            const remoteUsable = canApply(conflict, conflict.remote);
            const bothBlocked = !informational && !localUsable && !remoteUsable;

            return (
              <div key={conflict.id} className="rounded-xl border border-border bg-surface-2 p-3">
                <div className="flex items-start gap-2">
                  {sealed ? (
                    <LockKeyhole size={16} strokeWidth={1.9} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                  ) : (
                    <AlertTriangle size={16} strokeWidth={1.9} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-row font-medium text-fg">{conflict.label}</p>
                    <p className="mt-0.5 text-meta leading-relaxed text-subtle">
                      {conflictSummary(conflict)}
                    </p>
                    {conflict.fields && conflict.fields.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {conflict.fields.map((field) => (
                          <span
                            key={field}
                            className="rounded-full bg-surface-3 px-2 py-0.5 text-meta text-muted"
                          >
                            {FIELD_LABELS[field] ?? field}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {sealed ? (
                      <p className="mt-1.5 text-meta leading-relaxed text-subtle">
                        This item is locked. Its versions cannot be previewed here; choosing one replaces the
                        encrypted copy on this device, and opening it still asks for your device unlock.
                      </p>
                    ) : null}
                    {bothBlocked ? (
                      <p className="mt-1.5 text-meta leading-relaxed text-warning">
                        This conflict was recorded while the vault was locked, so its versions were not kept in a
                        usable form. Dismiss this record; the item itself is unchanged.
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-meta text-subtle">{formatRelative(conflict.detectedAt)}</span>
                </div>

                <div className={cn('mt-2.5 flex flex-wrap justify-end gap-2')}>
                  {informational || bothBlocked ? (
                    <Button
                      variant="surface"
                      size="sm"
                      disabled={busy}
                      onClick={() => void apply(conflict, 'dismiss')}
                    >
                      {conflict.reason === 'note-copy' ? 'Keep both versions' : 'Got it'}
                    </Button>
                  ) : (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                        Later
                      </Button>
                      {remoteUsable ? (
                        <Button
                          variant="surface"
                          size="sm"
                          disabled={busy}
                          onClick={() => void apply(conflict, 'remote')}
                        >
                          Use the other device’s
                        </Button>
                      ) : null}
                      {localUsable ? (
                        <Button
                          variant="accentSoft"
                          size="sm"
                          disabled={busy}
                          onClick={() => void apply(conflict, 'local')}
                        >
                          Keep this device’s
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <Button variant="ghost" className="mt-3 w-full" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}
