'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FilePlus2, Plus } from '@/components/ui/icons';
import { useCaptureStore } from '@/stores/capture-store';
import { useVaultStore } from '@/stores/vault-store';
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
 *    mid-sentence.
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

  const run = React.useCallback(async () => {
    if (!onNotes) {
      openManual();
      return;
    }
    setBusy(true);
    const result = await useVaultStore.getState().createNote({ title: 'New note', content: '', parentNoteId: null });
    setBusy(false);
    if (!result.ok) {
      toast(result.message, { tone: 'danger' });
      return;
    }
    router.push(`/notes?note=${result.note.id}`);
  }, [onNotes, openManual, router]);

  const captureStatus = useCaptureStore((state) => state.status);
  const captureMode = useCaptureStore((state) => state.mode);
  const shareTakeover = captureStatus !== 'idle' && captureMode === 'share';

  return {
    visible: !onSettings && !editingNote && !shareTakeover,
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
