'use client';

import * as React from 'react';
import { DotsSixVertical } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/**
 * The handle on a reorderable row.
 *
 * An earlier version of the drag had no handle at all, on the argument that the
 * whole row is the target and a six-dot grip asks the user to find a
 * five-millimetre thing. That argument was right about the *target* and wrong
 * about the *sign*, and the difference is the whole reason this exists: a row
 * that can be dragged has to look like one, or nobody discovers the gesture.
 *
 * So the grip is an affordance rather than the only way in. Pressing it lifts the
 * row immediately — no long press to guess at — while the rest of the row keeps
 * the long press, because it is also a button that opens something and part of a
 * list that scrolls. `data-drag-handle` is the marker the drag hook looks for;
 * `touch-none` keeps a touch that begins here from being read as a scroll.
 *
 * It is `aria-hidden` on purpose: the row already describes itself as reorderable
 * and answers to the arrow keys, so a second announcement would be noise.
 */
export function DragGrip({ className }: { className?: string }) {
  return (
    <span
      data-drag-handle
      aria-hidden
      className={cn(
        'flex w-7 shrink-0 cursor-grab touch-none items-center justify-center text-subtle/60 select-none',
        className,
      )}
    >
      <DotsSixVertical size={16} weight="bold" />
    </span>
  );
}
