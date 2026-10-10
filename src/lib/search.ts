import type { Folder, LinkTag, Note, NoteLink, SavedLink, Tag } from '@/db/types';
import { notePlainText } from '@/lib/notes';
import { breadcrumbOf, folderPathLabel, noteBreadcrumb } from '@/lib/tree';
import { emptyHidden, hiddenIds, type HiddenIds, type Protection } from '@/lib/privacy/protection';

/**
 * Offline search across the whole vault.
 *
 * Runs entirely in memory over a snapshot of IndexedDB. A personal vault is
 * thousands of rows, not millions, so a scored scan is both simpler and more
 * accurate than an IndexedDB prefix index, and it never touches the network.
 *
 * Results are returned as separate groups rather than one merged list. A link and
 * a note are different kinds of thing, and interleaving them by score alone makes
 * the list harder to read, not easier.
 */

/**
 * The vault filters.
 *
 * Every one of these *narrows*. There used to be a sixth — `archived` — which
 * widened instead, showing rows that every other filter hid, and it was the only
 * way back to a link somebody had archived by accident. A filter that is the only
 * route to your own data is a bug in the shape of a feature, so the archive is
 * gone, the rows were restored by a migration, and a link saved once is now
 * visible under every filter that applies to it.
 */
export type SearchFilter = 'all' | 'links' | 'notes' | 'favorites' | 'recent';

export const SEARCH_FILTERS: ReadonlyArray<{ id: SearchFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'links', label: 'Links' },
  { id: 'notes', label: 'Notes' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'recent', label: 'Recent' },
];

/**
 * Coerce a filter id from a URL into one this build still has.
 *
 * `?filter=archived` was a real address — it is written into Settings, and it is
 * in the history of anyone who ever used the Archive. A saved link must land on a
 * page rather than on an unsupported value, so an unknown (or removed) id falls
 * back to `all`.
 */
export function searchFilterFrom(value: string | null | undefined): SearchFilter {
  return SEARCH_FILTERS.some((entry) => entry.id === value) ? (value as SearchFilter) : 'all';
}

export interface VaultSnapshot {
  folders: Folder[];
  links: SavedLink[];
  tags: Tag[];
  linkTags: LinkTag[];
  notes: Note[];
  noteLinks: NoteLink[];
}

export interface LinkHit {
  link: SavedLink;
  score: number;
  /** `Development → React`, or `Inbox`. */
  folderPath: string;
  tagNames: string[];
  /** Field identifiers that matched, e.g. `['title', 'note']`. */
  matched: string[];
}

export interface FolderHit {
  folder: Folder;
  score: number;
  path: string;
}

export interface NoteHit {
  note: Note;
  score: number;
  /** `Machine Learning → SVM`, or the note title when it is a root. */
  path: string;
  /** Titles of the saved links this note references. */
  resourceTitles: string[];
  matched: string[];
}

export interface SearchOutcome {
  links: LinkHit[];
  folders: FolderHit[];
  notes: NoteHit[];
  /** True when strict matching found nothing and the engine relaxed to any-token. */
  relaxed: boolean;
}

const LINK_FIELD_WEIGHTS = {
  title: 3,
  tag: 2.4,
  folderPath: 2,
  domain: 1.6,
  url: 1.4,
  note: 1.2,
  description: 1.2,
  rawText: 0.4,
} as const;

const NOTE_FIELD_WEIGHTS = {
  title: 3,
  path: 2,
  /** Referenced link titles, so "the note about that video" is findable. */
  resource: 1.5,
  content: 1.4,
} as const;

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

interface FieldScore {
  score: number;
  matchedTokens: boolean[];
}

/** Score one haystack string against every query token. */
function scoreValue(haystack: string, tokens: readonly string[]): FieldScore {
  const matchedTokens = tokens.map(() => false);
  if (haystack.length === 0 || tokens.length === 0) return { score: 0, matchedTokens };

  const lower = haystack.toLowerCase();
  // Word-start offsets let a token match the beginning of any word, not just
  // the beginning of the whole string.
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);

  let score = 0;
  tokens.forEach((token, index) => {
    let best = 0;
    if (lower === token) best = 1;
    else if (lower.startsWith(token)) best = 0.85;
    else if (words.some((word) => word.startsWith(token))) best = 0.65;
    else if (lower.includes(token)) best = 0.35;

    if (best > 0) {
      matchedTokens[index] = true;
      score += best;
    }
  });

  return { score: score / tokens.length, matchedTokens };
}

interface ScoredEntry {
  score: number;
  matched: string[];
  satisfied: boolean;
}

/**
 * Score a set of weighted fields against the query.
 *
 * `requireAll` implements precise search first; the caller relaxes to
 * any-token matching only when that finds nothing at all.
 */
function scoreFields(
  fields: ReadonlyArray<{ id: string; value: string; weight: number }>,
  tokens: readonly string[],
  requireAll: boolean,
): ScoredEntry {
  const covered = tokens.map(() => false);
  const matched = new Set<string>();
  let total = 0;

  for (const field of fields) {
    const { score, matchedTokens } = scoreValue(field.value, tokens);
    if (score === 0) continue;
    total += score * field.weight;
    matched.add(field.id);
    matchedTokens.forEach((didMatch, index) => {
      if (didMatch) covered[index] = true;
    });
  }

  const hits = covered.filter(Boolean).length;
  if (hits === 0) return { score: 0, matched: [], satisfied: false };
  const satisfied = hits >= tokens.length;

  // Partial matches still rank, but below anything that satisfied every token.
  const coverage = hits / tokens.length;
  return { score: total * (requireAll ? 1 : coverage), matched: [...matched], satisfied };
}

interface PreparedLink {
  link: SavedLink;
  fields: Array<{ id: string; value: string; weight: number }>;
  folderPath: string;
  tagNames: string[];
}

interface PreparedNote {
  note: Note;
  fields: Array<{ id: string; value: string; weight: number }>;
  path: string;
  resourceTitles: string[];
}

function prepareLinks(snapshot: VaultSnapshot, pathCache: Map<string | null, string>): PreparedLink[] {
  const tagsById = new Map(snapshot.tags.map((tag) => [tag.id, tag.name]));
  const tagNamesByLink = new Map<string, string[]>();
  for (const linkTag of snapshot.linkTags) {
    const name = tagsById.get(linkTag.tagId);
    if (!name) continue;
    const bucket = tagNamesByLink.get(linkTag.linkId);
    if (bucket) bucket.push(name);
    else tagNamesByLink.set(linkTag.linkId, [name]);
  }

  const pathOf = (folderId: string | null): string => {
    const cached = pathCache.get(folderId);
    if (cached !== undefined) return cached;
    const label = folderPathLabel(snapshot.folders, folderId);
    pathCache.set(folderId, label);
    return label;
  };

  return snapshot.links.map((link) => {
    const tagNames = tagNamesByLink.get(link.id) ?? [];
    const folderPath = pathOf(link.folderId);
    const fields: Array<{ id: string; value: string; weight: number }> = [];
    if (link.title) fields.push({ id: 'title', value: link.title, weight: LINK_FIELD_WEIGHTS.title });
    if (link.source) fields.push({ id: 'domain', value: link.source, weight: LINK_FIELD_WEIGHTS.domain });
    fields.push({ id: 'url', value: link.url, weight: LINK_FIELD_WEIGHTS.url });
    if (link.userNote) fields.push({ id: 'note', value: link.userNote, weight: LINK_FIELD_WEIGHTS.note });
    if (link.description) {
      fields.push({ id: 'description', value: link.description, weight: LINK_FIELD_WEIGHTS.description });
    }
    for (const tagName of tagNames) {
      fields.push({ id: 'tag', value: tagName, weight: LINK_FIELD_WEIGHTS.tag });
    }
    fields.push({ id: 'folderPath', value: folderPath, weight: LINK_FIELD_WEIGHTS.folderPath });
    if (link.rawText) fields.push({ id: 'rawText', value: link.rawText, weight: LINK_FIELD_WEIGHTS.rawText });

    return { link, fields, folderPath, tagNames };
  });
}

function prepareNotes(snapshot: VaultSnapshot): PreparedNote[] {
  const linkTitles = new Map(snapshot.links.map((link) => [link.id, link.title?.trim() ?? '']));
  const titlesByNote = new Map<string, string[]>();
  for (const row of snapshot.noteLinks) {
    const title = linkTitles.get(row.linkId);
    if (!title) continue;
    const bucket = titlesByNote.get(row.noteId);
    if (bucket) bucket.push(title);
    else titlesByNote.set(row.noteId, [title]);
  }

  const notePathCache = new Map<string, string>();
  const pathOf = (note: Note): string => {
    const cached = notePathCache.get(note.id);
    if (cached !== undefined) return cached;
    const chain = noteBreadcrumb(snapshot.notes, note.id);
    const label = chain.length > 0 ? chain.map((entry) => entry.title).join(' → ') : note.title;
    notePathCache.set(note.id, label);
    return label;
  };

  return snapshot.notes.map((note) => {
    const path = pathOf(note);
    const resourceTitles = titlesByNote.get(note.id) ?? [];
    const fields: Array<{ id: string; value: string; weight: number }> = [
      { id: 'title', value: note.title, weight: NOTE_FIELD_WEIGHTS.title },
      { id: 'path', value: path, weight: NOTE_FIELD_WEIGHTS.path },
    ];
    const body = notePlainText(note.content, 4000);
    if (body.length > 0) fields.push({ id: 'content', value: body, weight: NOTE_FIELD_WEIGHTS.content });
    for (const title of resourceTitles) {
      fields.push({ id: 'resource', value: title, weight: NOTE_FIELD_WEIGHTS.resource });
    }
    return { note, fields, path, resourceTitles };
  });
}

/**
 * A link is "annotated" when the user wrote something on it. Kept exported
 * because list rows use it to decide whether to show a note marker.
 */
export function linkHasNote(link: SavedLink): boolean {
  return Boolean((link.userNote && link.userNote.trim()) || (link.description && link.description.trim()));
}

function passesLinkFilter(link: SavedLink, filter: SearchFilter, hidden: HiddenIds): boolean {
  // The lock check comes first and is absolute: a locked link is not a search
  // result under any filter, including an empty query, a favourites filter or a
  // recency listing. There is no filter combination that reveals it.
  if (hidden.links.has(link.id)) return false;
  switch (filter) {
    case 'favorites':
      return link.isFavorite;
    case 'notes':
      // The Notes filter means notes, so links step aside.
      return false;
    case 'links':
    case 'recent':
    case 'all':
    default:
      return true;
  }
}

function passesNoteFilter(note: Note, filter: SearchFilter, hidden: HiddenIds): boolean {
  // A locked note contributes neither its title nor its path nor its body to
  // search. `prepareNotes` never even reaches it.
  if (hidden.notes.has(note.id)) return false;
  switch (filter) {
    case 'favorites':
      return note.isFavorite;
    case 'links':
      // The Links filter means links.
      return false;
    case 'notes':
    case 'recent':
    case 'all':
    default:
      return true;
  }
}

export interface SearchOptions {
  query: string;
  filter?: SearchFilter;
  limit?: number;
  /** Result caps for the secondary groups. */
  folderLimit?: number;
  noteLimit?: number;
  includeFolders?: boolean;
  /**
   * Ids this session must not reveal. Pass `hiddenIds(protection, granted)`.
   *
   * Defaults to nothing hidden, which is only correct for a vault with no locks
   * at all. The search *screen* always passes the published set from the vault
   * store, so the default exists for pure unit tests and for a caller that has no
   * privacy context yet — never as a fallback that quietly disables the lock.
   */
  hidden?: HiddenIds;
}

export function searchVault(snapshot: VaultSnapshot, options: SearchOptions): SearchOutcome {
  const {
    query,
    filter = 'all',
    limit = 100,
    folderLimit = 20,
    noteLimit = 60,
    includeFolders = true,
    hidden = emptyHidden(),
  } = options;
  const tokens = tokenize(query);
  const pathCache = new Map<string | null, string>();
  const preparedNotes = prepareNotes(snapshot);

  // ---- Empty query: behave as a browsable, recency-ordered listing ----------
  if (tokens.length === 0) {
    const links = snapshot.links
      .filter((link) => passesLinkFilter(link, filter, hidden))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((link) => ({
        link,
        score: 0,
        folderPath: pathCache.get(link.folderId) ?? folderPathLabel(snapshot.folders, link.folderId),
        tagNames: [] as string[],
        matched: [] as string[],
      }));

    const notes = preparedNotes
      .filter((entry) => passesNoteFilter(entry.note, filter, hidden))
      .sort((a, b) => b.note.updatedAt - a.note.updatedAt)
      .slice(0, noteLimit)
      .map((entry) => ({
        note: entry.note,
        score: 0,
        path: entry.path,
        resourceTitles: entry.resourceTitles,
        matched: [] as string[],
      }));

    // Favorites narrows folders to the starred ones, which is what makes "all my
    // favorites" one list.
    const folders =
      includeFolders
        ? snapshot.folders
            .filter((folder) => !hidden.folders.has(folder.id))
            .filter((folder) => (filter === 'favorites' ? folder.isFavorite : true))
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, folderLimit)
            .map((folder) => ({ folder, score: 0, path: folderPathLabel(snapshot.folders, folder.id) }))
        : [];

    return { links, folders, notes, relaxed: false };
  }

  // ---- Query: scored scan, strict first then relaxed ------------------------
  const preparedLinks = prepareLinks(snapshot, pathCache);

  const scoreAll = (requireAll: boolean) => {
    const links: LinkHit[] = [];
    for (const entry of preparedLinks) {
      if (!passesLinkFilter(entry.link, filter, hidden)) continue;
      const scored = scoreFields(entry.fields, tokens, requireAll);
      if (scored.score === 0) continue;
      if (requireAll && !scored.satisfied) continue;
      links.push({
        link: entry.link,
        score: scored.score,
        folderPath: entry.folderPath,
        tagNames: entry.tagNames,
        matched: scored.matched,
      });
    }

    const notes: NoteHit[] = [];
    for (const entry of preparedNotes) {
      if (!passesNoteFilter(entry.note, filter, hidden)) continue;
      const scored = scoreFields(entry.fields, tokens, requireAll);
      if (scored.score === 0) continue;
      if (requireAll && !scored.satisfied) continue;
      notes.push({
        note: entry.note,
        score: scored.score,
        path: entry.path,
        resourceTitles: entry.resourceTitles,
        matched: scored.matched,
      });
    }

    const folders: FolderHit[] = [];
    if (includeFolders) {
      for (const folder of snapshot.folders) {
        if (hidden.folders.has(folder.id)) continue;
        if (filter === 'favorites' && !folder.isFavorite) continue;
        const path = pathCache.get(folder.id) ?? folderPathLabel(snapshot.folders, folder.id);
        const entry = {
          folder,
          fields: [
            { id: 'name', value: folder.name, weight: 3 },
            { id: 'path', value: path, weight: 1.2 },
          ],
        };
        const scored = scoreFields(entry.fields, tokens, requireAll);
        if (scored.score === 0 || (requireAll && !scored.satisfied)) continue;
        folders.push({ folder, score: scored.score, path });
      }
    }

    return { links, folders, notes };
  };

  let relaxed = false;
  let result = scoreAll(true);
  if (result.links.length === 0 && result.folders.length === 0 && result.notes.length === 0 && tokens.length > 1) {
    result = scoreAll(false);
    relaxed = true;
  }

  const sortByScoreThen = <T extends { score: number }>(items: T[], tieBreak: (item: T) => number) =>
    items.sort((a, b) => (b.score !== a.score ? b.score - a.score : tieBreak(b) - tieBreak(a)));

  if (filter === 'recent') {
    result.links.sort((a, b) => b.link.createdAt - a.link.createdAt);
    result.notes.sort((a, b) => b.note.updatedAt - a.note.updatedAt);
  } else {
    sortByScoreThen(result.links, (hit) => hit.link.createdAt);
    sortByScoreThen(result.notes, (hit) => hit.note.updatedAt);
  }
  sortByScoreThen(result.folders, (hit) => hit.folder.updatedAt);

  return {
    links: result.links.slice(0, limit),
    folders: result.folders.slice(0, folderLimit),
    notes: result.notes.slice(0, noteLimit),
    relaxed,
  };
}

/** Whether a folder is one of the folder's own ancestors (used for highlighting). */
export function folderChainLabels(folders: readonly Folder[], folderId: string | null): string[] {
  if (!folderId) return [];
  return breadcrumbOf(folders, folderId).map((folder) => folder.name);
}

/** Convenience re-export so callers of `searchVault` need one import, not two. */
export { hiddenIds };
export type { HiddenIds, Protection };
