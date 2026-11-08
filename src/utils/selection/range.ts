/**
 * Selection primitives for the note editor.
 *
 * These are the small, DOM-only operations the selection actions are built from:
 * find the range the user is talking about, read its text, put it back, delete
 * it, and say where on screen it is. Nothing here touches the clipboard, React
 * or the toolbar, so the same primitives can serve another editable surface
 * without dragging this app's UI along.
 *
 * The one rule all of them share: the editor is a boundary. A range that starts
 * inside the note body is the editor's business; a range anywhere else on the
 * page is not, and every helper here refuses to act on one. That is what keeps
 * "Select All" from selecting the application document and keeps a stray
 * document-wide selection from being copied as if it were the note.
 */

/** Whether `range` is a live range wholly inside `host`. */
export function isRangeInsideEditor(host: HTMLElement, range: Range | null): range is Range {
  if (!range) return false;
  if (!range.startContainer.isConnected) return false;
  if (!host.contains(range.startContainer)) return false;
  if (!range.collapsed && !host.contains(range.endContainer)) return false;
  return true;
}

/**
 * The selection the document currently has, if it belongs to this editor.
 *
 * Returns a clone: the caller may hold it across an asynchronous clipboard call,
 * and a live range is only safe while the DOM under it is unchanged.
 */
export function liveSelectionRange(host: HTMLElement): Range | null {
  if (typeof document === 'undefined') return null;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  if (!host.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0);
  return isRangeInsideEditor(host, range) ? range.cloneRange() : null;
}

/**
 * The exact range an action should use.
 *
 * The live selection wins. When it is gone — and on Android a tap on a button
 * can take focus and the selection away before the click handler runs — the
 * range the editor remembered is used instead, provided the node it points at is
 * still in this document. A stale range is dropped rather than applied, because
 * applying one can silently insert at the start of the note.
 */
export function resolveSelectionRange(
  host: HTMLElement,
  remembered?: Range | null,
): Range | null {
  return liveSelectionRange(host) ?? (isRangeInsideEditor(host, remembered ?? null) ? remembered! : null);
}

/** The selected text, exactly as the user sees it. */
export function rangeText(range: Range): string {
  return range.toString();
}

/**
 * The rectangle the toolbar should sit beside.
 *
 * The first client rect rather than the bounding rect: a selection spanning
 * several lines has a bounding box as wide as the column, whose centre is the
 * centre of the paragraph rather than of the words selected. The first line is
 * where the finger or the drag started, which is where a menu belongs.
 */
export function selectionRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  const first = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
  if (!first || (first.width === 0 && first.height === 0)) return null;
  return first;
}

/**
 * Put the caret (or the selection) back on this range.
 *
 * Focusing first and adding the range second is deliberate: focusing an editable
 * that lost its selection otherwise drops the caret at the start of the note,
 * and the range added afterwards is what puts it back where it was.
 */
export function restoreSelectionRange(host: HTMLElement, range: Range): boolean {
  if (typeof document === 'undefined') return false;
  if (!isRangeInsideEditor(host, range)) return false;
  if (document.activeElement !== host) host.focus({ preventScroll: true });
  const selection = document.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Delete a range's contents and leave a collapsed caret where they were.
 *
 * This is plain range surgery rather than a platform editing command, because
 * the surrounding blocks are the document's, not the command's: deleting half a
 * bold run must leave the other half formatted, and deleting a whole paragraph
 * must leave one empty paragraph rather than a new structure the serialiser
 * would have to guess at. The returned range is the caret, valid and inside the
 * editor, ready to be handed to {@link restoreSelectionRange}.
 *
 * A range that ends up in a container with nothing left in it gets an empty text
 * node to sit in: some engines refuse to draw a caret in an element with no
 * child, and the serialiser treats that node as nothing at all.
 */
export function deleteRangeContents(host: HTMLElement, range: Range): Range | null {
  if (!isRangeInsideEditor(host, range)) return null;

  const caret = range.cloneRange();
  caret.deleteContents();
  caret.collapse(true);

  if (caret.startContainer.nodeType === 1) {
    const element = caret.startContainer as Element;
    if (element.childNodes.length === 0) {
      const placeholder = document.createTextNode('');
      element.appendChild(placeholder);
      caret.setStart(placeholder, 0);
      caret.collapse(true);
    }
  }

  restoreSelectionRange(host, caret);
  return caret;
}
