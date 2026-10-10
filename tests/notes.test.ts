import { describe, expect, it } from 'vitest';
import type { Note } from '@/db/types';
import {
  MAX_NOTE_DEPTH,
  canMoveNote,
  flattenNotes,
  hasSiblingNoteWithTitle,
  noteMaxDepth,
  noteBreadcrumb,
  noteDeletionImpact,
  noteDepth,
  noteDescendantIds,
  noteChildren,
  nextNoteSortOrder,
} from '@/lib/tree';
import {
  contentFromLink,
  deriveNoteTitle,
  notePlainText,
  notePreview,
  sanitizeNoteTitle,
  titleFromLink,
  visibleNotes,
} from '@/lib/notes';
import {
  checklistProgress,
  continueList,
  insertLink,
  noteWordCount,
  parseMarkdown,
  renderInline,
  toggleChecklistItem,
  toggleLinePrefix,
  wrapSelection,
} from '@/lib/markdown';
import { AutosaveController, autosaveLabel } from '@/lib/autosave';

/** Build a note with sensible defaults for pure tests. */
function note(id: string, title: string, parentNoteId: string | null, sortOrder = 0, extra: Partial<Note> = {}): Note {
  return {
    id,
    parentNoteId,
    title,
    content: '',
    createdAt: 1,
    updatedAt: 1,
    sortOrder,
    isFavorite: false,
    isArchived: false,
    isLocked: false,
    ...extra,
  };
}

/**
 * The exact tree from the product brief, as notes.
 *
 * Machine Learning
 * ├── Regression
 * │     ├── Linear Regression
 * │     ├── Logistic Regression
 * │     └── Important Formulas
 * ├── SVM
 * │     ├── Intuition
 * │     └── Exam Questions
 * └── Neural Networks
 */
const ML = note('ml', 'Machine Learning', null, 0);
const REGRESSION = note('reg', 'Regression', 'ml', 0);
const SVM = note('svm', 'SVM', 'ml', 1);
const NN = note('nn', 'Neural Networks', 'ml', 2);
const LINEAR = note('lin', 'Linear Regression', 'reg', 0);
const LOGISTIC = note('log', 'Logistic Regression', 'reg', 1);
const FORMULAS = note('frm', 'Important Formulas', 'reg', 2);
const INTUITION = note('int', 'Intuition', 'svm', 0);
const EXAM = note('exm', 'Exam Questions', 'svm', 1);

const TREE: Note[] = [ML, REGRESSION, SVM, NN, LINEAR, LOGISTIC, FORMULAS, INTUITION, EXAM];

describe('note tree traversal', () => {
  it('finds root notes and direct children', () => {
    expect(noteChildren(TREE, null).map((n) => n.id)).toEqual(['ml']);
    expect(noteChildren(TREE, 'ml').map((n) => n.id)).toEqual(['reg', 'svm', 'nn']);
    expect(noteChildren(TREE, 'reg').map((n) => n.id)).toEqual(['lin', 'log', 'frm']);
  });

  it('orders siblings by sortOrder then title', () => {
    const shuffled: Note[] = [
      note('b', 'Banana', null, 1),
      note('a', 'Apple', null, 1),
      note('c', 'Cherry', null, 0),
    ];
    expect(noteChildren(shuffled, null).map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('walks ancestors for breadcrumbs', () => {
    const trail = noteBreadcrumb(TREE, 'lin').map((n) => n.title);
    expect(trail).toEqual(['Machine Learning', 'Regression', 'Linear Regression']);
  });

  it('survives a corrupt cycle without hanging', () => {
    const corrupt: Note[] = [note('a', 'A', 'b'), note('b', 'B', 'a')];
    expect(noteBreadcrumb(corrupt, 'a')).toHaveLength(2);
    expect(noteDescendantIds(corrupt, 'a')).toEqual(['b']);
  });

  it('collects descendants at any depth', () => {
    expect(noteDescendantIds(TREE, 'ml').sort()).toEqual(
      ['reg', 'svm', 'nn', 'lin', 'log', 'frm', 'int', 'exm'].sort(),
    );
    expect(noteDescendantIds(TREE, 'lin')).toEqual([]);
  });

  it('computes depth and flattens with indentation', () => {
    expect(noteDepth(TREE, 'lin')).toBe(2);
    expect(noteMaxDepth(TREE)).toBe(2);

    const flat = flattenNotes(TREE);
    expect(flat.find((entry) => entry.node.id === 'svm')?.depth).toBe(1);
    expect(flat.find((entry) => entry.node.id === 'int')?.depth).toBe(2);
    expect(flat.find((entry) => entry.node.id === 'lin')?.path).toBe(
      'Machine Learning → Regression → Linear Regression',
    );
  });

  it('computes the next sort order among siblings', () => {
    expect(nextNoteSortOrder(TREE, 'reg')).toBe(3);
    expect(nextNoteSortOrder(TREE, null)).toBe(1);
  });
});

describe('move rules', () => {
  it('rejects moving a note into itself or its own subtree', () => {
    expect(canMoveNote(TREE, 'ml', 'ml').ok).toBe(false);
    expect(canMoveNote(TREE, 'ml', 'reg').ok).toBe(false);
    // Exam Questions sits inside SVM's subtree.
    expect(canMoveNote(TREE, 'svm', 'exm').ok).toBe(false);
  });

  it('allows legal moves and rejects missing parents', () => {
    expect(canMoveNote(TREE, 'nn', 'reg').ok).toBe(true);
    expect(canMoveNote(TREE, 'nn', 'ghost').ok).toBe(false);
    expect(canMoveNote(TREE, 'lin', null).ok).toBe(true);
  });

  it('enforces the depth guard rail', () => {
    // A chain of MAX_NOTE_DEPTH notes: n0 sits at depth 0, n23 at depth 23.
    const chain: Note[] = [];
    let parent: string | null = null;
    for (let level = 0; level < MAX_NOTE_DEPTH; level += 1) {
      const id = `n${level}`;
      chain.push(note(id, `N${level}`, parent, 0));
      parent = id;
    }
    const nodes = [...chain];

    // Under the deepest node the tree is already at the cap.
    expect(canMoveNote(nodes, 'extra', 'n23').ok).toBe(false);
    // One level up there is still room.
    expect(canMoveNote(nodes, 'extra', 'n22').ok).toBe(true);
  });
});

describe('sibling duplicate check', () => {
  it('is case-insensitive and scoped to one parent', () => {
    expect(hasSiblingNoteWithTitle(TREE, 'ml', 'regression')).toBe(true);
    expect(hasSiblingNoteWithTitle(TREE, null, 'regression')).toBe(false);
    expect(hasSiblingNoteWithTitle(TREE, 'ml', 'Regression', 'reg')).toBe(false);
  });
});

describe('deletion impact', () => {
  const linksByNote = new Map<string, string[]>([
    ['lin', ['link-1']],
    ['frm', ['link-2', 'link-1']],
  ]);

  it('counts descendants and referenced links without double-counting', () => {
    const impact = noteDeletionImpact(TREE, linksByNote, 'reg');
    expect(impact).not.toBeNull();
    expect(impact!.descendantNoteCount).toBe(3);
    expect(impact!.childNoteCount).toBe(3);
    // link-1 referenced twice but counted once.
    expect(impact!.referencedLinkCount).toBe(2);
    expect(impact!.newParentId).toBe('ml');
  });

  it('reports where keep-children would promote to', () => {
    const impact = noteDeletionImpact(TREE, linksByNote, 'lin');
    expect(impact!.childNoteCount).toBe(0);
    expect(impact!.newParentId).toBe('reg');
  });
});

describe('visible notes', () => {
  it('keeps a note carrying the legacy archive flag, and its whole subtree', () => {
    // This is the regression guard for the bug that lost links and notes: the
    // flag used to remove a row and its descendants from every browsing surface.
    // It hides nothing now.
    const withFlag = TREE.map((n) => (n.id === 'reg' ? { ...n, isArchived: true } : n));
    const ids = new Set(visibleNotes(withFlag).map((n) => n.id));
    expect(ids.has('reg')).toBe(true);
    expect(ids.has('lin')).toBe(true);
    expect(ids.has('frm')).toBe(true);
    expect(ids.has('svm')).toBe(true);
  });

  it('returns everything, flagged or not', () => {
    expect(visibleNotes(TREE)).toHaveLength(TREE.length);
    const allFlagged = TREE.map((n) => ({ ...n, isArchived: true }));
    expect(visibleNotes(allFlagged)).toHaveLength(TREE.length);
  });
});

describe('title derivation', () => {
  it('derives a title from the first meaningful content line', () => {
    expect(deriveNoteTitle('# Heading first', 'fb')).toBe('Heading first');
    expect(deriveNoteTitle('- [x] done task', 'fb')).toBe('done task');
    expect(deriveNoteTitle('3. numbered item', 'fb')).toBe('numbered item');
    expect(deriveNoteTitle('> quoted thought', 'fb')).toBe('quoted thought');
    expect(deriveNoteTitle('', 'fb')).toBe('fb');
    expect(deriveNoteTitle('\n\n   \n', 'fb')).toBe('fb');
  });

  it('sanitizes whitespace and caps length', () => {
    expect(sanitizeNoteTitle('  spaced   out  ')).toBe('spaced out');
    expect(sanitizeNoteTitle('x'.repeat(500))).toHaveLength(120);
  });
});

describe('plain text projection', () => {
  it('strips markdown decorations', () => {
    const text = notePlainText('# Title\n\n- [ ] **bold** task\n- item `code`\n\nSee [docs](https://x.y)');
    expect(text).toContain('Title');
    expect(text).toContain('bold task');
    expect(text).toContain('item code');
    expect(text).toContain('See docs');
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
    expect(text).not.toContain('[');
  });
});

describe('previews', () => {
  it('falls back to subnote counts so parents do not read as empty', () => {
    expect(notePreview('', 3)).toBe('3 subnotes');
    expect(notePreview('', 1)).toBe('1 subnote');
    expect(notePreview('', 0)).toBe('Empty note');
    expect(notePreview('Real content', 2)).toBe('Real content');
  });
});

describe('note from link', () => {
  const link = {
    id: 'l1',
    folderId: null,
    url: 'https://youtube.com/watch?v=1',
    normalizedUrl: 'https://youtube.com/watch?v=1',
    title: 'Binary Search Explained',
    userNote: 'Watch before the interview',
    source: 'youtube.com',
    createdAt: 1,
    updatedAt: 1,
    isFavorite: false,
    isArchived: false,
    isLocked: false,
  };

  it('titles from link title, source label, then the URL', () => {
    expect(titleFromLink(link)).toBe('Binary Search Explained');
    expect(titleFromLink({ ...link, title: undefined })).toBe('YouTube');
    expect(titleFromLink({ ...link, title: undefined, source: undefined })).toContain('youtube.com');
  });

  it('seeds content with a markdown link and carries the user note', () => {
    const content = contentFromLink(link);
    expect(content).toContain('[Binary Search Explained](https://youtube.com/watch?v=1)');
    expect(content).toContain('Watch before the interview');
  });

  it('omits the URL when asked and is empty for a bare link', () => {
    expect(contentFromLink(link, { includeLinkUrl: false })).toBe('Watch before the interview\n');
    expect(contentFromLink({ ...link, userNote: undefined }, { includeLinkUrl: false })).toBe('');
  });
});

describe('markdown blocks', () => {
  it('parses headings, paragraphs and dividers', () => {
    const blocks = parseMarkdown('# H1\n\nPara\n\n---\n\n###### H6');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'divider', 'heading']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'H1' });
    expect(blocks[3]).toMatchObject({ kind: 'heading', level: 6 });
  });

  it('groups consecutive bullets into one list', () => {
    const blocks = parseMarkdown('- a\n- b\n\ntext\n- c');
    const lists = blocks.filter((b) => b.kind === 'list');
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({ ordered: false });
    const first = lists[0];
    if (first?.kind === 'list') expect(first.items.map((i) => i.text)).toEqual(['a', 'b']);
  });

  it('reads ordered lists with their start number', () => {
    const blocks = parseMarkdown('3. three\n4. four');
    const list = blocks[0];
    expect(list).toMatchObject({ kind: 'list', ordered: true, start: 3 });
    if (list?.kind === 'list') expect(list.items).toHaveLength(2);
  });

  it('reads checkboxes including their state and line numbers', () => {
    const source = '# Day plan\n- [ ] buy milk\n- [x] ship feature';
    const list = parseMarkdown(source)[1];
    expect(list?.kind).toBe('list');
    if (list?.kind === 'list') {
      expect(list.items.map((i) => i.checked)).toEqual([false, true]);
      expect(list.items.map((i) => i.line)).toEqual([1, 2]);
    }
  });

  it('captures fenced code with its language', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\n```');
    expect(blocks[0]).toMatchObject({ kind: 'code', language: 'ts', code: 'const x = 1;' });
  });

  it('parses quotes', () => {
    expect(parseMarkdown('> deep thought')[0]).toMatchObject({ kind: 'quote', text: 'deep thought' });
  });
});

describe('inline markdown', () => {
  it('classifies emphasis, code and links', () => {
    const nodes = renderInline('plain **bold** *italic* `code` ~~gone~~');
    expect(nodes.map((n) => n.type)).toEqual([
      'text',
      'bold',
      'text',
      'italic',
      'text',
      'code',
      'text',
      'strike',
    ]);
  });

  it('recognises bare urls and labelled links', () => {
    const bare = renderInline('see https://example.com/a now');
    expect(bare[1]).toMatchObject({ type: 'link', href: 'https://example.com/a' });

    const labelled = renderInline('[label](https://example.com/a)');
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toMatchObject({ type: 'link', value: 'label' });
  });

  it('lets code spans protect their contents', () => {
    const nodes = renderInline('`**not bold**`');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: 'code', value: '**not bold**' });
  });
});

describe('checklist interaction', () => {
  it('toggles exactly the tapped line', () => {
    const source = '- [ ] first\n- [ ] second\n- [ ] third';
    const updated = toggleChecklistItem(source, 1);
    expect(updated.split('\n')[1]).toBe('- [x] second');
    expect(updated.split('\n')[0]).toBe('- [ ] first');
    // Toggling back restores it.
    expect(toggleChecklistItem(updated, 1).split('\n')[1]).toBe('- [ ] second');
  });

  it('ignores lines that are not checklist items', () => {
    const source = '- plain\nparagraph';
    expect(toggleChecklistItem(source, 1)).toBe(source);
  });

  it('computes progress', () => {
    expect(checklistProgress('- [x] a\n- [ ] b\n- [x] c')).toEqual({ done: 2, total: 3 });
    expect(checklistProgress('no checkboxes')).toBeNull();
  });
});

describe('editor edits', () => {
  it('wraps the selection and places the caret inside for empty selections', () => {
    const wrapped = wrapSelection('hello world', { start: 0, end: 5 }, '**');
    expect(wrapped.text).toBe('**hello** world');
    expect(wrapped.selectionStart).toBe(2);
    expect(wrapped.selectionEnd).toBe(7);

    const caret = wrapSelection('ab', { start: 1, end: 1 }, '**');
    expect(caret.text).toBe('a****b');
    // The caret sits between the two markers, ready for typing.
    expect(caret.selectionStart).toBe(3);
  });

  it('toggles headings on and off', () => {
    const on = toggleLinePrefix('Hello', { start: 0, end: 5 }, '## ');
    expect(on.text).toBe('## Hello');
    expect(toggleLinePrefix(on.text, { start: 0, end: on.text.length }, '## ').text).toBe('Hello');
  });

  it('replaces a competing prefix instead of stacking prefixes', () => {
    expect(toggleLinePrefix('## Head', { start: 0, end: 7 }, '# ').text).toBe('# Head');
    expect(toggleLinePrefix('- item', { start: 0, end: 6 }, '- [ ] ').text).toBe('- [ ] item');
    expect(toggleLinePrefix('1. ordered', { start: 0, end: 10 }, '- ').text).toBe('- ordered');
  });

  it('inserts markdown links using the selection as label', () => {
    const result = insertLink('go here now', { start: 3, end: 7 }, 'https://example.com');
    expect(result.text).toBe('go [here](https://example.com) now');
    // The caret lands just after the inserted link, before the trailing text.
    expect(result.selectionStart).toBe('go [here](https://example.com)'.length);
  });

  it('continues lists on Enter and ends them on an empty item', () => {
    const bullet = continueList('- first', { start: 7, end: 7 });
    expect(bullet.text).toBe('- first\n- ');

    const ordered = continueList('3. third', { start: 8, end: 8 });
    expect(ordered.text).toBe('3. third\n4. ');

    const checklist = continueList('- [ ] task', { start: 10, end: 10 });
    expect(checklist.text).toBe('- [ ] task\n- [ ] ');

    const endsList = continueList('- ', { start: 2, end: 2 });
    expect(endsList.text).toBe('');
  });

  it('counts words', () => {
    expect(noteWordCount('one two  three\nfour')).toBe(4);
    expect(noteWordCount('   ')).toBe(0);
  });
});

describe('autosave controller', () => {
  /** Deterministic fake clock + timers so debounce behaviour is exact. */
  function makeHost() {
    let now = 0;
    let nextHandle = 1;
    const timers = new Map<number, { at: number; handler: () => void }>();
    return {
      now: () => now,
      setTimer: (handler: () => void, ms: number) => {
        const handle = nextHandle++;
        timers.set(handle, { at: now + ms, handler });
        return handle;
      },
      clearTimer: (handle: number) => {
        timers.delete(handle);
      },
      advance: (ms: number) => {
        const target = now + ms;
        // Fire in time order, allowing handlers to schedule more timers.
        for (;;) {
          const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
          const next = due[0];
          if (!next) break;
          timers.delete(next[0]);
          now = next[1].at;
          next[1].handler();
        }
        now = target;
      },
      pending: () => timers.size,
    };
  }

  it('debounces bursts of typing into one save', async () => {
    const host = makeHost();
    const saves: string[] = [];
    const controller = new AutosaveController<string>(
      {
        save: async (value) => {
          saves.push(value);
        },
        delayMs: 100,
      },
      host,
    );

    controller.schedule('h');
    host.advance(50);
    controller.schedule('he');
    host.advance(50);
    controller.schedule('hel');
    expect(saves).toEqual([]); // nothing persisted while the user keeps typing
    host.advance(100);
    await controller.flush();
    expect(saves).toEqual(['hel']);
  });

  it('persists at the max-delay bound even during continuous typing', async () => {
    const host = makeHost();
    const saves: string[] = [];
    const controller = new AutosaveController<string>(
      {
        save: async (value) => {
          saves.push(value);
        },
        delayMs: 300,
        maxDelayMs: 500,
      },
      host,
    );

    // Typing every 200ms never lets the 300ms debounce expire on its own,
    // but the 500ms cap forces a write once the first keystroke is that old.
    controller.schedule('a');
    host.advance(200);
    controller.schedule('ab');
    host.advance(200);
    controller.schedule('abc');
    expect(saves).toEqual([]);
    host.advance(200); // 600ms since 'a' -- past the cap, save fires at 500ms
    await controller.flush();
    expect(saves).toEqual(['abc']);
  });

  it('flush persists the newest value and reports status', async () => {
    const host = makeHost();
    const statuses: string[] = [];
    const controller = new AutosaveController<string>(
      {
        save: async () => undefined,
        delayMs: 50,
        onStatus: (status) => {
          statuses.push(status);
        },
      },
      host,
    );
    controller.schedule('draft');
    await controller.flush();
    expect(controller.getLastSavedAt()).not.toBeNull();
    expect(statuses).toContain('saving');
    expect(statuses).toContain('saved');
    expect(controller.hasPendingWork()).toBe(false);
  });

  it('keeps the value and reports an error when storage fails', async () => {
    const host = makeHost();
    let shouldFail = true;
    const attempts: string[] = [];
    const controller = new AutosaveController<string>(
      {
        save: async (value) => {
          attempts.push(value);
          if (shouldFail) throw new Error('quota');
        },
        delayMs: 50,
      },
      host,
    );

    controller.schedule('lost?');
    await controller.flush();
    expect(controller.getStatus()).toBe('error');
    expect(controller.hasPendingWork()).toBe(true);
    expect(attempts).toEqual(['lost?']); // tried exactly once, no infinite spin

    // The next edit retries the write through the normal path.
    shouldFail = false;
    controller.schedule('lost?');
    await controller.flush();
    expect(attempts).toEqual(['lost?', 'lost?']);
    expect(controller.getStatus()).toBe('saved');
  });

  it('a newer value typed during a failed write is preserved', async () => {
    const host = makeHost();
    let shouldFail = true;
    const attempts: string[] = [];
    const controller = new AutosaveController<string>(
      {
        save: async (value) => {
          attempts.push(value);
          if (shouldFail) throw new Error('quota');
        },
        delayMs: 50,
      },
      host,
    );

    controller.schedule('first');
    host.advance(50); // triggers flush -> fails
    controller.schedule('second'); // typed while the failed write was in flight
    host.advance(50);

    await controller.flush();
    shouldFail = false;
    await controller.flush();
    expect(attempts[attempts.length - 1]).toBe('second');
    expect(controller.getStatus()).toBe('saved');
  });

  it('does not save after dispose', () => {
    const host = makeHost();
    const saves: string[] = [];
    const controller = new AutosaveController<string>(
      {
        save: async (value) => {
          saves.push(value);
        },
        delayMs: 50,
      },
      host,
    );
    controller.schedule('x');
    controller.dispose();
    host.advance(500);
    expect(saves).toEqual([]);
  });

  it('labels statuses quietly', () => {
    expect(autosaveLabel('pending')).toBe('Saving…');
    expect(autosaveLabel('saving')).toBe('Saving…');
    expect(autosaveLabel('saved')).toBe('Saved');
    expect(autosaveLabel('error')).toBe('Not saved');
    expect(autosaveLabel('idle')).toBe('');
  });
});
