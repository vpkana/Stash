'use client';

import * as React from 'react';
import { ArrowUp } from '@/components/ui/icons';
import type { DragOutZoneProps } from '@/hooks/use-drag-sort';
import { cn } from '@/lib/utils';

/**
 * The way out of the directory you are in.
 *
 * Dragging is how things move in this app now, which leaves one case with no
 * gesture: taking an item *out* of the folder you are looking at, where the
 * destination is not on screen to drop onto. The old answer was a
 * `Move to another folder` menu row that listed the entire tree, which is a
 * question the user has already answered — they know the item belongs one level
 * up, and the tree is a detour.
 *
 * So there is one target, it sits above the list, and it names where the drop
 * goes ("Move out to Development"). It is a target rather than a button: the
 * gesture is the drag, and a button here would be the menu row again wearing a
 * different label.
 *
 * Rendering nothing when the caller has no `onDropOut` is deliberate — an
 * invisible hit target that silently does nothing is worse than no target.
 */
export interface DropOutZoneProps {
  zoneProps: DragOutZoneProps | null;
  /** Where the drop lands, e.g. `Move out to Development`. */
  label: string;
  className?: string;
}

export function DropOutZone({ zoneProps, label, className }: DropOutZoneProps) {
  if (!zoneProps) return null;
  const active = zoneProps['data-drop-out-active'];

  return (
    <div
      {...zoneProps}
      aria-hidden
      className={cn(
        'drop-out-zone text-meta mx-4 mt-1 flex items-center gap-2 rounded-control border px-3 py-2.5 font-medium',
        className,
      )}
    >
      <ArrowUp size={15} weight="bold" className="shrink-0" />
      <span className="truncate">{active ? 'Drop to move it out' : label}</span>
    </div>
  );
}
