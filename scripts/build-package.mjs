// Builds what the npm package runs: the `agent-lookout` command and the
// collector it starts, bundled with esbuild into plain JavaScript in
// `dist/cli/`, beside the dashboard that `npm run build` puts in `dist/`.
// `npm run build:package` runs both, and `npm pack` and `npm publish` run that
// first, through `prepack`. `bin/agent-lookout.mjs` loads the bundle when there
// is no `src/` beside it, as in the installed package.
//
// The libraries the command loads only when it needs them, the MCP SDK and zod
// for `mcp` and nodemailer for email, stay outside the bundle and are the
// package's dependencies, and Node's own modules stay outside too. This script
// stops if the bundle imports any other package, since a person who installs
// the package would not have it. Each dynamic import becomes a file of its
// own, so `status` loads none of the collector.
//
// Every file lands directly in `dist/cli/`, two folders below the package root,
// as the collector's source files are below it in `src/`: the collector reads
// its version from `package.json` by that path. No source map is written, and
// no path on this machine goes into the files.
//
// The dashboard's build writes dist/THIRD-PARTY-LICENSES.md, the licences of
// the libraries and fonts it includes, which the package has to carry. This
// script stops before anything is bundled or packed if that file is missing,
// lacks one of the entries it must have or the font licence, or holds a path
// on this machine.

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist", "cli");

/** The licence file the dashboard's build writes, beside its index.html. */
const LICENSES_FILE = "dist/THIRD-PARTY-LICENSES.md";

/**
 * Packages the licence file must name, at the least: the library most of the
 * dashboard's JavaScript is, and the packages its CSS and fonts come from,
 * which Vite does not see and vite.config.ts adds.
 */
const REQUIRED_LICENSES = [
  "react",
  "tailwindcss",
  "@fontsource/atkinson-hyperlegible-next",
  "@fontsource/atkinson-hyperlegible-mono",
];

/** The packages whose entry in the licence file has a heading and no text under it. */
function emptyEntries(text) {
  const lines = text.split("\n");
  const empty = [];
  lines.forEach((line, index) => {
    const heading = /^## (.+) - \S+ \(.+\)$/.exec(line);
    if (!heading) return;
    let next = index + 1;
    while (next < lines.length && lines[next].trim() === "") next++;
    if (next >= lines.length || lines[next].startsWith("## ")) empty.push(heading[1]);
  });
  return empty;
}

/** What is wrong with the licence file, in one sentence, or null when nothing is. */
async function licensesProblem() {
  const file = path.join(root, LICENSES_FILE);
  if (!existsSync(file)) {
    return `${LICENSES_FILE} is missing. Run \`npm run build:package\`, which writes it with the dashboard.`;
  }
  const text = await readFile(file, "utf8");
  const missing = REQUIRED_LICENSES.filter((name) => !text.includes(`\n## ${name} - `));
  if (missing.length > 0) {
    return `${LICENSES_FILE} has no entry for ${missing.join(", ")}. Check the licence options in vite.config.ts.`;
  }
  const empty = emptyEntries(text);
  if (empty.length > 0) {
    return `${LICENSES_FILE} has no licence text for ${empty.join(", ")}. Add each notice to licenses/, as vite.config.ts describes.`;
  }
  if (!text.includes("SIL OPEN FONT LICENSE")) {
    return `${LICENSES_FILE} does not hold the SIL Open Font License, which the dashboard's fonts are under.`;
  }
  const home = homedir();
  if (text.includes(root) || (home.length > 1 && text.includes(home))) {
    return `${LICENSES_FILE} holds a path on this machine.`;
  }
  return null;
}

/** The package an import names: `@scope/name` or `name`, without a path inside it. */
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function main() {
  if (!existsSync(path.join(root, "dist", "index.html"))) {
    console.error("The dashboard has not been built yet. Run `npm run build:package`.");
    return 1;
  }
  const problem = await licensesProblem();
  if (problem !== null) {
    console.error(problem);
    return 1;
  }
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  await rm(outdir, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: { "agent-lookout": "src/cli/agentLookout.ts" },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node20.19",
    packages: "external",
    chunkNames: "[name]-[hash]",
    sourcemap: false,
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  });

  const imported = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const { path: specifier, external } of output.imports) {
      if (external && !isBuiltin(specifier)) imported.add(packageName(specifier));
    }
  }
  const missing = [...imported].filter((name) => !(name in (pkg.dependencies ?? {})));
  if (missing.length > 0) {
    console.error(
      `The bundle imports ${missing.join(", ")}, which package.json does not list under dependencies. Add ${missing.length === 1 ? "it" : "them"} there, or bundle ${missing.length === 1 ? "it" : "them"}.`,
    );
    return 1;
  }

  const files = Object.entries(result.metafile.outputs).map(
    ([file, { bytes }]) => `  ${path.relative(root, path.resolve(root, file))}  ${bytes} bytes`,
  );
  console.log(`Built the command into dist/cli/:\n${files.join("\n")}`);
  console.log(`It loads ${[...imported].sort().join(", ")} from node_modules when it needs them.`);
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}
process.exit(code);
