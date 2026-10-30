// Takes every picture the landing page shows, from the landing page's tour:
// the real dashboard, as site/tour/ builds it from a release, with the hour it
// is given in src/site-tour/feed/. So the pictures show what the app does in
// that release, and the same tour, on the same system with the same
// Playwright, gives the same pictures, byte for byte.
//
//   npm run capture:site                   takes them from site/tour/ and writes
//                                          them into site/assets/
//   npm run capture:site -- --out <dir>    writes the same tree into another
//                                          folder, to compare them first
//   npm run capture:site -- --from-source  builds the tour from the working tree
//                                          into a temporary folder first, with
//                                          build.mjs --out, and takes them from
//                                          there, leaving site/tour/ alone
//
// Run it at a release, after npm run build:tour, when the version changes the
// dashboard. Look at each picture, and bring its alt text in site/index.html
// up to what it shows.
//
// What it writes, each in Night and Day:
//
//   dashboard-{quiet,waiting}-…-{2360,1770,1180}.webp
//       the frame on the first screen until the dashboard arrives: a 1440 by
//       900 window at twice the density, the size the page draws the dashboard
//       at in its frame, with nothing waiting, then with checkout-flow waiting
//   phone-{quiet,waiting}-…-{1170,780}.webp
//       the same as the app's one-column layout, a 390 by 844 window at three
//       times
//   features/<feature>-…-{1600,1000}.webp
//       one part of the dashboard for each feature the page shows, a 4:3 clip
//       around it in a 1280-wide window, or a wider one a feature names,
//       taken at the density that makes it 1600 by 1200
//   features/<feature>-phone-…-{1200,800}.webp
//       the same part in the one-column layout of a 390-wide window, a 4:5
//       clip, taken at the density that makes it 1200 by 1500, for a phone,
//       where the wide picture's type would be too small to read
//
// How it works. It serves site/ itself on a free port on 127.0.0.1, opens
// /tour/ in Playwright's Chromium on its own, and puts the dashboard in a scene
// by the "theme" and "scene" messages of src/site-tour/director/bridge.ts, as
// the landing page does. Each scene is found by its name in
// src/site-tour/feed/scenes.ts, and each picture's view is checked for what it
// must show before it is taken, so a scene renamed or changed stops the script
// rather than giving a wrong picture. What it shares with the pictures for the
// docs, the server, the held clock and the wait for a scene to settle, is in
// scripts/site-tour/tour-page.mjs.
//
// Each part is found in the page, and its clip is worked out from its box, in
// CSS pixels: W is the part's width and 20 more, rounded up to a multiple of 4
// so the clip is whole CSS pixels, the clip is W by 0.75 W, or 1.25 W on a
// phone, from 10 above and to the left of the part, or 8 above a card the
// director brought to the top, which sits 8 under the dashboard's header. The
// page is taken at 1600 / W times its density, or 1200 / W on a phone, so the
// picture is 1600 by 1200, or 1200 by 1500. The part is measured once to
// choose the density, then the scene is opened again at it. For the details of
// a session, the dashboard behind them is hidden while they are taken, so only
// their own backdrop shows round them.
//
// The pictures are WebP. Playwright gives PNG, so a blank page in the same
// browser draws each one at each width on a canvas and encodes it there: no
// other program and no dependency. Each picture is kept within its size in
// BUDGET_KB, which tests/unit/site-tour/feed/scenes.test.ts holds the files in
// site/assets/ to as well. A picture over its size is encoded again at a lower
// quality, and the script fails, naming it, if it is still over.
//
// The clock is held at 09:12:00 UTC on 5 October 2026, with the locale en-US,
// the time zone UTC and reduced motion, and the ground's dither is left out.
// It fails if the page logs an error, asks for anything outside its own
// address, or a picture's view is missing what it must show, and it stops its
// server and the browser whatever happens. It writes the pictures only once
// every one is taken and encoded, so a run that fails leaves the folder as it
// was.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { openScene, sceneIndex, serveSite, settle } from "./tour-page.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, "site");
const assets = path.join(site, "assets");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
if (outAt !== -1 && !args[outAt + 1]) {
  throw new Error(
    "Usage: node scripts/site-tour/capture-pictures.mjs [--from-source] [--out <folder>]",
  );
}
const out = path.resolve(outAt === -1 ? assets : args[outAt + 1]);
const fromSource = args.includes("--from-source");

const THEMES = { night: "dark", day: "light" };

/** The quality each picture is encoded at first, and the lowest it may be taken down to. */
const QUALITY = 0.85;
const LOWEST_QUALITY = 0.6;
const KB = 1024;
/**
 * Each picture's largest size, in KB, by what it is and its width: the
 * frame's two windows, a feature's wide picture and a feature's picture for a
 * phone. Fixed, so a picture can never grow by being taken again.
 */
const BUDGET_KB = {
  "dashboard-2360": 180,
  "dashboard-1770": 130,
  "dashboard-1180": 80,
  "phone-1170": 120,
  "phone-780": 75,
  "feature-1600": 200,
  "feature-1000": 100,
  "feature-phone-1200": 150,
  "feature-phone-800": 80,
};

/** The frame's two states: the scene, and the words its view must have. */
const STATES = [
  { state: "quiet", scene: "One screen", step: 0 },
  { state: "waiting", scene: "Needs you", step: 0 },
];

/** The frame's two windows, and the widths each is written at. */
const WINDOWS = [
  {
    name: "dashboard",
    viewport: { width: 1440, height: 900 },
    density: 2,
    sizes: [2360, 1770, 1180].map((width) => [width, Math.ceil((width * 5) / 8)]),
  },
  {
    name: "phone",
    viewport: { width: 390, height: 844 },
    density: 3,
    sizes: [1170, 780].map((width) => [width, (width * 844) / 390]),
  },
];

/**
 * The features, each a part of the dashboard in a scene, found and clipped by
 * its name in `inspect` below: `height` is the wide window's, `width` a wider
 * window for a part whose height would not fit its clip at 1280, `pressed`
 * waits for a button the scene presses to be let go, and `alone` hides the
 * dashboard behind the part.
 */
const FEATURES = [
  { name: "sessions", scene: "One screen", step: 1, height: 800 },
  { name: "needs-you", scene: "Needs you", step: 0, height: 800 },
  { name: "allow-deny", scene: "Allow or Deny", step: 0, height: 800 },
  { name: "notifications", scene: "Settings", step: 0, height: 1000 },
  { name: "jump-stop", scene: "Stop", step: 0, height: 800, pressed: true, alone: true },
  // With Hermes Agent's row, the card is taller than its clip in a 1280-wide window.
  { name: "agents", scene: "Sources", step: 2, width: 1360, height: 1000 },
];

/**
 * The two forms of each feature's picture: wide, from a 1280-wide window, and
 * for a phone, from the one-column layout of a 390-wide window. `ratio` is
 * the clip's height to its width, and the first size is the one it is taken at.
 */
const FORMS = [
  {
    form: "wide",
    stem: "",
    budget: "feature",
    width: 1280,
    ratio: 0.75,
    sizes: [
      [1600, 1200],
      [1000, 750],
    ],
  },
  {
    form: "phone",
    stem: "-phone",
    budget: "feature-phone",
    width: 390,
    height: 844,
    ratio: 1.25,
    sizes: [
      [1200, 1500],
      [800, 1000],
    ],
  },
];

/** While the details of a session are taken, the dashboard behind them is hidden. */
const ONLY_THE_DIALOG = "#root > :not(.ground) { visibility: hidden !important; }";

/**
 * Run in the page: finds the part a picture shows, works out its clip, and
 * says what the view is missing. `width` is the clip's width from the first
 * look, so the second, at the density chosen for it, keeps it, and `ratio` is
 * its height to its width: below 1 for the wide window, above for a phone's.
 */
function inspect({ name, width, ratio = 0.75 }) {
  const phone = ratio > 1;
  const missing = [];
  const titled = (title) =>
    [...document.querySelectorAll("section[aria-labelledby]")].find((section) =>
      document
        .getElementById(section.getAttribute("aria-labelledby") ?? "")
        ?.textContent?.trim()
        .startsWith(title),
    );
  const labels = (element) =>
    [...(element?.querySelectorAll("button") ?? [])].map((button) => button.textContent.trim());
  const has = (element, text) => element?.textContent?.includes(text) === true;
  const view = document.querySelector("main")?.dataset.view;
  const hero = document.querySelector('[data-slot="hero"]');
  const answer = hero?.querySelector('[data-slot="answer"]');
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');

  /**
   * A clip W by `ratio` W round a part, `above` over its top and 10 to its
   * left. The browser takes a clip in whole CSS pixels, so W is rounded up to
   * a multiple of 4, which makes 0.75 W and 1.25 W whole too.
   */
  const around = (part, above) => {
    const box = part.getBoundingClientRect();
    const w = width ?? Math.ceil((box.width + 20) / 4) * 4;
    return {
      x: Math.round(box.left - 10),
      y: Math.round(box.top - above),
      width: w,
      height: w * ratio,
    };
  };
  /** Whether a part lies in the clip, with `margin` round it, as a ring drawn outside its edge. */
  const inside = (part, clip, margin = 0) => {
    const box = part.getBoundingClientRect();
    return (
      box.left - margin >= clip.x &&
      box.top - margin >= clip.y &&
      box.right + margin <= clip.x + clip.width &&
      box.bottom + margin <= clip.y + clip.height
    );
  };

  let clip = null;
  if (name === "quiet" || name === "waiting") {
    if (view !== "overview") missing.push("the Overview");
    if (name === "quiet" && !has(hero, "Nothing needs you")) missing.push("Nothing needs you");
    if (name === "waiting") {
      for (const label of ["Deny", "Allow"]) {
        if (!labels(answer).includes(label)) missing.push(`${label} in the hero's request`);
      }
    }
  } else if (name === "sessions") {
    const card = titled("Sessions");
    const layout = document
      .querySelector('[role="radiogroup"][aria-label="Show sessions as"] [aria-checked="true"]')
      ?.textContent?.trim();
    if (layout !== "List") missing.push("List chosen");
    for (const agent of ["Claude Code", "Codex"]) {
      if (!has(card, agent)) missing.push(`a row of ${agent}`);
    }
    if (dialogs.length > 0) missing.push("no dialog open");
    if (card) clip = around(card, 8);
  } else if (name === "needs-you") {
    for (const text of ["checkout-flow", "Waiting for permission"]) {
      if (!has(hero, text)) missing.push(text);
    }
    for (const label of ["Deny", "Allow"]) {
      if (!labels(answer).includes(label)) missing.push(label);
    }
    if (!hero?.querySelector('[data-part="jump"]')) missing.push("Jump");
    if (hero) clip = around(hero, 10);
  } else if (name === "allow-deny") {
    // The whole Needs you card, as in the picture of Needs you, with the request lit.
    if (!answer?.hasAttribute("data-tour-point")) missing.push("the request pointed at");
    for (const label of ["Deny", "Allow"]) {
      if (!labels(answer).includes(label)) missing.push(label);
    }
    if (hero && answer) {
      clip = around(hero, 10);
      const sessionName = hero.querySelector('[data-part="name"]');
      // The request's lit ring reaches 9px outside its edge.
      if (!inside(answer, clip, 9)) missing.push("the whole request and its ring in the clip");
      if (!sessionName || !inside(sessionName, clip))
        missing.push("the session's name in the clip");
    }
  } else if (name === "notifications") {
    const card = titled("Notifications");
    if (!has(card, "Notifications are off.")) missing.push("Notifications are off.");
    if (!labels(card).includes("Turn on notifications")) missing.push("Turn on notifications");
    if (card) {
      clip = around(card, 10);
      const rules = titled("Time rules");
      const top = rules?.getBoundingClientRect().top;
      if (!phone && (top === undefined || top < clip.y || top > clip.y + clip.height)) {
        missing.push("the top of Time rules in the clip");
      }
    }
  } else if (name === "jump-stop") {
    const dialog = dialogs.length === 1 ? dialogs[0] : null;
    if (!dialog) missing.push("one dialog open");
    const title = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    if (title?.textContent?.trim() !== "checkout-flow") missing.push("checkout-flow's details");
    for (const part of ["jump", "stop"]) {
      if (!dialog?.querySelector(`[data-part="${part}"]`)) missing.push(part);
    }
    if (!has(dialog, "#214")) missing.push("the pull request #214");
    const shell = document.querySelector("#root > :not(.ground)");
    if (shell && getComputedStyle(shell).visibility !== "hidden")
      missing.push("the dashboard behind the details hidden");
    if (dialog) clip = around(dialog, 10);
  } else if (name === "agents") {
    const card = titled("What each agent can report");
    if (view !== "sources") missing.push("Sources");
    if (phone) {
      // A phone lists each agent's signals under its name, Claude Code's first.
      if (!has(card, "Claude Code")) missing.push("Claude Code's signals");
      if (card) clip = around(card, 8);
    } else {
      const rows = [...(card?.querySelectorAll("tr") ?? [])].map((row) =>
        row.firstElementChild?.textContent?.trim(),
      );
      for (const agent of [
        "Claude Code",
        "Codex",
        "Antigravity CLI",
        "Antigravity",
        "Mistral Vibe",
        "Gemini CLI",
        "OpenCode",
        "Qwen Code",
        "Hermes Agent",
        "Status files",
      ]) {
        if (!rows.includes(agent)) missing.push(`a row for ${agent}`);
      }
      if (card) {
        clip = around(card, 8);
        if (!inside(card, clip)) missing.push("the whole card in the clip");
      }
    }
  }
  if (clip) {
    const fits =
      clip.x >= 0 &&
      clip.y >= 0 &&
      clip.x + clip.width <= window.innerWidth &&
      clip.y + clip.height <= window.innerHeight;
    if (!fits) missing.push("the clip inside the window");
  } else if (!["quiet", "waiting"].includes(name)) {
    missing.push("the part the picture is of");
  }
  return { missing, clip };
}

/** A context for one picture, as every picture is taken. */
const contextFor = (browser, viewport, density, theme) =>
  browser.newContext({
    viewport,
    deviceScaleFactor: density,
    colorScheme: theme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });

/** Opens the scene, waits for a button it presses to be let go, and hides what a part is taken alone from. */
async function sceneFor(context, origin, shot, theme, label, problems) {
  const page = await openScene(
    context,
    origin,
    { theme, index: shot.index, step: shot.step, label },
    problems,
  );
  if (shot.pressed) {
    await page.waitForFunction(() => document.querySelector("[data-tour-pressed]") === null, null, {
      timeout: 10_000,
    });
    await settle(page);
  }
  if (shot.alone) {
    await page.addStyleTag({ content: ONLY_THE_DIALOG });
    await settle(page);
  }
  return page;
}

/** What a view is missing, as an error naming the picture. */
function insist(label, missing) {
  if (missing.length > 0)
    throw new Error(`${label}: the page does not show ${missing.join(", ")}.`);
}

/** The frame's picture of a scene, the whole window. */
async function takeWindow(browser, origin, win, state, theme, problems) {
  const label = `${win.name}-${state.state}-${theme}`;
  const context = await contextFor(browser, win.viewport, win.density, THEMES[theme]);
  try {
    const page = await sceneFor(context, origin, state, THEMES[theme], label, problems);
    insist(label, (await page.evaluate(inspect, { name: state.state })).missing);
    return await page.screenshot({ animations: "disabled", caret: "hide", scale: "device" });
  } finally {
    await context.close();
  }
}

/** A feature's picture in one form: measured once, then taken at the density that makes it its first size. */
async function takeFeature(browser, origin, feature, form, theme, problems) {
  const label = `features/${feature.name}${form.stem}-${theme}`;
  const wide = form.form === "wide";
  const viewport = {
    width: wide ? (feature.width ?? form.width) : form.width,
    height: form.height ?? feature.height,
  };
  const { ratio } = form;
  let clip;
  const first = await contextFor(browser, viewport, 1, THEMES[theme]);
  try {
    const page = await sceneFor(first, origin, feature, THEMES[theme], label, problems);
    const look = await page.evaluate(inspect, { name: feature.name, ratio });
    insist(label, look.missing);
    clip = look.clip;
  } finally {
    await first.close();
  }
  const density = form.sizes[0][0] / clip.width;
  const context = await contextFor(browser, viewport, density, THEMES[theme]);
  try {
    const page = await sceneFor(context, origin, feature, THEMES[theme], label, problems);
    const look = await page.evaluate(inspect, { name: feature.name, width: clip.width, ratio });
    insist(label, look.missing);
    if (Math.abs(look.clip.x - clip.x) > 1 || Math.abs(look.clip.y - clip.y) > 1) {
      throw new Error(`${label}: the part moved between the two looks at it.`);
    }
    return await page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "device",
      clip: look.clip,
    });
  } finally {
    await context.close();
  }
}

/** A PNG's width and height, from its header. */
const sizeOf = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];

/**
 * Run in the blank page: draws the PNG at each size on a canvas and encodes it
 * as WebP at the quality given.
 */
async function encode({ png, sizes, quality }) {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const written = [];
  for (const [width, height] of sizes) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if (blob.type !== "image/webp") throw new Error(`The browser wrote ${blob.type}, not WebP.`);
    const data = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (let at = 0; at < data.length; at += 0x8000) {
      text += String.fromCharCode(...data.subarray(at, at + 0x8000));
    }
    written.push(btoa(text));
  }
  return written;
}

/** Each size of a picture as WebP, each at the highest quality that keeps it within its budget. */
async function encoded(encoder, png, files) {
  const result = [];
  for (const file of files) {
    let quality = QUALITY;
    for (;;) {
      const [webp] = await encoder.evaluate(encode, {
        png: png.toString("base64"),
        sizes: [file.size],
        quality,
      });
      const bytes = Buffer.from(webp, "base64");
      if (bytes.length <= file.budget) {
        result.push({ ...file, bytes, quality });
        break;
      }
      if (quality - 0.05 < LOWEST_QUALITY - 1e-9) {
        throw new Error(
          `${file.path} is ${(bytes.length / KB).toFixed(1)} KB at quality ${quality.toFixed(2)}, over its ${(file.budget / KB).toFixed(1)} KB.`,
        );
      }
      quality = Math.round((quality - 0.05) * 100) / 100;
    }
  }
  return result;
}

// The scenes, by name.

for (const shot of [...STATES, ...FEATURES]) shot.index = await sceneIndex(root, shot.scene);

// The tour: site/tour/, or built from the working tree.

let built = null;
if (fromSource) {
  built = await mkdtemp(path.join(tmpdir(), "agent-lookout-pictures-"));
  execFileSync(process.execPath, [path.join(root, "scripts/site-tour/build.mjs"), "--out", built], {
    cwd: root,
    stdio: "inherit",
  });
} else if (!existsSync(path.join(site, "tour/index.html"))) {
  throw new Error("site/tour/ is not built. Run npm run build:tour first, or add --from-source.");
}

// Every picture is taken and encoded before any is written, so a run that fails
// leaves the pictures there as they were, and never some new and some old.
const problems = [];
const files = [];
let failed = true;
const { server, origin } = await serveSite(site, built ? path.join(built, "tour") : undefined);
try {
  const browser = await chromium.launch();
  try {
    const encoder = await browser.newPage();
    await encoder.setContent("<!doctype html><title>Pictures</title>");
    for (const win of WINDOWS) {
      for (const state of STATES) {
        for (const theme of Object.keys(THEMES)) {
          const png = await takeWindow(browser, origin, win, state, theme, problems);
          const [w, h] = sizeOf(png);
          const want = [win.viewport.width * win.density, win.viewport.height * win.density];
          if (w !== want[0] || h !== want[1]) {
            throw new Error(
              `${win.name}-${state.state}-${theme} is ${w} by ${h}, not ${want.join(" by ")}.`,
            );
          }
          const wanted = [];
          for (const size of win.sizes) {
            const relative = `${win.name}-${state.state}-${theme}-${size[0]}.webp`;
            wanted.push({ path: relative, size, budget: BUDGET_KB[`${win.name}-${size[0]}`] * KB });
          }
          for (const file of await encoded(encoder, png, wanted)) {
            files.push({ ...file, scene: state.scene, step: state.step, theme });
          }
        }
      }
    }
    for (const feature of FEATURES) {
      for (const form of FORMS) {
        for (const theme of Object.keys(THEMES)) {
          const png = await takeFeature(browser, origin, feature, form, theme, problems);
          const [w, h] = sizeOf(png);
          const [want] = form.sizes;
          if (w !== want[0] || h !== want[1]) {
            throw new Error(
              `features/${feature.name}${form.stem}-${theme} is ${w} by ${h}, not ${want.join(" by ")}.`,
            );
          }
          const wanted = form.sizes.map((size) => ({
            path: `features/${feature.name}${form.stem}-${theme}-${size[0]}.webp`,
            size,
            budget: BUDGET_KB[`${form.budget}-${size[0]}`] * KB,
          }));
          for (const file of await encoded(encoder, png, wanted)) {
            files.push({ ...file, scene: feature.scene, step: feature.step, theme });
          }
        }
      }
    }
    failed = problems.length > 0;
  } finally {
    await browser.close();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (built) await rm(built, { recursive: true, force: true });
  // What the page did wrong is said even when a picture could not be taken, as it may be why.
  if (problems.length > 0) console.error([...new Set(problems)].join("\n"));
  if (failed) console.error("No picture was written.");
}

if (failed) process.exit(1);
for (const file of files) {
  const step = file.step > 0 ? `, step ${file.step + 1}` : "";
  const theme = file.theme === "night" ? "Night" : "Day";
  const quality = file.quality === QUALITY ? "" : `, quality ${file.quality.toFixed(2)}`;
  console.log(
    `${file.path}  ${file.size.join(" x ")}  ${(file.bytes.length / KB).toFixed(1)} KB  ${file.scene}${step}, ${theme}${quality}`,
  );
}
await mkdir(path.join(out, "features"), { recursive: true });
for (const file of files) await writeFile(path.join(out, file.path), file.bytes);
const shown = out.startsWith(`${root}${path.sep}`) ? path.relative(root, out) : out;
console.log(`Wrote the ${files.length} pictures to ${shown}.`);
console.log("No console errors, and no request left the page's own address.");
