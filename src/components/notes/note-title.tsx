'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  activeFormats,
  htmlToInlineMarkdown,
  inlineToHtml,
  toggleInlineElement,
  type EditorCommand,
  type FormatState,
} from '@/lib/markdown-html';

/**
 * The note's title, editable in place and able to carry emphasis.
 *
 * ## Why this is not an `<input>`
 *
 * An input can only hold text, and the title is part of the note: bolding a word
 * in it is the same act as bolding a word in the body, and the toolbar that does
 * one should do the other. So the title is a one-line contentEditable over the
 * same Markdown inline model as the body — `**Design** notes` is stored, and the
 * words are shown weighted here, in the list, and in every place the title is
 * rendered.
 *
 * ## The single line is enforced, not assumed
 *
 * A title has no paragraphs, so Enter commits (the caller decides what that
 * means) and a paste has its newlines flattened. Without that, a pasted sentence
 * would become a second line that no list row could show and no breadcrumb could
 * truncate.
 *
 * The same uncontrolled rule as the body applies, for the same reason: the node
 * is written on mount and when Markdown arrives from outside, and never from the
 * keystroke that produced it — re-rendering a contentEditable from state takes the
 * caret away with it.
 */

export interface NoteTitleProps {
  /** Markdown for the title. */
  value: string;
  onChange: (markdown: string) => void;
  /** Called when the user presses Enter: done with the title, go to the body. */
  onEnter?: () => void;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  /** Receives the formatting API so the sheet's toolbar can drive the title. */
  onReady?: (api: NoteTitleApi) => void;
  /** Reports which formats are on, so the shared toolbar shows the truth. */
  onFormatStateChange?: (state: FormatState) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export interface NoteTitleApi {
  run: (command: EditorCommand) => void;
}

/** Titles are one line by definition; the storage layer agrees. */
const MAX_LENGTH = 120;

export function NoteTitle({
  value,
  onChange,
  onEnter,
  readOnly = false,
  placeholder = 'Title',
  className,
  onReady,
  onFormatStateChange,
  onFocus,
  onBlur,
}: NoteTitleProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const lastEmitted = React.useRef<string | null>(null);
  const onChangeRef = React.useRef(onChange);
  const formatsRef = React.useRef(onFormatStateChange);
  const onReadyRef = React.useRef(onReady);

  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  React.useEffect(() => {
    formatsRef.current = onFormatStateChange;
  }, [onFormatStateChange]);
  React.useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.innerHTML = inlineToHtml(value);
    lastEmitted.current = value;
    // Mount-only, like the body: `value` is adopted when the note opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const element = ref.current;
    if (!element || value === lastEmitted.current) return;
    element.innerHTML = inlineToHtml(value);
    lastEmitted.current = value;
  }, [value]);

  const emit = React.useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const markdown = htmlToInlineMarkdown(element).slice(0, MAX_LENGTH);
    lastEmitted.current = markdown;
    onChangeRef.current(markdown);
    formatsRef.current?.(activeFormats());
  }, []);

  const api = React.useMemo<NoteTitleApi>(
    () => ({
      run: (command) => {
        const element = ref.current;
        if (!element || readOnly) return;
        element.focus();
        /*
         * Inline formats are toggled structurally rather than through
         * `execCommand('bold')`: the title's own font is semibold, so the engine
         * decides the text is already bold and turns it *off*, producing
         * `font-weight: normal` on the words the user just highlighted. A block
         * command (a list, a heading, a size) has no meaning on a one-line title
         * and is ignored here.
         */
        if (command === 'bold') toggleInlineElement('b');
        else if (command === 'italic') toggleInlineElement('i');
        else if (command === 'strike') toggleInlineElement('del');
        else if (command === 'code') toggleInlineElement('code');
        else return;
        emit();
      },
    }),
    [emit, readOnly],
  );

  React.useEffect(() => {
    onReadyRef.current?.(api);
  }, [api]);

  React.useEffect(() => {
    if (readOnly) return;
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      if (!ref.current?.contains(selection.anchorNode)) return;
      formatsRef.current?.(activeFormats());
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [readOnly]);

  return (
    <div
      ref={ref}
      role="textbox"
      aria-label="Note title"
      data-surface="title"
      aria-readonly={readOnly || undefined}
      tabIndex={readOnly ? -1 : 0}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      onInput={emit}
      onFocus={onFocus}
      onBlur={onBlur}
      onPaste={(event) => {
        // A pasted title is always one line: whatever structure it arrived with,
        // a title cannot hold a paragraph break.
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain').replace(/\s+/g, ' ').trim();
        document.execCommand('insertText', false, text);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
          onEnter?.();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      className={cn('note-title min-w-0 flex-1 focus:outline-none', readOnly && 'cursor-default', className)}
    />
  );
}
