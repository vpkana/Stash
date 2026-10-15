import { extractUrls, domainOf } from '@/lib/url/extract';
import { normalizeUrl } from '@/lib/url/normalize';
import { labelForDomain, labelForPackage, type IncomingShare } from './types';

export { labelForDomain, labelForPackage };
export type { IncomingShare };

/** Raw payload as delivered by the native layer or a PWA share target. */
export interface RawShareInput {
  text?: string | null;
  subject?: string | null;
  sourcePackage?: string | null;
  receivedAt?: number | null;
}

/**
 * Either shape a share can arrive in.
 *
 * There are exactly two, and the difference is *when* it was normalized: the
 * bridges hand over an {@link IncomingShare} (already parsed, because they are
 * the only place that knows what an Android Intent extra or a share-target query
 * string is), while a raw payload is what a test or a stray caller has.
 *
 * Both are accepted rather than one being converted to the other, because both
 * accepted shapes are the ones that actually occur — and because the bug this
 * type exists to prevent was exactly a re-parse of already-parsed data, which
 * silently found no text in an object whose text is called `rawText` and turned
 * every shared link into "nothing to save".
 */
export type ShareInput = RawShareInput | IncomingShare;

function isParsedShare(input: ShareInput): input is IncomingShare {
  return typeof (input as IncomingShare).rawText === 'string';
}

/**
 * Platform boilerplate that ships alongside a shared link and is never part of
 * a real title. Kept as data so it stays reviewable.
 */
const LEAD_IN_PATTERNS: RegExp[] = [
  /^\s*(?:check\s+(?:out|this)\s+(?:this\s+)?(?:video|post|link|article|reel|short)?\s*(?:on|from)?\s*[A-Za-z ]{0,24}:?\s*)/i,
  /^\s*(?:shared|sent)\s+(?:from|via)\s+[A-Za-z .]{0,24}\s*[:—-]?\s*/i,
  /^\s*(?:watch|read|see|view)\s+(?:this\s+)?(?:on\s+)?[A-Za-z .]{0,24}\s*[:—-]\s*/i,
  /^\s*via\s+[A-Za-z .]{0,24}\s*[:—-]?\s*/i,
  /^\s*new\s+(?:video|post|article|reel)\s*[:—-]\s*/i,
];

const SEPARATOR_ONLY = /^[\s\-–—:•|\u2022>»·.]+$/;

const SENTENCE_END = /[.!?…]$/;
/** Beyond these bounds, leftover text is commentary rather than a title. */
const PROSE_MIN_LENGTH = 60;
const PROSE_MAX_WORDS = 16;

/**
 * Turn whatever arrived into the single normalized shape the app understands.
 *
 * Never throws and never drops information: `rawText` always preserves the
 * original payload so a future migration can re-parse it.
 */
export function parseShare(input: ShareInput): IncomingShare {
  // A share that is already normalized is handed straight back: parsing is
  // idempotent by construction, and reading `text` off it (a field it does not
  // have) would produce an empty share instead of the same one.
  if (isParsedShare(input)) return input;

  const text = typeof input.text === 'string' ? input.text : '';
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const { urls } = extractUrls(text);

  const share: IncomingShare = {
    rawText: text,
    urls,
    receivedAt: typeof input.receivedAt === 'number' ? input.receivedAt : Date.now(),
  };
  if (input.sourcePackage) share.sourcePackage = input.sourcePackage;
  if (subject.length > 0 && !/^https?:\/\//i.test(subject)) share.subject = subject;
  return share;
}

/** A capture-ready view of a share, used to prefill the Save Sheet. */
export interface ShareDraft {
  url: string;
  normalizedUrl: string;
  domain: string;
  /** Friendly product name for the domain, e.g. `YouTube`. */
  sourceLabel?: string;
  /** The heading the sender's app supplied, when it looks like one. */
  title?: string;
  sourcePackage?: string;
  appLabel?: string;
  receivedAt: number;
  /** Additional links when the sender shared more than one. */
  otherUrls: string[];
}

export interface ParsedShare {
  share: IncomingShare;
  /** Null when the share contained no usable link (pure text, malformed, empty). */
  draft: ShareDraft | null;
}

const MAX_TITLE_LENGTH = 180;

export function parseShareToDraft(input: ShareInput): ParsedShare {
  // Already normalized by a bridge: use it as it is. Re-parsing it here would
  // read fields it does not have and lose the text it does.
  const share = isParsedShare(input) ? input : parseShare(input);
  const first = share.urls[0];
  if (!first) return { share, draft: null };

  const normalizedUrl = normalizeUrl(first) ?? first;
  const domain = domainOf(first);
  const draft: ShareDraft = {
    url: first,
    normalizedUrl,
    domain,
    receivedAt: share.receivedAt,
    otherUrls: share.urls.slice(1),
  };

  const sourceLabel = labelForDomain(domain);
  if (sourceLabel) draft.sourceLabel = sourceLabel;
  const appLabel = labelForPackage(share.sourcePackage);
  if (appLabel) draft.appLabel = appLabel;
  if (share.sourcePackage) draft.sourcePackage = share.sourcePackage;

  const title = deriveTitle(share, first);
  if (title) draft.title = title;

  return { share, draft };
}

/**
 * A title is only claimed when the leftover text genuinely looks like one.
 * Long prose stays in the note instead of being forced into a heading.
 */
export function deriveTitle(share: IncomingShare, url: string): string | undefined {
  const subject = share.subject;
  if (subject && isTitleLike(subject)) return clamp(subject);

  let text = share.rawText.replace(url, ' ');
  const { urls } = extractUrls(share.rawText);
  for (const extra of urls) text = text.split(extra).join(' ');

  for (const pattern of LEAD_IN_PATTERNS) text = text.replace(pattern, '');

  text = normalizeWhitespace(text);
  if (!isTitleLike(text)) return undefined;
  return clamp(text);
}

function isTitleLike(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) return false;
  if (SEPARATOR_ONLY.test(trimmed)) return false;
  // More than a couple of line breaks means it is a paragraph, not a title.
  if (trimmed.split(/\n/).length > 3) return false;
  return !looksLikeProse(trimmed);
}

/**
 * A sentence someone typed next to a link is their own comment, not the link's
 * title. Titles rarely end in a full stop or run to a dozen-plus words, so those
 * shapes are kept as a note instead of being promoted to a heading.
 */
function looksLikeProse(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean).length;
  if (words > PROSE_MAX_WORDS) return true;
  return SENTENCE_END.test(value) && value.length >= PROSE_MIN_LENGTH;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function clamp(value: string, max = MAX_TITLE_LENGTH): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}
