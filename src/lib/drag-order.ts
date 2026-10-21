/**
 * The arithmetic behind a drag, kept out of the React hook.
 *
 * Three questions have to be answered on every pointer move, and each of them is
 * easy to get subtly wrong — so they live here, pure and testable, instead of
 * inside a callback that only a browser can exercise:
 *
 *  - **which slot** the dragged row's live centre is over;
 *  - **what order** results from dropping it there;
 *  - **how far** every other row slides so the list previews that order.
 *
 * The insertion index is expressed against the list *without* the dragged row.
 * That is the only formulation in which moving up and moving down are the same
 * sum: removing the row first means index `n` always means "after the n-th
 * remaining row", rather than meaning one thing above the origin and another
 * below it. The off-by-one that made dragging downward land a slot too far came
 * from inserting into the full list with an index measured on it.
 */

export interface RowBox {
  /** Viewport y of the row's top edge, measured before any drag transform. */
  top: number;
  height: number;
}

/**
 * The slot the dragged row would be inserted into, as an index among `others`.
 *
 * Measured against the *centre* of each remaining row rather than its edge, so
 * the answer changes halfway through a row rather than the instant the pointer
 * touches it. Clamped to the run, so dragging past the end parks at the end.
 */
export function dropIndex(others: readonly string[], boxes: ReadonlyMap<string, RowBox>, y: number): number {
  for (let index = 0; index < others.length; index += 1) {
    const box = boxes.get(others[index] as string);
    if (!box) continue;
    if (y < box.top + box.height / 2) return index;
  }
  return others.length;
}

/**
 * The order produced by moving `id` to `index` among the rows that remain.
 *
 * `index` is clamped rather than trusted: a caller computing it from a stale
 * measurement should get the nearest end of the list, never a hole.
 */
export function moveWithin(order: readonly string[], id: string, index: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const rest = [...order.slice(0, from), ...order.slice(from + 1)];
  const at = Math.max(0, Math.min(rest.length, index));
  rest.splice(at, 0, id);
  return rest;
}

/** Whether two orders are the same sequence. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * How far each row should slide to preview the drop.
 *
 * Positive values move a row down, negative up, in whole row-heights: exactly
 * one step per position the row gains or loses. The rows between the origin and
 * the slot close over the vacated space, and the space that opens up is the
 * dragged row's destination — a preview of the result rather than a line drawn
 * beside the row it is about to replace.
 */
export function previewShift(
  order: readonly string[],
  id: string,
  index: number,
  rowHeight: number,
): Map<string, number> {
  const shifts = new Map<string, number>();
  if (order.indexOf(id) < 0 || rowHeight === 0) return shifts;
  const next = moveWithin(order, id, index);
  for (let position = 0; position < order.length; position += 1) {
    const rowId = order[position] as string;
    if (rowId === id) continue;
    const delta = next.indexOf(rowId) - position;
    if (delta !== 0) shifts.set(rowId, delta * rowHeight);
  }
  return shifts;
}
