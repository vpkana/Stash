'use client';

import * as React from 'react';
import { Lock, MoreHorizontal, Star } from '@/components/ui/icons';
import type { Folder } from '@/db/types';
import type { DragRowProps } from '@/hooks/use-drag-sort';
import { pluralize } from '@/lib/format';
import { useFolderAccess } from '@/lib/privacy/access';
import { useVaultStore } from '@/stores/vault-store';
import { cn } from '@/lib/utils';
import { DragGrip } from '@/components/ui/drag-grip';
import { Icon, isIconName } from '@/components/ui/icon';
import { LockedRow } from '@/components/privacy/locked-row';
import { IdentityTile } from '@/components/ui/identity-tile';
import { identityColor } from '@/lib/identity-color';

/**
 * A folder in a list.
 *
 * The icon the user chose is information architecture — it is the little
 * differentiator between "Android" and "Machine Learning" at a glance — so it
 * gets a tile of its own, tinted with the folder's own identity tone. A folder is
 * an object with an identity the user gave it, and colour is how this app labels
 * identity: the tone is derived from the folder's id, so it never changes, and
 * "the Studio folder is the violet one" becomes something the user can use to find
 * it in a list of forty without reading a single label.
 *
 * The tile is tinted rather than filled with the vivid tone on purpose: forty
 * folders on a screen should be forty legible labels, not forty saturated blocks
 * fighting the text for attention.
 *
 * Opening one goes through {@link useFolderAccess}: if the folder is protected and
 * its boundary has not been crossed, the tap raises the system prompt and the
 * caller's `onOpen` runs only once access is granted. The row therefore cannot be
 * a way around the lock, which is exactly the class of bug this replaced — one
 * screen respecting the lock and another navigating straight past it.
 *
 * ## The two controls on the right, and the gesture on the row
 *
 *  - **the star** toggles favourite, in place, with no navigation and no sheet.
 *    It used to be a menu row, which meant starring a folder cost a tap, a sheet
 *    and a scroll — for the one folder property you can see at a glance;
 *  - **the ⋯ button** opens the sheet: rename, move, lock, delete. Everything
 *    that is *not* a toggle lives there, and it is opened by a tap on that
 *    button and by nothing else;
 *  - **the row itself drags.** Press and hold a folder and it lifts, dims and
 *    follows your finger or the cursor to a new position among its siblings (see
 *    `use-drag-sort.ts`). There is no grip any more: a six-dot handle asked the
 *    user to find a five-millimetre target to do the one thing the row could do
 *    itself.
 *
 * Both controls opt out of the drag with `data-no-drag`, so a press that starts
 * on the star or the ⋯ never lifts the row underneath it.
 *
 * There is no chevron. It was a decoration that promised a navigation the row
 * already performs, and the row says so better by being one.
 */
export interface FolderRowProps {
  folder: Folder;
  /** Secondary line, e.g. the full path when shown out of context. */
  subtitle?: string;
  linkCount?: number;
  childCount?: number;
  onOpen: () => void;
  onShowActions: () => void;
  /** Omit to render the row without a favourite toggle. */
  onToggleFavorite?: () => void;
  /** Row props from {@link useDragSort}, when this list is reorderable. */
  dragRow?: DragRowProps;
  /**
   * The companion to `dragRow`: true once, for the click that ends a lift.
   *
   * Passed separately rather than folded into `dragRow` because a function is not
   * an attribute — spreading it onto the element would put a `consumeDrag`
   * attribute in the DOM.
   */
  consumeDrag?: () => boolean;
  /**
   * Lit as a destination while something else is dragged onto it.
   *
   * Needed because the drag may belong to another list — a link being moved into
   * a folder is dragged by the links' hook, which cannot touch this row's class.
   */
  dropTarget?: boolean;
  className?: string;
}

export function FolderRow({
  folder,
  subtitle,
  linkCount = 0,
  childCount = 0,
  onOpen,
  onShowActions,
  onToggleFavorite,
  dragRow,
  consumeDrag,
  dropTarget = false,
  className,
}: FolderRowProps) {
  // Two different questions, and they are deliberately separate:
  //  - `locked` is about the *badge*: this folder is protected, whether or not
  //    the user has stepped through its lock in this session. A folder inside an
  //    opened `Private` is still a locked folder and still says so.
  //  - `access` is about *permission*: may its contents be rendered at all.
  const locked = useVaultStore((state) => state.protection.folders.has(folder.id));
  const access = useFolderAccess(folder.id);

  const meta: string[] = [];
  if (linkCount > 0) meta.push(pluralize(linkCount, 'link'));
  if (childCount > 0) meta.push(pluralize(childCount, 'folder'));

  // Stable, derived from the id and never from the list position — see
  // `identity-color.ts` for why that distinction is the whole point.
  const tone = identityColor(folder.id);

  const open = React.useCallback(async () => {
    // A press that lifted the row to drag it is not also a tap that opens it.
    if (consumeDrag?.()) return;
    if (await access.request()) onOpen();
  }, [access, consumeDrag, onOpen]);

  if (access.locked) {
    return (
      <LockedRow
        kind="folder"
        // The label is the folder's own name, not derived from its contents: it
        // is what makes "which of my private folders is this" answerable without
        // opening anything.
        label={folder.name}
        subtitle={meta.length > 0 ? meta.join(' · ') : undefined}
        onReveal={() => void open()}
        dragRow={dragRow}
        consumeDrag={consumeDrag}
        className={className}
      />
    );
  }

  return (
    <div
      {...dragRow}
      className={cn('flex items-stretch', dragRow?.className, dropTarget && 'row-drop-target', className)}
    >
      {/* The handle appears only where the list can actually be reordered. */}
      {dragRow ? <DragGrip /> : null}
      <button
        type="button"
        onClick={() => void open()}
        className="tap flex min-w-0 flex-1 items-center gap-3 px-3 py-3.5 text-left active:bg-surface-2"
      >
        <IdentityTile color={tone}>
          <Icon name={isIconName(folder.icon) ? folder.icon : 'folder'} size={19} strokeWidth={1.8} />
        </IdentityTile>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-row min-w-0 truncate font-medium text-fg">{folder.name}</span>
            {locked ? (
              <Lock size={12} strokeWidth={2.4} className="shrink-0 text-accent" aria-label="Locked folder" />
            ) : null}
          </span>
          <span className="text-meta mt-0.5 block truncate text-subtle">
            {subtitle ?? (meta.length > 0 ? meta.join(' · ') : 'Empty')}
          </span>
        </span>
      </button>

      {onToggleFavorite ? (
        <button
          type="button"
          data-no-drag
          onClick={onToggleFavorite}
          aria-label={folder.isFavorite ? `Unstar ${folder.name}` : `Star ${folder.name}`}
          aria-pressed={folder.isFavorite}
          className="tap tap-scale flex w-9 shrink-0 items-center justify-center"
        >
          <Star
            size={17}
            strokeWidth={folder.isFavorite ? 2.2 : 1.9}
            // Filled when starred, outline when not: the state has to be legible
            // without comparing two screenshots, and the accent tone is reserved
            // for the lock badge that sits in the same row.
            className={cn(
              'transition-colors duration-150',
              folder.isFavorite ? 'fill-warning text-warning' : 'text-subtle',
            )}
            aria-hidden
          />
        </button>
      ) : null}

      <button
        type="button"
        data-no-drag
        onClick={onShowActions}
        aria-label={`${folder.name} actions`}
        className="tap mr-1 flex w-10 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
      >
        <MoreHorizontal size={19} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
