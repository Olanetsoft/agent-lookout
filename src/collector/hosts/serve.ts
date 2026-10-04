// The entry point that `npm start` runs: the standalone host, serving the built
// dashboard from `dist/` and reading its settings from this process's
// environment. `standalone.ts` holds the host itself.

import { fileURLToPath } from "node:url";

import { runStandalone } from "./standalone.ts";

await runStandalone({
  distDir: fileURLToPath(new URL("../../../dist/", import.meta.url)),
  env: process.env,
  print: console,
  process,
});
