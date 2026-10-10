import Dexie, { type Table } from 'dexie';
import { normalizeUrl } from '@/lib/url/normalize';
import {
  META_KEYS,
  type Folder,
  type LinkTag,
  type MetaRow,
  type Note,
  type NoteLink,
  type SavedLink,
  type SecurityRow,
  type Tag,
} from './types';

export * from './types';

/**
 * The single source of truth for user data.
 *
 * Guarantees that matter for the product:
 *  - Data lives in IndexedDB, which survives app close, force stop, restart,
 *    offline use and a normal Android app update.
 *  - The schema is versioned. Upgrades run explicit migrations, and nothing in
 *    the boot path ever drops a table, so an update can never silently wipe a
 *    vault.
 *  - Only the user's explicit "Erase vault" action (or clearing app data /
 *    uninstalling) removes data.
 */
class StashDatabase extends Dexie {
  folders!: Table<Folder, string>;
  links!: Table<SavedLink, string>;
  tags!: Table<Tag, string>;
  linkTags!: Table<LinkTag, [string, string]>;
  notes!: Table<Note, string>;
  noteLinks!: Table<NoteLink, [string, string]>;
  meta!: Table<MetaRow, string>;
  /**
   * Wrapping material and security bookkeeping.
   *
   * Its own table so that "is this exported, imported, snapshotted or searched?"
   * has a structural answer — no — rather than depending on every future listing
   * path remembering to exclude a key from `meta`.
   */
  security!: Table<SecurityRow, string>;

  constructor(name = 'stash') {
    super(name);

    // ---- Version 1: initial vault -------------------------------------------------
    // Only indexable values appear here. IndexedDB keys may be numbers, strings,
    // dates, binaries or arrays -- booleans are skipped silently, so flag-based
    // lookups (`isFavorite`) are done with filters rather than fake indexes.
    this.version(1).stores({
      folders: 'id, parentId, name, sortOrder, updatedAt',
      links: 'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt',
      tags: 'id, &name',
      linkTags: '[linkId+tagId], linkId, tagId',
      meta: 'key',
    });

    // ---- Version 2: index tuning + defensive backfill ------------------------------
    // Adds the compound indexes the hot paths actually use: ordering a folder's
    // children, and listing a folder newest-first. Also backfills `normalizedUrl`
    // for rows written before normalization existed. Additive only -- no drop,
    // no re-create, no data loss.
    this.version(2)
      .stores({
        folders: 'id, parentId, name, sortOrder, updatedAt, [parentId+sortOrder]',
        links:
          'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt, [folderId+createdAt]',
        tags: 'id, &name',
        linkTags: '[linkId+tagId], linkId, tagId',
        meta: 'key',
      })
      .upgrade(async (transaction) => {
        const links = transaction.table<SavedLink, string>('links');
        await links.toCollection().modify((link) => {
          if (!link.normalizedUrl) {
            link.normalizedUrl = normalizeUrl(link.url) ?? link.url;
          }
          if (typeof link.isArchived !== 'boolean') link.isArchived = false;
          if (typeof link.isFavorite !== 'boolean') link.isFavorite = false;
        });
        await transaction.table<MetaRow, string>('meta').put({
          key: META_KEYS.schemaInfo,
          value: { version: 2, migratedAt: Date.now() },
        });
      });

    // ---- Version 3: hierarchical notes ---------------------------------------------
    // Purely additive. Two new tables appear and not a single existing row is
    // read, rewritten, or deleted, so installing this over an existing vault
    // cannot cost the user a link or a folder.
    this.version(3)
      .stores({
        folders: 'id, parentId, name, sortOrder, updatedAt, [parentId+sortOrder]',
        links:
          'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt, [folderId+createdAt]',
        tags: 'id, &name',
        linkTags: '[linkId+tagId], linkId, tagId',
        notes: 'id, parentNoteId, title, sortOrder, createdAt, updatedAt, [parentNoteId+sortOrder]',
        // Compound keys are the primary key here: a note references a link at
        // most once, and both directions of the relationship stay indexed.
        noteLinks: '[noteId+linkId], noteId, linkId, createdAt',
        meta: 'key',
      })
      .upgrade(async (transaction) => {
        // Defensive backfill for rows written by an early build of the note
        // editor. Touches nothing if the tables are empty, which is the normal
        // case when upgrading from a links-only vault.
        const notes = transaction.table<Note, string>('notes');
        await notes.toCollection().modify((note) => {
          if (typeof note.content !== 'string') note.content = '';
          if (typeof note.sortOrder !== 'number') note.sortOrder = 0;
          if (typeof note.isFavorite !== 'boolean') note.isFavorite = false;
          if (typeof note.isArchived !== 'boolean') note.isArchived = false;
          if (typeof note.isLocked !== 'boolean') note.isLocked = false;
          if (note.parentNoteId === undefined) note.parentNoteId = null;
        });
        await transaction.table<MetaRow, string>('meta').put({
          key: META_KEYS.schemaInfo,
          value: { version: 3, migratedAt: Date.now() },
        });
      });

    // ---- Version 4: privacy and locking ------------------------------------------
    // Additive again: one new table for key material and security bookkeeping.
    // Existing rows gain an optional `enc` ciphertext field and `SavedLink` gains
    // `isLocked`, both of which are simply absent on old rows and are treated as
    // "not sealed" and "not locked". Nothing is read, rewritten or reordered
    // here, so a vault that never uses locking is byte-for-byte unaffected.
    this.version(4)
      .stores({
        folders: 'id, parentId, name, sortOrder, updatedAt, [parentId+sortOrder]',
        links:
          'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt, [folderId+createdAt]',
        tags: 'id, &name',
        linkTags: '[linkId+tagId], linkId, tagId',
        notes: 'id, parentNoteId, title, sortOrder, createdAt, updatedAt, [parentNoteId+sortOrder]',
        noteLinks: '[noteId+linkId], noteId, linkId, createdAt',
        meta: 'key',
        security: 'key',
      })
      .upgrade(async (transaction) => {
        const links = transaction.table<SavedLink, string>('links');
        await links.toCollection().modify((link) => {
          if (typeof link.isLocked !== 'boolean') link.isLocked = false;
        });
        await transaction.table<MetaRow, string>('meta').put({
          key: META_KEYS.schemaInfo,
          value: { version: 4, migratedAt: Date.now() },
        });
      });

    // ---- Version 5: trash, and link health ----------------------------------
    // Additive again, and the smallest kind of schema change there is: an index
    // on `deletedAt` so the trash screen reads only thrown-away rows instead of
    // scanning the whole vault to find them. No row is read, rewritten or
    // reordered, and no field is required — a row without `deletedAt` is a live
    // row, which is exactly what every existing row is.
    //
    // The index is what makes `where('deletedAt').above(0)` a real query rather
    // than a filter. It also cannot lie: IndexedDB omits rows whose indexed key
    // is absent, so a live row can never turn up in a trash lookup.
    this.version(5)
      .stores({
        folders:
          'id, parentId, name, sortOrder, updatedAt, deletedAt, [parentId+sortOrder]',
        links:
          'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt, deletedAt, [folderId+createdAt]',
        tags: 'id, &name',
        linkTags: '[linkId+tagId], linkId, tagId',
        notes:
          'id, parentNoteId, title, sortOrder, createdAt, updatedAt, deletedAt, [parentNoteId+sortOrder]',
        noteLinks: '[noteId+linkId], noteId, linkId, createdAt',
        meta: 'key',
        security: 'key',
      })
      .upgrade(async (transaction) => {
        await transaction.table<MetaRow, string>('meta').put({
          key: META_KEYS.schemaInfo,
          value: { version: 5, migratedAt: Date.now() },
        });
      });

    // ---- Version 6: the archive goes away ----------------------------------------
    // Archiving was a trap, and this version undoes it.
    //
    // The old feature set a boolean on a link or note and, from that moment on,
    // every surface the user had — Home, the Library, the Inbox, a folder, the
    // default Search filter — filtered the row out. The only way back was one
    // filter chip, which is not where somebody who has just lost a link looks.
    // Nothing was ever deleted, which is why this is recoverable at all: the rows
    // are all still here, with their ids, folders, notes and timestamps.
    //
    // So the migration *restores* them. Every row that was archived is archived
    // no longer, and the app no longer reads the field anywhere. It is kept on the
    // type and in backups because a file written by an older build carries it and
    // must still import cleanly; it is simply not a state the app can enter again.
    //
    // This reads and rewrites flags only. No row is added, deleted, re-keyed or
    // re-homed, no index changes, and a row that was never archived is not touched
    // at all — so the worst case for a vault that never used the feature is a
    // handful of no-op writes.
    this.version(6)
      .stores({
        folders:
          'id, parentId, name, sortOrder, updatedAt, deletedAt, [parentId+sortOrder]',
        links:
          'id, folderId, normalizedUrl, createdAt, updatedAt, lastOpenedAt, deletedAt, [folderId+createdAt]',
        tags: 'id, &name',
        linkTags: '[linkId+tagId], linkId, tagId',
        notes:
          'id, parentNoteId, title, sortOrder, createdAt, updatedAt, deletedAt, [parentNoteId+sortOrder]',
        noteLinks: '[noteId+linkId], noteId, linkId, createdAt',
        meta: 'key',
        security: 'key',
      })
      .upgrade(async (transaction) => {
        let linksRestored = 0;
        let notesRestored = 0;

        await transaction
          .table<SavedLink, string>('links')
          .toCollection()
          .modify((link) => {
            if (link.isArchived === true) {
              link.isArchived = false;
              linksRestored += 1;
            }
          });

        await transaction
          .table<Note, string>('notes')
          .toCollection()
          .modify((note) => {
            if (note.isArchived === true) {
              note.isArchived = false;
              notesRestored += 1;
            }
          });

        await transaction.table<MetaRow, string>('meta').put({
          key: META_KEYS.schemaInfo,
          value: {
            version: 6,
            migratedAt: Date.now(),
            // Recorded so the recovery is auditable after the fact: how many
            // links and notes this upgrade brought back into view.
            restoredFromArchive: { links: linksRestored, notes: notesRestored },
          },
        });
      });

    // A newer build (or another tab) upgraded the schema: close so the other
    // context can proceed instead of us writing through a stale schema.
    this.on('versionchange', () => {
      this.close();
    });
  }
}

export const db = new StashDatabase();

/**
 * Opens the database and applies pending migrations. Called once during boot.
 * Resolves to `true` when the vault is reachable.
 */
export async function openDatabase(): Promise<boolean> {
  try {
    await db.open();
    return true;
  } catch (error) {
    console.error('[stash] failed to open IndexedDB', error);
    return false;
  }
}

export function isDatabaseOpen(): boolean {
  return db.isOpen();
}

/** Irreversible: only ever called from the explicit "Erase vault" action. */
export async function eraseDatabase(): Promise<void> {
  db.close();
  await Dexie.delete(db.name);
  await db.open();
}

export { StashDatabase };
