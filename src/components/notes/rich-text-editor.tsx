'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  htmlToMarkdown,
  markdownToHtml,
  runEditorCommand,
  escapeHtml,
  type EditorCommand,
} from '@/lib/markdown-html';

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
  ariaLabel?: string;
}

export interface RichTextApi {
  run: (command: EditorCommand) => void;
  /** Wrap the selection in a Markdown link, using the text as the label. */
  insertLink: (href: string) => void;
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
  ariaLabel = 'Note body',
}: RichTextEditorProps) {
  const ref = React.useRef<HTMLDivElement>(null);
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
      },
      insertLink: (href) => {
        const element = ref.current;
        if (!element || readOnly) return;
        element.focus();
        const selection = document.getSelection();
        const label = selection?.toString() ?? '';
        document.execCommand(
          'insertHTML',
          false,
          `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>`,
        );
        emit();
      },
      insertText: (text) => {
        const element = ref.current;
        if (!element || readOnly) return;
        element.focus();
        document.execCommand('insertHTML', false, escapeHtml(text));
        emit();
      },
      focus: () => ref.current?.focus(),
    }),
    [emit, readOnly, toggleChecklistAtSelection],
  );

  // Hand the command API up once, and keep it current without re-mounting the
  // editable node. The setter is called only from an effect, never during render.
  React.useEffect(() => {
    onReady?.(api);
  }, [api, onReady]);

  const onInput = () => {
    if (readOnly) return;
    emit();
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
      aria-readonly={readOnly || undefined}
      tabIndex={readOnly ? -1 : 0}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck
      onInput={onInput}
      onClick={onClick}
      onFocus={() => {
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

