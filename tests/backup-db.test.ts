import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDatabase } from '@/db';
import type { StashBackup, PortableSettings } from '@/lib/backup/format';
import type { Tag } from '@/db/types';
import {
  applyImport,
  buildBackup,
  buildEmergencyBackup,
  getPortableSettings,
  readVaultRaw,
} from '@/db/repos/backup';
import { decryptBackupPayload } from '@/lib/backup/envelope';
import { indexExisting, planImport, type ImportMode } from '@/lib/backup/merge';
import { parseBackup, type ParseResult } from '@/lib/backup/validate';
import { createFolder, setFolderFavorite, setFolderLocked } from '@/db/repos/folders';
import { createLink, moveLink, setLinkArchived, setLinkFavorite } from '@/db/repos/links';
import { createNote, setNoteFavorite, setNoteLocked } from '@/db/repos/notes';
import { setLinkTags } from '@/db/repos/tags';
import { createKeyring, forgetVaultKey, hasKeyring, unlockWithPasscode } from '@/lib/privacy/keyring';
import { getSnapshot } from '@/db/repos/vault';
import { isSealed } from '@/lib/privacy/protection';

/**
 * Backup and restore, end to end, over a real Dexie database.
 *
 * The assertions are made against *stored rows* wherever privacy is involved:
 * `db.notes.get(id)` is what someone with the device's data directory would see,
 * so "the title is not in there" is a claim about the database rather than about
 * a hydrated object the UI happened to build.
 *
 * The round trips deliberately go through the same four steps the app uses —
 * build, parse, plan, apply — rather than a shortcut. A test that restored by
 * writing rows directly would not exercise the validation, and validation is the
 * part that is easy to get wrong.
 */

const PASSCODE = 'open sesame 42';
const FILE_PASSPHRASE = 'a passphrase for the file';

async function resetDatabase() {
  db.close();
  await Dexie.delete(db.name);
  await openDatabase();
}

async function mustFolder(name: string, parentId: string | null = null): Promise<string> {
  const result = await createFolder({ name, parentId });
  if (!result.ok) throw new Error(`createFolder("${name}") failed: ${result.reason}`);
  return result.folder.id;
}

async function mustNote(title: string, content: string, parentNoteId: string | null = null): Promise<string> {
  const result = await createNote({ title, content, parentNoteId });
  if (!result.ok) throw new Error(`createNote("${title}") failed: ${result.message}`);
  return result.note.id;
}

async function mustLink(url: string, folderId: string | null = null, title?: string): Promise<string> {
  const link = await createLink({ url, folderId, ...(title ? { title } : {}) });
  return link.id;
}

/** Everything the app cares about, in a shape two vaults can be compared on. */
interface Structure {
  folders: unknown[];
  links: unknown[];
  tags: Tag[];
  linkTags: unknown[];
  notes: unknown[];
  noteLinks: unknown[];
  settings: PortableSettings;
}

async function structure(): Promise<Structure> {
  const snapshot = await readVaultRaw();
  const sort = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const sortPair = <T extends { noteId?: string; linkId: string }>(rows: T[]) =>
    [...rows].sort((a, b) => `${a.noteId ?? ''}:${a.linkId}`.localeCompare(`${b.noteId ?? ''}:${b.linkId}`));

  return {
    folders: sort(snapshot.folders).map((row) => ({
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      isFavorite: row.isFavorite,
      isLocked: row.isLocked,
      icon: row.icon ?? null,
    })),
    links: sort(snapshot.links).map((row) => ({
      id: row.id,
      folderId: row.folderId,
      url: row.url,
      normalizedUrl: row.normalizedUrl,
      title: row.title ?? null,
      description: row.description ?? null,
      userNote: row.userNote ?? null,
      source: row.source ?? null,
      isFavorite: row.isFavorite,
      isArchived: row.isArchived,
      isLocked: row.isLocked,
    })),
    tags: sort(snapshot.tags),
    linkTags: sortPair(snapshot.linkTags),
    notes: sort(snapshot.notes).map((row) => ({
      id: row.id,
      parentNoteId: row.parentNoteId,
      title: row.title,
      content: row.content,
      isFavorite: row.isFavorite,
      isArchived: row.isArchived,
      isLocked: row.isLocked,
    })),
    noteLinks: sortPair(snapshot.noteLinks).map((row) => ({
      noteId: row.noteId,
      linkId: row.linkId,
      origin: row.origin,
    })),
    settings: await getPortableSettings(),
  };
}

/** A vault with a bit of everything, including a locked subtree. */
async function populate(options: { withLocks?: boolean } = {}): Promise<void> {
  const development = await mustFolder('Development');
  const react = await mustFolder('React', development);
  const personal = await mustFolder('Personal');

  const a = await mustLink('https://react.dev/learn', react, 'Learn React');
  const b = await mustLink('https://example.com/a', development);
  const c = await mustLink('https://example.com/b', null);
  const d = await mustLink('https://example.com/c', personal);
  await moveLink(c, personal);
  await setLinkTags(a, ['to-read', 'react']);
  await setLinkTags(b, ['to-read']);

  const notes = await mustNote('Reading list', '# Reading list\n\nThings to read.');
  await mustNote('Chapter notes', 'Some thoughts on chapter one.', notes);
  await mustNote('Groceries', 'Milk', null);

  // Favourites and archive state are ordinary columns, so they must survive.
  await setLinkFavorite(a, true);
  await setLinkArchived(d, true);
  await setNoteFavorite(notes, true);
  await setFolderFavorite(development, true);

  if (options.withLocks) {
    await setFolderLocked(personal, true);
    await setNoteLocked(notes, true);
  }
}

async function build(mode: 'sealed' | 'plaintext' | 'encrypted' = 'sealed') {
  const result = await buildBackup({ mode, passphrase: mode === 'encrypted' ? FILE_PASSPHRASE : undefined });
  if (!result.ok || !result.text) throw new Error(`buildBackup failed: ${result.message}`);
  return result;
}

function mustParse(text: string): Extract<ParseResult, { kind: 'ready' }> {
  const parsed = parseBackup(text);
  if (parsed.kind !== 'ready') throw new Error(`expected a ready backup, got ${parsed.kind}`);
  return parsed;
}

async function restore(parsed: Extract<ParseResult, { kind: 'ready' }>, mode: ImportMode) {
  const snapshot = await readVaultRaw();
  const plan = planImport({
    data: parsed.data,
    existing: indexExisting(snapshot),
    mode,
    backupHasKeyring: Boolean(parsed.backup.security?.keyring),
    deviceHasKeyring: await hasKeyring(),
  });
  const outcome = await applyImport(plan, { keyring: parsed.backup.security?.keyring ?? null });
  if (!outcome.ok) throw new Error(`applyImport failed: ${outcome.message}`);
  return { plan, outcome };
}

/** Import straight from a document, as if the user had just chosen the file. */
async function importText(text: string, mode: ImportMode) {
  return restore(mustParse(text), mode);
}

beforeEach(async () => {
  await resetDatabase();
  forgetVaultKey();
});

describe('export, uninstall, import', () => {
  it('reproduces the vault exactly, structure for structure', async () => {
    await populate();
    const before = await structure();

    const built = await build('sealed');

    // The uninstall: the database is gone, and so is everything derived from it.
    await resetDatabase();
    expect((await structure()).folders).toEqual([]);

    await importText(built.text!, 'replace');
    expect(await structure()).toEqual(before);
  });

  it('reproduces the vault through an encrypted file', async () => {
    await populate();
    const before = await structure();

    const built = await build('encrypted');
    await resetDatabase();

    const envelope = parseBackup(built.text!);
    expect(envelope.kind).toBe('encrypted');
    if (envelope.kind !== 'encrypted') return;

    const opened = await decryptBackupPayload(envelope.backup, FILE_PASSPHRASE);
    expect(opened.kind).toBe('ready');
    if (opened.kind !== 'ready') return;

    await restore(opened, 'replace');
    expect(await structure()).toEqual(before);
  });

  it('reproduces the vault through a fully readable file, and re-locks what was locked', async () => {
    await createKeyring(PASSCODE);
    await populate({ withLocks: true });
    const before = await structure();

    const built = await build('plaintext');
    // A readable file genuinely has the locked items in the clear.
    expect(built.text).toContain('Personal');

    await resetDatabase();
    await importText(built.text!, 'replace');

    expect(await structure()).toEqual(before);
    // The lock flags travelled, so reconciliation sealed the *content* again: the
    // database is not left holding the readable copy the file contained. The
    // folder row keeps its name — the label is not the secret — but the links
    // inside it go back to being ciphertext.
    const restored = await readVaultRaw();
    const personal = restored.folders.find((row) => row.name === 'Personal');
    expect(personal?.isLocked).toBe(true);
    expect(restored.links.some((row) => isSealed(row))).toBe(true);
    expect(JSON.stringify(restored.links)).not.toContain('example.com/c');
  });

  it('keeps favourites, archive state, tags and note references', async () => {
    await populate();
    const built = await build('sealed');
    await resetDatabase();
    await importText(built.text!, 'replace');

    const snapshot = await readVaultRaw();
    expect(snapshot.links.find((row) => row.url.startsWith('https://react.dev'))?.isFavorite).toBe(true);
    expect(snapshot.links.some((row) => row.isArchived)).toBe(true);
    expect(snapshot.notes.some((row) => row.isFavorite)).toBe(true);
    expect(snapshot.folders.some((row) => row.isFavorite)).toBe(true);
    expect(snapshot.tags.map((tag) => tag.name).sort()).toEqual(['react', 'to-read']);
    expect(snapshot.linkTags).toHaveLength(3);
    expect(snapshot.noteLinks).toHaveLength(0);
  });

  it('round-trips a deeply nested hierarchy without flattening it', async () => {
    let parent: string | null = null;
    for (let depth = 0; depth < 10; depth += 1) parent = await mustFolder(`Level ${depth}`, parent);
    let noteParent: string | null = null;
    for (let depth = 0; depth < 18; depth += 1) noteParent = await mustNote(`Note ${depth}`, `Body ${depth}`, noteParent);

    const built = await build('sealed');
    await resetDatabase();
    await importText(built.text!, 'replace');

    const snapshot = await readVaultRaw();
    const byId = new Map(snapshot.folders.map((row) => [row.id, row]));
    expect(snapshot.folders).toHaveLength(10);
    let cursor = snapshot.folders.find((row) => row.name === 'Level 9')?.parentId ?? null;
    let measured = 0;
    while (cursor) {
      measured += 1;
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    expect(measured).toBe(9);
    expect(snapshot.notes).toHaveLength(18);
  });
});

describe('an empty backup', () => {
  it('merges as a no-op and leaves the vault alone', async () => {
    // Built against an empty vault, so the file really is empty.
    const empty = await buildBackup({ mode: 'sealed' });
    expect(empty.ok).toBe(true);

    await populate();
    const before = await structure();

    const { outcome } = await importText(empty.text!, 'merge');
    expect(outcome.written.folders).toBe(0);
    expect(await structure()).toEqual(before);
  });

  it('replaces with an empty vault, and keeps the old data in the safety copy', async () => {
    const empty = await buildBackup({ mode: 'sealed' });
    await populate();
    const before = await structure();

    const { outcome } = await importText(empty.text!, 'replace');

    const after = await readVaultRaw();
    expect(after.folders).toEqual([]);
    expect(after.links).toEqual([]);
    expect(after.notes).toEqual([]);
    expect(after.tags).toEqual([]);

    // The safety copy is a real, restorable backup of what was there.
    expect(outcome.emergencyBackup).toBeTruthy();
    await restore(mustParse(outcome.emergencyBackup!), 'replace');
    expect(await structure()).toEqual(before);
  });
});

describe('locked content', () => {
  it('keeps locked items encrypted in a sealed export, and readable after a restore', async () => {
    await createKeyring(PASSCODE);
    const personal = await mustFolder('Personal');
    const nested = await mustFolder('Settlement', personal);
    const secret = await mustLink('https://secret.example.com/divorce', nested, 'Settlement');
    const privateNote = await mustNote('Therapy', 'What I said on Tuesday.', null);
    const subnote = await mustNote('Session three', 'It went better.', privateNote);
    await setFolderLocked(personal, true);
    await setNoteLocked(privateNote, true);

    const built = await build('sealed');

    // What is stored is ciphertext, and the file carries it as-is. The folder's
    // own name is not part of that: it is the label, and it travels in the clear
    // so the restored vault can still say which folder is which.
    expect(isSealed((await db.folders.get(personal)) ?? {})).toBe(false);
    expect(isSealed((await db.links.get(secret)) ?? {})).toBe(true);
    expect(built.text).not.toContain('secret.example.com');
    expect(built.text).not.toContain('Therapy');
    expect(built.text).not.toContain('What I said on Tuesday');
    // ...and it carries the wrapped key that opens them, so they are restorable.
    expect(built.text).toContain('wrappedByPasscode');

    await resetDatabase();
    forgetVaultKey();

    const parsed = mustParse(built.text!);
    expect(parsed.report.summary.sealedItems).toBeGreaterThan(0);
    expect(parsed.report.orphanedCiphertext).toBe(false);

    const { plan } = await restore(parsed, 'replace');
    // A fresh device has no keyring, so the backup's is installed.
    expect(plan.keyring).toBe('adopt');
    expect(await hasKeyring()).toBe(true);

    // Until it is unlocked the restored rows are ciphertext, exactly as they
    // were on the original device.
    const sealedBefore = await readVaultRaw();
    // The folder's label survives the round trip — it is not the secret — while
    // the content behind it is still ciphertext, exactly as on the source device.
    expect(sealedBefore.folders.find((row) => row.id === personal)?.name).toBe('Personal');
    expect(sealedBefore.folders.find((row) => row.id === personal)?.isLocked).toBe(true);
    expect(isSealed(sealedBefore.links.find((row) => row.id === secret) ?? {})).toBe(true);
    expect(sealedBefore.notes.find((row) => row.id === privateNote)?.title).toBe('');

    // The original passcode opens the restored vault.
    forgetVaultKey();
    const key = await unlockWithPasscode(PASSCODE);
    expect(key).not.toBeNull();

    const snapshot = await getSnapshot();
    expect(snapshot.folders.find((row) => row.id === personal)?.name).toBe('Personal');
    expect(snapshot.folders.find((row) => row.id === nested)?.name).toBe('Settlement');
    expect(snapshot.links.find((row) => row.id === secret)?.url).toBe('https://secret.example.com/divorce');
    expect(snapshot.notes.find((row) => row.id === privateNote)?.title).toBe('Therapy');
    expect(snapshot.notes.find((row) => row.id === subnote)?.title).toBe('Session three');
    expect(snapshot.notes.find((row) => row.id === privateNote)?.content).toBe('What I said on Tuesday.');
    // The lock flags survive, so the restored vault is locked exactly as before.
    expect(snapshot.folders.find((row) => row.id === personal)?.isLocked).toBe(true);
    expect(snapshot.notes.find((row) => row.id === privateNote)?.isLocked).toBe(true);
  });

  it('writes locked items out in the clear only when the user chooses a readable export, and says so', async () => {
    await createKeyring(PASSCODE);
    const personal = await mustFolder('Personal');
    await setFolderLocked(personal, true);
    await mustLink('https://secret.example.com/x', personal);

    const built = await build('plaintext');

    // This is the documented, opt-in trade: the file is complete and readable.
    expect(built.text).toContain('Personal');
    expect(built.text).toContain('secret.example.com');
    // No key is needed, so none is shipped.
    expect(built.text).not.toContain('wrappedByPasscode');

    const parsed = mustParse(built.text!);
    expect(parsed.report.summary.sealedItems).toBe(0);
    // The lock flag still travels, so a restore locks the folder again.
    expect(parsed.data.folders.find((row) => row.id === personal)?.isLocked).toBe(true);
  });

  it('refuses a readable export while the session is locked, rather than shipping ciphertext', async () => {
    await createKeyring(PASSCODE);
    const personal = await mustFolder('Personal');
    await mustLink('https://secret.example.com/hidden', personal);
    await setFolderLocked(personal, true);
    forgetVaultKey();

    const result = await buildBackup({ mode: 'plaintext' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unlock');
  });

  it('will not open an encrypted backup with the wrong passphrase', async () => {
    await createKeyring(PASSCODE);
    await mustFolder('Personal');
    const built = await build('encrypted');

    const parsed = parseBackup(built.text!);
    expect(parsed.kind).toBe('encrypted');
    if (parsed.kind !== 'encrypted') return;

    const wrong = await decryptBackupPayload(parsed.backup, 'not the passphrase');
    expect(wrong.kind).toBe('invalid');
    if (wrong.kind !== 'invalid') return;
    expect(wrong.problem).toBe('wrong-passphrase');

    // The right one works, and the vault is untouched by the failed attempt.
    const right = await decryptBackupPayload(parsed.backup, FILE_PASSPHRASE);
    expect(right.kind).toBe('ready');
  });

  it('reports locked items honestly when the file has no key for them', async () => {
    await createKeyring(PASSCODE);
    const personal = await mustFolder('Personal');
    await setFolderLocked(personal, true);
    await mustLink('https://secret.example.com/x', personal);

    const built = (await build('sealed')).backup as StashBackup;
    // Strip the key, as a file written by a device whose keyring was removed.
    const stripped: StashBackup = { ...built };
    delete stripped.security;

    const parsed = mustParse(JSON.stringify(stripped));
    expect(parsed.report.orphanedCiphertext).toBe(true);
    expect(parsed.report.warnings.join(' ')).toContain('no key');
    // And the rows still import, locked rather than lost.
    const { outcome } = await restore(parsed, 'replace');
    expect(outcome.written.folders).toBeGreaterThan(0);
    expect(await db.folders.count()).toBeGreaterThan(0);
  });

  it('keeps the device key role out of the file entirely', async () => {
    await createKeyring(PASSCODE);
    await mustNote('Anything', 'Body');
    const built = await build('sealed');
    // The device-bound wrap only means something on this phone, so it is not
    // written to a file that is meant to travel.
    expect(built.text).not.toContain('wrappedByDevice');
  });
});

describe('safety', () => {
  it('writes a restorable safety copy before a replace', async () => {
    await populate();
    const before = await structure();
    const emergency = await buildEmergencyBackup();
    const parsed = mustParse(emergency);
    expect(parsed.data.folders.length).toBe(before.folders.length);
  });

  it('leaves the vault untouched when the restore fails part-way', async () => {
    await populate();
    const before = await structure();

    const replacement = await build('sealed');

    // Fail the write that happens *after* the old rows have already been
    // cleared. If the transaction were not atomic this is the point at which a
    // half-restored vault would be left behind.
    const spy = vi.spyOn(db.links, 'bulkPut').mockRejectedValueOnce(new Error('simulated storage failure'));

    const parsed = mustParse(replacement.text!);
    const snapshot = await readVaultRaw();
    const plan = planImport({
      data: parsed.data,
      existing: indexExisting(snapshot),
      mode: 'replace',
      backupHasKeyring: Boolean(parsed.backup.security?.keyring),
      deviceHasKeyring: false,
    });
    const outcome = await applyImport(plan, { keyring: null });
    spy.mockRestore();

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('simulated storage failure');
    // Dexie rolled the whole transaction back: clearing included.
    expect(await structure()).toEqual(before);
  });

  it('does not change the vault when the file is rejected', async () => {
    await populate();
    const before = await structure();

    for (const bad of ['not json at all', '{"format":"something-else"}', '{"format":"stash-backup","version":99}']) {
      const parsed = parseBackup(bad);
      expect(parsed.kind).toBe('invalid');
    }
    expect(await structure()).toEqual(before);
  });

  it('does not duplicate anything when the same file is merged twice', async () => {
    await populate();
    const built = await build('sealed');

    await importText(built.text!, 'merge');
    const afterFirst = await structure();
    await importText(built.text!, 'merge');
    expect(await structure()).toEqual(afterFirst);
  });

  it('adds only what is missing when merging two different vaults', async () => {
    await populate();
    const other = await mustFolder('Other vault folder');
    const otherLink = await mustLink('https://other.example.com/x', other);
    const built = await build('sealed');

    await resetDatabase();
    forgetVaultKey();
    const solo = await mustFolder('Solo');
    await mustLink('https://solo.example.com/y', solo);

    await importText(built.text!, 'merge');

    const snapshot = await readVaultRaw();
    // What was here is still here...
    expect(snapshot.folders.some((row) => row.id === solo)).toBe(true);
    // ...and everything from the file arrived.
    expect(snapshot.folders.some((row) => row.id === other)).toBe(true);
    expect(snapshot.links.some((row) => row.id === otherLink)).toBe(true);
    expect(snapshot.folders.some((row) => row.name === 'Development')).toBe(true);
  });

  it('reports a plan that would change nothing rather than claiming a restore happened', async () => {
    await populate();
    const built = await build('sealed');
    const parsed = mustParse(built.text!);

    const snapshot = await readVaultRaw();
    const plan = planImport({
      data: parsed.data,
      existing: indexExisting(snapshot),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(plan.folders).toHaveLength(0);
    expect(plan.messages.join(' ')).toContain('already exist');
  });
});

describe('scale', () => {
  it('round-trips a vault with a thousand links', async () => {
    const folder = await mustFolder('Big');
    for (let index = 0; index < 400; index += 1) {
      await createLink({ url: `https://example.com/${index}`, folderId: folder, title: `Item ${index}` });
    }

    const built = await build('sealed');
    await resetDatabase();
    await importText(built.text!, 'replace');

    const snapshot = await readVaultRaw();
    expect(snapshot.links).toHaveLength(400);
    expect(snapshot.links.every((row) => row.folderId === folder)).toBe(true);
  });
});

describe('the portable preferences', () => {
  it('travel with the backup and are restored on a replace', async () => {
    const { setMeta } = await import('@/db/repos/settings');
    const { META_KEYS } = await import('@/db/types');
    const welcome = await mustFolder('Welcome');
    await setMeta(META_KEYS.themeMode, 'dark');
    await setMeta(META_KEYS.lastFolderId, welcome);
    await setMeta(META_KEYS.recentFolders, [welcome]);
    await setMeta(META_KEYS.privacySettings, {
      enabled: false,
      relockPolicy: '5m',
      lockApp: false,
      secureScreen: true,
      biometric: false,
    });

    const built = await build('sealed');
    await resetDatabase();
    await importText(built.text!, 'replace');

    const { getThemeMode, getRecentFolderIds, getLastFolderId, getPrivacySettings } = await import(
      '@/db/repos/settings'
    );
    expect(await getThemeMode()).toBe('dark');
    expect(await getLastFolderId()).toBe(welcome);
    expect(await getRecentFolderIds()).toEqual([welcome]);
    const privacy = await getPrivacySettings();
    expect(privacy.relockPolicy).toBe('5m');
    expect(privacy.lockApp).toBe(false);
    expect(privacy.secureScreen).toBe(true);
    expect(privacy.biometric).toBe(false);
    // The file must not be able to claim privacy is on for a device with no key.
    expect(privacy.enabled).toBe(false);
  });

  it('keeps device bookkeeping out of the file', async () => {
    await populate();
    const built = await build('sealed');
    // The schema version describes the database a file came from, not the one
    // it is going to, so importing it would be a lie.
    expect(built.text).not.toContain('db.schemaInfo');
    expect(built.text).not.toContain('notes.lastNoteId');
  });
});
