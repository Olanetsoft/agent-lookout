import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createFeedReader,
  FEED_ARGS,
  feedEnvironment,
  pickSessionList,
  runProgram,
} from "@collector/adapters/claude-code/feed";
import { findClaudeBinary } from "@collector/adapters/claude-code/findBinary";
import { isProcessAlive } from "@collector/processes/pids";
import { feedEntries, feedJsonWithTrailingText } from "@tests/fixtures/claudeCode";
import { tempDir, writeStub } from "@tests/support/node/tempFiles";

const env = { PATH: "/usr/bin:/bin" };

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("The condition never became true.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const one = [{ pid: 4242, sessionId: "00000000-0000-4000-8000-000000000001", status: "busy" }];
const oneJson = JSON.stringify(one);

describe("runProgram, against real programs", () => {
  test("returns what the program printed, trailing text and all", async () => {
    const stub = await writeStub(`cat <<'JSON'\n${feedJsonWithTrailingText}\nJSON`);
    const result = await runProgram(stub, ["agents", "--json"], { timeoutMs: 5_000, env });
    expect(result.ok).toBe(true);
    expect(result.ok && result.stdout).toContain("session tracker");

    expect(await createFeedReader(runProgram).read(stub, { env })).toEqual({
      ok: true,
      entries: feedEntries,
    });
  });

  test("passes the arguments and the environment through, with no shell in between", async () => {
    const stub = await writeStub(
      `printf '[{"sessionId":"%s|%s|%s|%s|%s|%s|%s"}]' "$#" "$1" "$2" "$3" "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" "$DISABLE_AUTOUPDATER" "\${HTTPS_PROXY-unset}"`,
    );
    expect(await createFeedReader(runProgram).read(stub, { env })).toEqual({
      ok: true,
      entries: [{ sessionId: "3|agents|--json|--all|1|1|unset" }],
    });
    // A proxy the person set arrives as they set it.
    expect(
      await createFeedReader(runProgram).read(stub, {
        env: { ...env, HTTPS_PROXY: "http://proxy.example:8080" },
      }),
    ).toEqual({
      ok: true,
      entries: [{ sessionId: "3|agents|--json|--all|1|1|http://proxy.example:8080" }],
    });

    // An argument a shell would expand or split arrives untouched.
    const echo = await writeStub(`printf '%s' "$1"`);
    const result = await runProgram(echo, ["$(echo hacked); `id` && *"], {
      timeoutMs: 5_000,
      env,
    });
    expect(result).toEqual({ ok: true, stdout: "$(echo hacked); `id` && *" });
  });

  test("stdin is closed, so a program that reads it does not hang", async () => {
    const stub = await writeStub(`cat > /dev/null\necho '[]'`);
    const result = await runProgram(stub, [], { timeoutMs: 5_000, env });
    expect(result).toEqual({ ok: true, stdout: "[]\n" });
  });

  test("a program that exits with an error is a failure that names the exit code", async () => {
    const stub = await writeStub(`echo '[]'\necho 'not logged in' >&2\nexit 3`);
    expect(await runProgram(stub, [], { timeoutMs: 5_000, env })).toEqual({
      ok: false,
      problem: "stopped with exit code 3",
      exitCode: 3,
    });
  });

  test("a program that is not there is a failure, not an exception", async () => {
    const dir = await tempDir();
    expect(await runProgram(path.join(dir, "claude"), [], { timeoutMs: 5_000, env })).toEqual({
      ok: false,
      problem: "could not be started",
    });
  });

  test("a program that does not answer in time is stopped", async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "pid");
    const stub = await writeStub(`echo $$ > '${pidFile}'\nexec sleep 30`);

    const started = Date.now();
    const result = await runProgram(stub, [], { timeoutMs: 1_000, env });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ ok: false, problem: "did not answer within 1 second" });
    // Far short of the 30 seconds the program wanted.
    expect(elapsed).toBeLessThan(10_000);

    // The signal to stop has been sent by now. On a busy machine it can land
    // before the script has written its pid, and then there is no process left
    // to check. Otherwise the process it names must go away.
    const written = await readFile(pidFile, "utf8").catch(() => "");
    const pid = Number(written.trim());
    if (pid > 0) await waitUntil(() => !isProcessAlive(pid));
  });

  test("a program that prints far more than a session list is stopped", async () => {
    const stub = await writeStub("yes '[x] padding padding padding padding padding padding'");
    const result = await runProgram(stub, [], { timeoutMs: 20_000, env });
    expect(result).toEqual({ ok: false, problem: "printed far more than a session list" });
  });

  test("a real program too old to know --all is read the plain way", async () => {
    const stub = await writeStub(
      `if [ "$3" = "--all" ]; then echo "error: unknown option '--all'" >&2; exit 1; fi\necho '${oneJson}'`,
    );
    expect(await createFeedReader(runProgram).read(stub, { env })).toEqual({
      ok: true,
      entries: one,
    });
  });

  test("when a wrapper's child hangs, the timeout stops the child as well as the wrapper", async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "child-pid");
    // The wrapper starts a child of its own and waits for it. Stopping only the
    // wrapper would leave the child running, one more for every poll.
    const stub = await writeStub(`sleep 30 &\necho $! > '${pidFile}'\nwait`);

    // Long enough for the wrapper to start its child on a busy machine.
    const result = await runProgram(stub, [], { timeoutMs: 2_000, env });
    expect(result).toEqual({ ok: false, problem: "did not answer within 2 seconds" });

    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(childPid).toBeGreaterThan(0);
    await waitUntil(() => !isProcessAlive(childPid));
  });

  test("a child that ignores the request to stop is killed", async () => {
    const dir = await tempDir();
    const pidFile = path.join(dir, "child-pid");
    const stub = await writeStub(
      `(trap '' TERM; sleep 30) &\necho $! > '${pidFile}'\ntrap '' TERM\nwait`,
    );

    const result = await runProgram(stub, [], { timeoutMs: 2_000, env });
    expect(result.ok).toBe(false);

    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(childPid).toBeGreaterThan(0);
    // Still there after the polite signal; gone once the grace period is up.
    await waitUntil(() => !isProcessAlive(childPid), 8_000);
  }, 15_000);

  test("the timeout holds even when a wrapper leaves a child holding the output open", async () => {
    // The script is told to stop, but the `sleep` it started keeps the pipe open.
    // Waiting for that pipe to close would stretch the timeout to the sleep's length.
    const stub = await writeStub(`sleep 8 &\nwait`);

    const started = Date.now();
    const result = await runProgram(stub, [], { timeoutMs: 300, env });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ ok: false, problem: "did not answer within 0.3 seconds" });
    expect(elapsed).toBeLessThan(5_000);
  });
});

// The opt-in check: the real `claude` binary on this machine. It is skipped in
// every ordinary run, because it runs Claude Code itself and so reads this
// machine's real sessions (their number is checked; nothing of them is printed).
//
// Agent Lookout itself sends nothing anywhere. The child process it starts is
// Claude Code's own program, which may contact Anthropic the way it does for
// anyone who runs it. The collector runs it with an environment that asks it to
// keep its non-essential traffic off, and how it treats that environment can
// change from one version to the next. This measures what it does. Run it after
// a Claude Code update, or when touching `feedEnvironment`:
//
//   AGENT_LOOKOUT_CHECK_REAL_CLAUDE=1 npx vitest run --project integration tests/integration/collector/adapters/claude-code/feed.test.ts -t "real claude binary"
//
// It samples the child's sockets with macOS's `netstat`, so it runs on macOS only.

const enabled =
  process.env.AGENT_LOOKOUT_CHECK_REAL_CLAUDE === "1" && process.platform === "darwin";

const RUNS = 12;

interface Socket {
  remote: string;
  state: string;
}

/** The TCP sockets a process holds right now, from `netstat -anvp tcp`. */
function socketsOf(pid: number): Promise<Socket[]> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/netstat",
      ["-anvp", "tcp"],
      { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (_error, stdout) => {
        const sockets: Socket[] = [];
        for (const line of String(stdout ?? "").split("\n")) {
          const columns = line.trim().split(/\s+/);
          if (!columns[0]?.startsWith("tcp")) continue;
          // The owner is printed as `name:pid`.
          if (!columns.some((column) => column.endsWith(`:${pid}`))) continue;
          sockets.push({ remote: columns[4] ?? "", state: columns[5] ?? "" });
        }
        resolve(sockets);
      },
    );
  });
}

/** `netstat` writes an address as `host.port`. A listening socket has no remote end. */
function leavesThisMachine(socket: Socket): boolean {
  if (socket.remote === "*.*") return false;
  return !/^(127\.\d+\.\d+\.\d+|::1|fe80::1%lo0)\.\d+$/.test(socket.remote);
}

interface Observed {
  exitCode: number | null;
  stdout: string;
  samples: number;
  sockets: Socket[];
}

/** Runs a program and samples its sockets, as fast as `netstat` allows, until it exits. */
async function observe(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Observed> {
  const child = spawn(file, [...args], { env, stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  let exited = false;
  const exitCode = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      exited = true;
      resolve(code);
    }),
  );

  const sockets: Socket[] = [];
  let samples = 0;
  while (!exited && child.pid !== undefined) {
    sockets.push(...(await socketsOf(child.pid)));
    samples += 1;
  }
  return { exitCode: await exitCode, stdout, samples, sockets };
}

describe.runIf(enabled)("the real claude binary, run the way the collector runs it", () => {
  test("the sampler can see a socket that a child process holds", async () => {
    // Without this, "no socket was seen" could mean the sampler is blind.
    const listener = createServer((socket) => socket.on("error", () => {}));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => void listener.close());
    const { port } = listener.address() as { port: number };

    const seen = await observe(
      process.execPath,
      [
        "-e",
        `const s = require("node:net").connect(${port}, "127.0.0.1"); setTimeout(() => s.destroy(), 150);`,
      ],
      { PATH: process.env.PATH },
    );
    expect(seen.exitCode).toBe(0);
    expect(seen.sockets.map((socket) => socket.remote)).toContain(`127.0.0.1.${port}`);
    // And a socket on this machine is not mistaken for one that leaves it.
    expect(seen.sockets.filter(leavesThisMachine)).toEqual([]);
  });

  test(`claude ${FEED_ARGS.join(" ")} holds no socket to another machine, in ${RUNS} runs of ${RUNS}`, async () => {
    const binary = await findClaudeBinary({ env: process.env, homeDir: os.homedir() });
    expect(binary.found, "No claude binary was found to check.").toBe(true);
    if (!binary.found) return;

    const leaving: string[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const seen = await observe(binary.path, FEED_ARGS, feedEnvironment(process.env));

      // The command still works with the network taken away.
      expect(seen.exitCode).toBe(0);
      expect(pickSessionList(seen.stdout).ok).toBe(true);
      // It lived long enough to be looked at more than once.
      expect(seen.samples).toBeGreaterThan(1);

      for (const socket of seen.sockets.filter(leavesThisMachine)) {
        leaving.push(`run ${run + 1}: ${socket.remote} ${socket.state}`);
      }
    }
    expect(leaving).toEqual([]);
  }, 120_000);
});
