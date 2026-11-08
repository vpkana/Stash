/**
 * Select everything in the note body — and nothing else.
 *
 * `document.execCommand('selectAll')` and Ctrl+A both select the whole document,
 * which in this app means the title, the status line and the toolbar. Selecting
 * only the editable node is what makes the gesture mean "this note", which is the
 * only thing the user can see when the editor fills the screen.
 *
 * The selection is set through the document's Selection object rather than
 * through a synthetic keyboard event, so the browser draws its own selection
 * (and, on Android, its own handles) exactly as it would for a drag. The returned
 * range lets the caller remember it as the editor's last position.
 */

import { restoreSelectionRange } from './range';

export function selectAllInEditor(host: HTMLElement): Range | null {
  if (typeof document === 'undefined') return null;
  if (host.childNodes.length === 0) return null;

  const range = document.createRange();
  range.selectNodeContents(host);

  if (!restoreSelectionRange(host, range)) return null;
  return range;
}
