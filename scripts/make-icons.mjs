/**
 * Icon generation.
 *
 * Every icon Stash ships is derived from three SVG masters, and this script is
 * the only thing that writes the rasterised copies:
 *
 *   public/icons/icon.svg        the rounded tile        -> web, PWA, legacy launcher
 *   public/icons/maskable.svg    full-bleed background   -> PWA maskable
 *   public/icons/foreground.svg  mark only, transparent  -> Android adaptive icon
 *                                                        -> Android splash bitmaps
 *
 * Rasterising is a build step rather than a design step: a PNG that was drawn by
 * hand drifts from the master the moment the master is edited, and a launcher
 * icon is the one asset nobody re-checks. Run it after any change to the three
 * files above:
 *
 *   node scripts/make-icons.mjs
 *
 * It uses `sharp`, which arrives as a dependency of Next.js. If a future version
 * stops shipping it, `npm i -D sharp` is the fix — nothing else here is unusual.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative));

const TILE = await read('public/icons/icon.svg');
const MASKABLE = await read('public/icons/maskable.svg');
const FOREGROUND = await read('public/icons/foreground.svg');

/** Rasterise an SVG at `size`, blowing it up first so curves stay crisp. */
async function render(svg, size, file, { round = false } = {}) {
  const target = path.join(root, file);
  let image = sharp(svg, { density: 512 }).resize(size, size, { fit: 'contain' });
  if (round) {
    const circle = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
    );
    image = sharp(await image.png().toBuffer()).composite([{ input: circle, blend: 'dest-in' }]);
  }
  await image.png({ compressionLevel: 9 }).toFile(target);
  return file;
}

/**
 * Density buckets Android expects, as multiples of the 48dp baseline. The
 * launcher icon is 48dp, the adaptive foreground is a 108dp canvas.
 */
const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];

const written = [];

// Web: the tab icon, the iOS home-screen icon, and the two manifest sizes.
written.push(await render(TILE, 48, 'src/app/icon.png'));
written.push(await render(TILE, 180, 'src/app/apple-icon.png'));
written.push(await render(TILE, 192, 'public/icons/icon-192.png'));
written.push(await render(TILE, 512, 'public/icons/icon-512.png'));
written.push(await render(MASKABLE, 512, 'public/icons/maskable-512.png'));

// Android: the pre-API-26 launcher icons, and the adaptive-icon foreground.
for (const [bucket, scale] of DENSITIES) {
  const dir = `android/app/src/main/res/mipmap-${bucket}`;
  written.push(await render(TILE, Math.round(48 * scale), `${dir}/ic_launcher.png`));
  written.push(await render(TILE, Math.round(48 * scale), `${dir}/ic_launcher_round.png`, { round: true }));
  written.push(await render(FOREGROUND, Math.round(108 * scale), `${dir}/ic_launcher_foreground.png`));
}

/*
 * Android's legacy splash bitmaps (pre-API 31). The theme paints the window
 * background itself, so these are only reached by a launcher or plugin that asks
 * for the drawable directly — but they are still derived from the master rather
 * than drawn separately: the mark, in the tile's ink, centred on the app's own
 * light background.
 */
const SPLASH_BACKGROUND = '#F6F7FB';
const SPLASHES = [
  ['drawable', 480, 320],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
];
const SPLASH_MARK = Buffer.from(FOREGROUND.toString('utf8').replaceAll('#FFFFFF', '#1F1E50'));

for (const [dir, width, height] of SPLASHES) {
  const edge = Math.round(Math.min(width, height) * 0.24);
  /*
   * `foreground.svg` draws the mark at 40% of its canvas — the adaptive-icon safe
   * zone. The splash has no launcher mask to dodge, so the canvas is scaled up by
   * that same factor and the mark ends up exactly `edge` tall.
   */
  const canvas = Math.round(edge * 2.5);
  const mark = await sharp(SPLASH_MARK, { density: 512 }).resize(canvas, canvas).png().toBuffer();
  await sharp({ create: { width, height, channels: 3, background: SPLASH_BACKGROUND } })
    .composite([{ input: mark, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(root, `android/app/src/main/res/${dir}/splash.png`));
  written.push(`android/app/src/main/res/${dir}/splash.png`);
}

// The point of running this is to see what it wrote.
// eslint-disable-next-line no-console
for (const file of written) console.log(`wrote ${file}`);
