'use client';

import * as React from 'react';
import { Inbox, Lock, Star } from '@/components/ui/icons';
import type { Folder } from '@/db/types';
import { flattenFolders } from '@/lib/tree';
import {
  FAVORITES_DESTINATION,
  INBOX_DESTINATION,
  destinationKey,
  folderDestination,
  type DestinationSelection,
} from '@/lib/destination';
import { Icon, isIconName } from '@/components/ui/icon';
import { TreePickerList, type TreePickerItem } from '@/components/ui/tree-picker';

/**
 * Where a captured link can go.
 *
 * Every folder is reachable in one tap rather than by drilling down: the user is
 * mid-share and wants to get back to what they were looking at. The two
 * pseudo-destinations are not folders at all -- `Inbox` means "file it later"
 * and `Favorites` means "file it later and star it" -- so they are resolved to
 * real link fields at save time instead of inventing synthetic folders.
 */

export type { DestinationKind, DestinationSelection } from '@/lib/destination';

import { useVaultStore } from '@/stores/vault-store';

export const INBOX_SELECTION = INBOX_DESTINATION;
export const FAVORITES_SELECTION = FAVORITES_DESTINATION;

export interface FolderDestinationListProps {
  folders: readonly Folder[];
  selection: DestinationSelection;
  onSelect: (selection: DestinationSelection) => void;
  /** Offer the Inbox pseudo-destination (used when saving). */
  showInbox?: boolean;
  /** Offer the Favorites pseudo-destination (used when saving). */
  showFavorites?: boolean;
  /** Show the filter field regardless of list length. */
  alwaysFilterable?: boolean;
  filterPlaceholder?: string;
  className?: string;
  /** Rendered after the tree, e.g. the "+ Create folder" affordance. */
  footer?: React.ReactNode;
}

export function FolderDestinationList({
  folders,
  selection,
  onSelect,
  showInbox = true,
  showFavorites = false,
  alwaysFilterable = false,
  filterPlaceholder = 'Find a folder',
  className,
  footer,
}: FolderDestinationListProps) {
  /*
   * Locked folders ARE destinations, and they are listed.
   *
   * They are labelled with a lock rather than hidden, because "file this in
   * Private" is a perfectly normal thing to want and the prompt that follows is
   * the whole point of a lock. What they are not is *silently* selectable: the
   * caller asks for access before it accepts the choice, so the password is asked
   * for at the moment a protected destination is chosen and at no other time.
   */
  const hidden = useVaultStore((state) => state.hidden);
  const destinations = React.useMemo(
    () => folders.map((folder) => ({ folder, locked: hidden.folders.has(folder.id) })),
    [folders, hidden],
  );

  const items = React.useMemo<TreePickerItem[]>(() => {
    const rows: TreePickerItem[] = [];

    if (showFavorites) {
      rows.push({
        key: destinationKey(FAVORITES_DESTINATION),
        label: 'Favorites',
        path: '',
        depth: 0,
        hint: 'Saved to Inbox and starred',
        icon: <Star size={18} strokeWidth={1.9} aria-hidden />,
      });
    }
    if (showInbox) {
      rows.push({
        key: destinationKey(INBOX_DESTINATION),
        label: 'Inbox',
        path: '',
        depth: 0,
        hint: 'No folder yet',
        icon: <Inbox size={18} strokeWidth={1.9} aria-hidden />,
      });
    }

    const lockedIds = new Set(destinations.filter((entry) => entry.locked).map((entry) => entry.folder.id));
    for (const entry of flattenFolders(destinations.map((entry) => entry.folder))) {
      const locked = lockedIds.has(entry.folder.id);
      rows.push({
        key: `folder:${entry.folder.id}`,
        label: entry.folder.name,
        path: entry.path,
        depth: entry.depth,
        icon: isIconName(entry.folder.icon) ? (
          <Icon name={entry.folder.icon} size={16} strokeWidth={1.9} />
        ) : undefined,
        hint: locked ? 'Locked · asks for your unlock' : undefined,
        badge: locked ? (
          <Lock size={13} strokeWidth={2.4} className="shrink-0 text-accent" aria-label="Locked folder" />
        ) : entry.folder.isFavorite ? (
          <Star size={13} strokeWidth={2} className="shrink-0 text-warning" aria-label="Favorite folder" />
        ) : undefined,
      });
    }

    return rows;
  }, [destinations, showFavorites, showInbox]);

  const handleSelect = React.useCallback(
    (key: string) => {
      if (key === 'inbox') onSelect(INBOX_DESTINATION);
      else if (key === 'favorites') onSelect(FAVORITES_DESTINATION);
      else if (key.startsWith('folder:')) onSelect(folderDestination(key.slice('folder:'.length)));
    },
    [onSelect],
  );

  return (
    <TreePickerList
      items={items}
      selectedKey={destinationKey(selection)}
      onSelect={handleSelect}
      alwaysFilterable={alwaysFilterable}
      filterPlaceholder={filterPlaceholder}
      emptyTitle={folders.length === 0 ? 'No folders yet' : 'Nothing here yet'}
      emptyHint={folders.length === 0 ? 'Use “Create folder” below to add one.' : undefined}
      {...(footer ? { footer } : {})}
      {...(className ? { className } : {})}
    />
  );
}
