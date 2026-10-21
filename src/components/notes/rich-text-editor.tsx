'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  activeFormats,
  enclosingAnchor,
  htmlToMarkdown,
  markdownToHtml,
  runEditorCommand,
  escapeHtml,
  type EditorCommand,
  type FormatState,
} from '@/lib/markdown-html';
import { trailingUrl } from '@/lib/markdown';

/**
 * The note body, edited as rich text and stored as Markdown.
 *
 * ## Why it is uncontrolled
 *
 * The editable node is written to exactly twice: once on mount, and once when the
 * Markdown coming in from outside differs from the Markdown this editor last
 * produced. Every keystroke goes *out* to `onChange`, and nothing re-renders the
 * node from that value.
 *
 * That is not an optimisation, it is the only way this works. A contentEditable
 * that re-renders from state loses the caret and the selection on every character:
 * React replaces the DOM the browser is editing, and the browser puts the cursor
 * back at the start. So the Markdown is the source of truth *at rest* — saving,
 * reloading, switching notes — and the DOM is the source of truth *while typing*.
 * The `lastEmitted` ref is the hinge between the two.
 *
 * ## Markdown, still
 *
 * The note is serialised back to Markdown on every input event, so autosave writes
 * the same portable format it always did and a note written by an older build
 * opens with all of its formatting intact. What changed is only what the user
 * *sees* while typing.
 *
 * ## Checklists
 *
 * A checklist item is an `<li data-checkbox>`: a real list item whose box is drawn
 * by CSS, so the marker is never part of the text and the serialiser can put
 * `- [ ] ` back exactly where it came from. Toggling one is a click on the box,
 * handled here rather than by `execCommand`, which has no concept of it.
 */
export interface RichTextEditorProps {
  /** Markdown to edit. Changes are adopted only when they come from elsewhere. */
  value: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  /** Receives the command API so a toolbar can drive the selection. */
  onReady?: (api: RichTextApi) => void;
  /**
   * Reports which formats are on where the caret is.
   *
   * The toolbar lights its buttons from this. It fires on every selection change
   * and after every command, which is what makes a toggle read as a toggle: the
   * Bold button is highlighted exactly while typing would produce bold text.
   */
  onFormatStateChange?: (state: FormatState) => void;
  /**
   * Open the subnote an in-body reference points at.
   *
   * A note can hold a reference to one of its subnotes (`#note=<id>`, inserted at
   * the caret by the Note button beside the title), and this is what turns that
   * reference into navigation instead of a dead link.
   */
  onOpenReference?: (noteId: string) => void;
  /** The body gained focus — the toolbar targets whichever surface was last used. */
  onFocus?: () => void;
  ariaLabel?: string;
}

export interface RichTextApi {
  run: (command: EditorCommand) => void;
  /**
   * Remember where the caret is.
   *
   * Called *before* a dialog or a sheet opens, because opening one moves focus
   * out of the editable node and the selection is gone by the time the user has
   * chosen something. Restoring it is what makes "insert it where my cursor is"
   * mean the place the user was actually looking at.
   */
  saveSelection: () => void;
  /** Wrap the remembered selection (or the current one) in a link. */
  insertLink: (href: string, label?: string) => void;
  /** Insert an address at the caret: the selection becomes the link's text, and
   * with nothing selected the address is inserted as the words the user sees. */
  insertAddress: (href: string) => void;
  /** Insert a reference to a subnote at the remembered caret. */
  insertNoteReference: (noteId: string, title: string) => void;
  /** Insert plain text at the caret, as a paragraph. */
  insertText: (text: string) => void;
  focus: () => void;
}

export function RichTextEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
  className,
  onReady,
  onFormatStateChange,
  onOpenReference,
  onFocus,
  ariaLabel = 'Note body',
}: RichTextEditorProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  /**
   * Where the caret was when the last dialog opened.
   *
   * A live `Range` is only valid while the DOM around it is unchanged, and the
   * parent re-renders in between (a sheet opening, an attachment landing), so the
   * remembered range is re-validated before use rather than trusted.
   */
  const savedRange = React.useRef<Range | null>(null);
  /**
   * The Markdown this editor last produced, so an incoming change that is *its
   * own* output is not applied back as a DOM rewrite. Comparing against the value
   * prop directly would be the same thing until the first time two different
   * Markdown strings serialise to the same document — `**a**` and `__a__`, say —
   * at which point a re-render mid-sentence would eat the caret.
   */
  const lastEmitted = React.useRef<string | null>(null);
  /**
   * The latest `onChange`, kept in a ref so an input event never depends on the
   * identity of the callback the parent happened to render with — a stale closure
   * here would drop a keystroke's worth of content, which is exactly the kind of
   * loss this editor must not have. Synced in an effect, because a ref written
   * during render is a value the commit may never publish.
   */
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  /** Same reason as {@link onChangeRef}: a stale callback would light the wrong button. */
  const onFormatsRef = React.useRef(onFormatStateChange);
  React.useEffect(() => {
    onFormatsRef.current = onFormatStateChange;
  }, [onFormatStateChange]);

  // Mount: build the document from the note.
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.innerHTML = markdownToHtml(value);
    lastEmitted.current = value;
    // Intentionally mount-only: `value` is adopted at the moment the note opens
    // (the editor is keyed by note id), and after that the DOM leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Keep the caret on screen when the soft keyboard changes the viewport.
   *
   * Android resizes the window for the keyboard (`adjustResize` in the manifest),
   * and the browser scrolls the caret into view on its own *when it has room to*.
   * It often does not: the writing toolbar is pinned to the bottom, so the last
   * visible line is behind it, and a long note typed near the bottom ends up with
   * the caret hidden under the bar.
   *
   * The measurement is `visualViewport.height` rather than a keyboard height, and
   * the correction is `scrollIntoView({ block: 'center' })` rather than an offset,
   * so nothing here encodes a number that differs per device. It only acts when
   * the caret is genuinely below the visible floor, so it never fights the user
   * for the scroll position while they are reading.
   */
  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;

    const ensureCaretVisible = () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      if (!element.contains(selection.anchorNode)) return;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const parent = range.startContainer.parentElement;
      const bottom = rect.height > 0 ? rect.bottom : (parent?.getBoundingClientRect().bottom ?? 0);
      if (bottom <= viewport.height) return;
      (parent ?? element).scrollIntoView({ block: 'center' });
    };

    viewport.addEventListener('resize', ensureCaretVisible);
    return () => viewport.removeEventListener('resize', ensureCaretVisible);
  }, []);

  // An external change — a different note, or an unlock restoring sealed content.
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (value === lastEmitted.current) return;
    element.innerHTML = markdownToHtml(value);
    lastEmitted.current = value;
  }, [value]);

  const read = React.useCallback(() => {
    const element = ref.current;
    if (!element) return '';
    return htmlToMarkdown(element as unknown as Parameters<typeof htmlToMarkdown>[0]);
  }, []);

  const emit = React.useCallback(() => {
    const markdown = read();
    lastEmitted.current = markdown;
    onChangeRef.current(markdown);
  }, [read]);

  const publishFormats = React.useCallback(() => {
    onFormatsRef.current?.(activeFormats());
  }, []);

  /**
   * Turn the address sitting immediately before the caret into a real link.
   *
   * This is the "I typed google.com and nothing happened" fix. Markdown has
   * autolinked bare hosts all along, but only when a note is *parsed* — and the
   * editor deliberately does not re-parse what is being typed, because doing so
   * would replace the DOM under the caret. So the recognition happens here, on the
   * DOM, at the moment the address is finished.
   *
   * It splits the text node into `before`, the link, and `after`, and puts the
   * caret in what follows, so typing carries on *outside* the link instead of
   * extending its label. The scheme is supplied for the stored href while the
   * words on screen are left exactly as written, which is the same rule the reader
   * uses.
   */
  const linkifyBeforeCaret = React.useCallback((): boolean => {
    const element = ref.current;
    const selection = document.getSelection();
    if (!element || !selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return false;
    const node = range.startContainer;
    if (node.nodeType !== 3 || !element.contains(node)) return false;
    // An address already inside a link is already a link.
    if (enclosingAnchor(node)) return false;

    const text = node.textContent ?? '';
    const before = text.slice(0, range.startOffset);
    const found = trailingUrl(before);
    if (!found) return false;
    const leading = before.slice(0, found.start);
    // A URL only becomes a link on its own: `xgoogle.com` is a word, and the same
    // guard the reader uses applies here so the two agree about what a link is.
    if (leading.length > 0 && !/[\s([{<"'|]$/.test(leading)) return false;

    const consumed = before.slice(found.start + found.text.length);
    const parent = node.parentNode;
    if (!parent) return false;

    const anchor = document.createElement('a');
    anchor.setAttribute('href', found.href);
    anchor.textContent = found.text;
    const rest = document.createTextNode(consumed + text.slice(range.startOffset));
    node.textContent = leading;
    parent.insertBefore(anchor, node.nextSibling);
    parent.insertBefore(rest, anchor.nextSibling);

    const caret = document.createRange();
    caret.setStart(rest, consumed.length);
    caret.collapse(true);
    const current = document.getSelection();
    if (current) {
      current.removeAllRanges();
      current.addRange(caret);
    }
    return true;
  }, []);

  /**
   * Three states on one button, which is what a checklist needs.
   *
   * A plain item becomes an unchecked one, an unchecked one becomes checked, and
   * a checked one goes back to a plain bullet. Most editors put this on a second
   * click target inside the item; a toolbar has room for one button, so the button
   * cycles and the label says which state comes next.
   */
  const toggleChecklistAtSelection = React.useCallback(() => {
    const element = ref.current;
    const selection = document.getSelection();
    if (!element || !selection || selection.rangeCount === 0) return;

    let node: Node | null = selection.getRangeAt(0).startContainer;
    while (node && node !== element) {
      if (node.nodeType === 1 && (node as Element).tagName === 'LI') break;
      node = node.parentNode;
    }
    if (!node || node === element) {
      // Not in a list yet: make one, unchecked.
      document.execCommand('insertUnorderedList');
      const items = Array.from(element.querySelectorAll('li'));
      const created = items[items.length - 1];
      if (created) created.setAttribute('data-checkbox', ' ');
      return;
    }

    const item = node as Element;
    const state = item.getAttribute('data-checkbox');
    if (state === null) item.setAttribute('data-checkbox', ' ');
    else if (state !== 'x') item.setAttribute('data-checkbox', 'x');
    else item.removeAttribute('data-checkbox');
  }, []);

  /**
   * Put the caret back where {@link RichTextApi.saveSelection} left it.
   *
   * Returns `true` when a remembered position was restored. A range whose node is
   * no longer in the document — the note was re-rendered, the wrapper was
   * replaced — is dropped rather than applied, because applying a stale range can
   * throw or, worse, silently insert at the start of the note.
   */
  const restoreSelection = React.useCallback((): boolean => {
    const element = ref.current;
    if (!element) return false;
    element.focus();
    const range = savedRange.current;
    if (!range) return false;
    if (!element.contains(range.startContainer)) {
      savedRange.current = null;
      return false;
    }
    const selection = document.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }, []);

  /** Insert an HTML fragment at the remembered caret (or the current one). */
  const insertHtml = React.useCallback(
    (html: string) => {
      const element = ref.current;
      if (!element || readOnly) return;
      restoreSelection();
      document.execCommand('insertHTML', false, html);
      savedRange.current = null;
      emit();
    },
    [emit, readOnly, restoreSelection],
  );

  /**
   * Put a link at the caret.
   *
   * The words the user already selected win over any label the caller offers:
   * selecting a sentence and attaching a link is asking for *that sentence* to
   * become the link. With nothing selected there is nothing to put the words on,
   * so the address is inserted as plain text — it appears in the note exactly as
   * it was written, and the autolinker turns it into a link.
   */
  const insertLinkAtCaret = React.useCallback(
    (href: string, label?: string) => {
      const element = ref.current;
      if (!element || readOnly) return;
      restoreSelection();
      const selected = document.getSelection()?.toString() ?? '';
      const text = selected.trim() || label?.trim() || '';
      if (text.length === 0) {
        insertHtml(escapeHtml(href));
        return;
      }
      insertHtml(`<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`);
    },
    [insertHtml, readOnly, restoreSelection],
  );

  const api = React.useMemo<RichTextApi>(
    () => ({
      run: (command) => {
        const element = ref.current;
        if (!element || readOnly) return;
        element.focus();
        if (command === 'checklist') {
          toggleChecklistAtSelection();
        } else {
          runEditorCommand(command);
        }
        emit();
        publishFormats();
      },
      saveSelection: () => {
        const element = ref.current;
        const selection = document.getSelection();
        if (!element || !selection || selection.rangeCount === 0) return;
        if (!element.contains(selection.anchorNode)) return;
        savedRange.current = selection.getRangeAt(0).cloneRange();
      },
      insertLink: (href, label) => insertLinkAtCaret(href, label),
      insertAddress: (href) => insertLinkAtCaret(href),
      insertNoteReference: (noteId, title) => {
        const text = title?.trim() || 'Subnote';
        insertHtml(`<a href="#note=${escapeHtml(noteId)}">${escapeHtml(text)}</a>`);
      },
      insertText: (text) => insertHtml(escapeHtml(text)),
      focus: () => ref.current?.focus(),
    }),
    [emit, insertHtml, insertLinkAtCaret, publishFormats, readOnly, toggleChecklistAtSelection],
  );

  /*
   * Keep the toolbar in step with the caret.
   *
   * `selectionchange` fires on the document, not on the editable node, so the
   * handler filters: a selection somewhere else on the page must not clear the
   * lights of the note being written. Only the *reported* state changes here —
   * the editable node is never rewritten from it, which is what keeps this
   * re-render from disturbing the caret.
   */
  React.useEffect(() => {
    if (readOnly) return;
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      if (!ref.current?.contains(selection.anchorNode)) return;
      publishFormats();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [publishFormats, readOnly]);

  // Hand the command API up once, and keep it current without re-mounting the
  // editable node. The setter is called only from an effect, never during render.
  React.useEffect(() => {
    onReady?.(api);
  }, [api, onReady]);

  /**
   * An address becomes a link when it is *finished*, not on every keystroke.
   *
   * Linkifying each character would turn `example.com` into a link the instant the
   * top-level domain was complete, and every `/path` typed afterwards would land
   * outside it — the address would be cut in half. So the trigger is a boundary:
   * a space or a return after the address, or a paste, which is the moment a
   * person has stopped writing it.
   */
  const onInput = (event: React.FormEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const input = event.nativeEvent as InputEvent;
    const data = typeof input.data === 'string' ? input.data : '';
    const boundary =
      input.inputType === 'insertFromPaste' ||
      input.inputType === 'insertFromDrop' ||
      input.inputType === 'insertParagraph' ||
      input.inputType === 'insertLineBreak' ||
      /[\s.,;:!?)\]]$/.test(data);
    const linked = boundary ? linkifyBeforeCaret() : false;
    emit();
    if (linked) publishFormats();
  };

  /**
   * A click on a checkbox draws nothing by itself, so it is handled here.
   *
   * The box is a `::before` on the item, which is not clickable on its own; the
   * click lands on the item, and an item whose click is inside the first few
   * pixels of its text is treated as a click on the box. Anything else is a
   * normal text click and is left alone, which is what keeps the caret working.
   */
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const target = event.target as HTMLElement;

    // An in-body reference to a subnote opens it. Handled before the checkbox
    // test because a reference is a link, and a link inside a list item would
    // otherwise be swallowed by the item's click.
    const reference = target.closest('a[href^="#note="]');
    if (reference && onOpenReference) {
      event.preventDefault();
      const id = reference.getAttribute('href')?.slice('#note='.length) ?? '';
      if (id) onOpenReference(id);
      return;
    }

    const item = target.closest('li[data-checkbox]');
    if (!item) return;
    const range = document.createRange();
    range.selectNodeContents(item);
    const box = range.getBoundingClientRect();
    if (event.clientX - box.left > 26) return;
    event.preventDefault();
    item.setAttribute('data-checkbox', item.getAttribute('data-checkbox') === 'x' ? ' ' : 'x');
    emit();
  };

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      data-surface="body"
      aria-readonly={readOnly || undefined}
      tabIndex={readOnly ? -1 : 0}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck
      onInput={onInput}
      onClick={onClick}
      onFocus={() => {
        onFocus?.();
        // The keyboard has not opened yet, so the resize listener does the work;
        // this only covers the case of a caret at the end of a long note whose
        // viewport never changes afterwards.
        requestAnimationFrame(() => {
          const selection = document.getSelection();
          const parent = selection?.rangeCount ? selection.getRangeAt(0).startContainer.parentElement : null;
          parent?.scrollIntoView({ block: 'nearest' });
        });
      }}
      data-placeholder={placeholder}
      className={cn('note-body focus:outline-none', readOnly && 'cursor-default', className)}
    />
  );
}

