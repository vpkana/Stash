import { describe, expect, it } from 'vitest';
import { indexExisting, planImport, planTotal, type ExistingIndex } from '@/lib/backup/merge';
import type { VaultSnapshot } from '@/lib/search';
import { BASE_TIME, data, folder, link, note, sampleData } from './backup-fixtures';

/**
 * Planning a restore.
 *
 * The planner is where the safety guarantees of merge live, so these tests are
 * written as properties rather than as examples: no duplicate ids, no reference
 * pointing at nothing, and an existing row never modified. Those three hold for
 * every input, which is the claim the UI makes to the user.
 */

const EMPTY_SNAPSHOT: VaultSnapshot = {
  folders: [],
  links: [],
  tags: [],
  linkTags: [],
  notes: [],
  noteLinks: [],
};

function existing(partial: Partial<VaultSnapshot>): ExistingIndex {
  return indexExisting({ ...EMPTY_SNAPSHOT, ...partial });
}

describe('merge', () => {
  it('writes everything into an empty vault', () => {
    const source = sampleData();
    const plan = planImport({
      data: source,
      existing: existing({}),
      mode: 'merge',
      backupHasKeyring: true,
      deviceHasKeyring: false,
    });

    expect(plan.counts.folders).toBe(3);
    expect(plan.counts.links).toBe(4);
    expect(plan.counts.notes).toBe(3);
    expect(planTotal(plan)).toBe(3 + 4 + 3 + 2 + 2 + 2);
  });

  it('leaves rows that are already here untouched instead of writing them again', () => {
    const source = sampleData();
    const plan = planImport({
      data: source,
      existing: existing({
        folders: [source.folders[0] as never],
        links: [source.links[0] as never],
        notes: [source.notes[0] as never],
      }),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });

    expect(plan.counts.folders).toBe(2);
    expect(plan.counts.links).toBe(3);
    expect(plan.counts.notes).toBe(2);
    expect(plan.skipped).toEqual({ folders: 1, links: 1, notes: 1, tags: 0 });
    // Nothing that already exists is in the write set, so nothing is overwritten.
    expect(plan.folders.map((row) => row.id)).not.toContain('f-work');
    expect(plan.messages.join(' ')).toContain('already existed here');
  });

  it('inserts an id collision as a new record rather than dropping it', () => {
    // Same id, different folder. The local row keeps its id and its content; the
    // incoming row is a different thing and is given a fresh id. Skipping it —
    // the old behaviour — would have silently lost it.
    const plan = planImport({
      data: data({ folders: [folder('f-1', 'Incoming')] }),
      existing: existing({ folders: [folder('f-1', 'Something else')] }),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
      newId: () => 'fresh-id',
    });

    expect(plan.counts.folders).toBe(1);
    expect(plan.folders[0]?.id).toBe('fresh-id');
    expect(plan.folders[0]?.name).toBe('Incoming');
    expect(plan.skipped.folders).toBe(0);
  });

  it('keeps a child attached to a parent that already exists locally', () => {
    // The parent is merged into the local copy, so the child must attach to the
    // id that already exists rather than to the id from the file.
    const source = data({
      folders: [folder('f-parent', 'Parent'), folder('f-child', 'Child', 'f-parent')],
    });
    const plan = planImport({
      data: source,
      existing: existing({ folders: [folder('f-parent', 'Parent')] }),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });

    expect(plan.counts.folders).toBe(1);
    expect(plan.folders[0]?.id).toBe('f-child');
    expect(plan.folders[0]?.parentId).toBe('f-parent');
  });

  it('follows a remapped parent through an id that was taken', () => {
    // The parent cannot keep its id, so the child must point at the id the
    // parent *got*, not the one it arrived with.
    const plan = planImport({
      data: data({
        folders: [folder('f-parent', 'Parent'), folder('f-child', 'Child', 'f-parent')],
      }),
      existing: existing({ folders: [folder('f-parent', 'A different parent')] }),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
      newId: () => 'remapped-parent',
    });

    expect(plan.counts.folders).toBe(2);
    expect(plan.folders.map((row) => row.id)).toEqual(['remapped-parent', 'f-child']);
    expect(plan.folders[1]?.parentId).toBe('remapped-parent');
    expect(plan.idMap.folders['f-parent']).toBe('remapped-parent');
  });

  it('keeps a join row whose other half is already here', () => {
    const source = data({
      links: [link('l-1', 'https://x.test')],
      tags: [{ id: 't-1', name: 'one' }],
      linkTags: [{ linkId: 'l-1', tagId: 't-1' }],
    });
    const plan = planImport({
      data: source,
      existing: existing({ tags: [{ id: 't-1', name: 'one' } as never] }),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });

    expect(plan.counts.tags).toBe(0);
    expect(plan.linkTags).toHaveLength(1);
  });

  it('does not write a join row that is already here', () => {
    const source = data({
      links: [link('l-1', 'https://x.test')],
      tags: [
        { id: 't-1', name: 'one' },
        { id: 't-2', name: 'two' },
      ],
      linkTags: [
        { linkId: 'l-1', tagId: 't-1' },
        { linkId: 'l-1', tagId: 't-2' },
      ],
    });
    const plan = planImport({
      data: source,
      existing: existing({
        links: [link('l-1', 'https://x.test')],
        tags: [
          { id: 't-1', name: 'one' } as never,
          { id: 't-2', name: 'two' } as never,
        ],
        linkTags: [{ linkId: 'l-1', tagId: 't-1' } as never],
      }),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });

    expect(plan.linkTags.map((row) => row.tagId)).toEqual(['t-2']);
  });

  it('drops a join row whose other half is not coming', () => {
    const source = data({
      links: [link('l-1', 'https://x.test')],
      linkTags: [{ linkId: 'l-1', tagId: 't-missing' }],
    });
    const plan = planImport({
      data: source,
      existing: existing({}),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(plan.linkTags).toEqual([]);
  });

  it('importing the same file twice writes nothing the second time', () => {
    const source = sampleData();
    // What the first import leaves behind is exactly the backup's own rows.
    const after = existing({
      folders: source.folders,
      links: source.links,
      tags: source.tags,
      notes: source.notes,
      linkTags: source.linkTags,
      noteLinks: source.noteLinks,
    });
    const plan = planImport({
      data: source,
      existing: after,
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(planTotal(plan)).toBe(0);
  });

  it('keeps this device’s preferences when there is already something here', () => {
    const plan = planImport({
      data: data({ settings: { ...sampleData().settings, themeMode: 'dark' } }),
      existing: existing({ links: [{ id: 'l-1' } as never] }),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(plan.settings).toBeNull();
    expect(plan.messages.join(' ')).toContain('preferences');
  });

  it('restores preferences into an empty vault', () => {
    const plan = planImport({
      data: data({ settings: { ...sampleData().settings, themeMode: 'dark' } }),
      existing: existing({}),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(plan.settings?.themeMode).toBe('dark');
  });

  it('drops remembered destinations that do not exist after the import', () => {
    const plan = planImport({
      data: data({
        folders: [folder('f-1', 'One')],
        settings: {
          ...sampleData().settings,
          lastFolderId: 'f-gone',
          recentFolderIds: ['f-1', 'f-gone'],
        },
      }),
      existing: existing({}),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(plan.settings?.lastFolderId).toBeNull();
    expect(plan.settings?.recentFolderIds).toEqual(['f-1']);
  });
});

describe('replace', () => {
  it('writes every row from the file, including ones that share an id', () => {
    const plan = planImport({
      data: sampleData(),
      existing: existing({
        folders: [{ id: 'f-work' } as never],
        links: [{ id: 'l-1' } as never],
      }),
      mode: 'replace',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });

    expect(plan.counts.folders).toBe(3);
    expect(plan.counts.links).toBe(4);
    expect(plan.skipped).toEqual({ folders: 0, links: 0, notes: 0, tags: 0 });
  });

  it('drops join rows whose partners are not in the file', () => {
    const plan = planImport({
      data: data({
        links: [link('l-1', 'https://x.test')],
        tags: [{ id: 't-1', name: 'one' }],
        linkTags: [
          { linkId: 'l-1', tagId: 't-1' },
          { linkId: 'l-gone', tagId: 't-1' },
        ],
      }),
      existing: existing({}),
      mode: 'replace',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(plan.linkTags).toHaveLength(1);
  });

  it('always applies the file’s preferences', () => {
    const plan = planImport({
      data: data({ settings: { ...sampleData().settings, themeMode: 'light' } }),
      existing: existing({ links: [{ id: 'l-1' } as never] }),
      mode: 'replace',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(plan.settings?.themeMode).toBe('light');
  });
});

describe('the keyring decision', () => {
  it('installs the backup’s key when this device has none', () => {
    const plan = planImport({
      data: data(),
      existing: existing({}),
      mode: 'merge',
      backupHasKeyring: true,
      deviceHasKeyring: false,
    });
    expect(plan.keyring).toBe('adopt');
    expect(plan.replacesKeyring).toBe(false);
  });

  it('installs the backup’s key on a replace, and says the passcode is changing', () => {
    // After a replace nothing local is left to orphan, so the backup's key is
    // strictly better: it is the only one that can open the rows arriving.
    const plan = planImport({
      data: data(),
      existing: existing({ links: [{ id: 'l-1' } as never] }),
      mode: 'replace',
      backupHasKeyring: true,
      deviceHasKeyring: true,
    });
    expect(plan.keyring).toBe('adopt');
    expect(plan.replacesKeyring).toBe(true);
  });

  it('keeps this device’s key on a merge, and warns that keys may differ', () => {
    const plan = planImport({
      data: data(),
      existing: existing({ links: [{ id: 'l-1' } as never] }),
      mode: 'merge',
      backupHasKeyring: true,
      deviceHasKeyring: true,
    });
    expect(plan.keyring).toBe('keep');
    expect(plan.messages.join(' ')).toContain('stay locked');
  });

  it('does not touch the keyring when the backup has none', () => {
    const plan = planImport({
      data: data(),
      existing: existing({ links: [{ id: 'l-1' } as never] }),
      mode: 'replace',
      backupHasKeyring: false,
      deviceHasKeyring: true,
    });
    expect(plan.keyring).toBe('keep');
  });
});

describe('properties that must hold for every plan', () => {
  const scenarios: Array<{ name: string; mode: 'merge' | 'replace'; existing: ExistingIndex }> = [
    { name: 'merge into an empty vault', mode: 'merge', existing: existing({}) },
    {
      name: 'merge over a vault that already has the backup in it',
      mode: 'merge',
      existing: existing({
        folders: sampleData().folders,
        links: sampleData().links,
        tags: sampleData().tags,
        notes: sampleData().notes,
      }),
    },
    { name: 'replace a populated vault', mode: 'replace', existing: existing({ links: [{ id: 'l-1' } as never] }) },
  ];

  for (const scenario of scenarios) {
    it(`produces no duplicate ids: ${scenario.name}`, () => {
      const source = sampleData();
      const plan = planImport({
        data: source,
        existing: scenario.existing,
        mode: scenario.mode,
        backupHasKeyring: false,
        deviceHasKeyring: false,
      });

      for (const [label, rows] of [
        ['folders', plan.folders],
        ['links', plan.links],
        ['notes', plan.notes],
        ['tags', plan.tags],
      ] as const) {
        const ids = rows.map((row) => row.id);
        expect(new Set(ids).size, `${label} has duplicate ids`).toBe(ids.length);
      }
    });

    it(`points every parent at something that will exist: ${scenario.name}`, () => {
      const source = sampleData();
      const plan = planImport({
        data: source,
        existing: scenario.existing,
        mode: scenario.mode,
        backupHasKeyring: false,
        deviceHasKeyring: false,
      });

      const folderIds = new Set([...scenario.existing.folderIds, ...plan.folders.map((row) => row.id)]);
      const noteIds = new Set([...scenario.existing.noteIds, ...plan.notes.map((row) => row.id)]);
      const linkIds = new Set([...scenario.existing.linkIds, ...plan.links.map((row) => row.id)]);
      const tagIds = new Set([...scenario.existing.tagIds, ...plan.tags.map((row) => row.id)]);

      for (const row of plan.folders) expect(row.parentId === null || folderIds.has(row.parentId)).toBe(true);
      for (const row of plan.notes) expect(row.parentNoteId === null || noteIds.has(row.parentNoteId)).toBe(true);
      for (const row of plan.links) expect(row.folderId === null || folderIds.has(row.folderId)).toBe(true);
      for (const row of plan.linkTags) {
        expect(linkIds.has(row.linkId)).toBe(true);
        expect(tagIds.has(row.tagId)).toBe(true);
      }
      for (const row of plan.noteLinks) {
        expect(noteIds.has(row.noteId)).toBe(true);
        expect(linkIds.has(row.linkId)).toBe(true);
      }
    });
  }
});

describe('a note whose parent exists only locally', () => {
  it('attaches to the local parent rather than being promoted to a root note', () => {
    const plan = planImport({
      data: data({ notes: [note('n-parent', 'Parent', ''), note('n-child', 'Child', '', 'n-parent')] }),
      existing: existing({ notes: [note('n-parent', 'Parent', '')] }),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]?.parentNoteId).toBe('n-parent');
  });
});

describe('counts for the confirmation screen', () => {
  it('total the rows that would actually be written', () => {
    const plan = planImport({
      data: data({
        folders: [folder('f-1', 'One')],
        links: [link('l-1', 'https://x.test', 'f-1', { createdAt: BASE_TIME })],
      }),
      existing: existing({}),
      mode: 'merge',
      backupHasKeyring: false,
      deviceHasKeyring: false,
    });
    expect(planTotal(plan)).toBe(2);
    expect(plan.counts).toEqual({ folders: 1, links: 1, tags: 0, notes: 0, linkTags: 0, noteLinks: 0 });
  });
});
