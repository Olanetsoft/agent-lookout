import { spawn, type ChildProcess } from "node:child_process";

import { childEnvironment } from "../../processes/childEnvironment.ts";
import { validPid } from "../../processes/pids.ts";
import { jsonValuesIn } from "./jsonValues.ts";

/** How long `claude agents --json` gets before it is given up on. */
export const FEED_TIMEOUT_MS = 5_000;

/** Far more than a session list needs, and a ceiling on what a noisy wrapper can send. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** One entry of `claude agents --json`, with every field optional because none is promised. */
export interface FeedEntry {
  pid?: number;
  cwd?: string;
  /** `interactive` or `background`. */
  kind?: string;
  /** Epoch milliseconds. */
  startedAt?: number;
  sessionId?: string;
  name?: string;
  /** Present while the process is alive. */
  status?: string;
  /** Present while `status` is `waiting`. */
  waitingFor?: string;
  /** Background sessions only. */
  id?: string;
  /** Background sessions only. */
  state?: string;
}

export type RunResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      /** Plain-language reason that completes "The claude agents --json command ...". */
      problem: string;
      /** Set when the program ran to the end and reported failure itself. */
      exitCode?: number;
    };

export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<RunResult>;

/** How long a program that ignored the polite signal gets before it is killed outright. */
const KILL_GRACE_MS = 2_000;

/**
 * Away from Windows the program is started in a process group of its own, so
 * that stopping it also stops whatever it started.
 */
const OWN_GROUP = process.platform !== "win32";

/** Programs started here that may still be running, by pid. */
const stillRunning = new Set<number>();
let exitHookInstalled = false;

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // A negative pid addresses the whole group the program leads.
    if (OWN_GROUP) process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    // Nothing is left to signal.
  }
}

/**
 * A program in its own group does not get the Ctrl+C that stops the collector,
 * so one that is hanging at that moment is stopped here instead.
 */
function stopAllWhenThisProcessExits(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pid of stillRunning) {
      try {
        if (OWN_GROUP) process.kill(-pid, "SIGKILL");
        else process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
}

/**
 * Runs a program directly, with no shell between us and it, with stdin closed
 * so it cannot sit waiting for input.
 *
 * This uses `spawn`, the call `execFile` itself is built on, with the shell
 * switched off. `execFile` cannot start a program in its own process group, and
 * without that only the program itself can be stopped: when `claude` is a
 * wrapper script whose child hangs, the child would be left behind, one more
 * with every run.
 *
 * The timeout is enforced here. A wrapper script can leave a child holding the
 * output pipes open long after it was told to stop, and a poll must come back
 * when the time is up, whatever the program does. When the time is up the whole
 * group is asked to stop, and killed if it has not stopped shortly after.
 */
export const runProgram: RunCommand = (file, args, options) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess | undefined;
    const chunks: Buffer[] = [];
    let received = 0;

    const giveUp = (problem: string) => {
      settle({ ok: false, problem });
      if (!child) return;
      const running = child;
      running.stdout?.destroy();
      signal(running, "SIGTERM");
      // The program may have exited while something it started lives on in its
      // group, so the group is signalled again whether or not the program is gone.
      const hardStop = setTimeout(() => {
        signal(running, "SIGKILL");
        if (running.pid !== undefined) stillRunning.delete(running.pid);
      }, KILL_GRACE_MS);
      hardStop.unref();
    };

    const timer = setTimeout(() => {
      giveUp(`did not answer within ${formatSeconds(options.timeoutMs)}`);
    }, options.timeoutMs);

    try {
      child = spawn(file, [...args], {
        env: childEnvironment(options.env),
        shell: false,
        // stdin is the null device, so a program that reads it gets end-of-file.
        // stderr is not wanted and goes the same way.
        stdio: ["ignore", "pipe", "ignore"],
        detached: OWN_GROUP,
        windowsHide: true,
      });
    } catch {
      settle({ ok: false, problem: "could not be started" });
      return;
    }

    const started = child;
    if (started.pid !== undefined) {
      stillRunning.add(started.pid);
      stopAllWhenThisProcessExits();
    }

    started.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received > MAX_OUTPUT_BYTES) {
        giveUp("printed far more than a session list");
        return;
      }
      chunks.push(chunk);
    });
    started.stdout?.on("error", () => {});

    // ENOENT, EACCES and the like: the program never ran.
    started.on("error", () => settle({ ok: false, problem: "could not be started" }));

    started.on("close", (code, signalName) => {
      if (!settled && started.pid !== undefined) stillRunning.delete(started.pid);
      if (code === 0) {
        settle({ ok: true, stdout: Buffer.concat(chunks).toString("utf8") });
      } else if (typeof code === "number") {
        settle({ ok: false, problem: `stopped with exit code ${code}`, exitCode: code });
      } else {
        settle({
          ok: false,
          problem: signalName ? "was stopped before it finished" : "could not be started",
        });
      }
    });
  });

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A whole number. Whether it could be a real time is decided where the clock is known. */
function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Keeps the fields we know, with the types we expect, and drops the rest. */
export function toFeedEntry(value: unknown): FeedEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const entry: FeedEntry = {
    pid: validPid(raw.pid),
    cwd: text(raw.cwd),
    kind: text(raw.kind),
    startedAt: wholeNumber(raw.startedAt),
    sessionId: text(raw.sessionId),
    name: text(raw.name),
    status: text(raw.status),
    waitingFor: text(raw.waitingFor),
    id: text(raw.id),
    state: text(raw.state),
  };
  // Without one of these there is nothing stable to call the session.
  if (entry.sessionId === undefined && entry.id === undefined && entry.pid === undefined) {
    return null;
  }
  return entry;
}

export type FeedResult =
  | { ok: true; entries: FeedEntry[] }
  | {
      ok: false;
      /** The start of a plain-language sentence: "The claude agents --json command did not answer ...". */
      problem: string;
    };

/**
 * The environment the child `claude` process runs in: the collector's own
 * environment with two variables added, and nothing else changed.
 *
 * - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` asks Claude Code to skip its
 *   update check, usage reporting and error reporting.
 * - `DISABLE_AUTOUPDATER` is covered by the variable above as far as traffic
 *   goes. It is kept because an update would also rewrite Claude Code's own
 *   files, and Agent Lookout promises to be read-only on other tools.
 *
 * Agent Lookout's own process sends nothing. The `claude` command is another
 * vendor's program, and it may still contact Anthropic when it starts, the way
 * it does for anyone who runs it: on Claude Code 2.1.283 it opened a connection
 * to Anthropic's API server on every run, even with the two variables above
 * set. That is left alone. Proxy settings are passed on exactly as the person
 * set them: pushing the command's requests somewhere they cannot arrive would
 * be meddling in software this project does not own, and could break something
 * there, such as the refresh of a login. What is done instead is to run the
 * command seldom, and `AGENT_LOOKOUT_CLAUDE_FEED=off` stops it being run at all.
 *
 * The opt-in check in `tests/integration/collector/adapters/claude-code/feed.test.ts`
 * measures this against the real binary.
 */
export function feedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

/**
 * `--all` adds background sessions that have finished and whose process has
 * gone. Without it a job that failed and exited would simply vanish from the
 * list, and nothing could ever be shown as finished or failed. The session
 * registry cannot supply them either: it holds a file per live process.
 */
export const FEED_ARGS = ["agents", "--json", "--all"] as const;

/** For a Claude Code too old to know `--all`: the same list without finished jobs. */
export const FEED_ARGS_WITHOUT_ALL = ["agents", "--json"] as const;

const NOT_A_LIST = "did not print a list of sessions";
const NOTHING_READABLE = "printed a list, but nothing in it could be read as a session";

/**
 * Finds the session list in what the command printed.
 *
 * Other tools print around the list, and some of what they print is valid JSON
 * too: `[12345] wrapper started`, or an empty `[]`. So the list is the first
 * array holding at least one entry that reads as a session. An empty array
 * counts only when no such array follows it, and an array in which nothing
 * reads as a session is never taken for "no sessions": reporting an empty list
 * by mistake would announce every session as ended.
 */
export function pickSessionList(stdout: string): FeedResult {
  let sawEmptyList = false;
  let sawUnreadableList = false;

  for (const value of jsonValuesIn(stdout)) {
    if (!Array.isArray(value)) continue;
    if (value.length === 0) {
      sawEmptyList = true;
      continue;
    }
    const entries: FeedEntry[] = [];
    for (const item of value) {
      const entry = toFeedEntry(item);
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) return { ok: true, entries };
    sawUnreadableList = true;
  }

  if (sawEmptyList) return { ok: true, entries: [] };
  return { ok: false, problem: sawUnreadableList ? NOTHING_READABLE : NOT_A_LIST };
}

export interface FeedOptions {
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
}

export interface FeedReader {
  read(binary: string, options: FeedOptions): Promise<FeedResult>;
  /** Whether this binary is, for now, being read without `--all`. */
  readsPlainly(binary: string): boolean;
}

const failure = (problem: string): FeedResult => ({
  ok: false,
  problem: `The claude agents --json command ${problem}`,
});

/**
 * How many times a binary is read the plain way before `--all` is tried once
 * more. The command is run every 30 seconds, so this is about five minutes.
 * Claude Code can be updated while the collector runs, and a single odd failure
 * should not cost finished jobs for good.
 */
export const RETRY_ALL_AFTER_READS = 10;

/**
 * Reads the feed, and remembers which binaries turned out not to know `--all`.
 *
 * `--all` arrived in Claude Code 2.1.169, three weeks after `agents --json`
 * itself. An older binary refuses the option and exits with an error. When that
 * happens the plain command is tried, and if it works that binary is asked the
 * plain way for a while, so each read still runs one command, not two.
 */
export function createFeedReader(run: RunCommand): FeedReader {
  /** By binary: how many times in a row it has been read the plain way. */
  const plainReads = new Map<string, number>();

  return {
    readsPlainly: (binary) => plainReads.has(binary),
    async read(binary, options) {
      const runOptions = {
        timeoutMs: options.timeoutMs ?? FEED_TIMEOUT_MS,
        env: feedEnvironment(options.env),
      };

      const plainSoFar = plainReads.get(binary);
      const tryAll = plainSoFar === undefined || plainSoFar >= RETRY_ALL_AFTER_READS;
      if (tryAll) {
        const result = await run(binary, FEED_ARGS, runOptions);
        if (result.ok) {
          plainReads.delete(binary);
          const picked = pickSessionList(result.stdout);
          return picked.ok ? picked : failure(picked.problem);
        }
        // Only a program that ran and refused can have tripped over the option.
        // One that hung or never started would do the same again.
        if (result.exitCode === undefined) return failure(result.problem);
      }

      const plain = await run(binary, FEED_ARGS_WITHOUT_ALL, runOptions);
      if (!plain.ok) return failure(plain.problem);
      const picked = pickSessionList(plain.stdout);
      if (!picked.ok) return failure(picked.problem);
      plainReads.set(binary, tryAll ? 1 : plainSoFar + 1);
      return picked;
    },
  };
}
