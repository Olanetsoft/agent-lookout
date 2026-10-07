// Builds the two things the landing page in site/ takes from this repository,
// since Vercel serves that folder as it is and runs no build:
//
//   site/tour/          the real dashboard, built from src/site-tour/ with Vite,
//                       for the frame the page plays its tour in
//   site/vendor/motion.mjs
//                       the two parts of Motion the page's own script uses,
//                       scroll and the small animate, bundled with esbuild under
//                       Motion's licence
//
// Both are committed, and both are built from a release: the landing page shows
// the dashboard as the version people install has it, never a feature that has
// not shipped. So they are rebuilt only as part of a release:
//
//   node scripts/site-tour/build.mjs           npm run build:tour, a step of the
//                                              release: writes them, and the
//                                              line for Motion in site/licenses.txt
//   node scripts/site-tour/build.mjs --check   npm run check:tour: builds them
//                                              again into a temporary folder and
//                                              fails when what is committed differs
//   ... --check --since <commit>               CI: the same, but only when the
//                                              version in package.json differs from
//                                              the one at <commit>, which is a release.
//                                              Otherwise only the sizes are checked
//   node scripts/site-tour/build.mjs --sizes   npm run check:tour-size: the sizes of
//                                              what is committed, built nothing
//
// A feature on main that no release has yet stays out of the tour until one
// does. Today there is none: the tour shows all that 0.2.6 builds, permission
// rules with it.
//
// Every mode fails when a file is over its budget: the first screen of the page
// must load as fast as it did before the tour, and everything here loads after
// it. And every mode fails when site/licenses.txt names another version of
// Motion than the one bundled.
//
// The tour takes its fonts from the page's own folder, site/assets/fonts/, so
// the page and its dashboard share one copy of each face.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build as esbuild } from "esbuild";
import { build as viteBuild, createLogger } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, "site");
const checking = process.argv.includes("--check");
const sizesOnly = process.argv.includes("--sizes");
const sinceAt = process.argv.indexOf("--since");
const since = sinceAt === -1 ? null : (process.argv[sinceAt + 1] ?? "");
const LICENSES = path.join(site, "licenses.txt");
/** The line in site/licenses.txt that names the Motion bundled, and its version. */
const MOTION_LINE = /^- Motion (\S+), MIT licence/m;

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

/** Budgets, in bytes sent gzipped. */
const BUDGET = {
  /** The dashboard, with Allow and Deny, time and permission rules and other machines, is about 241 KB of it. */
  tourJs: 256 * 1024,
  tourCss: 14 * 1024,
  tourHtml: 2 * 1024,
  pageScript: 8 * 1024,
  /** Motion's scroll and animate, and the licence it carries, which is 0.7 KB of it. */
  motion: 8 * 1024,
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

/** The version of Motion installed, which is the one bundled. */
async function motionVersion() {
  const manifest = JSON.parse(
    await readFile(path.join(root, "node_modules/motion/package.json"), "utf8"),
  );
  return manifest.version;
}

/** The version a bundle of Motion says it is, from its licence header. */
async function bundledMotion(file) {
  return (
    /^ \* Motion (\S+), https:\/\/motion\.dev/m.exec(await readFile(file, "utf8"))?.[1] ?? null
  );
}

/** The version of Motion site/licenses.txt names. */
async function listedMotion() {
  return MOTION_LINE.exec(await readFile(LICENSES, "utf8"))?.[1] ?? null;
}

/** Names the bundled version of Motion in site/licenses.txt. */
async function listMotion(version) {
  const text = await readFile(LICENSES, "utf8");
  if (!MOTION_LINE.test(text)) fail("site/licenses.txt has no line for Motion to update.");
  await writeFile(LICENSES, text.replace(MOTION_LINE, `- Motion ${version}, MIT licence`));
}

/** Every way site/licenses.txt and the bundle of Motion disagree. */
async function licenceProblems(motionFile, installed = null) {
  const bundled = await bundledMotion(motionFile);
  const listed = await listedMotion();
  const problems = [];
  if (listed !== bundled) {
    problems.push(
      `site/licenses.txt names Motion ${listed}, but site/vendor/motion.mjs is Motion ${bundled}.`,
    );
  }
  if (installed !== null && installed !== bundled) {
    problems.push(`Motion ${installed} is installed, but site/vendor/motion.mjs is ${bundled}.`);
  }
  return problems;
}

/** Bundles the parts of Motion the page uses into one module, under Motion's licence. */
async function buildMotion(file) {
  const manifest = { version: await motionVersion() };
  const licence = (await readFile(path.join(root, "node_modules/motion/LICENSE.md"), "utf8"))
    .trim()
    .replaceAll("*/", "* /");
  const result = await esbuild({
    stdin: {
      contents: 'export { scroll } from "motion";\nexport { animate } from "motion/mini";\n',
      resolveDir: root,
      loader: "js",
    },
    bundle: true,
    format: "esm",
    minify: true,
    platform: "browser",
    target: "es2020",
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    write: false,
  });
  const header = `/*!\n * Motion ${manifest.version}, https://motion.dev: scroll and animate from motion/mini,\n * bundled for the landing page by scripts/site-tour/build.mjs.\n *\n${licence
    .split("\n")
    .map((line) => (line ? ` * ${line}` : " *"))
    .join("\n")}\n */\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, header + result.outputFiles[0].text);
}

/** The sizes of what was built, and every budget it is over. */
async function measure(tourDir, motionFile) {
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
  const motion = gz(await readFile(motionFile));
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
  row("site/vendor/motion.mjs", motion, BUDGET.motion);
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

/** Checks only what is committed: its sizes and its licence line. Builds nothing. */
async function checkSizes(note = "") {
  const motionFile = path.join(site, "vendor/motion.mjs");
  const { lines, over } = await measure(path.join(site, "tour"), motionFile);
  const problems = [...over, ...(await licenceProblems(motionFile))];
  if (problems.length > 0) fail(problems.join("\n"));
  console.log(`${note}The landing page's tour is within its sizes.\n${lines.join("\n")}`);
}

const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const released =
  since === null ? true : since !== "" && ![null, version].includes(versionAt(since));

if (sizesOnly || (checking && !released)) {
  await checkSizes(
    sizesOnly
      ? ""
      : `Not a release: package.json says ${version}, as before. The tour is built only for a release.\n`,
  );
} else if (checking) {
  const scratch = await mkdtemp(path.join(tmpdir(), "agent-lookout-tour-check-"));
  try {
    await buildTour(path.join(scratch, "tour"));
    await buildMotion(path.join(scratch, "vendor/motion.mjs"));
    const stale = [
      ...(await differences(path.join(site, "tour"), path.join(scratch, "tour"))).map(
        (line) => `site/tour/${line}`,
      ),
      ...(await differences(path.join(site, "vendor"), path.join(scratch, "vendor"))).map(
        (line) => `site/vendor/${line}`,
      ),
    ];
    if (stale.length > 0) {
      fail(
        `The landing page's tour is not what ${version} builds:\n  ${stale.join("\n  ")}\nAs part of the release, run npm run build:tour and commit site/tour/, site/vendor/ and site/licenses.txt.`,
      );
    }
    const motionFile = path.join(site, "vendor/motion.mjs");
    const { lines, over } = await measure(path.join(site, "tour"), motionFile);
    const problems = [...over, ...(await licenceProblems(motionFile, await motionVersion()))];
    if (problems.length > 0) fail(problems.join("\n"));
    console.log(`The landing page's tour is what ${version} builds.\n${lines.join("\n")}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} else {
  await rm(path.join(site, "tour"), { recursive: true, force: true });
  await buildTour(path.join(site, "tour"));
  await buildMotion(path.join(site, "vendor/motion.mjs"));
  await listMotion(await motionVersion());
  const { lines, over } = await measure(
    path.join(site, "tour"),
    path.join(site, "vendor/motion.mjs"),
  );
  console.log(
    `Built site/tour/ and site/vendor/motion.mjs from ${version}, and named Motion in site/licenses.txt.\n${lines.join("\n")}`,
  );
  if (over.length > 0) fail(over.join("\n"));
}
