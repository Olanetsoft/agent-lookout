// What the two picture scripts share: scripts/capture-docs-images.mjs, which
// takes the pictures in docs/images/, and scripts/site-tour/capture-pictures.mjs,
// which takes the landing page's. Both open the landing page's tour, the real
// dashboard as site/tour/ holds it, in Playwright's Chromium, put it in a scene
// by the messages of src/site-tour/director/bridge.ts, and take it with the
// clock held still, so the same tour, on the same system with the same
// Playwright, gives the same pictures byte for byte.

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

/** The moment every picture shows: 09:12:00 UTC on 5 October 2026. */
export const NOW = Date.UTC(2026, 9, 5, 9, 12, 0);

/** How long the scene must stay as it is before the picture is taken. */
export const STILL_MS = 1500;

/** The ports the app and its dev server use, which these scripts never take. */
const RESERVED_PORTS = new Set([4777, 5173]);

/**
 * The ground's dither, left out of the pictures. It moves each pixel by about
 * two levels so the dark gradients do not band on a screen, and cannot be seen
 * as texture, but no picture format packs it: with it every picture is about
 * twice the size.
 */
export const NO_DITHER = ".ground::after { display: none !important; }";

/** The tour's scenes, by name, in the order the director numbers them. */
export async function sceneNames(root) {
  const source = await readFile(path.join(root, "src/site-tour/feed/scenes.ts"), "utf8");
  const list = source.slice(source.indexOf("export const SCENES"));
  return [...list.matchAll(/^ {4}name: "([^"]+)",$/gm)].map((match) => match[1]);
}

/** Each scene's index by its name, or an error naming the one scenes.ts does not have. */
export async function sceneIndex(root, name) {
  const index = (await sceneNames(root)).indexOf(name);
  if (index === -1) {
    throw new Error(`The tour has no scene named ${name} in src/site-tour/feed/scenes.ts.`);
  }
  return index;
}

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

/**
 * The file a path names, as Vercel finds it in site/: `/tour/` is
 * `tour/index.html`. `/tour` and what is under it come from `tour`, which is
 * site/tour/ unless another folder is given.
 */
export function fileFor(site, pathname, tour = path.join(site, "tour")) {
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const inTour = clean === "/tour" || clean.startsWith("/tour/");
  const base = inTour ? tour : site;
  const rest = inTour ? clean.slice("/tour".length) || "/" : clean;
  for (const candidate of [rest, `${rest}.html`, path.join(rest, "index.html")]) {
    const file = path.join(base, candidate);
    if (file.startsWith(base) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/** Serves site/ on 127.0.0.1, on a port the system picks that is not the app's own. */
export async function serveSite(site, tour) {
  for (;;) {
    const server = createServer((request, response) => {
      const file = fileFor(site, new URL(request.url ?? "/", "http://127.0.0.1").pathname, tour);
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

/**
 * Holds the page's clock at `now`, before any of its own script runs: the
 * tour's clock, src/site-tour/host/clock.ts, then reads that time and keeps it.
 * Only Date is held. Playwright's own clock would hold performance too, and
 * its stand-in keeps none of the measures `settle` counts.
 */
export function holdTheClock(now) {
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

/** Notes what the page does wrong: an error it logs or throws, and any request off its own address. */
export function guard(page, origin, problems) {
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (error) => problems.push(`error: ${error}`));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("data:") && new URL(url).origin !== origin) {
      problems.push(`left the page's address: ${url}`);
    }
  });
}

/**
 * Opens the tour on its own, not inside the landing page, with the clock held
 * and the dither left out, and puts it in a scene as the landing page does: the
 * theme, then the scene. The tour applies the last scene it was given once it
 * has drawn each of its views.
 */
export async function openScene(context, origin, { theme, index, step, label }, problems) {
  const page = await context.newPage();
  await page.addInitScript(holdTheClock, NOW);
  guard(page, origin, problems);
  await page.goto(`${origin}/tour/`, { waitUntil: "load" });
  await page.evaluate(
    ({ theme, index, step }) => {
      window.postMessage({ type: "theme", theme }, location.origin);
      window.postMessage({ type: "scene", index, step, lamp: null }, location.origin);
    },
    { theme, index, step },
  );
  await page.addStyleTag({ content: NO_DITHER });
  await settle(page);
  if ((await page.locator(".ground").count()) === 0) {
    throw new Error(`${label}: the dashboard's ground, whose dither is left out, has moved.`);
  }
  return page;
}

/**
 * Waits until the fonts are in, the director has applied no scene for
 * STILL_MS, by the "tour:scene" measure it records as it finishes each, and
 * two frames are drawn. The tour draws each of its views once before it
 * applies the scene it was last given, so this is the scene asked for.
 */
export async function settle(page) {
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
