'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { BottomNav } from './bottom-nav';
import { SidebarNav } from './sidebar-nav';
import { PrimaryActionButton } from './primary-action';
import { AndroidBack } from './android-back';
import { CaptureSheet } from './capture/capture-sheet';
import { LockGate } from './privacy/lock-gate';
import { Toaster } from './ui/toast';
import { useCaptureStore } from '@/stores/capture-store';
import { useEditorStore } from '@/stores/editor-store';
import { usePrivacyStore } from '@/stores/privacy-store';

/**
 * The top-level section a route belongs to.
 *
 * `/` is Home; anything else is its first segment. Used to tell "the user moved
 * to another tab" from "the user went deeper into this one", which is the whole
 * difference between ending an unlocked session and getting in the way.
 */
function sectionOf(pathname: string): string {
  return pathname.split('/')[1] ?? '';
}

/**
 * Two shapes, one shell.
 *
 * **Phone.** The page never scrolls as a whole; the main region does. That keeps
 * the tab bar pinned, makes the gesture bar behave, and means a sheet can take
 * over the screen without the underlying page shifting behind it. This is the
 * primary surface and nothing here is compromised for the desktop one.
 *
 * The tab bar is drawn on every screen except two: while an incoming share is
 * being handled (the capture surface is the whole screen), and while a note is
 * open. The second one is the keyboard fix — see `stores/editor-store.ts` — and it
 * is a *removal* rather than a shift, because there is no offset that can be
 * right when the keyboard height is unknown.
 *
 * **Desktop.** Above `lg` the same shell becomes a row: the rail on the left, the
 * content column on the right, no tab bar. Notice that this is one component with
 * one `lg:` breakpoint rather than a second layout — a separate desktop shell is
 * how the two drift until they hash differently, and the content column
 * (`column` in `globals.css`) is what makes a 1400px window readable rather than
 * merely wide.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const captureStatus = useCaptureStore((state) => state.status);
  const captureMode = useCaptureStore((state) => state.mode);
  const pathname = usePathname() ?? '/';
  const lockOnTabChange = usePrivacyStore((state) => state.lockOnTabChange);

  /*
   * An unlock lasts for the session, and the session is the tab.
   *
   * Opening a folder or a note does not leave the section, so walking around
   * inside one does not re-lock anything. Moving to a different top-level screen
   * does — and the one navigation that is exempt is the one a reveal caused, which
   * `lockOnTabChange` recognises by having just happened (see `session.ts`).
   */
  const section = sectionOf(pathname);
  const previousSection = React.useRef(section);
  React.useEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;
    lockOnTabChange();
  }, [section, lockOnTabChange]);

  /*
   * While an incoming share is being handled the chrome is not drawn at all.
   * The capture surface covers the screen, so the tab bar and the action button
   * would only ever be a flash of somebody else's screen behind the fade-in.
   */
  const shareTakeover = captureStatus !== 'idle' && captureMode === 'share';
  // A note is being written: the writing toolbar owns the bottom of the screen,
  // and the tab bar would be sitting on the keyboard.
  const noteOpen = useEditorStore((state) => state.noteOpen);

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-bg px-safe pt-safe lg:flex-row lg:px-0 lg:pt-0">
      <SidebarNav />

      <main id="main" className="scroll-area relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/*
          The reading column. On a phone this is simply the full width, so the
          phone layout is byte-for-byte what it was; above `lg` it stops growing
          and centres, which is the entire difference between an app that was
          designed for one screen and an app that happens to render on a big one.
        */}
        <div className="column flex min-h-full flex-col">{children}</div>
      </main>

      <React.Suspense fallback={null}>
        <PrimaryActionButton variant="floating" />
      </React.Suspense>

      {shareTakeover || noteOpen ? null : <BottomNav />}
      <CaptureSheet />
      <Toaster />
      {/* Registered once, above every screen: the hardware back button. */}
      <AndroidBack />
      {/* Last so it paints over the shell, the sheets and the toasts alike. */}
      <LockGate />
    </div>
  );
}
