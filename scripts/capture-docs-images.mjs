// Takes the pictures the README and the guide show, in docs/images/, from the
// landing page's tour: the real dashboard, as site/tour/ builds it from a
// release, with the hour it is given in src/site-tour/feed/. So the pictures
// show what the app does in that release, and the same build, on the same
// system with the same Playwright, gives the same pictures, byte for byte.
//
//   npm run capture:images                 reuses site/tour/, and builds it
//                                          first only when it is missing
//   npm run capture:images -- --build      builds site/tour/ first, as
//                                          npm run build:tour does
//   npm run capture:images -- --out <dir>  writes the pictures into another
//                                          folder, to compare them first
//
// Run it after a release that changes the dashboard, once npm run build:tour
// has built that release's tour, then look at each picture and commit
// docs/images/. When a picture shows something new, bring its alt text in
// README.md or docs/GUIDE.md up to what it shows.
//
// How it works. It serves site/ itself on a free port on 127.0.0.1, opens
// /tour/ in Playwright's Chromium, on its own and not inside the landing page,
// and puts the dashboard in a scene of the tour the way the landing page does:
// by the "scene" and "theme" messages of src/site-tour/director/bridge.ts,
// which the director in src/site-tour/director/director.ts applies through the
// dashboard's own addresses and controls. Each scene is found by its name in
// src/site-tour/feed/scenes.ts, and the page is checked for what the picture
// must show before it is taken, so a scene renamed or changed stops the script
// rather than giving a wrong picture.
//
// Every picture is a window 1440 CSS pixels wide at twice the density, in
// Night or Day, and 900 high, except Sources, whose cards and table run past
// 900: its window is as tall as the whole view, so one picture holds the
// agents found, the other machine and the table, with the ground behind all of
// it. The Overview with nothing waiting, which the guide shows beside what it
// says of the Needs you panel, ends where the row under the panel and the
// Last hour chart begins, so no row of the list is cut through.
//
// The clock is held at 09:12:00 UTC on 5 October 2026, the moment the landing
// page's own pictures show, with the locale en-US and reduced motion, and the
// picture is taken once the fonts are in, the scene has stopped changing, and
// every animation is let finish.
//
// The ground's dither is left out of the pictures. It moves each pixel by
// about two levels so the dark gradients do not band on a screen, and cannot
// be seen as texture, but a PNG cannot pack it: with it every picture is about
// twice the size. Playwright's PNG is then written again, losslessly, at its
// smallest: RGB when no pixel is transparent, a palette when it has 256
// colours or fewer, and the rows filtered whichever way packs best, under
// zlib's strongest setting.
//
// It fails if the page logs an error or asks for anything outside its own
// address, and it stops its server and the browser whatever happens. It writes
// the pictures only once every one is taken and the page did nothing wrong, so
// a run that fails leaves the folder as it was.

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
if (outAt !== -1 && !args[outAt + 1]) {
  throw new Error("Usage: node scripts/capture-docs-images.mjs [--build] [--out <folder>]");
}
const out = path.resolve(outAt === -1 ? path.join(root, "docs/images") : args[outAt + 1]);

/** The moment every picture shows: 09:12:00 UTC on 5 October 2026. */
const NOW = Date.UTC(2026, 9, 5, 9, 12, 0);
const VIEWPORT = { width: 1440, height: 900 };
const DENSITY = 2;
/** How long the scene must stay as it is before the picture is taken. */
const STILL_MS = 1500;

/** The ports the app and its dev server use, which this never takes. */
const RESERVED_PORTS = new Set([4777, 5173]);

/** The ground's dither, left out: see above. */
const NO_DITHER = ".ground::after { display: none !important; }";

/**
 * Each picture: the tour's scene and step it shows, its theme, whether its
 * window is as tall as the whole view or it is cut below the Overview's top
 * row, and what the page must show before it is taken, as a function run in
 * the page that returns what is missing.
 */
const PICTURES = [
  {
    file: "dashboard-night.png",
    scene: "Needs you",
    step: 0,
    theme: "dark",
    expect: needsYouShown,
  },
  {
    file: "dashboard-day.png",
    scene: "Needs you",
    step: 0,
    theme: "light",
    expect: needsYouShown,
  },
  {
    file: "quiet-night.png",
    scene: "One screen",
    step: 0,
    theme: "dark",
    topRow: true,
    expect: () => {
      const missing = [];
      if (document.querySelector("main")?.dataset.view !== "overview") missing.push("Overview");
      const hero = document.querySelector('[data-slot="hero"]');
      if (!hero?.textContent?.includes("Nothing needs you")) missing.push("Nothing needs you");
      return missing;
    },
  },
  {
    file: "sources-night.png",
    scene: "Sources",
    step: 0,
    theme: "dark",
    whole: true,
    expect: () => {
      const missing = [];
      if (document.querySelector("main")?.dataset.view !== "sources") missing.push("Sources");
      const titled = (title) =>
        [...document.querySelectorAll("section[aria-labelledby]")].find((section) =>
          document
            .getElementById(section.getAttribute("aria-labelledby") ?? "")
            ?.textContent?.trim()
            .startsWith(title),
        );
      const inView = (element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      };
      for (const agent of ["Claude Code", "Codex", "Status files"]) {
        const card = titled(agent);
        if (!card?.textContent?.includes("Watching")) missing.push(`${agent} Watching`);
      }
      // The other machine of the tour's hour, src/site-tour/feed/hour.ts.
      const machine = titled("devbox");
      if (!machine?.textContent?.includes("Connected")) missing.push("devbox Connected");
      else if (!inView(machine)) missing.push("devbox's card in sight");
      const table = titled("What each agent can report");
      if (!table) missing.push("What each agent can report");
      else if (!inView(table)) missing.push("What each agent can report in sight");
      return missing;
    },
  },
];

/**
 * The Overview with a session waiting for permission, its command, Deny and
 * Allow, and the Sessions list, with the row of the session on devbox, the
 * other machine of the tour's hour, in sight.
 */
function needsYouShown() {
  const missing = [];
  if (document.querySelector("main")?.dataset.view !== "overview") missing.push("Overview");
  const answer = document.querySelector('[data-slot="hero"] [data-slot="answer"]');
  if (!answer) missing.push("the request with Deny and Allow");
  const buttons = [...(answer?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim());
  for (const label of ["Deny", "Allow"]) {
    if (!buttons.includes(label)) missing.push(label);
  }
  const sessions = [...document.querySelectorAll("section[aria-labelledby]")].find((section) =>
    document
      .getElementById(section.getAttribute("aria-labelledby") ?? "")
      ?.textContent?.trim()
      .startsWith("Sessions"),
  );
  if (!sessions) missing.push("the Sessions list");
  else if (sessions.getBoundingClientRect().top > window.innerHeight - 200) {
    missing.push("the Sessions list in sight");
  }
  // The badge Machine.tsx puts by the name of a session on another machine.
  const machineTag = [...(sessions?.querySelectorAll('[data-part="machine"]') ?? [])].find(
    (badge) => badge.textContent.trim() === "on devbox",
  );
  if (!machineTag) missing.push("a row on devbox");
  else if (machineTag.getBoundingClientRect().bottom > window.innerHeight) {
    missing.push("the row on devbox in sight");
  }
  return missing;
}

// The tour, as the release builds it.

const tourPage = path.join(site, "tour/index.html");
if (args.includes("--build") || !existsSync(tourPage)) {
  execFileSync(process.execPath, [path.join(root, "scripts/site-tour/build.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
}

/** The tour's scenes, by name, in the order the director numbers them. */
async function sceneNames() {
  const source = await readFile(path.join(root, "src/site-tour/feed/scenes.ts"), "utf8");
  const list = source.slice(source.indexOf("export const SCENES"));
  return [...list.matchAll(/^ {4}name: "([^"]+)",$/gm)].map((match) => match[1]);
}

const names = await sceneNames();
for (const picture of PICTURES) {
  picture.index = names.indexOf(picture.scene);
  if (picture.index === -1) {
    throw new Error(
      `The tour has no scene named ${picture.scene} in src/site-tour/feed/scenes.ts.`,
    );
  }
}

// site/, served as Vercel serves it.

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** The file a path names in site/, as Vercel finds it: `/tour/` is `tour/index.html`. */
function fileFor(pathname) {
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  for (const candidate of [clean, `${clean}.html`, path.join(clean, "index.html")]) {
    const file = path.join(site, candidate);
    if (file.startsWith(site) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/** Serves site/ on 127.0.0.1, on a port the system picks that is not the app's own. */
async function serveSite() {
  for (;;) {
    const server = createServer((request, response) => {
      const file = fileFor(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      if (!file) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    if (!RESERVED_PORTS.has(port)) return { server, origin: `http://127.0.0.1:${port}` };
    server.close();
  }
}

// The pictures.

/**
 * Holds the page's clock at `now`, before any of its own script runs: the
 * tour's clock, src/site-tour/host/clock.ts, then reads that time and keeps it.
 * Only Date is held. Playwright's own clock would hold performance too, and
 * its stand-in keeps none of the measures `settle` counts.
 */
function holdTheClock(now) {
  class HeldDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = HeldDate;
}

/**
 * Waits until the fonts are in, the director has applied no scene for
 * STILL_MS, by the "tour:scene" measure it records as it finishes each, and
 * two frames are drawn. The tour draws each of its views once before it
 * applies the scene it was last given, so this is the scene asked for.
 */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  const applied = () => page.evaluate(() => performance.getEntriesByName("tour:scene").length);
  let last = await applied();
  let stillFor = 0;
  for (let waited = 0; stillFor < STILL_MS; waited += 250) {
    if (waited > 30_000) throw new Error("The tour did not settle on its scene in 30 seconds.");
    await page.waitForTimeout(250);
    const now = await applied();
    stillFor = now === last && now > 0 ? stillFor + 250 : 0;
    last = now;
  }
  await page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
  );
}

/** The Overview's top row, the Needs you panel and the Last hour chart, down to where the next row begins. */
async function topRow(page) {
  const height = await page.evaluate(() => {
    const hero = document.querySelector('[data-slot="hero"]').getBoundingClientRect();
    const tops = [...document.querySelectorAll("section[aria-labelledby]")]
      .map((card) => card.getBoundingClientRect().top)
      .filter((top) => top >= hero.bottom);
    return Math.min(...tops);
  });
  return { x: 0, y: 0, width: VIEWPORT.width, height };
}

async function take(browser, origin, picture, problems) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DENSITY,
    colorScheme: picture.theme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(holdTheClock, NOW);
    page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
    page.on("pageerror", (error) => problems.push(`error: ${error}`));
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith("data:") && new URL(url).origin !== origin) {
        problems.push(`left the page's address: ${url}`);
      }
    });
    await page.goto(`${origin}/tour/`, { waitUntil: "load" });
    // As the landing page says them: the theme, then the scene. The tour applies the
    // last scene it was given once it has drawn each of its views.
    await page.evaluate(
      ({ theme, index, step }) => {
        window.postMessage({ type: "theme", theme }, location.origin);
        window.postMessage({ type: "scene", index, step, lamp: null }, location.origin);
      },
      { theme: picture.theme, index: picture.index, step: picture.step },
    );
    await page.addStyleTag({ content: NO_DITHER });
    await settle(page);
    if ((await page.locator(".ground").count()) === 0) {
      throw new Error(
        `${picture.file}: the dashboard's ground, whose dither is left out, has moved.`,
      );
    }
    // A window as tall as the view: grown until the view no longer runs past it.
    for (let tries = 0; picture.whole; tries++) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      if (height <= page.viewportSize().height) break;
      if (tries === 3) throw new Error(`${picture.file}: the view grows with the window.`);
      await page.setViewportSize({ width: VIEWPORT.width, height });
      await settle(page);
    }
    const missing = await page.evaluate(picture.expect);
    if (missing.length > 0) {
      throw new Error(`${picture.file}: the page does not show ${missing.join(", ")}.`);
    }
    const clip = picture.topRow ? await topRow(page) : undefined;
    const shot = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "device",
      clip,
    });
    return smallestPng(shot);
  } finally {
    await context.close();
  }
}

// The smallest lossless PNG of what Playwright gives.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks that say how to show the pixels, kept as they are. Every other ancillary chunk is left out. */
const KEPT = new Set(["sRGB", "iCCP", "gAMA", "cHRM", "pHYs"]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, sum]);
}

/** The PNG's header, the chunks kept, and its pixels with the filters undone, or null for a kind it does not rewrite. */
function decode(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) return null;
  let header = null;
  const kept = [];
  const data = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = body;
    else if (type === "IDAT") data.push(body);
    else if (KEPT.has(type)) kept.push(chunk(type, body));
    at += 12 + length;
  }
  if (!header) return null;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, kind, , , interlace] = header.subarray(8);
  const channels = { 2: 3, 6: 4 }[kind];
  if (depth !== 8 || !channels || interlace !== 0) return null;

  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0;
      const corner = y > 0 && x >= channels ? pixels[row - stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, corner);
      pixels[row + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels, kept };
}

function paeth(left, up, corner) {
  const p = left + up - corner;
  const a = Math.abs(p - left);
  const b = Math.abs(p - up);
  const c = Math.abs(p - corner);
  if (a <= b && a <= c) return left;
  return b <= c ? up : corner;
}

/** RGB in place of RGBA when every pixel is opaque. */
function withoutAlpha(image) {
  if (image.channels !== 4) return image;
  const { pixels } = image;
  for (let at = 3; at < pixels.length; at += 4) if (pixels[at] !== 255) return image;
  const rgb = Buffer.alloc((pixels.length / 4) * 3);
  for (let from = 0, to = 0; from < pixels.length; from += 4, to += 3) {
    rgb[to] = pixels[from];
    rgb[to + 1] = pixels[from + 1];
    rgb[to + 2] = pixels[from + 2];
  }
  return { ...image, channels: 3, pixels: rgb };
}

/** The image as palette indices, when it has 256 colours or fewer, or null. */
function asPalette(image) {
  const { pixels, channels } = image;
  const colours = new Map();
  const indices = Buffer.alloc(pixels.length / channels);
  for (let at = 0, i = 0; at < pixels.length; at += channels, i++) {
    const key = pixels.readUIntBE(at, channels);
    let index = colours.get(key);
    if (index === undefined) {
      if (colours.size === 256) return null;
      index = colours.size;
      colours.set(key, index);
    }
    indices[i] = index;
  }
  const palette = Buffer.alloc(colours.size * 3);
  const alpha = Buffer.alloc(colours.size);
  for (const [key, index] of colours) {
    const bytes = Buffer.alloc(channels);
    bytes.writeUIntBE(key, 0, channels);
    bytes.copy(palette, index * 3, 0, 3);
    alpha[index] = channels === 4 ? bytes[3] : 255;
  }
  return { indices, palette, alpha: alpha.some((a) => a !== 255) ? alpha : null };
}

/** Deflate's window: how far back it can find bytes to repeat. */
const WINDOW = 32 * 1024;

/**
 * The rows filtered: each with the one filter given, or, for "each row", with
 * the filter whose bytes add least to a quick deflate of the rows just before
 * it, as many as deflate's window holds beside it.
 */
function filtered(pixels, width, height, bpp, choice) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const filters = choice === "each row" ? [0, 1, 2, 3, 4] : [choice];
  const candidates = filters.map(() => Buffer.alloc(stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    filters.forEach((filter, at) => {
      const line = candidates[at];
      line[0] = filter;
      for (let x = 0; x < stride; x++) {
        const left = x >= bpp ? pixels[row + x - bpp] : 0;
        const up = y > 0 ? pixels[row - stride + x] : 0;
        const corner = y > 0 && x >= bpp ? pixels[row - stride + x - bpp] : 0;
        let value = pixels[row + x];
        if (filter === 1) value -= left;
        else if (filter === 2) value -= up;
        else if (filter === 3) value -= (left + up) >> 1;
        else if (filter === 4) value -= paeth(left, up, corner);
        line[x + 1] = value & 0xff;
      }
    });
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const end = y * (stride + 1);
      const before = out.subarray(Math.max(0, end - (WINDOW - stride - 1)), end);
      let least = Infinity;
      for (const line of candidates) {
        const cost = deflateSync(Buffer.concat([before, line]), { level: 4 }).length;
        if (cost < least) {
          least = cost;
          chosen = line;
        }
      }
    }
    chosen.copy(out, y * (stride + 1));
  }
  return out;
}

/** The smallest lossless PNG of the same pixels, or the PNG as it came when that is smaller. */
function smallestPng(png) {
  const decoded = decode(png);
  if (!decoded) return png;
  const image = withoutAlpha(decoded);
  const palette = asPalette(image);
  const { width, height } = image;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = palette ? 3 : image.channels === 4 ? 6 : 2;

  const pixels = palette ? palette.indices : image.pixels;
  const bpp = palette ? 1 : image.channels;
  // The ways of filtering the rows that have packed these pictures best: none, Sub, or a
  // filter for each row. Up or Paeth alone, the usual guess of a filter for each row by
  // its smallest bytes, and zlib's other strategies all did worse.
  let best = null;
  for (const choice of [0, 1, "each row"]) {
    const rows = filtered(pixels, width, height, bpp, choice);
    const packed = deflateSync(rows, { level: 9, memLevel: 9 });
    if (!best || packed.length < best.length) best = packed;
  }
  const parts = [SIGNATURE, chunk("IHDR", header), ...decoded.kept];
  if (palette) {
    parts.push(chunk("PLTE", palette.palette));
    if (palette.alpha) parts.push(chunk("tRNS", palette.alpha));
  }
  parts.push(chunk("IDAT", best), chunk("IEND", Buffer.alloc(0)));
  const written = Buffer.concat(parts);
  return written.length < png.length ? written : png;
}

const mb = (bytes) => `${(bytes / 1_000_000).toFixed(2)} MB`;

// Every picture is taken before any is written, so a run that fails leaves the
// pictures there as they were, and never some new and some old.
const problems = [];
const shots = [];
const { server, origin } = await serveSite();
try {
  const browser = await chromium.launch();
  try {
    for (const picture of PICTURES) {
      const png = await take(browser, origin, picture, problems);
      shots.push({ picture, png });
      const size = `${png.readUInt32BE(16)} x ${png.readUInt32BE(20)}`;
      const step = picture.step > 0 ? `, step ${picture.step + 1}` : "";
      const theme = picture.theme === "dark" ? "Night" : "Day";
      console.log(`${picture.file}  ${size}  ${mb(png.length)}  ${picture.scene}${step}, ${theme}`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  // What the page did wrong is said even when a picture could not be taken, as it may be why.
  if (problems.length > 0) console.error([...new Set(problems)].join("\n"));
  if (problems.length > 0 || shots.length < PICTURES.length) {
    console.error("No picture was written.");
  }
}

if (problems.length > 0) process.exit(1);
await mkdir(out, { recursive: true });
for (const { picture, png } of shots) await writeFile(path.join(out, picture.file), png);
const shown = out.startsWith(`${root}${path.sep}`) ? path.relative(root, out) : out;
console.log(`Wrote the ${shots.length} pictures to ${shown}.`);
console.log("No console errors, and no request left the page's own address.");
