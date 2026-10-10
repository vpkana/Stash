import { domainOf } from '@/lib/url/extract';
import { normalizeUrl } from '@/lib/url/normalize';
import { descendantIdsOf, folderPathLabel } from '@/lib/tree';
import { newId } from '../id';
import { db, type SavedLink } from '../index';
import { isFolderProtected } from '@/lib/privacy/context';
import { getVaultKey } from '@/lib/privacy/keyring';
import { isSealed, openLink, sealLink } from '@/lib/privacy/protection';
import { reconcileProtection } from '@/lib/privacy/reconcile';

/**
 * Link persistence.
 *
 * Note on `folderId === null`: IndexedDB cannot index `null`, so "Inbox" rows
 * are fetched with a filter rather than an index lookup. That is handled once
 * here so callers never have to know.
 */

export interface CreateLinkInput {
  url: string;
  folderId: string | null;
  title?: string;
  description?: string;
  userNote?: string;
  source?: string;
  sourcePackage?: string;
  rawText?: string;
  isFavorite?: boolean;
}

export function buildLinkRecord(input: CreateLinkInput): SavedLink {
  const now = Date.now();
  const normalized = normalizeUrl(input.url) ?? input.url.trim();
  const record: SavedLink = {
    id: newId(),
    folderId: input.folderId,
    url: input.url.trim(),
    normalizedUrl: normalized,
    createdAt: now,
    updatedAt: now,
    isFavorite: input.isFavorite ?? false,
    isArchived: false,
    isLocked: false,
  };
  if (input.title?.trim()) record.title = input.title.trim();
  if (input.description?.trim()) record.description = input.description.trim();
  if (input.userNote?.trim()) record.userNote = input.userNote.trim();
  const source = input.source?.trim() || domainOf(input.url);
  if (source) record.source = source;
  if (input.sourcePackage) record.sourcePackage = input.sourcePackage;
  if (input.rawText?.trim()) record.rawText = input.rawText.trim();
  return record;
}

export async function createLink(input: CreateLinkInput): Promise<SavedLink> {
  const record = buildLinkRecord(input);

  // Saving straight into a locked folder never writes the address in the clear:
  // the row is sealed before it is inserted, so there is no window in which the
  // URL exists plaintext on disk. The plaintext record is still what is returned,
  // because the caller is by definition unlocked at this point.
  if (await isFolderProtected(record.folderId)) {
    await db.links.add(await sealLink(record, getVaultKey()));
    return record;
  }

  await db.links.add(record);
  return record;
}

/**
 * Every link in a folder, newest first. `null` means the Inbox.
 *
 * There is no "include archived" switch any more, and its absence is the point:
 * a caller should not be able to ask for a list that leaves a saved link out
 * because of a flag the user cannot see or clear. Deleted rows are excluded, but
 * they are excluded by the snapshot, not here.
 */
export async function listLinksInFolder(
  folderId: string | null,
  options: { includeNested?: boolean } = {},
): Promise<SavedLink[]> {
  const { includeNested = false } = options;

  let scope: SavedLink[];
  if (folderId === null) {
    scope = await db.links.filter((link) => link.folderId === null).toArray();
  } else if (includeNested) {
    const folders = await db.folders.toArray();
    const ids = [folderId, ...descendantIdsOf(folders, folderId)];
    scope = await db.links.where('folderId').anyOf(ids).toArray();
  } else {
    scope = await db.links.where('folderId').equals(folderId).toArray();
  }

  return scope.sort((a, b) => b.createdAt - a.createdAt);
}

export async function listAllLinks(): Promise<SavedLink[]> {
  return db.links.toArray();
}

export async function listActiveLinks(): Promise<SavedLink[]> {
  return db.links.toArray();
}

/** IndexedDB cannot index booleans, so favorites are a filter, not a lookup. */
export async function listFavoriteLinks(): Promise<SavedLink[]> {
  const links = await db.links.toArray();
  return links.filter((link) => link.isFavorite).sort((a, b) => b.createdAt - a.createdAt);
}

export async function listRecentLinks(limit = 8): Promise<SavedLink[]> {
  const links = await db.links.toArray();
  return links.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function getLink(id: string): Promise<SavedLink | undefined> {
  return db.links.get(id);
}

export interface DuplicateMatch {
  link: SavedLink;
  /** `Development → React`, or `Inbox`. */
  folderPath: string;
  /** True when the normalized forms match exactly rather than merely sharing a host. */
  exact: boolean;
}

/**
 * Find links that already represent the same resource.
 *
 * Only normalized equality counts as a duplicate. Anything weaker would
 * produce false alarms, and a false "already saved" is worse than a rare
 * duplicate link.
 */
export async function findDuplicates(url: string, options: { excludeId?: string } = {}): Promise<DuplicateMatch[]> {
  const normalized = normalizeUrl(url) ?? url.trim();
  const [candidates, folders] = await Promise.all([
    db.links.where('normalizedUrl').equals(normalized).toArray(),
    db.folders.toArray(),
  ]);

  return candidates
    .filter((link) => link.id !== options.excludeId)
    .map((link) => ({
      link,
      folderPath: link.folderId ? folderPathLabel(folders, link.folderId) : 'Inbox',
      exact: true,
    }))
    .sort((a, b) => b.link.createdAt - a.link.createdAt);
}

export interface UpdateLinkInput {
  title?: string;
  description?: string;
  userNote?: string;
  folderId?: string | null;
}

export async function updateLink(id: string, patch: UpdateLinkInput): Promise<SavedLink | null> {
  // Not a Dexie transaction: WebCrypto resolves outside Dexie's zone, which ends
  // the transaction and drops the write. See the note in `folders.ts`.
  const raw = await db.links.get(id);
  if (!raw) return null;
  // Edit the plaintext view, then put it back the way it was found: a sealed
  // link stays sealed, so an edit cannot leave a locked address in the clear.
  const link = await openLink(raw, getVaultKey());
  const updated = applyLinkPatch(link, patch);
  await db.links.put(isSealed(raw) ? await sealLink(updated, getVaultKey()) : updated);
  return updated;
}

/** Apply an edit to the plaintext view of a link. */
function applyLinkPatch(link: SavedLink, patch: UpdateLinkInput): SavedLink {
  const updated: SavedLink = { ...link, updatedAt: Date.now() };
  if (patch.title !== undefined) {
    if (patch.title.trim()) updated.title = patch.title.trim();
    else delete updated.title;
  }
  if (patch.description !== undefined) {
    if (patch.description.trim()) updated.description = patch.description.trim();
    else delete updated.description;
  }
  if (patch.userNote !== undefined) {
    if (patch.userNote.trim()) updated.userNote = patch.userNote.trim();
    else delete updated.userNote;
  }
  if (patch.folderId !== undefined) updated.folderId = patch.folderId;
  return updated;
}

/**
 * Move a link to another folder.
 *
 * The move itself is a partial update, which preserves the sealed form, but it
 * can cross a lock boundary in either direction — into a locked folder the link
 * must be sealed, out of one it must be opened again — so sealing is re-derived
 * afterwards.
 */
export async function moveLink(id: string, folderId: string | null): Promise<void> {
  await db.links.update(id, { folderId, updatedAt: Date.now() });
  await reconcileProtection();
}

export async function setLinkFavorite(id: string, isFavorite: boolean): Promise<void> {
  await db.links.update(id, { isFavorite, updatedAt: Date.now() });
}

/**
 * Legacy field write. **Nothing in the app calls this any more.**
 *
 * Archiving used to hide a link from every screen the user had, which made it
 * indistinguishable from losing it. The UI is gone and version 6 of the database
 * restored every archived row, so there is no longer a state to set.
 *
 * It is kept only because the field still exists on the row — a backup written by
 * an older build carries it and has to import cleanly, and a test needs to be
 * able to *create* the state this app had to migrate away from. Do not call it
 * from a component or a store: if a future feature needs to hide a link, it needs
 * a way back that is not a filter chip on another screen.
 */
export async function setLinkArchived(id: string, isArchived: boolean): Promise<void> {
  await db.links.update(id, { isArchived, updatedAt: Date.now() });
}

export async function touchLinkOpened(id: string): Promise<void> {
  await db.links.update(id, { lastOpenedAt: Date.now() });
}

/** Lock or unlock one saved link. Sealing follows from the flag. */
export async function setLinkLocked(id: string, isLocked: boolean): Promise<void> {
  await db.links.update(id, { isLocked, updatedAt: Date.now() });
  await reconcileProtection();
}

/**
 * Record that the address no longer works, or that it does again.
 *
 * Set only by the user. Stash has no background checker and should not have one:
 * it cannot open a page on the user's behalf, it would need the network that the
 * rest of the app is proud not to need, and a periodic scan of someone's saved
 * links is a privacy cost paid for a guess. What the app *can* do is make it easy
 * to note the truth once, and then find the link again — which is what this does.
 *
 * The address itself is untouched either way. `url` is the record of what you
 * meant to keep; a dead page does not change that.
 */
export async function setLinkUnavailable(id: string, isUnavailable: boolean): Promise<void> {
  const now = Date.now();
  if (isUnavailable) {
    await db.links.update(id, { isUnavailable: true, unavailableAt: now, updatedAt: now });
    return;
  }

  // Marked working again: the timestamp is removed outright rather than set to
  // undefined, so the stored row says "never unavailable" instead of holding a
  // field that means two things.
  const row = await db.links.get(id);
  if (!row) return;
  const next: SavedLink = { ...row, isUnavailable: false, updatedAt: now };
  delete next.unavailableAt;
  await db.links.put(next);
}

/**
 * Remove a link for good, along with the references from notes.
 *
 * Notes that referenced it are not touched — they simply stop referencing it.
 * Deleting a link must never delete the thinking that pointed at it.
 *
 * Named for what it is because the ordinary delete is a move to the trash
 * (`trashLink`), and the two are not interchangeable. The only caller is the
 * undo on a link the user just saved: discarding something created seconds ago is
 * not the same act as changing your mind about something you kept, and sending it
 * to the trash would litter a recovery surface with rows nobody meant to keep.
 */
export async function deleteLinkPermanently(id: string): Promise<void> {
  await db.transaction('rw', db.links, db.noteLinks, async () => {
    await db.noteLinks.where('linkId').equals(id).delete();
    await db.links.delete(id);
  });
}

export async function countActiveLinks(): Promise<number> {
  return db.links.count();
}

/**
 * A conservative same-site hint used only when a normalized match failed.
 * Surfaced as a soft "similar link already saved" notice, never as a block.
 */
export async function findSameHostMatches(url: string, limit = 3): Promise<SavedLink[]> {
  const host = domainOf(url);
  if (!host) return [];
  const links = await db.links.toArray();
  return links
    .filter((link) => link.source === host)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
