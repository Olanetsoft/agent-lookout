import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import type { CSSOptions, Plugin } from "vite";
// `defineConfig` comes from vitest so the `test` block is typed.
import { defineConfig } from "vitest/config";
import type { BrowserCommand } from "vitest/node";

import { collectorPlugin } from "./src/collector/hosts/collectorPlugin.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** An absolute path from one relative to this file. */
const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Vitest sets this before it loads the config. The collector is left out of test
// runs so a test never starts the poller or reads real sessions from this machine.
const isTest = process.env.VITEST !== undefined;

/**
 * The three libraries that make up most of the build each get a file of their
 * own, so no one file grows past the size Vite warns about. Each list names the
 * library and everything only it depends on, so a file never has to reach back
 * into the app's own for a helper.
 */
const vendorChunks: Record<string, RegExp> = {
  // tslib is used by the other two, so it sits here, below both.
  react: /\/node_modules\/(react|react-dom|scheduler|tslib)\//,
  motion: /\/node_modules\/(motion|framer-motion|motion-dom|motion-utils)\//,
  radix:
    /\/node_modules\/(radix-ui|@radix-ui|@floating-ui|aria-hidden|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|get-nonce|use-callback-ref|use-sidecar|detect-node-es)\//,
};

/**
 * The file in `dist/` that holds the licences of the libraries and fonts the
 * dashboard includes. `scripts/build-package.mjs` adds those the command bundles.
 */
const LICENSES_FILE = "THIRD-PARTY-LICENSES.md";

/**
 * The packages the dashboard takes only CSS and fonts from. Vite writes the
 * licences of the packages whose JavaScript it bundles, and sees no others,
 * so these are added to its file.
 */
const cssAndFontPackages = [
  "tailwindcss",
  "tw-animate-css",
  "@fontsource/atkinson-hyperlegible-next",
  "@fontsource/atkinson-hyperlegible-mono",
];

/**
 * Notices for bundled packages that publish no licence text of their own,
 * copied from their repositories into `licenses/<name>.txt`:
 * react-remove-scroll-bar, from https://github.com/theKashey/react-remove-scroll-bar.
 */
const LICENSES_DIR = "./licenses";

/** The file in `licenses/` that holds a package's notice. A scope's slash becomes `__`. */
function noticeFile(name: string): string {
  return fromRoot(`${LICENSES_DIR}/${name.replace("/", "__")}.txt`);
}

/**
 * Fills each entry Vite wrote with no text under its heading, because the package
 * ships no LICENSE, from `licenses/`. An entry left empty stops the build.
 */
function fillMissingNotices(written: string, fail: (message: string) => never): string {
  const lines = written.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const heading = /^## (.+) - \S+ \(.+\)$/.exec(lines[i]);
    if (!heading) continue;
    let next = i + 1;
    while (next < lines.length && lines[next].trim() === "") next++;
    if (next < lines.length && !lines[next].startsWith("## ")) continue;
    const name = heading[1];
    const file = noticeFile(name);
    if (!existsSync(file)) {
      fail(
        `${name} ships no licence text, so ${LICENSES_FILE} would have an empty entry for it. Copy its notice from its repository into licenses/${name.replace("/", "__")}.txt.`,
      );
    }
    out.push("", readFileSync(file, "utf8").trim());
  }
  return out.join("\n");
}

/**
 * Adds each of `cssAndFontPackages` to the licence file Vite has written, as
 * Vite writes its own: the name, version and licence, then the whole of the
 * package's LICENSE, and fills any entry Vite left empty. A package or a
 * notice that is missing stops the build, so `dist/` is never built without a
 * notice it has to carry.
 */
function cssAndFontLicenses(): Plugin {
  return {
    name: "agent-lookout:css-and-font-licenses",
    apply: "build",
    async writeBundle(options) {
      const file = path.join(options.dir ?? fromRoot("./dist"), LICENSES_FILE);
      if (!existsSync(file)) {
        this.error(
          `Vite wrote no ${LICENSES_FILE}, so the licences of the CSS and fonts have nowhere to go.`,
        );
      }
      const written = readFileSync(file, "utf8");
      let added = "";
      for (const name of cssAndFontPackages) {
        // Vite lists it already, if it ever comes to see the package.
        if (written.includes(`\n## ${name} - `)) continue;
        const manifest = fromRoot(`./node_modules/${name}/package.json`);
        if (!existsSync(manifest)) {
          this.error(
            `${name} is not installed, so its licence cannot go into ${LICENSES_FILE}. Run npm install.`,
          );
        }
        const license = fromRoot(`./node_modules/${name}/LICENSE`);
        if (!existsSync(license)) {
          this.error(
            `${name} has no LICENSE file, so its licence cannot go into ${LICENSES_FILE}.`,
          );
        }
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          version: string;
          license: string;
        };
        const text = readFileSync(license, "utf8").trim();
        added += `\n## ${name} - ${pkg.version} (${pkg.license})\n\n${text}\n`;
      }
      const fail = (message: string): never => this.error(message);
      await writeFile(file, fillMissingNotices(written, fail) + added);
    },
  };
}

/**
 * A PostCSS plugin object: of the plugin shapes `css.postcss.plugins` takes,
 * the one with a `postcssPlugin` name that is not a function. It is read from
 * Vite's own options because PostCSS comes with Vite and is not a dependency
 * here, so nothing in this package imports `postcss` by name.
 */
type PostcssPlugin = Exclude<
  Extract<
    NonNullable<Exclude<CSSOptions["postcss"], string | undefined>["plugins"]>[number],
    { postcssPlugin: string }
  >,
  (...args: never[]) => unknown
>;

/** A source in a `@font-face` that is a `.woff` file, the format before `.woff2`. */
const WOFF_SOURCE =
  /\bformat\(\s*["']?woff["']?\s*\)|\burl\(\s*["']?[^"')]*\.woff(?:[?#][^"')]*)?["']?\s*\)/i;

/**
 * Each `@font-face` from the fontsource packages names a `.woff2` file and,
 * after it, a `.woff` for browsers that cannot read `.woff2`. Every browser
 * the dashboard is built for reads `.woff2`: Vite builds for Chrome and Edge
 * 107, Firefox 104 and Safari 16 by default, and each of them has read it
 * since 2018 at the latest. So a `.woff` would never be fetched, only shipped.
 * This takes each one out of `src` before Vite looks for the files a
 * stylesheet names, so none is copied into `dist/`. It works in `Once`, which
 * runs before Vite's own plugin for those files, also in `Once`: a listener
 * for each rule would run only after that plugin had copied them.
 */
function woff2Only(): PostcssPlugin {
  return {
    postcssPlugin: "agent-lookout:woff2-only",
    Once(root, { postcss }) {
      root.walkAtRules("font-face", (rule) => {
        rule.walkDecls("src", (declaration) => {
          const sources = postcss.list.comma(declaration.value);
          const kept = sources.filter((source) => !WOFF_SOURCE.test(source));
          if (kept.length > 0 && kept.length < sources.length) declaration.value = kept.join(", ");
        });
      });
    },
  };
}

/** The media features a component test can set, as a person's computer would. */
interface EmulatedMedia {
  colorScheme?: "light" | "dark" | null;
  reducedMotion?: "reduce" | "no-preference" | null;
}

/**
 * Sets what `prefers-color-scheme` and `prefers-reduced-motion` report to the
 * test page. `null` puts a feature back to the browser's own. Component tests
 * reach it through `tests/support/browser/media.ts`.
 */
const emulateMedia: BrowserCommand<[EmulatedMedia]> = async (context, media) => {
  await context.page.emulateMedia(media);
};

export default defineConfig({
  plugins: [react(), tailwindcss(), cssAndFontLicenses(), !isTest && collectorPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  css: {
    postcss: { plugins: [woff2Only()] },
  },
  resolve: {
    alias: {
      "@cli": fromRoot("./src/cli"),
      "@core": fromRoot("./src/core"),
      "@collector": fromRoot("./src/collector"),
      "@dashboard": fromRoot("./src/dashboard"),
      "@desktop": fromRoot("./src/desktop"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    // The licences of the packages whose JavaScript is bundled. `cssAndFontLicenses`
    // adds those of the CSS and fonts.
    license: { fileName: LICENSES_FILE },
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [name, packages] of Object.entries(vendorChunks)) {
            if (packages.test(id)) return name;
          }
          return undefined;
        },
      },
    },
  },
  test: {
    // Only tests can reach `tests/`. The build has no such alias, so production
    // code that imported a fixture or a helper would not build.
    alias: {
      "@tests": fromRoot("./tests"),
    },
    // Everything the browser tests write goes to one git-ignored folder.
    attachmentsDir: "tests/.artifacts/attachments",
    // A project is chosen by folder. `tests/README.md` says what belongs in each.
    projects: [
      {
        // One module at a time, in Node: no sockets, no child processes, no real files.
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: ["./tests/support/node/nodeSetup.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        // Real sockets, servers, child processes and files, in Node.
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: ["./tests/support/node/nodeSetup.ts"],
          sequence: { groupOrder: 1 },
        },
      },
      {
        // Rendered in real headless Chromium, because these tests assert computed
        // styles and layout that jsdom does not produce.
        extends: true,
        test: {
          name: "component",
          // A component is tested in a .test.tsx file; a plain module that needs a
          // real page, such as the theme or the stylesheet, in a .test.ts file.
          include: ["tests/component/**/*.test.{ts,tsx}"],
          setupFiles: ["./tests/support/browser/componentSetup.ts"],
          sequence: { groupOrder: 2 },
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
            screenshotDirectory: "tests/.artifacts/screenshots",
            commands: { emulateMedia },
          },
        },
      },
    ],
  },
});
