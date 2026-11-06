'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Copy, Cut, Paste, SelectAll } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import {
  activeFormats,
  caretInsideFormat,
  enclosingAnchor,
  htmlToMarkdown,
  markdownToHtml,
  runEditorCommand,
  escapeHtml,
  insertArmedText,
  insertTextOutsideFormat,
  type EditorCommand,
  type FormatState,
  type TypingCommand,
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
 *
 * ## The selection menu
 *
 * Android draws its own menu over a text selection, and it cannot be sized or
 * styled by the app — on this WebView it arrives as a slab of background far
 * larger than its buttons, over the note being read. So the body supplies its
 * own: {@link SelectionBar}, a floating row of Cut / Copy / Paste / Select all
 * anchored to the selection.
 *
 * The platform's copy is asked for, not assumed. The body tells
 * `SelectionMenuPlugin` which surface is being edited, and only while it is the
 * body is the system menu withheld (see `StashWebView` for what that means
 * natively). Tap the title, the search field or the link field and it comes
 * back, because those still use it.
 *
 * The bar acts on the selection it was opened for rather than on whatever the
 * browser holds when a button is pressed: a tap can collapse a selection before
 * that tap's click arrives, and losing the words between pressing Copy and
 * copying them is exactly the failure this code exists to prevent.
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

/**
 * The two native pieces the selection bar needs.
 *
 * `SelectionMenu` withholds Android's own selection menu while the body is the
 * surface being edited. `Clipboard` reads the system clipboard for Paste,
 * because a WebView denies `navigator.clipboard.readText()` outright — the
 * permission it wants cannot be requested by a page inside one.
 */
interface SelectionMenuPlugin {
  setSuppressed(options: { suppressed: boolean }): Promise<void>;
}

interface ClipboardPlugin {
  read(): Promise<{ text: string }>;
}

const selectionMenu = registerPlugin<SelectionMenuPlugin>('SelectionMenu');
const clipboard = registerPlugin<ClipboardPlugin>('Clipboard');

/** Where the bar hangs: the box around the selected words, in viewport pixels. */
interface SelectionAnchor {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/**
 * The platform the system menu is a problem on.
 *
 * Android is where it is an unstylable slab. iOS draws its own callout, which
 * cannot be withdrawn without native work, so there the platform's menu is left
 * alone and the bar is not drawn beside it. On the web there is no system menu
 * at all and the bar is simply the menu.
 */
function isAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function isIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

/** Put text on the clipboard when the engine will not do it for us. */
function copyText(text: string): void {
  if (!text) return;
  try {
    void navigator.clipboard.writeText(text).catch(() => {
      /* nothing left to fall back to: the words are still selected on screen */
    });
  } catch {
    /* no clipboard in this context */
  }
}

/** The system clipboard: through the bridge on Android, the browser API elsewhere. */
async function readClipboardText(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { text } = await clipboard.read();
      return text ?? '';
    } catch {
      /* no Clipboard implementation here: fall through to the browser API */
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
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
   * The last caret position this body had.
   *
   * A toolbar tap on Android can take the selection away before the click
   * handler runs, and focusing the editable again puts the caret at the start.
   * Remembering the range is what makes Bold apply to the words that were
   * selected rather than to the beginning of the note.
   */
  const lastRange = React.useRef<Range | null>(null);
  /**
   * The inline format armed at a collapsed caret, waiting for its first character.
   *
   * This is deliberately not the engine's pending format. `execCommand` may or may
   * not remember one across a keystroke — Android's WebView frequently does not —
   * and `queryCommandState` then reports a state that disagrees with the text, so
   * the button appears stuck. The intent lives here instead, and the first
   * character is written into a real element by {@link insertArmedText}; every
   * later character follows the caret inside that element without any help from
   * the engine.
   */
  const armed = React.useRef<TypingCommand | null>(null);
  /**
   * The format the next character is escaping.
   *
   * The other half of the same idea: the caret is inside a run, the button was
   * pressed to turn it off, and the next character has to be written *outside*
   * that run. An empty caret position cannot express that — the browser
   * normalises it away and the character lands back inside — so
   * {@link insertTextOutsideFormat} writes real text past the run instead.
   */
  const escaping = React.useRef<TypingCommand | null>(null);
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

    let expandedHeight = viewport.height;

    const ensureCaretVisible = () => {
      if (document.activeElement !== element) return;

      const height = viewport.height;
      if (height >= expandedHeight) {
        expandedHeight = height;
        return;
      }
      // Android also resizes the visual viewport for selection handles and the
      // copy/cut menu. Those changes are much smaller than the keyboard opening;
      // ignore them so they cannot move the note and create space above text.
      if (expandedHeight - height < 120) return;

      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      if (!element.contains(selection.anchorNode)) return;
      const range = selection.getRangeAt(0);
      if (!range.collapsed) return;
      const rect = range.getBoundingClientRect();
      const parent = range.startContainer.parentElement;
      const bottom = rect.height > 0 ? rect.bottom : (parent?.getBoundingClientRect().bottom ?? 0);
      if (bottom <= height) return;
      (parent ?? element).scrollIntoView({ block: 'nearest' });
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
    const base = activeFormats();
    const selection = document.getSelection();
    const collapsed = selection?.isCollapsed ?? true;
    if (!collapsed) {
      onFormatsRef.current?.(base);
      return;
    }
    /*
     * A pending format is not in the document yet, so the structural answer is
     * incomplete: armed means the next character will be bold even though nothing
     * is, and escaping means it will be plain even though the caret is sitting in
     * bold text. Those two intentions override the document until the first
     * character lands, which is what lets the button read as a toggle instead of
     * going dark while the next letter is still going to be bold.
     */
    const escape = escaping.current;
    const pending = armed.current;
    const next = escape ? { ...base, [escape]: false } : base;
    onFormatsRef.current?.(pending ? { ...next, [pending]: true } : next);
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

  /**
   * Put the caret back on this surface before a command runs.
   *
   * The live selection wins when it is still inside the body. When it is not —
   * a toolbar tap on Android may already have moved focus and dropped it — the
   * last position seen inside the body is restored instead. The range is added
   * *after* focus for the same reason as in the title: focusing an editable that
   * lost its caret otherwise puts the caret at the start of the note.
   */
  const restoreEditorSelection = React.useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const selection = document.getSelection();
    const live =
      selection && selection.rangeCount > 0 && element.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    const remembered =
      lastRange.current && element.contains(lastRange.current.startContainer) ? lastRange.current : null;
    const target = live ?? remembered;
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    if (target) {
      const restored = document.getSelection();
      restored?.removeAllRanges();
      restored?.addRange(target);
    }
  }, []);

  /*
   * --- The selection bar ----------------------------------------------------
   *
   * `barAnchor` is what makes the bar exist at all: the box around the selected
   * words, in viewport pixels. `barRange` is the selection itself, cloned, so
   * the bar still knows which words it was opened for after the browser has
   * moved on — which it does the moment a tap lands anywhere, including on the
   * bar.
   */
  const [barAnchor, setBarAnchor] = React.useState<SelectionAnchor | null>(null);
  const barRange = React.useRef<Range | null>(null);
  const barHideTimer = React.useRef<number | null>(null);

  const cancelBarHide = React.useCallback(() => {
    if (barHideTimer.current === null) return;
    window.clearTimeout(barHideTimer.current);
    barHideTimer.current = null;
  }, []);

  const hideSelectionBar = React.useCallback(() => {
    cancelBarHide();
    barRange.current = null;
    setBarAnchor(null);
  }, [cancelBarHide]);

  /** Show the bar over `range`, and take that selection as the one it acts on. */
  const showSelectionBar = React.useCallback(
    (range: Range) => {
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      cancelBarHide();
      barRange.current = range.cloneRange();
      setBarAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width });
    },
    [cancelBarHide],
  );

  /**
   * Take the bar away shortly after the selection stops being one.
   *
   * Not immediately: the click from a tap on the bar can arrive after the
   * browser has already collapsed the selection, and a bar that unmounts in
   * between never receives the click that would have copied anything. The delay
   * is cancelled by every press on the bar, and the conditions are checked
   * again before it hides — so a copy, which puts the selection back, leaves the
   * bar exactly where it was.
   */
  const scheduleBarHide = React.useCallback(() => {
    cancelBarHide();
    barHideTimer.current = window.setTimeout(() => {
      barHideTimer.current = null;
      const selection = document.getSelection();
      const element = ref.current;
      const inside = !!element && !!selection && element.contains(selection.anchorNode);
      if (!inside || !selection || selection.isCollapsed) hideSelectionBar();
    }, 180);
  }, [cancelBarHide, hideSelectionBar]);

  /**
   * Ask the native side for the system menu, or hand it back.
   *
   * Only when the answer changes: this runs on every focus, press and selection
   * change, and most of those repeat what the native side was already told.
   * Failure is swallowed — and forgotten, so the next ask tries again — because
   * the plugin exists on Android only and a platform without it simply keeps its
   * own menu beside ours.
   */
  const nativeMenuState = React.useRef<boolean | null>(null);
  const requestNativeMenu = React.useCallback((suppressed: boolean) => {
    if (!isAndroid()) return;
    if (nativeMenuState.current === suppressed) return;
    nativeMenuState.current = suppressed;
    void selectionMenu.setSuppressed({ suppressed }).catch(() => {
      nativeMenuState.current = null;
    });
  }, []);

  /**
   * Put the bar's selection back in the browser and on screen.
   *
   * `null` means the remembered range no longer belongs to this body — the note
   * was re-rendered under it, the wrapper replaced — because acting on a stale
   * range puts text in the wrong place, silently.
   */
  const restoreBarSelection = React.useCallback((): Range | null => {
    const element = ref.current;
    const range = barRange.current;
    if (!element || !range) return null;
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
    element.focus({ preventScroll: true });
    const selection = document.getSelection();
    if (!selection) return null;
    selection.removeAllRanges();
    selection.addRange(range);
    return range;
  }, []);

  const cutBarSelection = React.useCallback(() => {
    cancelBarHide();
    if (!restoreBarSelection()) return;
    let cut = false;
    try {
      cut = document.execCommand('cut');
    } catch {
      cut = false;
    }
    if (!cut) {
      // Refused by the engine: copy by hand, then take the words out ourselves.
      const range = barRange.current;
      copyText(range?.toString() ?? '');
      range?.deleteContents();
    }
    emit();
    publishFormats();
    hideSelectionBar();
  }, [cancelBarHide, emit, hideSelectionBar, publishFormats, restoreBarSelection]);

  const copyBarSelection = React.useCallback(() => {
    cancelBarHide();
    if (!restoreBarSelection()) return;
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    if (!copied) copyText(barRange.current?.toString() ?? '');
    // The bar stays: the selection it is about is still selected, and copying
    // is not a reason to make anybody select it again.
    publishFormats();
  }, [cancelBarHide, publishFormats, restoreBarSelection]);

  const pasteAtBarSelection = React.useCallback(() => {
    cancelBarHide();
    const element = ref.current;
    /*
     * The range is taken now, not after the clipboard answers: reading it is a
     * round trip through the bridge, and in that time the tap on the bar may
     * have collapsed the selection and the bar may have been dismissed. A clone
     * outlives both.
     */
    const range = barRange.current?.cloneRange() ?? null;
    if (!element || !range) return;
    void readClipboardText().then((text) => {
      if (!text) return;
      if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
      element.focus({ preventScroll: true });
      const selection = document.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range);
      /*
       * `insertText` is the browser's own edit: it replaces the selection, fires
       * an input event (so the Markdown is written and autosaved) and splits
       * paragraphs the way typing does. The DOM insertion is only for engines
       * that refuse it.
       */
      if (!document.execCommand('insertText', false, text)) {
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
      }
      emit();
      publishFormats();
      hideSelectionBar();
    });
  }, [cancelBarHide, emit, hideSelectionBar, publishFormats]);

  const selectAllInBody = React.useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    lastRange.current = range.cloneRange();
    // `selectionchange` will report the same thing a tick later; doing it here
    // as well keeps the bar from blinking out and back in.
    showSelectionBar(range);
    publishFormats();
  }, [publishFormats, showSelectionBar]);

  const api = React.useMemo<RichTextApi>(
    () => ({
      run: (command) => {
        const element = ref.current;
        if (!element || readOnly) return;
        restoreEditorSelection();

        const typing =
          command === 'bold' || command === 'italic' || command === 'strike' || command === 'code';
        const selection = document.getSelection();
        const collapsed = !selection || selection.isCollapsed;

        if (typing && collapsed) {
          const format: TypingCommand = command;
          if (escaping.current === format) {
            /*
             * Pressed again while escaping: cancel the escape and let ordinary
             * typing continue inside the run that is already there. Arming a
             * second wrapper would nest one bold inside another.
             */
            escaping.current = null;
            armed.current = null;
          } else if (caretInsideFormat(format)) {
            // The "off" half: leave the run alone, step the next character out.
            armed.current = null;
            escaping.current = format;
          } else {
            escaping.current = null;
            armed.current = armed.current === format ? null : format;
          }
          publishFormats();
          return;
        }

        /*
         * Anything with a selection, and every block command, is a real edit. The
         * pending intent has been consumed or contradicted; it must not survive
         * into the next paragraph.
         */
        armed.current = null;
        escaping.current = null;
        if (command === 'checklist') {
          toggleChecklistAtSelection();
        } else {
          runEditorCommand(command);
        }
        emit();
        publishFormats();
        const after = document.getSelection();
        if (after && after.rangeCount > 0 && element.contains(after.anchorNode)) {
          lastRange.current = after.getRangeAt(0).cloneRange();
        }
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
    [emit, insertHtml, insertLinkAtCaret, publishFormats, readOnly, restoreEditorSelection, toggleChecklistAtSelection],
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
      if (!selection || selection.rangeCount === 0) {
        scheduleBarHide();
        return;
      }
      if (!ref.current?.contains(selection.anchorNode)) {
        armed.current = null;
        escaping.current = null;
        scheduleBarHide();
        return;
      }
      const range = selection.getRangeAt(0);
      if (!range.collapsed) {
        // Selecting text is not a request to arm a format for the next word.
        armed.current = null;
        escaping.current = null;
        showSelectionBar(range);
        // A selection in the body is the one case where the platform's menu is
        // replaced rather than used; see `StashWebView`.
        requestNativeMenu(true);
      } else {
        scheduleBarHide();
      }
      lastRange.current = range.cloneRange();
      publishFormats();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [publishFormats, readOnly, requestNativeMenu, scheduleBarHide, showSelectionBar]);

  /*
   * Which surface the system menu belongs to.
   *
   * The body has its own now, so the platform's is withheld while the body is the
   * thing being edited and handed back the moment it is not. The pointer listener
   * is the fast path: it fires on the touch that begins a selection, long before
   * Android asks for a menu, so the very first long-press is covered too. Focus
   * and blur are the exact answer for every route that does not start with a
   * touch on the body.
   */
  React.useEffect(() => {
    if (readOnly || !isAndroid()) return;
    const element = ref.current;
    if (!element) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const onBar = target instanceof Element && !!target.closest('[data-selection-bar]');
      requestNativeMenu(!!target && (onBar || element.contains(target)));
    };
    const onFocus = () => requestNativeMenu(true);
    const onBlur = () => requestNativeMenu(false);

    document.addEventListener('pointerdown', onPointerDown, true);
    element.addEventListener('focus', onFocus);
    element.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      element.removeEventListener('focus', onFocus);
      element.removeEventListener('blur', onBlur);
      // Leaving the note must give the menu back, or the next screen's fields
      // would be the ones without one.
      requestNativeMenu(false);
    };
  }, [readOnly, requestNativeMenu]);

  /*
   * Follow the words when the page moves, and drop the bar when they leave the
   * screen.
   *
   * Hiding on every scroll would be the easier rule and the wrong one: Android
   * scrolls the page a little by itself when a selection is made — to bring the
   * text and its handles into view — so the bar would vanish at the instant it
   * appeared. Re-anchoring keeps it tied to the selection instead, which is also
   * what it should do while the user drags a handle.
   */
  React.useEffect(() => {
    let frame = 0;
    const follow = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const range = barRange.current;
        if (!range) return;
        const rect = range.getBoundingClientRect();
        const height = window.visualViewport?.height ?? window.innerHeight;
        if (rect.bottom < 0 || rect.top > height) {
          hideSelectionBar();
          return;
        }
        // Only when it actually moved: a scroll frame that leaves the words
        // where they were must not re-render the bar, or dragging the page
        // would churn React for nothing.
        setBarAnchor((current) => {
          if (
            current &&
            Math.abs(current.top - rect.top) < 1 &&
            Math.abs(current.left - rect.left) < 1 &&
            Math.abs(current.width - rect.width) < 1
          ) {
            return current;
          }
          return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
        });
      });
    };
    window.addEventListener('scroll', follow, true);
    return () => {
      window.removeEventListener('scroll', follow, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [hideSelectionBar]);

  /*
   * A real viewport change — the keyboard opening or closing, a rotation — puts
   * the bar back where it would have been before; it is easier to make it go and
   * let the next selection bring it back.
   *
   * Small changes are ignored on purpose: Android resizes the visual viewport a
   * little for the selection handles themselves, which is not a reason to take
   * the menu away from the selection it belongs to.
   */
  React.useEffect(() => {
    const hide = () => hideSelectionBar();
    window.addEventListener('resize', hide);
    const viewport = window.visualViewport;
    if (!viewport) {
      return () => window.removeEventListener('resize', hide);
    }
    let height = viewport.height;
    const onViewportResize = () => {
      if (Math.abs(viewport.height - height) < 120) return;
      height = viewport.height;
      hide();
    };
    viewport.addEventListener('resize', onViewportResize);
    return () => {
      window.removeEventListener('resize', hide);
      viewport.removeEventListener('resize', onViewportResize);
    };
  }, [hideSelectionBar]);

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
    <>
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
        onBeforeInput={(event) => {
          if (readOnly) return;
          const native = event.nativeEvent as InputEvent;
          if (native.inputType !== 'insertText' || !native.data) return;

          // Leaving a run: the first plain character is written outside it.
          const escape = escaping.current;
          if (escape) {
            event.preventDefault();
            escaping.current = null;
            insertTextOutsideFormat(escape, native.data);
            emit();
            publishFormats();
            return;
          }

          const format = armed.current;
          if (!format || caretInsideFormat(format)) return;
          event.preventDefault();
          armed.current = null;
          insertArmedText(format, native.data);
          emit();
          publishFormats();
        }}
        onKeyDown={(event) => {
          if (readOnly) return;
          /*
           * The first character of an armed format.
           *
           * Done here as well as in `onBeforeInput` because keydown runs first
           * and is the one event every engine dispatches for a printable key;
           * cancelling it stops the plain character from being inserted, and the
           * wrapped one goes in instead. Composition is left alone — an IME owns
           * its own text until it commits.
           */
          const native = event.nativeEvent;
          if (native.isComposing || native.ctrlKey || native.metaKey || native.altKey) return;
          if (event.key.length !== 1) return;

          const escape = escaping.current;
          if (escape) {
            event.preventDefault();
            escaping.current = null;
            insertTextOutsideFormat(escape, event.key);
            emit();
            publishFormats();
            return;
          }

          const format = armed.current;
          if (!format || caretInsideFormat(format)) return;
          event.preventDefault();
          armed.current = null;
          insertArmedText(format, event.key);
          emit();
          publishFormats();
        }}
        onBlur={() => {
          // A pending format belongs to the caret that armed it; leaving the body
          // must not decorate the next thing the user clicks into.
          armed.current = null;
          escaping.current = null;
        }}
        onClick={onClick}
        onFocus={() => {
          onFocus?.();
          // The keyboard has not opened yet, so the resize listener does the
          // work; this only covers the case of a caret at the end of a long note
          // whose viewport never changes afterwards.
          requestAnimationFrame(() => {
            const selection = document.getSelection();
            const parent = selection?.rangeCount
              ? selection.getRangeAt(0).startContainer.parentElement
              : null;
            parent?.scrollIntoView({ block: 'nearest' });
          });
        }}
        data-placeholder={placeholder}
        className={cn('note-body focus:outline-none', readOnly && 'cursor-default', className)}
      />

      {/*
       * The app's own menu over a selection, portalled to the document body.
       *
       * Outside the editable node on purpose: anything rendered inside a
       * contentEditable is part of the document being edited — it would be
       * typed text, serialised into the note — and outside it no ancestor's
       * overflow or transformation can clip the bar.
       */}
      {!readOnly && !isIOS() && barAnchor ? (
        <SelectionBar
          anchor={barAnchor}
          onInteract={cancelBarHide}
          onCut={cutBarSelection}
          onCopy={copyBarSelection}
          onPaste={pasteAtBarSelection}
          onSelectAll={selectAllInBody}
        />
      ) : null}
    </>
  );
}

/**
 * The app's own menu over a selection.
 *
 * The four actions Android's menu offers over an editable selection, in a pill
 * that sits above the selection rather than across it. It exists because the
 * platform's menu cannot be sized or themed — on this WebView it paints a slab
 * of background several menu rows taller than the words it belongs to — and
 * because the actions belong to the note editor anyway, which has already read
 * the selection and will serialise the result to Markdown.
 *
 * `anchor` is the box around the selected words, in viewport pixels. The bar
 * measures itself before it is placed, because where it can sit depends on how
 * wide it turned out: above the selection, unless there is no room there, and
 * never off either edge of the screen.
 */
function SelectionBar({
  anchor,
  onCut,
  onCopy,
  onPaste,
  onSelectAll,
  onInteract,
}: {
  anchor: SelectionAnchor;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  /** A press has landed on the bar: whatever was about to hide it no longer should. */
  onInteract: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [place, setPlace] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const gap = 8;
    const edge = 10;
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;

    const centred = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(centred, edge), Math.max(edge, viewportWidth - width - edge));
    // Above the words, and below them only when the selection is near the top
    // of the screen — the same rule the platform's own menu follows.
    let top = anchor.top - height - gap;
    if (top < edge) top = anchor.bottom + gap;
    top = Math.min(top, Math.max(edge, viewportHeight - height - edge));

    setPlace({ top, left });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selection actions"
      data-selection-bar
      className="animate-pop-in fixed z-50 flex items-center gap-0.5 rounded-2xl border border-border bg-surface/95 p-1 shadow-raised backdrop-blur-xl"
      style={{
        top: place?.top ?? anchor.top,
        left: place?.left ?? anchor.left,
        // The first pass exists only to be measured.
        visibility: place ? 'visible' : 'hidden',
      }}
      /*
       * A bar that takes focus is a bar that drops the selection it is about to
       * act on — and on Android it would also close the keyboard. Swallowing the
       * default of the press keeps both exactly where they are.
       */
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={onInteract}
    >
      <BarButton label="Cut" icon={<Cut size={17} weight="bold" aria-hidden />} onRun={onCut} />
      <BarButton label="Copy" icon={<Copy size={17} weight="bold" aria-hidden />} onRun={onCopy} />
      <BarButton label="Paste" icon={<Paste size={17} weight="bold" aria-hidden />} onRun={onPaste} />
      <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />
      <BarButton
        label="Select all"
        icon={<SelectAll size={17} weight="bold" aria-hidden />}
        onRun={onSelectAll}
      />
    </div>,
    document.body,
  );
}

/** One action in the selection bar. */
function BarButton({
  label,
  icon,
  onRun,
}: {
  label: string;
  icon: React.ReactNode;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      // Same reason as the bar itself: never take the selection away.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
      aria-label={label}
      title={label}
      className="tap tap-scale flex size-9 shrink-0 items-center justify-center rounded-xl text-fg active:bg-surface-2"
    >
      {icon}
    </button>
  );
}
