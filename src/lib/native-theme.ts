'use client';

import { Capacitor, registerPlugin } from '@capacitor/core';
import type { ResolvedTheme } from '@/stores/theme-store';

interface ThemeModePlugin {
  setNightMode(options: { dark: boolean }): Promise<void>;
}

const themeMode = registerPlugin<ThemeModePlugin>('ThemeMode');

/**
 * Keep the *native* window on the app's theme, not the device's.
 *
 * Stash follows its own theme — Settings can pin light or dark whatever the
 * phone is set to — but Android draws its own chrome (the Cut/Copy selection
 * toolbar over a WebView selection, dialogs, the window background in any gap
 * the WebView does not cover) from the activity's day/night mode, which comes
 * from the *device*. On the mismatch the selection toolbar in particular lands
 * as a black slab over light text.
 *
 * The resolved theme is therefore pushed to the native window whenever it
 * changes, exactly the way `syncSystemBars` hands the same value to the system
 * bars. The call is asynchronous and failure is swallowed: off Android the
 * plugin does not exist, and a window that cannot be re-themed must not take
 * the app down with it.
 */
export function syncNativeTheme(resolved: ResolvedTheme): void {
  if (!Capacitor.isNativePlatform()) return;
  void themeMode
    .setNightMode({ dark: resolved === 'dark' })
    .catch(() => {
      /* no ThemeMode implementation here: the window keeps the device appearance */
    });
}
