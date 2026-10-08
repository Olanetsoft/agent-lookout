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
import type { TerminalTab } from "@collector/terminal/terminalTabs";
import type { TmuxPane } from "@collector/tmux/panes";
import { HOME, ids, pids, registryFile, registryFiles } from "@tests/fixtures/claudeCode";
import {
  adapterFor,
  fails,
  now,
  prints,
  watching,
  WITHHELD,
} from "@tests/support/adapters/claudeCodeAdapter";
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

  /** A stand-in for the collector's finder: it knows one pane, and writes down who it was asked about. */
  function knownPanes(panes: Record<number, TmuxPane>) {
    const looked: number[][] = [];
    return {
      looked,
      look: async (asked: readonly number[]) => {
        looked.push([...asked].sort());
      },
      paneOf: (pid: number) => panes[pid],
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

  test("the health of the source says nothing of tmux, found or not", async () => {
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
