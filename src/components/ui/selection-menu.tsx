'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Copy, Cut, Paste, SelectAll } from '@/components/ui/icons';

/**
 * The app's own selection menu, for every editable surface in the app.
 *
 * ## Why it exists
 *
 * Android's text-selection menu belongs to the WebView, not to the app: it cannot
 * be sized, styled or placed, and on this WebView it paints a slab of background
 * several menu rows taller than the words it belongs to. The alternative is to
 * say what the menu is — four actions — in a pill of our own. That is this file,
 * and it is mounted once, in the root layout, so a selection in the note body, in
 * the note's title, in the title field of a link or in a folder's rename field all
 * get the same menu.
 *
 * ## Why the native menu is not simply replaced
 *
 * It cannot be dismissed from the page: the flag that withholds it lives in the
 * WebView (`StashWebView`), and the page asks for it over the bridge. Every
 * surface in the app but the editables has text selection turned off in CSS, so a
 * selection only ever exists where this bar also exists — which is why the
 * platform's menu is withheld for good rather than only while something is
 * focused.
 *
 * ## What it acts on
 *
 * A selection, remembered — not the live one. A tap collapses the browser's
 * selection before its click is delivered, so a bar that read the selection at
 * the moment of the tap would act on nothing at all. The range (or the field's
 * `selectionStart`/`selectionEnd`) is captured when the bar appears, put back
 * before every action, and dropped 180 ms after the selection goes away — long
 * enough for the tap on the bar to arrive first.
 *
 * ## The handles
 *
 * WebView draws its own drag handles in popup windows that no app can reach, so
 * they cannot be replaced — only prevented. They are prevented by refusing the
 * selection itself (`selectstart`), which is what `handleDragSelection` then
 * builds by hand: a word under a long press, moved by two handles of our own.
 * That only happens if the platform really does hand the selection back; on a
 * WebView that does not, `nativeSelection` stays false and the platform's
 * handles are left exactly as they are.
 */

interface SelectionMenuPlugin {
  setSuppressed(options: { suppressed: boolean }): Promise<void>;
}

interface ClipboardPlugin {
  read(): Promise<{ text: string }>;
}

const selectionMenu = registerPlugin<SelectionMenuPlugin>('SelectionMenu');
const clipboard = registerPlugin<ClipboardPlugin>('Clipboard');

/**
 * The platform where the system menu is a problem.
 *
 * Android is where it is an unstylable slab. iOS draws its own callout, which
 * cannot be withdrawn without native work, so there the platform's menu is left
 * alone and this bar is not drawn beside it.
 */
function isAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/**
 * The platform where a bar of our own would sit beside one that cannot be
 * withdrawn: iOS draws its own callout and keeps it. There the platform's menu is
 * the menu, and this bar is not drawn at all.
 */
function isIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

/** Input types whose text can be selected; a checkbox has no selection to offer. */
const SELECTABLE_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
  'number',
]);

/** The box around a selection, in viewport pixels. */
interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/**
 * What the bar is acting on.
 *
 * Two kinds, because a field and a rich editor disagree about what a selection
 * is: inside `<input>` and `<textarea>` it is a pair of offsets into `value`, and
 * there is no DOM range to ask for geometry. `range` is cloned, so it outlives the
 * live selection it came from.
 */
type Target =
  | { kind: 'range'; element: HTMLElement; range: Range }
  | {
      kind: 'field';
      field: HTMLInputElement | HTMLTextAreaElement;
      start: number;
      end: number;
    };

/** One end of a selection, where a handle hangs. */
interface HandlePoint {
  x: number;
  y: number;
  height: number;
}

/* -------------------------------------------------------------------------- */
/* Reading the selection                                                       */
/* -------------------------------------------------------------------------- */

/** The editable whose text is selected right now, if any. */
function readTarget(): Target | null {
  const active = document.activeElement;

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active.disabled || active.readOnly) return null;
    if (active instanceof HTMLInputElement && !SELECTABLE_INPUT_TYPES.has(active.type)) return null;
    const { selectionStart: start, selectionEnd: end } = active;
    if (start === null || end === null || start === end) return null;
    return { kind: 'field', field: active, start, end };
  }

  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const node = range.commonAncestorContainer;
  const element = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
    '[contenteditable="true"], [contenteditable=""]',
  );
  if (!element) return null;
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  return { kind: 'range', element, range };
}

/**
 * Where the selection in a field is, on screen.
 *
 * A field does not expose the geometry of its own selection — there is no range
 * inside one — so the text is laid out a second time in a hidden box carrying the
 * field's own font metrics, exactly over the field, and the position of the
 * selected run is read from that copy. Because the copy sits where the field sits,
 * its coordinates are the field's coordinates, with no arithmetic to get wrong.
 */
function measureField(
  field: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
): Box | null {
  const rect = field.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const style = window.getComputedStyle(field);

  const mirror = document.createElement('div');
  const copied = [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-variant',
    'letter-spacing',
    'line-height',
    'text-align',
    'text-transform',
    'text-indent',
    'word-spacing',
    'direction',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ];
  for (const property of copied) mirror.style.setProperty(property, style.getPropertyValue(property));

  Object.assign(mirror.style, {
    position: 'fixed',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    boxSizing: 'border-box',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
    whiteSpace: field instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre',
    overflowWrap: 'break-word',
  } satisfies Partial<CSSStyleDeclaration>);

  const selected = document.createElement('span');
  selected.textContent = field.value.slice(start, end) || '\u200b';
  mirror.append(
    document.createTextNode(field.value.slice(0, start)),
    selected,
    document.createTextNode(field.value.slice(end)),
  );

  document.body.appendChild(mirror);
  // A field scrolled to its own caret: the copy has to be scrolled the same way.
  mirror.scrollTop = field.scrollTop;
  mirror.scrollLeft = field.scrollLeft;
  const box = selected.getBoundingClientRect();
  mirror.remove();

  return {
    top: box.top,
    bottom: box.bottom,
    left: box.left,
    right: box.right,
    width: box.width,
    height: box.height,
  };
}

/** The box the bar hangs over: the first line of the selection. */
function boxOf(target: Target): Box | null {
  if (target.kind === 'field') return measureField(target.field, target.start, target.end);
  const rects = Array.from(target.range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  const rect = rects[0] ?? target.range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    width: rect.width,
    height: rect.height,
  };
}

/** The two ends of a range, where the handles hang. */
function handlePointsOf(range: Range): { start: HandlePoint; end: HandlePoint } | null {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length === 0) return null;
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return null;
  return {
    start: { x: first.left, y: first.top, height: first.height },
    end: { x: last.right, y: last.top, height: last.height },
  };
}

/* -------------------------------------------------------------------------- */
/* Editing                                                                     */
/* -------------------------------------------------------------------------- */

/** Put text on the clipboard when the engine will not do it for us. */
function writeClipboard(text: string): void {
  if (!text) return;
  try {
    void navigator.clipboard.writeText(text).catch(() => {
      /* nothing left to fall back to: the words are still selected on screen */
    });
  } catch {
    /* no clipboard in this context */
  }
}

/**
 * The system clipboard: through the bridge on Android, the browser API elsewhere.
 *
 * `navigator.clipboard.readText()` always rejects inside an Android WebView — the
 * permission it asks for cannot be granted to a page in one — so reading is the
 * one clipboard operation that has to cross the bridge.
 */
async function readClipboard(): Promise<string> {
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

/**
 * Replace `[start, end)` in a field and tell React about it.
 *
 * `input` is what makes a controlled field update: React compares the node's value
 * with the one it last wrote, and `setRangeText` has moved it on.
 */
function replaceFieldRange(
  field: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
): void {
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

/** Tell the editor that its DOM changed without an editing command. */
function announceEdit(element: HTMLElement, inputType: string): void {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
}

/**
 * The caret position nearest a point, inside `element`.
 *
 * Outside the words — above, below, left, right — the selection simply runs to
 * that end of the editor, which is what dragging a handle past the text does
 * everywhere else too.
 */
function caretPoint(
  element: HTMLElement,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const caret = (
    document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  ).caretRangeFromPoint?.(x, y);
  if (caret && element.contains(caret.startContainer)) {
    return { node: caret.startContainer, offset: caret.startOffset };
  }

  const rect = element.getBoundingClientRect();
  if (y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right) return null;
  const edge = document.createRange();
  edge.selectNodeContents(element);
  edge.collapse(y < rect.top || (y <= rect.bottom && x < rect.left));
  return { node: edge.startContainer, offset: edge.startOffset };
}

/** Grow a collapsed range to the word it sits in. */
function expandToWord(range: Range): void {
  const expandable = range as Range & { expand?: (unit: string) => void };
  if (typeof expandable.expand === 'function') {
    try {
      expandable.expand('word');
      return;
    } catch {
      /* fall through to counting characters */
    }
  }
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const text = node.textContent ?? '';
  let start = range.startOffset;
  let end = range.endOffset;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start -= 1;
  while (end < text.length && !/\s/.test(text.charAt(end))) end += 1;
  range.setStart(node, start);
  range.setEnd(node, end);
}

/* -------------------------------------------------------------------------- */
/* The menu                                                                    */
/* -------------------------------------------------------------------------- */

export function SelectionMenu() {
  const [target, setTarget] = React.useState<Target | null>(null);
  const [anchor, setAnchor] = React.useState<Box | null>(null);
  /**
   * Set once the platform has asked to make a selection of its own and been
   * refused. Until that happens this app has no way to know whether the WebView
   * will hand selection over at all, and drawing handles over the platform's own
   * would be worse than leaving it alone.
   */
  const [ownsSelection, setOwnsSelection] = React.useState(false);

  const targetRef = React.useRef<Target | null>(null);
  const hideTimer = React.useRef<number | null>(null);
  /** The end of the selection that is not being dragged. */
  const dragAnchor = React.useRef<{ node: Node; offset: number } | null>(null);
  const dragEdge = React.useRef<'start' | 'end' | null>(null);

  const keep = React.useCallback((next: Target | null) => {
    targetRef.current = next;
    setTarget(next);
    if (!next) setAnchor(null);
  }, []);

  const cancelHide = React.useCallback(() => {
    if (hideTimer.current === null) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);

  const dismiss = React.useCallback(() => {
    cancelHide();
    keep(null);
  }, [cancelHide, keep]);

  /**
   * Take the bar away shortly after the selection stops being one.
   *
   * Not immediately: the click from a tap on the bar can arrive after the browser
   * has already collapsed the selection, and a bar that unmounts in between never
   * receives the click that would have copied anything. Every press on the bar
   * cancels the delay, and the question is asked again before it hides.
   */
  const scheduleDismiss = React.useCallback(() => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      if (!readTarget()) dismiss();
    }, 180);
  }, [cancelHide, dismiss]);

  /** Ask the platform what is selected now, and put the bar where it belongs. */
  const refresh = React.useCallback(() => {
    const found = readTarget();
    if (!found) {
      // Nothing selected and nothing remembered: the common case, on every
      // keystroke and every tap. No reason to start a timer for it.
      if (targetRef.current) scheduleDismiss();
      return;
    }
    const box = boxOf(found);
    if (!box) {
      scheduleDismiss();
      return;
    }
    cancelHide();
    keep(found);
    setAnchor(box);
  }, [cancelHide, keep, scheduleDismiss]);

  React.useEffect(() => {
    // `selectionchange` on the document covers rich editors; a field reports its
    // own selection on the element, which capture still sees here.
    document.addEventListener('selectionchange', refresh, true);
    document.addEventListener('select', refresh, true);
    document.addEventListener('pointerup', refresh, true);
    document.addEventListener('keyup', refresh, true);
    return () => {
      document.removeEventListener('selectionchange', refresh, true);
      document.removeEventListener('select', refresh, true);
      document.removeEventListener('pointerup', refresh, true);
      document.removeEventListener('keyup', refresh, true);
    };
  }, [refresh]);

  /*
   * Follow the words when the page moves, and drop the bar when they leave the
   * screen.
   *
   * Hiding on every scroll would be the easier rule and the wrong one: Android
   * scrolls the page a little by itself when a selection is made, so the bar would
   * vanish at the instant it appeared.
   */
  React.useEffect(() => {
    let frame = 0;
    const follow = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = targetRef.current;
        if (!current) return;
        const box = boxOf(current);
        if (!box) return;
        const height = window.visualViewport?.height ?? window.innerHeight;
        if (box.bottom < 0 || box.top > height) {
          dismiss();
          return;
        }
        setAnchor((previous) =>
          previous &&
          Math.abs(previous.top - box.top) < 1 &&
          Math.abs(previous.left - box.left) < 1 &&
          Math.abs(previous.width - box.width) < 1
            ? previous
            : box,
        );
      });
    };
    window.addEventListener('scroll', follow, true);
    return () => {
      window.removeEventListener('scroll', follow, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [dismiss]);

  /*
   * A real viewport change — the keyboard opening or closing, a rotation — takes
   * the bar away. Small changes are ignored on purpose: Android resizes the visual
   * viewport a little for the selection handles themselves.
   */
  React.useEffect(() => {
    const hide = () => dismiss();
    window.addEventListener('resize', hide);
    const viewport = window.visualViewport;
    if (!viewport) return () => window.removeEventListener('resize', hide);
    let height = viewport.height;
    const onViewportResize = () => {
      if (Math.abs(viewport.height - height) < 120) return;
      height = viewport.height;
      dismiss();
    };
    viewport.addEventListener('resize', onViewportResize);
    return () => {
      window.removeEventListener('resize', hide);
      viewport.removeEventListener('resize', onViewportResize);
    };
  }, [dismiss]);

  /*
   * Withhold the platform's menu for as long as the app is running.
   *
   * Deliberately not tied to focus. A long press on a body that does not have
   * focus yet is the ordinary case — the editor was left a moment ago, the finger
   * comes back — and on that path the platform asks for its menu before the page
   * is told anything about focus, so a flag set from `focusin` arrives after the
   * slab has already been shown. Focus is also not needed to decide: selection is
   * allowed nowhere but the editables (`globals.css`), and every one of them has
   * this bar, so there is no surface left that wants the platform's menu.
   */
  React.useEffect(() => {
    if (!isAndroid()) return;
    void selectionMenu.setSuppressed({ suppressed: true }).catch(() => {
      // No plugin: a web build, or a native build whose WebView could not be
      // swapped for `StashWebView`. Nothing to withhold, and nothing to say.
    });
    return () => {
      void selectionMenu.setSuppressed({ suppressed: false }).catch(() => {});
    };
  }, []);

  /*
   * Own the selection, or leave it alone.
   *
   * WebView's handles are popup windows, unreachable from this side and drawn
   * above the page: the only way to have handles of our own is for the platform
   * never to make a selection in the first place. Refusing `selectstart` does
   * exactly that and nothing else — typing, the caret and scrolling are untouched,
   * because the refusal happens while Blink is building a selection, not while the
   * finger is moving. If a build never asks, nothing is refused, `ownsSelection`
   * stays false, and the platform's handles keep working as they do today.
   */
  React.useEffect(() => {
    if (!isAndroid()) return;
    const onSelectStart = (event: Event) => {
      const node = event.target;
      if (!(node instanceof Element)) return;
      // Fields keep their own selection: they have no range to rebuild by hand,
      // and their handles are the only way to place one.
      if (node.closest('input, textarea')) return;
      if (!node.closest('[contenteditable="true"], [contenteditable=""]')) return;
      event.preventDefault();
      setOwnsSelection(true);
    };
    document.addEventListener('selectstart', onSelectStart);
    return () => document.removeEventListener('selectstart', onSelectStart);
  }, []);

  /*
   * A long press selects the word under it, and a double tap does the same — the
   * gestures Android's own selection answers to, now that the refusal above means
   * this app is the one that has to answer them.
   */
  React.useEffect(() => {
    if (!isAndroid()) return;
    let timer = 0;
    let origin: { x: number; y: number } | null = null;
    let element: HTMLElement | null = null;
    let lastTap = { at: 0, x: 0, y: 0 };

    const cancel = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      origin = null;
      element = null;
    };

    const selectWordAt = (host: HTMLElement, x: number, y: number) => {
      const point = caretPoint(host, x, y);
      if (!point) return;
      const range = document.createRange();
      range.setStart(point.node, point.offset);
      range.collapse(true);
      expandToWord(range);
      if (range.collapsed) return;
      if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return;
      const selection = document.getSelection();
      if (!selection) return;
      host.focus({ preventScroll: true });
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      const node = event.target;
      if (!(node instanceof Element)) return;
      if (node.closest('[data-selection-bar], [data-selection-handle]')) return;
      const host = node.closest<HTMLElement>('[contenteditable="true"], [contenteditable=""]');
      if (!host) return;

      const now = Date.now();
      const doubleTap =
        now - lastTap.at < 320 &&
        Math.abs(event.clientX - lastTap.x) < 24 &&
        Math.abs(event.clientY - lastTap.y) < 24;
      lastTap = { at: now, x: event.clientX, y: event.clientY };
      if (doubleTap) {
        cancel();
        selectWordAt(host, event.clientX, event.clientY);
        return;
      }

      cancel();
      origin = { x: event.clientX, y: event.clientY };
      element = host;
      timer = window.setTimeout(() => {
        timer = 0;
        const at = origin;
        const host = element;
        if (!at || !host) return;
        selectWordAt(host, at.x, at.y);
      }, 420);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!origin) return;
      if (Math.abs(event.clientX - origin.x) > 8 || Math.abs(event.clientY - origin.y) > 8) {
        cancel();
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', cancel, true);
    document.addEventListener('pointercancel', cancel, true);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', cancel, true);
      document.removeEventListener('pointercancel', cancel, true);
    };
  }, []);

  /* --- Actions ------------------------------------------------------------ */

  /**
   * Put the remembered selection back in the browser and on screen.
   *
   * `null` means it no longer belongs to this document — the note was re-rendered
   * under it, the field unmounted — because acting on a stale selection puts text
   * in the wrong place, silently.
   */
  const restore = React.useCallback((): Target | null => {
    const current = targetRef.current;
    if (!current) return null;

    if (current.kind === 'field') {
      if (!current.field.isConnected) return null;
      current.field.focus({ preventScroll: true });
      current.field.setSelectionRange(current.start, current.end);
      return current;
    }

    if (!current.element.isConnected) return null;
    if (!current.element.contains(current.range.startContainer)) return null;
    if (!current.element.contains(current.range.endContainer)) return null;
    current.element.focus({ preventScroll: true });
    const selection = document.getSelection();
    if (!selection) return null;
    selection.removeAllRanges();
    selection.addRange(current.range);
    return current;
  }, []);

  const copySelection = React.useCallback(() => {
    cancelHide();
    const current = restore();
    if (!current) return;
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    if (copied) return;
    writeClipboard(
      current.kind === 'field'
        ? current.field.value.slice(current.start, current.end)
        : current.range.toString(),
    );
  }, [cancelHide, restore]);

  const cutSelection = React.useCallback(() => {
    cancelHide();
    const current = restore();
    if (!current) return;
    let cut = false;
    try {
      cut = document.execCommand('cut');
    } catch {
      cut = false;
    }
    if (!cut) {
      // Refused by the engine: copy by hand, then take the words out ourselves.
      if (current.kind === 'field') {
        const text = current.field.value.slice(current.start, current.end);
        writeClipboard(text);
        replaceFieldRange(current.field, current.start, current.end, '');
      } else {
        writeClipboard(current.range.toString());
        current.range.deleteContents();
        announceEdit(current.element, 'deleteByCut');
      }
    }
    dismiss();
  }, [cancelHide, dismiss, restore]);

  const pasteSelection = React.useCallback(() => {
    cancelHide();
    /*
     * The selection is taken now, not after the clipboard answers: reading it is a
     * round trip through the bridge, and in that time the tap on the bar may have
     * collapsed the selection and the bar may have been dismissed.
     */
    const current = targetRef.current;
    if (!current) return;
    void readClipboard().then((text) => {
      if (!text) return;

      if (current.kind === 'field') {
        const field = current.field;
        if (!field.isConnected) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(current.start, current.end);
        replaceFieldRange(field, current.start, current.end, text);
        dismiss();
        return;
      }

      const element = current.element;
      if (!element.isConnected) return;
      if (!element.contains(current.range.startContainer)) return;
      if (!element.contains(current.range.endContainer)) return;
      element.focus({ preventScroll: true });
      const selection = document.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(current.range);
      /*
       * `insertText` is the browser's own edit: it replaces the selection, fires
       * an input event (so the Markdown is written and autosaved) and splits
       * paragraphs the way typing does. The DOM insertion is only for engines that
       * refuse it.
       */
      if (!document.execCommand('insertText', false, text)) {
        current.range.deleteContents();
        current.range.insertNode(document.createTextNode(text));
        announceEdit(element, 'insertFromPaste');
      }
      dismiss();
    });
  }, [cancelHide, dismiss]);

  const selectAll = React.useCallback(() => {
    cancelHide();
    const current = targetRef.current;
    if (!current) return;
    if (current.kind === 'field') {
      const field = current.field;
      if (!field.isConnected) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(0, field.value.length);
      return;
    }
    const element = current.element;
    element.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }, [cancelHide]);

  /* --- Handles ------------------------------------------------------------ */

  const onHandleDown = React.useCallback(
    (edge: 'start' | 'end', event: React.PointerEvent<HTMLDivElement>) => {
      const current = targetRef.current;
      if (current?.kind !== 'range') return;
      cancelHide();
      event.preventDefault();
      event.stopPropagation();
      dragEdge.current = edge;
      // The other end is pinned for the whole drag, even when the selection turns
      // around, so the two handles cannot swap roles mid-gesture.
      dragAnchor.current =
        edge === 'start'
          ? { node: current.range.endContainer, offset: current.range.endOffset }
          : { node: current.range.startContainer, offset: current.range.startOffset };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [cancelHide],
  );

  const onHandleMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const edge = dragEdge.current;
    const fixed = dragAnchor.current;
    const current = targetRef.current;
    if (!edge || !fixed || current?.kind !== 'range') return;
    const point = caretPoint(current.element, event.clientX, event.clientY);
    if (!point) return;

    // Whichever end is now earlier becomes the start: dragging one handle past the
    // other is how a selection is turned around.
    const dragged = document.createRange();
    dragged.setStart(point.node, point.offset);
    dragged.collapse(true);
    const anchor = document.createRange();
    anchor.setStart(fixed.node, fixed.offset);
    anchor.collapse(true);

    const next = document.createRange();
    if (dragged.compareBoundaryPoints(Range.START_TO_START, anchor) <= 0) {
      next.setStart(point.node, point.offset);
      next.setEnd(fixed.node, fixed.offset);
    } else {
      next.setStart(fixed.node, fixed.offset);
      next.setEnd(point.node, point.offset);
    }

    const selection = document.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(next);
  }, []);

  const onHandleUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragEdge.current) return;
    dragEdge.current = null;
    dragAnchor.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const points =
    ownsSelection && target?.kind === 'range' ? handlePointsOf(target.range) : null;

  if (!anchor || isIOS()) return null;

  return createPortal(
    <>
      <SelectionBar
        anchor={anchor}
        onInteract={cancelHide}
        onCut={cutSelection}
        onCopy={copySelection}
        onPaste={pasteSelection}
        onSelectAll={selectAll}
      />
      {points ? (
        <>
          <SelectionHandle
            point={points.start}
            onDown={(event) => onHandleDown('start', event)}
            onMove={onHandleMove}
            onUp={onHandleUp}
          />
          <SelectionHandle
            point={points.end}
            onDown={(event) => onHandleDown('end', event)}
            onMove={onHandleMove}
            onUp={onHandleUp}
          />
        </>
      ) : null}
    </>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The pill over a selection.
 *
 * The four actions Android's menu offers over an editable selection, in a shape
 * that sits above the words rather than across them. It measures itself before it
 * is placed, because where it can sit depends on how wide it turned out: above the
 * selection unless there is no room there, and never off either edge.
 */
function SelectionBar({
  anchor,
  onCut,
  onCopy,
  onPaste,
  onSelectAll,
  onInteract,
}: {
  anchor: Box;
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
    // Above the words, and below them only when the selection is near the top of
    // the screen — the same rule the platform's own menu follows.
    let top = anchor.top - height - gap;
    if (top < edge) top = anchor.bottom + gap;
    top = Math.min(top, Math.max(edge, viewportHeight - height - edge));

    setPlace({ top, left });
  }, [anchor]);

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selection actions"
      data-selection-bar
      /*
       * `z-[70]` puts the bar above every sheet and dialog (all `z-50`) and above
       * the toasts (`z-[60]`), but still below the privacy gates (`z-[100]`,
       * `z-[120]`), which must stay on top of everything. Portals mount in the
       * order they are created, and a sheet opens long after this bar did, so an
       * equal layer would leave the bar painted underneath the sheet it belongs
       * to — which is exactly what a selection in a link's title field looked
       * like.
       *
       * `pointer-events-auto` is load-bearing rather than decorative: a modal
       * sheet sets `pointer-events: none` on `<body>` while it is open, and this
       * bar is a child of `<body>`. Without it the bar would be visible over the
       * sheet and untouchable — every press passing through to the words behind
       * it.
       */
      className="animate-pop-in pointer-events-auto fixed z-[70] flex items-center gap-0.5 rounded-2xl border border-border bg-surface/95 p-1 shadow-raised backdrop-blur-xl"
      style={{
        top: place?.top ?? anchor.top,
        left: place?.left ?? anchor.left,
        // The first pass exists only to be measured.
        visibility: place ? 'visible' : 'hidden',
      }}
      /*
       * A bar that takes focus is a bar that drops the selection it is about to act
       * on — and on Android it would also close the keyboard. Swallowing the
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
    </div>
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

/**
 * One end of the selection, and the finger that moves it.
 *
 * The visible part is a dot under the line of text; the touch target is the
 * transparent square around it, which is what a finger actually needs. The square
 * takes the gesture (`touch-action: none`) so dragging a handle never scrolls the
 * page out from under it.
 */
function SelectionHandle({
  point,
  onDown,
  onMove,
  onUp,
}: {
  point: HandlePoint;
  onDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onUp: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      data-selection-handle
      /*
       * Decorative to assistive technology: the words are selected in the document
       * either way, and the bar is where the actions are. This is a finger target.
       */
      aria-hidden
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      /* Layer and pointer events for the same two reasons as the bar itself. */
      className="pointer-events-auto fixed z-[70] flex size-11 touch-none items-start justify-center"
      style={{
        // The dot is centred in the square: its middle lands just under the line.
        top: point.y + point.height - 6,
        left: point.x - 22,
      }}
    >
      <span className="size-3.5 rounded-full border-2 border-accent bg-surface shadow-raised" />
    </div>
  );
}
