import os from "node:os";

import { STOP_INTERVAL_MS, STOP_WAIT_MS } from "../../core/api.ts";
import { mapClaudeCodeSurface } from "../../core/mapping/claudeCodeMapping.ts";
import type { Session, SessionEvent } from "../../core/sessions/session.ts";
import { feedEnvironment, runProgram, type RunCommand } from "../adapters/claude-code/feed.ts";
import {
  CLAUDE_BIN_ENV,
  findClaudeBinary,
  type BinarySearch,
} from "../adapters/claude-code/findBinary.ts";
import { CLAUDE_FEED_ENV, CLAUDE_HOME_ENV } from "../adapters/claude-code/index.ts";
import {
  parseRegistryEntry,
  readRegularFile,
  type RegistryEntry,
} from "../adapters/claude-code/registry.ts";
import { isProcessAlive } from "../processes/pids.ts";
import { readProcessParentsWithPs, type ReadProcessParents } from "../processes/processParents.ts";
import {
  compareProcessStart,
  readProcessStartsWithPs,
  SAME_START_TO_STOP_WITHIN_MS,
  type ReadProcessStarts,
} from "../processes/processStart.ts";
import { JOB_ID, type StopTarget } from "./stopTargets.ts";

/**
 * Stopping one Claude Code session, as both routes that stop sessions do it:
 * every check made again at the moment of acting, then the signal or
 * `claude stop`, then the wait for the process to end.
 */

/** How often a signalled process is looked at, while the collector waits for it to end. */
export const STOP_POLL_MS = 200;

/** How long `claude stop` gets. */
export const CLAUDE_STOP_TIMEOUT_MS = 10_000;

/** Why a session was not stopped, before anything was done to it. */
export type NotConfirmed = "gone" | "unsupported" | "cannot-confirm" | "not-allowed";

export type Confirmed = { ok: true; entry: RegistryEntry } | { ok: false; reason: NotConfirmed };

/** What sending the stop came to. `signalled` is waited on, to see whether the process ends. */
export type Acted = "signalled" | "stopped" | "gone" | "not-allowed" | "unsupported" | "failed";

/** Sends a signal to a process, as `process.kill` does: throws with `ESRCH` or `EPERM`. */
export type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface StopperOptions {
  /** Where `AGENT_LOOKOUT_CLAUDE_HOME`, `AGENT_LOOKOUT_CLAUDE_BIN` and `AGENT_LOOKOUT_CLAUDE_FEED` are read. */
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Reads a registry file again. Defaults to `readRegularFile`, which follows no link and reads no pipe. */
  readFile?: (file: string) => Promise<string>;
  /** Asks `ps` when processes started, with nothing remembered from before. */
  readStarts?: ReadProcessStarts;
  /** Asks `ps` for every process's parent, to find the processes Agent Lookout was started from. */
  readParents?: ReadProcessParents;
  kill?: Kill;
  isAlive?: (pid: number) => boolean;
  /** Runs `claude stop`. Defaults to the runner the command is run with. */
  run?: RunCommand;
  findBinary?: () => Promise<BinarySearch>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a signalled process gets to end. Defaults to 10 seconds. */
  waitMs?: number;
  /**
   * Agent Lookout's own process, and the one it was started from, which are
   * never stopped, nor is any process above them.
   */
  ownPid?: number;
  parentPid?: number;
}

/** The most parents followed up from Agent Lookout's own process, far more than any real chain. */
const MAX_ANCESTORS = 256;

/**
 * The processes Agent Lookout was started from, its own included: its parent,
 * that one's parent, and so on up to the first process, as `ps` lists them
 * now. Null when `ps` did not list Agent Lookout's own process, so they cannot
 * be told. A Claude Code session whose terminal started Agent Lookout is one
 * of them, and ending it would end Agent Lookout with it.
 */
export function ancestorsOf(
  ownPid: number,
  parents: ReadonlyMap<number, number>,
): Set<number> | null {
  if (!parents.has(ownPid)) return null;
  const found = new Set<number>([ownPid]);
  let current = parents.get(ownPid);
  while (current !== undefined && current > 1 && !found.has(current)) {
    if (found.size > MAX_ANCESTORS) break;
    found.add(current);
    current = parents.get(current);
  }
  return found;
}

export interface Stopper {
  /**
   * Makes every check again, at this moment, and says whether the session may
   * be stopped. Nothing is done to it here.
   */
  confirm(target: StopTarget): Promise<Confirmed>;
  /** Sends SIGTERM to the process, or runs `claude stop` for a background job. Never SIGKILL. */
  act(target: StopTarget): Promise<Acted>;
  /** Waits up to 10 seconds for the processes to end, and gives back those still running. */
  waitForEnd(pids: readonly number[]): Promise<Set<number>>;
  readonly now: () => number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function createStopper(options: StopperOptions): Stopper {
  const { env } = options;
  const homeDir = options.homeDir ?? os.homedir();
  const readFile = options.readFile ?? readRegularFile;
  const readStarts = options.readStarts ?? readProcessStartsWithPs;
  const readParents = options.readParents ?? readProcessParentsWithPs;
  const kill: Kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = options.isAlive ?? isProcessAlive;
  const run = options.run ?? runProgram;
  const findBinary = options.findBinary ?? (() => findClaudeBinary({ env, homeDir }));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const waitMs = options.waitMs ?? STOP_WAIT_MS;
  const ownPid = options.ownPid ?? process.pid;
  const parentPid = options.parentPid ?? process.ppid;

  /** Gone when the process has ended, and otherwise the reason given. */
  const goneOr = (pid: number, reason: NotConfirmed): Confirmed => ({
    ok: false,
    reason: isAlive(pid) ? reason : "gone",
  });

  async function confirm(target: StopTarget): Promise<Confirmed> {
    const { pid } = target;
    // Never the first process, Agent Lookout itself or what it was started from.
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === ownPid || pid === parentPid) {
      return { ok: false, reason: "not-allowed" };
    }
    // Nor any process further up, such as the Claude Code session whose
    // terminal ran the command that started it, as `ps` says now.
    let parents: Map<number, number>;
    try {
      parents = await readParents();
    } catch {
      parents = new Map();
    }
    const ancestors = ancestorsOf(ownPid, parents);
    if (ancestors === null) return goneOr(pid, "cannot-confirm");
    if (ancestors.has(pid)) return { ok: false, reason: "not-allowed" };

    // The registry file, read again: still this session's, of a kind that is stopped.
    let entry: RegistryEntry | null;
    try {
      entry = parseRegistryEntry(await readFile(target.registryFile));
    } catch {
      return goneOr(pid, "cannot-confirm");
    }
    if (entry === null || entry.pid !== pid || entry.sessionId !== target.sessionId) {
      return goneOr(pid, "cannot-confirm");
    }
    if (entry.kind !== "interactive" && entry.kind !== "bg") {
      return { ok: false, reason: "unsupported" };
    }
    if ((entry.kind === "bg") !== (target.how === "background")) {
      return { ok: false, reason: "cannot-confirm" };
    }
    const surface = mapClaudeCodeSurface(entry.entrypoint);
    if (surface === "desktop") return { ok: false, reason: "unsupported" };
    if (target.how === "signal" && surface !== "terminal" && surface !== "vscode") {
      return { ok: false, reason: "unsupported" };
    }

    // The process's start time, from `ps` now, with nothing remembered: the
    // same process the file was written for, to the second, or nothing is done.
    if (entry.procStart === undefined || entry.procStart !== target.procStart) {
      return goneOr(pid, "cannot-confirm");
    }
    let started: string | undefined;
    try {
      started = (await readStarts([pid])).get(pid);
    } catch {
      started = undefined;
    }
    if (compareProcessStart(entry.procStart, started, SAME_START_TO_STOP_WITHIN_MS) !== "same") {
      return goneOr(pid, "cannot-confirm");
    }

    try {
      kill(pid, 0);
    } catch (error) {
      return { ok: false, reason: errorCode(error) === "EPERM" ? "not-allowed" : "gone" };
    }
    return { ok: true, entry };
  }

  async function stopJob(jobId: string): Promise<Acted> {
    // The command is run only where Agent Lookout would run `claude agents`.
    const withheld = Boolean(env[CLAUDE_HOME_ENV]?.trim()) && !env[CLAUDE_BIN_ENV]?.trim();
    const feedOff = env[CLAUDE_FEED_ENV]?.trim().toLowerCase() === "off";
    if (withheld || feedOff || !JOB_ID.test(jobId)) return "unsupported";
    const binary = await findBinary();
    if (!binary.found) return "failed";
    const result = await run(binary.path, ["stop", jobId], {
      timeoutMs: CLAUDE_STOP_TIMEOUT_MS,
      env: feedEnvironment(env),
    });
    return result.ok ? "stopped" : "failed";
  }

  async function act(target: StopTarget): Promise<Acted> {
    if (target.how === "background") return stopJob(target.jobId);
    try {
      kill(target.pid, "SIGTERM");
      return "signalled";
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") return "gone";
      return code === "EPERM" ? "not-allowed" : "failed";
    }
  }

  async function waitForEnd(pids: readonly number[]): Promise<Set<number>> {
    const since = now();
    let running = new Set(pids.filter((pid) => isAlive(pid)));
    while (running.size > 0 && now() - since < waitMs) {
      await sleep(Math.min(STOP_POLL_MS, Math.max(1, waitMs - (now() - since))));
      running = new Set([...running].filter((pid) => isAlive(pid)));
    }
    return running;
  }

  return { confirm, act, waitForEnd, now };
}

/** The event that says Agent Lookout stopped a session. It holds nothing read from a transcript. */
export function stoppedEvent(
  session: Pick<Session, "id" | "name" | "status">,
  at: number,
): SessionEvent {
  return {
    id: `${session.id}@${at}:stopped`,
    at,
    sessionId: session.id,
    sessionName: session.name,
    kind: "stopped",
    from: session.status,
    severity: "advisory",
    by: "agent-lookout",
  };
}

/**
 * One stop, or one clean-up, at a time, and a second between the start of
 * one and the next: the two routes share it, since both end processes.
 */
export interface ActionLimiter {
  /** Takes the turn, or says false when one is under way or the last began less than a second ago. */
  begin(): boolean;
  /** Gives the turn back. */
  end(): void;
}

export function createActionLimiter(
  now: () => number = Date.now,
  intervalMs: number = STOP_INTERVAL_MS,
): ActionLimiter {
  let lastAt: number | null = null;
  let underWay = false;
  return {
    begin() {
      const at = now();
      const tooSoon = lastAt !== null && at >= lastAt && at - lastAt < intervalMs;
      if (underWay || tooSoon) return false;
      lastAt = at;
      underWay = true;
      return true;
    },
    end() {
      underWay = false;
    },
  };
}
