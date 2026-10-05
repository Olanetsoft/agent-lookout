import { describe, expect, test } from "vitest";

import {
  createClaudeCodeAdapter,
  FEED_FALLBACK_INTERVAL_MS,
  FEED_INTERVAL_MS,
} from "@collector/adapters/claude-code/index";
import type { RegistryIo } from "@collector/adapters/claude-code/registry";
import type { TerminalTab } from "@collector/terminal/terminalTabs";
import type { TmuxPane } from "@collector/tmux/panes";
import { HOME, pids, registryFiles } from "@tests/fixtures/claudeCode";
import {
  adapterFor,
  fails,
  now,
  prints,
  watching,
  WITHHELD,
} from "@tests/support/adapters/claudeCodeAdapter";

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

    expect(listed).toEqual([
      "/Users/example/elsewhere/sessions",
      "/Users/example/.claude/sessions",
    ]);
  });
});

describe("tmux panes", () => {
  /** The fixtures' registry folder, held in memory. */
  const registryIo: RegistryIo = {
    readdir: async () => Object.keys(registryFiles),
    readFile: async (file) => registryFiles[file.split("/").pop() ?? ""] ?? "",
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
    readFile: async (file) => registryFiles[file.split("/").pop() ?? ""] ?? "",
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
