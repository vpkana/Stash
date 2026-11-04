import { describe, expect, it } from 'vitest';
import { MAX_BACKUP_BYTES } from '@/lib/backup/format';
import { parseBackup } from '@/lib/backup/validate';
import { MAX_FOLDER_DEPTH, MAX_NOTE_DEPTH } from '@/lib/tree';
import { BASE_TIME, data, document, documentText, folder, link, note, sampleData } from './backup-fixtures';

/**
 * Reading a backup file.
 *
 * Every case here is a file the app might be handed in the real world: one from
 * an older build, one from another app, one truncated by a failed download, one
 * from a newer build. The requirement is that each is either accepted with its
 * repairs named, or refused with a reason — never half-read.
 */

function expectReady(text: string) {
  const result = parseBackup(text);
  if (result.kind !== 'ready') {
    throw new Error(`expected a ready backup, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  return result;
}

describe('the envelope', () => {
  it('refuses a file that is not JSON at all', () => {
    const result = parseBackup('{ this is not json');
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('not-json');
  });

  it('refuses an empty file without calling it corrupt', () => {
    const result = parseBackup('   ');
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('empty-file');
  });

  it('refuses a JSON document that is not an object', () => {
    expect(parseBackup('[1,2,3]').kind).toBe('invalid');
    expect(parseBackup('"hello"').kind).toBe('invalid');
    expect(parseBackup('42').kind).toBe('invalid');
  });

  it('refuses a file from another application, and says which field gave it away', () => {
    const result = parseBackup(JSON.stringify({ format: 'some-other-vault', version: 1 }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('not-a-backup');
    expect(result.details.join(' ')).toContain('some-other-vault');
  });

  it('refuses a JSON file with no format field at all', () => {
    const result = parseBackup(JSON.stringify({ hello: 'world' }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('not-a-backup');
  });

  it('refuses a version from the future rather than guessing at it', () => {
    const result = parseBackup(documentText({ version: 99, data: sampleData() }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('unsupported-version');
    expect(result.details.join(' ')).toContain('99');
  });

  it('refuses a payload with no data at all', () => {
    const result = parseBackup(documentText({ mode: 'sealed' }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('missing-payload');
  });

  it('refuses a file that is far too large to be a Stash backup', () => {
    const result = parseBackup('{}', { bytes: MAX_BACKUP_BYTES + 1 });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('too-large');
  });

  it('refuses a locking mode it does not understand', () => {
    const result = parseBackup(documentText({ mode: 'quantum' as never, data: sampleData() }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('corrupt');
  });

  it('asks for a passphrase when the payload is encrypted', () => {
    const result = parseBackup(
      documentText({
        mode: 'encrypted',
        kdf: { algorithm: 'PBKDF2-SHA256', salt: 'AAAA', iterations: 210_000 },
        payload: { v: 1, alg: 'AES-GCM', iv: 'AAAA', ct: 'AAAA' },
      }),
    );
    expect(result.kind).toBe('encrypted');
  });

  it('refuses an encrypted file whose envelope is incomplete', () => {
    const result = parseBackup(documentText({ mode: 'encrypted', data: undefined }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('missing-payload');
  });

  it('reads a readable payload in a file that claims to be encrypted, and says so', () => {
    const result = expectReady(documentText({ mode: 'encrypted', data: sampleData() }));
    expect(result.report.warnings.join(' ')).toContain('not actually encrypted');
  });
});

describe('an empty backup', () => {
  it('validates, and warns that there is nothing in it', () => {
    const result = expectReady(documentText({ data: data() }));
    expect(result.data.folders).toHaveLength(0);
    expect(result.report.warnings.join(' ')).toContain('no folders');
  });

  it('treats missing optional collections as empty rather than as corruption', () => {
    const result = expectReady(documentText({ data: { folders: [], links: [] } }));
    expect(result.data.tags).toEqual([]);
    expect(result.data.notes).toEqual([]);
    expect(result.report.repairs.join(' ')).toContain('No settings');
  });
});

describe('structure', () => {
  it('reads a complete vault and counts everything', () => {
    const source = sampleData();
    const result = expectReady(documentText({ data: source }));

    expect(result.data.folders).toHaveLength(3);
    expect(result.data.links).toHaveLength(4);
    expect(result.data.notes).toHaveLength(3);
    expect(result.data.tags).toHaveLength(2);
    // Favourites and archive state are columns on the rows, so they travel.
    expect(result.data.links.find((row) => row.id === 'l-1')?.isFavorite).toBe(true);
    expect(result.data.links.find((row) => row.id === 'l-4')?.isArchived).toBe(true);
    expect(result.data.notes.find((row) => row.id === 'n-archived')?.isArchived).toBe(true);
    // Hierarchy comes through unchanged.
    expect(result.data.folders.find((row) => row.id === 'f-work-reports')?.parentId).toBe('f-work');
    expect(result.data.notes.find((row) => row.id === 'n-child')?.parentNoteId).toBe('n-root');
    expect(result.data.linkTags).toHaveLength(2);
    expect(result.data.noteLinks).toHaveLength(2);
  });

  it('reports the hierarchy depth it accepted, up to the app limit', () => {
    const folders = Array.from({ length: MAX_FOLDER_DEPTH }, (_, index) =>
      folder(`f-${index}`, `Level ${index}`, index === 0 ? null : `f-${index - 1}`),
    );
    const result = expectReady(documentText({ data: data({ folders }) }));
    expect(result.report.repairs).toEqual([]);
    expect(result.data.folders).toHaveLength(MAX_FOLDER_DEPTH);
  });

  it('flattens folders nested deeper than the app allows, and says how many', () => {
    const depth = MAX_FOLDER_DEPTH + 4;
    const folders = Array.from({ length: depth }, (_, index) =>
      folder(`f-${index}`, `Level ${index}`, index === 0 ? null : `f-${index - 1}`),
    );
    const result = expectReady(documentText({ data: data({ folders }) }));

    expect(result.data.folders).toHaveLength(depth);
    expect(result.report.repairs.join(' ')).toContain('deeper than Stash allows');

    // Nothing is lost: every folder is still there, and the deepest chain is now
    // within the limit.
    const byId = new Map(result.data.folders.map((row) => [row.id, row]));
    let deepest = 0;
    for (const row of result.data.folders) {
      let cursor: string | null = row.id;
      let depthOf = 0;
      while (cursor && byId.has(cursor)) {
        depthOf += 1;
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      deepest = Math.max(deepest, depthOf);
    }
    expect(deepest).toBeLessThanOrEqual(MAX_FOLDER_DEPTH);
  });

  it('flattens notes nested deeper than the app allows', () => {
    const depth = MAX_NOTE_DEPTH + 3;
    const notes = Array.from({ length: depth }, (_, index) =>
      note(`n-${index}`, `Note ${index}`, '', index === 0 ? null : `n-${index - 1}`),
    );
    const result = expectReady(documentText({ data: data({ notes }) }));
    expect(result.data.notes).toHaveLength(depth);
    expect(result.report.repairs.join(' ')).toContain('deeper than Stash allows');
  });

  it('breaks a folder cycle instead of hanging or refusing the file', () => {
    const folders = [
      folder('a', 'A', 'b'),
      folder('b', 'B', 'c'),
      folder('c', 'C', 'a'),
      folder('orphan', 'Orphan', 'a'),
    ];
    const result = expectReady(documentText({ data: data({ folders }) }));

    expect(result.data.folders).toHaveLength(4);
    expect(result.report.repairs.join(' ')).toContain('loop');

    // One member of the loop lost its parent; every row is reachable from root.
    const byId = new Map(result.data.folders.map((row) => [row.id, row]));
    for (const row of result.data.folders) {
      const guard = new Set<string>([row.id]);
      let cursor = row.parentId;
      while (cursor) {
        expect(guard.has(cursor)).toBe(false);
        guard.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
      }
    }
  });

  it('treats a folder that is its own parent as a root folder', () => {
    const result = expectReady(documentText({ data: data({ folders: [folder('a', 'A', 'a')] }) }));
    expect(result.data.folders[0]?.parentId).toBeNull();
    expect(result.report.repairs.join(' ')).toContain('own parent');
  });
});

describe('missing references', () => {
  it('re-homes a link whose folder is not in the backup, rather than dropping it', () => {
    const result = expectReady(
      documentText({ data: data({ folders: [folder('f-1', 'One')], links: [link('l-1', 'https://x.test', 'f-gone')] }) }),
    );
    expect(result.data.links).toHaveLength(1);
    expect(result.data.links[0]?.folderId).toBeNull();
    expect(result.report.repairs.join(' ')).toContain('library root');
  });

  it('re-homes a folder whose parent is not in the backup', () => {
    const result = expectReady(documentText({ data: data({ folders: [folder('f-1', 'One', 'f-gone')] }) }));
    expect(result.data.folders[0]?.parentId).toBeNull();
    expect(result.report.repairs.join(' ')).toContain('top-level');
  });

  it('re-homes a note whose parent note is not in the backup', () => {
    const result = expectReady(documentText({ data: data({ notes: [note('n-1', 'One', '', 'n-gone')] }) }));
    expect(result.data.notes[0]?.parentNoteId).toBeNull();
    expect(result.report.repairs.join(' ')).toContain('top-level');
  });

  it('drops a tag link whose tag is missing, and counts it', () => {
    const result = expectReady(
      documentText({
        data: data({
          links: [link('l-1', 'https://x.test')],
          tags: [{ id: 't-1', name: 'one' }],
          linkTags: [
            { linkId: 'l-1', tagId: 't-1' },
            { linkId: 'l-1', tagId: 't-gone' },
            { linkId: 'l-gone', tagId: 't-1' },
          ],
        }),
      }),
    );
    expect(result.data.linkTags).toEqual([{ linkId: 'l-1', tagId: 't-1' }]);
    expect(result.report.repairs.join(' ')).toContain('2 tag link(s)');
  });

  it('drops a note reference whose note is missing, and keeps the note itself', () => {
    const result = expectReady(
      documentText({
        data: data({
          links: [link('l-1', 'https://x.test')],
          notes: [note('n-1', 'One', '')],
          noteLinks: [
            { noteId: 'n-1', linkId: 'l-1', origin: 'attached', createdAt: BASE_TIME, sortOrder: 0 },
            { noteId: 'n-1', linkId: 'l-gone', origin: 'attached', createdAt: BASE_TIME, sortOrder: 1 },
          ],
        }),
      }),
    );
    expect(result.data.noteLinks).toHaveLength(1);
    expect(result.data.notes).toHaveLength(1);
    expect(result.report.repairs.join(' ')).toContain('1 note reference(s)');
  });
});

describe('duplicates and corruption', () => {
  it('refuses a file with two folders sharing an id', () => {
    const result = parseBackup(documentText({ data: data({ folders: [folder('dup', 'A'), folder('dup', 'B')] }) }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('corrupt');
    expect(result.details.join(' ')).toContain('dup');
  });

  it('refuses a file with two notes sharing an id', () => {
    const result = parseBackup(documentText({ data: data({ notes: [note('dup', 'A', ''), note('dup', 'B', '')] }) }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('corrupt');
  });

  it('refuses a row that is not an object at all', () => {
    const result = parseBackup(documentText({ data: { folders: [folder('f', 'F')], links: [42] } }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('corrupt');
  });

  it('refuses a link with no address', () => {
    const result = parseBackup(
      documentText({
        data: data({
          links: [{ id: 'l-1', folderId: null, createdAt: BASE_TIME, updatedAt: BASE_TIME }] as never,
        }),
      }),
    );
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('corrupt');
    expect(result.details.join(' ')).toContain('url');
  });

  it('refuses a row whose ciphertext is malformed rather than importing a blank item', () => {
    const result = parseBackup(
      documentText({
        data: data({
          notes: [note('n-1', '', '', null, { enc: { v: 1, alg: 'AES-GCM', iv: '', ct: '' } as never })],
        }),
      }),
    );
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('corrupt');
    expect(result.details.join(' ')).toContain('encrypted payload');
  });

  it('repairs a repeated tag pair instead of refusing the file', () => {
    const result = expectReady(
      documentText({
        data: data({
          links: [link('l-1', 'https://x.test')],
          tags: [{ id: 't-1', name: 'one' }],
          linkTags: [
            { linkId: 'l-1', tagId: 't-1' },
            { linkId: 'l-1', tagId: 't-1' },
          ],
        }),
      }),
    );
    expect(result.data.linkTags).toHaveLength(1);
    expect(result.report.coerced).toBeGreaterThan(0);
  });

  it('defaults a missing flag rather than refusing the row', () => {
    const result = expectReady(
      documentText({
        data: data({ links: [{ id: 'l-1', url: 'https://x.test' }] as never }),
      }),
    );
    expect(result.data.links[0]?.isFavorite).toBe(false);
    expect(result.data.links[0]?.isArchived).toBe(false);
  });

  it('derives a note title from its body when the title is missing', () => {
    const result = expectReady(
      documentText({ data: data({ notes: [{ id: 'n-1', content: '# Heading\n\nBody text.' }] as never }) }),
    );
    expect(result.data.notes[0]?.title).toBe('Heading');
  });
});

describe('migrating older backups', () => {
  it('reads a version 3 legacy export', () => {
    const legacy = {
      format: 'stash-export',
      version: 3,
      exportedAt: BASE_TIME,
      folders: [folder('f-1', 'One')],
      links: [link('l-1', 'https://x.test', 'f-1')],
      tags: [],
      linkTags: [],
      notes: [note('n-1', 'Note', 'Body')],
      noteLinks: [],
      meta: [
        { key: 'theme.mode', value: 'dark' },
        { key: 'capture.lastFolderId', value: 'f-1' },
        { key: 'capture.recentFolders', value: ['f-1'] },
        { key: 'db.seeded', value: true },
      ],
    };
    const result = expectReady(JSON.stringify(legacy));

    expect(result.report.origin).toBe('stash-export');
    expect(result.report.migratedFrom).toBe('stash-export v3');
    expect(result.data.folders).toHaveLength(1);
    expect(result.data.notes).toHaveLength(1);
    // Settings lived in `meta` in the old format and are lifted out on the way in.
    expect(result.data.settings.themeMode).toBe('dark');
    expect(result.data.settings.lastFolderId).toBe('f-1');
    expect(result.data.settings.recentFolderIds).toEqual(['f-1']);
  });

  it('reads a version 1 legacy export, which predates notes entirely', () => {
    const legacy = {
      format: 'stash-export',
      version: 1,
      exportedAt: BASE_TIME,
      folders: [folder('f-1', 'One')],
      links: [link('l-1', 'https://x.test')],
      tags: [],
      linkTags: [],
      meta: [],
    };
    const result = expectReady(JSON.stringify(legacy));
    expect(result.report.migratedFrom).toBe('stash-export v1');
    expect(result.data.notes).toEqual([]);
    expect(result.data.settings.themeMode).toBe('system');
  });

  it('defaults the unlock duration to app-close for older and invalid backups', () => {
    const olderSettings = { ...sampleData().settings };
    Reflect.deleteProperty(olderSettings, 'sessionEndPolicy');
    const older = expectReady(documentText({ data: { ...sampleData(), settings: olderSettings } }));
    expect(older.data.settings.sessionEndPolicy).toBe('app-close');

    const invalid = expectReady(
      documentText({
        data: {
          ...sampleData(),
          settings: { ...sampleData().settings, sessionEndPolicy: 'unknown' },
        },
      }),
    );
    expect(invalid.data.settings.sessionEndPolicy).toBe('app-close');
  });

  it('applies the same reference checks to an old file as to a new one', () => {
    const legacy = {
      format: 'stash-export',
      version: 2,
      exportedAt: BASE_TIME,
      folders: [folder('f-1', 'One')],
      links: [link('l-1', 'https://x.test', 'f-gone')],
      tags: [],
      linkTags: [],
      notes: [note('n-1', 'Note', '', 'n-gone')],
      noteLinks: [],
      meta: [],
    };
    const result = expectReady(JSON.stringify(legacy));
    expect(result.data.links[0]?.folderId).toBeNull();
    expect(result.data.notes[0]?.parentNoteId).toBeNull();
    expect(result.report.repairs).toHaveLength(2);
  });

  it('refuses a legacy export with a version it never had', () => {
    const result = parseBackup(JSON.stringify({ format: 'stash-export', version: 9 }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.problem).toBe('unsupported-version');
  });
});

describe('the summary is advisory only', () => {
  it('ignores a summary that disagrees with the contents, and says so', () => {
    const lying = document({
      data: sampleData(),
      summary: { folders: 999, links: 999, tags: 0, notes: 0, linkTags: 0, noteLinks: 0, favorites: 0, archived: 0, sealedItems: 0 },
    });
    const result = expectReady(JSON.stringify(lying));

    // The real counts win.
    expect(result.data.folders).toHaveLength(3);
    expect(result.report.summary.folders).toBe(3);
    expect(result.report.warnings.join(' ')).toContain('does not match');
  });
});

describe('scale', () => {
  it('reads a large backup without losing or inventing rows', () => {
    const folders = Array.from({ length: 200 }, (_, index) => folder(`f-${index}`, `Folder ${index}`));
    const links = Array.from({ length: 5_000 }, (_, index) =>
      link(`l-${index}`, `https://example.com/${index}`, `f-${index % 200}`, {
        isFavorite: index % 17 === 0,
        isArchived: index % 29 === 0,
      }),
    );
    const notes = Array.from({ length: 2_000 }, (_, index) =>
      note(`n-${index}`, `Note ${index}`, `Body ${index}`, index < 10 ? null : `n-${index % 1_000}`),
    );
    const noteLinks = Array.from({ length: 3_000 }, (_, index) => ({
      noteId: `n-${index % 2_000}`,
      linkId: `l-${index % 5_000}`,
      origin: 'attached' as const,
      createdAt: BASE_TIME,
      sortOrder: index,
    }));

    const text = documentText({ data: data({ folders, links, notes, noteLinks }) });
    expect(text.length).toBeGreaterThan(1_000_000);

    const result = expectReady(text);
    expect(result.data.links).toHaveLength(5_000);
    expect(result.data.notes).toHaveLength(2_000);
    expect(result.data.noteLinks).toHaveLength(3_000);
    // Favourites are counted from the rows, not taken from the file's own summary.
    expect(result.report.summary.favorites).toBe(Math.ceil(5_000 / 17));
    expect(result.report.summary.archived).toBe(Math.ceil(5_000 / 29));
  });
});
