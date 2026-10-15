import { describe, expect, it } from 'vitest';
import { parseShare, parseShareToDraft } from '@/lib/share/parse';
import { labelForDomain, labelForPackage } from '@/lib/share/types';
import { createWebShareBridge } from '@/lib/share/bridge';

/**
 * The five share shapes the product promises to handle, plus the normalizations
 * the Android bridge depends on.
 */
describe('parseShare', () => {
  it('always preserves the raw payload', () => {
    const raw = 'Check this out! https://example.com/a';
    expect(parseShare({ text: raw }).rawText).toBe(raw);
  });

  it('never throws on empty or null input', () => {
    expect(parseShare({ text: null }).urls).toEqual([]);
    expect(parseShare({}).rawText).toBe('');
  });

  it('ignores a subject that is itself a URL', () => {
    const share = parseShare({ text: 'hello', subject: 'https://example.com/x' });
    expect(share.subject).toBeUndefined();
  });
});

describe('parseShareToDraft', () => {
  it('case 1: a URL on its own', () => {
    const { draft } = parseShareToDraft({ text: 'https://example.com/article' });
    expect(draft?.url).toBe('https://example.com/article');
    expect(draft?.domain).toBe('example.com');
    expect(draft?.title).toBeUndefined();
  });

  it('case 2: a title plus a URL', () => {
    const { draft } = parseShareToDraft({
      text: 'Binary Search Explained\nhttps://youtube.com/watch?v=abc',
    });
    expect(draft?.title).toBe('Binary Search Explained');
    expect(draft?.sourceLabel).toBe('YouTube');
  });

  it('case 3: arbitrary prose containing a URL keeps the link and claims no title', () => {
    const { draft } = parseShareToDraft({
      text: 'Highly recommend this write-up about indexing https://example.com/indexes because it changed how I model queries.',
    });
    // A link has one name, and long prose is not one: the address is still saved
    // and the user names it afterwards if they want to. Forcing a paragraph into
    // the heading is what the removed note was papering over.
    expect(draft?.url).toBe('https://example.com/indexes');
    expect(draft?.title).toBeUndefined();
  });

  it('case 4: several URLs in one share', () => {
    const { draft } = parseShareToDraft({
      text: 'https://example.com/one and also https://example.com/two and https://example.com/three',
    });
    expect(draft?.url).toBe('https://example.com/one');
    expect(draft?.otherUrls).toEqual(['https://example.com/two', 'https://example.com/three']);
  });

  it('case 5: malformed content yields no draft instead of a bad link', () => {
    expect(parseShareToDraft({ text: 'shared from an app with no link' }).draft).toBeNull();
    expect(parseShareToDraft({ text: '' }).draft).toBeNull();
    expect(parseShareToDraft({}).draft).toBeNull();
  });

  it('strips platform lead-ins from the derived title', () => {
    const { draft } = parseShareToDraft({
      text: 'Check out this video on YouTube: https://youtube.com/watch?v=xyz',
    });
    expect(draft?.title).toBeUndefined();
  });

  it('uses EXTRA_SUBJECT as the title when it looks like one', () => {
    const { draft } = parseShareToDraft({
      subject: 'Understanding IndexedDB Transactions',
      text: 'https://example.com/idb',
    });
    expect(draft?.title).toBe('Understanding IndexedDB Transactions');
  });

  it('labels the source app from its package name', () => {
    const { draft } = parseShareToDraft({
      text: 'https://youtube.com/shorts/abc',
      sourcePackage: 'com.google.android.youtube',
    });
    expect(draft?.appLabel).toBe('YouTube');
    expect(draft?.sourcePackage).toBe('com.google.android.youtube');
  });

  it('carries the normalized form so duplicate detection is exact', () => {
    const { draft } = parseShareToDraft({ text: 'https://youtu.be/abc123' });
    expect(draft?.normalizedUrl).toBe('https://youtube.com/watch?v=abc123');
    expect(draft?.url).toBe('https://youtu.be/abc123');
  });

  it('falls back to a friendly tail for unknown package names', () => {
    expect(labelForPackage('com.unknown.publisher.app')).toBe('App');
    expect(labelForPackage(undefined)).toBeUndefined();
  });

  it('maps subdomains to their parent product label', () => {
    expect(labelForDomain('news.ycombinator.com')).toBe('Hacker News');
    expect(labelForDomain('unknown.example')).toBe('unknown.example');
  });
});

describe('web share bridge', () => {
  it('reads a PWA share target payload from the query string', async () => {
    const bridge = createWebShareBridge('?title=Great+post&text=https%3A%2F%2Fexample.com%2Fp');
    expect(bridge.isAvailable()).toBe(true);
    const share = await bridge.getPendingShare();
    expect(share?.urls).toEqual(['https://example.com/p']);
  });

  it('is inert when there is no payload', () => {
    const bridge = createWebShareBridge('');
    expect(bridge.isAvailable()).toBe(false);
  });

  it('does not duplicate a title that the text already contains', () => {
    const bridge = createWebShareBridge('?title=Hello&text=Hello+https%3A%2F%2Fexample.com');
    expect(bridge.kind).toBe('web');
  });
});
