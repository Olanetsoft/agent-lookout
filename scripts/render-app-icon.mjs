// Draws the Mac app's icon into `build/icon.png`, from which electron-builder
// makes the app's .icns. Run it with `node scripts/render-app-icon.mjs` after
// changing the mark; the PNG is kept in the repository, so a build never runs it.
//
// It is the product mark, as `LookoutMark` draws it and as the favicon does, on
// the body of a macOS icon: a rounded square of the polished black ground, lit
// from the top right, with the lamp lit amber and its light in the lens. The
// body is an 824px squircle in a 1024px canvas, as Apple's icon grid has it,
// with a soft shadow under it. Playwright's Chromium renders the SVG.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "icon.png");

const SIZE = 1024;
const BODY = 824;

/** The icon's body: a superellipse, which is close to the shape macOS gives its icons. */
function squircle() {
  const exponent = 5;
  const points = [];
  for (let step = 0; step < 720; step += 1) {
    const angle = (step / 720) * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
    const y = Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
    points.push(
      `${(SIZE / 2 + (BODY / 2) * x).toFixed(2)},${(SIZE / 2 + (BODY / 2) * y).toFixed(2)}`,
    );
  }
  return `M${points.join("L")}Z`;
}

// The mark's own 32-unit box, scaled so the lens is about 62% of the body.
const SCALE = 19.5;
const MARK = SIZE / 2 - 16 * SCALE;
const LAMP = { x: MARK + 20.6 * SCALE, y: MARK + 15.1 * SCALE };
const BODY_PATH = squircle();

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c1a17"/>
      <stop offset=".46" stop-color="#100f0d"/>
      <stop offset="1" stop-color="#080807"/>
    </linearGradient>
    <radialGradient id="field" cx=".86" cy=".08" r=".95">
      <stop offset="0" stop-color="rgb(218,214,207)" stop-opacity=".22"/>
      <stop offset=".55" stop-color="rgb(218,214,207)" stop-opacity=".05"/>
      <stop offset="1" stop-color="rgb(218,214,207)" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="lamp-light" cx="${LAMP.x}" cy="${LAMP.y}" r="${11 * SCALE}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="rgb(255,166,60)" stop-opacity=".55"/>
      <stop offset=".35" stop-color="rgb(255,166,60)" stop-opacity=".16"/>
      <stop offset="1" stop-color="rgb(255,166,60)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb(255,248,238)" stop-opacity=".42"/>
      <stop offset=".5" stop-color="rgb(255,248,238)" stop-opacity=".08"/>
      <stop offset="1" stop-color="rgb(255,248,238)" stop-opacity=".03"/>
    </linearGradient>
    <linearGradient id="ink" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f7f4ee"/>
      <stop offset="1" stop-color="#d9d4cb"/>
    </linearGradient>
    <clipPath id="body"><path d="${BODY_PATH}"/></clipPath>
    <!-- Filters work in sRGB: in linear light the dark ground bands. -->
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="12"/>
      <feComponentTransfer><feFuncA type="linear" slope=".38"/></feComponentTransfer>
    </filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .9 -.35"/>
    </filter>
  </defs>
  <path d="${BODY_PATH}" fill="#000" filter="url(#shadow)" transform="translate(0 10)"/>
  <path d="${BODY_PATH}" fill="url(#ground)"/>
  <g clip-path="url(#body)">
    <rect width="${SIZE}" height="${SIZE}" fill="url(#field)"/>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#lamp-light)"/>
    <rect width="${SIZE}" height="${SIZE}" filter="url(#grain)" opacity=".05"/>
  </g>
  <path d="${BODY_PATH}" fill="none" stroke="url(#rim)" stroke-width="3"/>
  <g transform="translate(${MARK} ${MARK}) scale(${SCALE})" fill="none">
    <path d="M3.63 20a13 13 0 0 0 24.74 0z" fill="url(#ink)" opacity=".1"/>
    <circle cx="16" cy="16" r="13" stroke="url(#ink)" stroke-width="1.6"/>
    <path d="M3.63 20h24.74" stroke="url(#ink)" stroke-width="1.6"/>
    <circle cx="20.6" cy="15.1" r="2.7" fill="#ffb547" stroke="#ffc46b" stroke-width=".9"/>
    <path d="M18.9 23.6h3.4" stroke="#ffb547" stroke-width="1.4" stroke-linecap="round"/>
  </g>
</svg>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
  await page.screenshot({
    path: out,
    omitBackground: true,
    clip: { x: 0, y: 0, width: SIZE, height: SIZE },
  });
  console.log(`Drew the app icon into ${path.relative(root, out)}.`);
} finally {
  await browser.close();
}
