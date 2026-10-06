'use client';

import * as React from 'react';
import { Check, Search } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/**
 * An indented, filterable picker over a flattened tree.
 *
 * Both "which folder should this link go in" and "which note is this a subnote
 * of" are the same interaction, so they share one component. Flattening with
 * indentation instead of a drill-down browser is deliberate: every destination
 * is one tap away no matter how deep the user has nested things.
 */

export interface TreePickerItem {
  /** Stable selection key, e.g. `folder:<id>` or `note:<id>`. */
  key: string;
  label: string;
  /** Full `A → B → C` path, used as the secondary line and for filtering. */
  path: string;
  depth: number;
  /** Leading glyph. Falls back to the label's first letter when absent. */
  icon?: React.ReactNode;
  /** Short explanatory line for pseudo-destinations such as "Inbox". */
  hint?: string;
  /** Trailing marker, e.g. a favourite star. */
  badge?: React.ReactNode;
  /** Draw a separator above this row to set a pseudo-destination apart. */
  groupStart?: boolean;
}

export interface TreePickerListProps {
  items: readonly TreePickerItem[];
  selectedKey: string;
  onSelect: (key: string) => void;
  /** Show the filter field regardless of how many items there are. */
  alwaysFilterable?: boolean;
  filterPlaceholder?: string;
  /** Number of items above which the filter appears automatically. */
  filterThreshold?: number;
  emptyTitle?: string;
  emptyHint?: string;
  footer?: React.ReactNode;
  className?: string;
  /** Highlight rows matching the note/link currently being edited. */
  disabledKeys?: readonly string[];
}

export const TREE_FILTER_THRESHOLD = 7;

export function TreePickerList({
  items,
  selectedKey,
  onSelect,
  alwaysFilterable = false,
  filterPlaceholder = 'Find a destination',
  filterThreshold = TREE_FILTER_THRESHOLD,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  footer,
  className,
  disabledKeys,
}: TreePickerListProps) {
  const [query, setQuery] = React.useState('');
  const disabled = React.useMemo(() => new Set(disabledKeys ?? []), [disabledKeys]);

  const filtered = React.useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [...items];
    return items.filter((item) => {
      const haystack = `${item.label} ${item.path}`.toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [items, query]);

  const filterable = alwaysFilterable || items.length >= filterThreshold;

  return (
    <div className={cn('flex flex-col', className)}>
      {filterable ? (
        <div className="px-2 pt-1 pb-2">
          <div className="relative">
            <Search
              size={16}
              strokeWidth={2}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={filterPlaceholder}
              aria-label={filterPlaceholder}
              enterKeyHint="done"
              autoComplete="off"
              className={cn(
                'h-10 w-full rounded-xl border border-border bg-surface-2 pr-3 pl-9 text-row text-fg',
                'placeholder:text-subtle focus:border-accent focus:bg-surface focus:outline-none',
              )}
            />
          </div>
        </div>
      ) : null}

      <ul role="listbox" aria-label="Destination" className="flex flex-col gap-0.5 px-1">
        {filtered.map((item) => (
          <TreePickerRow
            key={item.key}
            item={item}
            selected={item.key === selectedKey}
            disabled={disabled.has(item.key)}
            onSelect={() => onSelect(item.key)}
          />
        ))}

        {filtered.length === 0 ? (
          <li className="flex flex-col items-center gap-1 px-4 py-6 text-center">
            <p className="text-body text-muted">{items.length === 0 ? emptyTitle : 'Nothing matches that'}</p>
            {emptyHint ? <p className="text-meta text-subtle">{emptyHint}</p> : null}
          </li>
        ) : null}
      </ul>

      {footer ? <div className="pt-1">{footer}</div> : null}
    </div>
  );
}

function TreePickerRow({
  item,
  selected,
  disabled,
  onSelect,
}: {
  item: TreePickerItem;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const indent = Math.min(item.depth, 5) * 14;
  // Depth beyond the indent cap is expressed as a path prefix so a deep tree
  // never runs out of horizontal room on a phone.
  const showPath = item.depth > 0 && item.path.length > 0;

  return (
    <li className={cn(item.groupStart && 'mt-1.5 border-t border-border pt-1.5')}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          'tap flex w-full items-center gap-3 rounded-xl py-2.5 pr-3 text-left',
          selected ? 'bg-accent-soft' : 'active:bg-surface-2',
          disabled && 'opacity-40',
        )}
        style={{ paddingLeft: 12 + indent }}
      >
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            selected ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted',
          )}
        >
          {item.icon ?? (
            <span className="text-meta font-semibold">{item.label.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-row leading-tight',
              selected ? 'font-semibold text-accent' : 'font-medium text-fg',
            )}
          >
            {item.label}
          </span>
          {item.hint ? (
            <span className="mt-0.5 block truncate text-meta text-subtle">{item.hint}</span>
          ) : showPath ? (
            <span className="mt-0.5 block truncate text-meta text-subtle">{item.path}</span>
          ) : null}
        </span>
        {item.badge}
        {selected ? <Check size={17} strokeWidth={2.4} className="shrink-0 text-accent" aria-hidden /> : null}
      </button>
    </li>
  );
}
