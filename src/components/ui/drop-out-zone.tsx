'use client';

import * as React from 'react';
import { ArrowUp } from '@/components/ui/icons';
import type { DragOutZoneProps } from '@/hooks/use-drag-sort';
import { cn } from '@/lib/utils';

/**
 * The way out of the directory you are in.
 *
 * Dragging is how things move in this app, which leaves one case with no gesture:
 * taking an item *out* of the folder or note you are looking at, where the
 * destination is not on screen to drop onto.
 *
 * It exists **only while something is being dragged**. Rendering it at rest made
 * a permanent control out of a target that can only be hit mid-gesture, and it
 * read as a button — "Move out to Development" — that did nothing when pressed.
 * The slot stays in the layout (invisible) so the list does not jump under the
 * finger the instant a drag begins; the bar itself fades in with the lift.
 *
 * ## Why it looks like a slot and not a button
 *
 * A solid fill is what this app uses for things you can press, and this is not
 * one: it is somewhere to put something down. So it is a dashed outline with no
 * fill of its own, a small arrow saying which direction the item leaves in, and
 * the label kept quiet. The earlier version used a tinted panel with a coloured
 * circle around the arrow, which read as a chunky secondary button competing with
 * the rows above and below it — the target was doing the one thing a drop target
 * must not do, which is look like the thing you were already trying to move.
 */
export interface DropOutZoneProps {
  zoneProps: DragOutZoneProps | null;
  /** Where the drop lands, e.g. `Move out to Development`. */
  label: string;
  /** True while a drag is in flight. The bar is invisible but laid out otherwise. */
  visible: boolean;
  className?: string;
}

export function DropOutZone({ zoneProps, label, visible, className }: DropOutZoneProps) {
  if (!zoneProps) return null;
  const active = zoneProps['data-drop-out-active'];

  return (
    <div
      {...zoneProps}
      aria-hidden
      data-drop-out-visible={visible}
      className={cn(
        'drop-out-zone text-meta mx-4 mt-1 flex items-center justify-center gap-2 rounded-full px-4 py-2.5 font-medium',
        className,
      )}
    >
      <ArrowUp size={14} weight="bold" className="drop-out-arrow shrink-0" aria-hidden />
      <span className="truncate">{active ? 'Release to move it out' : label}</span>
    </div>
  );
}
