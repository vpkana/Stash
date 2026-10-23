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

import {
  parseMarkdown,
  renderInline,
  type HeadingLevel,
  type InlineNode,
  type MarkdownBlock,
  type MarkdownListItem,
} from './markdown';

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
  return inlineNodesToHtml(renderInline(text));
}

/**
 * Inline nodes as HTML, recursively.
 *
 * Nesting has to be rendered as nesting: `<strong><em>x</em></strong>` is what
 * bold-and-italic looks like, and flattening it to "bold" would quietly drop half
 * of what the user applied.
 */
function inlineNodesToHtml(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'bold':
          return `<strong>${inlineNodesToHtml(node.children ?? [{ type: 'text', value: node.value }])}</strong>`;
        case 'italic':
          return `<em>${inlineNodesToHtml(node.children ?? [{ type: 'text', value: node.value }])}</em>`;
        case 'strike':
          return `<del>${inlineNodesToHtml(node.children ?? [{ type: 'text', value: node.value }])}</del>`;
        case 'code':
          return `<code>${escapeHtml(node.value)}</code>`;
        case 'link':
          return `<a href="${escapeHtml(node.href)}">${inlineNodesToHtml(node.children ?? [{ type: 'text', value: node.value }])}</a>`;
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
  /** Which list tag is currently open, so a change of kind closes it first. */
  let openList: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (!openList) return;
    html.push(`</${openList}>`);
    openList = null;
  };

  for (const block of blocks) {
    if (block.kind !== 'list') {
      closeList();
      html.push(blockToHtml(block));
      continue;
    }

    /*
     * An ordered list is an `<ol>`.
     *
     * Every list used to be emitted as `<ul>`, so a numbered note came back as
     * bullets the moment it was reopened — the number survived in the Markdown
     * and was thrown away by the editor's own renderer. The parser knew; only
     * this function did not.
     */
    const tag = block.ordered ? 'ol' : 'ul';
    if (openList !== tag) {
      closeList();
      openList = tag;
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
      html.push(`<${tag}${start}>`);
    }
    html.push(listItemsToHtml(block.items));
  }
  closeList();

  return html.join('');
}

function listItemsToHtml(items: readonly MarkdownListItem[]): string {
  return items
    .map((item) => {
      const indent = item.indent > 0 ? ` data-indent="${Math.min(item.indent, 4)}"` : '';
      const checkbox = item.checked === null ? '' : ` data-checkbox="${item.checked ? 'x' : ' '}"`;
      return `<li${indent}${checkbox}>${inlineToHtml(item.text)}</li>`;
    })
    .join('');
}

function blockToHtml(block: MarkdownBlock): string {
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

    case 'list':
      // Handled by `markdownToHtml`, which owns the open/close pairing.
      return listItemsToHtml(block.items);

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

/**
 * Invisible characters the *editor* needs but the *note* must not keep.
 *
 * `U+200B` is inserted inside an empty formatting wrapper so the caret has
 * somewhere to sit when the user presses Bold on nothing and starts typing (see
 * {@link toggleTypingStyle}); a caret cannot be placed in a truly empty element
 * in every engine. It is stripped here rather than never inserted, because the
 * alternative — a bold toggle that silently does nothing — is the bug this
 * exists to fix, and `String.prototype.trim` does not remove it.
 */
const CARET_CARRIER = /\u200b/g;

function cleanText(value: string): string {
  return value.replace(CARET_CARRIER, '');
}

function tagOf(node: DomNodeLike): string {
  return (node.nodeName ?? '').toUpperCase();
}

function childrenOf(node: DomNodeLike): DomNodeLike[] {
  return Array.from(node.childNodes ?? []);
}

function attr(node: DomNodeLike, name: string): string | null {
  return node.getAttribute?.(name) ?? null;
}

const STRONG_TAGS = new Set(['B', 'STRONG']);
const EM_TAGS = new Set(['I', 'EM']);

/** Serialise a node's children, inline context (no block separators). */
function inlineOf(node: DomNodeLike): string {
  const parent = tagOf(node);
  return childrenOf(node)
    .map((child) => serialiseInline(child, parent))
    .join('');
}

function serialiseInline(node: DomNodeLike, parentTag = ''): string {
  if (node.nodeType === TEXT_NODE) return cleanText(node.textContent ?? '');

  switch (tagOf(node)) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B': {
      /*
       * Alternate the delimiter when this bold sits inside italic. `**bold with
       * *italic* inside**` is valid Markdown but needs a parser that understands
       * single asterisks inside double ones; `**bold with _italic_ inside**`
       * needs only the obvious rule. The saved text is still ordinary Markdown,
       * and it is the shape the reader parses back without ambiguity.
       */
      const marker = EM_TAGS.has(parentTag) ? '__' : '**';
      return wrap(inlineOf(node), marker);
    }
    case 'EM':
    case 'I': {
      const marker = STRONG_TAGS.has(parentTag) ? '_' : '*';
      return wrap(inlineOf(node), marker);
    }
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrap(inlineOf(node), '~~');
    case 'CODE':
      return wrap(inlineOf(node), '`');
    case 'A': {
      const href = attr(node, 'href') ?? '';
      const label = inlineOf(node);
      // Two kinds of link survive: web links, and Stash's own in-note references.
      // A reference is `#note=<id>` — the subnote a note points at, inserted at
      // the caret so the *user* decides where it sits in the text. Anything else
      // (`javascript:`, `data:`, a pasted `file://`) becomes plain text, because
      // a tag this editor did not write is not a tag it should write back.
      if (!/^(https?:\/\/|#note=)/i.test(href)) return label;
      // A link whose text *is* its address is written back as the address. The
      // reader autolinks it again (see `renderInline`), so nothing is lost, and
      // an address the user typed stays the plain text they typed instead of
      // accumulating `[https://…](https://…)` brackets it never had.
      if (label === href || label === href.replace(/^https?:\/\/(www\.)?/i, '')) return href;
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
  const blocks = rootBlocks(node).filter((block) => block.trim().length > 0);
  return blocks.join('\n\n');
}

/**
 * The editable root's children, as paragraphs and blocks.
 *
 * The root is a container like any other, with one difference that matters here:
 * the caret can step *out* of a formatting wrapper and leave loose text beside it
 * (`<div><b>Bold</b> plain</div>`), because that is what pressing Bold a second
 * time does. Walking each child separately made those two nodes two paragraphs, so
 * turning bold off mid-sentence wrote a blank line into the note and the line came
 * back broken the next time it was opened.
 *
 * So a run of inline nodes that includes loose text is one paragraph. Two
 * *formatted* runs with nothing between them are kept apart deliberately: their
 * delimiters would abut (`**a***b*`), and that is ambiguous Markdown — the parser
 * reads it as one emphasis with stray asterisks in it, which is the asterisk bug
 * in its stored form. Two paragraphs are a visible, fixable artifact; a string
 * that parses to the wrong thing is not.
 */
function rootBlocks(node: DomNodeLike): string[] {
  const out: string[] = [];
  let run: DomNodeLike[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const loose = run.some((child) => child.nodeType === TEXT_NODE);
    if (loose || run.length === 1) {
      const inline = run.map((child) => serialiseInline(child)).join('').trim();
      if (inline.length > 0) out.push(inline);
    } else {
      for (const child of run) out.push(...blockOf(child));
    }
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

/**
 * A fragment's inline content as Markdown, with no block separation.
 *
 * The title is a single line of formatted words, not a document: running it
 * through `htmlToMarkdown` would turn `**a** b` into two paragraphs, because a
 * block walker separates every top-level node. This keeps the shape the title
 * actually has.
 */
export function htmlToInlineMarkdown(node: DomNodeLike): string {
  return inlineOf(node).replace(/\u00a0/g, ' ').trim();
}

/** One top-level node as one or more Markdown blocks. */
function blockOf(node: DomNodeLike): string[] {
  if (node.nodeType === TEXT_NODE) {
    const text = cleanText(node.textContent ?? '').trim();
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

    default: {
      /*
       * An inline element can sit *directly in the editable root*, and that is not
       * an edge case — it is exactly what the Bold button produces on an empty
       * note: there is no paragraph to wrap, so the wrapper becomes the top-level
       * node and every character typed afterwards goes inside it. Serialising it
       * as a container would drop the formatting and store the note as plain text,
       * which is a silent, data-level version of the bug this file exists to fix.
       *
       * So the test is structural: a tag that is not a block is inline content.
       */
      if (!BLOCK_TAGS.has(tagOf(node))) {
        const inline = serialiseInline(node).trim();
        return inline.length > 0 ? [inline] : [];
      }
      // A block container's own text is never reported: its children are, in
      // order, and reporting both would write the content twice.
      return containerBlocks(node);
    }
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
    const inline = run.map((child) => serialiseInline(child)).join('').trim();
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

/**
 * The tags whose children are blocks rather than inline content.
 *
 * Declared after `blockOf` reads it, which is fine: it is a `const` in module
 * scope and the function only runs long after the module has finished being
 * evaluated. It is also the whole of the block/inline distinction here — every
 * tag *not* in this set is treated as inline content wherever it appears.
 */
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
  | 'larger'
  | 'smaller'
  | 'bulletList'
  | 'orderedList'
  | 'checklist'
  | 'quote';

export type TypingCommand = 'bold' | 'italic' | 'strike' | 'code';

/**
 * The element an inline command wraps the *next* characters typed in.
 *
 * Only these four are "typing" formats. A heading, a list or a quote is a
 * property of the line the caret is on, and the platform's own command handles
 * that correctly whether the selection is collapsed or not.
 */
export const TYPING_TAGS: Record<TypingCommand, 'b' | 'i' | 'del' | 'code'> = {
  bold: 'b',
  italic: 'i',
  strike: 'del',
  code: 'code',
};

/**
 * Every tag that *means* one of the typing formats, however it got there.
 *
 * `b`/`strong` and `i`/`em` are the same format spelled two ways: the platform's
 * own command writes one pair, this editor's wrapper writes the other, and a
 * pasted fragment can contain either. A button that only recognised its own
 * spelling would report "not bold" while the caret sat inside bold text — which
 * is how a toggle ends up on when it looks off.
 */
const FORMAT_TAGS: Record<TypingCommand, readonly string[]> = {
  bold: ['B', 'STRONG'],
  italic: ['I', 'EM'],
  strike: ['DEL', 'S', 'STRIKE'],
  code: ['CODE'],
};

/** The invisible caret carrier, as a value rather than as a pattern. */
const CARET_CARRIER_TEXT = '\u200b';

/** Every tag a formatting button can wrap text in. */
const FORMATTING_ELEMENTS = new Set(['B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'STRIKE', 'CODE']);

/**
 * Whether a node holds nothing but the editor's own caret carrier.
 *
 * This is the difference between "an empty wrapper the caret is sitting in" and
 * "a wrapper with words in it", and getting it wrong is visible: a wrapper that
 * holds one `U+200B` would be re-created as a stray empty `<em>` every time the
 * caret stepped out of it, which stacks empty tags through a sentence as the user
 * toggles bold and italic.
 */
function isCarrierOnly(node: { textContent?: string | null } | null | undefined): boolean {
  return (node?.textContent ?? '').replace(CARET_CARRIER, '').trim().length === 0;
}

/** The editable surface a node lives in, for cleaning up after a command. */
function editingHostOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return (element?.closest('[contenteditable="true"]') as HTMLElement | null) ?? null;
}

/**
 * Drop the carriers left behind by an earlier toggle.
 *
 * Pressing Bold arms a wrapper with a carrier in it; pressing Italic next puts a
 * second wrapper inside the first and the first one's carrier becomes a leftover
 * that draws an empty tag and confuses the next toggle. Everything except the
 * wrapper the caret now sits in is removed.
 */
function clearStrayCarriers(host: HTMLElement | null, keep: Node | null): void {
  if (!host) return;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const strays: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node === keep) continue;
    if (keep && keep.nodeType === 1 && (keep as Element).contains(node)) continue;
    if (isCarrierOnly(node)) strays.push(node);
  }
  for (const node of strays) node.remove();
}

/**
 * The heading tags this editor treats as "the heading format".
 *
 * All six, not just the one the button writes: a note can arrive from Markdown
 * with `#`, `###` or anything in between, and a button that only recognised H2
 * would report "not a heading" while the caret sat in one — so the first press
 * would stamp a second heading rather than turn the first one off.
 */
const HEADING_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'] as const;

/** What the toolbar needs to know: which formats are on at the caret. */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  /** True where the caret's block is a heading. */
  heading: boolean;
  /** True where the caret's block is a blockquote. */
  quote: boolean;
}

export const NO_FORMATS: FormatState = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  heading: false,
  quote: false,
};

/** The nearest ancestor of `node`, itself included, whose tag is in `tags`. */
function enclosingTag(node: Node | null, tags: readonly string[]): HTMLElement | null {
  let cursor: Node | null = node;
  while (cursor && cursor.nodeType !== 1) cursor = cursor.parentNode;
  while (cursor) {
    const element = cursor as HTMLElement;
    if (tags.includes(element.tagName)) return element;
    cursor = element.parentNode;
  }
  return null;
}

/**
 * The nearest ancestor that is a link.
 *
 * Exported because the editor has to ask the same question before it autolinks:
 * an address already inside an anchor is already a link, and re-wrapping it would
 * nest one anchor in another.
 */
export function enclosingAnchor(node: Node | null): HTMLElement | null {
  return enclosingTag(node, ['A']);
}

function placeCaret(range: Range): void {
  const selection = document.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Which formats are on where the caret is.
 *
 * The answer is the document, not the engine. `queryCommandState` used to be
 * consulted too, because it is the only thing that can describe a *pending*
 * format — "the next character would be bold" — but on Android's WebView it is
 * unreliable in exactly the case that matters: it reports the style of the run
 * the caret sits in (or a stale state) rather than what the next keystroke will
 * produce, so the button and the text disagree and a toggle appears stuck.
 *
 * Pending formats are handled by the editors themselves now (`RichTextEditor`
 * and `NoteTitle` keep an armed/escaping ref and override this state while it is
 * pending), which means a button's light always describes something true: this
 * is inside that format, or the next character is about to be written into it.
 */
export function activeFormats(): FormatState {
  if (typeof document === 'undefined') return NO_FORMATS;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return NO_FORMATS;
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const end = range.endContainer;

  /**
   * A selection counts as formatted only when both ends sit inside it; a
   * selection that starts in bold and ends in plain text is not "bold", and
   * lighting the button there would claim the whole selection shares a format it
   * does not. With a collapsed caret both ends are the same node.
   */
  const inTag = (tags: readonly string[]) =>
    Boolean(enclosingTag(start, tags) && enclosingTag(end, tags));

  return {
    bold: inTag(FORMAT_TAGS.bold),
    italic: inTag(FORMAT_TAGS.italic),
    strike: inTag(FORMAT_TAGS.strike),
    code: inTag(FORMAT_TAGS.code),
    heading: Boolean(enclosingTag(start, HEADING_TAGS)),
    quote: Boolean(enclosingTag(start, ['BLOCKQUOTE'])),
  };
}

/**
 * Whether the caret is already inside one of the typing formats.
 *
 * Exported for the title, which arms its own pending format instead of relying on
 * the engine (see `note-title.tsx`): it has to know when the caret has stepped
 * into a run that is already formatted, so pressing the button again splits the
 * run rather than stacking another wrapper.
 */
export function caretInsideFormat(command: TypingCommand): boolean {
  return formatElementAtCaret(command) !== null;
}

/** The formatting element the caret sits in, if any. */
export function formatElementAtCaret(command: TypingCommand): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return enclosingTag(selection.getRangeAt(0).startContainer, FORMAT_TAGS[command]);
}

/**
 * Turn a formatting button into a *state of the keyboard*, not an edit.
 *
 * This is the fix for "I press Bold and then type, and it is not bold". With a
 * caret and no selection there is nothing to wrap, and whether `execCommand`
 * remembers a pending style for the next keystroke is left to the engine — on
 * Android's WebView it frequently does not, so the button appeared to do nothing
 * and the note stayed plain.
 *
 * So the wrapper is inserted *now*, empty, and the caret is put inside it. Every
 * character typed afterwards goes into the element because that is simply where
 * the caret is; no engine cooperation is involved. The carrier character keeps the
 * line's height and gives the caret a place to sit in an otherwise empty
 * paragraph, and the serialiser strips it, so it can never reach the saved
 * Markdown.
 *
 * It is a *toggle*, and it reports which way it went, so the button that was
 * pressed is the button that looks pressed. Turning a format back off is not the
 * same operation as turning it on, and it is not a text edit either: see the two
 * cases below.
 *
 * @returns whether the format is now armed at the caret.
 */
export function toggleTypingStyle(command: TypingCommand): boolean {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  const active = enclosingTag(range.startContainer, FORMAT_TAGS[command]);

  if (active) {
    /*
     * Turning the format off, which is the half that used to be missing: the
     * button only ever added a wrapper, so pressing it twice nested one inside
     * the other and the text stayed bold.
     *
     * There are two shapes to undo. An *empty* wrapper is the one this function
     * inserted a moment ago — nothing has been typed in it yet — and it goes away
     * entirely, leaving the caret exactly where it was. Anything else is a run of
     * text that is already formatted, and the honest answer there is to step the
     * caret outside it, so the next character typed is plain; rewriting text the
     * user has already written is not what pressing an un-pressed button means.
     */
    if (isCarrierOnly(active)) {
      const parent = active.parentNode;
      if (!parent) return false;
      const index = Array.prototype.indexOf.call(parent.childNodes, active);
      /*
       * A wrapper inside another wrapper is the bold-and-italic case: turn one
       * off and the other is still on, so the caret stays *inside* what is left
       * with a fresh carrier of its own. Stepping outside the whole thing is what
       * made pressing Italic inside bold look like it switched both off.
       */
      const outer =
        parent.nodeType === 1 && FORMATTING_ELEMENTS.has((parent as Element).tagName)
          ? (parent as Element)
          : null;
      active.remove();

      if (outer) {
        const carrier = document.createTextNode(CARET_CARRIER_TEXT);
        outer.insertBefore(carrier, outer.childNodes[index] ?? null);
        const inside = document.createRange();
        inside.setStart(carrier, 0);
        inside.collapse(true);
        placeCaret(inside);
        return false;
      }

      const after = document.createRange();
      after.setStart(parent, Math.min(index, parent.childNodes.length));
      after.collapse(true);
      placeCaret(after);
      return false;
    }

    /*
     * Turning it off *in the middle* of formatted text.
     *
     * The old behaviour was to step the caret past the whole run, which means the
     * next word is typed at the end of the sentence instead of where the user was
     * looking — and with bold and italic both on, the second press appeared to do
     * nothing while moving the caret out of the note they were editing.
     *
     * So the run is split at the caret and a plain bridge is left between the
     * halves: what came before stays formatted, the caret does not move on screen,
     * and the next character typed is plain. Pressing the button again on the
     * bridge re-arms the format at the same spot.
     */
    const live = selection.getRangeAt(0);
    if (!active.contains(live.startContainer)) {
      const outside = document.createRange();
      outside.setStartAfter(active);
      outside.collapse(true);
      placeCaret(outside);
      return false;
    }

    const parent = active.parentNode;
    if (!parent) return false;

    const tail = live.cloneRange();
    tail.setEnd(active, active.childNodes.length);
    const tailContent = tail.extractContents();
    const bridge = document.createTextNode(CARET_CARRIER_TEXT);
    parent.insertBefore(bridge, active.nextSibling);
    /*
     * Only words that are actually there get carried back into a second wrapper.
     * The tail almost always contains the invisible carrier this module put
     * there, and counting that as content is what produced a stray empty `<em>`
     * after every toggle — visible as an italic button that would not stay off.
     */
    if (!isCarrierOnly(tailContent)) {
      const rest = active.cloneNode(false) as HTMLElement;
      rest.appendChild(tailContent);
      parent.insertBefore(rest, bridge.nextSibling);
    }
    if (isCarrierOnly(active)) active.remove();

    const caret = document.createRange();
    caret.setStart(bridge, 0);
    caret.collapse(true);
    placeCaret(caret);
    return false;
  }

  /*
   * Turning it on. The wrapper is inserted *now*, empty, with the caret inside
   * it: every character typed afterwards goes into the element because that is
   * simply where the caret is, and no engine cooperation is involved. The carrier
   * character keeps the line's height and gives the caret a place to sit in an
   * otherwise empty paragraph, and the serialiser strips it, so it never reaches
   * the saved Markdown.
   */
  const wrapper = document.createElement(TYPING_TAGS[command] ?? 'b');
  const carrier = document.createTextNode(CARET_CARRIER_TEXT);
  wrapper.appendChild(carrier);
  const host = editingHostOf(range.startContainer);
  range.insertNode(wrapper);
  // The carriers of formats armed a moment ago are not needed any more: the
  // caret is in the newest wrapper, and leaving them behind draws empty tags.
  clearStrayCarriers(host, wrapper);

  const inner = document.createRange();
  inner.setStart(carrier, 0);
  inner.collapse(true);
  placeCaret(inner);
  return true;
}

/**
 * Insert the first character of an armed format, wrapped, with the caret inside.
 *
 * Shared by the title and the body. The caret ends up in a text node that is
 * inside the tag, which is what makes the *rest* of the word land there too — no
 * per-keystroke interception, and nothing for the browser to normalise away.
 */
export function insertArmedText(format: TypingCommand, text: string): void {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const wrapper = document.createElement(TYPING_TAGS[format]);
  wrapper.textContent = text;
  range.deleteContents();
  range.insertNode(wrapper);
  const caret = document.createRange();
  caret.setStart(wrapper.firstChild ?? wrapper, wrapper.firstChild ? text.length : 0);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
}

/**
 * Insert the first plain character *outside* the run of formatting it escapes.
 *
 * Pressing Bold with the caret inside bold text has to make the next character
 * plain, and leaving the caret on an empty text node does not do it: the browser
 * normalises the empty node away and the character lands back inside the run.
 * Writing real text outside the run gives the caret a home that survives, and
 * the rest of the word follows it.
 */
export function insertTextOutsideFormat(format: TypingCommand, text: string): void {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const active = formatElementAtCaret(format);
  const node = document.createTextNode(text);

  if (!active || !active.contains(range.startContainer) || !active.parentNode) {
    range.deleteContents();
    range.insertNode(node);
  } else {
    const parent = active.parentNode;
    // Keep whatever was after the caret formatted: split the run and put the new
    // plain character between the halves.
    const tail = document.createRange();
    tail.setStart(range.startContainer, range.startOffset);
    tail.setEnd(active, active.childNodes.length);
    const tailContent = tail.extractContents();
    const hasTail = (tailContent.textContent ?? '').replace(/\u200b/g, '').trim().length > 0;
    if (hasTail) {
      const rest = active.cloneNode(false) as HTMLElement;
      rest.appendChild(tailContent);
      parent.insertBefore(node, active.nextSibling);
      parent.insertBefore(rest, node.nextSibling);
    } else {
      parent.insertBefore(node, active.nextSibling);
    }
  }

  const caret = document.createRange();
  caret.setStart(node, text.length);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
}

/**
 * Toggle one inline tag around the selection, by hand.
 *
 * The title needs this rather than `execCommand('bold')`, and the reason is worth
 * knowing: the title is set in a semibold font, so the browser's own `bold`
 * command decides the text is *already* bold and turns it off — producing
 * `font-weight: normal` on the words the user just highlighted. Manual wrapping
 * asks only the structural question ("is this already inside a `<b>`?") and emits
 * the tag the serialiser understands.
 *
 * A collapsed caret delegates to {@link toggleTypingStyle}, so pressing Bold on
 * nothing still arms the format for what is typed next.
 */
export function toggleInlineElement(tag: 'b' | 'i' | 'del' | 'code'): boolean {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  if (selection.isCollapsed) {
    const command: TypingCommand = tag === 'b' ? 'bold' : tag === 'i' ? 'italic' : tag === 'del' ? 'strike' : 'code';
    return toggleTypingStyle(command);
  }

  const range = selection.getRangeAt(0);
  const active = enclosingTag(range.startContainer, [tag.toUpperCase()]);
  if (active && active.contains(range.endContainer)) {
    // Unwrap: the words stay, the tag goes.
    const parent = active.parentNode;
    if (!parent) return false;
    while (active.firstChild) parent.insertBefore(active.firstChild, active);
    parent.removeChild(active);
    return false;
  }

  if (!range.commonAncestorContainer.isConnected) return false;
  const wrapper = document.createElement(tag);
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);

  const around = document.createRange();
  around.selectNodeContents(wrapper);
  selection.removeAllRanges();
  selection.addRange(around);
  return true;
}

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

  /*
   * Every inline format at a collapsed caret is handled by the editors before
   * they reach here: they own the "armed for the next character" state, because
   * the engine does not reliably remember a pending format across a keystroke on
   * Android. This is the fallback for a direct call — arm an empty wrapper at the
   * caret, the way {@link toggleTypingStyle} always has.
   */
  const selection = document.getSelection();
  const caretOnly = Boolean(selection && selection.rangeCount > 0 && selection.isCollapsed);
  if (caretOnly && (command === 'bold' || command === 'italic' || command === 'strike' || command === 'code')) {
    return toggleTypingStyle(command);
  }

  /**
   * A list, from whatever kind of block the caret is in.
   *
   * `insertOrderedList` inside a heading puts the `<ol>` *inside* the `<h3>` —
   * which is not a list in a document, it is markup no renderer expects. The
   * stored note then loses the list entirely, because the serialiser reads an
   * `<ol>` under a heading as inline content. The heading is demoted to a
   * paragraph first, so the list replaces it the way it does everywhere else.
   */
  const makeList = (name: string) => {
    const block = currentBlock();
    const tag = block?.tagName ?? '';
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6' || tag === 'BLOCKQUOTE') {
      exec('formatBlock', 'P');
    }
    return exec(name);
  };

  switch (command) {
    case 'bold':
      return exec('bold');
    case 'larger':
      return changeTextSize(1);
    case 'smaller':
      return changeTextSize(-1);
    case 'italic':
      return exec('italic');
    case 'strike':
      return exec('strikeThrough');
    case 'code': {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return false;
      const range = selection.getRangeAt(0);
      // Already inline code: the button is a toggle, so this press steps out
      // (or removes an empty run) instead of nesting another one.
      if (enclosingTag(range.startContainer, FORMAT_TAGS.code)) {
        return toggleTypingStyle('code');
      }
      return toggleInlineElement('code');
    }
    case 'heading': {
      /*
       * A toggle, not an apply: pressing it inside a heading turns the block back
       * into a paragraph instead of stamping a second heading. The test covers
       * every level, because a note can arrive with `#` or `###` from Markdown
       * and the button has to be able to switch either of them off.
       *
       * A quote is demoted first rather than heading-ised in place: `formatBlock`
       * on a caret inside a `<blockquote>` would put the heading inside the quote,
       * which is not the block the button claims to have made.
       */
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return false;
      const start = selection.getRangeAt(0).startContainer;
      if (enclosingTag(start, HEADING_TAGS)) return exec('formatBlock', 'P');
      if (enclosingTag(start, ['BLOCKQUOTE'])) exec('formatBlock', 'P');
      return exec('formatBlock', 'H2');
    }
    case 'bulletList':
      return makeList('insertUnorderedList');
    case 'orderedList':
      return makeList('insertOrderedList');
    case 'quote': {
      // The same toggle shape as Heading, and the one the toolbar was missing:
      // pressing Quote inside a quote returns the line to a paragraph, rather
      // than asking `formatBlock` for the blockquote it is already in (a no-op
      // that left the button lit and the user unable to turn it off).
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return false;
      const start = selection.getRangeAt(0).startContainer;
      if (enclosingTag(start, ['BLOCKQUOTE'])) return exec('formatBlock', 'P');
      if (enclosingTag(start, HEADING_TAGS)) exec('formatBlock', 'P');
      return exec('formatBlock', 'BLOCKQUOTE');
    }
    case 'checklist':
      return false;
    default:
      return false;
  }
}

/**
 * The sizes a block can take, smallest to largest.
 *
 * A note has no font-size field, and inventing one would mean storing inline
 * styles the Markdown model cannot hold. Headings *are* the size scale the format
 * already has — they round-trip through `#`/`##`/`###`, they are what a reader
 * renders larger, and the toolbar's Heading button is already the middle of it. So
 * "bigger" and "smaller" walk this ladder, and the text stays portable.
 */
const SIZE_LADDER = ['P', 'H3', 'H2'] as const;

/** The block element the caret sits in, or `null` where resizing makes no sense. */
function currentBlock(): HTMLElement | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  let node: Node | null = selection.getRangeAt(0).startContainer;
  while (node && node.nodeType !== 1) node = node.parentNode;
  const host = editingHostOf(node);
  while (node) {
    const element = node as HTMLElement;
    // Never the editable surface itself: "the block" is the paragraph inside it, 
    // and `formatBlock` on the host would replace the editor with a heading.
    if (element === host) return null;
    if (/^(P|H[1-6]|LI|BLOCKQUOTE|DIV)$/.test(element.tagName)) {
      // A list item would be replaced by a heading, which is not a size change —
      // it is a different structure. Leave lists and quotes alone.
      if (element.tagName === 'LI' || element.tagName === 'BLOCKQUOTE') return null;
      return element;
    }
    node = element.parentNode;
  }
  return null;
}

/** Step the current block one size up or down. */
export function changeTextSize(direction: -1 | 1): boolean {
  if (typeof document === 'undefined') return false;
  const block = currentBlock();
  if (!block) return false;
  const index = SIZE_LADDER.indexOf(block.tagName as (typeof SIZE_LADDER)[number]);
  const current = index >= 0 ? index : 0;
  const next = Math.max(0, Math.min(SIZE_LADDER.length - 1, current + direction));
  if (next === current) return false;
  try {
    return document.execCommand('formatBlock', false, SIZE_LADDER[next]);
  } catch {
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
