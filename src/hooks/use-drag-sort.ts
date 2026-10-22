'use client';

import * as React from 'react';
import {
  dropIndex,
  moveWithin,
  previewShift,
  sameOrder,
  type RowBox,
} from '@/lib/drag-order';

/**
 * Reorder a short list by dragging one of its rows.
 *
 * Written rather than installed, and that is a deliberate call. What this serves
 * is a run of sibling folders or links — usually a handful, never hundreds — and
 * it needs one gesture, one preview and a persisted order. A general drag-and-drop
 * toolkit would bring a sensor system, collision detection, an overlay portal and
 * an animation layer to do that, and each of those is another thing that can
 * disagree with a phone's scroll gesture.
 *
 * ## The gesture
 *
 * The six-dot grip is the handle and lifts the row the instant it is pressed; the
 * rest of the row keeps a long press, because it is also a button that opens
 * something and part of a list that scrolls. A press that moves early is a scroll,
 * and the pending lift is cancelled.
 *
 * The one thing that cannot be left to CSS is scrolling. Setting `touch-action:
 * none` on the row would break the list for every other gesture, so the scroll is
 * suppressed *only while a drop is in flight*, by cancelling `touchmove` —
 * attached imperatively at the moment of the lift, because the browser reads
 * `touch-action` when the finger goes down.
 *
 * ## What moves
 *
 * The dragged row follows the pointer with a transform at slightly raised opacity.
 * The rows between it and the prospective slot slide by exactly one row-height in
 * the opposite direction, so the list **opens the gap where the row will land**:
 * a preview of the result instead of a line drawn across the row it is about to
 * replace. Nothing is measured again mid-drag — the geometry is captured once at
 * the lift, before any transform exists, and every later position is computed
 * from it.
 *
 * That capture is the fix for a dragging bug that was invisible in the code and
 * obvious in the hand: the old hook measured the dragged row *after* applying its
 * transform, inside the same event that had just set it. React had not committed
 * the transform yet, so the measurement was always one frame stale, the computed
 * slot lagged the pointer, and a drag that ended between two rows claimed to be
 * somewhere else entirely. With the layout frozen at the lift there is nothing to
 * lag.
 *
 * Keyboard parity rides along: Arrow Up and Arrow Down move a focused row one
 * slot, through the same order arithmetic as a drop.
 */

export interface DragSortState {
  /** The row being dragged, or `null`. */
  draggingId: string | null;
  /** Where it would land, as an index into the list without the dragged row. */
  overIndex: number | null;
  /** True while the dragged row is over the caller's "move out" zone. */
  overOut: boolean;
  /** True while the dragged row is over the caller's lock target. */
  overLock: boolean;
  /**
   * The row the dragged one is hovering *over*, when the list accepts drops onto
   * rows rather than only between them.
   *
   * Notes use this: dragging one note onto another nests it there, which is the
   * same gesture as dragging a link into a folder — the destination is the thing
   * under the finger. It is a separate value from `overIndex` because the two
   * answers are different kinds of drop: a slot means "put it here in this list",
   * a row means "put it inside that one".
   */
  targetId: string | null;
}

/** Props for a "move out of this directory" drop target. */
export interface DragOutZoneProps {
  ref: (element: HTMLElement | null) => void;
  'data-drop-out': boolean;
  'data-drop-out-active': boolean;
}

/** Props for a "lock / unlock this item" drop target. */
export interface DragLockZoneProps {
  ref: (element: HTMLElement | null) => void;
  'data-drop-lock': boolean;
  'data-drop-lock-active': boolean;
}

/** Props for the draggable row, spread onto the row's own root element. */
export interface DragRowProps {
  ref: (element: HTMLElement | null) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  'aria-roledescription': string;
  'data-dragging': boolean;
  /** True while the dragged item is hovering this row as a destination. */
  'data-drop-target': boolean;
  /**
   * This row's id and kind, so a drag in *another* list can find it.
   *
   * A link is dropped into a folder, but folders and links are two lists with
   * two hooks: the link's drag has no geometry for the folder's rows. These two
   * attributes are the shared vocabulary that lets it hit-test across that gap
   * without either hook knowing the other exists.
   */
  'data-drop-target-id': string;
  'data-drop-target-kind': string;
  /** Which way this row is sliding to open the drop gap, for CSS and tests. */
  'data-drag-preview': 'up' | 'down' | 'none';
  style: React.CSSProperties;
  className: string;
}

export interface UseDragSortOptions {
  /** Ids in display order. The order the caller renders them in. */
  ids: readonly string[];
  /**
   * Called with the full new order once a drag ends somewhere else. Omit to make
   * the list read-only: rows are then plain rows with no drag behaviour at all.
   */
  onReorder?: (next: string[]) => void;
  /** Word used in the accessible description, e.g. `folder` or `note`. */
  noun?: string;
  /** Accessible name of each row, so the row can say what it moves. */
  labelOf: (id: string) => string;
  /**
   * Called when the drag ends over the caller's "move out" zone.
   *
   * This is how an item leaves its current directory: the alternative was a
   * `Move to another folder` menu row listing the whole tree, which is a
   * question the user has already answered by dragging the thing they want moved
   * onto where they want it to go.
   */
  onDropOut?: (id: string) => void;
  /**
   * Called when the drag ends *on another row*, rather than between two.
   *
   * Supplying it is what turns the rows into drop targets: while a drag is over a
   * row, that row lights up and the reorder preview is cleared, because the drop
   * that is about to happen is not a reorder.
   */
  onDropOn?: (id: string, targetId: string) => void;
  /**
   * Called when the drag ends over the caller's lock target.
   *
   * Only the caller knows whether the item is currently locked, so only the
   * caller can decide whether this drop locks it or unlocks it; the hook just
   * reports that the gesture landed there.
   */
  onDropLock?: (id: string) => void;
  /**
   * How long the finger must rest on a row before it becomes a destination.
   *
   * `0` means immediately, which is what notes want: their rows have no reorder
   * preview to protect, so dragging one onto another is the whole gesture. A
   * list that also reorders keeps `0` off the table — every row would be a
   * destination and no drop could ever land between two — so folders and links
   * use a short hold: move straight away to reorder, rest on a folder to move
   * into it.
   */
  dropDwellMs?: number;
  /**
   * A CSS selector for rows in *another* list that this drag may land on.
   *
   * Used by a link dragging onto a folder: the folder's rows are rendered by a
   * different list with its own hook. The selector is matched against the element
   * under the finger, so any row that carries `data-drop-target-kind` can answer
   * without being registered here first.
   */
  externalTargetSelector?: string;
  /**
   * Whether rows *of this list* can be destinations.
   *
   * `true` for notes and folders, where the thing under the finger is the same
   * kind of thing being dragged. `false` for links: a link is never filed into
   * another link, so only the external selector can make it a drop.
   */
  dropOnRows?: boolean;
}

export interface UseDragSortResult {
  state: DragSortState;
  /** Props for a row. Registers the element used to hit-test and to move. */
  getRowProps: (id: string, index: number) => DragRowProps;
  /**
   * Props for the drop-out zone, or `null` when the list has no way out.
   *
   * Returns `null` rather than an inert object so a caller that renders the zone
   * conditionally cannot leave an invisible hit target on screen.
   */
  getOutZoneProps: () => DragOutZoneProps | null;
  /**
   * Props for the lock target, or `null` when this list has no lock gesture.
   *
   * The same contract as {@link UseDragSortResult.getOutZoneProps}: an inert
   * object is never returned, so a caller cannot leave an invisible hit target
   * on screen.
   */
  getLockZoneProps: () => DragLockZoneProps | null;
  /** True while a drag is in flight, so the list can soften the surrounding UI. */
  dragging: boolean;
  /**
   * Call from the row's `onClick` and bail out when it returns true.
   *
   * True exactly once, for the click that ends a lift: a long press that lifted a
   * row must not also open the folder it was pressing on.
   */
  consumeDrag: () => boolean;
}

/** Held still for this long and the row lifts. Long enough to not fire on a tap. */
const LONG_PRESS_MS = 280;
/** Movement before the lift that means the finger is scrolling, not dragging. */
const SLOP_PX = 8;
/**
 * How long a swallowed click is remembered.
 *
 * Browsers send the click immediately after `pointerup`, but a gesture that ends
 * somewhere the click never lands — dropped outside the window, or ended by a
 * cancel — would otherwise leave the flag set and eat the *next* genuine tap.
 */
const CLICK_GUARD_MS = 400;

interface LiveDrag {
  dy: number;
  overIndex: number | null;
  overOut: boolean;
  overLock: boolean;
  targetId: string | null;
  /** Height of the dragged row, captured at the lift. */
  height: number;
}

const IDLE: LiveDrag = {
  dy: 0,
  overIndex: null,
  overOut: false,
  overLock: false,
  targetId: null,
  height: 0,
};

export function useDragSort({
  ids,
  onReorder,
  noun = 'item',
  labelOf,
  onDropOut,
  onDropOn,
  onDropLock,
  dropDwellMs = 0,
  externalTargetSelector,
  dropOnRows = true,
}: UseDragSortOptions): UseDragSortResult {
  const [state, setState] = React.useState<DragSortState & { dy: number; height: number }>({
    draggingId: null,
    overIndex: null,
    overOut: false,
    overLock: false,
    targetId: null,
    dy: 0,
    height: 0,
  });

  const rows = React.useRef(new Map<string, HTMLElement>());
  /** The caller's "move out" target, when it rendered one. */
  const outZone = React.useRef<HTMLElement | null>(null);
  /** The caller's lock target, when it rendered one. */
  const lockZone = React.useRef<HTMLElement | null>(null);
  /**
   * The row a resting finger is currently over, and when it got there.
   *
   * The dwell is deliberately not state: it changes nothing on screen until it
   * matures, and a render per pointer move is exactly what this hook avoids. It
   * is cleared by leaving the row, ending the drag, or dropping the lock target.
   */
  const dwell = React.useRef<{ id: string; at: number } | null>(null);
  const dwellTimer = React.useRef<number | null>(null);
  const orderRef = React.useRef<readonly string[]>(ids);
  /**
   * Geometry captured at the lift.
   *
   * Everything positional is answered from this snapshot rather than from a live
   * `getBoundingClientRect`, because during a drag two things are transforming:
   * the dragged row (which follows the pointer) and every row sliding to open the
   * gap. Measuring mid-drag would feed those transforms back into the decision
   * that produces them.
   */
  const layout = React.useRef<ReadonlyMap<string, RowBox>>(new Map());
  /** The dragged row's own untouched box, used as the origin of its centre. */
  const startBox = React.useRef<RowBox | null>(null);
  /**
   * The drag's live values, updated synchronously.
   *
   * `pointerup` can arrive in the same frame as the last `pointermove`, before
   * React has committed the new state; reading the render's `state` there would
   * drop onto the previous slot — or miss the "move out" zone entirely, which is
   * how a drag meant to take a link out of a folder used to reorder it instead.
   */
  const live = React.useRef<LiveDrag>(IDLE);
  /** The row a press is *pending* on. Cleared by movement, release or a lift. */
  const armed = React.useRef<string | null>(null);
  /** The row whose drag is live. Only ever set by the long-press timer. */
  const active = React.useRef<string | null>(null);
  const timer = React.useRef<number | null>(null);
  const clickGuard = React.useRef<number | null>(null);
  const startY = React.useRef(0);
  const startX = React.useRef(0);
  /** Swallows the click that follows a lift, exactly once. */
  const swallow = React.useRef(false);
  /** The `touchmove` cancel installed for the duration of a drag. */
  const blockScroll = React.useRef<((event: TouchEvent) => void) | null>(null);

  // Synced in an effect rather than assigned during render: a ref written while
  // rendering is a value the commit might never publish. The order is only ever
  // read from a gesture handler, which by definition runs after the commit.
  React.useEffect(() => {
    orderRef.current = ids;
  }, [ids]);

  const registerRow = React.useCallback((id: string, element: HTMLElement | null) => {
    if (element) rows.current.set(id, element);
    else rows.current.delete(id);
  }, []);

  const clearTimer = React.useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const releaseScrollBlock = React.useCallback(() => {
    if (!blockScroll.current) return;
    document.removeEventListener('touchmove', blockScroll.current);
    blockScroll.current = null;
  }, []);

  const rememberClickGuard = React.useCallback(() => {
    if (clickGuard.current !== null) window.clearTimeout(clickGuard.current);
    clickGuard.current = window.setTimeout(() => {
      clickGuard.current = null;
      swallow.current = false;
    }, CLICK_GUARD_MS);
  }, []);

  /** Abandon any row the finger was resting on without promoting it. */
  const clearDwell = React.useCallback(() => {
    dwell.current = null;
    if (dwellTimer.current !== null) {
      window.clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
  }, []);

  // A row scrolled out of the list (or a screen unmounted) while a press was
  // pending must not leave a timer behind to lift something that is gone.
  React.useEffect(
    () => () => {
      clearTimer();
      clearDwell();
      releaseScrollBlock();
      if (clickGuard.current !== null) window.clearTimeout(clickGuard.current);
    },
    [clearTimer, clearDwell, releaseScrollBlock],
  );

  /** Reset the live drag, leaving the state the renderer reads in sync. */
  const resetLive = React.useCallback(() => {
    clearDwell();
    live.current = IDLE;
    startBox.current = null;
    layout.current = new Map();
    setState({
      draggingId: null,
      overIndex: null,
      overOut: false,
      overLock: false,
      targetId: null,
      dy: 0,
      height: 0,
    });
  }, [clearDwell]);

  /** The slot the dragged row's centre at `y` would land in. */
  const slotFor = React.useCallback((id: string, y: number): number => {
    const others = orderRef.current.filter((candidate) => candidate !== id);
    return dropIndex(others, layout.current, y);
  }, []);

  /**
   * The row directly under `y`, ignoring the one being dragged.
   *
   * Answered from the geometry frozen at the lift, so sliding rows and the lifted
   * row's own transform cannot make the target jump. `-1` at the top of a box and
   * `+1` at the bottom keep the hit area on the row's own pixels and not on the
   * hairline between two.
   */
  const rowUnder = React.useCallback((y: number, draggedId: string): string | null => {
    for (const [id, box] of layout.current) {
      if (id === draggedId) continue;
      if (y >= box.top && y <= box.top + box.height) return id;
    }
    return null;
  }, []);

  /**
   * A destination row rendered by another list, found by hit-testing.
   *
   * Live DOM rather than the frozen geometry, because there is no frozen geometry
   * for rows this hook did not lay out. The one thing that must be filtered out is
   * the lifted row itself: it follows the pointer on top of everything, so the
   * first element at the finger is always the thing being dragged. Asking for
   * *all* elements at that point and skipping that subtree leaves the row it is
   * covering, which is the one the user means.
   */
  const externalTargetUnder = React.useCallback(
    (x: number, y: number, draggedId: string): string | null => {
      if (!externalTargetSelector) return null;
      for (const element of document.elementsFromPoint(x, y)) {
        if (element.closest('[data-dragging="true"]')) continue;
        const row = element.closest(externalTargetSelector);
        const targetId = row?.getAttribute('data-drop-target-id');
        if (targetId && targetId !== draggedId) return targetId;
      }
      return null;
    },
    [externalTargetSelector],
  );

  const consumeDrag = React.useCallback(() => {
    if (!swallow.current) return false;
    swallow.current = false;
    return true;
  }, []);

  const finish = React.useCallback(
    (id: string, overIndex: number) => {
      const order = orderRef.current;
      const next = moveWithin(order, id, overIndex);
      resetLive();
      if (!onReorder || sameOrder(order, next)) return;
      onReorder(next);
    },
    [onReorder, resetLive],
  );

  /**
   * The gap preview, computed once per render rather than per row.
   *
   * Zero for every row when nothing is being dragged, and for the dragged row
   * always — it is following the pointer, not taking its place yet.
   */
  const shifts = React.useMemo(() => {
    if (!state.draggingId || state.overIndex === null || state.overOut || state.targetId) return null;
    return previewShift(ids, state.draggingId, state.overIndex, state.height);
  }, [ids, state.draggingId, state.overIndex, state.overOut, state.targetId, state.height]);

  const getRowProps = React.useCallback(
    (id: string, index: number): DragRowProps => {
      const isDragged = state.draggingId === id;
      const shift = isDragged ? 0 : (shifts?.get(id) ?? 0);
      const label = labelOf(id).trim();

      return {
        ref: (element: HTMLElement | null) => registerRow(id, element),

        onPointerDown: (event) => {
          if (!onReorder) return;
          // Primary button only: a right-click is not a drag.
          if (event.button !== 0) return;
          const target = event.target as HTMLElement;
          // The row's own controls are taps, never drags. They opt out with
          // `data-no-drag` rather than being guessed at by tag name, because the
          // row itself is a button too.
          if (target.closest('[data-no-drag]')) return;
          // The grip is the one place a press means "drag" and nothing else, so it
          // lifts at once instead of hiding behind a long press. That is what makes
          // the row *look* draggable: the handle is the affordance, and it does what
          // it looks like it does.
          const grip = target.closest('[data-drag-handle]') !== null;

          startY.current = event.clientY;
          startX.current = event.clientX;
          armed.current = id;
          clearTimer();

          const element = event.currentTarget;
          const pointerId = event.pointerId;
          timer.current = window.setTimeout(
            () => {
              timer.current = null;
              if (armed.current !== id) return;
              // The lift. From here the pointer belongs to the list, so the scroll
              // has to be stopped before it starts.
              active.current = id;
              swallow.current = true;
              rememberClickGuard();
              try {
                element.setPointerCapture(pointerId);
              } catch {
                /* no pointer capture available; the move handler still works */
              }
              const block = (touch: TouchEvent) => {
                if (touch.cancelable) touch.preventDefault();
              };
              blockScroll.current = block;
              document.addEventListener('touchmove', block, { passive: false });

              /*
               * Freeze the geometry here, while every row is still in its resting
               * place: no transform has been committed for this drag yet, so these
               * are the boxes the drag is measured against for its whole life.
               */
              const boxes = new Map<string, RowBox>();
              for (const [rowId, row] of rows.current) {
                const box = row.getBoundingClientRect();
                boxes.set(rowId, { top: box.top, height: box.height });
              }
              layout.current = boxes;
              const own = boxes.get(id) ?? null;
              startBox.current = own;
              const height = own?.height ?? 0;
              live.current = {
                dy: 0,
                overIndex: index,
                overOut: false,
                overLock: false,
                targetId: null,
                height,
              };
              setState({
                draggingId: id,
                overIndex: index,
                overOut: false,
                overLock: false,
                targetId: null,
                dy: 0,
                height,
              });
            },
            grip ? 0 : LONG_PRESS_MS,
          );
        },

        onPointerMove: (event) => {
          // Pending: any real movement means this was a scroll or a stray touch.
          if (armed.current === id && active.current === null) {
            if (
              Math.abs(event.clientY - startY.current) > SLOP_PX ||
              Math.abs(event.clientX - startX.current) > SLOP_PX
            ) {
              clearTimer();
              armed.current = null;
            }
            return;
          }
          if (active.current !== id) return;
          if (event.cancelable) event.preventDefault();

          const dy = event.clientY - startY.current;
          live.current.dy = dy;

          /*
           * The lock target comes first: it is a destination in its own right, so
           * while the row is over it neither the way out nor a list slot is what
           * the drop will do.
           */
          const lockTarget = lockZone.current;
          let overLock = false;
          if (lockTarget && onDropLock) {
            const box = lockTarget.getBoundingClientRect();
            overLock =
              event.clientX >= box.left &&
              event.clientX <= box.right &&
              event.clientY >= box.top &&
              event.clientY <= box.bottom;
          }
          if (overLock) {
            clearDwell();
            live.current = { ...live.current, overIndex: null, overOut: false, overLock: true, targetId: null };
            setState((current) =>
              current.draggingId === id
                ? { ...current, dy, overIndex: null, overOut: false, overLock: true, targetId: null }
                : current,
            );
            return;
          }

          /*
           * Over the "move out" zone the row is not being reordered at all, so the
           * preview is cleared rather than left pointing at a slot the drop will
           * not use.
           */
          const zone = outZone.current;
          let overOut = false;
          if (zone) {
            const box = zone.getBoundingClientRect();
            overOut =
              event.clientX >= box.left &&
              event.clientX <= box.right &&
              event.clientY >= box.top &&
              event.clientY <= box.bottom;
          }
          if (overOut) {
            clearDwell();
            live.current.overIndex = null;
            live.current.overOut = true;
            live.current.overLock = false;
            live.current.targetId = null;
            setState((current) =>
              current.draggingId === id
                ? { ...current, dy, overIndex: null, overOut: true, overLock: false, targetId: null }
                : current,
            );
            return;
          }

          /*
           * A row under the finger, when the list accepts drops *onto* rows. The
           * answer comes from the frozen boxes for the same reason the slot does:
           * the row being dragged is carrying a transform, and hit-testing a
           * moving element would make the target flicker as it follows the
           * pointer.
           *
           * With a dwell, a row only becomes a destination once the finger has
           * rested on it: a list that reorders has to keep every pixel of a row
           * usable for "put it here", and it can only do that if "put it inside"
           * is a slower, deliberate version of the same gesture.
           */
          if (onDropOn) {
            const target =
              (dropOnRows ? rowUnder(event.clientY, id) : null) ??
              externalTargetUnder(event.clientX, event.clientY, id);
            if (target) {
              const promoted = live.current.targetId === target;
              const resting = dwell.current?.id === target;
              const matured =
                resting && dwell.current !== null && Date.now() - dwell.current.at >= dropDwellMs;

              if (promoted || matured || dropDwellMs <= 0) {
                clearDwell();
                live.current = {
                  ...live.current,
                  dy,
                  overIndex: null,
                  overOut: false,
                  overLock: false,
                  targetId: target,
                };
                setState((current) =>
                  current.draggingId === id
                    ? { ...current, dy, overIndex: null, overOut: false, overLock: false, targetId: target }
                    : current,
                );
                return;
              }

              /*
               * Start (or keep) the wait. The reorder preview is deliberately left
               * running underneath it, so a quick drag still looks and behaves
               * exactly like a reorder.
               */
              if (!resting) {
                clearDwell();
                dwell.current = { id: target, at: Date.now() };
                dwellTimer.current = window.setTimeout(() => {
                  dwellTimer.current = null;
                  if (active.current !== id || dwell.current?.id !== target) return;
                  live.current = {
                    ...live.current,
                    overIndex: null,
                    overOut: false,
                    overLock: false,
                    targetId: target,
                  };
                  setState((current) =>
                    current.draggingId === id
                      ? { ...current, overIndex: null, overOut: false, overLock: false, targetId: target }
                      : current,
                  );
                }, dropDwellMs);
              }
            } else {
              clearDwell();
            }
          }

          /*
           * The centre is derived from the box captured at the lift, not measured
           * now: the row under the finger is carrying this drag's transform, and
           * the rows around it are animating to open the gap.
           */
          const box = startBox.current;
          const centre = box ? box.top + box.height / 2 + dy : event.clientY;
          const overIndex = slotFor(id, centre);
          live.current = { ...live.current, overIndex, overOut: false, overLock: false, targetId: null };
          setState((current) =>
            current.draggingId === id
              ? { ...current, dy, overIndex, overOut: false, overLock: false, targetId: null }
              : current,
          );
        },

        onPointerUp: (event) => {
          clearTimer();
          armed.current = null;
          if (active.current !== id) return;
          active.current = null;
          releaseScrollBlock();
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            /* the capture is already gone; nothing to release */
          }

          /*
           * A drop on the way out ends the drag as a *move*, not a reorder: the
           * item leaves this list, so there is no new order to write. Read from
           * the live ref, because this can run before React commits the last move.
           */
          if (live.current.overLock && onDropLock) {
            resetLive();
            rememberClickGuard();
            onDropLock(id);
            return;
          }

          if (live.current.overOut && onDropOut) {
            resetLive();
            rememberClickGuard();
            onDropOut(id);
            return;
          }

          // A drop on another row is a move *into* it, so there is no new order
          // for this list to write.
          if (live.current.targetId && onDropOn) {
            const target = live.current.targetId;
            resetLive();
            rememberClickGuard();
            onDropOn(id, target);
            return;
          }

          const box = startBox.current;
          const centre = box
            ? box.top + box.height / 2 + (event.clientY - startY.current)
            : event.clientY;
          const overIndex = live.current.overIndex ?? slotFor(id, centre);
          rememberClickGuard();
          finish(id, overIndex);
        },

        onPointerCancel: () => {
          clearTimer();
          armed.current = null;
          if (active.current !== id) return;
          // The browser took the gesture (a scroll started, or the app was
          // interrupted). Nothing moves: the list is left exactly as it was.
          active.current = null;
          releaseScrollBlock();
          resetLive();
        },

        onKeyDown: (event) => {
          if (!onReorder) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          const order = orderRef.current;
          const from = order.indexOf(id);
          if (from < 0) return;
          const to = from + (event.key === 'ArrowUp' ? -1 : 1);
          if (to < 0 || to > order.length - 1) return;
          const next = moveWithin(order, id, to);
          if (sameOrder(order, next)) return;
          onReorder(next);
        },

        /*
         * The sentence, with one guard the callers need rather than a bug they
         * have to avoid: a *locked* link has no name to say — its content is
         * stripped to nothing by design — and "Reorderable link, " would leave a
         * reader at a dangling comma. So the label is optional, and the row
         * still describes what it is and what the arrows do.
         */
        'aria-roledescription': label
          ? `Reorderable ${noun}, ${label}`
          : `Reorderable ${noun}`,
        'data-dragging': isDragged,
        'data-drop-target': state.targetId === id,
        'data-drop-target-id': id,
        'data-drop-target-kind': noun,
        'data-drag-preview': shift < 0 ? 'up' : shift > 0 ? 'down' : 'none',
        style: isDragged
          ? { transform: `translate3d(0, ${state.dy}px, 0) scale(1.02)`, zIndex: 6 }
          : shift !== 0
            ? { transform: `translate3d(0, ${shift}px, 0)` }
            : {},
        className: ['row-drag', isDragged ? 'row-drag-lifted' : '', state.targetId === id ? 'row-drop-target' : '']
          .filter(Boolean)
          .join(' '),
      };
    },
    [
      clearDwell,
      clearTimer,
      dropDwellMs,
      dropOnRows,
      externalTargetUnder,
      finish,
      labelOf,
      noun,
      onDropLock,
      onDropOn,
      onDropOut,
      onReorder,
      rowUnder,
      registerRow,
      releaseScrollBlock,
      rememberClickGuard,
      resetLive,
      shifts,
      slotFor,
      state.draggingId,
      state.dy,
      state.targetId,
    ],
  );

  const getOutZoneProps = React.useCallback((): DragOutZoneProps | null => {
    if (!onDropOut) return null;
    return {
      ref: (element: HTMLElement | null) => {
        outZone.current = element;
      },
      'data-drop-out': true,
      'data-drop-out-active': state.draggingId !== null && state.overOut,
    };
  }, [onDropOut, state.draggingId, state.overOut]);

  const getLockZoneProps = React.useCallback((): DragLockZoneProps | null => {
    if (!onDropLock) return null;
    return {
      ref: (element: HTMLElement | null) => {
        lockZone.current = element;
      },
      'data-drop-lock': true,
      'data-drop-lock-active': state.draggingId !== null && state.overLock,
    };
  }, [onDropLock, state.draggingId, state.overLock]);

  return {
    state: {
      draggingId: state.draggingId,
      overIndex: state.overIndex,
      overOut: state.overOut,
      overLock: state.overLock,
      targetId: state.targetId,
    },
    getRowProps,
    getOutZoneProps,
    getLockZoneProps,
    dragging: state.draggingId !== null,
    consumeDrag,
  };
}

/**
 * One drop target serving more than one list.
 *
 * A folder screen shows two lists at once — its subfolders and its links — and
 * each has its own hook. Rendering a "move out" bar per list put two identical
 * targets on screen, both claiming to do the same thing while only the one
 * belonging to the list being dragged actually answered. Merging them gives the
 * screen a single target: either hook may drop on it, and it lights up while
 * either drag is over it.
 *
 * Returns `null` when no list offered a target, so a caller cannot end up with an
 * inert hit area.
 */
export function mergeOutZones(
  ...zones: ReadonlyArray<DragOutZoneProps | null>
): DragOutZoneProps | null {
  const present = zones.filter((zone): zone is DragOutZoneProps => zone !== null);
  if (present.length === 0) return null;
  return {
    ref: (element) => {
      for (const zone of present) zone.ref(element);
    },
    'data-drop-out': true,
    'data-drop-out-active': present.some((zone) => zone['data-drop-out-active']),
  };
}
