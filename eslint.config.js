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
  //
  // And Motion is used only as `m` under the LazyMotion in src/dashboard/App.tsx,
  // which loads `domMin`: animations and exit, with no gestures, layout
  // animations or dragging. A `motion` component would bring the rest back, and
  // a prop on `m` that needs a feature left out would do nothing. Both rules sit
  // here because a second block for the same files would replace this one.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "motion/react",
              importNames: ["motion", "domAnimation", "domMax"],
              message: "Use m: src/dashboard/App.tsx loads only domMin.",
            },
            {
              name: "motion/react-client",
              message: "Use m from motion/react: src/dashboard/App.tsx loads only domMin.",
            },
            {
              name: "framer-motion",
              message: "Use m from motion/react: src/dashboard/App.tsx loads only domMin.",
            },
          ],
          patterns: [
            {
              group: ["@tests", "@tests/*", "**/tests/**"],
              message: "Production code never imports from tests/.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.object.name='m'] > JSXAttribute[name.name=/^(layout|while|viewport$|drag(?!gable)|on(Hover|Tap|Pan|Layout|Viewport|DirectionLock|Drag(Start|End|TransitionEnd)?$)|onMeasureDragConstraints)/]",
          message:
            "src/dashboard/App.tsx loads only domMin, which has no gestures, layout animations or dragging, so this prop would do nothing. Load the feature there and change this rule first.",
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
