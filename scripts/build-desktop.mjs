// Builds what the Mac app runs into `dist-electron/`, which is the whole app:
//
//   dist-electron/main.cjs      the main process and the collector, bundled with esbuild
//   dist-electron/dist/         the built dashboard, copied from `dist/`
//   dist-electron/menu-bar/     the icon in the menu bar, copied from `build/menu-bar/`
//   dist-electron/package.json  the app's name, version and entry point
//
// `npm run build:desktop` runs `npm run build` first and then this script.
// `npm run dev:desktop` opens the folder with Electron, and `npm run dist:mac`
// packs it into the app with electron-builder (`electron-builder.ts`).
//
// Every library the main process uses is bundled into main.cjs, nodemailer
// included, so the app ships no node_modules folder at all. Only Electron
// itself and Node's own modules stay outside, and this script stops if the
// bundle imports anything else. The command's bundle in `dist/cli/` is not
// copied: the app does not run it. No source map is written, and no path on
// this machine goes into the files.

import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist-electron");
const dashboard = path.join(root, "dist");
/** The menu bar's template images, which `scripts/render-menu-bar-icon.mjs` draws. */
const menuBarIcons = path.join(root, "build", "menu-bar");

/** The Node version inside the Electron the app is built with. */
const ELECTRON_NODE = "node24";

async function main() {
  if (!existsSync(path.join(dashboard, "index.html"))) {
    console.error("The dashboard has not been built yet. Run `npm run build:desktop`.");
    return 1;
  }
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  await rm(outdir, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/desktop/main.ts"],
    outfile: path.join(outdir, "main.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ELECTRON_NODE,
    external: ["electron"],
    sourcemap: false,
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  });

  const imported = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const { path: specifier, external } of output.imports) {
      if (external && !isBuiltin(specifier) && specifier !== "electron") imported.add(specifier);
    }
  }
  if (imported.size > 0) {
    console.error(
      `The main process imports ${[...imported].join(", ")} at run time, and the app ships no node_modules. Bundle it.`,
    );
    return 1;
  }

  if (!existsSync(path.join(menuBarIcons, "quietTemplate.png"))) {
    console.error(
      "The menu bar's icons are missing from build/menu-bar/. Run `node scripts/render-menu-bar-icon.mjs`.",
    );
    return 1;
  }
  await cp(menuBarIcons, path.join(outdir, "menu-bar"), { recursive: true });

  const cli = path.join(dashboard, "cli");
  await cp(dashboard, path.join(outdir, "dist"), {
    recursive: true,
    filter: (source) => source !== cli && !source.startsWith(cli + path.sep),
  });

  // The app's own package.json. Electron takes the app's name, which also
  // names its folder of user data, and its version from here.
  const app = {
    name: pkg.name,
    productName: "Agent Lookout",
    version: pkg.version,
    description: pkg.description,
    homepage: pkg.homepage,
    license: pkg.license,
    author: "Idris Olubisi",
    private: true,
    main: "main.cjs",
  };
  await writeFile(path.join(outdir, "package.json"), `${JSON.stringify(app, null, 2)}\n`);

  const bytes = result.metafile.outputs[path.relative(root, path.join(outdir, "main.cjs"))]?.bytes;
  console.log(
    `Built the Mac app into dist-electron/: main.cjs (${bytes} bytes), dist/, menu-bar/ and package.json.`,
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
