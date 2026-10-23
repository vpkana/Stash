/**
 * The accent colours the user can pick.
 *
 * One list, and every surface reads from it: the picker in Settings draws these
 * swatches, the store validates whatever comes back out of IndexedDB against
 * these ids, and the stylesheet has one `data-accent` block per entry. Adding a
 * colour means adding it here, adding its block in `globals.css`, and nothing
 * else — no component holds a hex of its own.
 *
 * `swatch` is the light-mode accent. The picker shows the light value in both
 * themes on purpose: it is the colour being *chosen*, and dark mode's lifted
 * tint is a legibility adjustment, not a different colour.
 */
export const ACCENTS = [
  { id: 'blue', label: 'Blue', swatch: '#2563eb' },
  { id: 'indigo', label: 'Indigo', swatch: '#4f46e5' },
  { id: 'violet', label: 'Violet', swatch: '#7c3aed' },
  { id: 'rose', label: 'Rose', swatch: '#e11d48' },
  { id: 'amber', label: 'Amber', swatch: '#b45309' },
  { id: 'emerald', label: 'Emerald', swatch: '#047857' },
  { id: 'teal', label: 'Teal', swatch: '#0e7490' },
  { id: 'graphite', label: 'Graphite', swatch: '#3f4a5a' },
] as const;

export type AccentId = (typeof ACCENTS)[number]['id'];

export const DEFAULT_ACCENT: AccentId = 'blue';

/**
 * True for a value this build understands.
 *
 * Used on the way out of storage, where the row was written by an older build,
 * a newer one, or something that is not this app at all. An unknown id must fall
 * back to the default rather than leave the root pointing at no palette.
 */
export function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((accent) => accent.id === value);
}

export function accentLabel(id: AccentId): string {
  return ACCENTS.find((accent) => accent.id === id)?.label ?? 'Blue';
}
