'use client';

import { cn } from '@/lib/utils';

/**
 * The brand mark, drawn rather than shipped as an image.
 *
 * The two shapes below are the app icon's (`public/icons/icon.svg`), kept in
 * step by hand because there are two of them and they are a path each. The point
 * of drawing it inline is that the mark can be *the current colour*: it renders
 * in the accent on the boot screen, in `muted-fg` next to a settings footer, and
 * in cream on the accent tile of an empty state, all from one component and with
 * no second asset per theme.
 *
 * The mark is a kept ribbon whose fold is the letter S, so it is two pieces with
 * the S cut between them. On the tile that gap shows the ink behind the mark; on
 * paper it shows the paper, which is what a one-colour mark does.
 *
 * The viewBox is the mark's own bounding box — `129.5 94.5 258.5 343` in the
 * icon's coordinates — so the mark fills whatever box it is given with no
 * padding to guess at. That is also why there is no `preserveAspectRatio`
 * override: the mark's ratio is the ratio, and stretching it would be the one
 * thing that makes a drawn mark look wrong.
 */
const RIBBON = [
  /* The lower-left fold: the S's tail, and the notch at the bottom. */
  'M 274 191.5 L 279 191.5 L 282 192.5 L 290.5 199.5 L 367.5 276 L 377 288.5 L 382.5 299 L 386.5 311.5 L 388 322 L 388 426 L 386.5 430.5 L 382.5 435 L 379 437 L 369 437 L 271 372.5 L 263.5 370 L 256 370 L 249.5 371.5 L 241.5 376 L 151.5 435.5 L 147 437.5 L 140.5 437.5 L 136.5 436 L 132 432 L 129.5 426 L 129.5 208 L 246 326 L 254.5 331.5 L 262 334.5 L 272 336.5 L 284 336 L 293 333.5 L 301 329.5 L 306.5 325.5 L 313.5 318 L 318.5 309 L 320.5 303 L 322 295.5 L 322 286 L 319 273.5 L 311.5 260.5 L 264 212.5 L 262.5 209 L 263 200.5 L 264.5 197.5 L 268 194 L 274 191.5 Z',
  /* The upper fold: the S's head, and the shoulders of the tile. */
  'M 169 94.5 L 348 94.5 L 358.5 97.5 L 367.5 102.5 L 374.5 108.5 L 380 115.5 L 384.5 124 L 387.5 134.5 L 388 250.5 L 309 172.5 L 303.5 168 L 293.5 162.5 L 281 159.5 L 271 159.5 L 259 162.5 L 247 169.5 L 240 176.5 L 236.5 181.5 L 234 186 L 231 195 L 230 201 L 230 209 L 231 215.5 L 233.5 223 L 240.5 234.5 L 287 281.5 L 289 285 L 290 288.5 L 289.5 294 L 287.5 298.5 L 284 302 L 279 304 L 272.5 304 L 266.5 301 L 155.5 188 L 146.5 177 L 138.5 163 L 135 153 L 133 141 L 133 129.5 L 136 118 L 141.5 109.5 L 149.5 102.5 L 160 97 L 169 94.5 Z',
];

export interface LogoMarkProps {
  /** Rendered height in pixels. The width follows the mark's own ratio. */
  size?: number;
  className?: string;
}

/** The ribbon alone, in `currentColor`. */
export function LogoMark({ size = 24, className }: LogoMarkProps) {
  return (
    <svg
      viewBox="129.5 94.5 258.5 343"
      height={size}
      style={{ height: size, width: 'auto' }}
      className={cn('shrink-0', className)}
      role="presentation"
      aria-hidden="true"
    >
      {RIBBON.map((d) => (
        <path key={d.slice(0, 12)} d={d} fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * The mark on its tile, for the places that want the *app icon* rather than a
 * glyph: the boot screen, an empty state, a share card.
 *
 * The tile is `--brand-ink` rather than the accent, because the icon is the one
 * surface that has to hold its own next to every other app on a home screen, and
 * a deep ink tile with a white mark does that better than a bright one. The
 * `size` is the tile's edge; the mark inside is 67% of that edge in height and
 * 50.5% in width, which is the proportion the icon was drawn at.
 */
export function LogoTile({ size = 56, className }: LogoMarkProps) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center bg-brand-ink', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
      aria-hidden="true"
    >
      <LogoMark size={Math.round(size * 0.67)} className="text-brand-cream" />
    </span>
  );
}

/**
 * Mark plus wordmark.
 *
 * The wordmark is set in the app's own type rather than drawn as outlines: it
 * stays crisp at any size, it follows the reader's font settings, and it cannot
 * drift from the type scale the rest of the app uses.
 */
export function LogoLockup({
  size = 40,
  subtitle,
  className,
}: {
  size?: number;
  subtitle?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoTile size={size} />
      <div className="min-w-0">
        <p className="text-title font-semibold tracking-tight text-fg">Stash</p>
        {subtitle ? <p className="text-meta text-muted">{subtitle}</p> : null}
      </div>
    </div>
  );
}
