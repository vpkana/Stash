'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, RotateCcw, ShieldAlert, Trash2 } from '@/components/ui/icons';
import type { TrashEntry } from '@/db/types';
import { pluralize, formatShortDate } from '@/lib/format';
import { describeTrashEntry } from '@/lib/trash';
import { useVaultStore } from '@/stores/vault-store';
import { Button } from '@/components/ui/button';
import { EmptyState, ListSurface, PageHeader, PageTitle, Section } from '@/components/ui/page';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * The Trash.
 *
 * Deleting is a move, not a destruction, and this is the screen that makes that
 * promise concrete. Everything here can still be brought back exactly as it was,
 * which is why the restore button is the loud one and emptying the trash is the
 * quiet, twice-confirmed one.
 *
 * Entries are the *acts*, not the rows. Throwing away a folder with ninety links
 * inside is one decision and comes back as one; listing it as ninety-one items
 * would be a description of the database rather than of what happened.
 */
export default function TrashPage() {
  const router = useRouter();
  const groups = useVaultStore((state) => state.trashGroups);
  const loaded = useVaultStore((state) => state.trashLoaded);
  const loadTrash = useVaultStore((state) => state.loadTrash);

  const [busyBatch, setBusyBatch] = React.useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = React.useState(false);
  const [emptying, setEmptying] = React.useState(false);

  React.useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  const restore = async (entry: TrashEntry) => {
    setBusyBatch(entry.batch);
    const impact = await useVaultStore.getState().restoreTrash(entry.batch);
    setBusyBatch(null);
    const total = impact.folders + impact.links + impact.notes;
    if (total === 0) {
      toast('Nothing to restore', { tone: 'danger' });
      return;
    }
    toast(
      impact.rehomed > 0
        ? `Restored ${pluralize(total, 'item')} — ${pluralize(impact.rehomed, 'item')} moved out, its old place was gone`
        : `Restored ${pluralize(total, 'item')}`,
      { tone: 'success' },
    );
  };

  const restoreEverything = async () => {
    setBusyBatch('*');
    const impact = await useVaultStore.getState().restoreAllTrash();
    setBusyBatch(null);
    toast(`Restored ${pluralize(impact.folders + impact.links + impact.notes, 'item')}`, { tone: 'success' });
  };

  const purge = async (entry: TrashEntry) => {
    setBusyBatch(entry.batch);
    const impact = await useVaultStore.getState().purgeTrash(entry.batch);
    setBusyBatch(null);
    toast(`Deleted ${pluralize(impact.folders + impact.links + impact.notes, 'item')} for good`, {
      tone: 'danger',
    });
  };

  const emptyEverything = async () => {
    setEmptying(true);
    const impact = await useVaultStore.getState().emptyTrashNow();
    setEmptying(false);
    setConfirmEmpty(false);
    toast(`Emptied the trash — ${pluralize(impact.folders + impact.links + impact.notes, 'item')} deleted`, {
      tone: 'danger',
    });
  };

  const total = groups.reduce(
    (sum, entry) => sum + entry.folderCount + entry.linkCount + entry.noteCount,
    0,
  );

  return (
    <>
      <PageHeader>
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => router.push('/settings')}
            aria-label="Back to Settings"
            className="tap -ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
          >
            <ArrowLeft size={19} strokeWidth={2} aria-hidden />
          </button>
          <div className="min-w-0 flex-1">
            <PageTitle
              subtitle={
                total === 0 ? 'Nothing is thrown away' : `${pluralize(total, 'item')} you can still get back`
              }
            >
              Trash
            </PageTitle>
          </div>
        </div>
      </PageHeader>

      {!loaded ? (
        <p className="flex items-center gap-2 px-5 py-6 text-body text-muted">
          <Loader2 size={16} strokeWidth={2.4} className="animate-spin" aria-hidden />
          Reading the trash…
        </p>
      ) : groups.length === 0 ? (
        <div className="px-4 pt-4">
          <EmptyState
            icon={<Trash2 size={22} strokeWidth={1.7} />}
            title="The trash is empty"
            description="Deleting a link, note or folder only moves it here. Nothing leaves your vault until you empty the trash, and this screen is where that would show up."
          />
        </div>
      ) : (
        <>
          <Section
            title="Thrown away"
            action="Restore all"
            onAction={() => void restoreEverything()}
          >
            <ListSurface>
              {groups.map((entry) => (
                <TrashRow
                  key={entry.batch}
                  entry={entry}
                  busy={busyBatch === entry.batch || busyBatch === '*'}
                  onRestore={() => void restore(entry)}
                  onPurge={() => void purge(entry)}
                />
              ))}
            </ListSurface>
            <p className="px-5 pt-3 text-meta leading-relaxed text-subtle">
              Restoring puts everything back where it was, with the same names, the same order and the same
              addresses. If a parent folder is gone for good, the item comes back at the top level rather than
              pointing at a place that no longer exists.
            </p>
          </Section>

          <Section title="Delete for good" className="pb-10">
            <div className="mx-4 rounded-2xl border border-danger/30 bg-danger-soft p-4">
              <p className="text-row font-semibold text-danger">Empty the trash</p>
              <p className="mt-1.5 text-meta leading-relaxed text-fg/80">
                Permanently removes {pluralize(total, 'item')} from this device. There is no undo after this — the
                only action in Stash that cannot be taken back. Export a backup first if you are unsure.
              </p>
              {confirmEmpty ? (
                <div className="mt-3.5 flex gap-2">
                  <Button variant="surface" className="flex-1" onClick={() => setConfirmEmpty(false)} disabled={emptying}>
                    Keep them
                  </Button>
                  <Button variant="danger" className="flex-1" onClick={() => void emptyEverything()} disabled={emptying}>
                    <Trash2 size={17} strokeWidth={2.1} aria-hidden />
                    Empty trash
                  </Button>
                </div>
              ) : (
                <Button variant="danger" className="mt-3.5 w-full" onClick={() => setConfirmEmpty(true)}>
                  <Trash2 size={17} strokeWidth={2.1} aria-hidden />
                  Empty the trash…
                </Button>
              )}
            </div>
          </Section>
        </>
      )}

      <div className="h-6" />
    </>
  );
}

function TrashRow({
  entry,
  busy,
  onRestore,
  onPurge,
}: {
  entry: TrashEntry;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const description = describeTrashEntry(entry);

  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl',
            entry.kind === 'folder' ? 'bg-surface text-muted' : 'bg-surface text-subtle',
          )}
          aria-hidden
        >
          <Trash2 size={16} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-row leading-tight font-medium text-fg">
            {entry.label.trim() || 'Locked item'}
          </p>
          <p className="mt-0.5 truncate text-meta text-subtle">
            {entry.kind === 'folder' ? 'Folder' : entry.kind === 'note' ? 'Note' : 'Link'}
            {description ? ` · ${description}` : ''}
          </p>
          <p className="mt-0.5 truncate text-meta text-subtle">
            {entry.path} · deleted {formatShortDate(entry.deletedAt)}
          </p>
        </div>
      </div>

      {confirming ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-meta text-danger">
            <ShieldAlert size={13} strokeWidth={2.2} aria-hidden />
            Gone for good?
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={onPurge} disabled={busy}>
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button variant="accentSoft" size="sm" className="flex-1" onClick={onRestore} disabled={busy}>
            {busy ? (
              <Loader2 size={15} strokeWidth={2.4} className="animate-spin" aria-hidden />
            ) : (
              <RotateCcw size={15} strokeWidth={2.1} aria-hidden />
            )}
            Restore
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} disabled={busy}>
            Delete for good
          </Button>
        </div>
      )}
    </div>
  );
}
