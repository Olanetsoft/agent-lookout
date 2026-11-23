import type { SourceCapabilities, SourceId } from "../../../core/sessions/session.ts";
import {
  createOpencodeFamilyAdapter,
  type OpencodeAdapter,
  type OpencodeAdapterOptions,
} from "../opencode/index.ts";
import { databaseFor, dataFolderFor, type OpencodeProfile } from "../opencode/profile.ts";
import { v1SessionsQuery, type V1Tools } from "../opencode/sessionRows.ts";

export {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  COMMAND_SHOWN,
  NO_SQLITE_ADVICE,
} from "../opencode/index.ts";

/**
 * The Kilo Code adapter. Kilo Code is built from OpenCode's source, and its
 * `kilo.db` keeps the tables OpenCode 1.x keeps, `session`, `message` and
 * `part`, with the same columns and the same JSON in their `data`, so this
 * adapter is OpenCode's (`../opencode/index.ts`) with a profile of Kilo
 * Code's own: its folder, its file, its variable, its programs, its tools and
 * its words. A change to those modules changes this adapter too.
 *
 * It reads no `session_v2`, which Kilo Code has none of. What a session last
 * said is asked with OpenCode's own question, unchanged, while its details
 * are open (`../opencode/lastMessages.ts`). See docs/adapters/kilo-code.md.
 * Built from Kilo Code's source at v7.8.27 (commit `03a6f07`, MIT), with the
 * last message checked at v7.8.32, and not yet checked on a computer running
 * it.
 */

export const SOURCE_ID: SourceId = "kilo-code";

const LABEL = "Kilo Code";

/** The variable that replaces Kilo Code's data folder, for Agent Lookout alone. */
export const KILO_HOME_ENV = "AGENT_LOOKOUT_KILO_HOME";

/** Kilo Code's own variable for its database: a path, one in its data folder, or `:memory:`. */
export const KILO_DB_ENV = "KILO_DB";

/** The file Kilo Code keeps its sessions in, in its data folder, for a release (`packages/core/src/database/database.ts`). */
export const KILO_DATABASE_FILE = "kilo.db";

/**
 * The names of Kilo Code's program, as `ps -A -o comm=` prints them:
 *
 * kilo           what the install script, Homebrew, the release archive, the
 *                editor extensions and Nix start
 * .kilo          the copy npm's launcher, `bin/kilo`, keeps beside itself and starts
 * .kilo-wrapped  the program Nix's wrapper starts
 *
 * `kilocode`, npm's second link, is the Node launcher, which `ps` shows as
 * `node`, so it is not one.
 */
export const KILO_PROGRAMS: ReadonlySet<string> = new Set(["kilo", ".kilo", ".kilo-wrapped"]);

/**
 * Kilo Code's tools that the 1.x question treats apart. Only `question` waits
 * for the person in the database: Kilo Code's `plan_exit` asks nothing, and
 * the plan's approval comes after it, held in memory. `suggest` waits inside
 * its call while Kilo Code shows the session as idle.
 */
export const KILO_TOOLS: V1Tools = { asking: ["question"], idle: ["suggest"] };

/** The question of the sessions Kilo Code's database is asked. */
export const KILO_SESSIONS_QUERY = v1SessionsQuery(KILO_TOOLS);

/** Said whenever Kilo Code is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "A Kilo Code session shows as needing you while Kilo Code asks you a question. Kilo Code does not record a wait for a tool's approval or a plan's, so a session waiting for a tool's shows as working, and one waiting for a plan's as idle.";

/** Said whenever Kilo Code is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Kilo Code's source at v7.8.27 and not yet checked on a computer running Kilo Code, so a status can be wrong.";

/** Said when a session's newest message is one this adapter does not know. */
export const UNKNOWN_MESSAGE_NOTE =
  "Some sessions end in a way Agent Lookout does not know, perhaps from a newer Kilo Code, so they show as unknown.";

/** What Sources says of the last-message read while it is on. */
export const LAST_MESSAGE_READ =
  "a Kilo Code session's newest reply, with sqlite3, while its details are open";

/** Said on Windows, where nothing of Kilo Code's is read. */
export const WINDOWS_DETAIL =
  "Agent Lookout does not read Kilo Code's sessions on Windows: they are read with sqlite3, which it does not run there.";

/** Added when Kilo Code's folder has no `kilo.db`: a pre-release or a build from source writes another file. */
export const NO_DATABASE_NOTE =
  "A pre-release or a build from source keeps its sessions in another file, such as kilo-rc.db or kilo-local.db, which is read only when KILO_DB names it.";

/**
 * What a Kilo Code session can show, from the database this adapter reads
 * with `sqlite3`, as OpenCode's does. See docs/adapters/kilo-code.md for each.
 *
 * - Working and idle are the newest message of each root session of
 *   `session`, on macOS and Linux only. A session whose one call not yet over
 *   is a `suggest` is idle, as Kilo Code shows it.
 * - Needs you is a `question` tool part of the newest message in the state
 *   `running`, unless it is older than the last `ps` that showed no Kilo Code.
 *   A wait for a tool's approval, and a plan's approval, are in memory.
 * - Finished is every session while `ps` shows no Kilo Code program.
 * - Failed is a reply that ends on an error Kilo Code records.
 * - The name is Kilo Code's title, or the folder's name while the title is a
 *   placeholder.
 * - No Jump, Stop or Answer: the database names no process or terminal.
 * - No Quiet for: every session is in one file.
 * - Tokens are the counts of the newest reply that ended with some.
 */
export const KILO_CODE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Read with sqlite3 on macOS and Linux. Agent Lookout reads nothing of Kilo Code's on Windows.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "While Kilo Code asks you a question. Tool approvals show as working, and a plan's approval as idle.",
  },
  finished: {
    level: "partly",
    reason:
      "Once ps shows no Kilo Code program, on macOS and Linux. Its editor server and daemon keep every session open while they run.",
  },
  failed: {
    level: "partly",
    reason:
      "When a reply ends on an error Kilo Code records. One that fails before its first step shows as working.",
  },
  names: { level: "yes" },
  jump: {
    level: "no",
    reason:
      "Kilo Code's database names no process or terminal, and Kilo Code documents no link to a session.",
  },
  "quiet-for": {
    level: "no",
    reason:
      "Kilo Code keeps every session in one database, so no file shows when one session was last written.",
  },
  tokens: { level: "yes" },
  stop: {
    level: "no",
    reason: "Kilo Code's database names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason:
      "Agent Lookout makes no request to Kilo Code's server, and Kilo Code keeps a wait for a tool's approval in memory.",
  },
};

/** Kilo Code's profile, for the shared body of the OpenCode adapter. */
export const KILO_CODE_PROFILE: OpencodeProfile = {
  sourceId: SOURCE_ID,
  label: LABEL,
  homeEnv: KILO_HOME_ENV,
  dbEnv: KILO_DB_ENV,
  folder: "kilo",
  databaseFile: KILO_DATABASE_FILE,
  programs: KILO_PROGRAMS,
  readsV2: false,
  tools: KILO_TOOLS,
  capabilities: KILO_CODE_CAPABILITIES,
  notes: {
    needsYou: NEEDS_YOU_NOTE,
    unchecked: UNCHECKED_NOTE,
    unknownMessage: UNKNOWN_MESSAGE_NOTE,
    windows: WINDOWS_DETAIL,
    noDatabase: NO_DATABASE_NOTE,
  },
  lastMessageRead: LAST_MESSAGE_READ,
};

/**
 * Kilo Code's data folder: the one `AGENT_LOOKOUT_KILO_HOME` names, else
 * `kilo` in `XDG_DATA_HOME` when that is an absolute path, else
 * `~/.local/share/kilo`, on macOS as on Linux (`packages/core/src/global.ts`).
 */
export function kiloHomeFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  return dataFolderFor(KILO_CODE_PROFILE, env, homeDir);
}

/**
 * The database the adapter reads, or null when Kilo Code keeps its sessions
 * in memory. With `AGENT_LOOKOUT_KILO_HOME`, `kilo.db` in that folder.
 * Otherwise Kilo Code's own `KILO_DB`, as Kilo Code takes it: `:memory:`, an
 * absolute path as it is, or a path in the data folder. Without it, or with it
 * empty, `kilo.db` in the data folder. A pre-release's `kilo-rc.db`, a build
 * from source's `kilo-<branch>.db` or `kilo-local.db`, and an older
 * `opencode-<channel>.db` in Kilo Code's folder are not read unless `KILO_DB`
 * names one.
 */
export function kiloDatabaseFor(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  return databaseFor(KILO_CODE_PROFILE, env, homeDir);
}

/** Everything the adapter touches outside itself. Tests replace these. */
export type KiloCodeAdapterOptions = OpencodeAdapterOptions;

/**
 * Finds Kilo Code's sessions on this machine from the database Kilo Code
 * keeps, as the OpenCode adapter finds OpenCode's, with nothing installed, no
 * setting changed, no program of Kilo Code's run and no request made to its
 * server: the status comes from the rows of `message` and `part`.
 *
 * What a session last said is asked of the database with one more fixed
 * question, OpenCode's, only while a page has the session's details open,
 * and never by a poll. `AGENT_LOOKOUT_LAST_MESSAGE=off` or
 * `AGENT_LOOKOUT_WAITING_TEXT=off` stops it.
 *
 * Kilo Code not being installed costs nothing: when its data folder is
 * missing, the adapter says so and looks again only once a minute, with a
 * single `stat`, and runs neither `sqlite3` nor `ps`. Nothing is read on
 * Windows.
 */
export function createKiloCodeAdapter(options: KiloCodeAdapterOptions = {}): OpencodeAdapter {
  // Kilo Code's profile reads last messages, so the adapter has its `lastMessage`.
  return createOpencodeFamilyAdapter(KILO_CODE_PROFILE, options) as OpencodeAdapter;
}
