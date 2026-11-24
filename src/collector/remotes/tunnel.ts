// The SSH tunnel to one other machine: the person's own ssh, with its input and
// output joined to the port Agent Lookout listens on there. It is started
// again, after a wait that grows, whenever it ends, and stopped with the
// collector.

import { spawn, type ChildProcess } from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";

import { clean, oneLine } from "../../core/text.ts";
import { childEnvironment } from "../processes/childEnvironment.ts";
import { createRemoteReader, type RemoteReading } from "./remoteReader.ts";
import type { Remote } from "./remoteSettings.ts";
import { findSsh, sshArguments, type SshSearch } from "./sshProgram.ts";

/**
 * How long to wait before starting ssh again, by how many runs in a row have
 * ended before anything came back through them. After a run that connected,
 * the wait is the first again.
 */
export const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

/**
 * How long a run of ssh has to bring back its first reading. One that hangs
 * while it signs in, itself or in a `ProxyJump` or `ProxyCommand`, never ends on
 * its own: ssh checks the other computer only once it has signed in. It is more
 * than Linux takes to give up on an address that does not answer, 127 seconds,
 * and leaves time for a `ProxyCommand` that starts the other computer.
 */
export const FIRST_READING_MS = 180_000;

/** The most of what ssh says that is kept: its last lines, which say why it ended. */
const MAX_SAID_BYTES = 4_096;

/** The longest line of what ssh said that is shown. */
const MAX_SAID_LENGTH = 200;

/**
 * How long `stop` waits for ssh to end after SIGTERM, which it does at once,
 * before it sends SIGKILL, and then again for that to end it.
 */
export const STOP_WAIT_MS = 2_000;

/** How one run of ssh ended. */
export interface TunnelEnd {
  at: number;
  /** Whether a reading had come back through it before it ended: if so, it dropped. */
  connected: boolean;
  /** The exit code, or null when it was ended by a signal or could not be started. */
  code: number | null;
  /**
   * The last line ssh wrote to its error output, on one line, or null when it
   * wrote none. For a run ended here, why it was.
   */
  said: string | null;
}

export type TunnelState =
  /** Not started, or stopped. */
  | { kind: "off" }
  /**
   * No ssh to run. It is looked for again at `retryAt`. `named` is true when
   * `AGENT_LOOKOUT_SSH_BIN` named a program that cannot be run.
   */
  | { kind: "no-ssh"; looked: string; named?: true; retryAt: number }
  | {
      kind: "running";
      /** Counts the runs, so a reading is known to belong to this one. */
      run: number;
      /** Reads the other machine through ssh, once it has signed in. */
      read: () => Promise<RemoteReading>;
      since: number;
      /** What was run: the program and its arguments, for the Sources view. */
      command: readonly string[];
    }
  /** ssh has ended, and is started again at `retryAt`. */
  | { kind: "ended"; run: number; end: TunnelEnd; retryAt: number };

export interface Tunnel {
  /** Starts ssh, unless it is running or waiting to start again. */
  start(): void;
  /**
   * Ends ssh, with SIGTERM, or SIGKILL when that has not ended it within two
   * seconds, and starts it no more. Resolves once it has ended.
   */
  stop(): Promise<void>;
  state(): TunnelState;
  /**
   * Told when a reading has come back whole through this run: the next time it
   * ends, it dropped, and the wait before it starts again is the shortest.
   */
  connected(run: number): void;
}

/** What starts ssh. Tests pass the real one too, with a stand-in ssh named in the environment. */
export type SpawnSsh = (
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => ChildProcess;

export interface TunnelOptions {
  remote: Remote;
  /** What ssh is looked for in and run with: `PATH`, `AGENT_LOOKOUT_SSH_BIN`, and ssh's own. */
  env: NodeJS.ProcessEnv;
  findSsh?: (env: NodeJS.ProcessEnv) => Promise<SshSearch>;
  spawnSsh?: SpawnSsh;
  /** Defaults to `RESTART_DELAYS_MS`. */
  restartDelaysMs?: readonly number[];
  /** Defaults to `FIRST_READING_MS`. */
  firstReadingMs?: number;
  now?: () => number;
}

/**
 * Away from Windows ssh is started in a process group of its own, so that
 * ending it also ends what it started: a `ProxyJump`'s own ssh, or a
 * `ProxyCommand`, that hangs does not end when ssh does.
 */
const OWN_GROUP = process.platform !== "win32";

/**
 * Starts ssh directly, with no shell between. With BatchMode it asks nothing, so
 * its input and output hold only what goes to the other machine's Agent Lookout
 * and comes back. Its error output is read for the reason it ends. Its input
 * ends when this process does, however it does, and then so does ssh, unless it
 * is still signing in: that one only `stop` and `endOnExit` end.
 */
export const spawnSsh: SpawnSsh = (binary, args, env) =>
  spawn(binary, [...args], {
    env: childEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: OWN_GROUP,
    windowsHide: true,
  });

/** Sends ssh a signal, or with 0 none, and says whether any of it was left to get it. */
function signal(ssh: ChildProcess, name: "SIGTERM" | "SIGKILL" | 0): boolean {
  if (ssh.pid === undefined) return false;
  try {
    // A negative pid is the whole group ssh leads.
    return OWN_GROUP ? process.kill(-ssh.pid, name) : ssh.kill(name);
  } catch {
    return false;
  }
}

/**
 * Every ssh this process has started and not seen end. When the process exits
 * without stopping the collector, each is sent SIGTERM, so none is left after
 * Agent Lookout has gone.
 */
const live = new Set<ChildProcess>();
let endedOnExit = false;

function endOnExit(child: ChildProcess): void {
  live.add(child);
  child.once("exit", () => live.delete(child));
  if (endedOnExit) return;
  endedOnExit = true;
  process.once("exit", () => {
    for (const running of live) signal(running, "SIGTERM");
  });
}

/**
 * The last line of what ssh said, on one line, or null. A warning is passed over
 * for the reason after it, and so is the line that says only that the channel
 * of `-W` failed, for the reason before it.
 */
function lastLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => clean(line))
    .filter((line): line is string => line !== undefined);
  const reasons = lines.filter((line) => !/^(warning:|stdio forwarding failed)/i.test(line));
  const line = reasons[reasons.length - 1] ?? lines[lines.length - 1];
  return line === undefined ? null : oneLine(line, MAX_SAID_LENGTH);
}

/**
 * ssh's output and input as one stream. An end of either ends both, since
 * nothing more can be read, and its failure is the run's end, which `close` says.
 */
function joined(readable: Readable, writable: Writable): Duplex {
  const stream = Duplex.from({ readable, writable });
  for (const each of [readable, writable, stream]) each.on("error", () => {});
  stream.once("end", () => stream.destroy());
  return stream;
}

/**
 * The tunnel to one other machine. Each run is
 * `ssh -W 127.0.0.1:<port there> -o BatchMode=yes -o ClearAllForwardings=yes
 * -o PermitLocalCommand=no -o LogLevel=INFO -o ServerAliveInterval=15
 * -o ControlMaster=no -o ControlPath=none -- <target>`, as `sshArguments` makes
 * it, with the program found as `findSsh` finds it. No port is opened on this
 * computer. The run ends when its connection to Agent Lookout there does, and
 * when there is none.
 *
 * Agent Lookout never sees a key or a password. ssh signs in with the person's
 * own config and agent, or, since it is told never to ask, fails and says why.
 *
 * When a run ends it is started again: after 1 second, then 2, 5, 10 and 30,
 * and then every minute, for as long as runs end before anything came back
 * through them. Once a reading has, the next wait is a second again. A run
 * through which no reading has come back within `FIRST_READING_MS` is ended, and
 * started again the same way.
 */
export function createTunnel(options: TunnelOptions): Tunnel {
  const { remote, env } = options;
  const find = options.findSsh ?? findSsh;
  const start = options.spawnSsh ?? spawnSsh;
  const delays = options.restartDelaysMs ?? RESTART_DELAYS_MS;
  const firstReadingMs = options.firstReadingMs ?? FIRST_READING_MS;
  const now = options.now ?? Date.now;

  let state: TunnelState = { kind: "off" };
  let on = false;
  /**
   * Counts each start and stop, so a run that was being prepared when the
   * tunnel was stopped, and perhaps started again, is never made.
   */
  let generation = 0;
  let run = 0;
  /** Runs in a row that ended before anything came back through them. */
  let unanswered = 0;
  let connectedRun: number | null = null;
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves when the running ssh has ended, for `stop`. */
  let exited: Promise<void> = Promise.resolve();

  /** An end with no run of ssh behind it, for a run that could not be made. */
  function notStarted(said: string): TunnelState {
    const at = now();
    return {
      kind: "ended",
      run,
      end: { at, connected: false, code: null, said },
      retryAt: later(nextDelay(), at),
    };
  }

  /** The wait before the next run, which grows with each run that never answered. */
  function nextDelay(): number {
    const delay = delays[Math.min(unanswered, delays.length - 1)] ?? 1_000;
    unanswered += 1;
    return delay;
  }

  /** Starts the next run after `delay`, and says when that is, counted from `from`. */
  function later(delay: number, from: number = now()): number {
    if (timer) clearTimeout(timer);
    const current = generation;
    timer = setTimeout(() => {
      timer = null;
      void launch(current);
    }, delay);
    // A wait alone should not keep a process alive.
    timer.unref?.();
    return from + delay;
  }

  /** Whether a run is being prepared, so that two are never made at once. */
  let launching = false;
  /** Whether a start came while one was being prepared, to be made once it is. */
  let again = false;

  async function launch(current: number): Promise<void> {
    if (launching) {
      again = true;
      return;
    }
    launching = true;
    try {
      await prepare(current);
    } finally {
      launching = false;
    }
    if (again) {
      again = false;
      void launch(generation);
    }
  }

  async function prepare(current: number): Promise<void> {
    const stale = () => !on || current !== generation;
    if (stale() || child) return;
    const search = await find(env);
    if (stale()) return;
    if (!search.found) {
      state = { kind: "no-ssh", looked: search.looked, retryAt: later(nextDelay()) };
      if (search.named) state.named = true;
      return;
    }

    run += 1;
    const thisRun = run;
    const args = sshArguments(remote);
    let ssh: ChildProcess;
    let stream: Duplex;
    try {
      ssh = start(search.path, args, env);
      // With no file left to open it has no input or output, and its error is still to come.
      ssh.on("error", () => {});
      stream = joined(ssh.stdout as Readable, ssh.stdin as Writable);
    } catch {
      state = notStarted("ssh could not be started.");
      return;
    }
    child = ssh;
    endOnExit(ssh);
    state = {
      kind: "running",
      run: thisRun,
      read: createRemoteReader(stream, remote.port),
      since: now(),
      command: [search.path, ...args],
    };

    let said = "";
    ssh.stderr?.setEncoding("utf8");
    ssh.stderr?.on("data", (chunk: string) => {
      said = (said + chunk).slice(-MAX_SAID_BYTES);
    });
    // Neither the process nor what it writes keeps this one alive on its own.
    ssh.unref();
    for (const pipe of ssh.stdio) (pipe as { unref?: () => void } | null)?.unref?.();

    let gone = () => {};
    const thisExited = new Promise<void>((resolve) => (gone = resolve));
    exited = thisExited;
    let overdue: string | null = null;
    const deadline = setTimeout(() => {
      if (connectedRun === thisRun) return;
      overdue = `Nothing came back within ${firstReadingMs / 1000} seconds.`;
      void endSsh(ssh, thisExited);
    }, firstReadingMs);
    deadline.unref?.();
    // With its connection gone ssh ends, and one that does not is ended.
    stream.once("close", async () => {
      if (!(await ended(thisExited))) await endSsh(ssh, thisExited);
    });
    // The process has ended, though what it wrote may not all be read yet. A
    // program it started can hold its error output open long after that.
    ssh.once("exit", (code) => {
      clearTimeout(deadline);
      if (child === ssh) child = null;
      gone();
      setTimeout(() => finish(code, null), STOP_WAIT_MS).unref?.();
      // Stopped, and started again while it was ending: the new start, which
      // found it still running, runs ssh now.
      if (current !== generation && on && child === null) {
        if (state.kind === "running" && state.run === thisRun) state = { kind: "off" };
        void launch(generation);
      }
    });

    let over = false;
    const finish = (code: number | null, failure: string | null) => {
      if (over) return;
      over = true;
      clearTimeout(deadline);
      ssh.stderr?.destroy();
      stream.destroy();
      if (child === ssh) child = null;
      gone();
      const connected = connectedRun === thisRun;
      if (connected) unanswered = 0;
      // A run that was stopped says nothing of the tunnel now: `stop`, and any
      // start after it, say that.
      if (current !== generation) return;
      const at = now();
      const end: TunnelEnd = { at, connected, code, said: overdue ?? lastLine(said) ?? failure };
      state = { kind: "ended", run: thisRun, end, retryAt: later(nextDelay(), at) };
    };
    // `close` comes once the error output has been read to its end, so the
    // reason ssh gave is all there.
    ssh.once("close", (code) => finish(typeof code === "number" ? code : null, null));
    // A program that could not be started at all may never close.
    ssh.once("error", () => {
      if (ssh.pid === undefined) finish(null, "ssh could not be started.");
    });
  }

  /** Whether a run of ssh ended, as `gone` says, within two seconds. */
  function ended(gone: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), STOP_WAIT_MS);
      timeout.unref?.();
      void gone.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  /** Ends a run of ssh, whose end `gone` says, and what it started, which can outlive it. */
  async function endSsh(ssh: ChildProcess, gone: Promise<void>): Promise<void> {
    signal(ssh, "SIGTERM");
    const kill = setTimeout(() => signal(ssh, "SIGKILL"), STOP_WAIT_MS);
    kill.unref?.();
    if (!(await ended(gone))) await ended(gone);
    if (!signal(ssh, 0)) clearTimeout(kill);
  }

  return {
    start() {
      if (on) return;
      on = true;
      generation += 1;
      unanswered = 0;
      void launch(generation);
    },
    async stop() {
      on = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      if (child) await endSsh(child, exited);
      // A start made while this one waited has begun a run of its own.
      if (!on) state = { kind: "off" };
    },
    state: () => state,
    connected(which) {
      if (state.kind === "running" && state.run === which) connectedRun = which;
    },
  };
}
