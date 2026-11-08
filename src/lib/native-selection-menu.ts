'use client';

import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Ask Android to keep its own Cut / Copy / Paste menu away from the note body.
 *
 * Android's floating selection menu over a WebView is a native `ActionMode`.
 * There is no CSS, no DOM attribute and no web API that hides it: the only place
 * it can be answered is the Activity, which is what `MainActivity` and
 * `EmptySelectionActionMode` do. This module is the on/off request that tells
 * them when the note body — and only the note body — is the surface being edited.
 *
 * It is deliberately a *request*, not a barrier. Off Android (the desktop web
 * build) there is no native menu to hide and this is a no-op; on Android the call
 * is fire-and-forget and a failure is swallowed, because an old APK without the
 * plugin must still be able to edit a note.
 */
interface SelectionMenuPlugin {
  setSuppressed(options: { suppressed: boolean }): Promise<void>;
}

const selectionMenu = registerPlugin<SelectionMenuPlugin>('SelectionMenu');

let applied: boolean | null = null;

export function suppressNativeSelectionMenu(suppressed: boolean): void {
  if (typeof window === 'undefined') return;
  if (!Capacitor.isNativePlatform()) return;
  if (applied === suppressed) return;
  applied = suppressed;

  void selectionMenu.setSuppressed({ suppressed }).catch(() => {
    /*
     * No plugin in this build. Forget the value rather than pretend it was sent,
     * so a later attempt (a new Android build, a reloaded page) still tries.
     */
    applied = null;
  });
}
