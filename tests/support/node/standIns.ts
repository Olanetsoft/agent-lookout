// Stand-ins for Claude Code sessions' processes, for the integration tests of
// Stop and of the clean-up: small Node programs this test starts itself, that
// do nothing but wait. Each is the test's own child, and is ended, if it is
// still running, when the test that started it finishes. No test signals any
// process it did not start.

import { spawn, type ChildProcess } from "node:child_process";

import { onTestFinished } from "vitest";

import { readProcessStartsWithPs } from "@collector/processes/processStart";

export interface StandIn {
  pid: number;
  /** When it started, as `ps` prints it: what Claude Code records as `procStart`. */
  procStart: string;
  /** How it ended: the signal that ended it, or null when it exited by itself. */
  exited: Promise<NodeJS.Signals | null>;
  /** Whether it is still running. */
  running(): boolean;
}

/**
 * Starts a process that waits until it is stopped, and resolves once it is
 * running. With `ignoreTerm`, it pays SIGTERM no heed, as a session that does
 * not end when asked would.
 */
export async function startStandIn(options: { ignoreTerm?: boolean } = {}): Promise<StandIn> {
  const script = [
    options.ignoreTerm ? "process.on('SIGTERM', () => {});" : "",
    "setInterval(() => {}, 1000);",
    "process.stdout.write('ready\\n');",
  ].join(" ");
  const child: ChildProcess = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin" },
  });
  let done = false;
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, signal) => {
      done = true;
      resolve(signal);
    });
  });
  onTestFinished(async () => {
    if (!done) {
      child.kill("SIGKILL");
      await exited;
    }
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("ready")) resolve();
    });
  });
  const pid = child.pid as number;
  const procStart = (await readProcessStartsWithPs([pid])).get(pid);
  if (procStart === undefined) throw new Error("ps gave no start time for the stand-in.");
  return { pid, procStart, exited, running: () => !done };
}

/** What a stand-in in a chain runs: it starts the next, until the last, which says it is running. */
const CHAIN_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const depth = Number(process.env.STAND_IN_DEPTH);",
  "if (depth > 0) {",
  "  spawn(process.execPath, ['-e', process.env.STAND_IN_SCRIPT], {",
  "    stdio: ['ignore', 'inherit', 'ignore'],",
  "    env: { ...process.env, STAND_IN_DEPTH: String(depth - 1) },",
  "  });",
  "} else {",
  "  process.stdout.write(`ready ${process.pid} ${process.ppid}\\n`);",
  "}",
  "setInterval(() => {}, 1000);",
].join("\n");

/**
 * Starts a stand-in that starts another, which starts a third: a chain of
 * three, as a Claude Code session, the shell in its terminal and a command run
 * from that shell are. Resolves once the last is running, with the first and
 * the pids of the other two. The three are in a process group of their own,
 * which is ended when the test that started it finishes.
 */
export async function startStandInChain(): Promise<{ top: StandIn; middle: number; leaf: number }> {
  const child: ChildProcess = spawn(process.execPath, ["-e", CHAIN_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin", STAND_IN_DEPTH: "2", STAND_IN_SCRIPT: CHAIN_SCRIPT },
    detached: true,
  });
  let done = false;
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, signal) => {
      done = true;
      resolve(signal);
    });
  });
  const top = child.pid as number;
  onTestFinished(async () => {
    try {
      // The group the first one leads: the three of them, and nothing else.
      process.kill(-top, "SIGKILL");
    } catch {
      // Already ended.
    }
    if (!done) await exited;
  });

  const [leaf, middle] = await new Promise<[number, number]>((resolve, reject) => {
    child.once("error", reject);
    let said = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      const match = /ready (\d+) (\d+)\n/.exec(said);
      if (match) resolve([Number(match[1]), Number(match[2])]);
    });
  });
  const procStart = (await readProcessStartsWithPs([top])).get(top);
  if (procStart === undefined) throw new Error("ps gave no start time for the stand-in.");
  return { top: { pid: top, procStart, exited, running: () => !done }, middle, leaf };
}
