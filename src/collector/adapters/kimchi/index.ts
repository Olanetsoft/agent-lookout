import type { SourceCapabilities, SourceId } from "../../../core/sessions/session.ts";
import type { Adapter } from "../adapter.ts";
import { createPiFamilyAdapter, type PiAdapterOptions } from "../pi/index.ts";
import { sessionsDirFor, type PiProfile } from "../pi/profile.ts";

export {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
} from "../pi/index.ts";

/**
 * The Kimchi adapter. Kimchi is CAST AI's coding agent built on Pi's coding
 * agent, `@earendil-works/pi-coding-agent` 1.3.0 at Kimchi v1.35.0, and its
 * session files are Pi's, in a folder of its own, so this adapter is Pi's
 * (`../pi/index.ts`) with a profile of Kimchi's own: its folder, its
 * variables, its program, its markers and its words. A change to those
 * modules changes this adapter too.
 *
 * It differs from Pi's in two ways. Kimchi names every session itself from
 * the person's first messages (`src/extensions/session-name.ts`), so no
 * `session_info` line is read, and a session takes its folder's name. And
 * Kimchi writes the sessions of its subagents, and before 1.40.0 of its
 * Ferment evaluator, beside the person's, each marked on its second line, so
 * those are left out. A session is never left out for naming a parent: a
 * branch the person makes names one too.
 *
 * See docs/adapters/kimchi.md. Built from Kimchi's source at v1.35.0
 * (Apache-2.0) and Pi's at v1.3.0 (MIT), and not yet checked on a computer
 * running Kimchi.
 */

export const SOURCE_ID: SourceId = "kimchi";

/** The variable that names Kimchi's agent folder, for Agent Lookout alone. */
export const KIMCHI_HOME_ENV = "AGENT_LOOKOUT_KIMCHI_HOME";

/**
 * Kimchi's own variable for its sessions folder: Pi's `ENV_SESSION_DIR`, made
 * from the name in Kimchi's `piConfig` (`config.ts:586` in Pi).
 */
export const KIMCHI_SESSIONS_ENV = "KIMCHI_CODING_AGENT_SESSION_DIR";

/**
 * Kimchi's agent folder, in the home folder. `src/entry.ts` sets it in
 * `KIMCHI_CODING_AGENT_DIR` and `PI_CODING_AGENT_DIR` as Kimchi starts, over
 * anything the person set, so no variable moves it.
 */
export const KIMCHI_AGENT_DIR = [".config", "kimchi", "harness"] as const;

/**
 * The names of Kimchi's program, as `ps -A -o comm=` prints them: `kimchi`,
 * the binary Kimchi's releases ship for macOS and Linux, and the title
 * `src/entry.ts` gives the process as it starts.
 */
export const KIMCHI_PROGRAMS: ReadonlySet<string> = new Set(["kimchi"]);

/** The marker on a subagent's second line (`src/session-visibility.ts`). */
export const SUBAGENT_SESSION_ENTRY = "kimchi:subagent-session";

/** The marker on the second line of a session Kimchi runs for itself, such as Ferment's evaluator. */
export const INTERNAL_SESSION_ENTRY = "kimchi:internal-session";

/** Said whenever Kimchi is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "Nothing Agent Lookout reads says whether a Kimchi session is working or waiting for you, and nothing ties a session to a process, so a session shows as unknown while a kimchi program runs and as finished once none does.";

/** Said whenever Kimchi is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Kimchi's source at v1.35.0 and not yet checked on a computer running Kimchi, so a status can be wrong.";

/** Said when a file is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "A Kimchi newer than this Agent Lookout wrote a session in a format it does not read, so that session is not shown.";

/**
 * What a Kimchi session can show, from the files this adapter reads. See
 * docs/adapters/kimchi.md for each. Built from Kimchi's source at v1.35.0
 * and not yet checked on a computer running it.
 *
 * - No Working and idle: nothing ties a session to a process, so a turn a
 *   crash cut off cannot be told from one under way.
 * - No Needs you: Kimchi keeps its approvals and questions in memory.
 * - Finished is every session while `ps` shows no `kimchi` program, on macOS
 *   and Linux.
 * - No Failed: a failed turn is written inside a message, which is not parsed.
 * - The name is the folder's. Kimchi's own is made from the person's words.
 * - No Jump, Stop or Answer: a session's file names no process or terminal.
 * - No Quiet for: a Kimchi session is never shown as working.
 * - No Tokens: a reply's counts are on the line with its text.
 */
export const KIMCHI_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "no",
    reason:
      "Nothing ties a Kimchi session to a process, so a turn a crash cut off looks like one under way.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Kimchi keeps its approvals and questions in memory, and writes nothing while it waits.",
  },
  finished: {
    level: "partly",
    reason: "Every session at once, when ps shows no kimchi program, on macOS and Linux.",
  },
  failed: {
    level: "no",
    reason: "Kimchi writes a failed turn inside a message, which is not parsed.",
  },
  names: {
    level: "partly",
    reason: "The folder's. Kimchi names a session from your first messages, which is never read.",
  },
  jump: { level: "no", reason: "A Kimchi session's file names no process or terminal." },
  "quiet-for": {
    level: "no",
    reason: "It is shown for a working session, and a Kimchi session never shows as working.",
  },
  tokens: {
    level: "no",
    reason: "A reply's counts are on the line with its text, which is not parsed.",
  },
  stop: {
    level: "no",
    reason: "A Kimchi session's file names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Kimchi, so it cannot send an answer.",
  },
};

/** Kimchi's profile, for the shared body of the Pi adapter. */
export const KIMCHI_PROFILE: PiProfile = {
  sourceId: SOURCE_ID,
  label: "Kimchi",
  program: "kimchi",
  programs: KIMCHI_PROGRAMS,
  homeEnv: KIMCHI_HOME_ENV,
  sessionsEnv: KIMCHI_SESSIONS_ENV,
  agentDir: KIMCHI_AGENT_DIR,
  readsNames: false,
  hiddenMarkers: [SUBAGENT_SESSION_ENTRY, INTERNAL_SESSION_ENTRY],
  capabilities: KIMCHI_CAPABILITIES,
  notes: { status: STATUS_NOTE, unchecked: UNCHECKED_NOTE, newerFormat: NEWER_FORMAT_NOTE },
};

/**
 * The folder this adapter reads: `sessions` in the folder
 * `AGENT_LOOKOUT_KIMCHI_HOME` names, for Agent Lookout alone, else the folder
 * `KIMCHI_CODING_AGENT_SESSION_DIR` names, else
 * `~/.config/kimchi/harness/sessions`, on every system. `~` at its start is
 * the home folder, as Pi takes it, and a relative one is passed over. Neither
 * `--session-dir` nor the `sessionDir` setting is followed.
 */
export function kimchiSessionsDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  return sessionsDirFor(KIMCHI_PROFILE, env, homeDir);
}

/** Everything the adapter touches outside itself. Tests replace these. */
export type KimchiAdapterOptions = PiAdapterOptions;

/**
 * Finds Kimchi's sessions on this machine from the files Kimchi keeps, as the
 * Pi adapter finds Pi's, with nothing installed, no setting changed and no
 * program of Kimchi's run. Of each file written in the last day it reads the
 * first line and compares the second, as bytes, with Kimchi's markers, once,
 * from its first 64 KiB. While there are sessions to show, it asks `ps`
 * whether a `kimchi` program runs. A session shows as unknown while one does,
 * or while `ps` cannot say, as on Windows, and as finished once none does.
 *
 * Kimchi not being installed costs nothing: when the sessions folder is
 * missing, the adapter says so and looks again only once a minute, and runs
 * nothing.
 */
export function createKimchiAdapter(options: KimchiAdapterOptions = {}): Adapter {
  return createPiFamilyAdapter(KIMCHI_PROFILE, options);
}
