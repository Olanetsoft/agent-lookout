import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { ANTIGRAVITY_HOME_ENV, DEFAULT_HOME } from "../adapters/antigravity/index.ts";
import { CLAUDE_HOME_ENV } from "../adapters/claude-code/index.ts";
import { CODEX_HOME_ENV, CODEX_OWN_HOME_ENV } from "../adapters/codex/index.ts";
import { STATUS_DIR_ENV } from "../adapters/status-files/index.ts";
import { tildify } from "../files/paths.ts";

/** Set to `off` and nothing is written: the history is held in memory only, and goes when Agent Lookout stops. */
export const HISTORY_ENV = "AGENT_LOOKOUT_HISTORY";

/** A folder to keep the history in, in place of `~/.agent-lookout/history`. */
export const HISTORY_DIR_ENV = "AGENT_LOOKOUT_HISTORY_DIR";

/** Where the history is kept, as the environment says. */
export type HistorySetup =
  | { on: false }
  | {
      on: true;
      /** The folder, as an absolute path. */
      dir: string;
      /** The same, with the home folder written `~`, to show. */
      folder: string;
      /** Which folders the sessions are read from, as a fingerprint: `sourcesFingerprint`. */
      sources: string;
    };

/**
 * Whether the history is kept on disk, and where: `~/.agent-lookout/history`,
 * beside the folder of status files, unless `AGENT_LOOKOUT_HISTORY_DIR` names
 * another. `AGENT_LOOKOUT_HISTORY=off` keeps it in memory only.
 */
export function readHistorySetup(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
): HistorySetup {
  if (env[HISTORY_ENV]?.trim().toLowerCase() === "off") return { on: false };
  const override = env[HISTORY_DIR_ENV]?.trim() || undefined;
  const dir = path.resolve(override ?? path.join(homeDir, ".agent-lookout", "history"));
  return {
    on: true,
    dir,
    folder: tildify(dir, homeDir),
    sources: sourcesFingerprint(env, homeDir),
  };
}

/**
 * The folders the four sources read, as the adapters work them out, made into
 * a short fingerprint that names none of them. Two copies of Agent Lookout
 * with the same one see the same sessions. The writer lock carries it, so a
 * copy can say when the one writing the history watches other folders, such
 * as a dev server pointed at empty test folders.
 */
export function sourcesFingerprint(env: NodeJS.ProcessEnv, homeDir: string = os.homedir()): string {
  const set = (name: string) => env[name]?.trim() || undefined;
  const folders = [
    path.resolve(set(CLAUDE_HOME_ENV) ?? path.join(homeDir, ".claude")),
    path.resolve(set(CODEX_HOME_ENV) ?? set(CODEX_OWN_HOME_ENV) ?? path.join(homeDir, ".codex")),
    path.resolve(set(STATUS_DIR_ENV) ?? path.join(homeDir, ".agent-lookout", "sessions")),
    path.resolve(set(ANTIGRAVITY_HOME_ENV) ?? path.join(homeDir, ...DEFAULT_HOME)),
  ];
  return createHash("sha256").update(JSON.stringify(folders)).digest("hex").slice(0, 32);
}
