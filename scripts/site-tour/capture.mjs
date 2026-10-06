// Takes the two pictures the landing page shows in its frame until the
// dashboard has arrived, from the dashboard itself: the tour's first scene,
// with nothing waiting, and its second, with checkout-flow waiting, in Night
// and Day, as a 1280 by 800 window at twice the density and as the app's
// one-column layout in a 390 by 844 window at three times. The clock is held
// at one moment, so the two agree to the second with each other and with
// what the dashboard draws when it arrives.
//
//   node scripts/site-tour/capture.mjs <port> <folder>
//
// It serves site/ on 127.0.0.1 at the port given, so run npm run build:tour
// first. It writes desktop-quiet-night.png, phone-waiting-day.png and the
// rest into the folder, and fails if a request leaves the page's own address
// or the page logs an error.

import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, "site");
const [portArg, outArg] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || port <= 0 || !outArg) {
  throw new Error("Usage: node scripts/site-tour/capture.mjs <port> <folder>");
}
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });

// 09:12:00 on 5 October 2026, in this machine's own time zone.
const NOW = new Date(2026, 9, 5, 9, 12, 0).getTime();

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

/** The file a path names in site/, as Vercel finds it: `/tour` is `tour/index.html`. */
function fileFor(pathname) {
  const clean = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  for (const candidate of [clean, `${clean}.html`, path.join(clean, "index.html")]) {
    const file = path.join(site, candidate);
    if (file.startsWith(site) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

const server = createServer((request, response) => {
  const file = fileFor(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${port}`;

const SHOTS = [
  { name: "desktop", width: 1280, height: 800, scale: 2 },
  { name: "phone", width: 390, height: 844, scale: 3 },
];
const SCENES = { quiet: 0, waiting: 1 };
const THEMES = { night: "dark", day: "light" };

const browser = await chromium.launch({ channel: "chromium" });
const problems = [];
try {
  for (const shot of SHOTS) {
    for (const [state, scene] of Object.entries(SCENES)) {
      for (const [theme, scheme] of Object.entries(THEMES)) {
        const context = await browser.newContext({
          viewport: { width: shot.width, height: shot.height },
          deviceScaleFactor: shot.scale,
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        await page.clock.setFixedTime(NOW);
        page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
        page.on("pageerror", (error) => problems.push(`error: ${error}`));
        page.on("request", (request) => {
          const url = request.url();
          if (!url.startsWith("data:") && new URL(url).origin !== origin) {
            problems.push(`left the page's address: ${url}`);
          }
        });
        await page.goto(`${origin}/tour`, { waitUntil: "load" });
        await page.evaluate(async (index) => {
          window.postMessage({ type: "scene", index, step: 0, lamp: null }, location.origin);
          await document.fonts.ready;
        }, scene);
        await page.waitForTimeout(1500);
        const file = path.join(out, `${shot.name}-${state}-${theme}.png`);
        await page.screenshot({ path: file });
        console.log(file);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

if (problems.length > 0) {
  console.error([...new Set(problems)].join("\n"));
  process.exit(1);
}
console.log("No console errors, and no request left the page's own address.");
