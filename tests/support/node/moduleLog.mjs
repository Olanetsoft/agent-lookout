// Writes down every module a Node process loads, for tests that check what a
// process never loads. Start the process with `--import` naming this file, in
// NODE_OPTIONS so that a process it starts does the same, and with
// MODULE_LOG_FILE naming a file: each module's address is added to it, one to a
// line. It is plain JavaScript because Node loads it before anything that could
// run TypeScript.

import { appendFileSync } from "node:fs";
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";

let logFile = "";

/** Runs in the thread where the hooks run, with what `register` was given. */
export function initialize(data) {
  logFile = data.file;
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  appendFileSync(logFile, `${resolved.url}\n`);
  return resolved;
}

// Loaded by `--import`, this file registers itself. Loaded again as the hooks,
// in a thread of their own, it does not.
const file = process.env.MODULE_LOG_FILE;
if (isMainThread && file) register(import.meta.url, { data: { file } });
