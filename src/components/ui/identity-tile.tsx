'use client';

import * as React from 'react';
import type { IdentityColor } from '@/lib/identity-color';
import { cn } from '@/lib/utils';

/**
 * The leading tile on a row.
 *
 * Every list in the app now starts with one of these, and it is the piece that
 * makes the colour *do* something: a folder shows the icon the user chose, a link
 * shows the first letter of its source, a note the first letter of its title — all
 * on a tinted square in that thing's own identity tone.
 *
 * Colour is only worth having if it repeats, so the tile is deliberately the same
 * shape, the same size and the same radius everywhere. Forty rows, forty slightly
 * different squares, is not a design language; it is forty decisions. The two
 * knobs are the tone and the glyph, and nothing else.
 *
 * A `solid` colour is available (see `identity-color.ts`) for the rare place a
 * tile needs to be the vivid foreground rather than a tint, but the tinted
 * `tile` pair is the default on purpose: it keeps the row's text the loudest thing
 * on it, which is what a list is for.
 */
export function IdentityTile({
  color,
  size = 40,
  radius,
  className,
  children,
}: {
  color: IdentityColor;
  size?: number;
  /** Overrides the square's corner radius. The default matches `tile`. */
  radius?: number;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn('tile', color.tile, className)}
      style={{ inlineSize: size, blockSize: size, ...(radius === undefined ? {} : { borderRadius: radius }) }}
    >
      {children}
    </span>
  );
}

/**
 * The monogram a tile shows when there is no icon to show.
 *
 * Not `Array.from(value)[0]`: that splits by UTF-16 unit, so an emoji or a
 * non-Latin script comes back as half a character — a small thing that looks like
 * a rendering bug and is not one. `Intl.Segmenter` is the correct tool, with a
 * grapheme-aware fallback for the engines that lack it.
 */
export function monogram(value: string | undefined | null): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const first = segmenter.segment(text)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment.toUpperCase();
  } catch {
    /* Older engines: fall through to the simple slice. */
  }
  return text.slice(0, 1).toUpperCase();
}

/**
 * A monogram tile, sized for the tile and tuned so a capital letter sits optically
 * centred rather than mathematically centred — a glyph's bounding box is taller
 * than its ink, so a truly centred cap always looks low.
 */
export function MonogramTile({
  color,
  value,
  size = 40,
  className,
}: {
  color: IdentityColor;
  value: string | undefined | null;
  size?: number;
  className?: string;
}) {
  const letter = monogram(value);
  return (
    <IdentityTile color={color} size={size} className={className}>
      <span
        className="font-semibold leading-none"
        style={{ fontSize: Math.round(size * 0.42), letterSpacing: '-0.01em', transform: 'translateY(0.5px)' }}
      >
        {letter}
      </span>
    </IdentityTile>
  );
}
