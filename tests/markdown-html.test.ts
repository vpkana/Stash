import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  htmlToInlineMarkdown,
  htmlToMarkdown,
  markdownToHtml,
  type DomNodeLike,
} from '@/lib/markdown-html';

/**
 * The editor's Markdown ↔ HTML boundary.
 *
 * Both directions are pure, so both are testable here. The HTML → Markdown side
 * takes a structural node rather than a `Node` precisely so that the serialiser —
 * the half that decides what gets *stored* — can be tested without a DOM in the
 * test environment. The tests build trees the way a browser would report them, so
 * a change in the serialiser has to face the same shapes the editor produces.
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function text(value: string): DomNodeLike {
  return { nodeType: TEXT_NODE, textContent: value };
}

function el(tag: string, attrs: Record<string, string> = {}, ...children: DomNodeLike[]): DomNodeLike {
  return {
    nodeType: ELEMENT_NODE,
    nodeName: tag.toUpperCase(),
    childNodes: children,
    getAttribute: (name) => attrOf(attrs, name),
    // A real element derives its text from its children; a hand-built one has to
    // as well, or the shapes the serialiser reads would be quietly different from
    // the shapes the browser produces.
    textContent: children.map((child) => child.textContent ?? '').join('') || null,
  };
}

function attrOf(attrs: Record<string, string>, name: string): string | null {
  return Object.prototype.hasOwnProperty.call(attrs, name) ? (attrs[name] as string) : null;
}

/** A root container, the way `contentEditable` reports one. */
function root(...children: DomNodeLike[]): DomNodeLike {
  return el('div', {}, ...children);
}

describe('markdownToHtml', () => {
  it('escapes user text and never emits markup from it', () => {
    // A note is user content, so a note containing a tag is content too: the
    // renderer has no `dangerouslySetInnerHTML` and this is the equivalent rule
    // for the editor.
    const html = markdownToHtml('<script>alert(1)</script>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).not.toContain('<script>');
    expect(escapeHtml('a & b "c"')).toBe('a &amp; b &quot;c&quot;');
  });

  it('renders the inline formatting the toolbar produces', () => {
    expect(markdownToHtml('**bold** and *italic* and `code`')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
    );
  });

  it('renders headings, quotes, rules and fenced code', () => {
    expect(markdownToHtml('## Head')).toBe('<h2>Head</h2>');
    expect(markdownToHtml('> quoted')).toBe('<blockquote>quoted</blockquote>');
    expect(markdownToHtml('---')).toBe('<hr>');
    expect(markdownToHtml('```js\nconst a = 1;\n```')).toBe(
      '<pre><code data-language="js">const a = 1;</code></pre>',
    );
  });

  it('groups consecutive items into one list, and keeps a numbered list numbered', () => {
    expect(markdownToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    // Not a `<ul>`: a numbered list reopened in the editor used to come back as
    // bullets, which is what made numbers "turn into dots" between sessions.
    expect(markdownToHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(markdownToHtml('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it('closes and reopens a list when its kind changes', () => {
    expect(markdownToHtml('- bullet\n1. number')).toBe(
      '<ul><li>bullet</li></ul><ol><li>number</li></ol>',
    );
  });

  it('marks a checklist item on the item, not in its text', () => {
    expect(markdownToHtml('- [x] done\n- [ ] todo')).toBe(
      '<ul><li data-checkbox="x">done</li><li data-checkbox=" ">todo</li></ul>',
    );
  });

  it('keeps a link as an anchor with the address escaped', () => {
    expect(markdownToHtml('[site](https://example.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2">site</a></p>',
    );
  });

  it('autolinks a bare host, so an address typed without a scheme is a link', () => {
    // This is what makes the editor's own autolinking work at rest: the note is
    // opened from Markdown, and the address the user typed is already an anchor
    // before a caret ever touches it.
    expect(markdownToHtml('read google.com now')).toBe(
      '<p>read <a href="https://google.com">google.com</a> now</p>',
    );
  });
});

describe('htmlToMarkdown', () => {
  it('serialises the tags the editor writes', () => {
    expect(
      htmlToMarkdown(
        root(
          el('p', {}, text('a '), el('strong', {}, text('bold')), text(' and '), el('em', {}, text('italic'))),
        ),
      ),
    ).toBe('a **bold** and *italic*');
  });

  it('serialises lists, including a numbered one that does not start at one', () => {
    expect(htmlToMarkdown(root(el('ul', {}, el('li', {}, text('one')), el('li', {}, text('two')))))).toBe(
      '- one\n- two',
    );
    expect(
      htmlToMarkdown(root(el('ol', { start: '3' }, el('li', {}, text('three')), el('li', {}, text('four'))))),
    ).toBe('3. three\n4. four');
  });

  it('round-trips a checklist back to source, marker and all', () => {
    expect(
      htmlToMarkdown(
        root(
          el(
            'ul',
            {},
            el('li', { 'data-checkbox': 'x' }, text('done')),
            el('li', { 'data-checkbox': ' ' }, text('todo')),
          ),
        ),
      ),
    ).toBe('- [x] done\n- [ ] todo');
  });

  it('separates blocks with a blank line and keeps headings, quotes and code', () => {
    expect(
      htmlToMarkdown(
        root(
          el('h2', {}, text('Head')),
          el('p', {}, text('Body')),
          el('blockquote', {}, el('p', {}, text('quoted'))),
          el('pre', {}, el('code', { 'data-language': 'js' }, text('const a = 1;\n'))),
          el('hr'),
        ),
      ),
    ).toBe('## Head\n\nBody\n\n> quoted\n\n```js\nconst a = 1;\n```\n\n---');
  });

  it('drops markup it did not write instead of storing it', () => {
    // A pasted `<span style>` and a pasted `<img onerror>` both become plain text:
    // the serialiser never re-emits a tag it does not understand, so an attribute
    // cannot survive a round trip into the database.
    expect(htmlToMarkdown(root(el('p', {}, el('span', { style: 'color:red' }, text('plain')), el('img', { src: 'x', onerror: 'evil()' }))))).toBe(
      'plain',
    );
    expect(htmlToMarkdown(root(el('p', {}, el('script', {}, text('alert(1)')), text('safe'))))).toBe('safe');
  });

  it('keeps only web links, turning anything else into plain text', () => {
    expect(htmlToMarkdown(root(el('p', {}, el('a', { href: 'https://example.com' }, text('site')))))).toBe(
      '[site](https://example.com)',
    );
    expect(htmlToMarkdown(root(el('p', {}, el('a', { href: 'javascript:evil()' }, text('click')))))).toBe(
      'click',
    );
  });

  it('writes an address that is its own label back as the address', () => {
    // Autolinking produces an anchor whose text *is* the address, and the reader
    // links that text again by itself. Storing `[https://x](https://x)` would be
    // the same link wrapped in markup the user never wrote — and a link whose
    // words say something else still keeps the bracket form, because there the
    // label is content.
    expect(
      htmlToMarkdown(root(el('p', {}, el('a', { href: 'https://google.com' }, text('https://google.com'))))),
    ).toBe('https://google.com');
    expect(
      htmlToMarkdown(root(el('p', {}, el('a', { href: 'https://google.com' }, text('google.com'))))),
    ).toBe('https://google.com');
    expect(htmlToMarkdown(root(el('p', {}, el('a', { href: 'https://google.com' }, text('Google')))))).toBe(
      '[Google](https://google.com)',
    );
  });

  it('keeps a reference to a subnote, and drops every other scheme', () => {
    // `#note=<id>` is the in-body reference the Note button beside the title
    // inserts at the caret. It has to survive a save, or the reference would
    // become plain text the first time the note was reopened.
    expect(htmlToMarkdown(root(el('p', {}, el('a', { href: '#note=abc123' }, text('Plan')))))).toBe(
      '[Plan](#note=abc123)',
    );
    // A `#`-anchor that is not a reference is not a Stash reference.
    expect(htmlToMarkdown(root(el('p', {}, el('a', { href: '#section' }, text('Down')))))).toBe('Down');
  });

  it('keeps inline formatting that sits directly in the editable root', () => {
    // Pressing Bold on an empty note puts the wrapper at the top level — there is
    // no paragraph to wrap, so the wrapper *is* the paragraph. Serialising it as a
    // container would drop the formatting and store the note as plain text.
    expect(htmlToMarkdown(root(el('b', {}, text('bold'))))).toBe('**bold**');
    expect(htmlToMarkdown(root(el('i', {}, text('it')), el('b', {}, text('bold'))))).toBe(
      '*it*\n\n**bold**',
    );
    expect(htmlToMarkdown(root(el('del', {}, text('gone'))))).toBe('~~gone~~');
  });

  it('keeps loose text beside a formatted run on the same line', () => {
    // Pressing Bold a second time steps the caret *out* of the wrapper, so what
    // the user types next is a bare text node beside a `<b>` at the top level.
    // Serialising each child as its own paragraph put a blank line in the middle
    // of the sentence — the "messed lines" a reopened note showed.
    expect(htmlToMarkdown(root(el('b', {}, text('Bold')), text(' plain')))).toBe('**Bold** plain');
    expect(htmlToMarkdown(root(text('plain '), el('i', {}, text('it'))))).toBe('plain *it*');
    // A whole sentence with two toggles in it is still one paragraph.
    expect(
      htmlToMarkdown(
        root(
          el('b', {}, text('one')),
          text(' two '),
          el('i', {}, text('three')),
          text(' four'),
        ),
      ),
    ).toBe('**one** two *three* four');
  });

  it('never stores the invisible character the editor uses as a caret carrier', () => {
    // Bold with no selection arms the format by inserting an empty `<b>` holding a
    // zero-width space (see `toggleTypingStyle`). It is there so the caret has
    // somewhere to sit; it must not reach the note.
    const carrier = `\u200b`;
    expect(htmlToMarkdown(root(el('p', {}, el('b', {}, text(`a${carrier}`)))))).toBe('**a**');
    expect(htmlToMarkdown(root(el('p', {}, el('b', {}, text(carrier)))))).toBe('');
    expect(htmlToMarkdown(root(el('p', {}, text(`hel${carrier}lo`))))).toBe('hello');
  });

  it('splits a `<div>` holding blocks rather than serialising its text twice', () => {
    // Browsers wrap loose content in a `<div>` after a stray Enter at the end of a
    // list, so this shape is on the hot path: the wrapper contributes only what is
    // directly inside it.
    expect(
      htmlToMarkdown(root(el('div', {}, el('p', {}, text('first')), el('p', {}, text('second'))))),
    ).toBe('first\n\nsecond');
  });

  it('ignores empty paragraphs rather than storing blank blocks', () => {
    expect(htmlToMarkdown(root(el('p', {}, text('one')), el('p', {}, el('br')), el('p', {}, text('two'))))).toBe(
      'one\n\ntwo',
    );
  });
});

describe('the two directions agree', () => {
  it('is stable: markdown -> html -> markdown keeps the meaning', () => {
    const source = [
      '## Plan',
      '',
      'A paragraph with **bold**, *italic* and `code`.',
      '',
      '- one',
      '- [x] done',
      '',
      '> a quote',
    ].join('\n');

    const once = markdownToHtml(source);
    // Rendered through a browser the markup would come back as a tree; here the
    // equality that matters is that rendering the same source twice produces the
    // same markup, so the editor never sees the document change under it.
    expect(markdownToHtml(source)).toBe(once);
    for (const fragment of ['<h2>Plan</h2>', '<strong>bold</strong>', '<em>italic</em>', '<li data-checkbox="x">done</li>']) {
      expect(once).toContain(fragment);
    }
  });

  it('keeps a numbered list numbered', () => {
    expect(markdownToHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(htmlToMarkdown(markdownToHtmlTree('1. one\n2. two'))).toBe('1. one\n2. two');
  });

  it('round-trips italic inside bold without leaving asterisks behind', () => {
    /*
     * The reported bug: bold a sentence, italicise a word in it, reopen the note —
     * and asterisks appeared in text that was never typed with any. The flat
     * inline parser could not nest, so it ended the bold at the first `*` of the
     * italic and rendered the surplus markers as text.
     */
    const html = '<p><strong>a <em>b</em> c</strong></p>';
    const tree = root(el('p', {}, el('strong', {}, text('a '), el('em', {}, text('b')), text(' c'))));
    const markdown = htmlToMarkdown(tree);
    expect(markdown).toBe('**a _b_ c**');
    expect(markdownToHtml(markdown)).toBe(html);
    expect(markdown).not.toContain('* *');
  });

  it('round-trips bold inside italic too', () => {
    const markdown = htmlToMarkdown(
      root(el('p', {}, el('em', {}, text('a '), el('strong', {}, text('b')), text(' c')))),
    );
    expect(markdown).toBe('*a __b__ c*');
    expect(markdownToHtml(markdown)).toBe('<p><em>a <strong>b</strong> c</em></p>');
  });

  it('reads the triple marker as bold and italic at once', () => {
    expect(markdownToHtml('***both***')).toBe('<p><strong><em>both</em></strong></p>');
  });

  it('serialises a one-line fragment as inline markdown, not as paragraphs', () => {
    // The note title is a single line: running it through `htmlToMarkdown` would
    // put a blank line between `**Design**` and `notes`, because a block walker
    // separates every top-level node.
    expect(
      htmlToInlineMarkdown(
        root(el('strong', {}, text('Design')), text(' notes with '), el('em', {}, text('care'))),
      ),
    ).toBe('**Design** notes with *care*');
  });
});

/** `markdownToHtml` output as a tree, so the other direction can be exercised. */
function markdownToHtmlTree(markdown: string) {
  // The link/list cases here contain no inline markup, so a deliberately small
  // parse is enough to hand `htmlToMarkdown` the shapes the editor produces.
  const blocks = markdown.split('\n').filter(Boolean).map((line) => {
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) return { type: 'li', text: ordered[2] ?? '' } as const;
    return { type: 'p', text: line } as const;
  });
  const listItems = blocks.filter((block) => block.type === 'li');
  const paragraphs = blocks.filter((block) => block.type === 'p');
  return root(
    ...paragraphs.map((block) => el('p', {}, text(block.text))),
    ...(listItems.length > 0
      ? [el('ol', {}, ...listItems.map((item) => el('li', {}, text(item.text))))]
      : []),
  );
}
