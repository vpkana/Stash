'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

/**
 * Bottom sheet, and — from `lg` up — a centred compact dialog.
 *
 * Radix's Dialog gives us focus trapping, scroll locking, escape handling and
 * `aria-modal` semantics for free. It also keeps the node mounted until the
 * closing animation finishes, so the exit motion is real rather than a snap.
 *
 * ## Two shapes, one component
 *
 * On a phone a sheet rises from the bottom edge and spans the screen, because
 * that is where a thumb can reach it. On a desktop that same full-width band
 * pinned to the bottom of a 1400px window is wrong twice over: it puts a 1400px
 * form under a 16px label, and it puts the confirm button a hand's width below
 * the content it confirms. So above `lg` the identical surface becomes a
 * **centred, compact dialog** — `inset-0` plus `margin: auto` centres it without
 * a transform, so the shared rise animation still plays and nothing has to be
 * duplicated. It is a media query on one element, not a second sheet component:
 * two implementations of "the action list for a link" is how a phone and a
 * desktop start to disagree.
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

export const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function SheetOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-overlay',
        'data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out',
        className,
      )}
      {...props}
    />
  );
});

export interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Hide the grab handle when the sheet is used as a full-height surface. */
  showHandle?: boolean;
  /** Element id describing the sheet, for screen readers. */
  describedBy?: string;
  /**
   * Keep the surface full-bleed on desktop too. For the share takeover, which is
   * a screen rather than a dialog — a captured share should not become a small
   * centred box just because the window is wide.
   */
  fullBleedOnDesktop?: boolean;
}

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent(
  { className, children, showHandle = true, describedBy, fullBleedOnDesktop = false, ...props },
  ref,
) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        aria-describedby={describedBy}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden',
          'rounded-t-sheet border-t border-border bg-surface shadow-sheet',
          'data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out',
          /*
           * Desktop: centred and compact. `inset-0` + `mx-auto`/`my-auto`
           * centres both axes without a transform, so the sheet's own
           * translateY animation still plays — it simply slides its own height
           * upward into the middle of the window instead of from off-screen.
           */
          !fullBleedOnDesktop && [
            'lg:inset-0 lg:mx-auto lg:my-auto lg:h-fit lg:w-[min(30rem,calc(100vw-5rem))]',
            'lg:max-h-[min(44rem,calc(100dvh-5rem))] lg:rounded-surface lg:border lg:shadow-raised',
          ],
          className,
        )}
        {...props}
      >
        {showHandle ? (
          <div className="flex shrink-0 justify-center pt-2.5 pb-1 lg:hidden" aria-hidden>
            <span className="h-1 w-9 rounded-full bg-border-strong" />
          </div>
        ) : null}
        {children}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
});

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('shrink-0 px-5 pt-2 pb-3', className)} {...props} />;
}

export const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function SheetTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-[1.0625rem] leading-tight font-semibold tracking-tight text-fg', className)}
      {...props}
    />
  );
});

export const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function SheetDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description ref={ref} className={cn('mt-1 text-body text-muted', className)} {...props} />
  );
});

/** The scrollable middle region of a sheet. */
export function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('scroll-area min-h-0 flex-1 overflow-y-auto px-3 pb-1', className)} {...props} />;
}

/** Pinned footer, kept above the keyboard and the gesture bar. */
export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('shrink-0 border-t border-border bg-surface px-4 pt-3 pb-safe', className)}
      {...props}
    />
  );
}
