import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDatabase } from '@/db';
import type { BackupData } from '@/lib/backup/format';
import { applyImport, buildBackup, readVaultRaw } from '@/db/repos/backup';
import { indexExisting, planImport, type ImportMode } from '@/lib/backup/merge';
import { parseBackup } from '@/lib/backup/validate';
import { createFolder } from '@/db/repos/folders';
import { createLink, setLinkFavorite } from '@/db/repos/links';
import { createNote, attachLinkToNote } from '@/db/repos/notes';
import { setLinkTags } from '@/db/repos/tags';
import { forgetVaultKey, hasKeyring } from '@/lib/privacy/keyring';
import { DEFAULT_SETTINGS } from './backup-fixtures';

/**
 * Merging, end to end, over a real Dexie database.
 *
 * ## The bug these tests exist for
 *
 * A backup taken on one device carries *different ids* for the same folders. The
 * planner used to decide everything from ids alone, so nothing collided, and a
 * restore onto a phone that already had `Entertainment`, `Development` and
 * `Reading` created a second set of all three with the backup's contents in them.
 *
 * So every test here is written the way that situation actually arises: **two
 * vaults are built separately**, the way two phones would build them, and one is
 * exported and merged into the other. Nothing is hand-waved by reusing ids across
 * the two vaults, because then the tests would pass against the broken planner
 * too — which is exactly how the bug survived a suite that already covered
 * "merge".
 *
 * ## What is asserted
 *
 * Where a claim is about what the user ends up with, it is asserted against the
 * stored rows (`readVaultRaw`), not against the plan. The plan is asserted
 * separately, and only for the thing the plan is responsible for: the numbers the
 * confirmation screen promises must be the numbers the database actually
 * receives.
 */

const DEVICE_SHARED: ReadonlyArray<{ folder: string; children: string[] }> = [
  { folder: 'Entertainment', children: ['Anime'] },
  { folder: 'Development', children: ['React'] },
  { folder: 'Reading', children: [] },
];

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

async function mustLink(url: string, folderId: string | null = null, title?: string): Promise<string> {
  const link = await createLink({ url, folderId, ...(title ? { title } : {}) });
  return link.id;
}

async function mustNote(title: string, content: string, parentNoteId: string | null = null): Promise<string> {
  const result = await createNote({ title, content, parentNoteId });
  if (!result.ok) throw new Error(`createNote("${title}") failed: ${result.message}`);
  return result.note.id;
}

/** The tree both devices have, with ids that are necessarily different. */
async function buildSharedTree(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const { folder, children } of DEVICE_SHARED) {
    ids[folder] = await mustFolder(folder);
    for (const child of children) ids[`${folder}/${child}`] = await mustFolder(child, ids[folder]!);
  }
  return ids;
}

/** Export the vault as it stands, the way the Export screen would. */
async function build(): Promise<string> {
  const result = await buildBackup({ mode: 'sealed' });
  if (!result.ok || !result.text) throw new Error(`buildBackup failed: ${result.message}`);
  return result.text;
}

async function plan(text: string, mode: ImportMode = 'merge') {
  const parsed = parseBackup(text);
  if (parsed.kind !== 'ready') throw new Error(`expected a ready backup, got ${parsed.kind}`);
  const snapshot = await readVaultRaw();
  const built = planImport({
    data: parsed.data,
    existing: indexExisting(snapshot),
    mode,
    backupHasKeyring: Boolean(parsed.backup.security?.keyring),
    deviceHasKeyring: await hasKeyring(),
  });
  return { plan: built, parsed };
}

async function merge(text: string) {
  const { plan: built, parsed } = await plan(text);
  const outcome = await applyImport(built, { keyring: parsed.backup.security?.keyring ?? null });
  if (!outcome.ok) throw new Error(`applyImport failed: ${outcome.message}`);
  return { plan: built, outcome };
}

/** Folder names directly inside `parentId`, sorted, for readable assertions. */
function childNames(folders: readonly { id: string; parentId: string | null; name: string }[], parentId: string | null): string[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .map((folder) => folder.name)
    .sort();
}

async function snapshot() {
  return readVaultRaw();
}

beforeEach(async () => {
  await resetDatabase();
  forgetVaultKey();
});

describe('merging two vaults that hold the same directories', () => {
  /**
   * The exact shape from the bug report: one device with Entertainment,
   * Development and Reading, and a backup from another device with the same
   * three — plus a subfolder and a link in each that the other does not have.
   */
  async function twoDevices() {
    // Device A: what the backup will contain.
    const a = await buildSharedTree();
    await mustFolder('Python', a['Development']!);
    await mustLink('https://ent.example/anime-list', a['Entertainment/Anime']!, 'Anime list');
    await mustLink('https://dev.example/react-docs', a['Development/React']!, 'React docs');
    await mustLink('https://read.example/paper-a', a['Reading']!, 'Paper A');
    await mustLink('https://dev.example/shared', a['Development']!, 'Shared');
    const backup = await build();

    // Device B: a different phone, with the same folders made by the same person.
    await resetDatabase();
    forgetVaultKey();
    const b = await buildSharedTree();
    await mustFolder('Docker', b['Development']!);
    await mustLink('https://dev.example/docker-guide', b['Development/Docker']!, 'Docker guide');
    await mustLink('https://read.example/paper-a', b['Reading']!, 'Paper A — my copy');
    await mustLink('https://dev.example/shared', b['Development']!, 'Shared');

    return { a, b, backup };
  }

  it('does not create a second Development, Entertainment or Reading', async () => {
    const { backup } = await twoDevices();
    await merge(backup);

    const after = await snapshot();
    const roots = childNames(after.folders, null);
    expect(roots).toEqual(['Development', 'Entertainment', 'Reading']);
    // Named, not merely counted: a duplicate would show as a second entry here.
    expect(roots.filter((name) => name === 'Development')).toHaveLength(1);
    expect(roots.filter((name) => name === 'Entertainment')).toHaveLength(1);
    expect(roots.filter((name) => name === 'Reading')).toHaveLength(1);
  });

  it('merges the contents of a matched directory, keeping both sides', async () => {
    const { backup, b } = await twoDevices();
    await merge(backup);

    const after = await snapshot();
    const development = after.folders.find((row) => row.name === 'Development')!;
    // Docker was only on the device, Python only in the backup, React on both.
    expect(childNames(after.folders, development.id)).toEqual(['Docker', 'Python', 'React']);
    // The device's own Development row is the one that survived, id and all.
    expect(development.id).toBe(b['Development']);

    const links = after.links.map((row) => row.url).sort();
    expect(links).toEqual([
      'https://dev.example/docker-guide',
      'https://dev.example/react-docs',
      'https://dev.example/shared',
      'https://ent.example/anime-list',
      'https://read.example/paper-a',
    ]);
  });

  it('imports a unique directory and its whole subtree', async () => {
    const { backup } = await twoDevices();
    await merge(backup);

    const after = await snapshot();
    const python = after.folders.find((row) => row.name === 'Python')!;
    const development = after.folders.find((row) => row.name === 'Development')!;
    // It arrived, and it arrived *inside the merged Development* — not at the
    // root beside it, and not inside a duplicate development.
    expect(python.parentId).toBe(development.id);
  });

  it('reports every merged directory as merged, and never as created', async () => {
    const { backup } = await twoDevices();
    const { plan: built } = await plan(backup);

    // Entertainment, Development, Reading, Anime, React existed here.
    expect(built.merged.folders).toBe(5);
    // Python, and Docker is device-only, so Python is the only new folder.
    expect(built.counts.folders).toBe(1);
    expect(built.folders.map((row) => row.name)).toEqual(['Python']);
    expect(built.messages.join(' ')).toContain('merged into');
  });

  it('counts match the rows the database actually gains', async () => {
    const { backup } = await twoDevices();
    const before = await snapshot();
    const { plan: built } = await plan(backup);
    await merge(backup);
    const after = await snapshot();

    expect(after.folders.length - before.folders.length).toBe(built.counts.folders);
    expect(after.links.length - before.links.length).toBe(built.counts.links);
    expect(after.notes.length - before.notes.length).toBe(built.counts.notes);
    expect(after.tags.length - before.tags.length).toBe(built.counts.tags);
  });

  it('changes nothing at all the second time the same file is merged', async () => {
    const { backup } = await twoDevices();
    await merge(backup);
    const afterFirst = await snapshot();

    const { plan: second } = await plan(backup);
    await merge(backup);

    expect(await snapshot()).toEqual(afterFirst);
    expect(second.counts.folders + second.counts.links + second.counts.notes + second.counts.tags).toBe(0);
  });
});

describe('link identity', () => {
  it('deduplicates a link whose address differs only harmlessly', async () => {
    // Same folder, same page. `www.` and a `utm_` parameter are noise — the two
    // spellings provably address one resource — so the merge reuses the local row.
    const folder = await mustFolder('Reading');
    await mustLink('https://example.com/paper', folder, 'Paper');

    const backup = await build();
    await resetDatabase();
    forgetVaultKey();
    const folder2 = await mustFolder('Reading');
    await mustLink('https://www.example.com/paper?utm_source=newsletter', folder2, 'Paper again');

    const before = await snapshot();
    const { plan: built } = await plan(backup);
    await merge(backup);
    const after = await snapshot();

    expect(built.counts.links).toBe(0);
    expect(built.merged.links).toBe(1);
    // The device's own row is untouched, title and all.
    expect(after.links).toHaveLength(before.links.length);
    expect(after.links[0]?.title).toBe('Paper again');
  });

  it('treats a trailing slash as meaningful, because it can be', async () => {
    // `/paper` and `/paper/` are *not* conflated, and that is deliberate: the
    // app's canonicalizer only drops a trailing slash from a bare host, because
    // on a real path the two can be different documents. A merge must not be more
    // eager than the rule the rest of the app dedupes on — a wrong "already here"
    // silently discards a link the user meant to keep.
    const folder = await mustFolder('Reading');
    await mustLink('https://example.com/paper', folder);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const folder2 = await mustFolder('Reading');
    await mustLink('https://example.com/paper/', folder2);
    const { plan: built } = await plan(backup);
    await merge(backup);

    expect(built.counts.links).toBe(1);
    expect((await snapshot()).links).toHaveLength(2);
  });

  it('never merges two links that differ by a meaningful query parameter', async () => {
    const folder = await mustFolder('Reading');
    await mustLink('https://example.com/watch?v=one', folder);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const folder2 = await mustFolder('Reading');
    await mustLink('https://example.com/watch?v=two', folder2);
    await merge(backup);

    const after = await snapshot();
    // `?v=` is the identity of the thing being watched, so these are two links.
    expect(after.links.map((row) => row.url).sort()).toEqual([
      'https://example.com/watch?v=one',
      'https://example.com/watch?v=two',
    ]);
  });

  it('does not merge the same address saved in two different folders', async () => {
    const reading = await mustFolder('Reading');
    await mustLink('https://example.com/paper', reading);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const development = await mustFolder('Development');
    // Same address, deliberately filed somewhere else on this device.
    await mustLink('https://example.com/paper', development);
    await merge(backup);

    const after = await snapshot();
    expect(after.links).toHaveLength(2);
    expect(new Set(after.links.map((row) => row.folderId))).toEqual(new Set([reading, development]));
  });

  it('keeps a device-only link and adds a backup-only link', async () => {
    const folder = await mustFolder('Development');
    await mustLink('https://dev.example/from-backup', folder);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const folder2 = await mustFolder('Development');
    const mine = await mustLink('https://dev.example/only-on-my-phone', folder2);
    await setLinkFavorite(mine, true);
    await merge(backup);

    const after = await snapshot();
    const kept = after.links.find((row) => row.url === 'https://dev.example/only-on-my-phone');
    expect(kept?.id).toBe(mine);
    expect(kept?.isFavorite).toBe(true);
    expect(after.links.some((row) => row.url === 'https://dev.example/from-backup')).toBe(true);
  });

  it('keeps the same name under a different parent distinct', async () => {
    // Development/React and Learning/React are different folders, and merging is
    // expected to say so rather than collapsing them on the name alone.
    const development = await mustFolder('Development');
    await mustFolder('React', development);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const learning = await mustFolder('Learning');
    const myReact = await mustFolder('React', learning);

    const { plan: built } = await plan(backup);
    await merge(backup);

    // Nothing matched: the only `React` here is under `Learning`, and the
    // incoming `Development` has no counterpart at all.
    expect(built.merged.folders).toBe(0);
    expect(built.counts.folders).toBe(2);

    const after = await snapshot();
    expect(after.folders).toHaveLength(4);
    // The local React is untouched, still under Learning.
    expect(after.folders.find((row) => row.id === myReact)?.parentId).toBe(learning);
    // And the incoming one sits under the Development that was created for it.
    const incomingReact = after.folders.find((row) => row.name === 'React' && row.id !== myReact)!;
    const createdDevelopment = after.folders.find((row) => row.name === 'Development')!;
    expect(incomingReact.parentId).toBe(createdDevelopment.id);
    expect(childNames(after.folders, learning)).toEqual(['React']);
    expect(childNames(after.folders, createdDevelopment.id)).toEqual(['React']);
  });

  it('merges a nested directory recursively', async () => {
    const outer = await mustFolder('Development');
    const inner = await mustFolder('React', outer);
    await mustFolder('Hooks', inner);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const outer2 = await mustFolder('Development');
    const inner2 = await mustFolder('React', outer2);
    await merge(backup);

    const after = await snapshot();
    expect(after.folders).toHaveLength(3);
    // Hooks landed inside the *device's* React, at the level it was nested to.
    const hooks = after.folders.find((row) => row.name === 'Hooks')!;
    expect(hooks.parentId).toBe(inner2);
    expect(childNames(after.folders, outer2)).toEqual(['React']);
  });
});

describe('notes and subnotes', () => {
  it('merges a note into its counterpart and keeps the device copy', async () => {
    await mustNote('Reading list', '# Reading list\n\nThings to read.');
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const mine = await mustNote('Reading list', '# Reading list\n\nThings to read.');
    const { plan: built } = await plan(backup);
    await merge(backup);

    const after = await snapshot();
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0]?.id).toBe(mine);
    expect(built.merged.notes).toBe(1);
    expect(built.counts.notes).toBe(0);
  });

  it('keeps two notes that share a title but not their words', async () => {
    await mustNote('Meeting', 'Decided to ship on Friday.');
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const mine = await mustNote('Meeting', 'Everyone agreed the date is wrong.');
    const { plan: built } = await plan(backup);
    await merge(backup);

    const after = await snapshot();
    // Both survive: only the user knows which `Meeting` this one is.
    expect(after.notes).toHaveLength(2);
    expect(after.notes.map((row) => row.content).sort()).toEqual([
      'Decided to ship on Friday.',
      'Everyone agreed the date is wrong.',
    ]);
    expect(after.notes.some((row) => row.id === mine)).toBe(true);
    expect(built.ambiguousNotes).toBe(1);
    expect(built.messages.join(' ')).toContain('share a title');
  });

  it('matches a note by its place in the tree, not by its title alone', async () => {
    // Two notes called `Notes`: one nested under `Plan`, one at the top level.
    const planNote = await mustNote('Plan', 'the plan');
    await mustNote('Notes', 'nested notes', planNote);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const myPlan = await mustNote('Plan', 'the plan');
    // Same title and same words as the incoming child, but at the root — so it is
    // not the same note, and only the nested one has a counterpart to merge into.
    await mustNote('Notes', 'nested notes', null);
    const { plan: built } = await plan(backup);
    await merge(backup);

    const after = await snapshot();
    expect(built.counts.notes).toBe(1);
    expect(built.merged.notes).toBe(1);
    const nested = after.notes.find((row) => row.title === 'Notes' && row.parentNoteId !== null);
    expect(nested?.parentNoteId).toBe(myPlan);
    expect(after.notes).toHaveLength(3);
  });

  it('brings a subnote in under the parent the archive nested it under', async () => {
    const root = await mustNote('Course', 'syllabus');
    const child = await mustNote('Week 1', 'intro', root);
    await mustNote('Week 2', 'more', root);
    await mustLink('https://read.example/week-1', null, 'Week 1 reading');
    await attachLinkToNote(child, (await snapshot()).links[0]!.id, 'attached');
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const mineRoot = await mustNote('Course', 'syllabus');
    await merge(backup);

    const after = await snapshot();
    const week1 = after.notes.find((row) => row.title === 'Week 1')!;
    const week2 = after.notes.find((row) => row.title === 'Week 2')!;
    expect(week1.parentNoteId).toBe(mineRoot);
    expect(week2.parentNoteId).toBe(mineRoot);
    expect(childNames([], null)).toEqual([]);
  });

  it('resolves an attached link after the ids it referred to were remapped', async () => {
    const note = await mustNote('Paper', 'the paper');
    const root = await mustFolder('Reading');
    const link = await mustLink('https://read.example/paper', root, 'Paper');
    await attachLinkToNote(note, link, 'attached');
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const mine = await mustNote('Paper', 'the paper');
    await merge(backup);

    const after = await snapshot();
    // The note merged, so no second note exists; the reference points at the
    // device's note id and resolves to a link that is actually stored.
    expect(after.notes).toHaveLength(1);
    expect(after.noteLinks).toHaveLength(1);
    const row = after.noteLinks[0]!;
    expect(row.noteId).toBe(mine);
    expect(after.links.some((link) => link.id === row.linkId)).toBe(true);
  });

  it('keeps a device-only note and its subtree', async () => {
    await mustNote('From the backup', 'body');
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const mine = await mustNote('Only mine', 'keep me');
    await mustNote('And my child', 'child body', mine);
    await merge(backup);

    const after = await snapshot();
    expect(after.notes).toHaveLength(3);
    expect(after.notes.find((row) => row.id === mine)?.title).toBe('Only mine');
    expect(after.notes.find((row) => row.parentNoteId === mine)?.title).toBe('And my child');
  });

  it('carries rich-text formatting through untouched', async () => {
    const content = '# Head\n\n**bold** and *italic* and `code`\n\n- one\n- [x] done\n\n> a quote';
    await mustNote('Formatted', content);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    await merge(backup);

    const after = await snapshot();
    expect(after.notes[0]?.content).toBe(content);
  });
});

describe('identifiers and references', () => {
  it('gives an id collision its own row instead of overwriting the local one', async () => {
    // A hand-built archive, because this is the one case two real devices cannot
    // produce: an id that is already taken here by a *different* directory.
    const taken = await mustFolder('Development');
    const incomingId = taken;

    const data: BackupData = {
      folders: [
        {
          id: incomingId,
          parentId: null,
          name: 'Something else entirely',
          createdAt: 1,
          updatedAt: 1,
          sortOrder: 0,
          isFavorite: false,
          isLocked: false,
        },
      ],
      links: [],
      tags: [],
      linkTags: [],
      notes: [],
      noteLinks: [],
      settings: { ...DEFAULT_SETTINGS },
    };
    const text = JSON.stringify({
      format: 'stash-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: '0.1.0',
      mode: 'sealed',
      summary: {
        folders: 1,
        links: 0,
        tags: 0,
        notes: 0,
        linkTags: 0,
        noteLinks: 0,
        favorites: 0,
        archived: 0,
        sealedItems: 0,
      },
      data,
    });

    const { plan: built } = await plan(text);
    await merge(text);

    const after = await snapshot();
    // The local folder kept its id and its name; the incoming one was inserted
    // under a fresh id rather than skipped or written over it.
    expect(after.folders.find((row) => row.id === taken)?.name).toBe('Development');
    const arrived = after.folders.find((row) => row.name === 'Something else entirely')!;
    expect(arrived).toBeDefined();
    expect(arrived.id).not.toBe(taken);
    expect(built.counts.folders).toBe(1);
  });

  it('points a remapped child at the id its parent was given', async () => {
    const taken = await mustFolder('Development');
    const text = JSON.stringify({
      format: 'stash-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: '0.1.0',
      mode: 'sealed',
      summary: {
        folders: 2,
        links: 0,
        tags: 0,
        notes: 0,
        linkTags: 0,
        noteLinks: 0,
        favorites: 0,
        archived: 0,
        sealedItems: 0,
      },
      data: {
        folders: [
          { id: taken, parentId: null, name: 'Different parent', createdAt: 1, updatedAt: 1, sortOrder: 0, isFavorite: false, isLocked: false },
          { id: 'incoming-child', parentId: taken, name: 'Child', createdAt: 1, updatedAt: 1, sortOrder: 0, isFavorite: false, isLocked: false },
        ],
        links: [],
        tags: [],
        linkTags: [],
        notes: [],
        noteLinks: [],
        settings: { ...DEFAULT_SETTINGS },
      } satisfies BackupData,
    });

    await merge(text);
    const after = await snapshot();
    const parent = after.folders.find((row) => row.name === 'Different parent')!;
    const child = after.folders.find((row) => row.name === 'Child')!;
    expect(parent.id).not.toBe(taken);
    expect(child.parentId).toBe(parent.id);
  });

  it('keeps tags by name and rewrites the join rows onto the local ids', async () => {
    const folder = await mustFolder('Development');
    const link = await mustLink('https://dev.example/a', folder);
    await setLinkTags(link, ['to-read', 'react']);
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    const mine = await mustFolder('Development');
    const myLink = await mustLink('https://dev.example/a', mine);
    await merge(backup);

    const after = await snapshot();
    expect(after.tags).toHaveLength(2);
    expect(after.linkTags).toHaveLength(2);
    for (const row of after.linkTags) {
      expect(row.linkId).toBe(myLink);
      expect(after.tags.some((tag) => tag.id === row.tagId)).toBe(true);
    }
  });
});

describe('the settings that travel', () => {
  it('keeps this device’s preferences when there is already something here', async () => {
    // The theme is written to the device's own settings, because that is what a
    // backup exports — a value held only in the test would never reach the file.
    const { setMeta } = await import('@/db/repos/settings');
    const { META_KEYS } = await import('@/db/types');
    await setMeta(META_KEYS.themeMode, 'dark');
    await mustFolder('Development');
    const backup = await build();

    await resetDatabase();
    forgetVaultKey();
    await mustFolder('Development');
    const { plan: built } = await plan(backup);
    await merge(backup);

    expect(built.settings).toBeNull();
    expect(built.messages.join(' ')).toContain('preferences');
  });
});

describe('a malformed archive', () => {
  it('is refused without touching the vault', async () => {
    const folder = await mustFolder('Development');
    await mustLink('https://dev.example/a', folder);
    const before = await snapshot();

    for (const bad of [
      'not json',
      '{"format":"stash-backup","version":99}',
      '{"format":"something-else"}',
      '{"format":"stash-backup","version":1,"data":{"folders":[{"id":"x","name":""}]}}',
    ]) {
      const parsed = parseBackup(bad);
      expect(parsed.kind).toBe('invalid');
    }

    expect(await snapshot()).toEqual(before);
  });
});
