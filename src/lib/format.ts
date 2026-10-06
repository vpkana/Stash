/**
 * Presentation helpers. Kept separate from domain logic so formatting choices
 * never leak into what gets stored.
 */

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const SHORT_DATE_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

export function formatShortDate(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  if (isSameDay(date, today)) return TIME.format(date);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) return 'Yesterday';

  if (date.getFullYear() === today.getFullYear()) return SHORT_DATE.format(date);
  return SHORT_DATE_WITH_YEAR.format(date);
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatShortDate(timestamp, now);
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Trim a URL for display: drop the scheme and any `www.` prefix. */
export function displayUrl(url: string, maxLength = 64): string {
  let value = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (value.length > maxLength) value = `${value.slice(0, maxLength - 1)}…`;
  return value;
}

/** First letter of a folder name. */
export function folderInitial(name: string): string {
  const match = name.trim().match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : '#';
}

/*
 * `tintForId` used to live here: a hash that picked one of six soft tints for a
 * row's letter tile. It was removed, and the reasoning at the time was that a hue
 * derived from an id carries no meaning.
 *
 * That reasoning was half right, and the half it got wrong is worth writing down
 * because the app now does almost exactly this — see `identity-color.ts`. What was
 * actually wrong with `tintForId` was not that it hashed an id. It was that the
 * colour was *incidental*: six tints chosen to look pleasant, applied to a tile in
 * one list, keyed so that the same item could shade differently in two places, and
 * carrying nothing the user could learn.
 *
 * Identity colour is the same mechanism with the opposite intent: eight tones, one
 * per identity, pinned for well-known domains, and — the load-bearing part —
 * *stable*, so the colour becomes a name for the thing rather than a property of
 * the row it happens to be drawn on. `format.ts` still holds no colour logic, and
 * that part was right: colour is decided in one module and nowhere else.
 */
