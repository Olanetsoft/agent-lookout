#!/usr/bin/env node
// The `agent-lookout` command. Installed from npm, it runs the plain JavaScript
// that `npm run build:package` bundles into `dist/cli/`, and needs no
// TypeScript. In a clone, where `src/` is, it runs the TypeScript in `src/cli/`
// through tsx, as `npm start` runs the server, so a change to the source is
// used at once and a bundle left by an earlier `npm pack` never is.
// `npm link` in a clone puts it on the PATH, and `npm run --silent status`
// runs it from there.
//
// For status, exit code 1 means a session needs you, so nothing else status
// does may end with it. start ends with 1 when it cannot start, as its help
// says. Whatever goes wrong here, such as tsx missing while `npm ci` runs, is
// one line on stderr and exit code 2.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A reader that went away, such as `| head` or a prompt, is no reason to change the answer.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const source = new URL("../src/cli/agentLookout.ts", import.meta.url);
const bundle = new URL("../dist/cli/agent-lookout.js", import.meta.url);

try {
  let command;
  if (existsSync(source)) {
    const { register } = await import("tsx/esm/api");
    register();
    command = await import(source.href);
  } else {
    command = await import(bundle.href);
  }
  process.exitCode = await command.runCommand({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    distDir: fileURLToPath(new URL("../dist/", import.meta.url)),
  });
} catch (error) {
  const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
  process.stderr.write(`agent-lookout could not run: ${why}\n`);
  process.exitCode = 2;
}
