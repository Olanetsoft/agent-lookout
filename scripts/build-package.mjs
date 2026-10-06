// Builds what the npm package runs: the `agent-lookout` command and the
// collector it starts, bundled with esbuild into plain JavaScript in
// `dist/cli/`, beside the dashboard that `npm run build` puts in `dist/`.
// `npm run build:package` runs both, and `npm pack` and `npm publish` run that
// first, through `prepack`. `bin/agent-lookout.mjs` loads the bundle when there
// is no `src/` beside it, as in the installed package.
//
// The MCP SDK and zod, which only `mcp` uses, are bundled, `BUNDLED` below:
// only the parts the command imports go in, with what those parts need, into
// the file that only `mcp` loads. So the package installs neither of them, nor
// the web servers the SDK depends on for the transports the command never
// uses. nodemailer, which email loads only once it is set up, stays outside
// the bundle and is the package's one dependency, and Node's own modules stay
// outside too. This script stops if the command's own code imports any other
// package, so that a new one is bundled or made a dependency on purpose. Each
// dynamic import becomes a file of its own, so `status` loads none of the
// collector and none of the SDK.
//
// A package that node_modules holds twice at the same version, as it holds
// ajv here, goes into the bundle once, as npm would install it once.
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
// on this machine. Then it adds to it the licence of every package the bundle
// includes, from the package's own licence file, or from `licenses/` for a
// package that ships none, and stops if a package has neither.

import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * The packages the command's own code imports that go into the bundle, with
 * whatever of their own dependencies they use. Each is a devDependency.
 */
const BUNDLED = ["@modelcontextprotocol/sdk", "zod"];

/** The names packages give their licence file: LICENSE, LICENSE.md, LICENCE-MIT, COPYING and the like. */
const LICENSE_FILE_NAME = /^(licen[cs]e|copying)([.-][\w.-]+)?$/i;

/**
 * Notices for packages that publish no licence text of their own, in
 * `licenses/<name>.txt` with a scope's slash made `__`, as vite.config.ts
 * keeps them for the dashboard.
 */
const NOTICES_DIR = path.join(root, "licenses");

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/** Passed to esbuild's own resolver, so the plugin below does not answer its own question. */
const RESOLVING = Symbol("resolving");

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

/**
 * What is wrong with the licence file, in one sentence, or null when nothing
 * is. `required` names the packages it must have an entry for.
 */
async function licensesProblem(required) {
  const file = path.join(root, LICENSES_FILE);
  if (!existsSync(file)) {
    return `${LICENSES_FILE} is missing. Run \`npm run build:package\`, which writes it with the dashboard.`;
  }
  const text = await readFile(file, "utf8");
  const missing = required.filter((name) => !text.includes(`\n## ${name} - `));
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

/** The folder of the installed package that holds a file, or null for a file of this project's own. */
function packageFolder(file) {
  const at = file.lastIndexOf(NODE_MODULES);
  if (at < root.length) return null;
  const start = at + NODE_MODULES.length;
  const parts = file.slice(start).split(path.sep);
  return file.slice(0, start) + parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join(path.sep);
}

const manifests = new Map();

/** The package.json of an installed package, read once. */
function manifestOf(folder) {
  if (!manifests.has(folder)) {
    manifests.set(
      folder,
      readFile(path.join(folder, "package.json"), "utf8").then((text) => JSON.parse(text)),
    );
  }
  return manifests.get(folder);
}

/**
 * Leaves each of the package's dependencies to node_modules, lets esbuild
 * bundle `BUNDLED` and what they import, and refuses any other package the
 * command's own code imports. What a bundled package imports is taken from
 * the copy each of `BUNDLED`, in order, would find, when that copy is the
 * same version as the one the importer would find, so that a package
 * node_modules holds twice is bundled once.
 */
function choosePackages(dependencies) {
  return {
    name: "agent-lookout:packages",
    setup(bundler) {
      const firstPlaces = BUNDLED.map((name) => path.join(root, "node_modules", name));
      bundler.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.kind === "entry-point" || args.pluginData === RESOLVING) return undefined;
        if (isBuiltin(args.path)) return undefined;
        const name = packageName(args.path);
        if (Object.hasOwn(dependencies, name)) return { path: args.path, external: true };
        if (packageFolder(args.importer) === null) {
          if (BUNDLED.includes(name)) return undefined;
          return {
            errors: [
              {
                text: `The command imports ${name}, which is neither bundled nor one of the package's dependencies. Add it to BUNDLED in scripts/build-package.mjs, or to dependencies in package.json.`,
              },
            ],
          };
        }

        const resolve = (resolveDir) =>
          bundler.resolve(args.path, { kind: args.kind, resolveDir, pluginData: RESOLVING });
        const own = await resolve(args.resolveDir);
        const ownFolder = own.errors.length === 0 && !own.external ? packageFolder(own.path) : null;
        if (ownFolder === null) return undefined;
        const { version } = await manifestOf(ownFolder);
        for (const place of firstPlaces) {
          const there = await resolve(place);
          const folder =
            there.errors.length === 0 && !there.external ? packageFolder(there.path) : null;
          if (folder === null) continue;
          const found = await manifestOf(folder);
          if (found.name === name && found.version === version) {
            return { path: there.path, sideEffects: there.sideEffects };
          }
        }
        return { path: own.path, sideEffects: own.sideEffects };
      });
    },
  };
}

/** Every package the bundle includes, by name and then version. */
async function bundledPackages(metafile) {
  const folders = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const folder = packageFolder(path.resolve(root, input));
    if (folder !== null) folders.add(folder);
  }
  const packages = [];
  for (const folder of folders) {
    const { name, version, license } = await manifestOf(folder);
    packages.push({
      name,
      version,
      license: typeof license === "string" ? license : "unknown",
      folder,
    });
  }
  return packages.sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
  );
}

/** A package's licence text: its own licence file, else its notice in `licenses/`, else null. */
async function licenseText(pkg) {
  const own = (await readdir(pkg.folder)).find((name) => LICENSE_FILE_NAME.test(name));
  if (own) return (await readFile(path.join(pkg.folder, own), "utf8")).trim();
  const notice = path.join(NOTICES_DIR, `${pkg.name.replace("/", "__")}.txt`);
  if (existsSync(notice)) return (await readFile(notice, "utf8")).trim();
  return null;
}

/**
 * Adds an entry to the licence file for each package the bundle includes, as
 * Vite writes its own, unless one is there already for that version. Resolves
 * with what is wrong, in one sentence, or null.
 */
async function addLicenses(packages) {
  const file = path.join(root, LICENSES_FILE);
  const written = await readFile(file, "utf8");
  let added = "";
  for (const pkg of packages) {
    if (written.includes(`\n## ${pkg.name} - ${pkg.version} (`)) continue;
    const text = await licenseText(pkg);
    if (text === null) {
      return `${pkg.name} ships no licence text, so ${LICENSES_FILE} would have no entry for it. Copy its notice from its repository into licenses/${pkg.name.replace("/", "__")}.txt.`;
    }
    added += `\n## ${pkg.name} - ${pkg.version} (${pkg.license})\n\n${text}\n`;
  }
  await writeFile(file, written + added);
  return null;
}

async function main() {
  if (!existsSync(path.join(root, "dist", "index.html"))) {
    console.error("The dashboard has not been built yet. Run `npm run build:package`.");
    return 1;
  }
  const before = await licensesProblem(REQUIRED_LICENSES);
  if (before !== null) {
    console.error(before);
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
    target: "node22.12",
    plugins: [choosePackages(pkg.dependencies ?? {})],
    chunkNames: "[name]-[hash]",
    sourcemap: false,
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  });

  const packages = await bundledPackages(result.metafile);
  const added = await addLicenses(packages);
  const after = added ?? (await licensesProblem([...REQUIRED_LICENSES, ...BUNDLED]));
  if (after !== null) {
    console.error(after);
    return 1;
  }

  const imported = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const { path: specifier, external } of output.imports) {
      if (external && !isBuiltin(specifier)) imported.add(packageName(specifier));
    }
  }
  const files = Object.entries(result.metafile.outputs).map(
    ([file, { bytes }]) => `  ${path.relative(root, path.resolve(root, file))}  ${bytes} bytes`,
  );
  console.log(`Built the command into dist/cli/:\n${files.join("\n")}`);
  console.log(
    `It bundles ${packages.map(({ name, version }) => `${name} ${version}`).join(", ")}, whose licences are in ${LICENSES_FILE}.`,
  );
  console.log(
    `It loads ${[...imported].sort().join(", ")} from node_modules when it needs ${imported.size === 1 ? "it" : "them"}.`,
  );
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}
process.exit(code);
