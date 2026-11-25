// What puts a new version in the running app's place. The app cannot replace
// its own bundle while it runs from it, so it starts a small helper, then
// quits. The helper waits for the app's process to end, moves the old bundle
// aside into the update's own folder, moves the new one into its place and
// opens it. It moves nothing unless the new one has its `Info.plist` and a
// program, and if the new one cannot be moved in, or cannot be opened, the old
// one is put back and opened, so the person is never left with no app. A new
// one that cannot go back where it was makes way under another name beside the
// app, and goes where the old one waited once that is back.
//
// The helper is `/bin/sh` with a script that is fixed text, written here. It
// is never built from anything: the process ID and the three paths reach it
// as arguments, `$1` to `$4`, which the shell never reads as script. The paths
// are the running bundle's own, and two in a folder the updater made itself,
// and each is checked before the helper starts. Every program the script runs
// is named by its full path.

import { spawn as spawnProcess } from "node:child_process";
// The paths are a Mac's, so they are checked by the rules of macOS paths.
import path from "node:path/posix";

export const HELPER_SHELL = "/bin/sh";

/** How long the helper waits for the app to quit, at the least: two minutes. */
export const HELPER_WAIT_MS = 120_000;

/** That wait in tenths of a second, which is how often the helper looks. */
const WAIT_TENTHS = HELPER_WAIT_MS / 100;

/**
 * The helper's script. `$1` is the app's process ID, `$2` the bundle, `$3` the
 * new bundle, `$4` where the old one goes.
 *
 * `mv` puts a bundle inside a folder that is there already, so the old one is
 * put back only once nothing is in its place. An open that fails is tried once
 * more, a second later, since macOS can still count the app that quit as open.
 */
export const HELPER_SCRIPT = [
  'pid="$1"; app="$2"; new="$3"; aside="$4"; beside="$2"."$$"',
  'open_app() { /usr/bin/open "$app" || { /bin/sleep 1; /usr/bin/open "$app"; }; }',
  "n=0",
  'while /bin/kill -0 "$pid" 2>/dev/null; do',
  "  n=$((n + 1))",
  `  if [ "$n" -gt ${WAIT_TENTHS} ]; then exit 1; fi`,
  "  /bin/sleep 0.1",
  "done",
  "whole=no",
  'for program in "$new"/Contents/MacOS/*; do',
  '  if [ -f "$program" ] && [ -x "$program" ]; then whole=yes; fi',
  "done",
  'if [ ! -f "$new"/Contents/Info.plist ]; then whole=no; fi',
  'if [ "$whole" = yes ] && /bin/mv "$app" "$aside"; then',
  '  if /bin/mv "$new" "$app" && open_app; then exit 0; fi',
  '  /bin/mv "$app" "$new" || /bin/mv "$app" "$beside"',
  '  if [ ! -e "$app" ] && /bin/mv "$aside" "$app"; then /bin/mv "$beside" "$aside"; fi',
  '  if [ ! -e "$app" ]; then /bin/mv "$beside" "$app"; fi',
  "fi",
  "open_app",
  "exit 1",
].join("\n");

/** What the helper is told. */
export interface InstallPlan {
  /** The process ID of the running app, which the helper waits for. */
  pid: number;
  /** The running app's bundle, which is replaced. */
  bundle: string;
  /** The new bundle, unpacked and checked in the update's own folder. */
  replacement: string;
  /** Where the old bundle is moved, in the same folder. */
  aside: string;
}

/** Whether a path may be handed to the helper: absolute, tidy, a bundle, with nothing in it a line could break on. */
function isBundlePath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value.endsWith(".app") &&
    !/[\0\n\r]/.test(value)
  );
}

/**
 * The arguments `/bin/sh` is started with: `-c`, the fixed script, the name
 * it runs as, and the plan. Null when any part of the plan is not what it must
 * be, so nothing is started.
 */
export function helperArguments(plan: InstallPlan): string[] | null {
  if (!Number.isSafeInteger(plan.pid) || plan.pid <= 1) return null;
  const paths = [plan.bundle, plan.replacement, plan.aside];
  if (!paths.every(isBundlePath)) return null;
  if (new Set(paths).size !== paths.length) return null;
  return ["-c", HELPER_SCRIPT, "agent-lookout-update", String(plan.pid), ...paths];
}

/**
 * Starts a program apart from this one, so it outlives it: Node's `spawn`,
 * detached, with nothing connected. Resolves with whether it started.
 */
export type StartDetached = (file: string, args: readonly string[]) => Promise<boolean>;

export const startDetached: StartDetached = (file, args) =>
  new Promise((resolve) => {
    try {
      const child = spawnProcess(file, [...args], { detached: true, stdio: "ignore" });
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
      child.unref();
    } catch {
      resolve(false);
    }
  });

/** Starts the helper for a plan. False when the plan was refused or the helper did not start. */
export async function startHelper(
  plan: InstallPlan,
  start: StartDetached = startDetached,
): Promise<boolean> {
  const args = helperArguments(plan);
  if (args === null) return false;
  try {
    return await start(HELPER_SHELL, args);
  } catch {
    return false;
  }
}
