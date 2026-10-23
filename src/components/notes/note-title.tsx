'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  activeFormats,
  caretInsideFormat,
  htmlToInlineMarkdown,
  inlineToHtml,
  insertArmedText,
  insertTextOutsideFormat,
  toggleInlineElement,
  TYPING_TAGS,
  type EditorCommand,
  type FormatState,
  type TypingCommand,
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
  /**
   * The last caret position this title had.
   *
   * A tap on the formatting bar can take the selection away before the click
   * handler runs — touch events on Android are not ordered like a desktop mouse
   * — and `focus()` on a surface that lost its selection puts the caret at the
   * start. Remembering the range and putting it back is what makes the button
   * format the words the user selected instead of a different spot.
   */
  const lastRange = React.useRef<Range | null>(null);
  /**
   * The inline format armed at a collapsed caret, waiting for its first character.
   *
   * It has to live here rather than in the document because the title cannot use
   * the engine's pending format: its face is semibold, so the engine believes the
   * words are already bold and its command writes `font-weight: normal` instead
   * of a tag. So the button remembers the intent and the first keystroke writes
   * its character inside a real element (see `insertArmedText`).
   */
  const armed = React.useRef<TypingCommand | null>(null);
  /**
   * The format the next character is escaping.
   *
   * The other direction of the same idea: the caret is parked inside a run, the
   * button was pressed to turn it off, and the next keystroke has to be written
   * *outside* that run — see `insertTextOutsideFormat` for why an empty caret
   * position cannot express that.
   */
  const escaping = React.useRef<TypingCommand | null>(null);
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

  /**
   * Publish the button state, including a format that is armed but not yet in
   * the document. Without this the button would go out the instant it was armed,
   * because there is nothing in the DOM to find yet.
   */
  const publishFormats = React.useCallback(() => {
    const base = activeFormats();
    const selection = document.getSelection();
    const collapsed = selection?.isCollapsed ?? true;
    const format = armed.current;
    const escape = escaping.current;
    if (!collapsed) {
      formatsRef.current?.(base);
      return;
    }
    // The caret may still be inside the run being left behind; the button has
    // already been pressed to turn that format off, so it must not stay lit.
    const next =
      escape === 'bold'
        ? { ...base, bold: false }
        : escape === 'italic'
          ? { ...base, italic: false }
          : escape === 'strike'
            ? { ...base, strike: false }
            : escape === 'code'
              ? { ...base, code: false }
              : base;
    if (!format) {
      formatsRef.current?.(next);
      return;
    }
    formatsRef.current?.(
      format === 'bold'
        ? { ...next, bold: true }
        : format === 'italic'
          ? { ...next, italic: true }
          : format === 'strike'
            ? { ...next, strike: true }
            : { ...next, code: true },
    );
  }, []);

  const emit = React.useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const markdown = htmlToInlineMarkdown(element).slice(0, MAX_LENGTH);
    lastEmitted.current = markdown;
    onChangeRef.current(markdown);
    publishFormats();
  }, [publishFormats]);

  const api = React.useMemo<NoteTitleApi>(
    () => ({
      run: (command) => {
        const element = ref.current;
        if (!element || readOnly) return;
        /*
         * Inline formats only: a block command (a list, a heading, a size) has no
         * meaning on a one-line title and is ignored here.
         */
        if (command !== 'bold' && command !== 'italic' && command !== 'strike' && command !== 'code') return;

        /*
         * A toolbar tap can arrive after focus and the selection have already
         * moved. The live range is preferred, the last in-title position is the
         * fallback, and the range is put back *after* focus — focusing an editable
         * that lost its caret otherwise drops the caret at the start of the title.
         */
        const live = document.getSelection();
        const liveRange =
          live && live.rangeCount > 0 && element.contains(live.anchorNode)
            ? live.getRangeAt(0).cloneRange()
            : null;
        const remembered =
          lastRange.current && element.contains(lastRange.current.startContainer)
            ? lastRange.current
            : null;
        const target = liveRange ?? remembered;
        if (document.activeElement !== element) element.focus();
        if (target) {
          const restored = document.getSelection();
          restored?.removeAllRanges();
          restored?.addRange(target);
        }

        const selection = document.getSelection();
        const collapsed = selection?.isCollapsed ?? true;

        if (!collapsed) {
          armed.current = null;
          escaping.current = null;
          toggleInlineElement(TYPING_TAGS[command]);
          emit();
          return;
        }

        /*
         * A caret with nothing selected cannot be wrapped, so the format becomes
         * a *state*: remembered here and applied by the next character typed.
         */
        if (escaping.current === command) {
          /*
           * Pressed again while escaping: cancel the escape and let ordinary
           * typing continue inside the run that is already there. Arming a fresh
           * wrapper here would nest one bold inside another, which is the same
           * format said twice in the stored Markdown.
           */
          escaping.current = null;
          armed.current = null;
          publishFormats();
          return;
        }

        if (caretInsideFormat(command)) {
          // The "off" half. Do not touch the document — the run the caret is in
          // stays as it is; only the next character is written outside it.
          armed.current = null;
          escaping.current = command;
          publishFormats();
          return;
        }

        escaping.current = null;
        armed.current = armed.current === command ? null : command;
        publishFormats();
      },
    }),
    [emit, publishFormats, readOnly],
  );

  React.useEffect(() => {
    onReadyRef.current?.(api);
  }, [api]);

  React.useEffect(() => {
    if (readOnly) return;
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      if (!ref.current?.contains(selection.anchorNode)) {
        armed.current = null;
        escaping.current = null;
        return;
      }
      const range = selection.getRangeAt(0);
      if (!range.collapsed) {
        // Selecting text is not a request to arm a format for the next word.
        armed.current = null;
        escaping.current = null;
      }
      lastRange.current = range.cloneRange();
      publishFormats();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [publishFormats, readOnly]);

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
      onBeforeInput={(event) => {
        /*
         * The first character after a format is armed: write it inside the
         * element ourselves, because nothing in the document can tell the
         * browser about the intent (see `armed`). Every later character is an
         * ordinary keystroke at a caret that is now inside that element.
         */
        const native = event.nativeEvent as InputEvent;
        if (native.inputType !== 'insertText' || !native.data) return;

        const escape = escaping.current;
        if (escape) {
          event.preventDefault();
          escaping.current = null;
          insertTextOutsideFormat(escape, native.data);
          emit();
          return;
        }

        const format = armed.current;
        if (!format || caretInsideFormat(format)) return;
        event.preventDefault();
        armed.current = null;
        insertArmedText(format, native.data);
        emit();
      }}
      onFocus={onFocus}
      onBlur={() => {
        armed.current = null;
        escaping.current = null;
        onBlur?.();
      }}
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
          armed.current = null;
          escaping.current = null;
          event.currentTarget.blur();
          onEnter?.();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          armed.current = null;
          escaping.current = null;
          event.currentTarget.blur();
          return;
        }

        /*
         * The first character of an armed format.
         *
         * Done here rather than only in `onBeforeInput` because keydown runs
         * first and is the one event every engine dispatches for a printable
         * key; cancelling it stops the plain character from being inserted, and
         * the wrapped one goes in instead. Composition is left alone — an IME
         * owns its own text until it commits.
         */
        const native = event.nativeEvent;
        if (native.isComposing || native.ctrlKey || native.metaKey || native.altKey) return;
        if (event.key.length !== 1) return;

        // Leaving a run: the first plain character is written outside it.
        const escape = escaping.current;
        if (escape) {
          event.preventDefault();
          escaping.current = null;
          insertTextOutsideFormat(escape, event.key);
          emit();
          return;
        }

        const format = armed.current;
        if (!format || caretInsideFormat(format)) return;
        event.preventDefault();
        armed.current = null;
        insertArmedText(format, event.key);
        emit();
      }}
      className={cn('note-title min-w-0 flex-1 focus:outline-none', readOnly && 'cursor-default', className)}
    />
  );
}
