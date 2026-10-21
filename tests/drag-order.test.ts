import { describe, expect, it } from 'vitest';
import { dropIndex, moveWithin, previewShift, sameOrder, type RowBox } from '@/lib/drag-order';

/**
 * Where a drag lands, and what the list shows while it is in flight.
 *
 * These are the two things the gesture has to get right, and both are arithmetic
 * rather than browser behaviour — which is exactly why they are here. The bug this
 * suite pins down is an off-by-one: inserting into the *full* list with an index
 * measured on that same list moves a row one slot too far whenever it travels
 * downward, so "one down" silently becomes "two down" (or the end of the list).
 */

/** Three rows, 60px tall, starting at 100 — a fixed layout for every case. */
const ORDER = ['a', 'b', 'c', 'd'] as const;
const box = (top: number): RowBox => ({ top, height: 60 });
const LAYOUT = new Map<string, RowBox>([
  ['a', box(100)],
  ['b', box(160)],
  ['c', box(220)],
  ['d', box(280)],
]);

describe('dropIndex', () => {
  const others = ORDER.filter((id) => id !== 'b');

  it('picks the slot above the first remaining row', () => {
    expect(dropIndex(others, LAYOUT, 90)).toBe(0);
  });

  it('changes slot at the centre of a row, not at its edge', () => {
    // `a` spans 100–160; its centre is 130.
    expect(dropIndex(others, LAYOUT, 129)).toBe(0);
    expect(dropIndex(others, LAYOUT, 131)).toBe(1);
  });

  it('parks at the end when dragged past the last row', () => {
    expect(dropIndex(others, LAYOUT, 900)).toBe(others.length);
  });

  it('ignores a row with no measurement instead of inventing a slot', () => {
    const sparse = new Map<string, RowBox>([['a', box(100)]]);
    expect(dropIndex(['missing', 'a'], sparse, 90)).toBe(1);
  });
});

describe('moveWithin', () => {
  it('moves a row up one slot', () => {
    expect(moveWithin(ORDER, 'c', 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves a row down one slot', () => {
    // The regression: inserting into the full list at index 2 would give
    // [a, c, b, d] — a row that moved *up*. The index is among the remaining
    // rows, so 2 means "after b", which is one step down.
    expect(moveWithin(ORDER, 'a', 1)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves a row to the end', () => {
    expect(moveWithin(ORDER, 'a', 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves a row to the front', () => {
    expect(moveWithin(ORDER, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is a no-op when the index is the row’s own slot', () => {
    expect(moveWithin(ORDER, 'b', 1)).toEqual([...ORDER]);
    expect(moveWithin(ORDER, 'd', 3)).toEqual([...ORDER]);
  });

  it('clamps a stale index rather than leaving a hole', () => {
    expect(moveWithin(ORDER, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveWithin(ORDER, 'a', -5)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns the list unchanged for an id that is not in it', () => {
    expect(moveWithin(ORDER, 'zz', 0)).toEqual([...ORDER]);
  });
});

describe('sameOrder', () => {
  it('compares by sequence, not by reference or membership', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
  });
});

describe('previewShift', () => {
  it('slides the rows above a downward drop up by one row-height', () => {
    // a moves from the top to after b: only b is between the origin and the slot.
    expect([...previewShift(ORDER, 'a', 1, 60)]).toEqual([['b', -60]]);
  });

  it('slides the rows below an upward drop down by one row-height', () => {
    expect([...previewShift(ORDER, 'd', 0, 60)]).toEqual([
      ['a', 60],
      ['b', 60],
      ['c', 60],
    ]);
  });

  it('never includes the dragged row, which follows the pointer instead', () => {
    expect(previewShift(ORDER, 'b', 3, 60).has('b')).toBe(false);
  });

  it('is empty for a drop in the row’s own slot', () => {
    expect(previewShift(ORDER, 'b', 1, 60).size).toBe(0);
  });

  it('is empty before a height is known', () => {
    expect(previewShift(ORDER, 'a', 2, 0).size).toBe(0);
  });

  it('leaves a row exactly where it already sits', () => {
    // Moving d to the end shifts nobody: every other row keeps its position.
    expect(previewShift(ORDER, 'd', 3, 60).size).toBe(0);
  });
});
