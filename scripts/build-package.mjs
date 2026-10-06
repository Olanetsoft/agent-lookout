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

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist", "cli");

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
