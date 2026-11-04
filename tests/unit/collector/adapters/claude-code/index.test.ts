import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_WINDOWS_CAPABILITIES,
  createClaudeCodeAdapter,
  FEED_FALLBACK_INTERVAL_MS,
  FEED_INTERVAL_MS,
} from "@collector/adapters/claude-code/index";
import type { RegistryIo } from "@collector/adapters/claude-code/registry";
import { createStopTargets } from "@collector/actions/stopTargets";
import { createTabFinder } from "@collector/terminal/tabFinder";
import type { TerminalTab } from "@collector/terminal/terminalTabs";
import { createPaneFinder } from "@collector/tmux/paneFinder";
import type { TmuxPane } from "@collector/tmux/panes";
import { createTmuxRunner, tmuxInstalled } from "@collector/tmux/program";
import type { SourceFact } from "@core/sessions/session";
import { HOME, ids, pids, registryFile, registryFiles } from "@tests/fixtures/claudeCode";
import {
  adapterFor,
  fails,
  now,
  prints,
  PROCESS_CHECK,
  PROCESS_CHECK_RUN,
  watching,
  WITHHELD,
} from "@tests/support/adapters/claudeCodeAdapter";
import {
  PANE_CHECK,
  PANE_CHECK_RUN,
  PANE_PARENT_CHECK,
  PANE_PARENT_CHECK_RUN,
  standInPaneFinder,
} from "@tests/support/node/tmux";
import { asWritten } from "@tests/support/paths";

// The adapter with every outside thing handed in: the registry folder is a
// stand-in that is never on disk, and no command or process is real. The tests
// that give it real folders and real programs are in tests/integration.

/** A registry folder that exists but cannot be listed. */
const unlistable: RegistryIo = {
  readdir: async () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  },
  readFile: async () => "",
};

describe("the Claude Code adapter", () => {
  test("has the id and label of its source and says where it looks", () => {
    const adapter = createClaudeCodeAdapter({ env: {}, homeDir: HOME });
    expect(adapter.id).toBe("claude-code");
    expect(adapter.label).toBe("Claude Code");
    expect(adapter.lookingIn).toBe(
      "Looking for sessions in ~/.claude/sessions and with claude agents --json --all.",
    );
  });
});

describe("how often the claude command is run", () => {
  test("the intervals are 30 seconds, and 5 seconds while the registry cannot be relied on", () => {
    expect(FEED_INTERVAL_MS).toBe(30_000);
    expect(FEED_FALLBACK_INTERVAL_MS).toBe(5_000);
  });

  test("a registry folder that cannot be listed moves the adapter to the command every 5 seconds, and the source says so in its own words", async () => {
    const { health, basis } = await adapterFor("/Users/example/elsewhere", {
      registryIo: unlistable,
    }).poll();
    expect(basis).toBe("feed");
    expect(health.detail).toBe(
      "The session registry at ~/elsewhere/sessions could not be read, so sessions are listed with the claude command every 5 seconds instead. Their apps and status times are unknown.",
    );
    expect(health.watching).toEqual(
      watching("~/elsewhere/sessions", "cannot be read", "every 5 seconds"),
    );
  });
});

describe("AGENT_LOOKOUT_CLAUDE_HOME", () => {
  test("a named directory that cannot be listed is unavailable, and says the command was not run", async () => {
    const { health, sessions } = await createClaudeCodeAdapter({
      env: { AGENT_LOOKOUT_CLAUDE_HOME: "/Users/example/elsewhere" },
      homeDir: HOME,
      now: () => now,
      registryIo: unlistable,
    }).poll();
    expect(sessions).toEqual([]);
    expect(health.state).toBe("unavailable");
    expect(health.detail).toBe(
      `Claude Code sessions could not be read. AGENT_LOOKOUT_CLAUDE_HOME is set, and the session registry at ~/elsewhere/sessions could not be read. ${WITHHELD}`,
    );
    expect(health.watching).toEqual(watching("~/elsewhere/sessions", "cannot be read", "not run"));
  });

  test("AGENT_LOOKOUT_CLAUDE_HOME replaces ~/.claude", async () => {
    const listed: string[] = [];
    const registryIo: RegistryIo = {
      readdir: async (dir) => {
        listed.push(dir);
        return [];
      },
      readFile: async () => "",
    };

    await createClaudeCodeAdapter({
      env: { AGENT_LOOKOUT_CLAUDE_HOME: "/Users/example/elsewhere" },
      homeDir: HOME,
      isExecutable: async () => false,
      registryIo,
    }).poll();
    await createClaudeCodeAdapter({
      env: {},
      homeDir: HOME,
      isExecutable: async () => false,
      registryIo,
    }).poll();

    expect(listed.map(asWritten)).toEqual([
      "/Users/example/elsewhere/sessions",
      "/Users/example/.claude/sessions",
    ]);
  });
});

describe("tmux panes", () => {
  /** The fixtures' registry folder, held in memory. */
  const registryIo: RegistryIo = {
    readdir: async () => Object.keys(registryFiles),
    readFile: async (file) => registryFiles[path.basename(file)] ?? "",
  };

  /**
   * A stand-in for the collector's finder: it knows one pane, and writes down
   * who it was asked about. It says tmux is not there, which keeps the rows
   * about panes off the card.
   */
  function knownPanes(panes: Record<number, TmuxPane>) {
    const looked: number[][] = [];
    return {
      looked,
      look: async (asked: readonly number[]) => {
        looked.push([...asked].sort());
      },
      paneOf: (pid: number) => panes[pid],
      installed: () => false,
      asked: () => false,
      parentsAsked: () => false,
    };
  }

  const pane: TmuxPane = { pid: 4100, id: "%3", place: "api-rate-limits:0.1" };

  test("a live session whose process is in a pane is given the place, and the others are not", async () => {
    const panes = knownPanes({ [pids.question]: pane });
    const { sessions } = await adapterFor("/Users/example/elsewhere", { registryIo, panes }).poll();

    expect(panes.looked).toEqual([[pids.busy, pids.permission, pids.question, pids.idle]]);
    expect(sessions.map((session) => [session.name, session.jump])).toEqual([
      ["demo-project", undefined],
      ["demo-api", undefined],
      ["demo-docs", { kind: "tmux", place: "api-rate-limits:0.1" }],
      ["demo-site", undefined],
      ["nightly-report", undefined],
    ]);
    expect(JSON.stringify(sessions)).not.toContain("%3");
  });

  test("the finder is asked on every poll, and keeps its own beat", async () => {
    const panes = knownPanes({});
    const adapter = adapterFor("/Users/example/elsewhere", { registryIo, panes });
    await adapter.poll();
    await adapter.poll();

    expect(panes.looked).toHaveLength(2);
  });

  test("while sessions come from the command, its processes are the ones asked about", async () => {
    const panes = knownPanes({ [pids.busy]: pane });
    const { sessions, basis } = await adapterFor("/Users/example/elsewhere", {
      registryIo: unlistable,
      panes,
    }).poll();

    expect(basis).toBe("feed");
    expect(panes.looked).toEqual([[pids.busy, pids.permission, pids.question, pids.idle]]);
    expect(sessions.find((session) => session.name === "demo-project")?.jump).toEqual({
      kind: "tmux",
      place: "api-rate-limits:0.1",
    });
  });

  test("a process that has gone is not asked about", async () => {
    const panes = knownPanes({});
    await adapterFor("/Users/example/elsewhere", {
      registryIo,
      panes,
      isAlive: (pid) => pid !== pids.idle,
    }).poll();

    expect(panes.looked).toEqual([[pids.busy, pids.permission, pids.question]]);
  });

  test("with no session there is nobody to ask about", async () => {
    const panes = knownPanes({});
    await adapterFor("/Users/example/elsewhere", {
      registryIo: { readdir: async () => [], readFile: async () => "" },
      run: prints("[]"),
      panes,
    }).poll();

    expect(panes.looked).toEqual([[]]);
  });

  test("without a finder no pane is looked for, and the sessions are as they were", async () => {
    const withFinder = adapterFor("/Users/example/elsewhere", {
      registryIo,
      panes: knownPanes({}),
    });
    const without = adapterFor("/Users/example/elsewhere", { registryIo });

    expect((await without.poll()).sessions).toEqual((await withFinder.poll()).sessions);
  });

  test("without tmux, the health of the source is the same with a pane finder or without one", async () => {
    const a = await adapterFor("/Users/example/elsewhere", {
      registryIo,
      run: fails("stopped with exit code 1"),
      panes: knownPanes({ [pids.busy]: pane }),
    }).poll();
    const b = await adapterFor("/Users/example/elsewhere", {
      registryIo,
      run: fails("stopped with exit code 1"),
    }).poll();

    expect(a.health).toEqual(b.health);
  });

  test("with tmux, the state and detail of the source are the same with a pane finder or without one", async () => {
    const a = await adapterFor("/Users/example/elsewhere", {
      registryIo,
      run: fails("stopped with exit code 1"),
      panes: { ...knownPanes({ [pids.busy]: pane }), installed: () => true },
    }).poll();
    const b = await adapterFor("/Users/example/elsewhere", {
      registryIo,
      run: fails("stopped with exit code 1"),
    }).poll();

    expect(a.health.watching).not.toEqual(b.health.watching);
    expect(a.health.state).toBe(b.health.state);
    expect(a.health.detail).toBe(b.health.detail);
  });
});

describe("Terminal and iTerm2 tabs", () => {
  const registryIo: RegistryIo = {
    readdir: async () => Object.keys(registryFiles),
    readFile: async (file) => registryFiles[path.basename(file)] ?? "",
  };

  /** A stand-in for the collector's tab finder: it knows some tabs, and writes down who it was asked about. */
  function knownTabs(tabs: Record<number, TerminalTab>) {
    const looked: number[][] = [];
    return {
      looked,
      look: async (asked: readonly number[]) => {
        looked.push([...asked].sort());
      },
      tabOf: (pid: number) => tabs[pid],
      asked: () => looked.length > 0,
    };
  }

  test("a live session whose process is in a tab is given the app, and the tab's terminal stays here", async () => {
    const terminals = knownTabs({ [pids.idle]: { app: "Terminal", tty: "/dev/ttys004" } });
    const { sessions } = await adapterFor("/Users/example/elsewhere", {
      registryIo,
      terminals,
    }).poll();

    expect(terminals.looked).toEqual([[pids.busy, pids.permission, pids.question, pids.idle]]);
    expect(sessions.find((session) => session.pid === pids.idle)?.jump).toEqual({
      kind: "terminal",
      app: "Terminal",
      place: "Terminal",
    });
    expect(sessions.filter((session) => session.jump !== undefined)).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain("ttys004");
  });

  test("a session in a tmux pane is given the pane, and both finders are asked about the same processes", async () => {
    const terminals = knownTabs({ [pids.question]: { app: "iTerm2", tty: "/dev/ttys007" } });
    const looked: number[][] = [];
    const panes = {
      look: async (asked: readonly number[]) => {
        looked.push([...asked].sort());
      },
      paneOf: (pid: number): TmuxPane | undefined =>
        pid === pids.question ? { pid: 4100, id: "%3", place: "search-indexing:0.1" } : undefined,
      installed: () => false,
      asked: () => false,
      parentsAsked: () => false,
    };
    const { sessions } = await adapterFor("/Users/example/elsewhere", {
      registryIo,
      panes,
      terminals,
    }).poll();

    expect(sessions.find((session) => session.pid === pids.question)?.jump).toEqual({
      kind: "tmux",
      place: "search-indexing:0.1",
    });
    expect(terminals.looked).toEqual(looked);
  });

  test("without a tab finder no tab is looked for, and the sessions are as they were", async () => {
    const withFinder = adapterFor("/Users/example/elsewhere", {
      registryIo,
      terminals: knownTabs({}),
    });
    const without = adapterFor("/Users/example/elsewhere", { registryIo });

    expect((await without.poll()).sessions).toEqual((await withFinder.poll()).sessions);
  });
});

// Stop is for macOS and Linux, so these name one of them, whatever system runs
// the tests. On Windows nothing is offered Stop: the last test here.
describe("Stop", () => {
  /** The fixtures' registry folder, held in memory. */
  const registryIo: RegistryIo = {
    readdir: async () => Object.keys(registryFiles),
    readFile: async (file) => registryFiles[path.basename(file)] ?? "",
  };

  test("each session it can stop says how, and what it is stopped by goes to the collector alone", async () => {
    const stops = createStopTargets();
    const { sessions } = await adapterFor("/Users/example/elsewhere", {
      registryIo,
      stops,
      platform: "linux",
    }).poll();

    expect(
      Object.fromEntries(sessions.map((session) => [session.name, session.stop?.how ?? null])),
    ).toEqual({
      "demo-project": "signal",
      // In the desktop app.
      "demo-api": null,
      "demo-docs": "signal",
      "demo-site": "signal",
      // A background job with no live process has nothing to stop.
      "nightly-report": null,
    });
    const target = stops.targetOf(`claude-code:${ids.busy}`);
    expect(target).toMatchObject({ how: "signal", pid: pids.busy });
    expect(asWritten(target?.registryFile ?? "")).toBe(
      `/Users/example/elsewhere/sessions/${pids.busy}.json`,
    );
    expect(stops.targetOf(`claude-code:${ids.permission}`)).toBeUndefined();
  });

  test("without anything to hand the targets to, no session is offered Stop", async () => {
    const { sessions } = await adapterFor("/Users/example/elsewhere", {
      registryIo,
      platform: "linux",
    }).poll();
    expect(sessions.filter((session) => session.stop !== undefined)).toEqual([]);
  });

  test("with AGENT_LOOKOUT_STOP off, nothing is offered Stop, and the source says so", async () => {
    const stops = createStopTargets();
    const adapter = adapterFor("/Users/example/elsewhere", {
      registryIo,
      stops,
      platform: "darwin",
      env: {
        AGENT_LOOKOUT_CLAUDE_HOME: "/Users/example/elsewhere",
        AGENT_LOOKOUT_CLAUDE_BIN: "/opt/tools/claude",
        AGENT_LOOKOUT_STOP: "off",
      },
    });
    const { sessions } = await adapter.poll();

    expect(sessions.filter((session) => session.stop !== undefined)).toEqual([]);
    expect(stops.targetOf(`claude-code:${ids.busy}`)).toBeUndefined();
    expect(adapter.capabilities?.stop).toEqual({
      level: "no",
      reason: "AGENT_LOOKOUT_STOP is off, so no session is stopped from Agent Lookout.",
    });
  });

  test("once a background job has been stopped, the command is run at the next poll, ahead of its beat", async () => {
    const stops = createStopTargets();
    const clock = { now };
    let runs = 0;
    const adapter = adapterFor("/Users/example/elsewhere", {
      registryIo,
      stops,
      platform: "linux",
      now: () => clock.now,
      run: async () => {
        runs += 1;
        return prints("[]")("", [], { timeoutMs: 1, env: {} });
      },
    });
    await adapter.poll();
    clock.now += 2_000;
    await adapter.poll();
    expect(runs).toBe(1);

    stops.askFeedSoon();
    clock.now += 2_000;
    await adapter.poll();
    expect(runs).toBe(2);
    // And then the beat goes on from that run.
    clock.now += 2_000;
    await adapter.poll();
    expect(runs).toBe(2);
  });
  test("on Windows no session is offered Stop, whatever it is handed, and the source says why", async () => {
    const stops = createStopTargets();
    let asked = false;
    stops.onAskFeedSoon(() => {
      asked = true;
    });
    const adapter = adapterFor("C:\\Users\\example\\elsewhere", {
      registryIo,
      stops,
      homeDir: "C:\\Users\\example",
      platform: "win32",
    });
    const { sessions } = await adapter.poll();

    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.filter((session) => session.stop !== undefined)).toEqual([]);
    expect(stops.targetOf(`claude-code:${ids.busy}`)).toBeUndefined();
    expect(asked).toBe(false);
    expect(adapter.capabilities).toBe(CLAUDE_CODE_WINDOWS_CAPABILITIES);
    expect(adapter.capabilities?.stop.level).toBe("no");
  });
});

describe("what Sources says of ps", () => {
  /** The fixtures' registry folder, held in memory. */
  const registryIo: RegistryIo = {
    readdir: async () => Object.keys(registryFiles),
    readFile: async (file) => registryFiles[path.basename(file)] ?? "",
  };

  /** No session anywhere: an empty registry folder, and a command that lists none. */
  const noSessions = {
    registryIo: { readdir: async () => [], readFile: async () => "" },
    run: prints("[]"),
  };

  /** What `ps` prints of the fixtures' processes, for the look for a tab. */
  const table = () =>
    new Map(Object.values(pids).map((pid) => [pid, { ppid: 1, tty: "??", path: "claude" }]));

  /**
   * Stand-ins for the two `ps` runs of a poll that the card lists, which count
   * each run, on a clock a test moves.
   */
  function standIns(env: NodeJS.ProcessEnv = {}) {
    const clock = { now };
    const counted = { starts: 0, tables: 0 };
    return {
      clock,
      counted,
      readProcessStarts: async () => {
        counted.starts += 1;
        return new Map<number, string>();
      },
      finder: createTabFinder({
        env,
        homeDir: HOME,
        now: () => clock.now,
        readProcesses: async () => {
          counted.tables += 1;
          return table();
        },
      }),
    };
  }

  /** An adapter on this system, handed what the collector hands it. */
  function adapterOn(
    platform: NodeJS.Platform,
    options: Parameters<typeof adapterFor>[1] = {},
    processes = standIns(),
  ) {
    const windows = platform === "win32";
    return adapterFor(windows ? "C:\\Users\\example\\elsewhere" : "/Users/example/elsewhere", {
      registryIo,
      platform,
      now: () => processes.clock.now,
      readProcessStarts: processes.readProcessStarts,
      terminals: processes.finder.asker(),
      stops: createStopTargets(),
      ...(windows && { homeDir: "C:\\Users\\example" }),
      ...options,
    });
  }

  const processRowsIn = (rows: SourceFact[] | undefined) =>
    rows?.filter((fact) => /^(Process|Tab|Stop) check/.test(fact.label));

  /** The rows a poll gives about processes. */
  const processRows = async (adapter: ReturnType<typeof adapterFor>) =>
    processRowsIn((await adapter.poll()).health.watching);

  const TAB_CHECK = "ps -A -o pid=,ppid=,tty=,comm=";
  const TAB_CHECK_RUN = "once for each new process, every 5 seconds at most";
  const STOP_CHECK = "ps -A -o pid=,ppid= and ps -o pid=,lstart= -p <pid>";
  const STOP_CHECK_RUN = "when you stop a session";

  test("on a Mac it lists the start check, the look for a tab and a stop's check", async () => {
    const stops = createStopTargets();
    const adapter = adapterOn("darwin", { stops });

    expect(await processRows(adapter)).toEqual([
      { label: "Process check", value: PROCESS_CHECK },
      { label: "Process check run", value: PROCESS_CHECK_RUN },
      { label: "Tab check", value: TAB_CHECK },
      { label: "Tab check run", value: TAB_CHECK_RUN },
      { label: "Stop check", value: STOP_CHECK },
      { label: "Stop check run", value: "not run" },
    ]);

    stops.noteCheck();
    expect(await processRows(adapter)).toContainEqual({
      label: "Stop check run",
      value: STOP_CHECK_RUN,
    });
  });

  test("on Linux it lists no look for a tab, which is made on a Mac alone", async () => {
    const stops = createStopTargets();
    const adapter = adapterOn("linux", { stops });

    expect(await processRows(adapter)).toEqual([
      { label: "Process check", value: PROCESS_CHECK },
      { label: "Process check run", value: PROCESS_CHECK_RUN },
      { label: "Stop check", value: STOP_CHECK },
      { label: "Stop check run", value: "not run" },
    ]);

    stops.noteCheck();
    expect(await processRows(adapter)).toContainEqual({
      label: "Stop check run",
      value: STOP_CHECK_RUN,
    });
  });

  test("on Windows, which has no ps, it says signal 0 alone, whatever it is handed", async () => {
    const signalOnly = [{ label: "Process check", value: "signal 0 alone, every 2 seconds" }];

    expect(await processRows(adapterOn("win32"))).toEqual(signalOnly);
    expect(await processRows(adapterOn("win32", noSessions))).toEqual(signalOnly);
    expect(await processRows(adapterOn("win32", { pollIntervalMs: 1_000 }))).toEqual([
      { label: "Process check", value: "signal 0 alone, every second" },
    ]);

    const { health } = await adapterOn("win32").poll();
    expect(JSON.stringify(health.watching)).not.toMatch(/\bps\b/);
  });

  test.each(["darwin", "linux"] as const)(
    "on %s each run says not run while no session has asked",
    async (platform) => {
      const processes = standIns();
      const rows = await processRows(adapterOn(platform, noSessions, processes));
      const runs = rows?.filter((fact) => fact.label.endsWith(" run"));

      expect(runs?.length).toBeGreaterThan(1);
      expect(runs?.every((fact) => fact.value === "not run")).toBe(true);
      expect(processes.counted).toEqual({ starts: 0, tables: 0 });
    },
  );

  test("a session whose file records no start time gives ps nothing to answer, so it says not run", async () => {
    const processes = standIns();
    const adapter = adapterOn(
      "linux",
      {
        registryIo: {
          readdir: async () => [`${pids.busy}.json`],
          readFile: async () => registryFile({ procStart: undefined }),
        },
      },
      processes,
    );

    expect(await processRows(adapter)).toContainEqual({
      label: "Process check run",
      value: "not run",
    });
    expect(processes.counted.starts).toBe(0);
  });

  test("the first run shows on the poll that made it, and stays once the sessions have gone", async () => {
    let files: Record<string, string> = {};
    const adapter = adapterOn("darwin", {
      run: prints("[]"),
      registryIo: {
        readdir: async () => Object.keys(files),
        readFile: async (file) => files[path.basename(file)] ?? "",
      },
    });
    const runs = async () =>
      (await processRows(adapter))?.filter((fact) => /^(Process|Tab) check run$/.test(fact.label));
    const ran = [
      { label: "Process check run", value: PROCESS_CHECK_RUN },
      { label: "Tab check run", value: TAB_CHECK_RUN },
    ];

    expect(await runs()).toEqual([
      { label: "Process check run", value: "not run" },
      { label: "Tab check run", value: "not run" },
    ]);

    files = registryFiles;
    expect(await runs()).toEqual(ran);

    files = {};
    expect(await runs()).toEqual(ran);
  });

  test("the rows add no run of ps: one start check in 30 seconds, and one look for the processes", async () => {
    const processes = standIns();
    const adapter = adapterOn("darwin", {}, processes);

    for (let polled = 0; polled < 15; polled += 1) {
      await adapter.poll();
      processes.clock.now += 2_000;
    }
    expect(processes.counted).toEqual({ starts: 1, tables: 1 });

    await adapter.poll();
    expect(processes.counted).toEqual({ starts: 2, tables: 1 });
  });

  test("a look made for another adapter's process leaves this card's row at not run", async () => {
    const processes = standIns();
    await processes.finder.asker().look([pids.idle]);
    expect(processes.counted.tables).toBe(1);

    expect(await processRows(adapterOn("darwin", noSessions, processes))).toContainEqual({
      label: "Tab check run",
      value: "not run",
    });
  });

  test("with no tab finder and no stop targets it says nothing of either", async () => {
    const rows = await processRows(adapterOn("darwin", { terminals: undefined, stops: undefined }));
    expect(rows?.map((fact) => fact.label)).toEqual(["Process check", "Process check run"]);
  });

  test("with AGENT_LOOKOUT_STOP off it lists no stop's check", async () => {
    const rows = await processRows(
      adapterOn("darwin", {
        env: {
          AGENT_LOOKOUT_CLAUDE_HOME: "/Users/example/elsewhere",
          AGENT_LOOKOUT_CLAUDE_BIN: "/opt/tools/claude",
          AGENT_LOOKOUT_STOP: "off",
        },
      }),
    );
    expect(rows?.map((fact) => fact.label)).toEqual([
      "Process check",
      "Process check run",
      "Tab check",
      "Tab check run",
    ]);
  });

  test("with AGENT_LOOKOUT_TERMINAL_JUMP off the look for a tab says not run, since none is made", async () => {
    const processes = standIns({ AGENT_LOOKOUT_TERMINAL_JUMP: "off" });

    expect(await processRows(adapterOn("darwin", {}, processes))).toContainEqual({
      label: "Tab check run",
      value: "not run",
    });
    expect(processes.counted.tables).toBe(0);
  });

  test("a poll that goes wrong gives the same rows", async () => {
    let broken = false;
    const adapter = adapterOn("darwin", {
      isAlive: () => {
        if (broken) throw new Error("Not expected.");
        return true;
      },
    });
    const rows = await processRows(adapter);

    broken = true;
    const { health } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(processRowsIn(health.watching)).toEqual(rows);
  });
});

describe("what Sources says of tmux", () => {
  /** The fixtures' registry folder, held in memory. */
  const registryIo: RegistryIo = {
    readdir: async () => Object.keys(registryFiles),
    readFile: async (file) => registryFiles[path.basename(file)] ?? "",
  };

  /** No session anywhere: an empty registry folder, and a command that lists none. */
  const noSessions = {
    registryIo: { readdir: async () => [], readFile: async () => "" },
    run: prints("[]"),
  };

  /** One pane, and every process in the fixtures run by the process tmux started in it. */
  const PANE = "4301 %1 0 0 checkout-flow";
  const parents = new Map(Object.values(pids).map((pid) => [pid, 4301]));

  /** The pane finder the collector builds, on a clock a test moves. */
  function standIns(
    more: { isInstalled?: () => Promise<boolean>; parents?: Map<number, number> } = {},
  ) {
    const clock = { now };
    const found = standInPaneFinder({
      panes: [PANE],
      parents,
      now: () => clock.now,
      ...more,
    });
    return { clock, ...found };
  }

  function adapterOn(
    platform: NodeJS.Platform,
    processes: ReturnType<typeof standIns>,
    options: Parameters<typeof adapterFor>[1] = {},
  ) {
    const windows = platform === "win32";
    return adapterFor(windows ? "C:\\Users\\example\\elsewhere" : "/Users/example/elsewhere", {
      registryIo,
      platform,
      now: () => processes.clock.now,
      panes: processes.finder.asker(),
      ...(windows && { homeDir: "C:\\Users\\example" }),
      ...options,
    });
  }

  /** The rows of a card that are about panes. */
  const paneRowsIn = (rows: SourceFact[] | undefined) =>
    rows?.filter((fact) => fact.label.startsWith("Pane "));
  const paneRows = async (adapter: ReturnType<typeof adapterFor>) =>
    paneRowsIn((await adapter.poll()).health.watching);

  const NOT_RUN = [
    { label: "Pane check", value: PANE_CHECK },
    { label: "Pane check run", value: "not run" },
    { label: "Pane parent check", value: PANE_PARENT_CHECK },
    { label: "Pane parent check run", value: "not run" },
  ];
  const RAN = [
    { label: "Pane check", value: PANE_CHECK },
    { label: "Pane check run", value: PANE_CHECK_RUN },
    { label: "Pane parent check", value: PANE_PARENT_CHECK },
    { label: "Pane parent check run", value: PANE_PARENT_CHECK_RUN },
  ];

  test.each(["darwin", "linux"] as const)(
    "on %s it lists tmux and its ps as not run while no session has asked, and nothing has run",
    async (platform) => {
      const processes = standIns();
      expect(await paneRows(adapterOn(platform, processes, noSessions))).toEqual(NOT_RUN);
      expect(processes.tmux.ran).toEqual([]);
      expect(processes.ps.runs).toBe(0);
    },
  );

  test.each(["darwin", "linux"] as const)(
    "on %s the first run shows on the poll that made it, and stays once the sessions have gone",
    async (platform) => {
      let files: Record<string, string> = {};
      const adapter = adapterOn(platform, standIns(), {
        run: prints("[]"),
        registryIo: {
          readdir: async () => Object.keys(files),
          readFile: async (file) => files[path.basename(file)] ?? "",
        },
      });
      expect(await paneRows(adapter)).toEqual(NOT_RUN);

      files = registryFiles;
      expect(await paneRows(adapter)).toEqual(RAN);

      files = {};
      expect(await paneRows(adapter)).toEqual(RAN);
    },
  );

  test("it says the same whether or not a session was found in a pane", async () => {
    const found = await adapterOn("linux", standIns()).poll();
    const notFound = await adapterOn("linux", standIns({ parents: new Map() })).poll();

    expect(found.sessions.some((session) => session.jump !== undefined)).toBe(true);
    expect(notFound.sessions.some((session) => session.jump !== undefined)).toBe(false);
    expect(found.health).toEqual(notFound.health);
  });

  test("they come after the start check and before the look for a tab", async () => {
    const processes = standIns();
    const { health } = await adapterOn("darwin", processes, {
      terminals: createTabFinder({
        env: {},
        homeDir: HOME,
        readProcesses: async () => new Map(),
      }).asker(),
    }).poll();

    expect(health.watching?.map((fact) => fact.label).slice(4, 10)).toEqual([
      "Process check",
      "Process check run",
      "Pane check",
      "Pane check run",
      "Pane parent check",
      "Pane parent check run",
    ]);
  });

  test("on Windows, which has neither, it lists neither, whatever it is handed", async () => {
    const processes = standIns();
    const { health } = await adapterOn("win32", processes).poll();

    expect(paneRowsIn(health.watching)).toEqual([]);
    expect(JSON.stringify(health.watching)).not.toMatch(/tmux|\bps\b/);
  });

  test("with no tmux server running it says tmux has run, and its ps has not", async () => {
    const processes = standIns();
    processes.tmux.down = "no server running on /tmp/tmux-501/default";

    expect(await paneRows(adapterOn("linux", processes))).toEqual([
      { label: "Pane check", value: PANE_CHECK },
      { label: "Pane check run", value: PANE_CHECK_RUN },
      { label: "Pane parent check", value: PANE_PARENT_CHECK },
      { label: "Pane parent check run", value: "not run" },
    ]);
    expect(processes.ps.runs).toBe(0);
  });

  test.each(["darwin", "linux"] as const)(
    "on %s without tmux it says nothing of it, and ps is not asked",
    async (platform) => {
      const processes = standIns({ isInstalled: async () => false });
      processes.tmux.panes = [];

      expect(await paneRows(adapterOn(platform, processes))).toEqual([]);
      expect(await paneRows(adapterOn(platform, processes, noSessions))).toEqual([]);
      expect(processes.ps.runs).toBe(0);
    },
  );

  test("with AGENT_LOOKOUT_TMUX off it says nothing of tmux, which is not even looked for", async () => {
    const env = { AGENT_LOOKOUT_TMUX: "off", PATH: "/opt/homebrew/bin" };
    const looked: string[] = [];
    const isExecutable = async (candidate: string) => {
      looked.push(candidate);
      return true;
    };
    const adapter = adapterFor("/Users/example/elsewhere", {
      registryIo,
      platform: "darwin",
      panes: createPaneFinder({
        run: createTmuxRunner({ env, isExecutable, platform: "darwin" }),
        isInstalled: () => tmuxInstalled({ env, isExecutable, platform: "darwin" }),
        readParents: async () => {
          throw new Error("ps must not be asked");
        },
      }).asker(),
    });

    expect(await paneRows(adapter)).toEqual([]);
    expect(looked).toEqual([]);
  });

  test("AGENT_LOOKOUT_TERMINAL_JUMP is for tabs alone, so with it off tmux runs and the card says so", async () => {
    const env = { AGENT_LOOKOUT_TERMINAL_JUMP: "off" };
    const processes = standIns({
      isInstalled: () => tmuxInstalled({ env, isExecutable: async () => true, platform: "darwin" }),
    });
    let tables = 0;
    const adapter = adapterOn("darwin", processes, {
      terminals: createTabFinder({
        env,
        homeDir: HOME,
        readProcesses: async () => {
          tables += 1;
          return new Map();
        },
      }).asker(),
    });

    expect(await paneRows(adapter)).toEqual(RAN);
    expect(processes.tmux.names()).toEqual(["list-panes"]);
    expect(processes.ps.runs).toBe(1);
    expect(tables).toBe(0);
  });

  test("the rows add no run of tmux or ps: one of each in 30 seconds, and nothing asks between polls", async () => {
    const processes = standIns();
    const adapter = adapterOn("linux", processes);

    for (let polled = 0; polled < 15; polled += 1) {
      await adapter.poll();
      processes.clock.now += 2_000;
    }
    expect(processes.tmux.ran).toHaveLength(1);
    expect(processes.ps.runs).toBe(1);

    await adapter.poll();
    expect(processes.tmux.ran).toHaveLength(2);
    expect(processes.ps.runs).toBe(2);
  });

  test("a look made for another adapter's process leaves this card's rows at not run", async () => {
    const processes = standIns();
    await processes.finder.asker().look([pids.idle]);
    expect(processes.tmux.ran).toHaveLength(1);

    expect(await paneRows(adapterOn("darwin", processes, noSessions))).toEqual(NOT_RUN);
    expect(processes.tmux.ran).toHaveLength(1);
  });

  test("with no pane finder it says nothing of tmux", async () => {
    expect(await paneRows(adapterOn("darwin", standIns(), { panes: undefined }))).toEqual([]);
  });

  test("a poll that goes wrong gives the same rows", async () => {
    let broken = false;
    const adapter = adapterOn("darwin", standIns(), {
      isAlive: () => {
        if (broken) throw new Error("Not expected.");
        return true;
      },
    });
    const rows = await paneRows(adapter);

    broken = true;
    const { health } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(paneRowsIn(health.watching)).toEqual(rows);
  });
});

describe("what Tokens says", () => {
  const tokensWith = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") =>
    createClaudeCodeAdapter({
      env: { AGENT_LOOKOUT_CLAUDE_FEED: "off", ...env },
      homeDir: platform === "win32" ? "C:\\Users\\example" : HOME,
      platform,
    }).capabilities;
  const PARTLY = {
    level: "partly",
    reason: "On the computer it runs on, from its newest reply, read while its details are open.",
  };
  const NO_TRANSCRIPTS = {
    level: "no",
    reason: "AGENT_LOOKOUT_WAITING_TEXT is off, so no transcript is read.",
  };
  const NO_LAST_MESSAGES = {
    level: "no",
    reason:
      "AGENT_LOOKOUT_LAST_MESSAGE is off, and the counts are read only with a session's last message.",
  };

  test("is partly by default: on the computer it runs on, while its details are open", () => {
    expect(CLAUDE_CODE_CAPABILITIES.tokens).toEqual(PARTLY);
    expect(CLAUDE_CODE_WINDOWS_CAPABILITIES.tokens).toEqual(PARTLY);
    expect(tokensWith({})).toBe(CLAUDE_CODE_CAPABILITIES);
    expect(tokensWith({}, "win32")).toBe(CLAUDE_CODE_WINDOWS_CAPABILITIES);
  });

  test.each(["darwin", "linux", "win32"] as const)(
    "on %s, is no by the first setting that stops the read, naming it, and nothing else changes",
    (platform) => {
      const declared =
        platform === "win32" ? CLAUDE_CODE_WINDOWS_CAPABILITIES : CLAUDE_CODE_CAPABILITIES;
      expect(tokensWith({ AGENT_LOOKOUT_WAITING_TEXT: " Off " }, platform)).toEqual({
        ...declared,
        tokens: NO_TRANSCRIPTS,
      });
      expect(
        tokensWith(
          { AGENT_LOOKOUT_WAITING_TEXT: "off", AGENT_LOOKOUT_LAST_MESSAGE: "off" },
          platform,
        )?.tokens,
      ).toEqual(NO_TRANSCRIPTS);
      expect(tokensWith({ AGENT_LOOKOUT_LAST_MESSAGE: "OFF" }, platform)).toEqual({
        ...declared,
        tokens: NO_LAST_MESSAGES,
      });
      for (const on of ["", "on", "no"]) {
        expect(
          tokensWith({ AGENT_LOOKOUT_WAITING_TEXT: on, AGENT_LOOKOUT_LAST_MESSAGE: on }, platform)
            ?.tokens,
        ).toEqual(PARTLY);
      }
    },
  );

  test("says so beside Stop and Answer turned off", () => {
    expect(
      tokensWith({
        AGENT_LOOKOUT_STOP: "off",
        AGENT_LOOKOUT_ANSWER: "off",
        AGENT_LOOKOUT_LAST_MESSAGE: "off",
      }),
    ).toMatchObject({
      stop: { level: "no" },
      answer: { level: "no" },
      tokens: NO_LAST_MESSAGES,
      names: CLAUDE_CODE_CAPABILITIES.names,
    });
  });
});

describe("a registry file read while Claude Code is writing it", () => {
  test("keeps its session listed for that poll, and no longer", async () => {
    const file = `${pids.busy}.json`;
    let content = registryFile({
      pid: pids.busy,
      sessionId: ids.busy,
      kind: "interactive",
      status: "busy",
    });
    const adapter = createClaudeCodeAdapter({
      env: { AGENT_LOOKOUT_CLAUDE_FEED: "off", AGENT_LOOKOUT_WAITING_TEXT: "off" },
      homeDir: HOME,
      now: () => now,
      isAlive: () => true,
      readProcessStarts: async () => new Map(),
      registryIo: { readdir: async () => [file], readFile: async () => content },
    });
    const listed = async () => (await adapter.poll()).sessions.map((session) => session.id);

    expect(await listed()).toEqual([`claude-code:${ids.busy}`]);
    // Emptied, and not yet written again: the session has not ended.
    content = "";
    expect(await listed()).toEqual([`claude-code:${ids.busy}`]);
    // Still not whole a poll later.
    expect(await listed()).toEqual([]);
  });
});
