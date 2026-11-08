/**
 * Reusable text-selection operations for an editable surface.
 *
 * The toolbar is one consumer; these exist on their own so a keyboard shortcut, a
 * context menu or a future editor can do the same things without importing the
 * toolbar's React component.
 */

export { browseSelection, googleSearchUrl, type BrowseResult } from './browse';
export { copySelection, type CopyResult } from './copy';
export { cutSelection, type CutResult } from './cut';
export { pasteSelection, type PasteResult } from './paste';
export { selectAllInEditor } from './select-all';
export {
  readClipboardText,
  usesNativeClipboard,
  writeClipboardText,
} from './clipboard';
export {
  deleteRangeContents,
  isRangeInsideEditor,
  liveSelectionRange,
  rangeText,
  resolveSelectionRange,
  restoreSelectionRange,
  selectionRect,
} from './range';
