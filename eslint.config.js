import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// Type-aware linting is off on purpose. `tsc -b` is the authority on types.
export default defineConfig(
  globalIgnores([
    "dist",
    "dist-electron",
    "release",
    ".output",
    "coverage",
    "tests/.artifacts",
    ".claude",
    ".reference",
    // Built by scripts/site-tour/build.mjs for the landing page.
    "site/tour",
    "site/vendor",
  ]),

  // One block for every source file, so a new folder is linted the day it appears.
  {
    files: ["**/*.{ts,tsx,mts,mjs,js}"],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-debugger": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  // Production code never imports from tests/. `scripts/check-layout.mjs` checks
  // the same rule without ESLint.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tests", "@tests/*", "**/tests/**"],
              message: "Production code never imports from tests/.",
            },
          ],
        },
      ],
    },
  },

  // The dashboard, and the tests that render it or call its code.
  {
    files: [
      "src/dashboard/**/*.{ts,tsx}",
      "tests/component/**/*.{ts,tsx}",
      "tests/unit/dashboard/**/*.{ts,tsx}",
      "tests/support/browser/browser.ts",
    ],
    extends: [reactHooks.configs.flat.recommended],
    plugins: { "react-refresh": reactRefresh },
    rules: {
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  // Node code that reports to a terminal.
  {
    files: ["src/collector/**", "scripts/**"],
    rules: {
      "no-console": "off",
    },
  },

  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
