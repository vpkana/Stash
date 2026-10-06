'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS, isActiveNav } from './nav';
import { cn } from '@/lib/utils';

/**
 * Primary navigation, phone shape.
 *
 * Hidden from `lg` up, where {@link SidebarNav} takes over: two navigations on
 * screen at once is the clearest possible signal that an app was ported to the
 * web rather than designed for it.
 *
 * The bar is deliberately tall (64px of touch, plus the safe area) and its active
 * state is a filled capsule behind the icon *and* the label: the label carries
 * the meaning, and colouring only the icon makes people hunt for which tab they
 * are on.
 */
export function BottomNav() {
  const pathname = usePathname() ?? '/';

  return (
    <nav
      aria-label="Primary"
      className="z-40 shrink-0 border-t border-hairline bg-surface/95 pb-safe backdrop-blur-xl lg:hidden"
    >
      <ul className="flex items-stretch">
        {NAV_ITEMS.map((item) => {
          const active = isActiveNav(pathname, item.href);
          const TabIcon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className="tap flex h-16 flex-col items-center justify-center gap-1.5"
              >
                <span
                  className={cn(
                    'flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200',
                    active ? 'nav-active' : 'bg-transparent',
                  )}
                >
                  <TabIcon
                    size={20}
                    strokeWidth={active ? 2.2 : 1.8}
                    className={cn('transition-colors duration-200', active ? 'text-accent' : 'text-muted')}
                    aria-hidden
                  />
                </span>
                <span
                  className={cn(
                    'text-label leading-none tracking-tight transition-colors duration-200',
                    active ? 'font-semibold text-accent' : 'font-medium text-muted',
                  )}
                >
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
