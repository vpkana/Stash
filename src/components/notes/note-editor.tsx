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
import { NO_FORMATS, type EditorCommand, type FormatState } from '@/lib/markdown-html';
import { useAutosave } from '@/hooks/use-autosave';
import { useEditorStore } from '@/stores/editor-store';
import { cn } from '@/lib/utils';
import { RichTextEditor, type RichTextApi } from './rich-text-editor';
import { NoteTitle, type NoteTitleApi } from './note-title';
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
 * **subnote** and a **link**. Both insert what they made *at the caret*, which is
 * the point of putting them here rather than in a menu below the text — the user
 * chooses where in the note the reference sits, instead of having it appended
 * wherever the editor happened to think the end was.
 *
 * Both also stop short of deciding for the user. The Note button opens a sheet
 * where the subnote is named first, or where an existing note is taken as one,
 * because "make a note" is not a decision about a name and a place — pressing it
 * used to produce an untitled "New subnote" nobody asked for. The Link button
 * opens the picker, which offers the vault's links *and* the address that has been
 * pasted into the search box: the second is written into this note and saved
 * nowhere, because a URL mentioned once is not a thing to file.
 *
 * That placement is why the caret is saved before either button runs: opening the
 * sheet or the picker moves focus out of the body, so the position is captured
 * first and restored when the insertion happens. And a link put on a selection
 * wraps *those words* — the sentence the user selected is the link, not a label
 * the editor chose for them.
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
  /**
   * Which formats are on where the caret is.
   *
   * The one piece of the toolbar that is *state* rather than an action, and the
   * reason the formatting buttons can be read at a glance: Bold is highlighted
   * exactly while typing would produce bold text, so pressing it twice visibly
   * turns it off instead of silently nesting another wrapper.
   */
  const [formats, setFormats] = React.useState<FormatState>(NO_FORMATS);

  const apiRef = React.useRef<RichTextApi | null>(null);
  const titleApiRef = React.useRef<NoteTitleApi | null>(null);


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

  /**
   * Run one toolbar command on the right surface.
   *
   * Inline formats follow the last surface touched; structure (a list, a heading,
   * a quote) belongs to the body by definition — a title has no second line to put
   * an item on.
   */
  const runCommand = React.useCallback((command: EditorCommand) => {
    // Size is a block property; the title's size belongs to the layout.
    const inline =
      command === 'bold' || command === 'italic' || command === 'strike' || command === 'code';
    /*
     * Which surface is focused is read from the DOM at the moment of the press,
     * not remembered from a focus event. The toolbar keeps focus where it was
     * (`mousedown` is cancelled), so `activeElement` is exactly the surface the
     * user is looking at — and unlike a stored flag it cannot be stale, or miss a
     * focus that arrived in the same tick as the tap.
     */
    const surface = document.activeElement?.closest('[data-surface]')?.getAttribute('data-surface');
    if (surface === 'title' && inline) {
      titleApiRef.current?.run(command);
      return;
    }
    apiRef.current?.run(command);
  }, []);

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2 px-4 pt-1">
        <NoteTitle
          value={draft.title}
          onChange={(title) => setDraft((current) => ({ ...current, title }))}
          placeholder="Title"
          readOnly={readOnly}
          onEnter={() => {
            void flush();
            apiRef.current?.focus();
          }}
          onFormatStateChange={setFormats}
          onReady={(api) => {
            titleApiRef.current = api;
          }}
          className="pt-1 text-display leading-tight font-semibold tracking-tight text-fg"
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
          onFormatStateChange={setFormats}
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
            <ToolButton label="Bold" icon={<Bold size={17} weight="bold" aria-hidden />} command="bold" onRun={runCommand} active={formats.bold} />
            <ToolButton label="Italic" icon={<Italic size={17} weight="bold" aria-hidden />} command="italic" onRun={runCommand} active={formats.italic} />
            <ToolButton label="Strikethrough" icon={<Strikethrough size={17} weight="bold" aria-hidden />} command="strike" onRun={runCommand} active={formats.strike} />
            <ToolButton label="Inline code" icon={<Code size={17} weight="bold" aria-hidden />} command="code" onRun={runCommand} active={formats.code} />
            <Divider />
            {/* Text size, on the left where the writing decisions are. */}
            <ToolButton
              label="Smaller text"
              icon={<span className="text-meta font-semibold leading-none">A<span className="align-super text-[0.65em]">−</span></span>}
              command="smaller"
              onRun={runCommand}
            />
            <ToolButton
              label="Larger text"
              icon={<span className="text-body font-semibold leading-none">A<span className="align-super text-[0.65em]">+</span></span>}
              command="larger"
              onRun={runCommand}
            />
            <Divider />
            <ToolButton label="Heading" icon={<Heading2 size={17} weight="bold" aria-hidden />} command="heading" onRun={runCommand} active={formats.heading} />
            <ToolButton label="Bulleted list" icon={<List size={17} weight="bold" aria-hidden />} command="bulletList" onRun={runCommand} />
            <ToolButton label="Numbered list" icon={<ListOrdered size={17} weight="bold" aria-hidden />} command="orderedList" onRun={runCommand} />
            <ToolButton label="Checklist" icon={<ListChecks size={17} weight="bold" aria-hidden />} command="checklist" onRun={runCommand} />
            <ToolButton label="Quote" icon={<Quote size={17} weight="bold" aria-hidden />} command="quote" onRun={runCommand} />
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
 * `active` is the state of the format where the caret is, reported by the editor.
 * It is not derived here by asking the DOM on every render: the answer depends on
 * a selection the browser owns, and the editor is the only place that already
 * watches it. Re-rendering this button is safe because the editor never rebuilds
 * its editable node from props — see the note at the top of `rich-text-editor.tsx`.
 */
function ToolButton({
  label,
  icon,
  command,
  onRun,
  active = false,
}: {
  label: string;
  icon: React.ReactNode;
  command: EditorCommand;
  onRun: (command: EditorCommand) => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      // `preventDefault` keeps the caret in whichever surface is being edited; a
      // button that takes focus would lose the selection it is about to format.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onRun(command)}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'tap tap-scale flex size-9 shrink-0 items-center justify-center rounded-xl active:bg-surface-2',
        active ? 'nav-active font-semibold' : 'text-muted',
      )}
    >
      {icon}
    </button>
  );
}
