import type { SavedLink } from '@/db/types';
import { displayUrl } from './format';

/**
 * What a saved link calls itself on screen.
 *
 * One rule, used by the row, the capture sheet's preview and the duplicate
 * notice, so a link is never described two different ways in two places:
 *
 *  1. the **title** — pre-filled from the sharing app's own heading when there
 *     was one, and editable by the user afterwards. It is the single name a link
 *     has, which is why there is no note branch any more: two fields describing
 *     one thing was two chances for them to disagree;
 *  2. the address, shortened, when there is no title. A link with no title is not
 *     a failure; it just has nothing better to show.
 *
 * The URL is never replaced by either — it stays on the record and is what
 * tapping the row opens. This only decides which words are on the front of the
 * row.
 */
export type LinkLabelKind = 'title' | 'url';

export interface LinkLabel {
  text: string;
  kind: LinkLabelKind;
}

export function linkPrimaryLabel(link: SavedLink, urlWidth = 54): LinkLabel {
  const title = link.title?.trim();
  if (title) return { text: title, kind: 'title' };

  return { text: displayUrl(link.url, urlWidth), kind: 'url' };
}

/** The secondary line's first token: the domain the link came from. */
export function linkSourceLabel(link: SavedLink): string | undefined {
  return link.source ?? undefined;
}

/**
 * The link's domain, whatever the record happens to have.
 *
 * `source` is what the sharing app told us and is trusted first. But a link
 * captured by pasting an address has none, and this value keys the row's identity
 * colour — so falling back to the host is what keeps a pasted
 * `youtube.com/watch?v=…` the same red as one shared from the YouTube app. Two
 * records of the same video disagreeing about their colour would be the colour
 * system failing at the one job it has.
 *
 * `www.` is stripped and nothing else is: the case is left alone and no
 * registrable-domain logic runs here, because `domainColor` already handles
 * subdomain inheritance and doing it twice is how two code paths come to disagree.
 */
export function linkDomain(link: SavedLink): string | undefined {
  const source = link.source?.trim();
  if (source) return source.replace(/^www\./i, '');
  try {
    return new URL(link.url).hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}
