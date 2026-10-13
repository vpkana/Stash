'use client';

import * as React from 'react';
import {
  Bold,
  Check,
  Code,
  FilePlus2,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  Lock,
  Quote,
  Strikethrough,
  Unlock,
  X,
} from '@/components/ui/icons';
import type { Note } from '@/db/types';
import { autosaveLabel } from '@/lib/autosave';
import { normaliseLinkHref } from '@/lib/markdown';
import type { EditorCommand } from '@/lib/markdown-html';
import { useAutosave } from '@/hooks/use-autosave';
import { useEditorStore } from '@/stores/editor-store';
import { cn } from '@/lib/utils';
import { RichTextEditor, type RichTextApi } from './rich-text-editor';
import { MarkdownView } from './markdown-view';

/**
 * The note editor.
 *
 * ## What changed, and why
 *
 * The body used to be a `<textarea>` holding Markdown, with a formatting bar that
 * inserted syntax characters. That made formatting a *text edit*: the user pressed
 * Bold and two asterisks appeared around their sentence. The brief for this change
 * is unambiguous — bold has to look bold — so the body is now a rich-text surface
 * and the storage format is still Markdown (see `lib/markdown-html.ts` for why
 * that combination is worth the boundary).
 *
 * ## What the screen is for
 *
 * Writing. The layout says so in the order it puts things in:
 *
 *  1. the title, with the two things that create *structure* beside it;
 *  2. the body, which is everything;
 *  3. one quiet line of status — autosave, and whether the note is protected;
 *  4. one formatting bar, fixed under the thumb, holding *only* formatting.
 *
 * ## Note and Link, beside the title
 *
 * The two buttons next to the title create the two things a note refers to: a
 * **subnote** and a **saved link**. Both insert what they created *at the caret*,
 * which is the point of putting them here rather than in a menu below the text —
 * the user chooses where in the note the reference sits, instead of having it
 * appended wherever the editor happened to think the end was.
 *
 * That placement is why the caret is saved before either button runs: opening the
 * link picker moves focus out of the body, so the position is captured first and
 * restored when the insertion happens.
 *
 * There is no Read/Edit toggle either: the body *is* the formatted view while you
 * write it, and the reading view exists where it always mattered — in the rendered
 * checklist you can tick from the list.
 *
 * ## Autosave
 *
 * Unchanged, and deliberately: no store round-trip per keystroke, no re-render of
 * the tree, no network. The status line says "Saving…" then "Saved" — a modal or a
 * banner for a routine save would be noise — and `flush` runs before the menu
 * actions and before anything that could navigate away.
 */

export interface NoteDraft {
  title: string;
  content: string;
}

export interface NoteEditorProps {
  note: Note;
  /** Persist the draft. Must resolve once storage has accepted it. */
  save: (draft: NoteDraft) => Promise<void>;
  /**
   * A soft lock: the note opens read-only until it is unlocked.
   */
  readOnly?: boolean;
  onUnlock?: () => void;
  /**
   * Create a subnote and insert a reference to it at the caret.
   *
   * The editor saves the caret, calls this, and expects the reference to be
   * inserted by the caller through the API it published — the caller is the one
   * that knows how to make the note.
   */
  onAddSubnote?: () => void;
  /** Open the link picker; the picked link is attached and inserted at the caret. */
  onAttachLink?: () => void;
  /** Receives the insertion API, so the caller can land things at the caret. */
  onApiReady?: (api: RichTextApi) => void;
  /** Follow a subnote reference that was tapped in the body. */
  onOpenReference?: (noteId: string) => void;
  subnoteCount?: number;
  linkCount?: number;
}

export function NoteEditor({
  note,
  save,
  readOnly = false,
  onUnlock,
  onAddSubnote,
  onAttachLink,
  onApiReady,
  onOpenReference,
  subnoteCount = 0,
  linkCount = 0,
}: NoteEditorProps) {
  const [draft, setDraft] = React.useState<NoteDraft>({ title: note.title, content: note.content });
  const [linkDraft, setLinkDraft] = React.useState<string | null>(null);

  const apiRef = React.useRef<RichTextApi | null>(null);
  const titleRef = React.useRef<HTMLInputElement>(null);

  const persisted = React.useMemo(
    () => ({ title: note.title, content: note.content }),
    [note.title, note.content],
  );

  /*
   * Tell the shell a note is open, for as long as this component is mounted.
   *
   * The tab bar is not drawn while an editor is on screen: on Android the soft
   * keyboard resizes the WebView, and a fixed bar at the bottom of the layout is
   * pushed up over the keys. Removing it is the fix; an offset would have to guess
   * a keyboard height, which the brief rules out and which no correct value exists
   * for. The flag is released on unmount, so navigating away restores the bar.
   */
  const setNoteOpen = useEditorStore((state) => state.setNoteOpen);
  React.useEffect(() => {
    setNoteOpen(true);
    return () => setNoteOpen(false);
  }, [setNoteOpen]);

  const { status, flush } = useAutosave<NoteDraft>({
    value: draft,
    persisted,
    save,
    isEqual: (a, b) => a.title === b.title && a.content === b.content,
    enabled: !readOnly,
  });

  const setContent = React.useCallback((content: string) => {
    setDraft((current) => (current.content === content ? current : { ...current, content }));
  }, []);

  const applyLink = React.useCallback(() => {
    const href = normaliseLinkHref(linkDraft ?? '');
    setLinkDraft(null);
    if (!href) return;
    apiRef.current?.insertLink(href);
  }, [linkDraft]);

  /**
   * Both structure buttons work the same way: remember the caret, save what is
   * typed, and let the caller put the new thing there.
   */
  const createAtCaret = React.useCallback(
    (action: () => void) => {
      apiRef.current?.saveSelection();
      void flush().then(action);
    },
    [flush],
  );

  const statusText = autosaveLabel(status);
  const dirty = draft.title !== persisted.title || draft.content !== persisted.content;

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2 px-4 pt-1">
        <input
          ref={titleRef}
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void flush();
              apiRef.current?.focus();
            }
          }}
          placeholder="Title"
          aria-label="Note title"
          maxLength={120}
          autoComplete="off"
          readOnly={readOnly}
          enterKeyHint="next"
          className={cn(
            'min-w-0 flex-1 bg-transparent pt-1 text-display leading-tight font-semibold tracking-tight text-fg',
            'placeholder:text-subtle focus:outline-none',
          )}
        />

        {/*
          * The two structure buttons, beside the name rather than in a panel under
          * the text. Each one writes at the caret, so the reference appears in the
          * sentence being written instead of at the end of the note.
          */}
        {!readOnly ? (
          <div className="flex shrink-0 items-center gap-1 pt-1.5">
            {onAddSubnote ? (
              <button
                type="button"
                onClick={() => createAtCaret(() => onAddSubnote())}
                aria-label="Add a subnote and insert it here"
                title="Add a subnote here"
                className="tap tap-scale flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-meta font-medium text-muted active:bg-surface-3"
              >
                <FilePlus2 size={16} strokeWidth={2} aria-hidden />
                Note
              </button>
            ) : null}
            {onAttachLink ? (
              <button
                type="button"
                onClick={() => createAtCaret(() => onAttachLink())}
                aria-label="Attach a saved link and insert it here"
                title="Attach a link here"
                className="tap tap-scale flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-meta font-medium text-muted active:bg-surface-3"
              >
                <Link2 size={16} strokeWidth={2} aria-hidden />
                Link
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-2">
        <p className="min-w-0 truncate text-meta text-subtle">
          {readOnly
            ? 'Locked · encrypted, reading only'
            : subnoteCount > 0
              ? `${subnoteCount === 1 ? '1 subnote' : `${subnoteCount} subnotes`}${linkCount > 0 ? ` · ${linkCount === 1 ? '1 link' : `${linkCount} links`}` : ''}`
              : 'Writing'}
        </p>
        <span className="flex shrink-0 items-center gap-1.5 text-meta" aria-live="polite" aria-atomic="true">
          {status === 'saving' || status === 'pending' ? (
            <>
              <Loader2 size={12} strokeWidth={2.4} className="animate-spin text-subtle" aria-hidden />
              <span className="text-subtle">{statusText}</span>
            </>
          ) : status === 'error' ? (
            <span className="text-danger">{statusText}</span>
          ) : status === 'saved' && !dirty ? (
            <>
              <Check size={12} strokeWidth={2.6} className="text-success" aria-hidden />
              <span className="text-subtle">{statusText}</span>
            </>
          ) : (
            <span className="text-subtle">Saved</span>
          )}
        </span>
      </div>

      {readOnly ? (
        // Reading, not editing: the rendered view, with its interactive
        // checklists. Nothing here shows Markdown source either.
        <div className="px-4 pb-6">
          <MarkdownView content={draft.content} />
        </div>
      ) : (
        <RichTextEditor
          value={draft.content}
          onChange={setContent}
          placeholder="Start writing…"
          className="px-4 pb-6 text-title leading-relaxed text-fg"
          {...(onOpenReference ? { onOpenReference } : {})}
          onReady={(api) => {
            apiRef.current = api;
            onApiReady?.(api);
          }}
        />
      )}

      {/* Formatting. Fixed above the tab bar so it stays under the thumb and rides
          above the keyboard — and while a note is open the tab bar is not drawn at
          all (see `app-shell.tsx`), so this sits on the bottom edge. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-safe backdrop-blur-xl lg:left-64">
        {readOnly ? (
          <div className="flex items-center gap-3 px-3 py-2">
            <span className="text-meta flex flex-1 items-center gap-2 text-muted">
              <Lock size={15} strokeWidth={2} aria-hidden />
              {onUnlock
                ? 'Encrypted. Unlock to edit again.'
                : 'Locked by a parent note. Unlock that one to edit this.'}
            </span>
            {onUnlock ? (
              <button
                type="button"
                onClick={onUnlock}
                className="tap bg-accent text-accent-fg flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-meta font-semibold"
              >
                <Unlock size={15} strokeWidth={2.2} aria-hidden />
                Unlock
              </button>
            ) : null}
          </div>
        ) : linkDraft !== null ? (
          <div className="flex items-center gap-2 px-3 py-2">
            <input
              value={linkDraft}
              autoFocus
              onChange={(event) => setLinkDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyLink();
                }
                if (event.key === 'Escape') setLinkDraft(null);
              }}
              placeholder="example.com"
              aria-label="Link address"
              inputMode="url"
              autoComplete="off"
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface-2 px-3 text-row text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={applyLink}
              className="tap bg-accent text-accent-fg flex h-10 items-center rounded-xl px-3.5 text-body font-semibold"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setLinkDraft(null)}
              aria-label="Cancel link"
              className="tap tile text-subtle active:bg-surface-2"
            >
              <X size={18} strokeWidth={2} aria-hidden />
            </button>
          </div>
        ) : (
          <div className="scroll-area no-scrollbar flex items-center gap-1 overflow-x-auto px-2 py-1.5">
            <ToolButton label="Bold" icon={<Bold size={17} weight="bold" aria-hidden />} command="bold" api={apiRef} />
            <ToolButton label="Italic" icon={<Italic size={17} weight="bold" aria-hidden />} command="italic" api={apiRef} />
            <ToolButton label="Strikethrough" icon={<Strikethrough size={17} weight="bold" aria-hidden />} command="strike" api={apiRef} />
            <ToolButton label="Inline code" icon={<Code size={17} weight="bold" aria-hidden />} command="code" api={apiRef} />
            <Divider />
            <ToolButton label="Heading" icon={<Heading2 size={17} weight="bold" aria-hidden />} command="heading" api={apiRef} />
            <ToolButton label="Bulleted list" icon={<List size={17} weight="bold" aria-hidden />} command="bulletList" api={apiRef} />
            <ToolButton label="Numbered list" icon={<ListOrdered size={17} weight="bold" aria-hidden />} command="orderedList" api={apiRef} />
            <ToolButton label="Checklist" icon={<ListChecks size={17} weight="bold" aria-hidden />} command="checklist" api={apiRef} />
            <ToolButton label="Quote" icon={<Quote size={17} weight="bold" aria-hidden />} command="quote" api={apiRef} />
            <Divider />
            <button
              type="button"
              onClick={() => setLinkDraft('')}
              aria-label="Insert link"
              title="Insert link"
              className="tap tap-scale flex size-9 shrink-0 items-center justify-center rounded-xl text-muted active:bg-surface-2"
            >
              <Link2 size={17} weight="bold" aria-hidden />
            </button>
          </div>
        )}
      </div>

      {/* Space for the fixed formatting bar. */}
      <div className="h-16" />
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}

/**
 * One formatting button.
 *
 * It does not track state ("is this selection bold?"). A live pressed state would
 * mean re-rendering the toolbar on every selection change, and every such
 * re-render is a chance to fight the editable node for the caret. The buttons act;
 * the document shows the result, which is the immediate feedback that matters.
 */
function ToolButton({
  label,
  icon,
  command,
  api,
}: {
  label: string;
  icon: React.ReactNode;
  command: EditorCommand;
  api: React.RefObject<RichTextApi | null>;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => api.current?.run(command)}
      aria-label={label}
      title={label}
      className="tap tap-scale flex size-9 shrink-0 items-center justify-center rounded-xl text-muted active:bg-surface-2"
    >
      {icon}
    </button>
  );
}
