import { describe, expect, it } from 'vitest';
import type { Folder, SavedLink } from '@/db/types';
import {
  breadcrumbOf,
  canMoveFolder,
  childrenOf,
  descendantIdsOf,
  filterFlatFolders,
  flattenFolders,
  folderDeletionImpact,
  folderPathLabel,
  groupByParent,
  hasSiblingWithName,
  isDescendantOf,
  maxDepth,
  nextSortOrder,
} from '@/lib/tree';

function folder(id: string, name: string, parentId: string | null, sortOrder = 0): Folder {
  return {
    id,
    parentId,
    name,
    createdAt: 1,
    updatedAt: 1,
    sortOrder,
    isFavorite: false,
    isLocked: false,
  };
}

function link(id: string, folderId: string | null): SavedLink {
  return {
    id,
    folderId,
    url: `https://example.com/${id}`,
    normalizedUrl: `https://example.com/${id}`,
    createdAt: 1,
    updatedAt: 1,
    isFavorite: false,
    isArchived: false,
    isLocked: false,
  };
}

/**
 * The exact tree from the product brief.
 */
const TREE: Folder[] = [
  folder('prog', 'Programming', null, 0),
  folder('web', 'Web Development', 'prog', 0),
  folder('react', 'React', 'web', 0),
  folder('tut', 'Tutorials', 'react', 0),
  folder('lib', 'Libraries', 'react', 1),
  folder('backend', 'Backend', 'web', 1),
  folder('ml', 'Machine Learning', 'prog', 1),
  folder('cv', 'Computer Vision', 'ml', 0),
  folder('papers', 'Research Papers', 'ml', 1),
];

describe('tree traversal', () => {
  it('returns ordered children', () => {
    expect(childrenOf(TREE, null).map((f) => f.id)).toEqual(['prog']);
    expect(childrenOf(TREE, 'react').map((f) => f.id)).toEqual(['tut', 'lib']);
  });

  it('sorts by sortOrder then name', () => {
    const siblings = [folder('b', 'Beta', null, 0), folder('a', 'Alpha', null, 0), folder('c', 'Aardvark', null, 2)];
    expect(childrenOf(siblings, null).map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('builds a root-first breadcrumb', () => {
    expect(breadcrumbOf(TREE, 'tut').map((f) => f.name)).toEqual([
      'Programming',
      'Web Development',
      'React',
      'Tutorials',
    ]);
  });

  it('stops instead of hanging on a corrupted cycle', () => {
    const cycle: Folder[] = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    expect(breadcrumbOf(cycle, 'a').length).toBeLessThanOrEqual(2);
    expect(descendantIdsOf(cycle, 'a').length).toBeLessThanOrEqual(1);
  });

  it('finds all descendants and not the folder itself', () => {
    const ids = descendantIdsOf(TREE, 'prog');
    expect(ids).toContain('tut');
    expect(ids).toContain('papers');
    expect(ids).not.toContain('prog');
    // web, ml, react, backend, tutorials, libraries, cv, papers
    expect(ids).toHaveLength(8);
  });

  it('detects ancestry', () => {
    expect(isDescendantOf(TREE, 'tut', 'prog')).toBe(true);
    expect(isDescendantOf(TREE, 'prog', 'tut')).toBe(false);
    expect(isDescendantOf(TREE, 'prog', 'prog')).toBe(true);
  });

  it('reports the deepest level present', () => {
    expect(maxDepth(TREE)).toBe(3);
  });

  it('renders a readable path', () => {
    expect(folderPathLabel(TREE, 'papers')).toBe('Programming → Machine Learning → Research Papers');
    expect(folderPathLabel(TREE, null)).toBe('Inbox');
  });

  it('groups children in one pass', () => {
    const grouped = groupByParent(TREE);
    expect(grouped.get('react')?.map((f) => f.id)).toEqual(['tut', 'lib']);
    expect(grouped.get('ml')?.map((f) => f.id)).toEqual(['cv', 'papers']);
  });
});

describe('flattening for the capture sheet', () => {
  it('lists every folder with depth and full path', () => {
    const flat = flattenFolders(TREE);
    expect(flat).toHaveLength(9);
    const tutorials = flat.find((entry) => entry.folder.id === 'tut');
    expect(tutorials?.depth).toBe(3);
    expect(tutorials?.path).toBe('Programming → Web Development → React → Tutorials');
  });

  it('filters by name and by path', () => {
    const flat = flattenFolders(TREE);
    expect(filterFlatFolders(flat, 'tut').map((e) => e.folder.id)).toEqual(['tut']);
    expect(filterFlatFolders(flat, 'machine').map((e) => e.folder.id)).toEqual(['ml', 'cv', 'papers']);
    expect(filterFlatFolders(flat, '')).toHaveLength(9);
  });

  it('requires every token to match', () => {
    const flat = flattenFolders(TREE);
    expect(filterFlatFolders(flat, 'react libraries').map((e) => e.folder.id)).toEqual(['lib']);
  });

  it('does not loop forever on cycles', () => {
    const cycle: Folder[] = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    expect(flattenFolders(cycle).length).toBeLessThanOrEqual(2);
  });
});

describe('move safety', () => {
  it('refuses to move a folder into itself', () => {
    expect(canMoveFolder(TREE, 'prog', 'prog')).toEqual({
      ok: false,
      reason: 'A folder cannot be moved inside itself.',
    });
  });

  it('refuses to move a folder into its own descendant', () => {
    const result = canMoveFolder(TREE, 'prog', 'tut');
    expect(result.ok).toBe(false);
  });

  it('allows a legitimate re-parent', () => {
    expect(canMoveFolder(TREE, 'cv', 'web').ok).toBe(true);
    expect(canMoveFolder(TREE, 'cv', null).ok).toBe(true);
  });

  it('rejects a target that has vanished', () => {
    expect(canMoveFolder(TREE, 'cv', 'ghost').ok).toBe(false);
  });
});

describe('sibling helpers', () => {
  it('detects a duplicate name inside one parent, ignoring case', () => {
    expect(hasSiblingWithName(TREE, 'react', 'tutorials')).toBe(true);
    expect(hasSiblingWithName(TREE, 'react', 'Tutorials')).toBe(true);
    expect(hasSiblingWithName(TREE, 'react', 'Tutorials', 'tut')).toBe(false);
    expect(hasSiblingWithName(TREE, 'web', 'Tutorials')).toBe(false);
  });

  it('allocates the next ordering slot', () => {
    expect(nextSortOrder(TREE, 'react')).toBe(2);
    expect(nextSortOrder(TREE, null)).toBe(1);
  });
});

describe('delete impact', () => {
  const links = [
    link('l1', 'react'),
    link('l2', 'react'),
    link('l3', 'tut'),
    link('l4', 'papers'),
    link('l5', 'prog'),
  ];

  it('counts direct and nested links separately', () => {
    const impact = folderDeletionImpact(TREE, links, 'react');
    expect(impact?.directLinkCount).toBe(2);
    expect(impact?.descendantLinkCount).toBe(1);
    expect(impact?.descendantFolderCount).toBe(2);
    expect(impact?.childFolderCount).toBe(2);
  });

  it('records where the contents would go', () => {
    const impact = folderDeletionImpact(TREE, links, 'react');
    expect(impact?.newParentId).toBe('web');
    expect(folderDeletionImpact(TREE, links, 'prog')?.newParentId).toBeNull();
  });

  it('counts a link carrying the legacy archive flag, so a delete warning cannot understate itself', () => {
    const flagged = { ...link('l6', 'tut'), isArchived: true };
    const impact = folderDeletionImpact(TREE, [...links, flagged], 'react');
    expect(impact?.descendantLinkCount).toBe(2);
  });

  it('returns null for a folder that does not exist', () => {
    expect(folderDeletionImpact(TREE, links, 'ghost')).toBeNull();
  });
});
