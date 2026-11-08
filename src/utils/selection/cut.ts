/**
 * Cut the selection: copy it, then remove it from the editor.
 *
 * The order matters and is not incidental. The text is copied first and the
 * deletion only happens if the copy succeeded, so a device where the clipboard is
 * unavailable loses nothing: a cut that silently deletes without copying is the
 * worst possible outcome for a notes app, and it is one clipboard permission
 * refusal away on a platform that cannot report it.
 *
 * The deletion itself is range surgery (see `deleteRangeContents`), which keeps
 * the surrounding formatting and block structure intact instead of asking the
 * engine to rebuild the line. The caret is returned rather than placed by the
 * caller so it can also be remembered as the editor's last range.
 */

import { copySelection } from './copy';
import { deleteRangeContents } from './range';

export interface CutResult {
  /** True only when the text was copied *and* removed. */
  cut: boolean;
  text: string;
  /** The collapsed caret where the removed text was, if the cut happened. */
  range: Range | null;
}

export async function cutSelection(
  host: HTMLElement,
  remembered?: Range | null,
): Promise<CutResult> {
  const copied = await copySelection(host, remembered);

  if (!copied.copied || !copied.range || !copied.text) {
    return { cut: false, text: copied.text, range: copied.range };
  }

  const caret = deleteRangeContents(host, copied.range);
  if (!caret) return { cut: false, text: copied.text, range: copied.range };

  return { cut: true, text: copied.text, range: caret };
}
