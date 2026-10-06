import { describe, expect, test, vi } from "vitest";

import { STOP_INTERVAL_MS, STOP_WAIT_MS } from "@core/api";
import {
  ancestorsOf,
  createActionLimiter,
  createStopper,
  STOP_POLL_MS,
  stoppedEvent,
  type Kill,
  type StopperOptions,
} from "@collector/actions/stopSession";
import type { StopTarget } from "@collector/actions/stopTargets";
import type { RunCommand } from "@collector/adapters/claude-code/feed";
import { ids, registryFile } from "@tests/fixtures/claudeCode";

const PID = 4241;
const STARTED = "Tue Nov 14 22:13:20 2023";
const FILE = `/Users/example/.claude/sessions/${PID}.json`;
const BIN = "/opt/tools/claude";

const SIGNAL: StopTarget = {
  how: "signal",
  sessionId: ids.busy,
  pid: PID,
  procStart: STARTED,
  registryFile: FILE,
};

const JOB: StopTarget = {
  how: "background",
  sessionId: ids.background,
  pid: PID,
  procStart: STARTED,
  registryFile: FILE,
  jobId: "7c5dcf5d",
};

/** An error as `process.kill` throws it. */
const failure = (code: string) => Object.assign(new Error(code), { code });

interface World {
  /** The registry file's content, or null when it is not there. */
  file: string | null;
  /** What `ps` prints for the pid, or null when it prints nothing. */
  started: string | null;
  alive: boolean;
  /** What `kill(pid, 0)` and `kill(pid, "SIGTERM")` throw, by code. */
  probe?: string;
  term?: string;
}

/**
 * Each process's parent, as `ps -A -o pid=,ppid=` would say: Agent Lookout is
 * 100, started from 99, which a shell, 60, started, in a terminal of the
 * Claude Code session 50. The session to stop, 4241, is elsewhere.
 */
const PARENTS = new Map([
  [100, 99],
  [99, 60],
  [60, 50],
  [50, 1],
  [PID, 1],
]);

/** A stopper over a world of the test's own: no file, no process and no `ps` of this machine. */
function stopperIn(world: World, options: Partial<StopperOptions> = {}) {
  const kill = vi.fn<Kill>((_pid, signal) => {
    const code = signal === 0 ? world.probe : world.term;
    if (code) throw failure(code);
    if (signal === "SIGTERM") world.alive = false;
  });
  const run = vi.fn<RunCommand>(async () => ({ ok: true, stdout: "" }));
  const readStarts = vi.fn(async (pids: readonly number[]) =>
    world.started === null ? new Map() : new Map(pids.map((pid) => [pid, world.started as string])),
  );
  const readFile = vi.fn(async (file: string) => {
    if (world.file === null || file !== FILE) throw failure("ENOENT");
    return world.file;
  });
  const stopper = createStopper({
    env: { AGENT_LOOKOUT_CLAUDE_BIN: BIN },
    homeDir: "/Users/example",
    readFile,
    readStarts,
    readParents: async () => new Map(PARENTS),
    kill,
    isAlive: () => world.alive,
    run,
    findBinary: async () => ({ found: true, path: BIN }),
    ownPid: 100,
    parentPid: 99,
    ...options,
  });
  return { stopper, kill, run, readStarts, readFile };
}

/** A live interactive session in a terminal, as the registry and `ps` say it is now. */
function terminalSession(overrides: Record<string, unknown> = {}): World {
  return {
    file: registryFile({ pid: PID, entrypoint: "cli", ...overrides }),
    started: STARTED,
    alive: true,
  };
}

describe("the checks made again before a stop", () => {
  test("a session that is still what was found may be stopped, and nothing is sent yet", async () => {
    const { stopper, kill, readStarts, readFile } = stopperIn(terminalSession());

    expect(await stopper.confirm(SIGNAL)).toMatchObject({ ok: true, entry: { pid: PID } });
    // The file is read again and `ps` asked again, about that one process.
    expect(readFile).toHaveBeenCalledWith(FILE);
    expect(readStarts).toHaveBeenCalledWith([PID]);
    // The only signal is the probe that sends nothing.
    expect(kill.mock.calls).toEqual([[PID, 0]]);
  });

  test("a session in VS Code may be stopped as one in a terminal is", async () => {
    const { stopper } = stopperIn(terminalSession({ entrypoint: "claude-vscode" }));
    expect((await stopper.confirm(SIGNAL)).ok).toBe(true);
  });

  test.each([
    ["the first process", 1],
    ["Agent Lookout's own process", 100],
    ["the process Agent Lookout was started from", 99],
    ["no process at all", 0],
    ["a pid that is not whole", 4241.5],
  ])("%s is never stopped, and nothing is read or sent", async (_what, pid) => {
    const { stopper, kill, readFile } = stopperIn(terminalSession({ pid }));

    expect(await stopper.confirm({ ...SIGNAL, pid })).toEqual({ ok: false, reason: "not-allowed" });
    expect(readFile).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  test.each([
    ["the Claude Code session whose terminal started Agent Lookout", 50],
    ["the shell in between", 60],
  ])("%s is never stopped, and nothing is read or sent", async (_what, pid) => {
    const { stopper, kill, readFile } = stopperIn(terminalSession({ pid }));

    expect(await stopper.confirm({ ...SIGNAL, pid })).toEqual({ ok: false, reason: "not-allowed" });
    expect(readFile).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  test("when ps cannot say which processes Agent Lookout was started from, nothing is stopped", async () => {
    for (const readParents of [
      async () => new Map<number, number>(),
      async () => {
        throw new Error("ps could not be run");
      },
    ]) {
      const { stopper, kill } = stopperIn(terminalSession(), { readParents });
      expect(await stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "cannot-confirm" });
      expect(kill).not.toHaveBeenCalled();
    }
  });

  test("a registry file that has gone, for a process that has gone, means the session has ended", async () => {
    const { stopper, kill } = stopperIn({ file: null, started: null, alive: false });
    expect(await stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "gone" });
    expect(kill).not.toHaveBeenCalled();
  });

  test("a registry file that has gone while its process runs cannot be confirmed", async () => {
    const { stopper, kill } = stopperIn({ file: null, started: STARTED, alive: true });
    expect(await stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "cannot-confirm" });
    expect(kill).not.toHaveBeenCalled();
  });

  test.each<[string, Record<string, unknown> | string]>([
    ["names another session", { sessionId: ids.idle }],
    ["names another process", { pid: PID + 1 }],
    ["records another start time", { procStart: "Wed Nov 15 09:00:00 2023" }],
    ["records no start time", { procStart: undefined }],
    ["is not JSON", "{not json"],
  ])("a registry file that now %s cannot be confirmed", async (_what, overrides) => {
    const world =
      typeof overrides === "string"
        ? { file: overrides, started: STARTED, alive: true }
        : terminalSession(overrides);
    const { stopper, kill } = stopperIn(world);

    expect(await stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "cannot-confirm" });
    expect(kill).not.toHaveBeenCalled();
  });

  test.each([
    ["a helper process", "daemon"],
    ["a helper's worker", "daemon-worker"],
    ["no kind at all", undefined],
    ["a kind nobody knows", "something-new"],
  ])("a registry file that names %s is not stopped", async (_what, kind) => {
    const { stopper, kill } = stopperIn(terminalSession({ kind }));
    expect(await stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "unsupported" });
    expect(kill).not.toHaveBeenCalled();
  });

  test("a session that has turned into a background job, or the other way round, cannot be confirmed", async () => {
    expect(await stopperIn(terminalSession({ kind: "bg" })).stopper.confirm(SIGNAL)).toEqual({
      ok: false,
      reason: "cannot-confirm",
    });
    expect(
      await stopperIn(terminalSession({ sessionId: ids.background })).stopper.confirm(JOB),
    ).toEqual({ ok: false, reason: "cannot-confirm" });
  });

  test("a session in the desktop app, or in an app that is not known, is not stopped", async () => {
    for (const entrypoint of ["claude-desktop", undefined]) {
      const { stopper, kill } = stopperIn(terminalSession({ entrypoint }));
      expect(await stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "unsupported" });
      expect(kill).not.toHaveBeenCalled();
    }
    const job = stopperIn(
      terminalSession({ kind: "bg", sessionId: ids.background, entrypoint: "claude-desktop" }),
    );
    expect(await job.stopper.confirm(JOB)).toEqual({ ok: false, reason: "unsupported" });
  });

  test("a start time from ps that is another process's cannot be confirmed", async () => {
    const world = terminalSession();
    world.started = "Wed Nov 15 09:00:00 2023";
    const { stopper, kill } = stopperIn(world);

    expect(await stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "cannot-confirm" });
    expect(kill).not.toHaveBeenCalled();
  });

  test("a start time from ps more than a second from the recorded one cannot be confirmed", async () => {
    const twoOff = terminalSession();
    twoOff.started = "Tue Nov 14 22:13:22 2023";
    const off = stopperIn(twoOff);
    expect(await off.stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "cannot-confirm" });
    expect(off.kill).not.toHaveBeenCalled();

    // One second is as far as Linux's ps can move it, counting in whole seconds.
    const oneOff = terminalSession();
    oneOff.started = "Tue Nov 14 22:13:21 2023";
    expect((await stopperIn(oneOff).stopper.confirm(SIGNAL)).ok).toBe(true);
    // Printed with other padding, it is the same time.
    const padded = terminalSession();
    padded.started = "Tue Nov 14  22:13:20  2023";
    expect((await stopperIn(padded).stopper.confirm(SIGNAL)).ok).toBe(true);
  });

  test("a start time that cannot be compared is not enough to act on", async () => {
    const world = terminalSession();
    world.started = "a time in some other form";
    const { stopper, kill } = stopperIn(world);

    expect(await stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "cannot-confirm" });
    expect(kill).not.toHaveBeenCalled();
  });

  test("a ps that says nothing, or cannot be run, is not enough to act on either", async () => {
    const silent = terminalSession();
    silent.started = null;
    expect(await stopperIn(silent).stopper.confirm(SIGNAL)).toEqual({
      ok: false,
      reason: "cannot-confirm",
    });

    const broken = stopperIn(terminalSession(), {
      readStarts: async () => {
        throw new Error("ps could not be run");
      },
    });
    expect(await broken.stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "cannot-confirm" });
    expect(broken.kill).not.toHaveBeenCalled();
  });

  test("a ps that says nothing because the process has just ended means it has ended", async () => {
    const world = terminalSession();
    world.started = null;
    world.alive = false;
    expect(await stopperIn(world).stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "gone" });
  });

  test("another user's process is not allowed, and one that ends in between has gone", async () => {
    const theirs = terminalSession();
    theirs.probe = "EPERM";
    expect(await stopperIn(theirs).stopper.confirm(SIGNAL)).toEqual({
      ok: false,
      reason: "not-allowed",
    });

    const ended = terminalSession();
    ended.probe = "ESRCH";
    expect(await stopperIn(ended).stopper.confirm(SIGNAL)).toEqual({ ok: false, reason: "gone" });
  });
});

describe("sending the stop", () => {
  test("a session in a terminal or VS Code is sent SIGTERM, once, and never SIGKILL", async () => {
    const { stopper, kill, run } = stopperIn(terminalSession());

    expect(await stopper.act(SIGNAL)).toBe("signalled");
    expect(kill.mock.calls).toEqual([[PID, "SIGTERM"]]);
    expect(run).not.toHaveBeenCalled();
  });

  test("a process that ended before the signal has gone, and another user's is not allowed", async () => {
    const ended = terminalSession();
    ended.term = "ESRCH";
    expect(await stopperIn(ended).stopper.act(SIGNAL)).toBe("gone");

    const theirs = terminalSession();
    theirs.term = "EPERM";
    expect(await stopperIn(theirs).stopper.act(SIGNAL)).toBe("not-allowed");

    const odd = terminalSession();
    odd.term = "EINVAL";
    expect(await stopperIn(odd).stopper.act(SIGNAL)).toBe("failed");
  });

  test("a background job is stopped with claude stop and its id, never with a signal", async () => {
    const { stopper, kill, run } = stopperIn(terminalSession());

    expect(await stopper.act(JOB)).toBe("stopped");
    expect(kill).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    const [file, args, options] = run.mock.calls[0] ?? [];
    expect(file).toBe(BIN);
    expect(args).toEqual(["stop", "7c5dcf5d"]);
    expect(options?.timeoutMs).toBe(10_000);
    // Run as `claude agents` is run: asked to skip its update check and reporting.
    expect(options?.env).toMatchObject({
      AGENT_LOOKOUT_CLAUDE_BIN: BIN,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  test("claude stop that fails, or a claude that cannot be found, is a failure", async () => {
    const failing = stopperIn(terminalSession(), {
      run: async () => ({ ok: false, problem: "stopped with exit code 1", exitCode: 1 }),
    });
    expect(await failing.stopper.act(JOB)).toBe("failed");

    const missing = stopperIn(terminalSession(), {
      findBinary: async () => ({ found: false, looked: "nowhere" }),
    });
    expect(await missing.stopper.act(JOB)).toBe("failed");
    expect(missing.run).not.toHaveBeenCalled();
  });

  test.each([
    ["an id of another shape", { ...JOB, jobId: "7c5d; rm -rf ~" }, {}],
    ["an id that is an option", { ...JOB, jobId: "--all" }, {}],
    [
      "AGENT_LOOKOUT_CLAUDE_HOME set without AGENT_LOOKOUT_CLAUDE_BIN",
      JOB,
      { env: { AGENT_LOOKOUT_CLAUDE_HOME: "/tmp/elsewhere" } },
    ],
    [
      "AGENT_LOOKOUT_CLAUDE_FEED off",
      JOB,
      { env: { AGENT_LOOKOUT_CLAUDE_BIN: BIN, AGENT_LOOKOUT_CLAUDE_FEED: "off" } },
    ],
  ] as const)("with %s, nothing is run", async (_what, target, options) => {
    const { stopper, run, kill } = stopperIn(terminalSession(), options);

    expect(await stopper.act(target)).toBe("unsupported");
    expect(run).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  test("with both AGENT_LOOKOUT_CLAUDE_HOME and AGENT_LOOKOUT_CLAUDE_BIN set, the named claude is run", async () => {
    const { stopper, run } = stopperIn(terminalSession(), {
      env: { AGENT_LOOKOUT_CLAUDE_HOME: "/tmp/elsewhere", AGENT_LOOKOUT_CLAUDE_BIN: BIN },
    });
    expect(await stopper.act(JOB)).toBe("stopped");
    expect(run.mock.calls[0]?.[1]).toEqual(["stop", "7c5dcf5d"]);
  });
});

describe("waiting for the process to end", () => {
  /** A clock that moves on only when the stopper sleeps. */
  function clock() {
    const time = { now: 1_700_000_000_000 };
    const sleep = vi.fn(async (ms: number) => {
      time.now += ms;
    });
    return { time, sleep, now: () => time.now };
  }

  test("a process that ends is no longer waited on", async () => {
    const { sleep, now } = clock();
    let looks = 0;
    const { stopper } = stopperIn(terminalSession(), {
      sleep,
      now,
      isAlive: () => {
        looks += 1;
        return looks < 4;
      },
    });

    expect(await stopper.waitForEnd([PID])).toEqual(new Set());
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(STOP_POLL_MS);
  });

  test("a process still running 10 seconds later is said to be still running", async () => {
    const { time, sleep, now } = clock();
    const start = time.now;
    const { stopper, kill } = stopperIn(terminalSession(), {
      sleep,
      now,
      isAlive: () => true,
    });

    expect(await stopper.waitForEnd([PID, PID + 1])).toEqual(new Set([PID, PID + 1]));
    expect(time.now - start).toBe(STOP_WAIT_MS);
    // It is only looked at: nothing stronger is sent.
    expect(kill).not.toHaveBeenCalled();
  });

  test("with nothing to wait for, it does not wait", async () => {
    const { sleep, now } = clock();
    const { stopper } = stopperIn(terminalSession(), { sleep, now, isAlive: () => false });
    expect(await stopper.waitForEnd([PID])).toEqual(new Set());
    expect(await stopper.waitForEnd([])).toEqual(new Set());
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("the stopped event", () => {
  test("names the session and what it was doing, says who stopped it, and holds nothing else", () => {
    const event = stoppedEvent(
      { id: `claude-code:${ids.busy}`, name: "demo-project", status: "working" },
      1_700_000_000_000,
    );
    expect(event).toEqual({
      id: `claude-code:${ids.busy}@1700000000000:stopped`,
      at: 1_700_000_000_000,
      sessionId: `claude-code:${ids.busy}`,
      sessionName: "demo-project",
      kind: "stopped",
      from: "working",
      severity: "advisory",
      by: "agent-lookout",
    });
  });

  test("never carries what a waiting session was asking", () => {
    const event = stoppedEvent(
      {
        id: `claude-code:${ids.permission}`,
        name: "demo-api",
        status: "needs-you",
        waitingText: "Run: npm test",
      } as never,
      1,
    );
    expect(JSON.stringify(event)).not.toContain("npm test");
  });
});

describe("one stop at a time", () => {
  test("one turn at a time, and a second between the start of one and the next", () => {
    const time = { now: 1_000 };
    const limiter = createActionLimiter(() => time.now);

    expect(limiter.begin()).toBe(true);
    // While one is under way, however long it takes.
    time.now += 30_000;
    expect(limiter.begin()).toBe(false);
    limiter.end();
    expect(limiter.begin()).toBe(true);
    limiter.end();
    time.now += STOP_INTERVAL_MS - 1;
    expect(limiter.begin()).toBe(false);
    time.now += 1;
    expect(limiter.begin()).toBe(true);
  });

  test("a clock set back does not hold the next one back", () => {
    const time = { now: 10_000 };
    const limiter = createActionLimiter(() => time.now);
    expect(limiter.begin()).toBe(true);
    limiter.end();
    time.now = 5_000;
    expect(limiter.begin()).toBe(true);
  });
});

describe("ancestorsOf", () => {
  test("follows the parents up from Agent Lookout's own process to the first", () => {
    expect([...(ancestorsOf(100, PARENTS) ?? [])]).toEqual([100, 99, 60, 50]);
  });

  test("stops at a loop and at a parent ps did not list", () => {
    const looped = new Map([
      [100, 99],
      [99, 100],
    ]);
    expect([...(ancestorsOf(100, looped) ?? [])]).toEqual([100, 99]);
    expect([...(ancestorsOf(100, new Map([[100, 99]])) ?? [])]).toEqual([100, 99]);
  });

  test("is null when ps did not list Agent Lookout's own process", () => {
    expect(ancestorsOf(100, new Map([[99, 1]]))).toBeNull();
  });
});
