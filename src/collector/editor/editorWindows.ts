// VS Code is a Mac app here, so its paths are read by the rules of macOS paths
// whatever system reads them.
import path from "node:path/posix";

import type { EditorApp } from "../../core/sessions/session.ts";
import type { ProcessFacts } from "../processes/processTable.ts";

// Which editor a process runs under, read from a table of processes. Pure, so
// every odd chain can be tested.

/** An editor the collector found a process under. */
export interface EditorWindow {
  app: EditorApp;
  /**
   * The app's bundle, `/Applications/Visual Studio Code.app`, from the path its
   * program gave `ps`. The only app whose command is ever run. It never leaves
   * the collector.
   */
  bundle: string;
}

/** The editors whose window Jump brings forward, by the name of their app's folder. */
export const EDITOR_BUNDLES: ReadonlyMap<string, EditorApp> = new Map([
  ["Visual Studio Code.app", "VS Code"],
  ["Visual Studio Code - Insiders.app", "VS Code Insiders"],
]);

/** The longest path the collector reads as one: macOS's own limit. */
export const MAX_PATH_LENGTH = 1024;

/** A control or format character, or a line or paragraph separator. */
const UNSAFE_IN_PATH = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/**
 * Whether text is a whole macOS path written one way only: from `/`, with no
 * `.`, `..` or empty part, no `/` at the end but for `/` itself, at most 1,024
 * characters, and none that is a control or format character.
 */
export function isPlainPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    (value === "/" || !value.endsWith("/")) &&
    !UNSAFE_IN_PATH.test(value)
  );
}

/**
 * The outermost app bundle a program is in: `/Applications/Visual Studio
 * Code.app` for `.../Visual Studio Code.app/Contents/Frameworks/Code Helper
 * (Plugin).app/Contents/MacOS/Code Helper (Plugin)`. Null for a program that is
 * not a plain whole path, or has no part ending in `.app` that `Contents` follows.
 */
export function bundleOfProgram(program: string): string | null {
  if (!isPlainPath(program)) return null;
  const parts = program.split("/");
  for (let index = 1; index < parts.length - 1; index += 1) {
    const part = parts[index] ?? "";
    if (part.length > ".app".length && part.endsWith(".app") && parts[index + 1] === "Contents") {
      return parts.slice(0, index + 1).join("/");
    }
  }
  return null;
}

/** The editor a bundle is, by its folder's name, or null for any other app. */
export function editorOfBundle(bundle: string): EditorApp | null {
  // A Map, so no name reaches anything an object inherits.
  return EDITOR_BUNDLES.get(path.basename(bundle)) ?? null;
}

/**
 * The editor a process runs under: the first program, from the process itself
 * up through its parents, that is inside an app's bundle, when that app is one
 * of `EDITOR_BUNDLES`. Undefined when that first app is another, such as
 * Terminal, or none is found.
 *
 * A session of Claude Code's VS Code extension runs under the extension host,
 * `Code Helper (Plugin)`, which is inside VS Code's own bundle. A program that
 * names itself with anything but a plain whole path is passed over.
 *
 * The walk stops at the first process of the system, at a process `ps` did not
 * list, and at one already passed, so a table that loops cannot hold it.
 */
export function editorOfProcess(
  pid: number,
  table: ReadonlyMap<number, ProcessFacts>,
): EditorWindow | undefined {
  const passed = new Set<number>();
  let current = pid;
  while (current > 1 && !passed.has(current)) {
    const facts = table.get(current);
    if (!facts) return undefined;
    const bundle = bundleOfProgram(facts.path);
    if (bundle !== null) {
      const app = editorOfBundle(bundle);
      return app === null ? undefined : { app, bundle };
    }
    passed.add(current);
    current = facts.ppid;
  }
  return undefined;
}
