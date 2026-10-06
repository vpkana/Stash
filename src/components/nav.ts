import { Home, Library, NotebookPen, Search, Settings, type IconType } from '@/components/ui/icons';

/**
 * Primary navigation, in one place.
 *
 * Five destinations, which is the practical limit for a thumb-reachable bar on a
 * phone: Home answers "what did I just save", Library is where structure lives,
 * Notes is where the user's own writing lives, Search finds anything, and
 * Settings holds the rare, destructive things.
 *
 * This table is shared by both shapes of the app — the phone's tab bar and the
 * desktop's sidebar — because the moment they are separate lists they start to
 * disagree, and "the sidebar has a place the tab bar doesn't" is a bug the user
 * cannot even report clearly.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: IconType;
  /** Shown only in the sidebar, where there is room for a second line. */
  hint: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', icon: Home, hint: 'What you just saved' },
  { href: '/library', label: 'Library', icon: Library, hint: 'Folders and tags' },
  { href: '/notes', label: 'Notes', icon: NotebookPen, hint: 'Your own writing' },
  { href: '/search', label: 'Search', icon: Search, hint: 'Find anything' },
  { href: '/settings', label: 'Settings', icon: Settings, hint: 'Locking, backup, data' },
];

/**
 * `/` is Home; anything else matches its own subtree. Kept as a function rather
 * than a regex because `startsWith('/search')` would otherwise also light up a
 * hypothetical `/search-notes`, and that class of bug shows up as two nav items
 * active at once.
 */
export function isActiveNav(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
