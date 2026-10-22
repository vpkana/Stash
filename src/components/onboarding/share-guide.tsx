'use client';

import * as React from 'react';
import { Download, ExternalLink, Link2, MoreHorizontal, Share2, Smartphone } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { LogoMark } from '@/components/ui/logo';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useBackDismiss } from '@/hooks/use-back-dismiss';
import { openExternal } from '@/lib/open-external';
import { cn } from '@/lib/utils';

/**
 * How a link gets into Stash from another app — shown once, illustrated.
 *
 * The share feature has a discoverability problem that no amount of copywriting
 * fixes: it lives *outside* this app. Nothing on a phone's home screen hints that
 * sharing a page from Chrome can file it, and in most social apps Stash is not on
 * the first row of the share sheet at all — it is behind "More". A new user
 * therefore has to already know that two different share sheets behave two
 * different ways, which is not something to learn from a sentence in an empty
 * state.
 *
 * So the first run shows the sheets themselves. They are drawn here rather than
 * shipped as screenshots: a picture of Instagram would date, and a picture of
 * *this* app's own idea of Instagram would be a promise about someone else's
 * interface. A schematic phone with a highlighted row says the one thing that
 * needs saying — "the row you are looking for looks like this" — and keeps
 * working in both themes and at any font size.
 *
 * The web app cannot receive a share at all. That is a platform fact, not a
 * missing feature, so instead of pretending otherwise the guide says so once,
 * plainly, and offers the Android build for people who want the share sheet.
 */

/** Remembered so the guide opens once, not every time the vault is empty. */
export const SHARE_GUIDE_SEEN_KEY = 'onboarding.shareGuide';

/**
 * Where the Android build lives.
 *
 * The repository's releases page rather than a hard-coded asset URL: an APK path
 * changes with every build, and a link that 404s is worse than no link.
 */
export const ANDROID_DOWNLOAD_URL = 'https://github.com/Redakai-07/Stash/releases';

export function ShareGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = React.useState(0);
  /*
   * Closing rewinds the guide, so opening it again starts at the first card.
   * Done on the way out rather than in an effect on `open`: this is a short
   * explanation, not a place with a reading position to restore.
   */
  const close = React.useCallback(() => {
    setStep(0);
    onClose();
  }, [onClose]);
  useBackDismiss(open, close);

  if (!open) return null;

  const steps = [
    {
      title: 'From your browser',
      body: 'Open a page in Chrome or any browser, tap Share, then pick Stash. The link lands in your Inbox — no title, folder or tag is required.',
      art: <BrowserMock />,
    },
    {
      title: 'From social apps',
      body: 'In Instagram, YouTube or X the first row of the share sheet is short. Tap More and Stash is in the full list.',
      art: <SocialMock />,
    },
    {
      title: 'Sharing needs the phone app',
      body: 'A browser cannot hand a link to another website, so this works in the Android build only. Everything else — reading, searching, notes — works exactly the same on the web.',
      art: <PhoneCallout />,
    },
  ];

  const current = steps[step] ?? steps[0]!;
  const last = step === steps.length - 1;

  return (
    <Sheet open onOpenChange={(next) => !next && close()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{current.title}</SheetTitle>
          <p className="mt-1 text-meta leading-relaxed text-subtle">{current.body}</p>
        </SheetHeader>

        <SheetBody>
          <div className="flex min-h-[16.5rem] items-center justify-center px-2 pb-4">{current.art}</div>

          {/* Step dots, as a position and not as navigation: three steps are
              short enough to read in order, and a dot that jumps skips the one
              card that explains the "More" row. */}
          <div className="flex items-center justify-center gap-1.5 pb-4" aria-hidden>
            {steps.map((_, index) => (
              <span
                key={index}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  index === step ? 'w-5 bg-accent' : 'w-1.5 bg-border',
                )}
              />
            ))}
          </div>

          <div className="flex items-center gap-2 px-1 pb-2">
            {step > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setStep((value) => value - 1)}>
                Back
              </Button>
            ) : null}
            <div className="flex-1" />
            {last ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  void openExternal(ANDROID_DOWNLOAD_URL);
                }}
              >
                <Download size={16} strokeWidth={2.1} aria-hidden />
                Get the Android app
              </Button>
            ) : (
              <Button variant="accentSoft" size="sm" onClick={() => setStep((value) => value + 1)}>
                Next
              </Button>
            )}
          </div>

          <button
            type="button"
            onClick={close}
            className="tap mx-auto mb-2 block rounded-full px-4 py-2 text-meta font-medium text-subtle active:bg-surface-2"
          >
            {last ? 'Continue in the browser' : 'Skip'}
          </button>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** A phone, drawn: bezel, a hint of an interface, and nothing pretending to be a photo. */
function PhoneFrame({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    <figure className="m-0 flex flex-col items-center gap-2.5">
      <div className="w-[13.5rem] rounded-[1.9rem] border-[6px] border-border bg-surface-2 p-1 shadow-card">
        <div className="relative overflow-hidden rounded-[1.4rem] bg-surface">
          <div className="mx-auto mt-1.5 h-1 w-8 rounded-full bg-border" aria-hidden />
          <div className="px-2 pb-2 pt-2.5">{children}</div>
        </div>
      </div>
      <figcaption className="text-meta text-subtle">{caption}</figcaption>
    </figure>
  );
}

/** Two skeleton lines standing in for someone else's page. */
function ArticleLines({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1.5" aria-hidden>
      <div className="h-2 w-3/4 rounded-full bg-surface-3" />
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-1.5 rounded-full bg-border"
          style={{ width: `${[92, 78, 85, 64][index % 4]}%` }}
        />
      ))}
    </div>
  );
}

/** A share sheet row for Stash, with the tile the app actually uses. */
function StashRow({ highlighted }: { highlighted?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg px-2 py-1.5',
        highlighted ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2',
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface">
        <LogoMark size={13} />
      </span>
      <span className="text-[11px] font-semibold text-fg">Stash</span>
      {highlighted ? <span className="ml-auto text-[9px] font-bold text-accent">TAP THIS</span> : null}
    </div>
  );
}

/** Chrome: a page, its toolbar, and the share button in it. */
function BrowserMock() {
  return (
    <PhoneFrame caption="Chrome · Share, then Stash">
      <div className="flex items-center gap-1 pb-2" aria-hidden>
        <span className="flex size-4 items-center justify-center rounded-full bg-danger/60" />
        <span className="flex size-4 items-center justify-center rounded-full bg-warning/70" />
        <span className="flex size-4 items-center justify-center rounded-full bg-success/60" />
        <span className="ml-1 h-3 flex-1 rounded-full bg-surface-2" />
      </div>
      <ArticleLines rows={3} />
      <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1.5" aria-hidden>
        <div className="h-1.5 flex-1 rounded-full bg-border" />
        <Share2 size={12} strokeWidth={2.4} className="text-accent" />
      </div>
      <div className="mt-2 rounded-xl border border-border p-1.5">
        <p className="px-1 pb-1 text-[9px] font-semibold tracking-wide text-muted uppercase">Share</p>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5" aria-hidden>
            <span className="size-6 shrink-0 rounded-md bg-surface-2" />
            <span className="text-[11px] text-muted">Copy link</span>
          </div>
          <StashRow highlighted />
        </div>
      </div>
    </PhoneFrame>
  );
}

/** A social app: short first row, and "More" holding the rest. */
function SocialMock() {
  return (
    <PhoneFrame caption="Instagram · Share, then More">
      <div className="flex items-center gap-2 pb-2" aria-hidden>
        <span className="size-5 rounded-full bg-surface-3" />
        <div className="h-1.5 w-16 rounded-full bg-border" />
        <MoreHorizontal size={12} className="ml-auto text-subtle" />
      </div>
      <div className="flex gap-2" aria-hidden>
        <div className="h-14 flex-1 rounded-md bg-surface-2" />
        <div className="h-14 flex-1 rounded-md bg-surface-2" />
        <div className="h-14 flex-1 rounded-md bg-surface-2" />
      </div>
      <div className="mt-2 rounded-xl border border-border p-1.5">
        <p className="px-1 pb-1 text-[9px] font-semibold tracking-wide text-muted uppercase">Share to</p>
        <div className="flex items-start gap-1.5">
          {['Stories', 'Message', 'Copy'].map((label) => (
            <div key={label} className="flex flex-1 flex-col items-center gap-1" aria-hidden>
              <span className="size-8 rounded-full bg-surface-2" />
              <span className="text-[8px] text-subtle">{label}</span>
            </div>
          ))}
          <div className="flex flex-1 flex-col items-center gap-1">
            <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft ring-2 ring-accent">
              <MoreHorizontal size={13} className="text-accent" />
            </span>
            <span className="text-[8px] font-semibold text-accent">More</span>
          </div>
        </div>
        <div className="mt-1.5">
          <StashRow highlighted />
        </div>
      </div>
    </PhoneFrame>
  );
}

/** The honest bit: this is an Android-only gesture, and here is where to get it. */
function PhoneCallout() {
  return (
    <div className="flex w-full flex-col items-center gap-3 px-2 text-center">
      <div className="relative flex size-24 items-center justify-center rounded-[1.6rem] border border-border bg-surface-2">
        <Smartphone size={34} strokeWidth={1.5} className="text-muted" aria-hidden />
        <span className="absolute -right-1.5 -bottom-1.5 flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg shadow-card">
          <Share2 size={15} strokeWidth={2.4} aria-hidden />
        </span>
      </div>
      <ul className="flex flex-col gap-1.5 text-left">
        {[
          { icon: Share2, text: 'Share from any app into Stash' },
          { icon: Link2, text: 'The link is filed without opening Stash first' },
          { icon: ExternalLink, text: 'Installs beside the web app, same vault' },
        ].map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2 text-meta text-muted">
            <Icon size={14} strokeWidth={2.2} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}
