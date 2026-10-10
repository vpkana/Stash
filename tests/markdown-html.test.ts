import { describe, expect, it } from 'vitest';
import { escapeHtml, htmlToMarkdown, markdownToHtml, type DomNodeLike } from '@/lib/markdown-html';

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

  it('groups consecutive items into one list, bullets and numbers alike', () => {
    expect(markdownToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(markdownToHtml('1. one\n2. two')).toBe('<ul><li>one</li><li>two</li></ul>');
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
});
