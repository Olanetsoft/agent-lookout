// Builds the one thing the landing page in site/ takes from this repository,
// since Vercel serves that folder as it is and runs no build: site/tour/, the
// real dashboard, built from src/site-tour/ with Vite, for the frame on the
// page's first screen.
//
// It is committed, and built from a release: the landing page shows the
// dashboard as the version people install has it, never a feature that has not
// shipped. So it is rebuilt only as part of a release:
//
//   node scripts/site-tour/build.mjs           npm run build:tour, a step of the
//                                              release: writes site/tour/
//   node scripts/site-tour/build.mjs --check   npm run check:tour: builds it
//                                              again into a temporary folder and
//                                              fails when what is committed differs
//   ... --check --since <commit>               CI. On a release, when the version in
//                                              package.json differs from the one at
//                                              <commit>: the same as --check.
//                                              Otherwise it builds the working tree
//                                              into a temporary folder and checks
//                                              only the budgets, of that build and of
//                                              what is committed. It compares nothing
//                                              with what is committed and writes
//                                              nothing in site/, so a change that
//                                              would put the tour over a budget fails
//                                              in its own pull request
//   node scripts/site-tour/build.mjs --sizes   npm run check:tour-size: the sizes of
//                                              what is committed, built nothing
//   node scripts/site-tour/build.mjs --out <folder>
//                                              builds the tour from the working tree
//                                              into <folder>/tour/ and measures it,
//                                              writing nothing in site/. The landing
//                                              page's picture script uses it, with
//                                              --from-source, to take pictures of a
//                                              dashboard no release has built yet
//
// A feature on main that no release has yet stays out of the tour until one
// does.
//
// Every mode fails when a file is over its budget: the first screen of the page
// must load as fast as it did before the tour, and everything here loads after
// it.
//
// The tour takes its fonts from the page's own folder, site/assets/fonts/, so
// the page and its dashboard share one copy of each face.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build as viteBuild, createLogger, normalizePath } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, "site");
const checking = process.argv.includes("--check");
const sizesOnly = process.argv.includes("--sizes");
const sinceAt = process.argv.indexOf("--since");
const since = sinceAt === -1 ? null : (process.argv[sinceAt + 1] ?? "");
const outAt = process.argv.indexOf("--out");
if (outAt !== -1 && !process.argv[outAt + 1]) {
  throw new Error("Usage: node scripts/site-tour/build.mjs --out <folder>");
}
const out = outAt === -1 ? null : path.resolve(process.argv[outAt + 1]);

/**
 * Vite's own logger, without its note on each font: the fonts are the page's,
 * at an address the build does not serve, so leaving them as written is right.
 */
const logger = createLogger("warn");
const fontNote = (message) => message.includes("didn't resolve at build time");
const warn = logger.warn.bind(logger);
const warnOnce = logger.warnOnce.bind(logger);
logger.warn = (message, options) => fontNote(message) || warn(message, options);
logger.warnOnce = (message, options) => fontNote(message) || warnOnce(message, options);

/**
 * Budgets, in bytes sent gzipped.
 *
 * #203 took out what the tour bundled and never ran, the Mac app's own parts
 * and the app's polling store, about 7 KB, so what is left is the dashboard
 * the tour shows. From 0.2.9 to 0.2.14 a release added between 0 and 4 KB to
 * it. CI builds the tour on every pull request and fails one that would put it
 * over either budget, so raising one is decided there, with the change that
 * needs it.
 */
const BUDGET = {
  /** Built from main after #203, the tour's JavaScript is 246.4 KB, and 278.9 KB with its fonts. */
  tourJs: 256 * 1024,
  tourCss: 14 * 1024,
  tourHtml: 2 * 1024,
  /** The page's own script that puts the dashboard in its frame. */
  pageScript: 8 * 1024,
  /** Everything the frame fetches, its two fonts the page does not use included. */
  tourAll: 288 * 1024,
};

/** The fonts the dashboard uses that the page does not, so the tour fetches them on its own. */
const TOUR_ONLY_FONTS = [
  "atkinson-hyperlegible-mono-latin-500-normal.woff2",
  "atkinson-hyperlegible-mono-latin-600-normal.woff2",
];

const FONTS_CSS = path.join(root, "src/site-tour/styles/fonts.css");
const NO_FONTS_CSS = path.join(root, "src/site-tour/styles/none.css");

/**
 * The dashboard imports each face from its Fontsource package. In the tour all
 * six come from one file of the page's own: the first import is pointed at it,
 * and the other five at an empty file, so no face is declared twice.
 */
const fontAliases = [
  { find: "@fontsource/atkinson-hyperlegible-next/400.css", replacement: FONTS_CSS },
  {
    find: /^@fontsource\/atkinson-hyperlegible-(next|mono)\/\d00\.css$/,
    replacement: NO_FONTS_CSS,
  },
];

/**
 * The parts of the dashboard drawn only in the Mac app's window, and so never
 * in a browser or in the tour: the Menu bar, Keep awake and Updates cards in
 * Settings, and the note on the app's Claude Code plugin. Each is given, in
 * the tour, the part beside it in src/site-tour/app-only/, which draws nothing.
 */
const APP_ONLY = {
  "src/dashboard/components/settings/app/MenuBarCard.tsx": "src/site-tour/app-only/AppCards.tsx",
  "src/dashboard/components/settings/app/KeepAwakeCard.tsx": "src/site-tour/app-only/AppCards.tsx",
  "src/dashboard/components/settings/app/UpdatesCard.tsx": "src/site-tour/app-only/AppCards.tsx",
  "src/dashboard/components/dashboard/PluginNotice.tsx": "src/site-tour/app-only/PluginNotice.tsx",
};

/**
 * Puts the parts in APP_ONLY out of the tour, with the hooks and the calls to
 * the app behind them. A part is known by the file an import resolves to, so
 * an import by `@dashboard/…`, by a relative path or by any other name is
 * caught alike.
 *
 * The tour's build fails when a part here was never imported, as happens once
 * it is moved or renamed: point its line in APP_ONLY at it again. It also
 * fails when one is in the tour anyway, and Rollup fails it when a part in
 * src/site-tour/app-only/ lacks a name the dashboard imports. CI builds the
 * tour on every pull request, so none of these can reach main. A new part
 * that only the Mac app's window draws is not caught here: add it to APP_ONLY.
 */
function appOnlyParts() {
  /** Each real part's file, by the id Vite gives it, with its name here and the file put in its place. */
  const parts = new Map(
    Object.entries(APP_ONLY).map(([real, standIn]) => [
      normalizePath(path.join(root, real)),
      { name: real, standIn: normalizePath(path.join(root, standIn)) },
    ]),
  );
  const names = new Set(Object.keys(APP_ONLY).map((real) => path.parse(real).name));
  const replaced = new Set();
  return {
    name: "agent-lookout:app-only-parts",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // Only an import whose last part is one of their names is resolved again.
      const last = path.posix.basename(source.split("?")[0].replaceAll("\\", "/"));
      if (!importer || !names.has(last.replace(/\.[cm]?[jt]sx?$/, ""))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const real = resolved && normalizePath(resolved.id);
      if (!real || !parts.has(real)) return null;
      replaced.add(real);
      return parts.get(real).standIn;
    },
    generateBundle(_options, bundle) {
      const bundled = new Set();
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk") continue;
        for (const id of Object.keys(file.modules)) bundled.add(normalizePath(id.split("?")[0]));
      }
      const problems = [];
      for (const [real, { name }] of parts) {
        if (bundled.has(real)) {
          problems.push(`${name} is in the tour, though only the Mac app's window draws it.`);
        } else if (!replaced.has(real)) {
          problems.push(
            `${name} was never imported. If it was moved or renamed, point its line in APP_ONLY at it, or the tour carries it again.`,
          );
        }
      }
      if (problems.length > 0) this.error(problems.join("\n"));
    },
  };
}

const gz = (bytes) => gzipSync(bytes, { level: 9 }).length;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** Every file under a folder, as paths relative to it, sorted. */
async function filesUnder(folder) {
  if (!existsSync(folder)) return [];
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      found.push(path.relative(folder, path.join(entry.parentPath ?? entry.path, entry.name)));
    }
  }
  return found.sort();
}

/** Builds the tour into `out`: index.html, assets/ and the licences of what it bundles. */
async function buildTour(out) {
  const work = await mkdtemp(path.join(tmpdir(), "agent-lookout-tour-"));
  try {
    await viteBuild({
      configFile: path.join(root, "vite.config.ts"),
      root,
      base: "/tour/",
      customLogger: logger,
      resolve: { alias: fontAliases },
      plugins: [appOnlyParts()],
      build: {
        outDir: work,
        emptyOutDir: true,
        reportCompressedSize: false,
        rollupOptions: { input: path.join(root, "src/site-tour/index.html") },
      },
    });
    await mkdir(out, { recursive: true });
    await cp(path.join(work, "src/site-tour/index.html"), path.join(out, "index.html"));
    await cp(path.join(work, "assets"), path.join(out, "assets"), { recursive: true });
    await cp(path.join(work, "THIRD-PARTY-LICENSES.md"), path.join(out, "THIRD-PARTY-LICENSES.md"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The sizes of what was built, and every budget it is over. */
async function measure(tourDir) {
  const over = [];
  const lines = [];
  const totals = { js: 0, css: 0, html: 0, fonts: 0 };
  for (const relative of await filesUnder(tourDir)) {
    const bytes = await readFile(path.join(tourDir, relative));
    if (relative.endsWith(".js")) totals.js += gz(bytes);
    else if (relative.endsWith(".css")) totals.css += gz(bytes);
    else if (relative.endsWith(".html")) totals.html += gz(bytes);
  }
  for (const font of TOUR_ONLY_FONTS) {
    const file = path.join(site, "assets/fonts", font);
    if (!existsSync(file)) over.push(`site/assets/fonts/${font} is missing.`);
    else totals.fonts += (await readFile(file)).length;
  }
  const pageScript = gz(await readFile(path.join(site, "tour.js")));
  const all = totals.js + totals.css + totals.html + totals.fonts;

  const row = (name, size, budget) => {
    lines.push(`  ${name.padEnd(28)} ${kb(size).padStart(9)}  of ${kb(budget)}`);
    if (size > budget) over.push(`${name} is ${kb(size)} gzipped, over its ${kb(budget)}.`);
  };
  row("tour JavaScript", totals.js, BUDGET.tourJs);
  row("tour CSS", totals.css, BUDGET.tourCss);
  row("tour HTML", totals.html, BUDGET.tourHtml);
  row("tour, with its two fonts", all, BUDGET.tourAll);
  row("site/tour.js", pageScript, BUDGET.pageScript);
  return { lines, over };
}

/** The files that differ between two folders, by their paths in the first. */
async function differences(committed, built) {
  const a = await filesUnder(committed);
  const b = await filesUnder(built);
  const differ = [];
  for (const file of new Set([...a, ...b])) {
    if (!a.includes(file)) differ.push(`${file} is not committed`);
    else if (!b.includes(file)) differ.push(`${file} is no longer built`);
    else {
      const [x, y] = await Promise.all([
        readFile(path.join(committed, file)),
        readFile(path.join(built, file)),
      ]);
      if (!x.equals(y)) differ.push(`${file} differs`);
    }
  }
  return differ;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The version in package.json, now and at a commit, or null where it cannot be read. */
function versionAt(commit) {
  try {
    const text = execFileSync("git", ["show", `${commit}:package.json`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(text).version;
  } catch {
    return null;
  }
}

/** Checks only what is committed: its sizes. Builds nothing. */
async function checkSizes() {
  const { lines, over } = await measure(path.join(site, "tour"));
  if (over.length > 0) fail(over.join("\n"));
  console.log(`The landing page's tour is within its sizes.\n${lines.join("\n")}`);
}

/** Builds the tour from the working tree into `tourDir`, in place of what was there, and measures it. */
async function buildAndMeasure(tourDir) {
  await rm(tourDir, { recursive: true, force: true });
  await buildTour(tourDir);
  return measure(tourDir);
}

/**
 * Not a release: site/tour/ stays as the last release built it, and is only
 * measured. The working tree is built into a temporary folder, measured and
 * thrown away, so a change that would put the tour over a budget fails in its
 * own pull request and not at the next release. Nothing is compared with what
 * is committed, and nothing is written in site/.
 */
async function checkBetweenReleases() {
  const committed = await measure(path.join(site, "tour"));
  const scratch = await mkdtemp(path.join(tmpdir(), "agent-lookout-tour-sizes-"));
  let built;
  try {
    built = await buildAndMeasure(path.join(scratch, "tour"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(
    `Not a release: package.json says ${version}, as before, so site/tour/ is not rebuilt.\n` +
      `The tour built from the working tree:\n${built.lines.join("\n")}\n` +
      `The tour committed in site/tour/:\n${committed.lines.join("\n")}`,
  );
  const over = [];
  if (built.over.length > 0) {
    over.push(
      `The tour built from the working tree is over a budget:\n  ${built.over.join("\n  ")}`,
    );
  }
  if (committed.over.length > 0) {
    over.push(
      `The tour committed in site/tour/ is over a budget:\n  ${committed.over.join("\n  ")}`,
    );
  }
  // After the temporary folder is gone: fail() exits at once.
  if (over.length > 0) fail(over.join("\n"));
}

const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const released =
  since === null ? true : since !== "" && ![null, version].includes(versionAt(since));

if (out !== null) {
  const tourDir = path.join(out, "tour");
  const { lines, over } = await buildAndMeasure(tourDir);
  console.log(`Built the tour from the working tree into ${tourDir}.\n${lines.join("\n")}`);
  if (over.length > 0) fail(over.join("\n"));
} else if (sizesOnly) {
  await checkSizes();
} else if (checking && !released) {
  await checkBetweenReleases();
} else if (checking) {
  const scratch = await mkdtemp(path.join(tmpdir(), "agent-lookout-tour-check-"));
  try {
    await buildTour(path.join(scratch, "tour"));
    const stale = (await differences(path.join(site, "tour"), path.join(scratch, "tour"))).map(
      (line) => `site/tour/${line}`,
    );
    if (stale.length > 0) {
      fail(
        `The landing page's tour is not what ${version} builds:\n  ${stale.join("\n  ")}\nAs part of the release, run npm run build:tour and commit site/tour/.`,
      );
    }
    const { lines, over } = await measure(path.join(site, "tour"));
    if (over.length > 0) fail(over.join("\n"));
    console.log(`The landing page's tour is what ${version} builds.\n${lines.join("\n")}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} else {
  await rm(path.join(site, "tour"), { recursive: true, force: true });
  await buildTour(path.join(site, "tour"));
  const { lines, over } = await measure(path.join(site, "tour"));
  console.log(`Built site/tour/ from ${version}.\n${lines.join("\n")}`);
  if (over.length > 0) fail(over.join("\n"));
}
