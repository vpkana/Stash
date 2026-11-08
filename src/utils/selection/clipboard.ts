/**
 * The system clipboard, one API over the two platforms this app runs on.
 *
 * On Android the WebView's own `navigator.clipboard` is not dependable: read
 * access is gated by the browser's permission model and the asynchronous
 * Clipboard API has been removed or restricted in several WebView versions, so
 * reading the clipboard from a page is exactly the thing that never works. The
 * Capacitor plugin talks to Android's `ClipboardManager` instead, which is the
 * same clipboard every other application uses — which is what makes "copy here,
 * paste there" mean the same thing as it does in a native app.
 *
 * On the web the browser API is the right one, with a synchronous fallback for
 * browsers or origins where the async API is unavailable (an insecure origin, an
 * older Safari). The fallback can write but cannot read: there is deliberately no
 * hidden paste button to fake it, and an unavailable read reports `null` so the
 * caller can say nothing happened rather than paste an empty string.
 */

import { Capacitor } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';

/** Whether this is running inside the native shell. */
export function usesNativeClipboard(): boolean {
  return typeof window !== 'undefined' && Capacitor.isNativePlatform();
}

/**
 * Copy text to the system clipboard.
 *
 * Resolves `true` only when a clipboard was actually written. A failure is
 * reported rather than swallowed because the callers have a visible consequence:
 * Cut must not delete the text it failed to copy.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return false;

  if (usesNativeClipboard()) {
    try {
      await Clipboard.write({ string: text });
      return true;
    } catch (error) {
      console.warn('[stash] native clipboard write failed', error);
    }
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('[stash] clipboard write failed', error);
  }

  return legacyCopy(text);
}

/**
 * Read text from the system clipboard.
 *
 * `null` means "could not read" — an empty clipboard also resolves an empty
 * string, and the two deserve different handling (one is a broken feature, the
 * other is a user who has not copied anything yet).
 */
export async function readClipboardText(): Promise<string | null> {
  if (usesNativeClipboard()) {
    try {
      const { value } = await Clipboard.read();
      return typeof value === 'string' ? value : '';
    } catch (error) {
      console.warn('[stash] native clipboard read failed', error);
      return null;
    }
  }

  try {
    if (navigator.clipboard?.readText) {
      const value = await navigator.clipboard.readText();
      return typeof value === 'string' ? value : '';
    }
  } catch (error) {
    /*
     * Reading the clipboard needs permission (or a user gesture the browser
     * trusts). A refusal is not a crash: the caller reports that there is
     * nothing to paste, and the platform's own paste still works.
     */
    console.warn('[stash] clipboard read unavailable', error);
  }

  return null;
}

/**
 * The pre-Clipboard-API copy: a selected off-screen textarea and `copy`.
 *
 * It is a fallback, not the architecture — the async API is tried first. This
 * path exists because it is the only way to copy on an insecure origin, where
 * `navigator.clipboard` is undefined.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const holder = document.createElement('textarea');
  holder.value = text;
  holder.setAttribute('readonly', '');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.position = 'fixed';
  holder.style.top = '0';
  holder.style.left = '-9999px';
  holder.style.opacity = '0';
  document.body.appendChild(holder);

  let copied = false;
  try {
    holder.select();
    holder.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    holder.remove();
  }
  return copied;
}
