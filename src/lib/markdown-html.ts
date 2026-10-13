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

/** Serialise a node's children, inline context (no block separators). */
function inlineOf(node: DomNodeLike): string {
  return childrenOf(node).map(serialiseInline).join('');
}

function serialiseInline(node: DomNodeLike): string {
  if (node.nodeType === TEXT_NODE) return cleanText(node.textContent ?? '');

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
  const blocks = childrenOf(node).flatMap(blockOf).filter((block) => block.trim().length > 0);
  return blocks.join('\n\n');
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
  | 'bulletList'
  | 'orderedList'
  | 'checklist'
  | 'quote';

/**
 * The element an inline command wraps the *next* characters typed in.
 *
 * Only these four are "typing" formats. A heading, a list or a quote is a
 * property of the line the caret is on, and the platform's own command handles
 * that correctly whether the selection is collapsed or not.
 */
const TYPING_TAGS: Partial<Record<EditorCommand, string>> = {
  bold: 'b',
  italic: 'i',
  strike: 'del',
  code: 'code',
};

type TypingCommand = 'bold' | 'italic' | 'strike' | 'code';

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

/** What the toolbar needs to know: which formats are on at the caret. */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
}

export const NO_FORMATS: FormatState = { bold: false, italic: false, strike: false, code: false };

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

function commandState(name: string): boolean {
  try {
    return document.queryCommandState(name);
  } catch {
    return false;
  }
}

/**
 * Which formats are on where the caret is.
 *
 * Both questions are asked, because they answer different halves of it: the DOM
 * walk answers "is this text already bold" (which covers a caret parked in bold
 * text, and a selection over it), and `queryCommandState` answers "would the next
 * character be bold" (the engine's own pending state). Neither alone is right in
 * both cases, and the toolbar shows exactly one light per format.
 */
export function activeFormats(): FormatState {
  if (typeof document === 'undefined') return NO_FORMATS;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return NO_FORMATS;
  const start = selection.getRangeAt(0).startContainer;
  const inTag = (tags: readonly string[]) => Boolean(enclosingTag(start, tags));
  return {
    bold: inTag(FORMAT_TAGS.bold) || commandState('bold'),
    italic: inTag(FORMAT_TAGS.italic) || commandState('italic'),
    strike: inTag(FORMAT_TAGS.strike) || commandState('strikeThrough'),
    code: inTag(FORMAT_TAGS.code),
  };
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
    if (active.textContent === CARET_CARRIER_TEXT) {
      const after = document.createRange();
      after.setStartAfter(active);
      after.collapse(true);
      active.remove();
      placeCaret(after);
      return false;
    }
    const outside = document.createRange();
    outside.setStartAfter(active);
    outside.collapse(true);
    placeCaret(outside);
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
  range.insertNode(wrapper);

  const inner = document.createRange();
  inner.setStart(carrier, 0);
  inner.collapse(true);
  placeCaret(inner);
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

  // A collapsed caret has nothing to wrap, so the format is toggled as a state
  // of the keyboard instead of applied to a range. Checked before the switch so
  // every typing format behaves the same — and so that pressing the button a
  // second time turns it off rather than nesting another wrapper.
  const selection = document.getSelection();
  const caretOnly = Boolean(selection && selection.rangeCount > 0 && selection.isCollapsed);
  if (caretOnly && command in TYPING_TAGS) return toggleTypingStyle(command as TypingCommand);

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
