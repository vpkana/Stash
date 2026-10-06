'use client';

import * as React from 'react';
import { LogoTile } from '@/components/ui/logo';
import { getActiveShareBridge } from '@/lib/share/bridge';
import { useCaptureStore } from '@/stores/capture-store';
import { usePrivacyStore } from '@/stores/privacy-store';
import { useThemeStore } from '@/stores/theme-store';
import { useVaultStore } from '@/stores/vault-store';

/**
 * Boot sequence.
 *
 * Order matters: IndexedDB opens and seeds first, the theme is applied before
 * anything is painted so there is no light flash on a dark device, and only
 * then is a share from Android consumed -- by which point the folder list is in
 * memory and the Save Sheet can render fully populated on its first frame.
 */
export function AppBoot({ children }: { children: React.ReactNode }) {
  const initialize = useVaultStore((state) => state.initialize);
  const refresh = useVaultStore((state) => state.refresh);
  const initializeTheme = useThemeStore((state) => state.initialize);
  const initializePrivacy = usePrivacyStore((state) => state.initialize);

  React.useEffect(() => {
    // Sequential because the privacy session has to be resolved *before* the
    // vault is read: the read decides what is decryptable, and reading first
    // would either show locked items or blank ones depending on timing.
    void (async () => {
      await initializeTheme();
      await initialize();
      await initializePrivacy();
    })();
  }, [initialize, initializePrivacy, initializeTheme]);

  // Re-read the vault when the app comes back to the foreground: Android may
  // have killed and restored the process while another app was on screen.
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && useVaultStore.getState().status === 'ready') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  return <>{children}</>;
}

/**
 * Keeps the vault in step with the privacy session.
 *
 * Two jobs, and both are about the session, not about the UI:
 *
 *  1. when the session locks or unlocks, the vault is re-read — which is what
 *     turns locked items back into readable content, and back again, because the
 *     store decides what is readable rather than a component hiding it;
 *  2. when the app leaves the foreground, the session ends — losing the key, not
 *     merely a flag (see `handleBackground`).
 *
 * Android may also kill the process while backgrounded, so the app state
 * listener and the web `visibilitychange` event are both wired: the native event
 * is authoritative when it fires, and the web one covers the PWA and desktop
 * builds where there is no Capacitor runtime.
 */
export function PrivacySession() {
  React.useEffect(() => {
    return usePrivacyStore.subscribe((state, previous) => {
      // The key changed (what is *decryptable*) or a lock boundary was crossed
      // (what is *permitted*). Both change what every listing may show, so both
      // re-read. `grantedRoots` is a fresh array on every grant, so a reference
      // check is enough.
      if (state.unlocked === previous.unlocked && state.grantedRoots === previous.grantedRoots) return;
      void useVaultStore.getState().refresh();
    });
  }, []);

  React.useEffect(() => {
    const privacy = () => usePrivacyStore.getState();

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') privacy().handleBackground();
      else privacy().handleForeground();
    };
    document.addEventListener('visibilitychange', onVisibility);

    let detach: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const core = await import('@capacitor/core');
        if (!core.Capacitor.isNativePlatform()) return;
        const app = await import('@capacitor/app');
        const handle = await app.App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) {
            privacy().handleForeground();
            void privacy().refreshCapabilities();
          } else {
            privacy().handleBackground();
          }
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
      if (detach) detach();
    };
  }, []);

  return null;
}

/**
 * Turns an incoming Android share into the capture flow.
 *
 * `receivedAt` on the normalized share lets us ignore a payload that is being
 * replayed from a stale process restoration.
 */
const MAX_SHARE_AGE_MS = 4 * 60 * 1000;

export function ShareListener() {
  const status = useVaultStore((state) => state.status);

  /*
   * Keyed on the vault being ready, with no "already ran" ref.
   *
   * A `started` flag looks tidier and is wrong: React in development mounts,
   * unmounts and remounts this effect on purpose, and the flag survives the
   * remount while the work it was guarding has already been cancelled — so the
   * one path that has to work exactly once, on a cold start, silently did
   * nothing. Running again is safe: the pending share is consumed after it is
   * read, and opening the same share twice is the same state.
   */
  React.useEffect(() => {
    if (status !== 'ready') return;

    let unsubscribe: () => void = () => undefined;
    let cancelled = false;

    void (async () => {
      const bridge = await getActiveShareBridge();
      if (cancelled) return;

      unsubscribe = bridge.subscribe((share) => {
        // Warm start: the app is already running behind another app.
        void useCaptureStore.getState().openFromShare(share);
      });

      const pending = await bridge.getPendingShare();
      if (cancelled || !pending) return;

      const age = Date.now() - pending.receivedAt;
      if (age < MAX_SHARE_AGE_MS) {
        await useCaptureStore.getState().openFromShare(pending);
      }
      // Consume it either way so a restart does not replay a stale share.
      await bridge.clearPendingShare();
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [status]);

  return null;
}

/**
 * Shown while IndexedDB opens.
 *
 * The one screen where the brand is the whole content: the mark on its tile and
 * the wordmark, at the size a real launch screen would use. It is also the only
 * place the app names itself — which is what makes it feel like the app opening
 * rather than a page loading.
 */
export function BootSplash() {
  return (
    <div className="bg-bg flex h-dvh flex-col items-center justify-center gap-5">
      <div className="animate-pop-in">
        <LogoTile size={72} className="shadow-raised" />
      </div>
      <div className="animate-pop-in text-center">
        <p className="text-display font-semibold tracking-tight text-fg">Stash</p>
        <p className="text-body mt-1 text-muted">Opening your vault…</p>
      </div>
    </div>
  );
}

export function BootGate({ children }: { children: React.ReactNode }) {
  const status = useVaultStore((state) => state.status);
  const error = useVaultStore((state) => state.error);
  // The vault is readable before the privacy session is resolved, and on a cold
  // start that read is what decides which rows are ciphertext. Waiting for it
  // means the first painted frame already shows locked items as locked rather
  // than flashing their shape and then correcting itself.
  const privacyReady = usePrivacyStore((state) => state.ready);

  if (status === 'error') {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg px-8 text-center">
        <p className="text-title font-semibold text-fg">Could not open the local vault</p>
        <p className="text-body text-muted">{error}</p>
        <p className="text-meta text-subtle">
          Stash stores everything on this device. Check that storage is not full and try again.
        </p>
      </div>
    );
  }

  if (status === 'booting' || !privacyReady) return <BootSplash />;
  return <>{children}</>;
}
