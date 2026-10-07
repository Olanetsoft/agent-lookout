import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  FEED_ARGS,
  FEED_ARGS_WITHOUT_ALL,
  type RunCommand,
} from "@collector/adapters/claude-code/feed";
import {
  createClaudeCodeAdapter,
  NEW_SESSION_GRACE_MS,
  type ClaudeCodeAdapterOptions,
} from "@collector/adapters/claude-code/index";
import { readProcessStartsWithPs } from "@collector/processes/processStart";
import type { RegistryIo } from "@collector/adapters/claude-code/registry";
import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller } from "@collector/poller";
import { FINISHED_RETENTION_MS } from "@core/sessions/retention";
import {
  feedEntries,
  feedJson,
  feedJsonWithTrailingText,
  HOME,
  ids,
  pids,
  registryFile,
  registryFiles,
} from "@tests/fixtures/claudeCode";
import {
  adapterFor,
  BIN,
  fails,
  noStartTimes,
  now,
  prints,
  watching,
  WITHHELD,
} from "@tests/support/adapters/claudeCodeAdapter";
import {
  makeClaudeHome,
  makeUserHome,
  tempDir,
  writeStub,
  writeWindowsStub,
} from "@tests/support/node/tempFiles";
import { asWritten } from "@tests/support/paths";

/**
 * An adapter on a machine where no claude binary can be found. Nothing in its
 * environment names a directory, so it looks in `<userHome>/.claude`.
 */
function withoutBinary(userHome: string, options: ClaudeCodeAdapterOptions = {}) {
  return createClaudeCodeAdapter({
    env: { PATH: "/usr/bin:/bin" },
    homeDir: userHome,
    now: () => now,
    isAlive: () => true,
    isExecutable: async () => false,
    run: prints(feedJson),
    readProcessStarts: noStartTimes,
    ...options,
  });
}

/** A clock a test moves by hand. */
function handClock() {
  let at = now;
  return {
    now: () => at,
    /** Moves to this many milliseconds after the start. */
    moveTo(sinceStart: number) {
      at = now + sinceStart;
    },
  };
}

/** A command that counts its runs and prints whatever the test says it prints at that moment. */
function countedRun(stdout: () => string = () => feedJson) {
  const calls: (readonly string[])[] = [];
  const run: RunCommand = async (_file, args) => {
    calls.push(args);
    return { ok: true, stdout: stdout() };
  };
  return { run, runs: () => calls.length, calls };
}

const registryPath = (home: string, name: string) => path.join(home, "sessions", name);

/** Where the adapter says it looked, on this system, with no APPDATA set on Windows. */
const NOT_FOUND =
  process.platform === "win32"
    ? "The claude command, claude.exe, was not found on PATH or in ~/.local/bin or ~/AppData/Roaming/npm"
    : "The claude command was not found on PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin or /usr/bin";

const HEALTHY =
  "Sessions are read from Claude Code's session registry and checked against its own list of sessions.";

const NO_ENDED_JOBS = "Background jobs whose process has ended are not listed.";

describe("the Claude Code adapter", () => {
  test("lists the registry's sessions, and the background job only the feed knows", async () => {
    const home = await makeClaudeHome(registryFiles);
    const { health, sessions } = await adapterFor(home).poll();

    expect(health).toEqual({
      id: "claude-code",
      label: "Claude Code",
      state: "ok",
      detail: HEALTHY,
      watching: watching(path.join(home, "sessions"), "every 2 seconds", "every 30 seconds"),
      checkedAt: now,
    });

    expect(
      sessions.map((session) => [
        session.name,
        session.status,
        session.waitingReason,
        session.surface,
        session.statusSince,
      ]),
    ).toEqual([
      ["demo-project", "working", undefined, "vscode", 1_700_000_030_000],
      ["demo-api", "needs-you", "permission", "desktop", 1_700_000_040_000],
      ["demo-docs", "needs-you", "question", "terminal", 1_700_000_050_000],
      ["demo-site", "idle", undefined, "vscode", 1_700_000_010_000],
      ["nightly-report", "needs-you", "other", "unknown", null],
    ]);

    expect(sessions[0]).toEqual({
      id: `claude-code:${ids.busy}`,
      source: "claude-code",
      surface: "vscode",
      name: "demo-project",
      cwd: "/Users/example/code/demo",
      project: "demo",
      status: "working",
      startedAt: 1_700_000_000_000,
      statusSince: 1_700_000_030_000,
      pid: pids.busy,
      alive: true,
      links: { open: `vscode://anthropic.claude-code/open?session=${ids.busy}` },
      stale: false,
    });
    expect(sessions[1]).toMatchObject({ waitingDetail: "permission prompt", links: {} });
    expect(sessions[2]).toMatchObject({ waitingDetail: "input needed", links: {} });
    expect(sessions[3]?.links.open).toBe(`vscode://anthropic.claude-code/open?session=${ids.idle}`);
    // The job has no process, so it has no pid and nothing says it is alive.
    expect("pid" in (sessions[4] ?? {})).toBe(false);
  });

  test("each result says which way it was read, so the poller never compares two ways", async () => {
    const home = await makeClaudeHome(registryFiles);
    expect((await adapterFor(home).poll()).basis).toBe("registry+feed");
    expect((await adapterFor(home, { run: fails("stopped with exit code 1") }).poll()).basis).toBe(
      "registry",
    );
    expect((await withoutBinary(await makeUserHome(registryFiles)).poll()).basis).toBe("registry");
    // A directory with no sessions folder cannot be relied on, so the command decides.
    expect((await adapterFor(await tempDir()).poll()).basis).toBe("feed");
    expect((await withoutBinary(await tempDir()).poll()).basis).toBeUndefined();
  });

  test("text printed after the JSON array changes nothing", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clean = await adapterFor(home).poll();
    const noisy = await adapterFor(home, { run: prints(feedJsonWithTrailingText) }).poll();
    expect(noisy).toEqual(clean);
    expect(noisy.basis).toBe("registry+feed");
    expect(noisy.sessions).toHaveLength(5);
  });

  test("an idle session whose status is a day old is stale", async () => {
    const day = 24 * 60 * 60 * 1000;
    const home = await makeClaudeHome({
      ...registryFiles,
      [`${pids.idle}.json`]: registryFile({
        pid: pids.idle,
        sessionId: ids.idle,
        status: "idle",
        startedAt: now - 2 * day,
        statusUpdatedAt: now - day,
      }),
    });
    const { sessions } = await adapterFor(home).poll();
    expect(sessions.map((session) => session.stale)).toEqual([false, false, false, true, false]);
  });

  test("an idle time that is older than the session itself is not believed, so it is not stale", async () => {
    const home = await makeClaudeHome({
      ...registryFiles,
      [`${pids.idle}.json`]: registryFile({
        pid: pids.idle,
        sessionId: ids.idle,
        name: "demo-site",
        status: "idle",
        statusUpdatedAt: now - 24 * 60 * 60 * 1000,
      }),
    });
    // The file says this session started under two minutes ago.
    const { sessions } = await adapterFor(home).poll();
    expect(sessions[3]).toMatchObject({
      name: "demo-site",
      surface: "vscode",
      statusSince: null,
      stale: false,
    });
  });

  test("an empty registry and an empty feed are a healthy source with no sessions", async () => {
    const home = await makeClaudeHome();
    expect(await adapterFor(home, { run: prints("[]\n") }).poll()).toMatchObject({
      health: { state: "ok", detail: HEALTHY },
      sessions: [],
      basis: "registry+feed",
    });
  });

  test("a session that two entries claim appears once", async () => {
    // Two registry files naming one session.
    const home = await makeClaudeHome({
      [`${pids.busy}.json`]: registryFile(),
      [`${pids.idle}.json`]: registryFile({ pid: pids.idle, name: "demo-project-copy" }),
    });
    const twice = JSON.stringify([
      { pid: pids.busy, sessionId: ids.busy, name: "demo-project", status: "busy" },
      { pid: pids.idle, sessionId: ids.busy, name: "demo-project-copy", status: "idle" },
    ]);
    const merged = await adapterFor(home, { run: prints(twice) }).poll();
    expect(merged.basis).toBe("registry+feed");
    expect(merged.sessions.map((session) => session.name)).toEqual(["demo-project"]);

    // And the same from the command alone.
    const listed = await adapterFor(await tempDir(), { run: prints(twice) }).poll();
    expect(listed.basis).toBe("feed");
    expect(listed.sessions.map((session) => session.name)).toEqual(["demo-project"]);
  });
});

describe("how often the claude command is run", () => {
  test("once on the first poll, then once every 30 seconds, however often it is polled", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    const { run, runs, calls } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });

    await adapter.poll();
    expect(runs()).toBe(1);
    expect(calls[0]).toEqual(FEED_ARGS);

    for (const at of [0, 2_000, 4_000, 16_000, 28_000, 29_900]) {
      clock.moveTo(at);
      expect((await adapter.poll()).basis).toBe("registry+feed");
    }
    expect(runs()).toBe(1);

    clock.moveTo(30_000);
    await adapter.poll();
    expect(runs()).toBe(2);

    clock.moveTo(58_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    clock.moveTo(60_000);
    await adapter.poll();
    expect(runs()).toBe(3);
  });

  test("a poll that comes late does not push the later runs back", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });

    await adapter.poll();
    clock.moveTo(31_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    // The next run is due 60 seconds after the first, not 30 after the late one.
    clock.moveTo(60_000);
    await adapter.poll();
    expect(runs()).toBe(3);
  });

  test("a poll that comes a few milliseconds early still counts as on time", async () => {
    // A timer can fire a millisecond before the clock says it should.
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });

    await adapter.poll();
    clock.moveTo(29_999);
    await adapter.poll();
    expect(runs()).toBe(2);
    // And it is not run again a moment later for the same beat.
    clock.moveTo(30_001);
    await adapter.poll();
    clock.moveTo(32_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    clock.moveTo(60_000);
    await adapter.poll();
    expect(runs()).toBe(3);
  });

  test("a clock that is set back does not stop the command being run", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });

    await adapter.poll();
    clock.moveTo(-3_600_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    clock.moveTo(-3_600_000 + 28_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    clock.moveTo(-3_600_000 + 30_000);
    await adapter.poll();
    expect(runs()).toBe(3);
  });

  test("after a long gap the runs start again from now and are not made up for", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });

    await adapter.poll();
    // The computer slept for ten minutes.
    clock.moveTo(600_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    clock.moveTo(602_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    clock.moveTo(630_000);
    await adapter.poll();
    expect(runs()).toBe(3);
  });

  test("while the registry folder cannot be read it is run every 5 seconds, and the source says so", async () => {
    // A named directory with no sessions folder, and a named binary to run.
    const home = await tempDir();
    const clock = handClock();
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });

    const first = await adapter.poll();
    expect(runs()).toBe(1);
    expect(first.basis).toBe("feed");
    expect(first.health.state).toBe("ok");
    expect(first.health.detail).toBe(
      `There is no session registry at ${path.join(home, "sessions")}, so sessions are listed with the claude command every 5 seconds instead. Their apps and status times are unknown.`,
    );
    expect(first.health.watching).toEqual(
      watching(path.join(home, "sessions"), "not found", "every 5 seconds"),
    );
    expect(first.sessions).toHaveLength(5);
    expect(first.sessions.every((session) => session.surface === "unknown")).toBe(true);
    expect(first.sessions.every((session) => session.statusSince === null)).toBe(true);

    clock.moveTo(4_000);
    await adapter.poll();
    expect(runs()).toBe(1);
    clock.moveTo(5_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    clock.moveTo(9_000);
    await adapter.poll();
    expect(runs()).toBe(2);
    clock.moveTo(10_000);
    await adapter.poll();
    expect(runs()).toBe(3);
  });

  test("polled every two seconds, a run due every 5 seconds still happens twelve times a minute", async () => {
    const home = await tempDir();
    const clock = handClock();
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });

    const ranAt: number[] = [];
    for (let at = 0; at < 60_000; at += 2_000) {
      clock.moveTo(at);
      const before = runs();
      await adapter.poll();
      if (runs() > before) ranAt.push(at / 1000);
    }
    // The first poll on or after each fifth second.
    expect(ranAt).toEqual([0, 6, 10, 16, 20, 26, 30, 36, 40, 46, 50, 56]);
  });

  test("when the binary is missing it is looked for only when a run is due, and nothing is run", async () => {
    const userHome = await makeUserHome(registryFiles);
    const clock = handClock();
    let looks = 0;
    let ran = 0;
    const adapter = withoutBinary(userHome, {
      now: clock.now,
      isExecutable: async () => {
        looks += 1;
        return false;
      },
      run: async () => {
        ran += 1;
        return { ok: true, stdout: "[]" };
      },
    });

    await adapter.poll();
    const looksPerSearch = looks;
    expect(looksPerSearch).toBeGreaterThan(0);

    for (const at of [2_000, 10_000, 28_000]) {
      clock.moveTo(at);
      await adapter.poll();
    }
    expect(looks).toBe(looksPerSearch);

    clock.moveTo(30_000);
    await adapter.poll();
    expect(looks).toBe(2 * looksPerSearch);
    expect(ran).toBe(0);
  });

  test("a binary too old to know --all is read the plain way, and the facts name what was run", async () => {
    const home = await makeClaudeHome(registryFiles);
    const calls: (readonly string[])[] = [];
    const { health, sessions } = await adapterFor(home, {
      run: async (_file, args) => {
        calls.push(args);
        return args.includes("--all")
          ? { ok: false, problem: "stopped with exit code 1", exitCode: 1 }
          : { ok: true, stdout: feedJson };
      },
    }).poll();

    expect(calls).toEqual([FEED_ARGS, FEED_ARGS_WITHOUT_ALL]);
    expect(sessions).toHaveLength(5);
    expect(health.detail).toBe(
      `${HEALTHY} This version of Claude Code cannot list background jobs whose process has ended.`,
    );
    expect(health.watching).toEqual(
      watching(
        path.join(home, "sessions"),
        "every 2 seconds",
        "every 30 seconds",
        "claude agents --json",
      ),
    );
  });
});

describe("the registry is read on every poll", () => {
  test("a status that changes, a session that starts and one that ends all show on the next poll, with no run", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    const alive = new Set<number>(Object.values(pids));
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, {
      now: clock.now,
      run,
      isAlive: (pid) => alive.has(pid),
    });
    const names = async () =>
      (await adapter.poll()).sessions.map((session) => [session.name, session.status]);

    expect(await names()).toEqual([
      ["demo-project", "working"],
      ["demo-api", "needs-you"],
      ["demo-docs", "needs-you"],
      ["demo-site", "idle"],
      ["nightly-report", "needs-you"],
    ]);

    // The idle session is given work.
    clock.moveTo(2_000);
    await writeFile(
      registryPath(home, `${pids.idle}.json`),
      registryFile({
        pid: pids.idle,
        sessionId: ids.idle,
        name: "demo-site",
        status: "busy",
        statusUpdatedAt: now + 1_500,
      }),
    );
    expect((await names())[3]).toEqual(["demo-site", "working"]);

    // A session starts.
    clock.moveTo(4_000);
    alive.add(5150);
    await writeFile(
      registryPath(home, "5150.json"),
      registryFile({
        pid: 5150,
        sessionId: "00000000-0000-4000-8000-00000000aaaa",
        name: "demo-new",
        status: "idle",
        startedAt: now + 3_000,
        statusUpdatedAt: now + 3_500,
      }),
    );
    expect((await names()).map(([name]) => name)).toContain("demo-new");

    // A session ends: its process goes, and its file with it.
    clock.moveTo(6_000);
    alive.delete(pids.permission);
    await rm(registryPath(home, `${pids.permission}.json`));
    expect((await names()).map(([name]) => name)).toEqual([
      "demo-project",
      "demo-docs",
      "demo-site",
      "demo-new",
      "nightly-report",
    ]);

    expect(runs()).toBe(1);
  });

  test("a session that starts while the command is running is not taken for one the registry lacks", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    const alive = new Set<number>(Object.values(pids));
    let started = false;
    const newEntry = {
      pid: 5150,
      cwd: "/Users/example/code/demo",
      kind: "interactive",
      startedAt: now + 29_500,
      sessionId: "00000000-0000-4000-8000-00000000aaaa",
      name: "demo-new",
      status: "busy",
    };
    const run: RunCommand = async () => {
      if (!started) return { ok: true, stdout: feedJson };
      // The registry was read a moment ago, before this session wrote its file.
      alive.add(5150);
      await writeFile(registryPath(home, "5150.json"), registryFile(newEntry));
      return { ok: true, stdout: JSON.stringify([...feedEntries, newEntry]) };
    };
    const adapter = adapterFor(home, { now: clock.now, run, isAlive: (pid) => alive.has(pid) });

    await adapter.poll();
    started = true;
    clock.moveTo(30_000);
    const { basis, sessions } = await adapter.poll();
    expect(basis).toBe("registry+feed");
    expect(sessions.map((session) => session.name)).toContain("demo-new");
  });

  test("a session whose process has gone is left out, though the last answer listed it", async () => {
    const home = await makeClaudeHome(registryFiles);
    const { sessions, basis } = await adapterFor(home, {
      isAlive: (pid) => pid !== pids.idle,
    }).poll();
    expect(basis).toBe("registry+feed");
    expect(sessions.map((session) => session.name)).toEqual([
      "demo-project",
      "demo-api",
      "demo-docs",
      "nightly-report",
    ]);
    expect(sessions.map((session) => session.alive)).toEqual([true, true, true, undefined]);
  });
});

describe("the feed's answer outranks the registry", () => {
  test("a registry session the answer did not list is left out", async () => {
    const home = await makeClaudeHome({
      ...registryFiles,
      "5150.json": registryFile({ pid: 5150, sessionId: "00000000-0000-4000-8000-00000000aaaa" }),
    });
    const { sessions, basis } = await adapterFor(home).poll();
    expect(basis).toBe("registry+feed");
    expect(sessions).toHaveLength(5);
    expect(sessions.some((session) => session.pid === 5150)).toBe(false);
  });

  test("unless it started under 10 seconds before the answer was asked for", async () => {
    expect(NEW_SESSION_GRACE_MS).toBe(10_000);
    const unlisted = (startedAt: number | undefined) =>
      registryFile({
        pid: 5150,
        sessionId: "00000000-0000-4000-8000-00000000aaaa",
        name: "demo-new",
        startedAt,
      });
    const listedWith = async (startedAt: number | undefined) => {
      const home = await makeClaudeHome({ ...registryFiles, "5150.json": unlisted(startedAt) });
      const { sessions } = await adapterFor(home).poll();
      return sessions.some((session) => session.name === "demo-new");
    };

    expect(await listedWith(now - 9_999)).toBe(true);
    expect(await listedWith(now - 10_000)).toBe(false);
    // One that does not say when it started cannot be called new.
    expect(await listedWith(undefined)).toBe(false);
  });

  test("it is listed once an answer lists it", async () => {
    const home = await makeClaudeHome({
      ...registryFiles,
      "5150.json": registryFile({
        pid: 5150,
        sessionId: "00000000-0000-4000-8000-00000000aaaa",
        name: "demo-late",
      }),
    });
    const clock = handClock();
    let listed: Record<string, unknown>[] = feedEntries;
    const { run } = countedRun(() => JSON.stringify(listed));
    const adapter = adapterFor(home, { now: clock.now, run });

    expect((await adapter.poll()).sessions.map((session) => session.name)).not.toContain(
      "demo-late",
    );
    listed = [
      ...feedEntries,
      {
        pid: 5150,
        cwd: "/Users/example/code/demo",
        kind: "interactive",
        startedAt: 1_700_000_000_000,
        sessionId: "00000000-0000-4000-8000-00000000aaaa",
        name: "demo-late",
        status: "busy",
      },
    ];
    clock.moveTo(30_000);
    expect((await adapter.poll()).sessions.map((session) => session.name)).toContain("demo-late");
  });
});

describe("when the registry cannot be relied on", () => {
  test("a running session the feed lists and the registry lacks moves the adapter to the feed, every 5 seconds, until they agree", async () => {
    // Claude Code has shipped registry files with stray characters in them.
    const home = await makeClaudeHome({
      ...registryFiles,
      [`${pids.busy}.json`]: `${registryFile()}}`,
    });
    const clock = handClock();
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });

    const first = await adapter.poll();
    expect(first.basis).toBe("feed");
    expect(first.health.state).toBe("ok");
    expect(first.health.detail).toBe(
      `The claude command lists a running session that the registry at ${path.join(home, "sessions")} does not have, so sessions are listed with the claude command every 5 seconds until the two agree.`,
    );
    expect(first.health.watching).toEqual(
      watching(path.join(home, "sessions"), "every 2 seconds", "every 5 seconds"),
    );
    // The malformed file costs one session its app and status time and nothing else.
    expect(first.sessions).toHaveLength(5);
    expect(first.sessions[0]).toMatchObject({
      name: "demo-project",
      status: "working",
      surface: "unknown",
      statusSince: null,
      links: {},
    });
    expect(first.sessions[3]).toMatchObject({ name: "demo-site", surface: "vscode" });

    clock.moveTo(4_000);
    await adapter.poll();
    expect(runs()).toBe(1);
    clock.moveTo(5_000);
    expect((await adapter.poll()).basis).toBe("feed");
    expect(runs()).toBe(2);

    // The file is written again, whole. The registry now agrees with the last
    // answer, so it is relied on again from the next poll, with no run needed.
    await writeFile(registryPath(home, `${pids.busy}.json`), registryFile());
    clock.moveTo(7_000);
    const agreed = await adapter.poll();
    expect(runs()).toBe(2);
    expect(agreed.basis).toBe("registry+feed");
    expect(agreed.health.detail).toBe(HEALTHY);
    expect(agreed.health.watching).toEqual(
      watching(path.join(home, "sessions"), "every 2 seconds", "every 30 seconds"),
    );
    expect(agreed.sessions[0]).toMatchObject({ name: "demo-project", surface: "vscode" });

    // And the command is back to every 30 seconds, counted from its last run.
    for (const at of [10_000, 15_000, 33_000]) {
      clock.moveTo(at);
      await adapter.poll();
    }
    expect(runs()).toBe(2);
    clock.moveTo(35_000);
    await adapter.poll();
    expect(runs()).toBe(3);
  });

  test("a file that stays malformed keeps the command at every 5 seconds", async () => {
    const home = await makeClaudeHome({
      ...registryFiles,
      [`${pids.busy}.json`]: `${registryFile()}}`,
    });
    const clock = handClock();
    const { run, runs } = countedRun();
    const adapter = adapterFor(home, { now: clock.now, run });
    for (const at of [0, 5_000, 10_000, 15_000]) {
      clock.moveTo(at);
      expect((await adapter.poll()).basis).toBe("feed");
    }
    expect(runs()).toBe(4);
  });

  test("a listed session whose process has gone is not one the registry lacks", async () => {
    const home = await makeClaudeHome({
      [`${pids.busy}.json`]: registryFile(),
    });
    const { basis, sessions } = await adapterFor(home, {
      isAlive: (pid) => pid === pids.busy,
    }).poll();
    expect(basis).toBe("registry+feed");
    expect(sessions.map((session) => session.name)).toEqual(["demo-project", "nightly-report"]);
  });

  test("a live session with a status the mapping does not know moves the adapter to the feed", async () => {
    const home = await makeClaudeHome({
      ...registryFiles,
      [`${pids.idle}.json`]: registryFile({
        pid: pids.idle,
        sessionId: ids.idle,
        name: "demo-site",
        status: "pondering",
      }),
    });
    const { health, sessions, basis } = await adapterFor(home).poll();
    expect(basis).toBe("feed");
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `A session in the registry at ${path.join(home, "sessions")} has a status Agent Lookout does not know, so sessions are listed with the claude command every 5 seconds instead.`,
    );
    expect(health.watching?.[3]).toEqual({ label: "Command run", value: "every 5 seconds" });
    // The feed's word for it is used.
    expect(sessions[3]).toMatchObject({ name: "demo-site", status: "idle", surface: "vscode" });
  });

  test("an entry that says nothing of its status is the same, once the session is no longer new", async () => {
    const silent = (startedAt: number) =>
      registryFile({
        pid: pids.idle,
        sessionId: ids.idle,
        name: "demo-site",
        status: undefined,
        startedAt,
        statusUpdatedAt: undefined,
      });

    const old = await makeClaudeHome({
      ...registryFiles,
      [`${pids.idle}.json`]: silent(now - 60_000),
    });
    expect((await adapterFor(old).poll()).basis).toBe("feed");

    // A session writes its file first and its status a moment later.
    const starting = await makeClaudeHome({
      ...registryFiles,
      [`${pids.idle}.json`]: silent(now - 3_000),
    });
    const { basis, sessions } = await adapterFor(starting).poll();
    expect(basis).toBe("registry+feed");
    expect(sessions[3]).toMatchObject({ name: "demo-site", status: "unknown" });
  });

  test("a helper process or a dead one with an unknown status does not count", async () => {
    const home = await makeClaudeHome({
      ...registryFiles,
      "5150.json": registryFile({
        pid: 5150,
        sessionId: "00000000-0000-4000-8000-00000000aaaa",
        kind: "daemon",
        status: "pondering",
      }),
      "5151.json": registryFile({
        pid: 5151,
        sessionId: "00000000-0000-4000-8000-00000000bbbb",
        status: "pondering",
      }),
    });
    const { basis } = await adapterFor(home, { isAlive: (pid) => pid !== 5151 }).poll();
    expect(basis).toBe("registry+feed");
  });

  test("with no answer from the command either, the registry is read as far as it goes and both problems are named", async () => {
    const userHome = await makeUserHome({
      ...registryFiles,
      [`${pids.idle}.json`]: registryFile({
        pid: pids.idle,
        sessionId: ids.idle,
        name: "demo-site",
        status: "pondering",
      }),
    });
    const { health, sessions, basis } = await withoutBinary(userHome).poll();
    expect(basis).toBe("registry");
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `${NOT_FOUND}, and a session in the registry at ~/.claude/sessions has a status Agent Lookout does not know. Sessions are read from the registry alone, and that status is shown as unknown.`,
    );
    expect(sessions.map((session) => [session.name, session.status])).toEqual([
      ["demo-project", "working"],
      ["demo-api", "needs-you"],
      ["demo-docs", "needs-you"],
      ["demo-site", "unknown"],
    ]);
  });
});

describe("background jobs, which the registry cannot hold once their process has gone", () => {
  const job = (overrides: Record<string, unknown>) => ({
    cwd: "/Users/example/code/demo-jobs",
    kind: "background",
    sessionId: ids.background,
    name: "nightly-report",
    id: "job-0001",
    ...overrides,
  });

  test("a failed job with no process is a failed row on every poll between runs of the command", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    const feed = JSON.stringify([
      ...feedEntries.slice(0, 4),
      job({ state: "failed", startedAt: now - 60_000 }),
    ]);
    const { run, runs } = countedRun(() => feed);
    const adapter = adapterFor(home, { now: clock.now, run });

    for (const at of [0, 2_000, 4_000, 28_000]) {
      clock.moveTo(at);
      const { sessions } = await adapter.poll();
      expect(sessions).toHaveLength(5);
      expect(sessions[4]).toMatchObject({ name: "nightly-report", status: "failed" });
      expect("pid" in (sessions[4] ?? {})).toBe(false);
    }
    expect(runs()).toBe(1);
  });

  test("a failed job whose process is still there is read from the registry, as failed and not idle", async () => {
    const home = await makeClaudeHome({
      [`${pids.idle}.json`]: registryFile({
        pid: pids.idle,
        sessionId: ids.background,
        kind: "bg",
        name: "nightly-report",
        status: "idle",
        state: "failed",
      }),
    });
    const feed = JSON.stringify([
      job({ pid: pids.idle, status: "idle", state: "failed", startedAt: now - 60_000 }),
    ]);
    const { sessions, basis } = await adapterFor(home, { run: prints(feed) }).poll();
    expect(basis).toBe("registry+feed");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "failed", pid: pids.idle, alive: true });
  });

  test("a job whose process ends between runs keeps its row, not alive, and then shows how it ended", async () => {
    const jobPid = 5150;
    const home = await makeClaudeHome({
      [`${jobPid}.json`]: registryFile({
        pid: jobPid,
        sessionId: ids.background,
        kind: "bg",
        name: "nightly-report",
        status: "busy",
        state: "working",
      }),
    });
    const clock = handClock();
    let jobAlive = true;
    let listed = [job({ pid: jobPid, status: "busy", state: "working", startedAt: now - 60_000 })];
    const { run, runs } = countedRun(() => JSON.stringify(listed));
    const adapter = adapterFor(home, {
      now: clock.now,
      run,
      isAlive: (pid) => pid !== jobPid || jobAlive,
    });
    const row = async () => {
      const { sessions, basis } = await adapter.poll();
      expect(basis).toBe("registry+feed");
      expect(sessions).toHaveLength(1);
      return sessions[0];
    };

    expect(await row()).toMatchObject({ status: "working", pid: jobPid, alive: true });

    // The process ends and its registry file goes with it. The command is not
    // due for another 26 seconds.
    clock.moveTo(4_000);
    jobAlive = false;
    await rm(registryPath(home, `${jobPid}.json`));
    listed = [job({ state: "failed", startedAt: now - 60_000 })];
    const between = await row();
    expect(between).toMatchObject({
      id: `claude-code:${ids.background}`,
      status: "working",
      pid: jobPid,
      alive: false,
    });
    expect(runs()).toBe(1);

    clock.moveTo(30_000);
    const after = await row();
    expect(after).toMatchObject({ id: `claude-code:${ids.background}`, status: "failed" });
    expect(runs()).toBe(2);
  });

  test("a job whose process went does not keep the live status that went with it", async () => {
    const jobPid = 5150;
    const home = await makeClaudeHome();
    const statusOf = async (entry: Record<string, unknown>) => {
      const feed = JSON.stringify([job({ pid: jobPid, startedAt: now - 60_000, ...entry })]);
      const { sessions, basis } = await adapterFor(home, {
        run: prints(feed),
        isAlive: (pid) => pid !== jobPid,
      }).poll();
      expect(basis).toBe("registry+feed");
      expect(sessions[0]).toMatchObject({ pid: jobPid, alive: false });
      return sessions[0]?.status;
    };

    // The process was idle, or waiting at a prompt, while the job was still
    // under way. The process is gone, so only the job's own state is left.
    expect(await statusOf({ status: "idle", state: "working" })).toBe("working");
    expect(await statusOf({ status: "waiting", state: "working" })).toBe("working");
    expect(await statusOf({ status: "busy", state: "failed" })).toBe("failed");
    expect(await statusOf({ status: "idle", state: "done" })).toBe("finished");
  });

  test("one that was over long before the collector started is left out", async () => {
    const home = await makeClaudeHome();
    const feed = JSON.stringify([
      job({ state: "done", startedAt: now - 3 * FINISHED_RETENTION_MS }),
      job({ sessionId: ids.busy, id: "job-0002", state: "working", startedAt: now - 60_000 }),
    ]);
    const { health, sessions } = await adapterFor(home, { run: prints(feed) }).poll();
    expect(health.state).toBe("ok");
    expect(sessions.map((session) => session.status)).toEqual(["working"]);
  });

  test("one seen to finish stays for 24 hours and is then left out", async () => {
    const home = await makeClaudeHome();
    const clock = handClock();
    let state = "working";
    const { run } = countedRun(() =>
      JSON.stringify([job({ state, startedAt: now - 3 * FINISHED_RETENTION_MS })]),
    );
    const adapter = adapterFor(home, { now: clock.now, run });
    const statuses = async () => (await adapter.poll()).sessions.map((session) => session.status);

    expect(await statuses()).toEqual(["working"]);
    state = "done";
    clock.moveTo(30_000);
    expect(await statuses()).toEqual(["finished"]);
    clock.moveTo(30_000 + FINISHED_RETENTION_MS - 1);
    expect(await statuses()).toEqual(["finished"]);
    clock.moveTo(30_000 + FINISHED_RETENTION_MS);
    expect(await statuses()).toEqual([]);
  });

  test("a run of the command that fails does not start the 24 hours again", async () => {
    const home = await makeClaudeHome();
    const clock = handClock();
    let state = "working";
    let failing = false;
    const run: RunCommand = async () =>
      failing
        ? { ok: false, problem: "did not answer within 5 seconds" }
        : { ok: true, stdout: JSON.stringify([job({ state, startedAt: now - 60_000 })]) };
    const adapter = adapterFor(home, { now: clock.now, run });
    const poll = async () => {
      const { sessions, basis } = await adapter.poll();
      return [basis, ...sessions.map((session) => session.status)];
    };

    expect(await poll()).toEqual(["registry+feed", "working"]);
    state = "done";
    clock.moveTo(30_000);
    expect(await poll()).toEqual(["registry+feed", "finished"]);

    // One run fails. With no answer the job cannot be shown.
    failing = true;
    clock.moveTo(60_000);
    expect(await poll()).toEqual(["registry"]);
    clock.moveTo(62_000);
    expect(await poll()).toEqual(["registry"]);

    failing = false;
    clock.moveTo(90_000);
    expect(await poll()).toEqual(["registry+feed", "finished"]);

    // Counted from when it was first seen over, not from when the command came back.
    clock.moveTo(30_000 + FINISHED_RETENTION_MS - 1);
    expect(await poll()).toEqual(["registry+feed", "finished"]);
    clock.moveTo(30_000 + FINISHED_RETENTION_MS);
    expect(await poll()).toEqual(["registry+feed"]);
  });
});

describe("through the poller", () => {
  function polled(adapter: ReturnType<typeof createClaudeCodeAdapter>, clock: () => number) {
    const events = createEventStore();
    const poller = createPoller({
      adapters: [adapter],
      events,
      history: createHistoryStore(),
      now: clock,
    });
    const told = () =>
      events
        .list()
        .map((event) => [event.sessionName, event.kind, event.from, event.to])
        .reverse();
    return { poller, told };
  }

  test("a job whose process ends and which then fails is one change of status, not an ending and an arrival", async () => {
    const jobPid = 5150;
    const home = await makeClaudeHome({
      [`${jobPid}.json`]: registryFile({
        pid: jobPid,
        sessionId: ids.background,
        kind: "bg",
        name: "nightly-report",
        status: "busy",
        state: "working",
      }),
    });
    const entry = {
      cwd: "/Users/example/code/demo-jobs",
      kind: "background",
      sessionId: ids.background,
      name: "nightly-report",
      id: "job-0001",
      startedAt: now - 60_000,
    };
    const clock = handClock();
    let jobAlive = true;
    let listed: Record<string, unknown>[] = [
      { ...entry, pid: jobPid, status: "busy", state: "working" },
    ];
    const { run } = countedRun(() => JSON.stringify(listed));
    const adapter = adapterFor(home, {
      now: clock.now,
      run,
      isAlive: (pid) => pid !== jobPid || jobAlive,
    });
    const { poller, told } = polled(adapter, clock.now);

    await poller.pollOnce();
    clock.moveTo(2_000);
    jobAlive = false;
    await rm(registryPath(home, `${jobPid}.json`));
    listed = [{ ...entry, state: "failed" }];
    await poller.pollOnce();
    expect(told()).toEqual([]);

    clock.moveTo(30_000);
    await poller.pollOnce();
    expect(told()).toEqual([["nightly-report", "status-changed", "working", "failed"]]);
    expect(poller.getSnapshot().sessions.map((session) => session.status)).toEqual(["failed"]);
  });

  test("moving between the three ways of reading produces no wave of events", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    let failing = false;
    const run: RunCommand = async () =>
      failing ? { ok: false, problem: "stopped with exit code 1" } : { ok: true, stdout: feedJson };
    const adapter = adapterFor(home, { now: clock.now, run });
    const { poller, told } = polled(adapter, clock.now);
    const basisNow = async () => {
      await poller.pollOnce();
      return poller.getSnapshot().sources[0]?.watching?.[3]?.value;
    };

    // The registry and the command together.
    expect(await basisNow()).toBe("every 30 seconds");
    expect(poller.getSnapshot().sessions).toHaveLength(5);

    // The command fails: the registry alone, without the job.
    failing = true;
    clock.moveTo(30_000);
    await poller.pollOnce();
    expect(poller.getSnapshot().sessions).toHaveLength(4);

    // The command is back.
    failing = false;
    clock.moveTo(60_000);
    await poller.pollOnce();
    expect(poller.getSnapshot().sessions).toHaveLength(5);

    // A registry file goes wrong. For one poll it could be one read while it
    // was being written, and what it held before stands in for it.
    await writeFile(registryPath(home, `${pids.busy}.json`), `${registryFile()}}`);
    clock.moveTo(62_000);
    expect(await basisNow()).toBe("every 30 seconds");
    expect(poller.getSnapshot().sessions).toHaveLength(5);

    // Still wrong at the next poll: the command alone.
    clock.moveTo(64_000);
    expect(await basisNow()).toBe("every 5 seconds");
    expect(poller.getSnapshot().sessions).toHaveLength(5);

    // And is put right.
    await writeFile(registryPath(home, `${pids.busy}.json`), registryFile());
    clock.moveTo(66_000);
    expect(await basisNow()).toBe("every 30 seconds");

    expect(told()).toEqual([]);
  });
});

describe("AGENT_LOOKOUT_CLAUDE_FEED", () => {
  /** A machine with a claude binary everywhere it could be, which says so if it is looked for or run. */
  function withFeedSet(userHome: string, value: string) {
    const looked: string[] = [];
    let ran = 0;
    const clock = handClock();
    const adapter = createClaudeCodeAdapter({
      env: { AGENT_LOOKOUT_CLAUDE_FEED: value, PATH: "/usr/local/bin:/usr/bin:/bin" },
      homeDir: userHome,
      now: clock.now,
      isAlive: () => true,
      isExecutable: async (candidate) => {
        looked.push(candidate);
        return true;
      },
      run: async () => {
        ran += 1;
        return { ok: true, stdout: feedJson };
      },
      readProcessStarts: noStartTimes,
    });
    return { adapter, clock, looked, ran: () => ran };
  }

  test.each(["off", "OFF", " Off "])(
    "set to %j, the claude command is never looked for or run",
    async (value) => {
      const userHome = await makeUserHome(registryFiles);
      const { adapter, clock, looked, ran } = withFeedSet(userHome, value);

      const { health, sessions, basis } = await adapter.poll();
      for (const at of [2_000, 30_000, 60_000, 300_000]) {
        clock.moveTo(at);
        await adapter.poll();
      }

      expect(ran()).toBe(0);
      expect(looked).toEqual([]);
      expect(basis).toBe("registry");
      expect(sessions.map((session) => session.name)).toEqual([
        "demo-project",
        "demo-api",
        "demo-docs",
        "demo-site",
      ]);
      expect(health.state).toBe("ok");
      expect(health.detail).toBe(
        `AGENT_LOOKOUT_CLAUDE_FEED is off, so sessions are read from the session registry alone. ${NO_ENDED_JOBS}`,
      );
      expect(health.watching).toEqual(watching("~/.claude/sessions", "every 2 seconds", "not run"));
      expect(adapter.lookingIn).toBe("Looking for sessions in ~/.claude/sessions.");
    },
  );

  test.each(["on", "", "0", "false", "offline"])(
    "set to %j, the command is run as usual",
    async (value) => {
      const userHome = await makeUserHome(registryFiles);
      const { adapter, ran } = withFeedSet(userHome, value);
      expect((await adapter.poll()).basis).toBe("registry+feed");
      expect(ran()).toBe(1);
    },
  );

  test("off with no registry either, the source is unavailable and says why", async () => {
    const userHome = await tempDir();
    const { adapter, ran } = withFeedSet(userHome, "off");
    const { health, sessions, basis } = await adapter.poll();
    expect(ran()).toBe(0);
    expect(sessions).toEqual([]);
    expect(basis).toBeUndefined();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toBe(
      "Claude Code sessions could not be read. AGENT_LOOKOUT_CLAUDE_FEED is off, so the claude command is not run, and there is no session registry at ~/.claude/sessions.",
    );
    expect(health.advice).toBeUndefined();
    expect(health.watching).toEqual(watching("~/.claude/sessions", "not found", "not run"));
  });

  test("off with a registry entry it cannot map, both are named", async () => {
    const userHome = await makeUserHome({
      [`${pids.busy}.json`]: registryFile({ status: "pondering" }),
    });
    const { adapter } = withFeedSet(userHome, "off");
    const { health, sessions, basis } = await adapter.poll();
    expect(basis).toBe("registry");
    expect(sessions.map((session) => session.status)).toEqual(["unknown"]);
    expect(health.detail).toBe(
      "AGENT_LOOKOUT_CLAUDE_FEED is off, so the claude command is not run, and a session in the registry at ~/.claude/sessions has a status Agent Lookout does not know. Sessions are read from the registry alone, and that status is shown as unknown.",
    );
  });
});

describe("AGENT_LOOKOUT_CLAUDE_HOME", () => {
  /** A machine where a claude binary is everywhere it could be, and says so if it is run. */
  function onlyHomeNamed(claudeHome: string) {
    const looked: string[] = [];
    let ran = 0;
    const clock = handClock();
    const adapter = createClaudeCodeAdapter({
      env: { AGENT_LOOKOUT_CLAUDE_HOME: claudeHome, PATH: "/usr/local/bin:/usr/bin:/bin" },
      homeDir: HOME,
      now: clock.now,
      isAlive: () => true,
      isExecutable: async (candidate) => {
        looked.push(candidate);
        return true;
      },
      run: async () => {
        ran += 1;
        return { ok: true, stdout: feedJson };
      },
      readProcessStarts: noStartTimes,
    });
    return { adapter, clock, looked, ran: () => ran };
  }

  test("set on its own, the claude command is not looked for or run, so no real session is listed", async () => {
    const home = await makeClaudeHome({
      [`${pids.idle}.json`]: registryFiles[`${pids.idle}.json`]!,
    });
    const { adapter, clock, looked, ran } = onlyHomeNamed(home);

    const { health, sessions, basis } = await adapter.poll();
    for (const at of [2_000, 30_000, 60_000]) {
      clock.moveTo(at);
      await adapter.poll();
    }

    // The command would have listed five sessions from the usual folder.
    expect(ran()).toBe(0);
    expect(looked).toEqual([]);
    expect(basis).toBe("registry");
    expect(sessions.map((session) => session.name)).toEqual(["demo-site"]);
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_CLAUDE_HOME is set, so sessions are read from the registry in that folder alone. ${WITHHELD}`,
    );
    expect(health.watching).toEqual(
      watching(path.join(home, "sessions"), "every 2 seconds", "not run"),
    );
    expect(adapter.lookingIn).toBe(`Looking for sessions in ${path.join(home, "sessions")}.`);
  });

  test("an empty sessions folder is the empty state", async () => {
    const home = await makeClaudeHome();
    const { adapter, ran } = onlyHomeNamed(home);
    expect(await adapter.poll()).toMatchObject({
      health: { state: "ok" },
      sessions: [],
      basis: "registry",
    });
    expect(ran()).toBe(0);
  });

  test("a directory with no sessions folder at all is the empty state too", async () => {
    const home = await tempDir();
    const { adapter, ran } = onlyHomeNamed(home);
    const { health, sessions, basis } = await adapter.poll();
    expect(ran()).toBe(0);
    expect(sessions).toEqual([]);
    expect(basis).toBe("registry");
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_CLAUDE_HOME is set to ${home}, which has no sessions folder, so no sessions are listed. ${WITHHELD}`,
    );
    expect(health.watching).toEqual(watching(path.join(home, "sessions"), "not found", "not run"));
  });

  test("with a binary that does not exist and an empty directory, it is still the empty state", async () => {
    // The recipe for seeing the dashboard with no sessions.
    const home = await tempDir();
    const { health, sessions, basis } = await adapterFor(home, {
      env: { AGENT_LOOKOUT_CLAUDE_HOME: home, AGENT_LOOKOUT_CLAUDE_BIN: "/nonexistent" },
      isExecutable: async () => false,
    }).poll();
    expect(sessions).toEqual([]);
    expect(basis).toBe("registry");
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_CLAUDE_BIN is set to /nonexistent, which is not a program this user can run, and AGENT_LOOKOUT_CLAUDE_HOME is set to ${home}, which has no sessions folder, so no sessions are listed.`,
    );
    expect(health.advice).toBeUndefined();
    expect(health.watching).toEqual(
      watching(path.join(home, "sessions"), "not found", "not found"),
    );
  });

  test("with a binary named as well, that binary is run", async () => {
    const home = await makeClaudeHome(registryFiles);
    let ranWith = "";
    const { basis } = await adapterFor(home, {
      run: async (file) => {
        ranWith = file;
        return { ok: true, stdout: feedJson };
      },
    }).poll();
    expect(asWritten(ranWith)).toBe(BIN);
    expect(basis).toBe("registry+feed");
  });
});

describe("when the claude binary is missing", () => {
  test("sessions come from the registry alone, and the source says so", async () => {
    const userHome = await makeUserHome(registryFiles);
    const { health, sessions, basis } = await withoutBinary(userHome).poll();

    expect(basis).toBe("registry");
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `${NOT_FOUND}, so sessions are read from the session registry alone. ${NO_ENDED_JOBS}`,
    );
    expect(health.watching).toEqual(watching("~/.claude/sessions", "every 2 seconds", "not found"));
    expect(
      sessions
        .map((session) => [session.name, session.status, session.waitingReason, session.surface])
        .sort(),
    ).toEqual([
      ["demo-api", "needs-you", "permission", "desktop"],
      ["demo-docs", "needs-you", "question", "terminal"],
      ["demo-project", "working", undefined, "vscode"],
      ["demo-site", "idle", undefined, "vscode"],
    ]);
  });

  test("the command is never run", async () => {
    const userHome = await makeUserHome(registryFiles);
    let ran = false;
    await withoutBinary(userHome, {
      run: async () => {
        ran = true;
        return { ok: true, stdout: "[]" };
      },
    }).poll();
    expect(ran).toBe(false);
  });

  test("a binary named by AGENT_LOOKOUT_CLAUDE_BIN that is not there is reported by name", async () => {
    const home = await makeClaudeHome(registryFiles);
    const { health, sessions } = await adapterFor(home, {
      env: { AGENT_LOOKOUT_CLAUDE_HOME: home, AGENT_LOOKOUT_CLAUDE_BIN: "/nowhere/claude" },
      isExecutable: async () => false,
    }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_CLAUDE_BIN is set to /nowhere/claude, which is not a program this user can run, so sessions are read from the session registry alone. ${NO_ENDED_JOBS}`,
    );
    // The sessions are there to see, so there is nothing the person has to do.
    expect(health.advice).toBeUndefined();
    expect(sessions).toHaveLength(4);
  });

  test("registry files left by dead processes are not sessions", async () => {
    const userHome = await makeUserHome(registryFiles);
    const { sessions } = await withoutBinary(userHome, {
      isAlive: (pid) => pid === pids.busy || pid === pids.question,
    }).poll();
    expect(sessions.map((session) => session.name).sort()).toEqual(["demo-docs", "demo-project"]);
    expect(sessions.every((session) => session.alive === true)).toBe(true);
  });

  test("a leftover file whose pid now belongs to another program is not a session", async () => {
    // The pid is alive, so liveness alone would show the crashed session as
    // running, with its old status and a jump link.
    const userHome = await makeUserHome(registryFiles);
    const asked: number[][] = [];
    const { sessions } = await withoutBinary(userHome, {
      readProcessStarts: async (asking) => {
        asked.push([...asking].sort());
        return new Map([
          [pids.busy, "Tue Nov 14 22:13:20 2023"],
          // Started long after the registry file says its process did.
          [pids.permission, "Sat Oct  3 09:12:00 2026"],
          // pids.question: ps says nothing, so nothing is concluded.
          [pids.idle, "Tue Nov 14 22:13:20 2023"],
        ]);
      },
    }).poll();

    expect(asked).toEqual([Object.values(pids).sort()]);
    expect(sessions.map((session) => session.name).sort()).toEqual([
      "demo-docs",
      "demo-project",
      "demo-site",
    ]);
  });

  test("the same leftover is left out when the command runs too, and does not count as a session the registry lacks", async () => {
    const home = await makeClaudeHome(registryFiles);
    // The command no longer lists the crashed session.
    const feed = JSON.stringify(feedEntries.filter((entry) => entry.pid !== pids.permission));
    const { sessions, basis } = await adapterFor(home, {
      run: prints(feed),
      readProcessStarts: async () => new Map([[pids.permission, "Sat Oct  3 09:12:00 2026"]]),
    }).poll();
    expect(basis).toBe("registry+feed");
    expect(sessions.map((session) => session.name)).toEqual([
      "demo-project",
      "demo-docs",
      "demo-site",
      "nightly-report",
    ]);
  });

  test("an entry that recorded no start time is kept", async () => {
    const userHome = await makeUserHome({
      [`${pids.busy}.json`]: registryFile({ procStart: undefined }),
    });
    const { sessions } = await withoutBinary(userHome, {
      readProcessStarts: async () => new Map([[pids.busy, "Sat Oct  3 09:12:00 2026"]]),
    }).poll();
    expect(sessions).toHaveLength(1);
  });

  test("malformed registry files are skipped silently", async () => {
    const userHome = await makeUserHome({
      ...registryFiles,
      [`${pids.busy}.json`]: `${registryFile()}}`,
      [`${pids.idle}.json`]: "",
      "5150.json": "not json at all",
    });
    const { health, sessions } = await withoutBinary(userHome).poll();
    expect(health.state).toBe("ok");
    expect(sessions.map((session) => session.name).sort()).toEqual(["demo-api", "demo-docs"]);
  });

  test("a registry entry with no session id is a helper process, not a session", async () => {
    const userHome = await makeUserHome({
      [`${pids.busy}.json`]: registryFile(),
      "5150.json": registryFile({
        pid: 5150,
        sessionId: undefined,
        kind: "daemon",
        name: undefined,
      }),
    });
    const { sessions } = await withoutBinary(userHome).poll();
    expect(sessions.map((session) => session.pid)).toEqual([pids.busy]);
  });

  test("only interactive and background entries are sessions, whatever else names a session id", async () => {
    const entry = (pid: number, kind: string | undefined) =>
      registryFile({ pid, sessionId: `00000000-0000-4000-8000-00000000${pid}`, kind });
    const userHome = await makeUserHome({
      "5150.json": entry(5150, "interactive"),
      "5151.json": entry(5151, "bg"),
      "5152.json": entry(5152, "daemon"),
      "5153.json": entry(5153, "daemon-worker"),
      "5154.json": entry(5154, "something-new"),
      // An entry that names no kind is kept: nothing says it is a helper.
      "5155.json": entry(5155, undefined),
    });
    const { sessions } = await withoutBinary(userHome).poll();
    expect(sessions.map((session) => session.pid).sort()).toEqual([5150, 5151, 5155]);
  });

  test("a session whose registry status is shell is working, not unknown", async () => {
    const userHome = await makeUserHome({
      [`${pids.busy}.json`]: registryFile({ status: "shell" }),
    });
    const { sessions } = await withoutBinary(userHome).poll();
    expect(sessions.map((session) => session.status)).toEqual(["working"]);

    // And it is not a status that sets the registry aside when the command runs.
    const home = await makeClaudeHome({ [`${pids.busy}.json`]: registryFile({ status: "shell" }) });
    const merged = await adapterFor(home, {
      run: prints(JSON.stringify([feedEntries[0]])),
    }).poll();
    expect(merged.basis).toBe("registry+feed");
    expect(merged.sessions[0]).toMatchObject({ name: "demo-project", status: "working" });
  });

  test("with no registry either, the source is unavailable and names where it looked", async () => {
    const userHome = await tempDir();
    const { health, sessions } = await withoutBinary(userHome).poll();
    expect(sessions).toEqual([]);
    expect(health).toEqual({
      id: "claude-code",
      label: "Claude Code",
      state: "unavailable",
      detail: `Claude Code sessions could not be read. ${NOT_FOUND}, and there is no session registry at ~/.claude/sessions.`,
      watching: watching("~/.claude/sessions", "not found", "not found"),
      checkedAt: now,
    });
    // Installing Claude Code is what would help here, and the dashboard says that itself.
    expect("advice" in health).toBe(false);
  });

  test("when the cause is a bad AGENT_LOOKOUT_CLAUDE_BIN, the advice is to correct the variable", async () => {
    const userHome = await tempDir();
    const { health } = await withoutBinary(userHome, {
      env: { AGENT_LOOKOUT_CLAUDE_BIN: "/nowhere/claude", PATH: "/usr/bin:/bin" },
    }).poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toBe(
      "Claude Code sessions could not be read. AGENT_LOOKOUT_CLAUDE_BIN is set to /nowhere/claude, which is not a program this user can run, and there is no session registry at ~/.claude/sessions.",
    );
    expect(health.advice).toBe("Correct AGENT_LOOKOUT_CLAUDE_BIN, or unset it.");
    // Said once, in the advice.
    expect(health.detail).not.toContain("Correct");
  });
});

describe("when the claude command fails", () => {
  test("sessions come from the registry alone, the source says why, and it is tried again 30 seconds later", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    let ran = 0;
    let failing = true;
    const run: RunCommand = async () => {
      ran += 1;
      return failing
        ? { ok: false, problem: "did not answer within 5 seconds" }
        : { ok: true, stdout: feedJson };
    };
    const adapter = adapterFor(home, { now: clock.now, run });

    const { health, sessions, basis } = await adapter.poll();
    expect(basis).toBe("registry");
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `The claude agents --json command did not answer within 5 seconds, so sessions are read from the session registry alone. ${NO_ENDED_JOBS}`,
    );
    expect(health.watching).toEqual(
      watching(path.join(home, "sessions"), "every 2 seconds", "every 30 seconds"),
    );
    expect(sessions).toHaveLength(4);

    // Not sooner: the registry can be relied on, so there is no hurry.
    failing = false;
    for (const at of [2_000, 5_000, 10_000, 28_000]) {
      clock.moveTo(at);
      expect((await adapter.poll()).basis).toBe("registry");
    }
    expect(ran).toBe(1);

    clock.moveTo(30_000);
    const recovered = await adapter.poll();
    expect(ran).toBe(2);
    expect(recovered.basis).toBe("registry+feed");
    expect(recovered.sessions).toHaveLength(5);
  });

  test("output that is not a session list is a failure too", async () => {
    const home = await makeClaudeHome(registryFiles);
    const { health, sessions } = await adapterFor(home, {
      run: prints("Please log in to continue.\n"),
    }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain(
      "The claude agents --json command did not print a list of sessions",
    );
    expect(sessions).toHaveLength(4);
  });

  test("a list in which nothing reads as a session is a failure, and the registry is used alone", async () => {
    // Taking it for an empty list would report every session as ended.
    const home = await makeClaudeHome(registryFiles);
    const { health, sessions, basis } = await adapterFor(home, {
      run: prints('[12345, "wrapper started"]\n'),
    }).poll();
    expect(basis).toBe("registry");
    expect(health.detail).toContain("printed a list, but nothing in it could be read as a session");
    expect(sessions).toHaveLength(4);
  });

  test("with no registry either, the source is unavailable, and the command is tried every 5 seconds", async () => {
    const userHome = await tempDir();
    const clock = handClock();
    let ran = 0;
    const adapter = withoutBinary(userHome, {
      env: { AGENT_LOOKOUT_CLAUDE_BIN: BIN },
      now: clock.now,
      isExecutable: async (candidate) => asWritten(candidate) === BIN,
      run: async () => {
        ran += 1;
        return { ok: false, problem: "stopped with exit code 1" };
      },
    });
    const { health, sessions } = await adapter.poll();
    expect(sessions).toEqual([]);
    expect(health.state).toBe("unavailable");
    expect(health.detail).toBe(
      "Claude Code sessions could not be read. The claude agents --json command stopped with exit code 1, and there is no session registry at ~/.claude/sessions.",
    );
    // The binary is there and runs, so the variable is not what is wrong.
    expect(health.advice).toBeUndefined();
    expect(health.watching).toEqual(watching("~/.claude/sessions", "not found", "every 5 seconds"));

    clock.moveTo(4_000);
    await adapter.poll();
    expect(ran).toBe(1);
    clock.moveTo(5_000);
    await adapter.poll();
    expect(ran).toBe(2);
  });
});

describe("what the adapter says about itself", () => {
  test("no detail, in any way of reading, uses the word surface", async () => {
    const home = await makeClaudeHome(registryFiles);
    const malformed = await makeClaudeHome({
      ...registryFiles,
      [`${pids.busy}.json`]: `${registryFile()}}`,
    });
    const odd = await makeClaudeHome({
      [`${pids.busy}.json`]: registryFile({ status: "pondering" }),
    });
    const results = await Promise.all([
      adapterFor(home).poll(),
      adapterFor(home, { run: fails("stopped with exit code 1") }).poll(),
      adapterFor(home, { env: { AGENT_LOOKOUT_CLAUDE_HOME: home } }).poll(),
      adapterFor(home, {
        env: {
          AGENT_LOOKOUT_CLAUDE_HOME: home,
          AGENT_LOOKOUT_CLAUDE_BIN: BIN,
          AGENT_LOOKOUT_CLAUDE_FEED: "off",
        },
      }).poll(),
      adapterFor(malformed).poll(),
      adapterFor(odd).poll(),
      adapterFor(await tempDir()).poll(),
      withoutBinary(await makeUserHome(registryFiles)).poll(),
      withoutBinary(await tempDir()).poll(),
    ]);

    expect(results.map((result) => result.basis)).toEqual([
      "registry+feed",
      "registry",
      "registry",
      "registry",
      "feed",
      "feed",
      "feed",
      "registry",
      undefined,
    ]);
    for (const { health } of results) {
      expect(health.detail).toBeTruthy();
      expect(health.detail).not.toMatch(/surface/i);
      expect(health.watching?.map((fact) => fact.label)).toEqual([
        "Registry folder",
        "Registry read",
        "Command",
        "Command run",
        "Transcript read",
      ]);
    }
  });

  test("when all is well the sentence names neither the folder nor the command, which the facts carry", async () => {
    const home = await makeClaudeHome(registryFiles);
    const { health } = await adapterFor(home).poll();
    expect(health.detail).not.toContain(home);
    expect(health.detail).not.toContain("--json");
    expect(health.detail).not.toContain("claude agents");
    expect(health.watching).toContainEqual({
      label: "Registry folder",
      value: path.join(home, "sessions"),
    });
    expect(health.watching).toContainEqual({
      label: "Command",
      value: "claude agents --json --all",
    });
  });

  test("the facts state the intervals the adapter was given", async () => {
    const home = await makeClaudeHome(registryFiles);
    const { health } = await adapterFor(home, {
      pollIntervalMs: 1_000,
      feedIntervalMs: 90_000,
    }).poll();
    expect(health.watching).toEqual(
      watching(path.join(home, "sessions"), "every second", "every 90 seconds"),
    );
  });
});

describe("what the adapter touches", () => {
  test("it never opens a .key file, whichever way it is reading", async () => {
    const keys = {
      [`${pids.busy}.0f3a9c1d5e7b.key`]: "not-for-reading",
      [`${pids.permission}.9a8b7c6d5e4f.key`]: "not-for-reading",
      [`${pids.question}.1a2b3c4d5e6f.key`]: "not-for-reading",
      [`${pids.idle}.6f5e4d3c2b1a.key`]: "not-for-reading",
      "5150.aa11bb22cc33.key": "not-for-reading",
    };
    const home = await makeClaudeHome({ ...registryFiles, ...keys });
    const malformed = await makeClaudeHome({
      ...registryFiles,
      ...keys,
      [`${pids.busy}.json`]: `${registryFile()}}`,
    });
    const opened: string[] = [];
    const registryIo: RegistryIo = {
      readdir: (dir) => readdir(dir),
      readFile: (file) => {
        opened.push(file);
        return readFile(file, "utf8");
      },
    };

    const bases = [
      // The registry with the command, twice so that a poll between runs is covered.
      await (async () => {
        const adapter = adapterFor(home, { registryIo });
        await adapter.poll();
        return (await adapter.poll()).basis;
      })(),
      (await adapterFor(home, { env: { AGENT_LOOKOUT_CLAUDE_HOME: home }, registryIo }).poll())
        .basis,
      (await adapterFor(home, { run: fails("stopped with exit code 1"), registryIo }).poll()).basis,
      (await adapterFor(malformed, { registryIo }).poll()).basis,
    ];
    expect(bases).toEqual(["registry+feed", "registry", "registry", "feed"]);

    expect(opened.length).toBeGreaterThanOrEqual(4 * bases.length);
    expect(opened.every((file) => file.endsWith(".json"))).toBe(true);
    expect(opened.some((file) => file.includes(".key"))).toBe(false);
  });

  test("it never throws: an unexpected failure becomes an error state with no stack trace", async () => {
    const home = await makeClaudeHome(registryFiles);
    const clock = handClock();
    let ran = 0;
    const adapter = adapterFor(home, {
      now: clock.now,
      run: () => {
        ran += 1;
        throw new Error("boom at /Users/example/secret/path.ts:12:3");
      },
    });
    const result = await adapter.poll();
    expect(result).toEqual({
      health: {
        id: "claude-code",
        label: "Claude Code",
        state: "error",
        detail: "Something unexpected went wrong while reading Claude Code sessions.",
        watching: watching(path.join(home, "sessions"), "every 2 seconds", "every 30 seconds"),
        checkedAt: now,
      },
      sessions: [],
    });

    // The polls after it read the registry, and the command waits its turn.
    clock.moveTo(2_000);
    const next = await adapter.poll();
    expect(ran).toBe(1);
    expect(next.basis).toBe("registry");
    expect(next.sessions).toHaveLength(4);
    expect(next.health.detail).not.toContain("boom");
    expect(next.health.detail).not.toContain("secret");
  });
});

/** The feed of a session in this very process, one whose process has exited, and a failed job. */
function realFeed(exited: number | undefined): string {
  return JSON.stringify([
    {
      pid: process.pid,
      cwd: "/Users/example/code/demo",
      kind: "interactive",
      startedAt: 1_700_000_000_000,
      sessionId: ids.busy,
      name: "demo-project",
      status: "busy",
    },
    {
      pid: exited,
      cwd: "/Users/example/code/demo-site",
      kind: "interactive",
      startedAt: 1_700_000_003_000,
      sessionId: ids.idle,
      name: "demo-site",
      status: "idle",
    },
    {
      cwd: "/Users/example/code/demo-jobs",
      kind: "background",
      startedAt: Date.now() - 60_000,
      sessionId: ids.background,
      name: "nightly-report",
      id: "job-0001",
      state: "failed",
    },
  ]);
}

// Each stand-in claude here is a POSIX sh script, which Windows cannot run, and
// the start time of a process comes from ps, which Windows has not. Windows has
// its own checks after these, with a stand-in claude.exe.
describe.skipIf(process.platform === "win32")(
  "end to end, with a real program and real processes",
  () => {
    test("runs the named binary, reads past its trailing text and checks real pids", async () => {
      const exited = spawnSync(process.execPath, ["-e", ""]).pid;
      const feed = realFeed(exited);
      const stub = await writeStub(`cat <<'JSON'\n${feed}\nJSON\necho '[tracker] 2 sessions {ok}'`);
      // What Claude Code would have recorded for this very process.
      const procStart = (await readProcessStartsWithPs([process.pid])).get(process.pid);
      const home = await makeClaudeHome({
        [`${process.pid}.json`]: registryFile({ pid: process.pid, procStart }),
        [`${exited}.json`]: registryFile({
          pid: exited,
          sessionId: ids.idle,
          name: "demo-site",
          entrypoint: "claude-desktop",
        }),
        [`${process.pid}.0f3a9c1d5e7b.key`]: "not-for-reading",
      });

      const adapter = createClaudeCodeAdapter({
        env: {
          AGENT_LOOKOUT_CLAUDE_HOME: home,
          AGENT_LOOKOUT_CLAUDE_BIN: stub,
          PATH: "/usr/bin:/bin",
        },
        homeDir: path.dirname(home),
      });
      const { health, sessions, basis } = await adapter.poll();

      expect(health.state).toBe("ok");
      expect(basis).toBe("registry+feed");
      expect(
        sessions.map((session) => [session.name, session.status, session.surface, session.alive]),
      ).toEqual([
        ["demo-project", "working", "vscode", true],
        // The session whose process has exited is left out, and the job is there.
        ["nightly-report", "failed", "unknown", undefined],
      ]);
    });

    test("a real binary that fails leaves a real registry, without its dead processes", async () => {
      const exited = spawnSync(process.execPath, ["-e", ""]).pid;
      const stub = await writeStub("echo 'something went wrong' >&2\nexit 1");
      const procStart = (await readProcessStartsWithPs([process.pid])).get(process.pid);
      const home = await makeClaudeHome({
        [`${process.pid}.json`]: registryFile({ pid: process.pid, status: "idle", procStart }),
        [`${exited}.json`]: registryFile({ pid: exited, sessionId: ids.idle }),
      });

      const adapter = createClaudeCodeAdapter({
        env: { AGENT_LOOKOUT_CLAUDE_HOME: home, AGENT_LOOKOUT_CLAUDE_BIN: stub },
        homeDir: path.dirname(home),
      });
      const { health, sessions } = await adapter.poll();

      expect(health.state).toBe("ok");
      expect(health.detail).toContain("The claude agents --json command stopped with exit code 1");
      expect(sessions.map((session) => [session.pid, session.status, session.alive])).toEqual([
        [process.pid, "idle", true],
        // The entry for the exited process is a crash leftover and is left out.
      ]);
    });

    test("a real binary is run with the two quiet variables and with the person's proxy settings as they are", async () => {
      const stub = await writeStub(
        `printf '[{"sessionId":"%s|%s|%s|%s"}]' "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" "$DISABLE_AUTOUPDATER" "$HTTPS_PROXY" "$NO_PROXY"`,
      );
      const home = await tempDir();
      const adapter = createClaudeCodeAdapter({
        env: {
          AGENT_LOOKOUT_CLAUDE_HOME: home,
          AGENT_LOOKOUT_CLAUDE_BIN: stub,
          PATH: "/usr/bin:/bin",
          HTTPS_PROXY: "http://proxy.example:8080",
          NO_PROXY: "localhost",
        },
        homeDir: path.dirname(home),
      });
      const { sessions } = await adapter.poll();
      expect(sessions.map((session) => session.id)).toEqual([
        "claude-code:1|1|http://proxy.example:8080|localhost",
      ]);
    });

    test("a real leftover file whose pid is now a different live process is left out", async () => {
      // This test process stands in for the unrelated program that was given the
      // crashed session's pid. It is alive, and it did not start in 2023.
      const home = await makeClaudeHome({
        [`${process.pid}.json`]: registryFile({
          pid: process.pid,
          sessionId: ids.permission,
          status: "waiting",
          waitingFor: "permission prompt",
          procStart: "Tue Nov 14 22:13:20 2023",
        }),
      });
      const adapter = createClaudeCodeAdapter({
        env: { AGENT_LOOKOUT_CLAUDE_HOME: home },
        homeDir: path.dirname(home),
      });
      const { health, sessions } = await adapter.poll();
      expect(health.state).toBe("ok");
      expect(sessions).toEqual([]);
    });

    test("a real registry with a link to a .key file and a named pipe in it is read without either", async () => {
      const procStart = (await readProcessStartsWithPs([process.pid])).get(process.pid);
      const home = await makeClaudeHome({
        [`${process.pid}.json`]: registryFile({ pid: process.pid, procStart }),
        "7.aaaa.key": registryFile({
          pid: process.ppid,
          name: "key-file-content",
          procStart: undefined,
        }),
      });
      const sessionsDir = path.join(home, "sessions");
      await symlink("7.aaaa.key", path.join(sessionsDir, "7.json"));
      execFileSync("mkfifo", [path.join(sessionsDir, "1.json")]);

      const adapter = createClaudeCodeAdapter({
        env: { AGENT_LOOKOUT_CLAUDE_HOME: home },
        homeDir: path.dirname(home),
      });
      const started = Date.now();
      const { sessions } = await adapter.poll();
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(sessions.map((session) => session.name)).toEqual(["demo-project"]);
    }, 8_000);
  },
);

describe("end to end, on any system", () => {
  test("a real registry with a link to a .key file in it is read without it", async () => {
    const home = await makeClaudeHome({
      [`${process.pid}.json`]: registryFile({ pid: process.pid }),
      "7.aaaa.key": registryFile({ pid: process.ppid, name: "key-file-content" }),
    });
    await symlink("7.aaaa.key", path.join(home, "sessions", "7.json"));

    const adapter = createClaudeCodeAdapter({
      env: { AGENT_LOOKOUT_CLAUDE_HOME: home },
      homeDir: path.dirname(home),
      readProcessStarts: noStartTimes,
    });
    const { sessions } = await adapter.poll();
    expect(sessions.map((session) => session.name)).toEqual(["demo-project"]);
  });
});

describe.runIf(process.platform === "win32")(
  "end to end on Windows, with a stand-in claude.exe",
  () => {
    test("runs the named claude.exe, reads past its trailing text and checks real pids", async () => {
      const exited = spawnSync(process.execPath, ["-e", ""]).pid;
      const stub = await writeWindowsStub(
        `write(${JSON.stringify(realFeed(exited))} + "\\n[tracker] 2 sessions {ok}\\n");`,
      );
      // Claude Code on Windows records no start time Agent Lookout can compare.
      const home = await makeClaudeHome({
        [`${process.pid}.json`]: registryFile({ pid: process.pid, procStart: undefined }),
        [`${exited}.json`]: registryFile({
          pid: exited,
          sessionId: ids.idle,
          name: "demo-site",
          entrypoint: "claude-desktop",
          procStart: undefined,
        }),
        [`${process.pid}.0f3a9c1d5e7b.key`]: "not-for-reading",
      });

      const adapter = createClaudeCodeAdapter({
        env: {
          ...process.env,
          ...stub.env,
          AGENT_LOOKOUT_CLAUDE_HOME: home,
          AGENT_LOOKOUT_CLAUDE_BIN: stub.file,
        },
        homeDir: path.dirname(home),
        feedTimeoutMs: 20_000,
      });
      const { health, sessions, basis } = await adapter.poll();

      expect(health.state).toBe("ok");
      expect(basis).toBe("registry+feed");
      expect(health.watching).toContainEqual({ label: "Command run", value: "every 30 seconds" });
      expect(
        sessions.map((session) => [session.name, session.status, session.surface, session.alive]),
      ).toEqual([
        ["demo-project", "working", "vscode", true],
        // The session whose process has exited is left out, and the job is there.
        ["nightly-report", "failed", "unknown", undefined],
      ]);
      // Nothing is offered Stop on Windows.
      expect(sessions.filter((session) => session.stop !== undefined)).toEqual([]);
    });

    test("a real claude.exe that fails leaves a real registry, without its dead processes", async () => {
      const exited = spawnSync(process.execPath, ["-e", ""]).pid;
      const stub = await writeWindowsStub("process.exit(1);");
      const home = await makeClaudeHome({
        [`${process.pid}.json`]: registryFile({
          pid: process.pid,
          status: "idle",
          procStart: undefined,
        }),
        [`${exited}.json`]: registryFile({
          pid: exited,
          sessionId: ids.idle,
          procStart: undefined,
        }),
      });

      const adapter = createClaudeCodeAdapter({
        env: {
          ...process.env,
          ...stub.env,
          AGENT_LOOKOUT_CLAUDE_HOME: home,
          AGENT_LOOKOUT_CLAUDE_BIN: stub.file,
        },
        homeDir: path.dirname(home),
        feedTimeoutMs: 20_000,
      });
      const { health, sessions } = await adapter.poll();

      expect(health.state).toBe("ok");
      expect(health.detail).toContain("The claude agents --json command stopped with exit code 1");
      expect(sessions.map((session) => [session.pid, session.status, session.alive])).toEqual([
        [process.pid, "idle", true],
      ]);
    });
  },
);
