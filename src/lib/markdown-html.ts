/**
 * Markdown ↔ HTML, for the editor.
 *
 * ## Why this exists
 *
 * The editor used to be a `<textarea>` showing the Markdown source, and the
 * toolbar inserted `**` around the selection. That is a perfectly good Markdown
 * editor and a terrible *formatting* editor: the user pressed Bold and watched two
 * asterisks appear in the middle of a sentence. The brief for this change says it
 * plainly — bold has to look bold — so the editor became a rich one.
 *
 * The storage format is deliberately **still Markdown**. Notes carry their own
 * content in a form that outlives this app: it exports cleanly, diffs cleanly,
 * pastes into anything, and is readable in a database viewer. A rich editor that
 * stored its own document tree would trade all of that for nothing the user can
 * see. So this module is the boundary: Markdown goes in, HTML is rendered to be
 * edited, and HTML comes back out as Markdown on every keystroke.
 *
 * ## Safety
 *
 * `markdownToHtml` **escapes** every character of user text and only ever emits
 * tags from a fixed list, so a note cannot inject markup — the same guarantee the
 * renderer gives by building React elements rather than an HTML string. The escape
 * happens in one function, `escapeHtml`, and every text node passes through it.
 *
 * `htmlToMarkdown` is the other direction and is defensive in the opposite way: it
 * never emits an attribute or a tag verbatim. Anything it does not recognise is
 * unwrapped to its text, so pasted formatting cannot smuggle an `<img onerror>`
 * into a note by surviving a round trip.
 */

import { parseMarkdown, renderInline, type HeadingLevel, type MarkdownBlock } from './markdown';

// ---------------------------------------------------------------------------
// Markdown -> HTML
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ESCAPES[character] ?? character);
}

/** Inline spans, as HTML. Bold, italic, strike, code and links. */
export function inlineToHtml(text: string): string {
  return renderInline(text)
    .map((node) => {
      switch (node.type) {
        case 'bold':
          return `<strong>${escapeHtml(node.value)}</strong>`;
        case 'italic':
          return `<em>${escapeHtml(node.value)}</em>`;
        case 'strike':
          return `<del>${escapeHtml(node.value)}</del>`;
        case 'code':
          return `<code>${escapeHtml(node.value)}</code>`;
        case 'link':
          return `<a href="${escapeHtml(node.href)}">${escapeHtml(node.value)}</a>`;
        case 'text':
        default:
          return escapeHtml(node.value);
      }
    })
    .join('');
}

/**
 * Markdown source as an editable HTML fragment.
 *
 * The list-item indent is carried on a `data-indent` attribute rather than as a
 * nested `<ul>`, because nesting is what makes `execCommand`'s list handling
 * unpredictable and it is only representable when the indentation is well formed.
 * An attribute round-trips exactly and cannot be half-right.
 */
export function markdownToHtml(source: string): string {
  const blocks = parseMarkdown(source);
  const html: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const block of blocks) {
    if (block.kind !== 'list') closeList();
    html.push(blockToHtml(block, () => inList, () => (inList = true)));
  }
  closeList();

  return html.join('');
}

function blockToHtml(block: MarkdownBlock, isOpen: () => boolean, open: () => void): string {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(3, Math.max(1, block.level)) as HeadingLevel;
      return `<h${level}>${inlineToHtml(block.text)}</h${level}>`;
    }

    case 'paragraph':
      return `<p>${inlineToHtml(block.text)}</p>`;

    case 'quote':
      return `<blockquote>${inlineToHtml(block.text)}</blockquote>`;

    case 'divider':
      return '<hr>';

    case 'code':
      return `<pre><code data-language="${escapeHtml(block.language)}">${escapeHtml(block.code)}</code></pre>`;

    case 'list': {
      const items = block.items.map((item) => {
        const indent = item.indent > 0 ? ` data-indent="${Math.min(item.indent, 4)}"` : '';
        const checkbox = item.checked === null ? '' : ` data-checkbox="${item.checked ? 'x' : ' '}"`;
        return `<li${indent}${checkbox}>${inlineToHtml(item.text)}</li>`;
      });
      // A checklist and an ordinary bullet are both `<ul>`: the difference is on
      // the item, which is where the markdown says it is.
      if (isOpen()) return items.join('');
      open();
      return `<ul>${items.join('')}`;
    }

    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// HTML -> Markdown
// ---------------------------------------------------------------------------

/**
 * The shape this walker needs from a DOM node.
 *
 * Declared structurally rather than as `Node` so the serialiser can be tested on
 * hand-built trees with no DOM at all — which is the only way to test it here,
 * since this project's test environment has no browser in it.
 */
export interface DomNodeLike {
  nodeType: number;
  nodeName?: string;
  textContent?: string | null;
  childNodes?: ArrayLike<DomNodeLike>;
  getAttribute?: (name: string) => string | null;
}

const TEXT_NODE = 3;

function tagOf(node: DomNodeLike): string {
  return (node.nodeName ?? '').toUpperCase();
}

function childrenOf(node: DomNodeLike): DomNodeLike[] {
  return Array.from(node.childNodes ?? []);
}

function attr(node: DomNodeLike, name: string): string | null {
  return node.getAttribute?.(name) ?? null;
}

/** Serialise a node's children, inline context (no block separators). */
function inlineOf(node: DomNodeLike): string {
  return childrenOf(node).map(serialiseInline).join('');
}

function serialiseInline(node: DomNodeLike): string {
  if (node.nodeType === TEXT_NODE) return node.textContent ?? '';

  switch (tagOf(node)) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B':
      return wrap(inlineOf(node), '**');
    case 'EM':
    case 'I':
      return wrap(inlineOf(node), '*');
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrap(inlineOf(node), '~~');
    case 'CODE':
      return wrap(inlineOf(node), '`');
    case 'A': {
      const href = attr(node, 'href') ?? '';
      const label = inlineOf(node);
      // Only web links survive. A `javascript:` or `data:` href — which would only
      // be there because something pasted it — becomes plain text.
      if (!/^https?:\/\//i.test(href)) return label;
      return `[${label || href}](${href})`;
    }
    case 'SCRIPT':
    case 'STYLE':
      // Never allow pasted script content to become text in a note.
      return '';
    default:
      return inlineOf(node);
  }
}

/**
 * The whole fragment as Markdown.
 *
 * Blocks are separated by a blank line, which is what the parser expects and what
 * makes the stored text readable on its own.
 */
export function htmlToMarkdown(node: DomNodeLike): string {
  const blocks = childrenOf(node).flatMap(blockOf).filter((block) => block.trim().length > 0);
  return blocks.join('\n\n');
}

/** One top-level node as one or more Markdown blocks. */
function blockOf(node: DomNodeLike): string[] {
  if (node.nodeType === TEXT_NODE) {
    const text = (node.textContent ?? '').trim();
    return text.length > 0 ? [text] : [];
  }

  switch (tagOf(node)) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const level = Number(tagOf(node).slice(1));
      return [`${'#'.repeat(level)} ${inlineOf(node).trim()}`];
    }

    case 'HR':
      return ['---'];

    case 'PRE': {
      const code = childrenOf(node).find((child) => tagOf(child) === 'CODE');
      const language = code ? attr(code, 'data-language') ?? '' : '';
      const body = (code ?? node).textContent ?? '';
      return [`\`\`\`${language}\n${body.replace(/\n$/, '')}\n\`\`\``];
    }

    case 'UL':
    case 'OL': {
      const start = Number.parseInt(attr(node, 'start') ?? '1', 10);
      const lines: string[] = [];
      let index = 0;
      for (const item of childrenOf(node)) {
        if (tagOf(item) !== 'LI') {
          // A stray node inside a list (a pasted `<p>`, a bare text run) keeps its
          // text as a bullet rather than vanishing.
          const text = inlineOf(item).trim();
          if (text.length > 0) lines.push(`${bulletFor(node, index, start)}${text}`);
          index += 1;
          continue;
        }
        const indent = '  '.repeat(Math.min(Number.parseInt(attr(item, 'data-indent') ?? '0', 10) || 0, 4));
        const checkbox = attr(item, 'data-checkbox');
        const text = inlineOf(item).trim();
        if (checkbox !== null) {
          // The editor draws the box itself; the markdown keeps the truth.
          lines.push(`${indent}- [${checkbox === 'x' ? 'x' : ' '}] ${text}`);
        } else {
          lines.push(`${indent}${bulletFor(node, index, start)}${text}`);
        }
        index += 1;
      }
      return lines.length > 0 ? [lines.join('\n')] : [];
    }

    case 'BLOCKQUOTE': {
      // A quote holds either inline content or blocks; either way each line of it
      // gets the marker, which is what makes a multi-line quote survive a round
      // trip instead of collapsing into one line.
      const inner = htmlToMarkdown(node) || innerInlineOf(node).trim();
      if (inner.length === 0) return [];
      return [inner.split('\n').map((line) => (line.trim().length > 0 ? `> ${line}` : '>')).join('\n')];
    }

    case 'DIV':
    case 'P':
    case 'SECTION':
    case 'ARTICLE':
    case 'BODY':
    default:
      // Anything unrecognised is unwrapped rather than re-emitted: the tag was not
      // written by this editor, so it is not a tag this editor should write back.
      return containerBlocks(node);
  }
}

/**
 * A container's children, as paragraphs and blocks.
 *
 * The order is the document's, and inline runs are grouped: consecutive text and
 * inline elements become one paragraph, and each child block becomes its own. That
 * is what makes the two shapes a contentEditable actually produces both come out
 * right — `<p>text</p>` (inline children) and `<div><p>a</p><p>b</p></div>` (block
 * children) — without either one being serialised twice, which is what happens if
 * a container reports both its own text and its children's blocks.
 *
 * The mixed shape is real, not hypothetical: pressing Enter at the end of a list
 * leaves loose text in a `<div>` next to the list.
 */
function containerBlocks(node: DomNodeLike): string[] {
  const out: string[] = [];
  let run: DomNodeLike[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const inline = run.map(serialiseInline).join('').trim();
    if (inline.length > 0) out.push(inline);
    run = [];
  };

  for (const child of childrenOf(node)) {
    const isBlock = child.nodeType !== TEXT_NODE && BLOCK_TAGS.has(tagOf(child));
    if (isBlock) {
      flush();
      out.push(...blockOf(child));
    } else {
      run.push(child);
    }
  }
  flush();
  return out;
}

/** A node's inline text, skipping its child blocks. Used for a quote's body. */
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR']);

function innerInlineOf(node: DomNodeLike): string {
  let out = '';
  for (const child of childrenOf(node)) {
    if (child.nodeType !== TEXT_NODE && BLOCK_TAGS.has(tagOf(child))) continue;
    out += serialiseInline(child);
  }
  return out;
}

function bulletFor(list: DomNodeLike, index: number, start: number): string {
  if (tagOf(list) === 'OL') {
    const number = Number.isFinite(start) ? start + index : index + 1;
    return `${number}. `;
  }
  return '- ';
}

function wrap(value: string, marker: string): string {
  return value.length > 0 ? `${marker}${value}${marker}` : '';
}

// ---------------------------------------------------------------------------
// Editor commands
// ---------------------------------------------------------------------------

/**
 * The formatting operations the toolbar can apply to a live selection.
 *
 * Kept as a closed union so the editor's toolbar and the DOM side cannot drift:
 * every button names one of these, and the editor is the only place that turns one
 * into a DOM operation.
 */
export type EditorCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'heading'
  | 'bulletList'
  | 'orderedList'
  | 'checklist'
  | 'quote';

/**
 * Apply a command through the platform's own editing commands.
 *
 * `document.execCommand` is deprecated in the sense that the specification says so
 * and nobody has replaced it: it is what contentEditable has, it is implemented
 * consistently in Chromium and WebKit — the two engines this app actually runs in
 * — and the alternative is re-implementing range surgery for every command. The
 * wrapper exists so the choice is made once, in a named place, rather than spread
 * across a toolbar.
 *
 * `styleWithCSS` is turned off first so bold produces `<b>`/`<strong>` rather than
 * `style="font-weight:700"`: the serialiser understands tags and would have to
 * guess at arbitrary inline styles.
 */
export function runEditorCommand(command: EditorCommand): boolean {
  if (typeof document === 'undefined') return false;
  try {
    document.execCommand('styleWithCSS', false, 'false');
  } catch {
    /* not supported: the tag-based output is the default anyway */
  }

  const exec = (name: string, value?: string) => {
    try {
      return document.execCommand(name, false, value);
    } catch {
      return false;
    }
  };

  switch (command) {
    case 'bold':
      return exec('bold');
    case 'italic':
      return exec('italic');
    case 'strike':
      return exec('strikeThrough');
    case 'code': {
      // There is no inline-code command; `insertHTML` with the selection still in
      // place wraps it the way `wrapSelection` used to, but visibly.
      const selection = document.getSelection();
      const text = selection?.toString() ?? '';
      return exec('insertHTML', `<code>${escapeHtml(text || 'code')}</code>`);
    }
    case 'heading':
      return exec('formatBlock', 'H2');
    case 'bulletList':
      return exec('insertUnorderedList');
    case 'orderedList':
      return exec('insertOrderedList');
    case 'quote':
      return exec('formatBlock', 'BLOCKQUOTE');
    case 'checklist':
      return false;
    default:
      return false;
  }
}

/** Whether the live selection is already inside `tag`. Drives toolbar state. */
export function selectionInside(tag: string): boolean {
  if (typeof document === 'undefined') return false;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  let node: Node | null = selection.getRangeAt(0).startContainer;
  while (node) {
    if (node.nodeType === 1 && (node as Element).tagName === tag) return true;
    node = node.parentNode;
  }
  return false;
}
