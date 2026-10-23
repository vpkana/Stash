import { db } from '@/db';
import type { Folder, LinkTag, Note, NoteLink, SavedLink, Tag } from '@/db/types';
import type { SyncConflictRow } from '@/db/sync-types';
import { baseRow } from './sync';
import { splitCompositeId, type SyncEntry } from '@/lib/sync/protocol';
import { reconcileProtection } from '@/lib/privacy/reconcile';

/**
 * Resolving a conflict is a local decision, not a remote one.
 *
 * The conflict record holds both versions as they were at merge time; the person
 * picks one, and this writes that version into the vault. The next sync publishes
 * the result because `syncBase` is deliberately set to the *remote* version in
 * both cases:
 *
 *  - choose the remote version → vault equals base, so there is nothing to send;
 *  - choose this device's version → the difference from base is a real local
 *    change, so it is uploaded on the next sync like any other edit.
 *
 * Deleting the conflict without applying anything is also offered, and is the
 * right action for `note-copy` (both versions already exist, one as a copy) and
 * for `delete-edit` (the edit already survived by design). It never deletes
 * vault content.
 */

export type ConflictChoice = 'local' | 'remote' | 'dismiss';

export interface ResolveConflictResult {
  ok: boolean;
  message?: string;
}

export async function resolveConflict(
  id: string,
  choice: ConflictChoice,
): Promise<ResolveConflictResult> {
  let outcome: ResolveConflictResult = { ok: false, message: 'That conflict is no longer here.' };

  await db.transaction(
    'rw',
    [
      db.folders,
      db.links,
      db.notes,
      db.tags,
      db.linkTags,
      db.noteLinks,
      db.syncBase,
      db.syncConflicts,
    ],
    async () => {
      const conflict = await db.syncConflicts.get(id);
      if (!conflict) return;

      if (choice === 'dismiss') {
        await db.syncConflicts.delete(id);
        outcome = { ok: true };
        return;
      }

      const chosen = choice === 'local' ? conflict.local : conflict.remote;
      if (!chosen) {
        outcome = {
          ok: false,
          message:
            choice === 'remote'
              ? 'The other device’s version is no longer available. Dismiss this and sync again.'
              : 'This device’s version is no longer available. Dismiss this and sync again.',
        };
        return;
      }

      await applyEntry(chosen);
      const baseline = conflict.remote ?? chosen;
      await db.syncBase.put(baseRow(baseline, Date.now()));
      await db.syncConflicts.delete(id);
      outcome = { ok: true };
    },
  );

  if (outcome.ok && choice !== 'dismiss') {
    // A chosen version may move a row across a lock boundary (for example, a
    // folder pick that the losing side had chosen differently). Sealing is
    // derived, so reconciling here is what keeps the applied row honest.
    await reconcileProtection().catch(() => undefined);
  }

  return outcome;
}

async function applyEntry(entry: SyncEntry): Promise<void> {
  if (entry.deleted) {
    await deleteEntry(entry);
    return;
  }
  const row = entry.row;
  if (!row) return;

  switch (entry.kind) {
    case 'folder': {
      const current = await db.folders.get(entry.id);
      await db.folders.put({ ...current, ...(row as Folder) });
      return;
    }
    case 'link': {
      const current = await db.links.get(entry.id);
      const next = { ...(row as SavedLink) };
      if (!current) {
        next.isArchived = false;
        next.normalizedUrl = next.normalizedUrl || next.url;
      }
      await db.links.put({ ...current, ...next });
      return;
    }
    case 'note': {
      const current = await db.notes.get(entry.id);
      await db.notes.put({
        ...current,
        ...(row as Note),
        ...(current ? {} : { isArchived: false }),
      });
      return;
    }
    case 'tag':
      await db.tags.put(row as Tag);
      return;
    case 'linkTag':
      await db.linkTags.put(row as LinkTag);
      return;
    case 'noteLink':
      await db.noteLinks.put(row as NoteLink);
      return;
  }
}

async function deleteEntry(entry: SyncEntry): Promise<void> {
  switch (entry.kind) {
    case 'folder':
      await db.folders.delete(entry.id);
      return;
    case 'link':
      await db.links.delete(entry.id);
      return;
    case 'note':
      await db.notes.delete(entry.id);
      return;
    case 'tag':
      await db.tags.delete(entry.id);
      return;
    case 'linkTag':
    case 'noteLink': {
      const pair = splitCompositeId(entry.id);
      if (!pair) return;
      if (entry.kind === 'linkTag') await db.linkTags.delete(pair);
      else await db.noteLinks.delete(pair);
      return;
    }
  }
}

/**
 * A structural, content-free description of what the two versions differ in.
 *
 * The conflict record already carries the field names; nothing here reads a row
 * value, so this can be shown for a locked item without unlocking it.
 */
export function conflictSummary(conflict: SyncConflictRow): string {
  if (conflict.reason === 'note-copy') {
    return 'Both versions of this note were kept. One is on this note, the other is a separate copy.';
  }
  if (conflict.reason === 'delete-edit') {
    return 'One device deleted this item while another edited it. The edit was kept.';
  }
  if (conflict.fields && conflict.fields.length > 0) {
    return `Changed on both devices: ${conflict.fields.join(', ')}.`;
  }
  return 'Changed on both devices.';
}

/** Kept for callers that only need to know whether both sides are recoverable. */
export function conflictHasBothSides(conflict: SyncConflictRow): boolean {
  return Boolean(conflict.local && conflict.remote);
}
