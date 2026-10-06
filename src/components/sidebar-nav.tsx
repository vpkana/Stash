'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS, isActiveNav } from './nav';
import { LogoLockup } from './ui/logo';
import { PrimaryActionButton } from './primary-action';
import { cn } from '@/lib/utils';

/**
 * The desktop shape of the navigation.
 *
 * Below `lg` this does not exist: a phone gets the tab bar, which is the thing a
 * thumb can reach. But a 1400px window is not a phone, and stretching a phone
 * layout across it produces the worst of both — rows 1400px wide, a tab bar
 * floating in the middle of nowhere, and a reading column so long the eye loses
 * its place between lines. So above `lg` the app grows a rail on the left and the
 * content becomes a centred column (`column` in `globals.css`), and the tab bar
 * retires.
 *
 * The rail earns its 256px: the mark, the five destinations with room for the
 * second line that says what each one is *for*, and the primary action — which is
 * where a desktop user's pointer already lives. It also gives the app somewhere
 * honest to put the one sentence that matters most about it.
 */
export function SidebarNav() {
  const pathname = usePathname() ?? '/';

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface lg:flex">
      <div className="px-5 pt-6 pb-5">
        <LogoLockup size={40} subtitle="Your vault" />
      </div>

      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 no-scrollbar">
        {NAV_ITEMS.map((item) => {
          const active = isActiveNav(pathname, item.href);
          const NavIcon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'tap flex items-center gap-3 rounded-control px-3 py-2.5',
                active ? 'nav-active' : 'text-fg hover:bg-surface-2',
              )}
            >
              <NavIcon size={19} strokeWidth={active ? 2.2 : 1.8} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className={cn('text-row block truncate', active ? 'font-semibold' : 'font-medium')}>
                  {item.label}
                </span>
                <span
                  className={cn('text-meta block truncate', active ? 'text-accent/70' : 'text-subtle')}
                >
                  {item.hint}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-hairline px-4 py-5">
        <React.Suspense fallback={null}>
          <PrimaryActionButton variant="sidebar" />
        </React.Suspense>
        {/*
          The one sentence that matters most about this app, said once, where a
          desktop user will read it: the vault is local. It is not a slogan — it
          is the reason the app exists, and the rail has the room.
        */}
        <p className="text-meta mt-4 px-1 leading-relaxed text-subtle">
          Everything stays on this device. Stash never uploads your links or notes.
        </p>
      </div>
    </aside>
  );
}
