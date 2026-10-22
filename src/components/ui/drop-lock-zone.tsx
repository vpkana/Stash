'use client';

import * as React from 'react';
import { Lock, Unlock } from '@/components/ui/icons';
import type { DragLockZoneProps } from '@/hooks/use-drag-sort';
import { cn } from '@/lib/utils';

/**
 * The lock, as somewhere to put something.
 *
 * Locking a folder used to be a trip through its sheet — five taps to do the one
 * thing the row could take as a gesture — while everything else about moving it
 * was already drag. This is the missing half of that gesture: drop an item here
 * and it is locked; drop one that *is* locked and you are asked for the device
 * prompt or passcode, and it is unlocked.
 *
 * ## Why it only exists while something is lifted
 *
 * The same reason the "move out" bar does: a drop target can only be hit during a
 * drop, so drawing it at rest would be a button that does nothing when pressed. It
 * fades in with the lift and out with the drop, which is also the moment the user
 * is looking for destinations.
 *
 * ## Why it is a filled tile, unlike the way out
 *
 * The way out is an edge — a slot the item leaves through — so it is a dashed
 * outline. The lock is a place, and the one place on the screen that is a *state
 * change* rather than a move, so it is allowed to read as a small, solid target.
 * It is still dashed, because nothing here is pressed; it is only bigger, tinted,
 * and labelled with a verb the user already knows.
 */
export interface DropLockZoneProps {
  zoneProps: DragLockZoneProps | null;
  /** True while the dragged item is locked, which makes this an unlock target. */
  locked: boolean;
  /** True while a drag is in flight. The tile is invisible but laid out otherwise. */
  visible: boolean;
  className?: string;
}

export function DropLockZone({ zoneProps, locked, visible, className }: DropLockZoneProps) {
  if (!zoneProps) return null;
  const active = zoneProps['data-drop-lock-active'];
  const Icon = locked ? Unlock : Lock;

  return (
    <div
      {...zoneProps}
      aria-hidden
      data-drop-lock-visible={visible}
      className={cn(
        'drop-lock-zone text-meta flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2.5 font-medium',
        className,
      )}
    >
      <Icon size={14} weight="bold" className="drop-lock-icon shrink-0" aria-hidden />
      <span className="whitespace-nowrap">
        {active ? (locked ? 'Release to unlock' : 'Release to lock') : locked ? 'Unlock' : 'Lock'}
      </span>
    </div>
  );
}
