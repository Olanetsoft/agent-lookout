import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
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

/** The media features a component test can set, as a person's computer would. */
interface EmulatedMedia {
  colorScheme?: "light" | "dark" | null;
  reducedMotion?: "reduce" | "no-preference" | null;
}

/**
 * Sets what `prefers-color-scheme` and `prefers-reduced-motion` report to the
 * test page. `null` puts a feature back to the browser's own. Component tests
 * reach it through `tests/support/media.ts`.
 */
const emulateMedia: BrowserCommand<[EmulatedMedia]> = async (context, media) => {
  await context.page.emulateMedia(media);
};

export default defineConfig({
  plugins: [react(), tailwindcss(), !isTest && collectorPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@core": fromRoot("./src/core"),
      "@collector": fromRoot("./src/collector"),
      "@dashboard": fromRoot("./src/dashboard"),
    },
  },
  server: {
    port: 5173,
  },
  build: {
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
          setupFiles: ["./tests/support/componentSetup.ts"],
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
