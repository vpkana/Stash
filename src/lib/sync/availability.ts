/**
 * Whether Google Drive sync is offered in the app.
 *
 * The sync engine, the OAuth client and the conflict UI are all still here and
 * still tested — this flag only decides whether they are reachable. They are off
 * for now: sync is not the priority, and an unfinished connection surface is
 * worse than none, because it invites people to trust a copy that may not be
 * being kept up to date.
 *
 * Flip it to `true` (or set `NEXT_PUBLIC_GOOGLE_SYNC=1` at build time) to bring
 * the settings section and the background sync runtime back.
 */
export const GOOGLE_SYNC_ENABLED =
  process.env.NEXT_PUBLIC_GOOGLE_SYNC === '1';
