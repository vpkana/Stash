/**
 * Copy the selection.
 *
 * The range is resolved and its text read *before* the clipboard is touched. On
 * Android a toolbar tap can move focus out of the editable and collapse the
 * browser's selection, so a helper that read the text after an await would
 * sometimes copy an empty string. Here the text is captured first and only then
 * handed to whichever clipboard the platform has.
 */

import { writeClipboardText } from './clipboard';
import { rangeText, resolveSelectionRange } from './range';

export interface CopyResult {
  /** True only when the clipboard was written. */
  copied: boolean;
  /** What was copied — also what the toolbar can report back. */
  text: string;
  /** The range that was copied, so a caller can keep the selection around. */
  range: Range | null;
}

export async function copySelection(
  host: HTMLElement,
  remembered?: Range | null,
): Promise<CopyResult> {
  const range = resolveSelectionRange(host, remembered);
  if (!range) return { copied: false, text: '', range: null };

  const text = rangeText(range);
  if (!text) return { copied: false, text: '', range };

  const copied = await writeClipboardText(text);
  return { copied, text, range };
}
