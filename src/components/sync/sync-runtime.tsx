'use client';

import * as React from 'react';
import { useSyncStore } from '@/stores/sync-store';
import { useVaultStore } from '@/stores/vault-store';

/**
 * The lifecycle half of sync.
 *
 * It runs once, inside the boot gate, and does three things: initialises the
 * sync store after the vault is readable, asks for a sync when a local edit has
 * settled (the store does the debouncing), and asks again when the app comes back
 * into the foreground or the network returns.
 *
 * Nothing here runs in the background. Android will not keep a WebView alive to
 * poll Drive, and pretending otherwise would produce a sync indicator that means
 * nothing. "Resume" is the promise: come back to Stash and it catches up.
 */
export function SyncRuntime() {
  const initialize = useSyncStore((state) => state.initialize);
  const noteLocalChange = useSyncStore((state) => state.noteLocalChange);
  const handleResume = useSyncStore((state) => state.handleResume);
  const handleOnline = useSyncStore((state) => state.handleOnline);

  React.useEffect(() => {
    void initialize();
  }, [initialize]);

  /*
   * Every vault change bumps `dataVersion`, including the refresh a sync itself
   * performs. The store's pending-change check is what keeps that from becoming
   * a feedback loop; this effect only has to notice the bump.
   */
  React.useEffect(() => {
    let previous = useVaultStore.getState().dataVersion;
    return useVaultStore.subscribe((state) => {
      if (state.dataVersion === previous) return;
      previous = state.dataVersion;
      noteLocalChange();
    });
  }, [noteLocalChange]);

  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') handleResume();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onOnline = () => handleOnline();
    window.addEventListener('online', onOnline);

    let detach: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const core = await import('@capacitor/core');
        if (!core.Capacitor.isNativePlatform()) return;
        const app = await import('@capacitor/app');
        const handle = await app.App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) handleResume();
        });
        if (cancelled) void handle.remove();
        else detach = () => void handle.remove();
      } catch {
        /* no native app state: the web listener is enough */
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      if (detach) detach();
    };
  }, [handleOnline, handleResume]);

  return null;
}
