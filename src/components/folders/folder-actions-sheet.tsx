'use client';

import * as React from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowUpDown,
  Check,
  FolderInput,
  FolderPlus,
  Lock,
  Pencil,
  Share2,
  Star,
  Trash2,
  Unlock,
} from '@/components/ui/icons';
import { useRouter } from 'next/navigation';
import type { Folder } from '@/db/types';
import { FOLDER_ICON_CHOICES, Icon } from '@/components/ui/icon';
import { canMoveFolder, descendantIdsOf, folderPathLabel, type MoveCheck } from '@/lib/tree';
import { pluralize } from '@/lib/format';
import { folderDigest, shareOut } from '@/lib/share/share-out';
import { useBackDismiss } from '@/hooks/use-back-dismiss';
import { useVaultStore } from '@/stores/vault-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { ActionList, ActionRow } from '@/components/ui/action-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { FolderDestinationList } from '@/components/capture/folder-destination-list';
import { CreateFolderInline } from '@/components/capture/create-folder-inline';
import { INBOX_DESTINATION, folderDestination } from '@/lib/destination';

/**
 * Folder management.
 *
 * Deleting a folder never happens as a side effect: the sheet states exactly what
 * is inside, offers "move contents up" as the default, and requires an explicit
 * choice before anything moves. Neither choice destroys anything — the second
 * one puts the folder and its links in the trash as one batch, which is what
 * makes a mis-tap on a folder with ninety links in it recoverable.
 */

type Mode = 'actions' | 'rename' | 'move' | 'delete' | 'subfolder';

export interface FolderActionsSheetProps {
  folder: Folder | null;
  onClose: () => void;
  /** Called after a successful delete so callers can leave the folder view. */
  onDeleted?: (folderId: string) => void;
}

export function FolderActionsSheet({ folder, onClose, onDeleted }: FolderActionsSheetProps) {
  const router = useRouter();
  const folders = useVaultStore((state) => state.folders);
  const links = useVaultStore((state) => state.links);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);
  const protectedId = folder?.id ?? '';
  const isProtected = useVaultStore((state) => state.protection.folders.has(protectedId));
  // Reset by remount: callers pass a `key` derived from the folder id.
  const [mode, setMode] = React.useState<Mode>('actions');
  const [name, setName] = React.useState(folder?.name ?? '');
  const [icon, setIcon] = React.useState<string>(folder?.icon ?? 'folder');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const close = React.useCallback(() => {
    setMode('actions');
    onClose();
  }, [onClose]);

  useBackDismiss(Boolean(folder), close);

  const impact = React.useMemo(() => {
    if (!folder) return null;
    const descendants = new Set<string>();
    const queue = [folder.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const candidate of folders) {
        if (candidate.parentId === current && !descendants.has(candidate.id)) {
          descendants.add(candidate.id);
          queue.push(candidate.id);
        }
      }
    }
    const direct = links.filter((link) => !link.isArchived && link.folderId === folder.id).length;
    const nested = links.filter(
      (link) => !link.isArchived && link.folderId !== null && descendants.has(link.folderId),
    ).length;
    return { descendants: descendants.size, direct, nested, total: direct + nested };
  }, [folder, folders, links]);

  if (!folder) return null;

  const parentLabel = folder.parentId ? folderPathLabel(folders, folder.parentId) : 'Top level';
  const moveCheck: MoveCheck = canMoveFolder(folders, folder.id, folder.parentId);

  /**
   * Archiving is the gentle alternative to deleting: nothing leaves the vault,
   * the links simply stop showing up in the folder. Scoped to this folder's own
   * subtree so a parent folder is never touched by a child's action.
   */
  const archiveFolderAndContents = async () => {
    setBusy(true);
    const subtreeIds = new Set<string>([folder.id]);
    for (const candidate of folders) {
      if (candidate.parentId === folder.id) subtreeIds.add(candidate.id);
    }
    const targets = links.filter(
      (link) => !link.isArchived && link.folderId !== null && subtreeIds.has(link.folderId),
    );
    for (const link of targets) {
      await useVaultStore.getState().archiveLink(link.id, true);
    }
    setBusy(false);
    toast(targets.length > 0 ? `Archived ${pluralize(targets.length, 'link')}` : 'Nothing to archive');
    close();
  };

  const handleRename = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Give the folder a name.');
      return;
    }
    setBusy(true);
    const ok = await useVaultStore.getState().renameFolder(folder.id, trimmed);
    if (!ok) {
      setBusy(false);
      setError('Another folder here already uses that name.');
      return;
    }
    if (icon !== (folder.icon ?? 'folder')) {
      await useVaultStore.getState().setFolderEmojiIcon(folder.id, icon);
    }
    setBusy(false);
    toast('Folder updated', { tone: 'success' });
    close();
  };

  const handleMove = async (targetParentId: string | null) => {
    setBusy(true);
    const result = await useVaultStore.getState().moveFolder(folder.id, targetParentId);
    setBusy(false);
    if (!result.ok) {
      toast(result.reason, { tone: 'danger' });
      return;
    }
    toast('Folder moved', { tone: 'success' });
    close();
  };

  /**
   * Send the folder's contents to another app as readable lines.
   *
   * Sharing the *structure* rather than a database file is deliberate: a digest
   * of titles and addresses is useful in any messaging app on any platform, while
   * a partial Stash backup would need its own format version, its own validation
   * and its own reader — and would still be unreadable to whoever received it.
   */
  const shareContents = async () => {
    const subtree = new Set<string>([folder.id, ...descendantIdsOf(folders, folder.id)]);
    const inside = links.filter(
      (link) => !link.isArchived && link.folderId !== null && subtree.has(link.folderId),
    );
    if (inside.length === 0) {
      toast('Nothing in this folder to share yet');
      return;
    }

    const text = folderDigest({
      name: folder.name,
      links: inside.map((link) => ({
        url: link.url,
        ...(link.title ? { title: link.title } : {}),
        ...(link.folderId ? { folderPath: folderPathLabel(folders, link.folderId) } : {}),
      })),
    });

    const outcome = await shareOut({ text, title: folder.name });
    if (outcome === 'copied') toast(`Copied ${pluralize(inside.length, 'link')} to the clipboard`);
    else if (outcome === 'failed') toast('Could not share that', { tone: 'danger' });
    close();
  };

  const handleDelete = async (strategy: 'move-contents-up' | 'delete-everything') => {
    setBusy(true);
    const ok = await useVaultStore.getState().deleteFolder(folder.id, strategy);
    setBusy(false);
    if (!ok) {
      toast('Could not delete that folder', { tone: 'danger' });
      return;
    }
    toast(strategy === 'move-contents-up' ? 'Folder removed, contents kept' : 'Moved to trash', {
      tone: strategy === 'move-contents-up' ? 'success' : 'default',
      ...(strategy === 'move-contents-up'
        ? {}
        : { description: 'The whole folder is recoverable from Settings → Trash.' }),
    });
    onDeleted?.(folder.id);
    close();
  };

  return (
    <Sheet open onOpenChange={(next) => !next && close()}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-start gap-3">
            {mode !== 'actions' ? (
              <button
                type="button"
                onClick={() => {
                  setMode('actions');
                  setError(null);
                }}
                aria-label="Back"
                className="tap -ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-full text-accent active:bg-surface-2"
              >
                <ArrowLeft size={19} strokeWidth={2.1} aria-hidden />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">
                {mode === 'rename'
                  ? 'Rename folder'
                  : mode === 'move'
                    ? 'Move folder'
                    : mode === 'delete'
                      ? 'Delete folder?'
                      : mode === 'subfolder'
                        ? 'New subfolder'
                        : folder.name}
              </SheetTitle>
              <p className="mt-0.5 truncate text-meta text-subtle">
                {mode === 'actions' ? `${parentLabel} · ${pluralize(impact?.total ?? 0, 'link')}` : folderPathLabel(folders, folder.id)}
              </p>
            </div>
          </div>
        </SheetHeader>

        <SheetBody>
          {mode === 'subfolder' ? (
            <CreateFolderInline
              folders={folders}
              defaultParentId={folder.id}
              onCancel={() => setMode('actions')}
              onCreated={(created) => {
                toast(`Created “${created.name}”`, { tone: 'success' });
                close();
              }}
            />
          ) : mode === 'rename' ? (
            <div className="flex flex-col gap-3 px-3 pb-2">
              <div className="flex items-center gap-2">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <Icon name={icon} size={20} strokeWidth={1.9} />
                </span>
                <Input
                  value={name}
                  autoFocus
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleRename();
                    }
                  }}
                  aria-label="Folder name"
                  enterKeyHint="done"
                  maxLength={80}
                />
              </div>
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 no-scrollbar" role="radiogroup" aria-label="Folder icon">
                {FOLDER_ICON_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={icon === choice}
                    aria-label={choice}
                    onClick={() => setIcon(choice)}
                    className={cn(
                      'tap flex size-9 shrink-0 items-center justify-center rounded-xl border',
                      icon === choice
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-border bg-surface-2 text-subtle',
                    )}
                  >
                    <Icon name={choice} size={16} strokeWidth={1.9} />
                  </button>
                ))}
              </div>
              {error ? (
                <p className="rounded-lg bg-danger-soft px-3 py-2 text-meta text-danger">{error}</p>
              ) : null}
            </div>
          ) : mode === 'move' ? (
            <FolderDestinationList
              folders={folders}
              selection={folder.parentId ? folderDestination(folder.parentId) : INBOX_DESTINATION}
              onSelect={(selection) => void handleMove(selection.kind === 'folder' ? selection.folderId : null)}
              showInbox
              filterPlaceholder="Find a destination"
            />
          ) : mode === 'delete' ? (
            <div className="flex flex-col gap-3 px-4 pb-2">
              <div className="pt-3">
                <p className="text-row font-semibold text-fg">“{folder.name}” contains</p>
                <ul className="text-meta mt-1.5 flex flex-col gap-1 text-muted">
                  <li>· {pluralize(impact?.direct ?? 0, 'link')} directly in this folder</li>
                  <li>· {pluralize(impact?.nested ?? 0, 'link')} in its subfolders</li>
                  <li>· {pluralize(impact?.descendants ?? 0, 'subfolder')}</li>
                </ul>
              </div>

              <div className="flex flex-col gap-2">
                <ChoiceCard
                  title="Delete the folder, keep the links"
                  description={`Links move to ${parentLabel} and stay in your vault.`}
                  recommended
                  onClick={() => void handleDelete('move-contents-up')}
                  disabled={busy}
                />
                <ChoiceCard
                  title="Delete the folder and everything in it"
                  description={`${pluralize(impact?.total ?? 0, 'link')} and ${pluralize(impact?.descendants ?? 0, 'subfolder')} move to the trash together, and come back together.`}
                  destructive
                  onClick={() => void handleDelete('delete-everything')}
                  disabled={busy}
                />
                <Button variant="ghost" className="w-full" onClick={() => setMode('actions')} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <ActionList className="pb-2">
              <ActionRow
                icon={<Pencil size={18} strokeWidth={1.9} aria-hidden />}
                label="Rename or change icon"
                onClick={() => setMode('rename')}
              />
              <ActionRow
                icon={<FolderPlus size={18} strokeWidth={1.9} aria-hidden />}
                label={`New folder inside “${folder.name}”`}
                onClick={() => setMode('subfolder')}
              />
              <ActionRow
                icon={<FolderInput size={18} strokeWidth={1.9} aria-hidden />}
                label="Move to another folder"
                onClick={() => setMode('move')}
              />
              <ActionRow
                icon={
                  folder.isLocked ? (
                    <Unlock size={18} strokeWidth={1.9} aria-hidden />
                  ) : (
                    <Lock size={18} strokeWidth={1.9} aria-hidden />
                  )
                }
                label={
                  // "Locked by a parent" is a real state, not an edge case: the
                  // lock is inherited, so this folder cannot release itself.
                  isProtected && !folder.isLocked
                    ? 'Locked by a parent folder'
                    : folder.isLocked
                      ? 'Unlock this folder'
                      : 'Lock this folder'
                }
                onClick={() => {
                  if (!keyringPresent) {
                    toast('Turn on locking first', { tone: 'danger' });
                    close();
                    router.push('/settings');
                    return;
                  }
                  if (isProtected && !folder.isLocked) {
                    toast('A folder inside a locked folder inherits its lock. Unlock the parent instead.');
                    return;
                  }
                  const next = !folder.isLocked;
                  void useVaultStore.getState().toggleFolderLocked(folder.id).then(() => {
                    toast(
                      next
                        ? 'Locked — its contents need your unlock from now on'
                        : 'Unlocked — this folder opens normally again',
                      { tone: 'success' },
                    );
                  });
                  close();
                }}
              />
              <ActionRow
                icon={
                  <Star
                    size={18}
                    strokeWidth={1.9}
                    className={cn(folder.isFavorite && 'fill-warning text-warning')}
                    aria-hidden
                  />
                }
                label={folder.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={() => {
                  void useVaultStore.getState().toggleFolderFavorite(folder.id);
                  close();
                }}
              />
              <ActionRow
                icon={<ArrowUpDown size={18} strokeWidth={1.9} aria-hidden />}
                label="Move up in this list"
                onClick={() => {
                  void useVaultStore
                    .getState()
                    .reorderFolder(folder.id, 'up')
                    .then((ok) => toast(ok ? 'Moved up' : 'Already at the top'));
                }}
              />
              <ActionRow
                icon={<ArrowUpDown size={18} strokeWidth={1.9} className="rotate-180" aria-hidden />}
                label="Move down in this list"
                onClick={() => {
                  void useVaultStore
                    .getState()
                    .reorderFolder(folder.id, 'down')
                    .then((ok) => toast(ok ? 'Moved down' : 'Already at the bottom'));
                }}
              />
              <ActionRow
                icon={<Share2 size={18} strokeWidth={1.9} aria-hidden />}
                label="Share the links inside"
                onClick={() => void shareContents()}
              />
              <ActionRow
                icon={<Archive size={18} strokeWidth={1.9} aria-hidden />}
                label="Archive the links inside"
                onClick={() => void archiveFolderAndContents()}
              />
              <ActionRow
                icon={<Trash2 size={18} strokeWidth={1.9} aria-hidden />}
                label="Delete folder"
                tone="danger"
                onClick={() => setMode('delete')}
              />
              {!moveCheck.ok ? <p className="text-label px-4 pb-3 text-subtle">{moveCheck.reason}</p> : null}
              {!keyringPresent ? (
                <p className="text-label px-4 pb-3 leading-relaxed text-subtle">
                  Locking encrypts a folder and everything inside it. Turn it on in Settings with your device
                  lock.
                </p>
              ) : null}
            </ActionList>
          )}
        </SheetBody>

        {mode === 'rename' ? (
          <SheetFooter>
            <Button variant="primary" size="lg" className="w-full" onClick={() => void handleRename()} disabled={busy}>
              <Check size={18} strokeWidth={2.4} aria-hidden />
              Save changes
            </Button>
          </SheetFooter>
        ) : mode === 'actions' ? (
          <SheetFooter>
            <Button variant="surface" className="w-full" onClick={close}>
              Close
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}


function ChoiceCard({
  title,
  description,
  onClick,
  recommended = false,
  destructive = false,
  disabled = false,
}: {
  title: string;
  description: string;
  onClick: () => void;
  recommended?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'tap flex w-full flex-col gap-1 rounded-xl border p-3.5 text-left disabled:opacity-50',
        destructive
          ? 'border-danger/30 bg-danger-soft active:bg-danger-soft/70'
          : 'border-accent/30 bg-accent-soft active:bg-accent-soft/70',
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn('text-row font-semibold', destructive ? 'text-danger' : 'text-accent')}>
          {title}
        </span>
        {recommended ? (
          <span className="text-label font-semibold text-accent">
            Safer
          </span>
        ) : null}
      </span>
      <span className="text-meta leading-relaxed text-fg/80">{description}</span>
    </button>
  );
}
