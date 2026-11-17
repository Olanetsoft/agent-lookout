import path from "node:path";

import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isReachedByRealFolders } from "../kimi-code/paths.ts";

/**
 * Where fx keeps its sessions, and which of its folders are looked at. Built
 * from fx's source at v0.0.17 and not yet checked on a computer running it.
 *
 * fx keeps its files in `~/.fx`, or the folder `FX_HOME` names, and each
 * session in its own folder in `sessions/v2` there (`profile_paths.zig`,
 * `session_layout.zig`). It refuses to keep sessions in a `.fx`, `sessions`
 * or `v2` that is a link or not a folder (`checkSessionsPath` in
 * `session_adapter.zig`), so Agent Lookout reads nothing through one either.
 */

/** The variable that names fx's folder, for Agent Lookout alone. */
export const FX_HOME_ENV = "AGENT_LOOKOUT_FX_HOME";

/** fx's own variable for its folder, which moves `~/.fx` (`useFxHome` in `profile_paths.zig`). */
export const FX_OWN_HOME_ENV = "FX_HOME";

/** fx's folder in the home folder, when nothing names another. */
export const FX_DIR = ".fx";

/** The folders from fx's own down to the one that holds a folder for each session. */
export const SESSIONS_FOLDERS = ["sessions", "v2"] as const;

/** Where a session's log is, in its folder. */
export const LOG_FILE = "log.jsonl";

/** fx's folder, as Agent Lookout works it out, and from what. */
export type FxFolder =
  /** Named by `AGENT_LOOKOUT_FX_HOME`. */
  | { from: "agent-lookout"; folder: string }
  /** Named by `FX_HOME`, or `~/.fx`. */
  | { from: "fx"; folder: string }
  /** `FX_HOME` names it through a `.` or `..`, which is not followed. */
  | { from: "dotted"; folder: string };

/**
 * fx's folder: the one `AGENT_LOOKOUT_FX_HOME` names, for Agent Lookout alone,
 * else the one `FX_HOME` names, as fx takes it, else `~/.fx`.
 *
 * fx takes `FX_HOME` as it is given, with any `/` at its end left off
 * (`useFxHome` in `profile_paths.zig`, `useFxHomeFromEnv` in `main.zig`). An
 * empty one is not set. One that is not absolute, is `/`, or is the home
 * folder in `HOME`, makes fx stop before it writes anything, so `~/.fx` is
 * read then. `~` is not taken for the home folder. fx opens the folder that
 * holds its own and then its own by name, so the system follows a link before
 * a `..` in it, as a path made by Node would not: one with a `.` or `..` in
 * it is read not at all.
 */
export function fxFolderFor(env: NodeJS.ProcessEnv, homeDir: string): FxFolder {
  const own = env[FX_HOME_ENV]?.trim();
  if (own) return { from: "agent-lookout", folder: path.resolve(own) };
  const value = env[FX_OWN_HOME_ENV];
  if (value && path.posix.isAbsolute(value)) {
    const trimmed = value.replace(/\/+$/, "");
    const home = env.HOME;
    const isHome = home !== undefined && trimmed === home.replace(/\/+$/, "");
    if (trimmed !== "" && !isHome) {
      if (trimmed.split("/").some((part) => part === "." || part === "..")) {
        return { from: "dotted", folder: trimmed };
      }
      return { from: "fx", folder: path.join(trimmed) };
    }
  }
  return { from: "fx", folder: path.join(homeDir, FX_DIR) };
}

/** The folder of session folders in fx's folder. */
export function sessionsDirOf(folder: string): string {
  return path.join(folder, ...SESSIONS_FOLDERS);
}

/**
 * The folder of session folders, `v2`, when fx's own folder, `sessions` and
 * `v2` are each a real folder, and "not-real" when one is a link or not a
 * folder. Rejects, with the error's `code`, when one cannot be looked at, as
 * for one that is not there.
 */
export async function sessionsFolder(
  folder: string,
  io: Pick<ReadOnlyIo, "lstat">,
): Promise<FileInfo | "not-real"> {
  const parents = [path.basename(folder), SESSIONS_FOLDERS[0]];
  if (!(await isReachedByRealFolders(path.dirname(folder), parents, io))) return "not-real";
  const info = await io.lstat(sessionsDirOf(folder));
  return info.kind === "directory" ? info : "not-real";
}
