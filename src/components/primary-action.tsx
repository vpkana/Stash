'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FilePlus2, Plus } from '@/components/ui/icons';
import { useCaptureStore } from '@/stores/capture-store';
import { useVaultStore } from '@/stores/vault-store';
import { useFolderAccess } from '@/lib/privacy/access';
import { useEditorStore } from '@/stores/editor-store';
import { INBOX_DESTINATION, folderDestination } from '@/lib/destination';
import { toast } from './ui/toast';
import { cn } from '@/lib/utils';

/**
 * The app's one primary action, and the two shapes it takes.
 *
 * There is exactly one action that is always *the* thing you would do next: on
 * Notes it creates a note, anywhere else it captures a link. It is a single
 * concept, so it is a single hook — and then two presentations, because a
 * floating button that hovers over a 1400px window is a phone habit, not a
 * desktop one, and the sidebar is where a desktop user's hand already is.
 *
 * Three cases make it step aside, and all three are about the button being
 * *wrong* rather than ugly:
 *
 *  - **A note is open in the editor.** The editor owns the bottom of the screen
 *    with its formatting bar, which sits in exactly the space the floating
 *    button occupies, and creating a *new* note is not what anyone is doing
 *    mid-sentence. It is asked of the editor rather than of the URL so the button
 *    and the tab bar agree about it by construction.
 *  - **Settings**, where "add a link" is not a thing the screen is for.
 *  - **A share is being handled**, because the capture surface is the whole
 *    screen by then.
 *
 * It reads `useSearchParams`, so it must be rendered under a `Suspense`
 * boundary — the shell is in the root layout, where there is none above it.
 */
function usePrimaryAction() {
  const pathname = usePathname() ?? '/';
  const params = useSearchParams();
  const router = useRouter();
  const openManual = useCaptureStore((state) => state.openManual);
  const [busy, setBusy] = React.useState(false);

  const onNotes = pathname === '/notes' || pathname.startsWith('/notes/');
  const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const editingNote = onNotes && params.has('note');

  /*
   * Where the user is standing, so the capture sheet does not have to ask.
   *
   * A link saved while browsing `Library → Developer` belongs in `Developer`,
   * and one saved from the Inbox belongs in the Inbox — the destination is
   * already a fact by then, and a second question about it is the step the brief
   * asked to remove.
   *
   * The folder is only used as context when the session may actually read it.
   * Parking on a locked folder's page and tapping "add a link" must not turn a
   * save into a lock prompt; in that case there is no usable context and the
   * remembered destination applies instead.
   */
  const folderParam = params.get('folder');
  const onLibrary = pathname === '/library' || pathname.startsWith('/library/');
  const browsingFolderId = onLibrary && folderParam ? folderParam : null;
  const browsingAccess = useFolderAccess(browsingFolderId);
  const onInbox = pathname === '/inbox' || pathname.startsWith('/inbox/');

  const contextSelection = React.useMemo(() => {
    if (browsingFolderId && !browsingAccess.locked) return folderDestination(browsingFolderId);
    if (!browsingFolderId && onInbox) return INBOX_DESTINATION;
    return undefined;
  }, [browsingFolderId, browsingAccess.locked, onInbox]);

  const run = React.useCallback(async () => {
    if (!onNotes) {
      openManual(contextSelection);
      return;
    }
    // On Notes the primary action makes a note — always a top-level one. A
    // subnote is created from inside the note it belongs to, which is where the
    // hierarchy makes it obvious what the new note is a child of.
    setBusy(true);
    const result = await useVaultStore.getState().createNote({ title: 'New note', content: '', parentNoteId: null });
    setBusy(false);
    if (!result.ok) {
      toast(result.message, { tone: 'danger' });
      return;
    }
    router.push(`/notes?note=${result.note.id}`);
  }, [onNotes, openManual, router, contextSelection]);

  const captureStatus = useCaptureStore((state) => state.status);
  const captureMode = useCaptureStore((state) => state.mode);
  const shareTakeover = captureStatus !== 'idle' && captureMode === 'share';
  const noteOpen = useEditorStore((state) => state.noteOpen);

  return {
    visible: !onSettings && !editingNote && !noteOpen && !shareTakeover,
    label: onNotes ? 'New note' : 'Add a link',
    busy,
    run,
    onNotes,
  };
}

export function PrimaryActionButton({ variant, className }: { variant: 'floating' | 'sidebar'; className?: string }) {
  const { visible, label, busy, run, onNotes } = usePrimaryAction();
  if (!visible) return null;

  const glyph = onNotes ? (
    <FilePlus2 size={variant === 'sidebar' ? 19 : 25} strokeWidth={2.1} aria-hidden />
  ) : (
    <Plus size={variant === 'sidebar' ? 19 : 26} strokeWidth={2.2} aria-hidden />
  );

  if (variant === 'sidebar') {
    return (
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className={cn(
          'tap tap-scale flex h-11 w-full items-center justify-center gap-2 rounded-control',
          'bg-accent text-row font-semibold text-accent-fg disabled:opacity-60',
          className,
        )}
      >
        {glyph}
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      aria-label={label}
      className={cn(
        // `bottom-20 mb-safe` sits it one clear step above the tab bar, and adds
        // the system inset through the same variable the bar itself uses.
        'tap tap-scale absolute right-4 bottom-20 z-30 mb-safe',
        'flex size-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-raised',
        'disabled:opacity-60 lg:hidden',
        className,
      )}
    >
      {glyph}
    </button>
  );
}
