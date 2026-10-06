// Stand-ins for another machine, for the tests of reading one over SSH: a
// stand-in ssh, which forwards to this machine and connects nowhere else, and
// a stand-in Agent Lookout for it to forward to. No test runs the real ssh,
// reads ~/.ssh or reaches another machine. Everything is ended when the test
// that started it finishes.

import { execFileSync } from "node:child_process";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vitest";

import { listen } from "@tests/support/node/http";
import { tempDir } from "@tests/support/node/tempFiles";

/** The stand-in itself: plain JavaScript, so Node runs it as it is. */
const STAND_IN_SSH = fileURLToPath(new URL("./standInSsh.mjs", import.meta.url));

/** One run of the stand-in ssh, as it wrote it down. */
export interface SshRun {
  pid: number;
  args: string[];
}

export interface StandInSsh {
  /** The program to name in `AGENT_LOOKOUT_SSH_BIN`, or to find on `PATH`, as `ssh`. */
  bin: string;
  /** The folder it is in, to put on `PATH`. */
  dir: string;
  /**
   * The environment to run it with: nothing of this process's, so no real
   * ssh can be found on its `PATH`, with the stand-in named and its log.
   */
  env: NodeJS.ProcessEnv;
  /** Each run so far, oldest first. */
  runs(): Promise<SshRun[]>;
}

/**
 * Writes a program named `ssh` in a folder of its own that runs the stand-in
 * with Node, and returns it. `settings` go in its environment, such as
 * `STAND_IN_SSH_DELAY_MS`. Every run still going when the test finishes is
 * ended.
 */
export async function makeStandInSsh(settings: Record<string, string> = {}): Promise<StandInSsh> {
  const dir = await tempDir();
  const bin = path.join(dir, "ssh");
  const log = path.join(dir, "runs.jsonl");
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN_SSH}" "$@"\n`);
  await chmod(bin, 0o755);
  await writeFile(log, "");

  const runs = async (): Promise<SshRun[]> =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as SshRun);

  // A run the test left going is ended, and only one that is still this
  // stand-in: a process ID that has been given to another program is left alone.
  onTestFinished(async () => {
    for (const run of await runs()) {
      if (isRunning(run.pid) && commandOf(run.pid).includes(STAND_IN_SSH)) {
        process.kill(run.pid, "SIGKILL");
      }
    }
  });

  return {
    bin,
    dir,
    env: { AGENT_LOOKOUT_SSH_BIN: bin, STAND_IN_SSH_LOG: log, ...settings },
    runs,
  };
}

/** What a process is running, as `ps` prints it, or nothing once it has gone. */
function commandOf(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch {
    return "";
  }
}

/** Whether a process is still running. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One request the stand-in Agent Lookout was sent. */
export interface LookoutRequest {
  method: string;
  path: string;
  host: string | undefined;
  origin: string | undefined;
  notifications: string | undefined;
}

export interface StandInLookout {
  port: number;
  /** Every request so far, oldest first. */
  requests: LookoutRequest[];
  /** What `/api/sessions` answers from now on. */
  answer(snapshot: unknown): void;
  /** Stops it, as Agent Lookout stopping on the other machine would. */
  close(): Promise<void>;
}

/**
 * A stand-in for Agent Lookout on the other machine: an HTTP server on a free
 * port of 127.0.0.1 that answers `/api/health` with the version given and
 * `/api/sessions` with the snapshot given, and 404 for anything else. It
 * writes down every request. It is closed when the test finishes.
 */
export async function startStandInLookout(
  snapshot: unknown,
  version = "0.2.3",
): Promise<StandInLookout> {
  let current = snapshot;
  const requests: LookoutRequest[] = [];
  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      host: req.headers.host,
      origin: req.headers.origin,
      notifications: req.headers["x-agent-lookout-notifications"] as string | undefined,
    });
    const body =
      req.url === "/api/health"
        ? { ok: true, version }
        : req.url === "/api/sessions"
          ? current
          : null;
    res.writeHead(body === null ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not-found" }));
  });
  const port = await listen(server);
  return {
    port,
    requests,
    answer(next) {
      current = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
