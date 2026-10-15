'use client';

import * as React from 'react';

/**
 * Reorder a short list by dragging one of its rows.
 *
 * Written rather than installed, and that is a deliberate call. What this serves
 * is a run of sibling folders — usually a handful, never hundreds — and it needs
 * one gesture, one drop indicator and a persisted order. A general drag-and-drop
 * toolkit would bring a sensor system, collision detection, an overlay portal and
 * an animation layer to do that, and each of those is another thing that can
 * disagree with a phone's scroll gesture.
 *
 * ## The gesture, and why it is a long press
 *
 * The row is *the* drag target: press and hold anywhere on a folder and the whole
 * row lifts, loses some opacity and follows the finger or the cursor. No grip, no
 * handle, no separate hit target to find with a thumb.
 *
 * The long press is what makes that unambiguous. A row is also a button that
 * opens a folder and part of a list that scrolls, so the three gestures have to be
 * told apart before they start:
 *
 *  - **a quick press that ends** is a tap, and opens the folder;
 *  - **a press that moves early** is a scroll (or a drag of the list), so the
 *    pending lift is cancelled the moment the pointer travels further than the
 *    touch slop;
 *  - **a press that is held still for {@link LONG_PRESS_MS}** is a drag: the row
 *    is lifted, and from that instant the gesture belongs to the list.
 *
 * The one thing that cannot be left to CSS is scrolling. Setting `touch-action:
 * none` on the row would break the list for every other gesture, so instead the
 * scroll is suppressed *only while a drop is in flight*, by cancelling
 * `touchmove` — attached imperatively at the moment of the lift, because the
 * browser reads `touch-action` when the finger goes down and a listener added a
 * render later could be a listener added after the page already scrolled.
 *
 * ## What moves
 *
 * **Nothing re-lays-out while dragging.** The lifted row is moved with a
 * transform and the insertion point is shown with an edge line; the rows
 * underneath do not shuffle. Rows that physically reorder under the finger are
 * pretty and untestable, and they also make the drop target ambiguous — a line
 * that says exactly where the row will land is neither.
 *
 * Keyboard parity rides along: Arrow Up and Arrow Down move a focused row one
 * slot, so the feature a mouse gets is not a feature only a mouse gets.
 */

export interface DragSortState {
  /** The row being dragged, or `null`. */
  draggingId: string | null;
  /** Where it would land, as an index into the list the caller passed. */
  overIndex: number | null;
  /** True while the dragged row is over the caller's "move out" zone. */
  overOut: boolean;
}

/** Props for a "move out of this directory" drop target. */
export interface DragOutZoneProps {
  ref: (element: HTMLElement | null) => void;
  'data-drop-out': boolean;
  'data-drop-out-active': boolean;
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
  /**
   * Where the insertion line goes for this row: `top` when the dragged row comes
   * from below, `bottom` when it comes from above, `none` otherwise.
   */
  'data-drop-edge': 'top' | 'bottom' | 'none';
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
   *
   * The dragged row's id is passed because one hook instance serves the whole
   * list and only the hook knows which row the gesture started on.
   */
  onDropOut?: (id: string) => void;
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

export function useDragSort({
  ids,
  onReorder,
  noun = 'item',
  labelOf,
  onDropOut,
}: UseDragSortOptions): UseDragSortResult {
  const [state, setState] = React.useState<DragSortState & { dy: number }>({
    draggingId: null,
    overIndex: null,
    overOut: false,
    dy: 0,
  });

  const rows = React.useRef(new Map<string, HTMLElement>());
  /** The caller's "move out" target, when it rendered one. */
  const outZone = React.useRef<HTMLElement | null>(null);
  const orderRef = React.useRef<readonly string[]>(ids);
  /** The row a press is *pending* on. Cleared by movement, release or a lift. */
  const armed = React.useRef<string | null>(null);
  /** The row whose drag is live. Only ever set by the long-press timer. */
  const active = React.useRef<string | null>(null);
  const timer = React.useRef<number | null>(null);
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

  // A row scrolled out of the list (or a screen unmounted) while a press was
  // pending must not leave a timer behind to lift something that is gone.
  React.useEffect(
    () => () => {
      clearTimer();
      releaseScrollBlock();
    },
    [clearTimer, releaseScrollBlock],
  );

  /**
   * Which slot the dragged row's live centre is over.
   *
   * Measured against the *other* rows' centres rather than their edges, so the
   * answer changes halfway through a row rather than the instant the pointer
   * touches it. Clamped to the list, so dragging past the end parks at the end
   * instead of doing nothing.
   */
  const slotFor = React.useCallback((id: string, y: number): number => {
    const order = orderRef.current;
    let index = order.length - 1;
    for (let position = 0; position < order.length; position += 1) {
      const otherId = order[position] as string;
      if (otherId === id) continue;
      const element = rows.current.get(otherId);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        index = position;
        break;
      }
    }
    return Math.max(0, Math.min(order.length - 1, index));
  }, []);

  const consumeDrag = React.useCallback(() => {
    if (!swallow.current) return false;
    swallow.current = false;
    return true;
  }, []);

  const finish = React.useCallback(
    (id: string, overIndex: number) => {
      const order = orderRef.current;
      const from = order.indexOf(id);
      setState({ draggingId: null, overIndex: null, overOut: false, dy: 0 });
      if (from < 0 || from === overIndex || !onReorder) return;
      const next = order.slice();
      next.splice(from, 1);
      next.splice(overIndex, 0, id);
      onReorder(next);
    },
    [onReorder],
  );

  const getRowProps = React.useCallback(
    (id: string, index: number): DragRowProps => {
      const isDragged = state.draggingId === id;
      const isTarget = state.draggingId !== null && !isDragged && state.overIndex === index;
      const fromIndex = state.draggingId ? ids.indexOf(state.draggingId) : -1;
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
          timer.current = window.setTimeout(() => {
            timer.current = null;
            if (armed.current !== id) return;
            // The lift. From here the pointer belongs to the list, so the scroll
            // has to be stopped before it starts.
            active.current = id;
            swallow.current = true;
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
            setState({ draggingId: id, overIndex: index, overOut: false, dy: 0 });
          }, grip ? 0 : LONG_PRESS_MS);
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
          /*
           * Over the "move out" zone the row is not being reordered at all, so the
           * insertion line is cleared rather than left pointing at a slot the drop
           * will not use.
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
            setState((current) =>
              current.draggingId === id ? { ...current, dy, overIndex: null, overOut: true } : current,
            );
            return;
          }

          // The lifted row already carries the transform, so its measured centre
          // *is* the live centre — nothing has to be added back in, and the
          // measurement stays right however far the pointer travels.
          const rect = rows.current.get(id)?.getBoundingClientRect();
          const centre = rect ? rect.top + rect.height / 2 : event.clientY;
          setState((current) =>
            current.draggingId === id
              ? { ...current, dy, overIndex: slotFor(id, centre), overOut: false }
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
          // A drop on the way out ends the drag as a *move*, not a reorder: the
          // item leaves this list, so there is no new order to write.
          if (state.overOut && onDropOut) {
            setState({ draggingId: null, overIndex: null, overOut: false, dy: 0 });
            swallow.current = false;
            onDropOut(id);
            return;
          }
          finish(id, state.overIndex ?? index);
        },

        onPointerCancel: () => {
          clearTimer();
          armed.current = null;
          if (active.current !== id) return;
          // The browser took the gesture (a scroll started, or the app was
          // interrupted). Nothing moves: the list is left exactly as it was.
          active.current = null;
          releaseScrollBlock();
          setState({ draggingId: null, overIndex: null, overOut: false, dy: 0 });
        },

        onKeyDown: (event) => {
          if (!onReorder) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          const order = orderRef.current;
          const from = order.indexOf(id);
          const to = event.key === 'ArrowUp' ? from - 1 : from + 1;
          if (from < 0 || to < 0 || to >= order.length) return;
          const next = order.slice();
          next.splice(from, 1);
          next.splice(to, 0, id);
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
        'data-drop-edge': (isTarget ? (fromIndex > index ? 'top' : 'bottom') : 'none') as
          | 'top'
          | 'bottom'
          | 'none',
        style: isDragged
          ? { transform: `translate3d(0, ${state.dy}px, 0) scale(1.02)`, zIndex: 5 }
          : ({} as React.CSSProperties),
        className: ['row-drag', isDragged ? 'row-drag-lifted' : ''].filter(Boolean).join(' '),
      };
    },
    [
      clearTimer,
      finish,
      ids,
      labelOf,
      noun,
      onDropOut,
      onReorder,
      registerRow,
      releaseScrollBlock,
      slotFor,
      state.draggingId,
      state.dy,
      state.overIndex,
      state.overOut,
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

  return {
    state: { draggingId: state.draggingId, overIndex: state.overIndex, overOut: state.overOut },
    getRowProps,
    getOutZoneProps,
    dragging: state.draggingId !== null,
    consumeDrag,
  };
}
