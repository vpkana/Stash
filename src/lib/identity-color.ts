/**
 * Identity colour.
 *
 * The app is vivid, and this is where the vividness comes from. An identity tone
 * is a *label*: each folder, note and link gets one tone, derived from its own
 * identity, and keeps it. Two things follow, and both are the point:
 *
 *  - a colour is stable, so it becomes information. The user learns "the Studio
 *    folder is the violet one" and can find it in a list of forty without reading
 *    a single label. A tone assigned per render, or by list position, would be
 *    decoration and would actively hurt — the same folder changing colour every
 *    time you open the Library is worse than no colour at all;
 *  - a domain gets a tone derived from the *domain*, so YouTube is the same red
 *    on the Home row, inside a folder, in search and in the capture sheet. That
 *    is real recognition, and it is why the source map below is worth keeping.
 *
 * The value is deliberately small and closed: eight tones, one hash, no
 * configuration. It is a lookup table, not a theming system, and it should stay
 * one.
 */

export const IDENTITY_TONES = [
  'rose',
  'orange',
  'amber',
  'emerald',
  'cyan',
  'blue',
  'violet',
  'fuchsia',
] as const;

export type IdentityTone = (typeof IDENTITY_TONES)[number];

export interface IdentityColor {
  tone: IdentityTone;
  /** A leading tile: tinted background, vivid glyph. */
  tile: string;
  /** Vivid text only, for a chip or a count. */
  text: string;
  /** A solid swatch, for a dot or a rule. */
  solid: string;
}

/*
 * Written out in full rather than composed from the tone name.
 *
 * This is not verbosity for its own sake: Tailwind reads class names out of the
 * source as literal strings, so a template like `bg-id-${tone}-soft` would
 * compile to no CSS at all and every tile would silently go transparent. The
 * literal strings below are the *only* thing that makes these utilities exist.
 */
const TONES: Record<IdentityTone, IdentityColor> = {
  rose: {
    tone: 'rose',
    tile: 'bg-id-rose-soft text-id-rose',
    text: 'text-id-rose',
    solid: 'bg-id-rose',
  },
  orange: {
    tone: 'orange',
    tile: 'bg-id-orange-soft text-id-orange',
    text: 'text-id-orange',
    solid: 'bg-id-orange',
  },
  amber: {
    tone: 'amber',
    tile: 'bg-id-amber-soft text-id-amber',
    text: 'text-id-amber',
    solid: 'bg-id-amber',
  },
  emerald: {
    tone: 'emerald',
    tile: 'bg-id-emerald-soft text-id-emerald',
    text: 'text-id-emerald',
    solid: 'bg-id-emerald',
  },
  cyan: {
    tone: 'cyan',
    tile: 'bg-id-cyan-soft text-id-cyan',
    text: 'text-id-cyan',
    solid: 'bg-id-cyan',
  },
  blue: {
    tone: 'blue',
    tile: 'bg-id-blue-soft text-id-blue',
    text: 'text-id-blue',
    solid: 'bg-id-blue',
  },
  violet: {
    tone: 'violet',
    tile: 'bg-id-violet-soft text-id-violet',
    text: 'text-id-violet',
    solid: 'bg-id-violet',
  },
  fuchsia: {
    tone: 'fuchsia',
    tile: 'bg-id-fuchsia-soft text-id-fuchsia',
    text: 'text-id-fuchsia',
    solid: 'bg-id-fuchsia',
  },
};

export function toneColor(tone: IdentityTone): IdentityColor {
  return TONES[tone];
}

/**
 * FNV-1a, 32-bit.
 *
 * Chosen over `String.length` arithmetic or `charCodeAt` sums because those
 * collide in a way a human notices: folder names that differ by one character,
 * or by letter order, land on the same tone. This spreads short, similar strings,
 * which is exactly what folder and domain names are.
 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    // The FNV prime, by shift-add: `* 16777619` overflows a double before it
    // overflows a uint32.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

/** A stable tone for any identity string — a folder id, a note id, a domain. */
export function identityTone(key: string): IdentityTone {
  if (key.length === 0) return 'blue';
  return IDENTITY_TONES[hash(key) % IDENTITY_TONES.length]!;
}

export function identityColor(key: string): IdentityColor {
  return TONES[identityTone(key)];
}

/*
 * Domains people actually save from, pinned to a tone.
 *
 * The hash would spread these fine on its own; pinning is about the *pairing*
 * being memorable and correct rather than merely distinct — a red YouTube tile
 * next to a red Instagram tile would undo the recognition the colour is for. So
 * neighbours in the popular set are forced apart, and the well-known brand
 * association is kept where it is genuinely helpful (YouTube red, GitHub violet,
 * Spotify green).
 */
const DOMAIN_TONES: Record<string, IdentityTone> = {
  'youtube.com': 'rose',
  'youtu.be': 'rose',
  'youtube-nocookie.com': 'rose',
  'instagram.com': 'fuchsia',
  'facebook.com': 'blue',
  'fb.com': 'blue',
  'x.com': 'cyan',
  'twitter.com': 'cyan',
  'reddit.com': 'orange',
  'linkedin.com': 'blue',
  'github.com': 'violet',
  'gitlab.com': 'orange',
  'stackoverflow.com': 'amber',
  'news.ycombinator.com': 'orange',
  'wikipedia.org': 'emerald',
  'medium.com': 'emerald',
  'substack.com': 'orange',
  'notion.so': 'amber',
  'spotify.com': 'emerald',
  'soundcloud.com': 'orange',
  'pinterest.com': 'rose',
  'tiktok.com': 'cyan',
  'twitch.tv': 'violet',
  'netflix.com': 'rose',
  'amazon.com': 'amber',
  'docs.google.com': 'blue',
  'drive.google.com': 'amber',
  'developer.mozilla.org': 'violet',
  'npmjs.com': 'rose',
  'arxiv.org': 'rose',
  'figma.com': 'fuchsia',
  'dribbble.com': 'rose',
  'behance.net': 'blue',
};

/** The tone for a link's source domain, pinned where it is worth pinning. */
export function domainColor(domain: string | undefined | null): IdentityColor {
  if (!domain) return TONES.blue;
  const key = domain.toLowerCase().replace(/^www\./, '');
  const pinned = DOMAIN_TONES[key];
  if (pinned) return TONES[pinned];
  // A subdomain inherits its registrable parent's tone, so `m.youtube.com` and
  // `music.youtube.com` are the same colour as `youtube.com`.
  const parent = key.split('.').slice(-2).join('.');
  const inherited = DOMAIN_TONES[parent];
  if (inherited) return TONES[inherited];
  return TONES[identityTone(key)];
}
