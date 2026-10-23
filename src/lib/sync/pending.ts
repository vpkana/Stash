import { db } from '@/db';
import {
  canonicalFolder,
  canonicalLink,
  canonicalLinkTag,
  canonicalNote,
  canonicalNoteLink,
  canonicalTag,
  entryKey,
  rowIdentity,
  syncEntriesEqual,
  type CanonicalRow,
  type EntityKind,
  type SyncEntry,
} from './protocol';

/**
 * How much local work a sync would have to publish.
 *
 * This is deliberately derived from the vault every time rather than trusted
 * from a counter. Counters drift: a failed write, an interrupted import or an
 * older build can leave one saying zero while rows have changed. Since the only
 * consequence of being wrong here is a harmless extra sync, correctness is
 * cheaper than incremental bookkeeping.
 *
 * A row that exists on both sides with the same content is not work, even if its
 * revision string differs — revisions carry a device origin, so comparing them
 * would report every mirrored row as pending forever on a second device.
 */
export async function countPendingChanges(): Promise<number> {
  const baseRows = await db.syncBase.toArray();
  const base = new Map(baseRows.map((row) => [row.key, row.entry]));

  const kinds: Array<{ kind: EntityKind; rows: CanonicalRow[] }> = [
    { kind: 'folder', rows: (await db.folders.toArray()).map(canonicalFolder) },
    { kind: 'link', rows: (await db.links.toArray()).map(canonicalLink) },
    { kind: 'note', rows: (await db.notes.toArray()).map(canonicalNote) },
    { kind: 'tag', rows: (await db.tags.toArray()).map(canonicalTag) },
    { kind: 'linkTag', rows: (await db.linkTags.toArray()).map(canonicalLinkTag) },
    { kind: 'noteLink', rows: (await db.noteLinks.toArray()).map(canonicalNoteLink) },
  ];

  const localKeys = new Set<string>();
  let pending = 0;

  for (const { kind, rows } of kinds) {
    for (const row of rows) {
      const entry: SyncEntry = { kind, id: rowIdentity(row), rev: '', row };
      const key = entryKey(entry);
      localKeys.add(key);
      const known = base.get(key);
      if (!known || !syncEntriesEqual(known, entry)) pending += 1;
    }
  }

  // A live base row with no local counterpart is a deletion still to publish.
  // A base tombstone with no local row is not work; it is the expected state.
  for (const [key, entry] of base) {
    if (!localKeys.has(key) && entry.deleted !== true) pending += 1;
  }

  return pending;
}
