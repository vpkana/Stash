import { db } from '@/db';
import { getVaultKey } from './keyring';
import { computeProtection, isSealed, openFolder, openLink, openNote, sealLink, sealNote } from './protection';

/**
 * Keep the database's sealing in step with the lock state.
 *
 * Sealing is *derived*, not bookkept. Rather than trying to remember, at every
 * mutation, which descendants a folder change affected, this function reads the
 * vault, recomputes what should be protected, and seals or opens only the rows
 * that differ. Running it twice in a row writes nothing the second time.
 *
 * That property is what makes inheritance trustworthy. Moving a link into a
 * locked folder, promoting a subnote out of a locked note, flattening a deleted
 * folder's children upward, importing a backup — all of them are handled by the
 * same reconciliation instead of by four separate, individually fallible rules.
 *
 * Which fields are sealed is documented on the codec in `protection.ts`. While
 * sealed, the plaintext simply is not in IndexedDB.
 */
export interface ReconcileReport {
  sealed: { folders: number; notes: number; links: number };
  opened: { folders: number; notes: number; links: number };
  /**
   * Rows that should be sealed but could not be, because no key was available.
   * Non-zero is a bug indicator, not a data-loss state: the rows stay readable
   * and the next reconciliation with a key will seal them.
   */
  deferred: number;
}

function emptyReport(): ReconcileReport {
  return {
    sealed: { folders: 0, notes: 0, links: 0 },
    opened: { folders: 0, notes: 0, links: 0 },
    deferred: 0,
  };
}

export async function reconcileProtection(): Promise<ReconcileReport> {
  const key = getVaultKey();

  // A whole-vault read, outside any transaction: crypto is async and holding an
  // IndexedDB transaction open across it would block every other writer.
  const [folders, notes, links] = await Promise.all([
    db.folders.toArray(),
    db.notes.toArray(),
    db.links.toArray(),
  ]);

  // Protection depends only on plaintext structural fields — ids, parents and
  // the lock flags — so it can be computed from the sealed rows as they are.
  const protection = computeProtection(folders, notes, links);
  const report = emptyReport();
  const writes: Array<Promise<unknown>> = [];

  const settle = (target: boolean, sealed: boolean, bucket: 'folders' | 'notes' | 'links') => {
    if (target === sealed) return false;
    if (!key) {
      report.deferred += 1;
      return false;
    }
    if (target) report.sealed[bucket] += 1;
    else report.opened[bucket] += 1;
    return true;
  };

  /*
   * Folders are never sealed.
   *
   * A folder name is the label on the door rather than what is behind it, and
   * only the label makes a locked folder usable: "Private" is tappable and
   * choosable, an anonymous "Locked folder" is not — least of all in the share
   * destination picker, where the user has to say *which* locked folder a link
   * is going into. Content stays sealed; a folder row does not.
   *
   * The `target` is therefore always "open", which is also the migration for a
   * vault written by an earlier build: its sealed folder rows are opened here,
   * once, the first time a key is available.
   */
  for (const folder of folders) {
    if (!settle(false, isSealed(folder), 'folders')) continue;
    writes.push(db.folders.put(await openFolder(folder, key)));
  }

  for (const note of notes) {
    const target = protection.notes.has(note.id);
    if (!settle(target, isSealed(note), 'notes')) continue;
    writes.push(db.notes.put(target ? await sealNote(note, key) : await openNote(note, key)));
  }

  for (const link of links) {
    const target = protection.links.has(link.id);
    if (!settle(target, isSealed(link), 'links')) continue;
    writes.push(db.links.put(target ? await sealLink(link, key) : await openLink(link, key)));
  }

  await Promise.all(writes);
  return report;
}

/**
 * Open every sealed row. Only used when the user turns privacy off, which cannot
 * happen without the key (the gate blocks it), so `deferred` should always be 0.
 */
export async function unsealEverything(): Promise<ReconcileReport> {
  const key = getVaultKey();
  const report = emptyReport();
  if (!key) {
    report.deferred += 1;
    return report;
  }

  const [folders, notes, links] = await Promise.all([
    db.folders.toArray(),
    db.notes.toArray(),
    db.links.toArray(),
  ]);

  const writes: Array<Promise<unknown>> = [];
  for (const folder of folders) {
    if (!isSealed(folder)) continue;
    report.opened.folders += 1;
    writes.push(db.folders.put(await openFolder(folder, key)));
  }
  for (const note of notes) {
    if (!isSealed(note)) continue;
    report.opened.notes += 1;
    writes.push(db.notes.put(await openNote(note, key)));
  }
  for (const link of links) {
    if (!isSealed(link)) continue;
    report.opened.links += 1;
    writes.push(db.links.put(await openLink(link, key)));
  }

  await Promise.all(writes);
  return report;
}

/** How many rows are currently sealed. Used by settings to describe the state. */
export async function countSealed(): Promise<{ folders: number; notes: number; links: number }> {
  const [folders, notes, links] = await Promise.all([
    db.folders.toArray(),
    db.notes.toArray(),
    db.links.toArray(),
  ]);
  return {
    folders: folders.filter(isSealed).length,
    notes: notes.filter(isSealed).length,
    links: links.filter(isSealed).length,
  };
}

/**
 * How many rows carry a lock flag — directly, not through an ancestor.
 *
 * Distinct from {@link countSealed}, and the difference is the point. Sealing is
 * *derived* from the flags on every reconciliation, so the two only disagree when
 * something has gone wrong — most importantly when the vault key is missing, in
 * which case flags exist and content is ciphertext. The rule for a device with no
 * screen lock reads both, because removing a flag it cannot stand behind is safe
 * only once the plaintext is back.
 */
export async function countLocks(): Promise<{ folders: number; notes: number; links: number }> {
  const [folders, notes, links] = await Promise.all([
    db.folders.toArray(),
    db.notes.toArray(),
    db.links.toArray(),
  ]);
  return {
    folders: folders.filter((row) => row.isLocked === true).length,
    notes: notes.filter((row) => row.isLocked === true).length,
    links: links.filter((row) => row.isLocked === true).length,
  };
}

/**
 * Clear every lock flag, reporting how many were actually cleared.
 *
 * The one caller is the policy for a device with no screen lock, and the ordering
 * it relies on is enforced there rather than here: this runs *after* the content
 * has been unsealed. Clearing a flag while its row is still ciphertext would take
 * away the only record that the row is locked and leave its content unreadable —
 * no longer protected, still unreachable, which is the worst of both.
 *
 * Unlocking is not deleted data: the row keeps its id, its place, its content and
 * its timestamps, and becomes ordinary readable content again.
 */
export async function clearEveryLock(): Promise<{ folders: number; notes: number; links: number }> {
  const [folders, notes, links] = await Promise.all([
    db.folders.toArray(),
    db.notes.toArray(),
    db.links.toArray(),
  ]);

  const counts = { folders: 0, notes: 0, links: 0 };
  const writes: Array<Promise<unknown>> = [];

  for (const folder of folders) {
    if (folder.isLocked !== true) continue;
    counts.folders += 1;
    writes.push(db.folders.put({ ...folder, isLocked: false }));
  }
  for (const note of notes) {
    if (note.isLocked !== true) continue;
    counts.notes += 1;
    writes.push(db.notes.put({ ...note, isLocked: false }));
  }
  for (const link of links) {
    if (link.isLocked !== true) continue;
    counts.links += 1;
    writes.push(db.links.put({ ...link, isLocked: false }));
  }

  await Promise.all(writes);
  return counts;
}
