import os from "node:os";

import type { SourceCapabilities, SourceId } from "../../../core/sessions/session.ts";
import { nodeIo } from "../../files/readOnlyIo.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import { runPs } from "../../processes/ps.ts";
import type { ReadProcFile } from "../../processes/linuxProcesses.ts";
import type { Adapter } from "../adapter.ts";
import { createPiFamilyAdapter, type PiAdapterOptions } from "../pi/index.ts";
import { agentDirFor, sessionsDirFor, type PiProfile } from "../pi/profile.ts";
import { PRIME_AGENT_PROGRAMS, type RunPsWith } from "./holders.ts";
import { createPrimeAgentStatus } from "./status.ts";

export { RECHECK_MS } from "../pi/index.ts";
export { PRIME_AGENT_PROGRAMS } from "./holders.ts";
export { BASIS, BASIS_WITHOUT_LEASES, BASIS_WITHOUT_PROCESSES, WINDOWS_NOTE } from "./status.ts";

/**
 * The Prime Agent adapter. Prime Agent is Prime Intellect's coding agent, a
 * Rust port of its TypeScript product, which keeps each session in a file of
 * Pi's format: a header line, then one line for each entry. So this adapter
 * is the Pi adapter's body (`../pi/index.ts`) with a profile of Prime
 * Agent's own: its folders, its variables and its words, with every file in
 * the sessions folder itself. A change to those modules changes this adapter
 * too.
 *
 * It differs from Pi's in what a status rests on. Prime Agent writes a lease
 * for each session a process has open, and its daemon's workers each keep a
 * journal of the steps they take, so a session is shown as working, idle or
 * finished from those (`status.ts`), not from whether any `prime-agent` runs.
 *
 * See docs/adapters/prime-agent.md. Built from Prime Agent's source at
 * v0.10.3 (MIT), and not yet checked on a computer running Prime Agent.
 */

export const SOURCE_ID: SourceId = "prime-agent";

/** The variable that names Prime Agent's agent folder, for Agent Lookout alone. */
export const PRIME_AGENT_HOME_ENV = "AGENT_LOOKOUT_PRIME_AGENT_HOME";

/** Prime Agent's own variable for its sessions folder (`SESSION_DIR_ENV` in `crates/pa-daemon/src/paths.rs`). */
export const PRIME_AGENT_SESSIONS_ENV = "PRIME_AGENT_SESSION_DIR";

/**
 * The older name of that variable, which Prime Agent's command still reads
 * after it (`ENV_LEGACY_SESSION_DIR` in `crates/pa-cli/src/config.rs`) and
 * passes on to its workers.
 */
export const PRIME_AGENT_LEGACY_SESSIONS_ENV = "PRIME_AGENT_CODING_AGENT_SESSION_DIR";

/** Prime Agent's own variable for its agent folder (`AGENT_DIR_ENV` in `paths.rs`). */
export const PRIME_AGENT_DIR_ENV = "PRIME_AGENT_CODING_AGENT_DIR";

/** Prime Agent's agent folder, in the home folder (`CONFIG_DIR_NAME` in `paths.rs`). */
export const PRIME_AGENT_DIR = [".prime", "agent"] as const;

/** Said whenever Prime Agent is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "A Prime Agent session shows as working or idle from the recovery journal its worker keeps, while a running prime-agent holds the session's lease, and as finished once none does. Between its opening and its first prompt, while its queue is parked, and when run with -p or --mode rpc, it shows as unknown.";

/** Said whenever Prime Agent is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Prime Agent's source at v0.10.3 and not yet checked on a computer running Prime Agent, so a status can be wrong.";

/** Said when a file is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "A Prime Agent newer than this Agent Lookout wrote a session in a format it does not read, so that session is not shown.";

/**
 * What a Prime Agent session can show, from the files this adapter reads.
 * See docs/adapters/prime-agent.md for each. Built from Prime Agent's source
 * at v0.10.3 and not yet checked on a computer running it.
 *
 * - Working and idle come from the journal of the worker that holds the
 *   session's lease, on macOS and Linux.
 * - No Needs you: Prime Agent asks nothing mid-turn.
 * - Finished once no running prime-agent holds the lease.
 * - No Failed: a failed turn is written inside a message, which is not parsed.
 * - The name is one you or its model gave, else the folder's.
 * - No Jump, Stop or Answer: the files name no terminal, only signal 0 is
 *   ever sent, and no request is made to Prime Agent.
 * - Quiet for is the time since the session's file was last written.
 * - No Tokens: a reply's counts are on the line with its text.
 */
export const PRIME_AGENT_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "From the journal of the worker that holds its lease, on macOS and Linux. Unknown before its first prompt, or while parked.",
  },
  "needs-you": {
    level: "no",
    reason: "Prime Agent puts no question or approval to you mid-turn.",
  },
  finished: {
    level: "partly",
    reason:
      "When no running prime-agent holds the session's lease, as also after Prime Agent stops an idle worker.",
  },
  failed: {
    level: "no",
    reason: "Prime Agent writes a failed turn inside a message, which is not parsed.",
  },
  names: {
    level: "partly",
    reason: "One you gave with /name or /new --name, or its model gave, else the folder's.",
  },
  jump: { level: "no", reason: "Prime Agent's files name no terminal." },
  "quiet-for": {
    level: "partly",
    reason:
      "The time since the session's file was last written. A long reply or Python call writes nothing until it ends.",
  },
  tokens: {
    level: "no",
    reason: "A reply's counts are on the line with its text, which is not parsed.",
  },
  stop: {
    level: "no",
    reason: "Agent Lookout sends a Prime Agent process no signal but signal 0.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Prime Agent's sockets, so it cannot send an answer.",
  },
};

/** Prime Agent's profile, for the shared body of the Pi adapter. */
export const PRIME_AGENT_PROFILE: PiProfile = {
  sourceId: SOURCE_ID,
  label: "Prime Agent",
  program: "prime-agent",
  programs: PRIME_AGENT_PROGRAMS,
  homeEnv: PRIME_AGENT_HOME_ENV,
  sessionsEnv: PRIME_AGENT_SESSIONS_ENV,
  legacySessionsEnv: PRIME_AGENT_LEGACY_SESSIONS_ENV,
  agentDirEnv: PRIME_AGENT_DIR_ENV,
  agentDir: PRIME_AGENT_DIR,
  layout: "flat",
  readsNames: true,
  hiddenMarkers: [],
  capabilities: PRIME_AGENT_CAPABILITIES,
  notes: { status: STATUS_NOTE, unchecked: UNCHECKED_NOTE, newerFormat: NEWER_FORMAT_NOTE },
};

/**
 * The folder of session files this adapter reads: `sessions` in the folder
 * `AGENT_LOOKOUT_PRIME_AGENT_HOME` names, for Agent Lookout alone, else the
 * folder `PRIME_AGENT_SESSION_DIR` names, else the one
 * `PRIME_AGENT_CODING_AGENT_SESSION_DIR` names, else `sessions` in the folder
 * `PRIME_AGENT_CODING_AGENT_DIR` names, else `~/.prime/agent/sessions`, on
 * every system (`sessions_dir` and `agent_dir` in `paths.rs`). `~` at its
 * start is the home folder, and a relative one is passed over. Neither
 * `--session-dir` nor the `sessionDir` setting is followed.
 */
export function primeAgentSessionsDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  return sessionsDirFor(PRIME_AGENT_PROFILE, env, homeDir);
}

/**
 * The agent folder, which holds `session-leases/` and `daemon-workers/`: the
 * folder `AGENT_LOOKOUT_PRIME_AGENT_HOME` names, else the one
 * `PRIME_AGENT_CODING_AGENT_DIR` names, else `~/.prime/agent`. Prime Agent's
 * variables for the sessions folder do not move it (`lease_directory` in
 * `lease.rs`, `descriptor_dir` in `descriptor.rs`).
 */
export function primeAgentAgentDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  return agentDirFor(PRIME_AGENT_PROFILE, env, homeDir);
}

/** Everything the adapter touches outside itself. Tests replace these. */
export type PrimeAgentAdapterOptions = Omit<PiAdapterOptions, "processes" | "processCheckMs"> & {
  /** Whether a process runs, with signal 0, which tests a process and sends it nothing. */
  isAlive?: (pid: number) => boolean;
  /** How long the computer has been on, in milliseconds. Defaults to asking the system. */
  uptimeMs?: () => number;
  /** What runs `ps`. Defaults to `runPs`. */
  runPs?: RunPsWith;
  /** What reads a file of `/proc`, on Linux. Defaults to reading it, at most 4 KiB. */
  readProcFile?: ReadProcFile;
};

/**
 * Finds Prime Agent's sessions on this machine from the files Prime Agent
 * keeps, as the Pi adapter finds Pi's, with nothing installed, no setting
 * changed and no program of Prime Agent's run. Of each session file written
 * in the last day it reads the first line and the lines that name the
 * session. While there are sessions to show, it reads the session leases,
 * checks each lease's process, and on macOS and Linux reads the journal of
 * the worker that holds a session.
 *
 * Prime Agent not being installed costs nothing: when the sessions folder is
 * missing, the adapter says so and looks again only once a minute, and runs
 * nothing.
 */
export function createPrimeAgentAdapter(options: PrimeAgentAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const status = createPrimeAgentStatus({
    agentDir: primeAgentAgentDirFor(env, homeDir),
    homeDir,
    io: options.io ?? nodeIo,
    platform: options.platform ?? process.platform,
    now: options.now ?? Date.now,
    isAlive: options.isAlive ?? isProcessAlive,
    uptimeMs: options.uptimeMs ?? (() => os.uptime() * 1000),
    runPs: options.runPs ?? runPs,
    ...(options.readProcFile === undefined ? {} : { readProcFile: options.readProcFile }),
    ...(options.sweepMs === undefined ? {} : { sweepMs: options.sweepMs }),
  });
  return createPiFamilyAdapter(PRIME_AGENT_PROFILE, options, status);
}
