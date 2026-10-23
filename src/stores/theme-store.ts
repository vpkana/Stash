'use client';

import { create } from 'zustand';
import {
  getAccent,
  getThemeMode,
  setAccent as persistAccent,
  setThemeMode,
  type ThemeMode,
} from '@/db/repos/settings';
import { DEFAULT_ACCENT, type AccentId } from '@/lib/accent';
import { syncSystemBars } from '@/lib/system-bars';

export type { ThemeMode };

/**
 * Theme preference.
 *
 * `system` is a real mode, not a fallback: it follows the OS setting and keeps
 * following it while the app is open, which is what people expect from a
 * native-feeling Android app.
 */

export type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  accent: AccentId;
  ready: boolean;
  initialize: () => Promise<void>;
  setMode: (mode: ThemeMode) => Promise<void>;
  setAccent: (accent: AccentId) => Promise<void>;
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const THEME_CACHE_KEY = 'stash.theme';
const ACCENT_CACHE_KEY = 'stash.accent';

function applyResolved(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  // Android draws the bars itself, so the theme has to be handed over too.
  syncSystemBars(resolved);
}

/**
 * Mirror the mode into localStorage so the pre-paint boot script can colour the
 * very first frame. IndexedDB stays the source of truth; this is a cache that
 * only ever affects the first few milliseconds of a cold start.
 */
function cacheMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, mode);
  } catch {
    /* storage disabled: the boot script falls back to the OS preference */
  }
}

/**
 * Hand the chosen palette to the stylesheet.
 *
 * The palette itself lives in `globals.css` as one `data-accent` block per
 * colour, so this is the entire mechanism: set the attribute, and every surface
 * that reads `--accent` follows. Nothing in JS knows a hex value.
 */
function applyAccent(accent: AccentId): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.accent = accent;
}

/** Same paint-time cache as the mode: IndexedDB stays the source of truth. */
function cacheAccent(accent: AccentId): void {
  try {
    window.localStorage.setItem(ACCENT_CACHE_KEY, accent);
  } catch {
    /* storage disabled: the boot script falls back to the default palette */
  }
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: 'system',
  resolved: 'light',
  accent: DEFAULT_ACCENT,
  ready: false,

  initialize: async () => {
    if (get().ready) return;
    const [mode, accent] = await Promise.all([getThemeMode(), getAccent()]);
    const resolved = mode === 'system' ? systemTheme() : mode;
    applyResolved(resolved);
    applyAccent(accent);
    cacheMode(mode);
    cacheAccent(accent);
    set({ mode, resolved, accent, ready: true });

    if (typeof window !== 'undefined' && window.matchMedia) {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => {
        if (get().mode !== 'system') return;
        const next = systemTheme();
        applyResolved(next);
        set({ resolved: next });
      };
      query.addEventListener('change', listener);
    }
  },

  setMode: async (mode) => {
    const resolved = mode === 'system' ? systemTheme() : mode;
    applyResolved(resolved);
    cacheMode(mode);
    set({ mode, resolved });
    await setThemeMode(mode);
  },

  setAccent: async (accent) => {
    // Painted first and persisted second: the picker is the preview, and a
    // colour that only appears once IndexedDB answers feels broken.
    applyAccent(accent);
    cacheAccent(accent);
    set({ accent });
    await persistAccent(accent);
  },
}));
