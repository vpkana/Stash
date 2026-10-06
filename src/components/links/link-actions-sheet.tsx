'use client';

import * as React from 'react';
import {
  Archive,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  FilePlus2,
  FolderInput,
  Link2Off,
  Lock,
  NotebookPen,
  Share2,
  Star,
  Tag as TagIcon,
  Trash2,
  Unlock,
} from '@/components/ui/icons';
import { useRouter } from 'next/navigation';
import type { Note, SavedLink } from '@/db/types';
import { destinationLabel, INBOX_DESTINATION, folderDestination } from '@/lib/destination';
import { displayUrl, formatShortDate } from '@/lib/format';
import { shareOut } from '@/lib/share/share-out';
import { selectTagsForLink } from '@/stores/vault-store';
import { LinkTagsEditor } from './link-tags-editor';
import { useBackDismiss } from '@/hooks/use-back-dismiss';
import { useVaultStore } from '@/stores/vault-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { ActionList, ActionRow } from '@/components/ui/action-list';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { FolderDestinationList } from '@/components/capture/folder-destination-list';
import { NotePicker } from '@/components/notes/note-picker';

/**
 * Everything you can do to one saved link.
 *
 * The move flow reuses the very same folder list as capture, so "where does
 * this go" behaves identically whether you are saving or reorganising later.
 */

type Mode = 'actions' | 'move' | 'confirm-delete' | 'attach-note' | 'tags';

export interface LinkActionsSheetProps {
  link: SavedLink | null;
  onClose: () => void;
}

export function LinkActionsSheet({ link, onClose }: LinkActionsSheetProps) {
  const router = useRouter();
  const folders = useVaultStore((state) => state.folders);
  const notes = useVaultStore((state) => state.notes);
  const noteLinks = useVaultStore((state) => state.noteLinks);
  const linkId = link?.id;
  // Notes that already reference this link, so a saved link can show what
  // thinking it is attached to.
  const referencingNotes = React.useMemo(() => {
    if (!linkId) return [];
    const notesById = new Map(notes.map((candidate) => [candidate.id, candidate]));
    return noteLinks
      .filter((row) => row.linkId === linkId)
      .map((row) => notesById.get(row.noteId))
      .filter((candidate): candidate is Note => candidate !== undefined);
  }, [linkId, noteLinks, notes]);
  // State is initialised from props and reset by remounting: callers pass a
  // `key` derived from the link id, so a different link always starts clean.
  const [mode, setMode] = React.useState<Mode>('actions');
  const [note, setNote] = React.useState(link?.userNote ?? '');
  const [busy, setBusy] = React.useState(false);
  const keyringPresent = usePrivacyStore((state) => state.keyringPresent);
  const protectedId = link?.id ?? '';
  const isProtected = useVaultStore((state) => state.protection.links.has(protectedId));
  const tagNames = useVaultStore((state) => selectTagsForLink(state, protectedId));

  const close = React.useCallback(() => {
    setMode('actions');
    onClose();
  }, [onClose]);

  useBackDismiss(Boolean(link), close);

  if (!link) return null;

  const noteDirty = note.trim() !== (link.userNote ?? '').trim();

  const openLink = () => {
    void useVaultStore.getState().markLinkOpened(link.id);
    window.open(link.url, '_blank', 'noopener,noreferrer');
    close();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      toast('Link copied');
    } catch {
      toast('Could not copy the link', { tone: 'danger' });
    }
  };

  /**
   * Hand the address to another app.
   *
   * The same act as a capture, in reverse, and it goes through the same seam:
   * Android's chooser. When there is nothing to hand it to, or the platform has
   * no share sheet, the address is copied instead and said so — a share that
   * silently did nothing would be worse than no button.
   */
  const shareLink = async () => {
    const outcome = await shareOut({
      text: link.url,
      ...(link.title?.trim() ? { subject: link.title.trim() } : {}),
      title: link.title?.trim() || displayUrl(link.url, 40),
    });
    if (outcome === 'copied') toast('No share sheet here — address copied', { tone: 'success' });
    else if (outcome === 'failed') toast('Could not share that', { tone: 'danger' });
  };

  const saveNote = async () => {
    setBusy(true);
    await useVaultStore.getState().updateLink(link.id, { userNote: note });
    setBusy(false);
    toast('Note saved', { tone: 'success' });
  };

  const move = async (folderId: string | null) => {
    setBusy(true);
    await useVaultStore.getState().moveLink(link.id, folderId);
    setBusy(false);
    const label = folderId ? destinationLabel(folderDestination(folderId), folders) : 'Inbox';
    toast(`Moved to ${label}`, { tone: 'success' });
    close();
  };

  const attachToNote = async (noteId: string) => {
    setBusy(true);
    const ok = await useVaultStore.getState().attachLink(noteId, link.id, 'attached');
    setBusy(false);
    if (!ok) {
      toast('Already attached to that note', { tone: 'danger' });
      return;
    }
    toast('Attached to note', { tone: 'success' });
    close();
  };

  const createNote = async () => {
    setBusy(true);
    const result = await useVaultStore.getState().createNoteFromLink(link.id);
    setBusy(false);
    if (!result.ok) {
      toast(result.message, { tone: 'danger' });
      return;
    }
    toast('Note created', { tone: 'success' });
    close();
    router.push(`/notes?note=${result.note.id}`);
  };

  /**
   * Deleting is a move to the trash, so the confirmation above is the only
   * warning that is needed and the undo is a real restore rather than a re-save.
   * The action opens the trash rather than restoring inline: a restore needs the
   * whole batch to be meaningful, and that is where it lives.
   */
  const remove = async () => {
    setBusy(true);
    await useVaultStore.getState().deleteLink(link.id);
    setBusy(false);
    toast('Moved to trash', {
      description: 'You can restore it from Settings → Trash.',
      action: {
        label: 'Open trash',
        onSelect: () => router.push('/trash'),
      },
      duration: 6000,
    });
    close();
  };

  const currentFolder = link.folderId ? destinationLabel(folderDestination(link.folderId), folders) : 'Inbox';

  return (
    <Sheet open onOpenChange={(next) => !next && close()}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-start gap-3">
            {mode !== 'actions' ? (
              <button
                type="button"
                onClick={() => setMode('actions')}
                aria-label="Back"
                className="tap -ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-full text-accent active:bg-surface-2"
              >
                <ArrowLeft size={19} strokeWidth={2.1} aria-hidden />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">
                {mode === 'move'
                  ? 'Move to'
                  : mode === 'confirm-delete'
                    ? 'Delete link?'
                    : mode === 'attach-note'
                      ? 'Attach to a note'
                      : mode === 'tags'
                        ? 'Tags'
                        : link.title?.trim() || displayUrl(link.url, 40)}
              </SheetTitle>
              <p className="mt-0.5 truncate text-meta text-subtle">
                {mode === 'move' ? currentFolder : `${link.source ?? ''} · ${formatShortDate(link.createdAt)}`}
              </p>
            </div>
          </div>
        </SheetHeader>

        <SheetBody>
          {mode === 'move' ? (
            <FolderDestinationList
              folders={folders}
              selection={link.folderId ? folderDestination(link.folderId) : INBOX_DESTINATION}
              onSelect={(selection) => void move(selection.kind === 'folder' ? selection.folderId : null)}
              showInbox
              filterPlaceholder="Find a folder"
            />
          ) : mode === 'attach-note' ? (
            <NotePicker
              notes={notes.filter((candidate) => !candidate.isArchived)}
              selectedNoteId={null}
              onSelect={(parentId) => {
                if (parentId) void attachToNote(parentId);
              }}
              filterPlaceholder="Find a note"
            />
          ) : mode === 'tags' ? (
            <div className="px-3 pb-2">
              <LinkTagsEditor key={link.id} linkId={link.id} />
            </div>
          ) : mode === 'confirm-delete' ? (
            <div className="px-3 pb-2">
              <div className="rounded-xl border border-danger/30 bg-danger-soft p-3.5">
                <p className="text-row font-semibold text-danger">This removes the link permanently</p>
                <p className="mt-1.5 text-meta leading-relaxed text-fg/80">
                  “{link.title?.trim() || displayUrl(link.url, 40)}” moves to the trash. Its note and the notes
                  that reference it are left alone, and you can restore it from Settings → Trash.
                </p>
                <div className="mt-3.5 flex gap-2">
                  <Button variant="surface" className="flex-1" onClick={() => setMode('actions')} disabled={busy}>
                    Keep it
                  </Button>
                  <Button variant="danger" className="flex-1" onClick={() => void remove()} disabled={busy}>
                    <Trash2 size={17} strokeWidth={2.1} aria-hidden />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <ActionList className="pb-2">
              {/*
                Address, folder and note read as plain sections of one list
                rather than as cards stacked inside a sheet. Nothing here is
                raised off the page, so nothing here gets a box.
              */}
              <div className="px-4 py-3">
                <p className="text-label text-subtle">Address</p>
                <p className="text-meta mt-1 break-all leading-relaxed text-muted">{link.url}</p>
                <p className="text-label mt-1.5 text-subtle">
                  In {currentFolder}
                  {link.sourcePackage ? ` · via ${link.sourcePackage.split('.').pop()}` : ''}
                </p>
              </div>

              <div className="flex flex-col gap-2 px-4 py-3">
                <label htmlFor="link-note" className="text-label text-subtle">
                  Your note
                </label>
                <Textarea
                  id="link-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Why did you keep this?"
                  className="bg-surface text-row"
                />
                {noteDirty ? (
                  <Button variant="accentSoft" size="sm" onClick={() => void saveNote()} disabled={busy}>
                    <Check size={16} strokeWidth={2.4} aria-hidden />
                    Save note
                  </Button>
                ) : null}
              </div>

              {referencingNotes.length > 0 ? (
                <div className="px-4 py-3">
                  <p className="text-label text-subtle">Referenced in</p>
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    {referencingNotes.map((ref) => (
                      <button
                        key={ref.id}
                        type="button"
                        onClick={() => {
                          close();
                          router.push(`/notes?note=${ref.id}`);
                        }}
                        className="tap flex items-center gap-2 rounded-tap py-1.5 text-left active:bg-surface-2"
                      >
                        <NotebookPen size={14} strokeWidth={1.9} className="shrink-0 text-muted" aria-hidden />
                        <span className="truncate text-body text-fg">{ref.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <ActionRow
                icon={<ExternalLink size={18} strokeWidth={1.9} aria-hidden />}
                label="Open link"
                onClick={openLink}
              />
              <ActionRow
                icon={<Copy size={18} strokeWidth={1.9} aria-hidden />}
                label="Copy address"
                onClick={() => void copyLink()}
              />
              <ActionRow
                icon={<Share2 size={18} strokeWidth={1.9} aria-hidden />}
                label="Share link"
                onClick={() => void shareLink()}
              />
              <ActionRow
                icon={
                  <TagIcon size={18} strokeWidth={1.9} aria-hidden />
                }
                label={tagNames.length > 0 ? `Tags · ${tagNames.join(', ')}` : 'Add tags'}
                onClick={() => setMode('tags')}
              />
              <ActionRow
                icon={
                  <Star
                    size={18}
                    strokeWidth={1.9}
                    className={cn(link.isFavorite && 'fill-warning text-warning')}
                    aria-hidden
                  />
                }
                label={link.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={() => {
                  void useVaultStore.getState().toggleLinkFavorite(link.id);
                  close();
                }}
              />
              <ActionRow
                icon={<FilePlus2 size={18} strokeWidth={1.9} aria-hidden />}
                label="Create note from link"
                onClick={() => void createNote()}
              />
              <ActionRow
                icon={<NotebookPen size={18} strokeWidth={1.9} aria-hidden />}
                label={referencingNotes.length > 0 ? 'Attach to another note' : 'Attach to a note'}
                onClick={() => setMode('attach-note')}
              />
              <ActionRow
                icon={<FolderInput size={18} strokeWidth={1.9} aria-hidden />}
                label="Move to another folder"
                onClick={() => setMode('move')}
              />
              <ActionRow
                icon={
                  link.isLocked ? (
                    <Unlock size={18} strokeWidth={1.9} aria-hidden />
                  ) : (
                    <Lock size={18} strokeWidth={1.9} aria-hidden />
                  )
                }
                label={
                  isProtected && !link.isLocked
                    ? 'Locked by its folder'
                    : link.isLocked
                      ? 'Unlock this link'
                      : 'Lock this link'
                }
                onClick={() => {
                  if (!keyringPresent) {
                    toast('Turn on locking first', { tone: 'danger' });
                    close();
                    router.push('/settings');
                    return;
                  }
                  if (isProtected && !link.isLocked) {
                    toast('This link is inside a locked folder, so it is already protected.');
                    return;
                  }
                  const next = !link.isLocked;
                  void useVaultStore.getState().toggleLinkLocked(link.id).then(() => {
                    toast(next ? 'Locked — the address is now encrypted' : 'Unlocked', { tone: 'success' });
                  });
                  close();
                }}
              />
              {/*
                Link health is recorded, never checked. Stash has no background
                checker and should not have one: it would need the network the
                rest of the app does not need, and a periodic scan of someone's
                saved links is a real privacy cost paid for a guess. What it can
                do is let the user note the truth once — and find it again.
              */}
              <ActionRow
                icon={<Link2Off size={18} strokeWidth={1.9} aria-hidden />}
                label={link.isUnavailable ? 'This link works again' : 'Mark as no longer working'}
                onClick={() => {
                  const next = !link.isUnavailable;
                  void useVaultStore
                    .getState()
                    .setLinkUnavailable(link.id, next)
                    .then(() => toast(next ? 'Marked as unavailable' : 'Marked as working'));
                  close();
                }}
              />
              <ActionRow
                icon={<Archive size={18} strokeWidth={1.9} aria-hidden />}
                label={link.isArchived ? 'Restore from archive' : 'Archive link'}
                onClick={() => {
                  void useVaultStore.getState().archiveLink(link.id, !link.isArchived);
                  toast(link.isArchived ? 'Restored' : 'Archived');
                  close();
                }}
              />
              <ActionRow
                icon={<Trash2 size={18} strokeWidth={1.9} aria-hidden />}
                label="Delete link"
                tone="danger"
                onClick={() => setMode('confirm-delete')}
              />
            </ActionList>
          )}
        </SheetBody>

        {mode === 'actions' ? (
          <SheetFooter>
            <Button variant="surface" className="w-full" onClick={close}>
              Close
            </Button>
          </SheetFooter>
        ) : null}
        {mode === 'attach-note' ? (
          <SheetFooter>
            <Button variant="accentSoft" className="w-full" onClick={() => void createNote()} disabled={busy}>
              <FilePlus2 size={17} strokeWidth={2} aria-hidden />
              New note from this link
            </Button>
          </SheetFooter>
        ) : mode === 'tags' ? (
          <SheetFooter>
            <Button variant="surface" className="w-full" onClick={close}>
              Done
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

