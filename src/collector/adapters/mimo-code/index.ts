import type { SourceCapabilities, SourceId } from "../../../core/sessions/session.ts";
import {
  createOpencodeFamilyAdapter,
  type OpencodeAdapter,
  type OpencodeAdapterOptions,
} from "../opencode/index.ts";
import { databaseFor, dataFolderFor, type OpencodeProfile } from "../opencode/profile.ts";
import { v1SessionsQuery, type V1Extras, type V1Tools } from "../opencode/sessionRows.ts";

export {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  COMMAND_SHOWN,
  NO_SQLITE_ADVICE,
} from "../opencode/index.ts";

/**
 * The MiMo Code adapter. MiMo Code is Xiaomi's agent built from OpenCode's
 * source, and its `mimocode.db` keeps the tables OpenCode 1.x keeps,
 * `session`, `message` and `part`, with the same JSON in their `data`, so
 * this adapter is OpenCode's (`../opencode/index.ts`) with a profile of MiMo
 * Code's own: its folders, its file, its variables, its program, its tools,
 * its error names and its words. A change to those modules changes this
 * adapter too.
 *
 * Its database differs from OpenCode's in three ways the profile's
 * `V1Extras` ask about. Its subagents work in the session itself, so their
 * messages sit beside the main agent's, told apart by `message.agent_id`,
 * and only the main agent's say how the session stands. Each actor of a
 * session has a row of `actor_registry`, the main agent's too, and while a
 * subagent's is `pending` or `running` the session is working. And a
 * session's title is the first line of the person's prompt until a model
 * names it, and a fork's is copied from the session it came from, so a title
 * is read only when MiMo Code marks it `generated`, or `user` once the person
 * renamed the session.
 *
 * It reads no `session_v2`. What a session last said, the main agent's
 * newest reply, is asked with OpenCode's question while its details are open
 * (`../opencode/lastMessages.ts`). See docs/adapters/mimo-code.md.
 * Built from MiMo Code's source at v0.1.17 (MIT), and not yet checked on a
 * computer running it.
 */

export const SOURCE_ID: SourceId = "mimo-code";

const LABEL = "MiMo Code";

/** The variable that replaces MiMo Code's data folder, for Agent Lookout alone. */
export const MIMO_CODE_HOME_ENV = "AGENT_LOOKOUT_MIMO_CODE_HOME";

/** MiMo Code's own variable for its home, whose `data` folder is its data folder (`packages/shared/src/global.ts`). */
export const MIMOCODE_HOME_ENV = "MIMOCODE_HOME";

/** MiMo Code's own variable for its database: a path, one in its data folder, or `:memory:`. */
export const MIMOCODE_DB_ENV = "MIMOCODE_DB";

/** The file MiMo Code keeps its sessions in, in its data folder (`packages/cli/src/storage/db.ts`). */
export const MIMO_DATABASE_FILE = "mimocode.db";

/**
 * The names of MiMo Code's program, as `ps -A -o comm=` prints them: `mimo`,
 * which the install script puts in `~/.mimocode/bin`, and which npm's
 * launcher, a Node script that `ps` shows as `node`, starts from its
 * `vendor` folder and waits for.
 */
export const MIMO_PROGRAMS: ReadonlySet<string> = new Set(["mimo"]);

/**
 * MiMo Code's tools that ask the person and wait inside their call, as
 * OpenCode's do: `question`, and `plan_exit`, which asks through the same
 * question. No call of its leaves a session idle.
 */
export const MIMO_TOOLS: V1Tools = { asking: ["question", "plan_exit"], idle: [] };

/**
 * What MiMo Code's layout has beyond OpenCode 1.x's: the main agent's
 * messages are those with `agent_id` `main`, its subagents are in
 * `actor_registry`, and a title is read only when a model wrote it, or once
 * the person renamed the session. MiMo Code marks `user` a fork's copied
 * title and a title passed when a session is made too, at `title_revision` 0,
 * and a rename moves the revision above 0 (`writeTitle` in `session.ts`).
 */
export const MIMO_EXTRAS: V1Extras = {
  mainAgent: "main",
  actors: true,
  titleSources: ["generated"],
  renamedSources: ["user"],
};

/**
 * The errors MiMo Code v0.1.17 records on a reply, besides
 * `MessageAbortedError`, each of which ends it as failed: OpenCode's seven and
 * four of its own (`Assistant` in `packages/cli/src/session/message-v2.ts`).
 */
export const MIMO_FAILED_ERRORS: readonly string[] = [
  "ProviderAuthError",
  "UnknownError",
  "MessageOutputLengthError",
  "StructuredOutputError",
  "ContextOverflowError",
  "InvalidOutputError",
  "StreamIncompleteError",
  "TextToolCallError",
  "ContentFilterError",
  "ModelError",
  "APIError",
];

/** The question of the sessions MiMo Code's database is asked. */
export const MIMO_SESSIONS_QUERY = v1SessionsQuery(MIMO_TOOLS, MIMO_EXTRAS);

/** Said whenever MiMo Code is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "A MiMo Code session shows as needing you while MiMo Code asks you a question or to approve a plan. MiMo Code does not record a wait for a tool's approval, so a session waiting for one shows as working, as does one whose subagent asks you something.";

/** Said whenever MiMo Code is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from MiMo Code's source at v0.1.17 and not yet checked on a computer running MiMo Code, so a status can be wrong.";

/** Said when a session's newest message is one this adapter does not know. */
export const UNKNOWN_MESSAGE_NOTE =
  "Some sessions end in a way Agent Lookout does not know, perhaps from a newer MiMo Code, so they show as unknown.";

/** What Sources says of the last-message read while it is on. */
export const LAST_MESSAGE_READ =
  "a MiMo Code session's newest reply, with sqlite3, while its details are open";

/** Said on Windows, where nothing of MiMo Code's is read. */
export const WINDOWS_DETAIL =
  "Agent Lookout does not read MiMo Code's sessions on Windows: they are read with sqlite3, which it does not run there.";

/**
 * What a MiMo Code session can show, from the database this adapter reads
 * with `sqlite3`, as OpenCode's does. See docs/adapters/mimo-code.md for each.
 *
 * - Working and idle are the newest message of the main agent of each root
 *   session of `session`, on macOS and Linux only. A session with a subagent
 *   `pending` or `running` in `actor_registry` is working. The main agent's
 *   own row stays `pending`, and is not counted.
 * - Needs you is a `question` or `plan_exit` tool part of that message in the
 *   state `running`, unless it is older than the last `ps` that showed no
 *   MiMo Code. A wait for a tool's approval is in memory, and a subagent's
 *   question is not read.
 * - Finished is every session while `ps` shows no `mimo`.
 * - Failed is a reply that ends on an error MiMo Code records.
 * - The name is a title a model wrote or the person renamed the session to,
 *   else the folder's. MiMo Code's first title, the first line of the
 *   prompt, a fork's copied title and a title passed when a session is made
 *   are not read.
 * - No Jump, Stop or Answer: the database names no process or terminal.
 * - No Quiet for: every session is in one file.
 * - Tokens are the counts of the main agent's newest reply that ended with
 *   some.
 */
export const MIMO_CODE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Read with sqlite3 on macOS and Linux. Agent Lookout reads nothing of MiMo Code's on Windows.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "While MiMo Code asks you a question or to approve a plan. Tool approvals, and a subagent's questions, show as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once ps shows no MiMo Code program, on macOS and Linux. Any program named mimo keeps every session open.",
  },
  failed: {
    level: "partly",
    reason:
      "When a reply ends on an error MiMo Code records. One that fails before its first step shows as working.",
  },
  names: {
    level: "partly",
    reason:
      "A model's title or your rename, else the folder's. MiMo Code's first title is the first line of your prompt, never read.",
  },
  jump: {
    level: "no",
    reason: "MiMo Code's database names no process or terminal.",
  },
  "quiet-for": {
    level: "no",
    reason:
      "MiMo Code keeps every session in one database, so no file shows when one session was last written.",
  },
  tokens: { level: "yes" },
  stop: {
    level: "no",
    reason: "MiMo Code's database names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason:
      "Agent Lookout makes no request to MiMo Code's server, and MiMo Code keeps a wait for a tool's approval in memory.",
  },
};

/** MiMo Code's profile, for the shared body of the OpenCode adapter. */
export const MIMO_CODE_PROFILE: OpencodeProfile = {
  sourceId: SOURCE_ID,
  label: LABEL,
  homeEnv: MIMO_CODE_HOME_ENV,
  dbEnv: MIMOCODE_DB_ENV,
  ownHome: { env: MIMOCODE_HOME_ENV, folder: "data" },
  folder: "mimocode",
  databaseFile: MIMO_DATABASE_FILE,
  programs: MIMO_PROGRAMS,
  readsV2: false,
  tools: MIMO_TOOLS,
  v1Extras: MIMO_EXTRAS,
  failedErrors: MIMO_FAILED_ERRORS,
  capabilities: MIMO_CODE_CAPABILITIES,
  notes: {
    needsYou: NEEDS_YOU_NOTE,
    unchecked: UNCHECKED_NOTE,
    unknownMessage: UNKNOWN_MESSAGE_NOTE,
    windows: WINDOWS_DETAIL,
  },
  lastMessageRead: LAST_MESSAGE_READ,
};

/**
 * MiMo Code's data folder: the one `AGENT_LOOKOUT_MIMO_CODE_HOME` names, else
 * `data` in `MIMOCODE_HOME` when that is an absolute path, else `mimocode` in
 * `XDG_DATA_HOME` when that is an absolute path, else `~/.local/share/mimocode`,
 * on macOS as on Linux (`resolveMimocodeHome` in `packages/shared/src/global.ts`).
 * MiMo Code refuses a `MIMOCODE_HOME` that is not absolute, so such a one is
 * passed over.
 */
export function mimoCodeHomeFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  return dataFolderFor(MIMO_CODE_PROFILE, env, homeDir);
}

/**
 * The database the adapter reads, or null when MiMo Code keeps its sessions
 * in memory. With `AGENT_LOOKOUT_MIMO_CODE_HOME`, `mimocode.db` in that
 * folder. Otherwise MiMo Code's own `MIMOCODE_DB`, as MiMo Code takes it:
 * `:memory:`, an absolute path as it is, or a path in the data folder.
 * Without it, or with it empty, `mimocode.db` in the data folder, which every
 * build of MiMo Code writes unless `MIMOCODE_DISABLE_CHANNEL_DB` is `false` or
 * `0`. A `mimocode-<channel>.db` is not read unless `MIMOCODE_DB` names it.
 */
export function mimoCodeDatabaseFor(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  return databaseFor(MIMO_CODE_PROFILE, env, homeDir);
}

/** Everything the adapter touches outside itself. Tests replace these. */
export type MimoCodeAdapterOptions = OpencodeAdapterOptions;

/**
 * Finds MiMo Code's sessions on this machine from the database MiMo Code
 * keeps, as the OpenCode adapter finds OpenCode's, with nothing installed, no
 * setting changed, no program of MiMo Code's run and no request made to its
 * server: the status comes from the rows of `message`, `part` and
 * `actor_registry`.
 *
 * What a session last said, the main agent's newest reply, is asked of the
 * database with one more fixed question, OpenCode's, only while a page has
 * the session's details open, and never by a poll.
 * `AGENT_LOOKOUT_LAST_MESSAGE=off` or `AGENT_LOOKOUT_WAITING_TEXT=off` stops
 * it.
 *
 * MiMo Code not being installed costs nothing: when its data folder is
 * missing, the adapter says so and looks again only once a minute, with a
 * single `stat`, and runs neither `sqlite3` nor `ps`. Nothing is read on
 * Windows.
 */
export function createMimoCodeAdapter(options: MimoCodeAdapterOptions = {}): OpencodeAdapter {
  // MiMo Code's profile reads last messages, so the adapter has its `lastMessage`.
  return createOpencodeFamilyAdapter(MIMO_CODE_PROFILE, options) as OpencodeAdapter;
}
