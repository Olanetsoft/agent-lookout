// Draws the Mac app's icon in the menu bar into `build/menu-bar/`, at 16 and
// 32 pixels, for screens at 1x and 2x. Run it with
// `node scripts/render-menu-bar-icon.mjs` after changing the mark; the PNGs are
// kept in the repository, so a build never runs it, and
// `scripts/build-desktop.mjs` copies them into the app.
//
// It is the product mark, as `LookoutMark` draws it, in one colour on nothing:
// the lens, the horizon across it with the water faintly filled, and the lamp.
// macOS takes only the shape of a template image and paints it in the menu
// bar's own colour, dark on a light bar and light on a dark one, so each is
// black with transparency, and its name ends in `Template`, as macOS and
// Electron read it. The quiet icon has the lamp unlit, a hollow ring, and the
// lit one, shown while a session needs you, has it filled, as the mark has
// when it is lit. The mark's glint on the water has no room at this size.
//
// The mark is redrawn for its size, not scaled down: the strokes are heavier,
// and the horizon and the lamp sit on whole pixels at both sizes, so nothing
// is smeared across two rows. The 1x icon has lines of its own: a lens one
// pixel wide whose edges fall on whole pixels where it crosses the axes, and a
// lamp five pixels across centred on a pixel, so the unlit lamp's hole is a
// clear pixel and not only a lighter middle. Playwright's Chromium renders the
// SVG.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "build", "menu-bar");

/** The icon's size in points: a menu bar holds an icon of 16 by 16. */
const POINTS = 16;

// Drawn on the mark's own 32-unit box, so a unit is half a pixel at 1x and a pixel at 2x.
// The horizon at y 20 to 22, one row at 1x and two at 2x, meeting the lens at x 4 and 28.
const HORIZON = `<rect x="4" y="20" width="24" height="2" fill="#000"/>`;
const WATER = `<path d="M4 21a13 13 0 0 0 24 0z" fill="#000" opacity=".22"/>`;

const lens = (width) => `<circle cx="16" cy="16" r="13" stroke="#000" stroke-width="${width}"/>`;

/** Each size's lens, and its lamp unlit and lit. */
const DRAWN = {
  // A lens of 1 pixel, from 6 to 7 pixels out, and a lamp 5 pixels across
  // centred on the pixel at 9.5 by 6.5: unlit, a ring a pixel wide round a
  // clear middle; lit, filled.
  1: {
    lens: lens(2),
    lamps: {
      quiet: `<circle cx="19" cy="13" r="4" stroke="#000" stroke-width="2"/>`,
      lit: `<circle cx="19" cy="13" r="5" fill="#000"/>`,
    },
  },
  // A heavier lens, and a lamp 8 pixels across centred on a pixel's corner,
  // so its edge and the unlit lamp's hole are whole pixels.
  2: {
    lens: lens(2.4),
    lamps: {
      quiet: `<circle cx="20" cy="14" r="3" stroke="#000" stroke-width="2"/>`,
      lit: `<circle cx="20" cy="14" r="4" fill="#000"/>`,
    },
  },
};

function svg(drawn, lamp) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${POINTS}" height="${POINTS}" viewBox="0 0 32 32" fill="none">${WATER}${drawn.lens}${HORIZON}${lamp}</svg>`;
}

const browser = await chromium.launch();
try {
  await mkdir(outDir, { recursive: true });
  for (const [scale, drawn] of Object.entries(DRAWN).map(([key, value]) => [Number(key), value])) {
    const page = await browser.newPage({
      viewport: { width: POINTS, height: POINTS },
      deviceScaleFactor: scale,
    });
    for (const [name, lamp] of Object.entries(drawn.lamps)) {
      await page.setContent(
        `<body style="margin:0;background:transparent">${svg(drawn, lamp)}</body>`,
      );
      const file = path.join(outDir, `${name}Template${scale === 2 ? "@2x" : ""}.png`);
      await page.screenshot({
        path: file,
        omitBackground: true,
        clip: { x: 0, y: 0, width: POINTS, height: POINTS },
      });
      console.log(`Drew ${path.relative(root, file)}.`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
