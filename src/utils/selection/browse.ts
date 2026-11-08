/**
 * Look up the selected words on the web.
 *
 * The button is deliberately one gesture and one destination: take the selection
 * exactly as the user sees it, and search for it. There is no URL parsing here,
 * because the whole point is the case where the words are *not* an address — a
 * name, a phrase, a half-remembered title.
 *
 * Opening is split by platform. Android goes through Chrome Custom Tabs
 * (`openExternal`), which keeps Stash alive behind the browser the way every other
 * outbound link in the app does. On the web the window is opened *synchronously*
 * inside the click: `window.open` after an `await` has lost the user gesture, and
 * browsers answer that with a blocked popup.
 */

import { Capacitor } from '@capacitor/core';
import { openExternal } from '@/lib/open-external';
import { rangeText, resolveSelectionRange } from './range';

/** The search URL for a phrase: a query, escaped, and nothing else. */
export function googleSearchUrl(text: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(text.trim())}`;
}

export interface BrowseResult {
  /** True when a browser was handed the search. */
  browsed: boolean;
  /** The words that were searched for. */
  text: string;
}

export async function browseSelection(
  host: HTMLElement,
  remembered?: Range | null,
): Promise<BrowseResult> {
  const range = resolveSelectionRange(host, remembered);
  const text = range ? rangeText(range).trim() : '';
  if (!text) return { browsed: false, text: '' };

  const url = googleSearchUrl(text);

  if (Capacitor.isNativePlatform()) {
    await openExternal(url);
    return { browsed: true, text };
  }

  // Synchronous on purpose: the gesture is still live here (see the note above).
  window.open(url, '_blank', 'noopener,noreferrer');
  return { browsed: true, text };
}
