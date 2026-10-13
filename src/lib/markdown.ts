/**
 * A deliberately small Markdown model.
 *
 * The editor stores plain Markdown text. That choice keeps note content
 * portable, diffable, and independent of any editor's internal document format,
 * and it means the feature set the product asked for -- headings, bullets,
 * numbers, checklists, bold, italic, code, links -- needs no rich-text engine
 * and no dependency that could fail offline.
 *
 * Parsing is a pure function so the renderer, the checklist toggle and the
 * toolbar all share one definition of what the text means.
 */

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface ChecklistItemMeta {
  checked: boolean;
  /** Source line index, so tapping a checkbox can rewrite exactly that line. */
  line: number;
}

export type MarkdownBlock =
  | { kind: 'heading'; level: HeadingLevel; text: string; line: number }
  | { kind: 'paragraph'; text: string; line: number }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownListItem[]; line: number }
  | { kind: 'code'; language: string; code: string; line: number }
  | { kind: 'quote'; text: string; line: number }
  | { kind: 'divider'; line: number };

export interface MarkdownListItem {
  text: string;
  /** `null` for a plain bullet or number; a boolean for a checklist item. */
  checked: boolean | null;
  line: number;
  indent: number;
}

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'strike'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string; href: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const DIVIDER = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^```(.*)$/;
const CHECKLIST = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;

interface OpenList {
  ordered: boolean;
  start: number;
  line: number;
  items: MarkdownListItem[];
}

/**
 * Parse source into block-level nodes.
 *
 * Lists are grouped so consecutive items render as one list rather than as
 * separate one-item lists, which is what makes bulleted notes look right.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split('\n');
  const blocks: MarkdownBlock[] = [];
  let openList: OpenList | null = null;

  const closeList = () => {
    if (openList) {
      blocks.push({
        kind: 'list',
        ordered: openList.ordered,
        start: openList.start,
        items: openList.items,
        line: openList.line,
      });
      openList = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';

    const fence = FENCE.exec(raw);
    if (fence) {
      closeList();
      const language = (fence[1] ?? '').trim();
      const startLine = index;
      const collected: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        collected.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'code', language, code: collected.join('\n'), line: startLine });
      continue;
    }

    if (raw.trim().length === 0) {
      closeList();
      continue;
    }

    if (DIVIDER.test(raw)) {
      closeList();
      blocks.push({ kind: 'divider', line: index });
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading) {
      closeList();
      const level = Math.min(6, Math.max(1, (heading[1] ?? '#').length)) as HeadingLevel;
      blocks.push({ kind: 'heading', level, text: heading[2] ?? '', line: index });
      continue;
    }

    const checklist = CHECKLIST.exec(raw);
    if (checklist) {
      openList = openList ?? { ordered: false, start: 0, line: index, items: [] };
      openList.items.push({
        text: checklist[4] ?? '',
        checked: (checklist[3] ?? ' ').toLowerCase() === 'x',
        line: index,
        indent: indentOf(checklist[1] ?? ''),
      });
      continue;
    }

    const bullet = BULLET.exec(raw);
    if (bullet) {
      if (openList?.ordered) closeList();
      openList = openList ?? { ordered: false, start: 0, line: index, items: [] };
      openList.items.push({
        text: bullet[3] ?? '',
        checked: null,
        line: index,
        indent: indentOf(bullet[1] ?? ''),
      });
      continue;
    }

    const ordered = ORDERED.exec(raw);
    if (ordered) {
      const number = Number.parseInt(ordered[2] ?? '1', 10);
      if (openList && !openList.ordered) closeList();
      if (!openList) openList = { ordered: true, start: Number.isFinite(number) ? number : 1, line: index, items: [] };
      openList.items.push({
        text: ordered[3] ?? '',
        checked: null,
        line: index,
        indent: indentOf(ordered[1] ?? ''),
      });
      continue;
    }

    const quote = QUOTE.exec(raw);
    if (quote) {
      closeList();
      blocks.push({ kind: 'quote', text: quote[1] ?? '', line: index });
      continue;
    }

    closeList();
    blocks.push({ kind: 'paragraph', text: raw, line: index });
  }

  closeList();
  return blocks;
}

function indentOf(whitespace: string): number {
  return Math.floor(whitespace.replace(/\t/g, '  ').length / 2);
}

/**
 * Inline spans.
 *
 * A single left-to-right pass with one alternation. Nested emphasis (`**bold and
 * *italic***`) renders as adjacent spans rather than a nested tree; that is the
 * documented limit of this model and keeps the renderer small enough to audit.
 * Code spans win over everything, so backticks protect their contents.
 */
/**
 * The endings that make a bare host a link rather than a sentence.
 *
 * A domain with no scheme is only autolinked when its last label is a real
 * top-level domain, which is what keeps "Node.js", "e.g." and "v1.2" out of it
 * while `google.com` in the middle of a sentence becomes a link — the behaviour
 * every other notes app has, and the one the user asked for by name.
 */
const URL_TLDS = [
  'com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'me', 'sh', 'xyz', 'info', 'edu', 'gov',
  'us', 'uk', 'de', 'fr', 'au', 'ca', 'in', 'to', 'tv', 'gg', 'so', 'rs', 'fm', 'link', 'page',
  'site', 'blog', 'wiki', 'news', 'tech', 'design', 'art', 'store', 'online', 'cloud', 'pro',
  'zip', 'run', 'tools', 'codes', 'works', 'studio', 'space', 'team', 'live', 'world', 'zone',
  'nl', 'se', 'no', 'es', 'it', 'ch', 'at', 'be', 'dk', 'fi', 'pl', 'pt', 'ie', 'nz', 'za',
];

const TLD_ALTERNATION = URL_TLDS.join('|');

/**
 * A host with no scheme: `www.example.com`, `google.com`, `example.co.uk/path`.
 *
 * The leading guard is what stops it matching inside something else — an email
 * address (`me@example.com`) and the tail of a longer word are both left as text.
 */
const BARE_URL = `(?<![\\w@.])(?:www\\.)?[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${TLD_ALTERNATION})(?:\\/[^\\s<>"'\u0060)\\]]*)?`;

const SCHEMED_URL = `https?:\\/\\/[^\\s<>"'\u0060)\\]]+`;

const INLINE_PATTERN = new RegExp(
  [
    '(`[^`\\n]+`)',
    '(\\*\\*[^*\\n]+\\*\\*)',
    '(__[^_\\n]+__)',
    '(~~[^~\\n]+~~)',
    '(\\*[^*\\n]+\\*)',
    '(_[^_\\n]+_)',
    '(\\[[^\\]\\n]*\\]\\([^)\\s]+\\))',
    `(${SCHEMED_URL})`,
    `(${BARE_URL})`,
  ].join('|'),
  'gi',
);

const TRAILING_URL = new RegExp(`(${SCHEMED_URL}|${BARE_URL})\\s*$`, 'i');

/**
 * The URL that ends `text`, if it ends with one.
 *
 * Used by the editor to turn a link into a link *as it is typed*, and exported
 * separately from {@link renderInline} so the two agree: a string that renders as
 * a link is a string that is autolinked while writing it, and vice versa.
 */
export function trailingUrl(text: string): { text: string; start: number; href: string } | null {
  const match = TRAILING_URL.exec(text);
  if (!match) return null;
  const raw = (match[1] ?? '').trim();
  if (raw.length === 0) return null;
  return {
    text: raw,
    start: match.index,
    href: /^https?:/i.test(raw) ? raw : `https://${raw}`,
  };
}

export function renderInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = 0;
  INLINE_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null = INLINE_PATTERN.exec(text);
  while (match !== null) {
    if (match.index > cursor) {
      nodes.push({ type: 'text', value: text.slice(cursor, match.index) });
    }
    const token = match[0];
    const node = classifyInline(token);
    if (node) nodes.push(node);
    else nodes.push({ type: 'text', value: token });
    cursor = match.index + token.length;
    match = INLINE_PATTERN.exec(text);
  }

  if (cursor < text.length) nodes.push({ type: 'text', value: text.slice(cursor) });
  return nodes;
}

function classifyInline(token: string): InlineNode | null {
  if (token.startsWith('`')) return { type: 'code', value: token.slice(1, -1) };
  if (token.startsWith('**')) return { type: 'bold', value: token.slice(2, -2) };
  if (token.startsWith('__')) return { type: 'bold', value: token.slice(2, -2) };
  if (token.startsWith('~~')) return { type: 'strike', value: token.slice(2, -2) };
  if (token.startsWith('*')) return { type: 'italic', value: token.slice(1, -1) };
  if (token.startsWith('_')) return { type: 'italic', value: token.slice(1, -1) };

  if (token.startsWith('[')) {
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
    if (link) return { type: 'link', value: link[1] ?? '', href: link[2] ?? '' };
    return null;
  }

  if (/^https?:\/\//.test(token)) {
    return { type: 'link', value: token.replace(/^https?:\/\/(www\.)?/, ''), href: token };
  }

  // A bare host, which is a link because the last label is a real top-level
  // domain. The scheme is supplied rather than shown, so the text keeps the
  // words the user actually wrote.
  if (/\./.test(token) && token.length > 3) {
    return { type: 'link', value: token.replace(/^www\./, ''), href: `https://${token}` };
  }

  return null;
}

/**
 * Flip one checklist item, identified by its source line.
 *
 * Tapping a checkbox in the rendered note rewrites the exact source line rather
 * than regenerating the document, so nothing else the user typed can shift.
 */
export function toggleChecklistItem(source: string, line: number): string {
  const lines = source.split('\n');
  const target = lines[line];
  if (target === undefined) return source;

  const match = CHECKLIST.exec(target);
  if (!match) return source;

  const checked = (match[3] ?? ' ').toLowerCase() === 'x';
  const [, indent, bullet, , text] = match;
  lines[line] = `${indent}${bullet} [${checked ? ' ' : 'x'}] ${text}`;
  return lines.join('\n');
}

export interface ChecklistProgress {
  done: number;
  total: number;
}

/** `3/5` style progress, or null when the note has no checkboxes. */
export function checklistProgress(source: string): ChecklistProgress | null {
  let done = 0;
  let total = 0;
  for (const line of source.split('\n')) {
    const match = CHECKLIST.exec(line);
    if (!match) continue;
    total += 1;
    if ((match[3] ?? ' ').toLowerCase() === 'x') done += 1;
  }
  return total === 0 ? null : { done, total };
}

/** Recognised at a glance in the notes list. */
export function noteWordCount(source: string): number {
  const trimmed = source.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Editor edits
// ---------------------------------------------------------------------------

export interface EditSelection {
  start: number;
  end: number;
}

export interface EditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Wrap the selection (or the cursor) in an inline marker such as `**`. */
export function wrapSelection(source: string, selection: EditSelection, marker: string): EditResult {
  const { start, end } = normaliseRange(source, selection);
  const selected = source.slice(start, end);
  const text = `${source.slice(0, start)}${marker}${selected}${marker}${source.slice(end)}`;
  if (selected.length === 0) {
    const caret = start + marker.length;
    return { text, selectionStart: caret, selectionEnd: caret };
  }
  return {
    text,
    selectionStart: start + marker.length,
    selectionEnd: end + marker.length,
  };
}

/**
 * Toggle a line prefix such as `## `, `- `, `- [ ] ` or `> ` across every
 * selected line. Applying it twice removes it, which is what a toolbar button
 * should do.
 */
export function toggleLinePrefix(source: string, selection: EditSelection, prefix: string): EditResult {
  const range = normaliseRange(source, selection);
  const lineStart = source.lastIndexOf('\n', range.start - 1) + 1;
  const lineEndIndex = source.indexOf('\n', range.end);
  const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;

  const block = source.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const alreadyApplied = lines.every((line) => line.length === 0 || line.startsWith(prefix));

  const rewritten = lines.map((line) => {
    if (line.length === 0) return line;
    if (alreadyApplied) return line.slice(prefix.length);
    // Replace any competing prefix so headings and lists do not stack up.
    return `${prefix}${stripCompetingPrefix(line, prefix)}`;
  });

  const replacement = rewritten.join('\n');
  const text = `${source.slice(0, lineStart)}${replacement}${source.slice(lineEnd)}`;
  return {
    text,
    selectionStart: lineStart,
    selectionEnd: lineStart + replacement.length,
  };
}

const COMPETING_PREFIXES = ['###### ', '##### ', '#### ', '### ', '## ', '# ', '- [ ] ', '- [x] ', '- ', '* ', '+ ', '> '];

function stripCompetingPrefix(line: string, keep: string): string {
  if (keep.startsWith('#')) {
    // Headings replace headings only.
    for (const prefix of COMPETING_PREFIXES) {
      if (prefix !== keep && prefix.startsWith('#') && line.startsWith(prefix)) return line.slice(prefix.length);
    }
    return line;
  }
  for (const prefix of COMPETING_PREFIXES) {
    if (prefix !== keep && line.startsWith(prefix)) return line.slice(prefix.length);
  }
  const ordered = /^\d+[.)]\s+/.exec(line);
  if (ordered) return line.slice(ordered[0].length);
  return line;
}

/** Insert a Markdown link, using the selection as the label when there is one. */
export function insertLink(source: string, selection: EditSelection, href: string, label?: string): EditResult {
  const { start, end } = normaliseRange(source, selection);
  const selected = source.slice(start, end);
  const text = selected.trim().length > 0 ? selected.trim() : (label ?? '');
  const inserted = `[${text}](${href})`;
  const next = `${source.slice(0, start)}${inserted}${source.slice(end)}`;
  // Put the caret in the label when it is empty, so the user can type it.
  if (text.length === 0) {
    const caret = start + 1;
    return { text: next, selectionStart: caret, selectionEnd: caret };
  }
  return { text: next, selectionStart: start + inserted.length, selectionEnd: start + inserted.length };
}

/** Start a new line continuing a list, or end the list on an empty item. */
export function continueList(source: string, selection: EditSelection): EditResult {
  const range = normaliseRange(source, selection);
  const lineStart = source.lastIndexOf('\n', range.start - 1) + 1;
  const lineEndIndex = source.indexOf('\n', range.end);
  const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
  const line = source.slice(lineStart, lineEnd);

  const checklist = CHECKLIST.exec(line);
  const ordered = ORDERED.exec(line);
  const bullet = BULLET.exec(line);

  if (!checklist && !ordered && !bullet) {
    return { text: source, selectionStart: range.start, selectionEnd: range.end };
  }

  const isEmptyItem =
    (checklist && (checklist[4] ?? '').trim().length === 0) ||
    (ordered && (ordered[3] ?? '').trim().length === 0) ||
    (bullet && (bullet[3] ?? '').trim().length === 0);

  // Enter on an empty bullet ends the list instead of adding another one.
  if (isEmptyItem) {
    const text = `${source.slice(0, lineStart)}${source.slice(lineEnd)}`;
    return { text, selectionStart: lineStart, selectionEnd: lineStart };
  }

  let nextPrefix: string;
  if (checklist) nextPrefix = `${checklist[1] ?? ''}${checklist[2] ?? '-'} [ ] `;
  else if (ordered) nextPrefix = `${ordered[1] ?? ''}${(Number.parseInt(ordered[2] ?? '1', 10) + 1).toString()}. `;
  else nextPrefix = `${bullet?.[1] ?? ''}${bullet?.[2] ?? '-'} `;

  const insertion = `\n${nextPrefix}`;
  const at = range.end;
  const text = `${source.slice(0, at)}${insertion}${source.slice(at)}`;
  return { text, selectionStart: at + insertion.length, selectionEnd: at + insertion.length };
}

function normaliseRange(source: string, selection: EditSelection): EditSelection {
  const start = Math.max(0, Math.min(selection.start, source.length));
  const end = Math.max(start, Math.min(selection.end, source.length));
  return { start, end };
}

/** Build the anchor href a note body link should use. */
export function normaliseLinkHref(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(value)) return `https://${value}`;
  return null;
}
