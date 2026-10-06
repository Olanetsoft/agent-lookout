import { describe, expect, test } from "vitest";

import {
  CLAUDE_CODE_CAPABILITIES,
  createClaudeCodeAdapter,
} from "@collector/adapters/claude-code/index";
import { sessionFromRegistry } from "@collector/adapters/claude-code/toSession";
import { CODEX_CAPABILITIES, createCodexAdapter } from "@collector/adapters/codex/index";
import { codexSession } from "@collector/adapters/codex/toSession";
import {
  createStatusFileAdapter,
  STATUS_FILE_CAPABILITIES,
} from "@collector/adapters/status-files/index";
import { statusFileSession } from "@collector/adapters/status-files/toSession";
import { mapClaudeCodeStatus } from "@core/mapping/claudeCodeMapping";
import { mapCodexStatus } from "@core/mapping/codexMapping";
import { mapStatusFileStatus } from "@core/mapping/statusFileMapping";
import { CAPABILITIES, type SessionStatus, type SourceCapabilities } from "@core/sessions/session";
import { memoryFiles } from "@tests/support/adapters/codexAdapter";

const NOW = 1_700_000_100_000;

const DECLARED: [string, SourceCapabilities][] = [
  ["Claude Code", CLAUDE_CODE_CAPABILITIES],
  ["Codex", CODEX_CAPABILITIES],
  ["Status files", STATUS_FILE_CAPABILITIES],
];

/** The longest reason that still reads as one short line in a tooltip. */
const MOST_REASON_CHARACTERS = 130;

describe.each(DECLARED)("what %s declares it can report", (_label, declared) => {
  test("names every capability and nothing else, each as yes, no or partly", () => {
    expect(Object.keys(declared).sort()).toEqual([...CAPABILITIES].sort());
    for (const capability of CAPABILITIES) {
      expect(["yes", "no", "partly"], capability).toContain(declared[capability].level);
    }
  });

  test("gives one short plain sentence of reason for each no and partly, and none for a yes", () => {
    for (const capability of CAPABILITIES) {
      const cell = declared[capability];
      if (cell.level === "yes") {
        expect(cell, capability).toEqual({ level: "yes" });
        continue;
      }
      const { reason } = cell;
      expect(reason, capability).toBe(reason.trim());
      expect(reason, capability).toMatch(/^[A-Z].*\.$/);
      expect(reason.length, capability).toBeLessThanOrEqual(MOST_REASON_CHARACTERS);
      expect(reason, capability).not.toContain("!");
    }
  });
});

test("each adapter carries its own declaration, for the poller to pass on", () => {
  const files = memoryFiles(() => NOW);
  const home = "/Users/example";
  const env = { AGENT_LOOKOUT_CLAUDE_FEED: "off" };

  expect(createClaudeCodeAdapter({ env, homeDir: home }).capabilities).toBe(
    CLAUDE_CODE_CAPABILITIES,
  );
  expect(createCodexAdapter({ env: {}, homeDir: home, io: files.io }).capabilities).toBe(
    CODEX_CAPABILITIES,
  );
  expect(createStatusFileAdapter({ env: {}, homeDir: home, io: files.io }).capabilities).toBe(
    STATUS_FILE_CAPABILITIES,
  );
});

/**
 * The declarations against the code they describe, so a change to a mapping
 * that makes one untrue fails here.
 */
describe("each declaration agrees with what its adapter does", () => {
  const statuses = (mapped: SessionStatus[]) => new Set(mapped);

  test("Claude Code: a live status can need you, and only a background job's state finishes or fails", () => {
    const live = statuses(
      ["busy", "shell", "idle", "waiting"].map(
        (status) => mapClaudeCodeStatus({ status }, "registry").status,
      ),
    );
    expect(live).toEqual(new Set(["working", "idle", "needs-you"]));
    const jobs = statuses(
      ["working", "blocked", "done", "stopped", "failed"].map(
        (state) => mapClaudeCodeStatus({ state }).status,
      ),
    );
    expect(jobs).toEqual(new Set(["working", "needs-you", "finished", "failed"]));

    expect(CLAUDE_CODE_CAPABILITIES["needs-you"].level).toBe("yes");
    expect(CLAUDE_CODE_CAPABILITIES.finished.level).toBe("partly");
    expect(CLAUDE_CODE_CAPABILITIES.failed.level).toBe("partly");
  });

  test("Claude Code: a session has no time of its last write, so it is never quiet", () => {
    const session = sessionFromRegistry(
      { pid: 4242, sessionId: "00000000-0000-4000-8000-000000000001", status: "busy" },
      { now: NOW, isAlive: () => true },
    );
    expect(session).not.toHaveProperty("lastWriteAt");
    expect(CLAUDE_CODE_CAPABILITIES["quiet-for"].level).toBe("no");
  });

  test("Codex: no turn line and no lock ever makes a session need you or fail", () => {
    const turns = [
      "task_started",
      "turn_started",
      "task_complete",
      "turn_complete",
      "turn_aborted",
      null,
      "something_else",
      undefined,
    ];
    const mapped = statuses(
      turns.flatMap((lastTurn) =>
        ([true, false, "unknown"] as const).map((live) => mapCodexStatus({ lastTurn, live })),
      ),
    );
    expect(mapped).toEqual(new Set(["working", "idle", "finished", "unknown"]));
    expect(CODEX_CAPABILITIES["needs-you"].level).toBe("no");
    expect(CODEX_CAPABILITIES.failed.level).toBe("no");
  });

  test("Codex: a session has the time of its last write and no way to jump to it", () => {
    const session = codexSession({
      threadId: "00000000-0000-4000-8000-0000000000c1",
      state: {
        meta: { timestamp: new Date(NOW - 60_000).toISOString(), cwd: "/Users/example/code/demo" },
        lastTurn: "task_started",
        lastTurnAt: NOW - 30_000,
        lastTurnImported: false,
        lastLineAt: NOW - 20_000,
      },
      live: true,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.lastWriteAt).toBe(NOW - 10_000);
    expect(session).not.toHaveProperty("jump");
    expect(session.links).toEqual({});
    expect(CODEX_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(CODEX_CAPABILITIES.jump.level).toBe("no");
  });

  test("status files: every status is the agent's own word, and nothing in a file reaches a session", () => {
    const mapped = statuses(
      ["working", "waiting", "idle", "finished", "failed"].map(
        (status) => mapStatusFileStatus({ status }).status,
      ),
    );
    expect(mapped).toEqual(new Set(["working", "needs-you", "idle", "finished", "failed"]));
    const session = statusFileSession({
      fileName: "demo.json",
      file: { agent: "Night Shift", status: "waiting", pid: 4242 },
      statusSince: null,
      alive: true,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session).not.toHaveProperty("jump");
    expect(session.links).toEqual({});
    for (const capability of ["working-and-idle", "needs-you", "finished", "failed"] as const) {
      expect(STATUS_FILE_CAPABILITIES[capability].level, capability).toBe("partly");
    }
    expect(STATUS_FILE_CAPABILITIES.jump.level).toBe("no");
  });
});
