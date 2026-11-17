import os from "node:os";
import path from "node:path";

import type { FileInfo } from "../../files/readOnlyIo.ts";

/**
 * Where Autohand Code keeps its files, and which of them this adapter is
 * willing to read. Built from Autohand Code's source at v0.9.11 and not yet
 * checked on a computer running it.
 */

/** The variable that names Autohand Code's folder, for Agent Lookout alone. */
export const AUTOHAND_HOME_ENV = "AGENT_LOOKOUT_AUTOHAND_HOME";

/** Autohand Code's own variable for its folder. */
export const AUTOHAND_OWN_HOME_ENV = "AUTOHAND_HOME";

/** Where the folder this adapter reads was named. */
export type HomeFrom = "agent-lookout" | "autohand" | "default";

/** A setting's value, trimmed. Empty is none. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/**
 * Whether a folder is the Windows folder or one in it, which Autohand Code
 * does not take as its own on Windows (`src/constants.ts:17-20`, `:43`): a
 * service's folder can be reported as the home folder.
 */
function inWindowsFolder(value: string): boolean {
  const written = path.win32.normalize(value).replaceAll("/", "\\").toLowerCase();
  const rest = /^[a-z]:/.test(written) ? written.slice(2) : written;
  return rest === "\\windows" || rest.startsWith("\\windows\\");
}

/**
 * The folder this adapter reads, and where it was named:
 *
 * 1. the folder `AGENT_LOOKOUT_AUTOHAND_HOME` names, for Agent Lookout alone;
 * 2. else the one `AUTOHAND_HOME` names, as Autohand Code takes it
 *    (`src/constants.ts:36-66`), when it is a whole path, and on Windows not
 *    the Windows folder or one in it. A relative one is passed over: Autohand
 *    Code reads it from the folder it was started in, which is not known here.
 *    Like Autohand Code, `~` is not taken as the home folder;
 * 3. else `.autohand` in the home folder, `%USERPROFILE%\.autohand` on Windows.
 *
 * Autohand Code's own other places on Windows, used when `USERPROFILE` is not
 * set or is a system folder, are not followed. Nor is the folder its settings
 * can move its heartbeats to, since its settings are never read.
 */
export function autohandHomeOf(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): { home: string; from: HomeFrom } {
  const own = setting(env, AUTOHAND_HOME_ENV);
  if (own !== undefined) return { home: path.resolve(own), from: "agent-lookout" };
  const theirs = setting(env, AUTOHAND_OWN_HOME_ENV);
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (
    theirs !== undefined &&
    paths.isAbsolute(theirs) &&
    (platform !== "win32" || !inWindowsFolder(theirs))
  ) {
    return { home: path.resolve(theirs), from: "autohand" };
  }
  return { home: path.join(homeDir, ".autohand"), from: "default" };
}

/** The folder this adapter reads: see `autohandHomeOf`. */
export function autohandHomeFor(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return autohandHomeOf(env, homeDir, platform).home;
}

/** The folder of heartbeats, `active-agents` (`src/constants.ts:88`). */
export const heartbeatsDirOf = (home: string) => path.join(home, "active-agents");

/** The folder of sessions, `sessions` (`src/constants.ts:83`). */
export const sessionsDirOf = (home: string) => path.join(home, "sessions");

/** A session's `metadata.json` (`src/session/SessionManager.ts:688-693`). */
export const metadataPathOf = (sessionsDir: string, sessionId: string) =>
  path.join(sessionsDir, sessionId, "metadata.json");

/**
 * A heartbeat's name that could be one: it ends `.json` and does not begin
 * with a dot, so a temporary file `.<name>.<pid>.<uuid>.tmp`, a removed file
 * `.<name>.<pid>.<uuid>.tombstone` (`src/utils/atomicFile.ts:541-545`,
 * `:577-580`) and a lock folder `<name>.json.lock`
 * (`src/session/ActiveAgentRegistry.ts:89`) are passed over.
 */
const HEARTBEAT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,250}\.json$/;

/** An instance's ID in a heartbeat's name (`src/session/ActiveAgentRegistry.ts:171-175`). */
const INSTANCE_ID = /^[A-Za-z0-9-]{1,128}$/;

/**
 * A session's folder: a letter or digit first, then letters, digits, `_` and
 * `-`, with no dot. Autohand Code names one `<uuid>-<milliseconds>`
 * (`src/session/SessionManager.ts:431-435`). The dot leaves out `index.json`,
 * its lock, its temporary files and its copies, and a transfer's temporary
 * folder `<id>.import-<random>`.
 */
const SESSION_FOLDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export function isHeartbeatName(name: string): boolean {
  return HEARTBEAT_NAME.test(name);
}

export function isSessionFolderName(name: string): boolean {
  return SESSION_FOLDER.test(name);
}

/** Whether a heartbeat's name is its own session's: `<id>.json`, or `<id>.<instance>.json`. */
export function nameIsSessions(name: string, sessionId: string): boolean {
  if (name === `${sessionId}.json`) return true;
  const prefix = `${sessionId}.`;
  if (!name.startsWith(prefix) || !name.endsWith(".json")) return false;
  return INSTANCE_ID.test(name.slice(prefix.length, -".json".length));
}

/** What a file or folder must be for this adapter to read it, as Autohand Code requires of `active-agents` and a heartbeat. */
export type Trusted = "heartbeats-folder" | "heartbeat" | "session-folder" | "metadata";

/**
 * Whether a thing is one this adapter reads, from its `lstat` or its open
 * file's, as Autohand Code itself reads its heartbeats
 * (`src/session/ActiveAgentRegistry.ts:138-152`):
 *
 * - never a link, and a folder or an ordinary file as it should be;
 * - a heartbeat or a `metadata.json` with no second name;
 * - on macOS and Linux, only one that belongs to the user Agent Lookout runs
 *   as, and a heartbeat only when no one else may read or write it. A
 *   `metadata.json` is not held to that, since one Autohand Code imports is
 *   written readable by others and keeps that.
 *
 * Without the owner and the permission bits, on macOS and Linux, nothing is
 * read.
 */
export function isTrusted(
  info: FileInfo,
  what: Trusted,
  platform: NodeJS.Platform,
  euid: number | null,
): boolean {
  const folder = what === "heartbeats-folder" || what === "session-folder";
  if (info.kind !== (folder ? "directory" : "file")) return false;
  if (!folder && info.nlink !== 1) return false;
  if (platform === "win32") return true;
  if (euid === null || info.uid !== euid) return false;
  if (what !== "heartbeat") return true;
  return info.mode !== undefined && (info.mode & 0o077) === 0;
}

/** The user this runs as, on macOS and Linux, or null where there is none. */
export function effectiveUser(): number | null {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}
