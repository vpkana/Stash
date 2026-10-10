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
 * disagree with a phone's scroll gesture. A hundred lines that only do this are
 * easier to trust than a dependency that does everything.
 *
 * Three decisions do the real work:
 *
 *  - **The drag starts from a handle, not the row.** A row is also a button that
 *    opens a folder, and a list is also a scrollable surface on a phone. Making
 *    the whole row draggable means a slow tap opens the wrong folder and a fast
 *    flick moves it instead of scrolling. The handle claims the gesture
 *    explicitly, so nothing else has to guess.
 *  - **The handle alone sets `touch-action: none`.** The scroll container keeps
 *    its normal behaviour everywhere else, so dragging never costs scrolling.
 *  - **Nothing moves in the layout while dragging.** The dragged row is lifted
 *    with a transform and the insertion point is shown with an edge line. Rows
 *    that physically shuffle under the finger are pretty and untestable; a line
 *    that says exactly where the row will land is neither.
 *
 * Keyboard parity is part of the same handle: Arrow Up and Arrow Down move a row
 * one slot, so the feature a mouse gets is not a feature only a mouse gets.
 */

export interface DragSortState {
  /** The row being dragged, or `null`. */
  draggingId: string | null;
  /** Where it would land, as an index into the list the caller passed. */
  overIndex: number | null;
}

export interface DragHandleProps {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  'aria-label': string;
  'aria-roledescription': string;
  style: React.CSSProperties;
  className: string;
}

export interface UseDragSortOptions {
  /** Ids in display order. The order the caller renders them in. */
  ids: readonly string[];
  /**
   * Called with the full new order once a drag ends somewhere else. Omit to make
   * the list read-only: the handle then only offers the keyboard path.
   */
  onReorder?: (next: string[]) => void;
  /** Word used in the handle's accessible name, e.g. `folder` or `note`. */
  noun?: string;
  /** Accessible name of each row, so the handle can say what it moves. */
  labelOf: (id: string) => string;
}

export interface UseDragSortResult {
  state: DragSortState;
  /** Props for the row wrapper. Registers the element used to hit-test. */
  getRowProps: (id: string, index: number) => {
    ref: (element: HTMLElement | null) => void;
    'data-dragging': boolean;
    /**
     * Where the insertion line goes for this row: `top` when the dragged row
     * comes from below, `bottom` when it comes from above, `none` otherwise.
     */
    'data-drop-edge': 'top' | 'bottom' | 'none';
    style: React.CSSProperties;
    className: string;
  };
  getHandleProps: (id: string, index: number) => DragHandleProps;
  /** True while a drag is in flight, so the list can soften the surrounding UI. */
  dragging: boolean;
}

const HANDLE_CLASS =
  'flex size-8 shrink-0 cursor-grab items-center justify-center rounded-lg text-subtle ' +
  'active:cursor-grabbing active:bg-surface-3';

export function useDragSort({ ids, onReorder, noun = 'item', labelOf }: UseDragSortOptions): UseDragSortResult {
  const [state, setState] = React.useState<DragSortState>({ draggingId: null, overIndex: null });

  const rows = React.useRef(new Map<string, HTMLElement>());
  const startY = React.useRef(0);
  const orderRef = React.useRef<readonly string[]>(ids);
  // Synced in an effect rather than assigned during render: a ref written while
  // rendering is a value the commit might never publish. The order is only ever
  // read from a gesture handler, which by definition runs after the commit, so
  // the one-frame-old value between render and effect is never observed.
  React.useEffect(() => {
    orderRef.current = ids;
  }, [ids]);

  const registerRow = React.useCallback((id: string, element: HTMLElement | null) => {
    if (element) rows.current.set(id, element);
    else rows.current.delete(id);
  }, []);

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

  const finish = React.useCallback(
    (id: string, overIndex: number) => {
      const order = orderRef.current;
      const from = order.indexOf(id);
      setState({ draggingId: null, overIndex: null });
      if (from < 0 || from === overIndex || !onReorder) return;
      const next = order.slice();
      next.splice(from, 1);
      next.splice(overIndex, 0, id);
      onReorder(next);
    },
    [onReorder],
  );

  const getHandleProps = React.useCallback(
    (id: string, index: number): DragHandleProps => ({
      onPointerDown: (event) => {
        if (!onReorder) return;
        // Only the primary button, and only from the handle: this is the one
        // place in the list that claims the gesture.
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        startY.current = event.clientY;
        setState({ draggingId: id, overIndex: index });
      },
      onPointerMove: (event) => {
        if (state.draggingId !== id) return;
        const element = rows.current.get(id);
        const box = element?.getBoundingClientRect();
        const centre = box ? box.top + box.height / 2 + (event.clientY - startY.current) : event.clientY;
        setState((current) =>
          current.draggingId === id ? { ...current, overIndex: slotFor(id, centre) } : current,
        );
      },
      onPointerUp: (event) => {
        if (state.draggingId !== id) return;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* the capture is already gone; nothing to release */
        }
        finish(id, state.overIndex ?? index);
      },
      onPointerCancel: () => {
        if (state.draggingId !== id) return;
        setState({ draggingId: null, overIndex: null });
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
      'aria-label': `Reorder ${labelOf(id)}`,
      'aria-roledescription': `Drag handle, ${noun}`,
      style: { touchAction: 'none' },
      className: HANDLE_CLASS,
    }),
    [finish, labelOf, noun, onReorder, slotFor, state.draggingId, state.overIndex],
  );

  const dragging = state.draggingId !== null;
  const fromIndex = state.draggingId ? ids.indexOf(state.draggingId) : -1;

  const getRowProps = React.useCallback(
    (id: string, index: number) => {
      const isDragged = state.draggingId === id;
      const isTarget = dragging && !isDragged && state.overIndex === index;
      return {
        ref: (element: HTMLElement | null) => registerRow(id, element),
        'data-dragging': isDragged,
        'data-drop-edge': (isTarget ? (fromIndex > index ? 'top' : 'bottom') : 'none') as
          | 'top'
          | 'bottom'
          | 'none',
        style: {} as React.CSSProperties,
        className: ['row-drag', isDragged ? 'row-drag-lifted' : ''].filter(Boolean).join(' '),
      };
    },
    [dragging, fromIndex, registerRow, state.draggingId, state.overIndex],
  );

  return { state, getRowProps, getHandleProps, dragging };
}
