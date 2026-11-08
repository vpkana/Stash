/**
 * Paste the clipboard at the caret, or over the selection.
 *
 * The insertion goes through the editing command the rest of this editor already
 * uses (`insertHTML` for links, formatting commands for the toolbar). That is not
 * a new dependency: it is the same mechanism, in the same place, because plain
 * text insertion is where it earns its keep — it splits blocks, carries the
 * existing inline formatting at the caret and leaves a correct caret at the end,
 * all of which a hand-written walk over the DOM would have to reproduce and get
 * subtly wrong. What is deliberately *not* used is the engine's HTML paste: the
 * clipboard is read as text and inserted as escaped text, so a copied web page
 * cannot smuggle markup, styles or scripts into the note.
 *
 * The caller owns serialising the result. `RichTextEditor` calls its normal
 * `emit()` afterwards, which is the same path a keystroke takes, so autosave
 * treats a paste exactly like typing.
 */

import { readClipboardText } from './clipboard';
import { resolveSelectionRange, restoreSelectionRange } from './range';

export interface PasteResult {
  /** True when text was inserted. */
  pasted: boolean;
  /** The clipboard text, or an empty string when there was none. */
  text: string;
  /** False when the clipboard could not be read at all (permission, old build). */
  readable: boolean;
}

export async function pasteSelection(
  host: HTMLElement,
  remembered?: Range | null,
): Promise<PasteResult> {
  const text = await readClipboardText();
  if (text === null) return { pasted: false, text: '', readable: false };
  if (!text) return { pasted: false, text, readable: true };

  const range = resolveSelectionRange(host, remembered);
  if (!range) return { pasted: false, text, readable: true };

  /*
   * Re-select exactly what the user had. A non-collapsed range here is how
   * "paste over the selection" works: the command replaces whatever is selected.
   */
  if (!restoreSelectionRange(host, range)) {
    return { pasted: false, text, readable: true };
  }

  let pasted = false;
  try {
    pasted = document.execCommand('insertText', false, text);
  } catch {
    pasted = false;
  }

  return { pasted, text, readable: true };
}
