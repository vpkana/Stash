'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Page scaffolding.
 *
 * One sticky header pattern for every screen keeps the scroll position obvious,
 * and the title is a real title: 28px on a phone, 34px once there is a desktop to
 * put it on. A big heading is not decoration — it is what tells the eye where the
 * screen begins and what it is, in the half-second before any content is read.
 *
 * The header is full-bleed and its *contents* sit in the reading column, which is
 * the only arrangement that works in both shapes: on a phone the column is the
 * screen, so nothing changed; on a desktop the blurred backdrop still covers the
 * whole width while the title lines up with the rows underneath it.
 *
 * There is no rule under the header. A hairline across the full width is the
 * single most "tool-like" detail an app can have: it reads as a table boundary
 * rather than as a title. The blur behind the title is what separates it from
 * content scrolling underneath.
 */
export function PageHeader({
  children,
  className,
  sticky = true,
}: {
  children: React.ReactNode;
  className?: string;
  sticky?: boolean;
}) {
  return (
    <header className={cn('z-20 bg-bg/85 backdrop-blur-xl', sticky && 'sticky top-0', className)}>
      <div className="px-4 pt-4 pb-3 lg:pt-7 lg:pb-4">{children}</div>
    </header>
  );
}

export function PageTitle({ children, subtitle }: { children: React.ReactNode; subtitle?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h1 className="text-display lg:text-hero truncate font-semibold text-fg">{children}</h1>
      {subtitle ? <p className="text-body mt-1 truncate text-muted">{subtitle}</p> : null}
    </div>
  );
}

/**
 * A labelled group with an optional action on the right.
 *
 * The label is sentence case, semibold and *legible*: a section label is a
 * signpost, not an eyebrow. It used to be 12px grey, which is the size and colour
 * of a caption nobody is meant to read.
 */
export function Section({
  title,
  action,
  children,
  className,
  actionHref,
  onAction,
}: {
  title: string;
  action?: string;
  actionHref?: string;
  onAction?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mt-8 first:mt-4', className)}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2">
        <h2 className="text-label truncate font-semibold text-muted">{title}</h2>
        {action && actionHref ? (
          <Link
            href={actionHref}
            className="tap text-meta shrink-0 rounded-tap px-1 py-0.5 font-semibold text-accent active:bg-accent-soft"
          >
            {action}
          </Link>
        ) : action && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="tap text-meta shrink-0 rounded-tap px-1 py-0.5 font-semibold text-accent active:bg-accent-soft"
          >
            {action}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * An empty state, said kindly.
 *
 * The icon sits on a soft accent tile and the block is centred, because an empty
 * screen is the one place where the app has nothing to show and everything to
 * explain: it should look deliberate rather than half-loaded. The copy is one
 * short sentence plus a way forward, never a numbered manual.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
      {icon ? (
        <span className="mb-1 flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          {icon}
        </span>
      ) : null}
      <p className="text-title font-semibold tracking-tight text-fg">{title}</p>
      {description ? (
        <p className="text-body max-w-[38ch] leading-relaxed text-muted text-balance">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * A group of rows.
 *
 * One soft edge around content that belongs together — a hairline, a 20px radius,
 * and rows divided inside it. This is the app's most common surface, and it
 * replaced full-bleed hairlines for a reason: a screen of bare rules reads as a
 * spreadsheet, while the same rows on a card read as a handful of things the user
 * owns. It is always inset by the page margin, so the card's edge is never
 * confused with the screen's edge.
 */
export function ListSurface({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('card mx-4 flex flex-col divide-y divide-hairline', className)}>{children}</div>;
}

/**
 * The same surface as {@link ListSurface}, kept as a name because settings-style
 * screens talk about groups ("Appearance", "Locking") rather than lists.
 *
 * They used to be two different looks — one bordered, one bare — which is how an
 * app ends up with two visual languages for the same idea. There is one.
 */
export function GroupSurface({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('card mx-4 flex flex-col divide-y divide-hairline', className)}>{children}</div>;
}
