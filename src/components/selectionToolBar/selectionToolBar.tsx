'use client';

import * as React from 'react';
import { ClipboardText, Copy, Scissors, Search, SelectionAll } from '@/components/ui/icons';
import './selectionToolBar.css';

/**
 * The Stash text-selection toolbar.
 *
 * It replaces Android's floating Cut / Copy / Paste menu over the note body (see
 * `MainActivity` and `EmptySelectionActionMode` for the native half) and does the
 * same job with the app's own surface: the same tokens, the same radii, the same
 * light and dark themes as the rest of the interface.
 *
 * Three rules make it usable over a live selection:
 *
 *  1. **It is outside the editable.** It is a sibling of the `contentEditable`,
 *     never a child, so it cannot become part of the note, cannot be serialised
 *     into the Markdown and cannot move the caret when it appears.
 *  2. **It never takes focus.** `preventDefault` on `mousedown` keeps the
 *     editable focused and the selection alive on the web; on Android, where the
 *     selection can still collapse when a button is tapped, the editor keeps
 *     `lastRange` and the actions fall back to it (see `utils/selection`).
 *  3. **It only exists when there is a selection.** Positioning is the editor's:
 *     this component renders where it is told and nothing else.
 */
export type SelectionToolbarPlacement = 'above' | 'below';

export interface SelectionToolbarProps {
  visible: boolean;
  /** Viewport x of the selection's centre; the toolbar is centred on it. */
  left: number;
  /** Viewport y of the selection's top (above) or bottom (below). */
  top: number;
  placement?: SelectionToolbarPlacement;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onBrowse: () => void;
}

export default function SelectionToolbar({
  visible,
  left,
  top,
  placement = 'above',
  onCopy,
  onCut,
  onPaste,
  onSelectAll,
  onBrowse,
}: SelectionToolbarProps) {
  if (!visible) return null;

  return (
    <div
      className="selection-toolbar"
      data-selection-toolbar=""
      data-placement={placement}
      role="toolbar"
      aria-label="Text selection"
      style={{ left, top }}
      // Keeps the caret and the selection where they are when the toolbar is
      // pressed. Without this, the first mousedown blurs the editable and the
      // actions have nothing to work on.
      onMouseDown={(event) => event.preventDefault()}
    >
      <ToolbarButton label="Copy" icon={<Copy size={17} />} onSelect={onCopy} />
      <ToolbarButton label="Cut" icon={<Scissors size={17} />} onSelect={onCut} />
      <ToolbarButton label="Paste" icon={<ClipboardText size={17} />} onSelect={onPaste} />
      <span className="selection-toolbar-divider" aria-hidden />
      <ToolbarButton label="Select all" icon={<SelectionAll size={17} />} onSelect={onSelectAll} />
      <span className="selection-toolbar-divider" aria-hidden />
      <ToolbarButton label="Search on Google" icon={<Search size={17} />} onSelect={onBrowse} />
    </div>
  );
}

function ToolbarButton({
  label,
  icon,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="selection-toolbar-button"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      {icon}
    </button>
  );
}
