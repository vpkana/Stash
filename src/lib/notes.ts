import type { Note, SavedLink } from '@/db/types';
import { displayUrl } from '@/lib/format';
import { labelForDomain } from '@/lib/share/types';

/**
 * Note-domain helpers that sit between the storage layer and the UI.
 *
 * Nothing here talks to IndexedDB or to React, so every rule about how a note
 * behaves (what a title falls back to, how a link becomes the seed of a note) is
 * testable on plain objects.
 */

/**
 * The notes a browsing UI should show.
 *
 * This used to remove archived notes and their whole subtrees. It no longer
 * removes anything, and the reason is worth keeping written down: archiving was
 * the one state a user could enter and not get out of, because it hid a row from
 * every surface they were looking at. The field is still on the type — a backup
 * written by an older build carries it, and version 6 of the database migrates
 * every archived row back to false — but nothing can set it and nothing hides on
 * it any more.
 *
 * It is kept as a named function rather than deleted so every caller keeps
 * stating, in one place, that "what a browsing UI shows" is a decision this
 * module makes; if a visibility rule is ever needed again it belongs here.
 */
export function visibleNotes(notes: readonly Note[]): Note[] {
  return [...notes];
}

export const NOTE_TITLE_MAX = 120;

/** First meaningful line of the content, used when a note has no title yet. */
export function deriveNoteTitle(content: string, fallback = 'Untitled note'): string {
  for (const rawLine of content.split('\n')) {
    const line = rawLine
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/[*_`>]/g, '')
      .trim();
    if (line.length > 0) return line.slice(0, NOTE_TITLE_MAX);
  }
  return fallback;
}

/** Collapse whitespace so a title typed with stray spaces still compares equal. */
export function sanitizeNoteTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, NOTE_TITLE_MAX);
}

/** Plain-text projection of note content, for search, snippets, and previews. */
export function notePlainText(content: string, limit = 400): string {
  const flattened = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+[.)]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flattened.length > limit ? `${flattened.slice(0, limit - 1)}…` : flattened;
}

/**
 * A one-line description of what a note holds, for lists. Prefers the note's own
 * opening text and falls back to counting subnotes so a parent note reads as a
 * container rather than as "empty".
 */
export function notePreview(content: string, childCount = 0, limit = 160): string {
  const text = notePlainText(content, limit);
  if (text.length > 0) return text;
  if (childCount === 1) return '1 subnote';
  if (childCount > 1) return `${childCount} subnotes`;
  return 'Empty note';
}

/** Default title for a note born from a saved link. */
export function titleFromLink(link: SavedLink): string {
  const title = link.title?.trim();
  if (title) return sanitizeNoteTitle(title);
  if (link.source) {
    const label = labelForDomain(link.source);
    if (label) return sanitizeNoteTitle(label);
  }
  return sanitizeNoteTitle(displayUrl(link.url, 60)) || 'Saved link';
}

/**
 * Starting content for a note created from a link.
 *
 * The URL is written as a Markdown link so the note is self-contained if it is
 * ever exported or pasted elsewhere, and the user's own note text is carried
 * over. The crawlable reference lives in `noteLinks`, not here.
 */
export function contentFromLink(link: SavedLink, options: { includeLinkUrl?: boolean } = {}): string {
  const { includeLinkUrl = true } = options;
  const parts: string[] = [];
  if (includeLinkUrl) parts.push(`[${titleFromLink(link)}](${link.url})`);
  if (link.userNote?.trim()) parts.push(link.userNote.trim());
  if (parts.length === 0) return '';
  return `${parts.join('\n\n')}\n`;
}

/** Notes that are the note itself plus its ancestors, for lock/visibility checks. */
export function isNoteVisible(noteId: string, visible: readonly Note[]): boolean {
  return visible.some((note) => note.id === noteId);
}
