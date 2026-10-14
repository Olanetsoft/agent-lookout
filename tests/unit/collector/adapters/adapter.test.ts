import { describe, expect, test } from "vitest";

import {
  ANTIGRAVITY_APP_CAPABILITIES,
  createAntigravityAppAdapter,
} from "@collector/adapters/antigravity/app/index";
import {
  ANTIGRAVITY_CAPABILITIES,
  createAntigravityAdapter,
} from "@collector/adapters/antigravity/cli/index";
import {
  antigravitySession,
  APP_PROFILE,
  CLI_PROFILE,
} from "@collector/adapters/antigravity/shared/toSession";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_WINDOWS_CAPABILITIES,
  createClaudeCodeAdapter,
} from "@collector/adapters/claude-code/index";
import { sessionFromRegistry } from "@collector/adapters/claude-code/toSession";
import { CODEX_CAPABILITIES, createCodexAdapter } from "@collector/adapters/codex/index";
import { codexSession } from "@collector/adapters/codex/toSession";
import {
  createGeminiCliAdapter,
  GEMINI_CLI_CAPABILITIES,
} from "@collector/adapters/gemini-cli/index";
import { geminiCliSession } from "@collector/adapters/gemini-cli/toSession";
import {
  createMistralVibeAdapter,
  MISTRAL_VIBE_CAPABILITIES,
} from "@collector/adapters/mistral-vibe/index";
import { mistralVibeSession } from "@collector/adapters/mistral-vibe/toSession";
import { createOpencodeAdapter, OPENCODE_CAPABILITIES } from "@collector/adapters/opencode/index";
import { opencodeSession } from "@collector/adapters/opencode/toSession";
import { createQwenCodeAdapter, QWEN_CODE_CAPABILITIES } from "@collector/adapters/qwen-code/index";
import { qwenCodeSession } from "@collector/adapters/qwen-code/toSession";
import {
  createStatusFileAdapter,
  STATUS_FILE_CAPABILITIES,
} from "@collector/adapters/status-files/index";
import { statusFileSession } from "@collector/adapters/status-files/toSession";
import {
  ANTIGRAVITY_STEP_STATUSES,
  ANTIGRAVITY_STEP_TYPES,
  mapAntigravityStatus,
} from "@core/mapping/antigravityMapping";
import { mapClaudeCodeStatus } from "@core/mapping/claudeCodeMapping";
import { mapCodexStatus } from "@core/mapping/codexMapping";
import {
  ENVIRONMENT_CONTEXT_ID,
  GEMINI_CLI_MESSAGE_TYPES,
  mapGeminiCliStatus,
  replayGeminiCliRecords,
  type GeminiCliRecord,
} from "@core/mapping/gemini-cli/geminiCliMapping";
import { mapMistralVibeStatus } from "@core/mapping/mistral-vibe/mistralVibeMapping";
import { mapOpencodeStatus } from "@core/mapping/opencode/opencodeMapping";
import {
  foldQwenCodeRecord,
  mapQwenCodeStatus,
  startQwenCodeFold,
  type QwenCodeRecord,
} from "@core/mapping/qwen-code/qwenCodeMapping";
import { mapStatusFileStatus } from "@core/mapping/statusFileMapping";
import { CAPABILITIES, type SessionStatus, type SourceCapabilities } from "@core/sessions/session";
import { memoryFiles } from "@tests/support/adapters/codexAdapter";

const NOW = 1_700_000_100_000;

const DECLARED: [string, SourceCapabilities][] = [
  ["Claude Code", CLAUDE_CODE_CAPABILITIES],
  ["Claude Code on Windows", CLAUDE_CODE_WINDOWS_CAPABILITIES],
  ["Codex", CODEX_CAPABILITIES],
  ["Antigravity CLI", ANTIGRAVITY_CAPABILITIES],
  ["Antigravity", ANTIGRAVITY_APP_CAPABILITIES],
  ["Mistral Vibe", MISTRAL_VIBE_CAPABILITIES],
  ["Gemini CLI", GEMINI_CLI_CAPABILITIES],
  ["OpenCode", OPENCODE_CAPABILITIES],
  ["Qwen Code", QWEN_CODE_CAPABILITIES],
  ["Status files", STATUS_FILE_CAPABILITIES],
];

/** The longest reason that still reads as one short line in a tooltip. */
const MAX_REASON_CHARACTERS = 130;

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
      expect(reason.length, capability).toBeLessThanOrEqual(MAX_REASON_CHARACTERS);
      expect(reason, capability).not.toContain("!");
    }
  });
});

test("each adapter carries its own declaration, for the poller to pass on", () => {
  const files = memoryFiles(() => NOW);
  const home = "/Users/example";
  const env = { AGENT_LOOKOUT_CLAUDE_FEED: "off" };

  for (const platform of ["darwin", "linux"] as const) {
    expect(createClaudeCodeAdapter({ env, homeDir: home, platform }).capabilities).toBe(
      CLAUDE_CODE_CAPABILITIES,
    );
  }
  expect(
    createClaudeCodeAdapter({ env, homeDir: "C:\\Users\\example", platform: "win32" }).capabilities,
  ).toBe(CLAUDE_CODE_WINDOWS_CAPABILITIES);
  expect(createCodexAdapter({ env: {}, homeDir: home, io: files.io }).capabilities).toBe(
    CODEX_CAPABILITIES,
  );
  expect(createStatusFileAdapter({ env: {}, homeDir: home, io: files.io }).capabilities).toBe(
    STATUS_FILE_CAPABILITIES,
  );
  expect(
    createAntigravityAdapter({ env: {}, homeDir: home, io: files.io, platform: "win32" })
      .capabilities,
  ).toBe(ANTIGRAVITY_CAPABILITIES);
  for (const platform of ["darwin", "linux", "win32"] as const) {
    expect(
      createAntigravityAppAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(ANTIGRAVITY_APP_CAPABILITIES);
    expect(
      createOpencodeAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(OPENCODE_CAPABILITIES);
    expect(
      createQwenCodeAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(QWEN_CODE_CAPABILITIES);
  }
  expect(createMistralVibeAdapter({ env: {}, homeDir: home, io: files.io }).capabilities).toBe(
    MISTRAL_VIBE_CAPABILITIES,
  );
  expect(createGeminiCliAdapter({ env: {}, homeDir: home, io: files.io }).capabilities).toBe(
    GEMINI_CLI_CAPABILITIES,
  );
});

test("on Windows Claude Code reports all it does elsewhere, but Jump in VS Code alone, and no Stop or Answer", () => {
  const differs = Object.keys(CLAUDE_CODE_CAPABILITIES).filter(
    (capability) =>
      JSON.stringify(CLAUDE_CODE_CAPABILITIES[capability as keyof SourceCapabilities]) !==
      JSON.stringify(CLAUDE_CODE_WINDOWS_CAPABILITIES[capability as keyof SourceCapabilities]),
  );
  expect(differs.sort()).toEqual(["answer", "jump", "stop"]);
  expect(CLAUDE_CODE_WINDOWS_CAPABILITIES.jump.level).toBe("partly");
  expect(CLAUDE_CODE_WINDOWS_CAPABILITIES.stop.level).toBe("no");
  expect(CLAUDE_CODE_WINDOWS_CAPABILITIES.answer.level).toBe("no");

  // Whatever the settings say, on Windows the reason is Windows.
  const adapter = createClaudeCodeAdapter({
    env: {
      AGENT_LOOKOUT_CLAUDE_FEED: "off",
      AGENT_LOOKOUT_STOP: "off",
      AGENT_LOOKOUT_ANSWER: "off",
    },
    homeDir: "C:\\Users\\example",
    platform: "win32",
  });
  expect(adapter.capabilities).toBe(CLAUDE_CODE_WINDOWS_CAPABILITIES);
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
        tokens: null,
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

  test("Antigravity CLI: no step alone makes a session need you, only its program's log, and only an error of agy's own fails", () => {
    const steps = ANTIGRAVITY_STEP_TYPES.flatMap((type) =>
      ANTIGRAVITY_STEP_STATUSES.flatMap((status) =>
        [true, false].map((toolCalls) => ({ type, status, toolCalls })),
      ),
    );
    const mapped = statuses(
      [...steps, null, undefined].flatMap((last) =>
        ([true, false, "unknown"] as const).map((live) => mapAntigravityStatus({ last, live })),
      ),
    );
    expect(mapped).toEqual(new Set(["working", "idle", "finished", "failed", "unknown"]));
    const failing = steps.filter((last) => mapAntigravityStatus({ last, live: true }) === "failed");
    expect(new Set(failing.map((last) => last.type))).toEqual(
      new Set(["ERROR_MESSAGE", "PLANNER_RESPONSE"]),
    );
    expect(
      mapAntigravityStatus({
        last: { type: "PLANNER_RESPONSE", status: "DONE", toolCalls: true },
        live: true,
        asking: true,
      }),
    ).toBe("needs-you");
    expect(ANTIGRAVITY_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(ANTIGRAVITY_CAPABILITIES.failed.level).toBe("partly");
    expect(ANTIGRAVITY_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Antigravity CLI: a session has the time of its last write, no jump or stop, and with no title or log, no name or folder", () => {
    const session = antigravitySession({
      profile: CLI_PROFILE,
      conversationId: "00000000-0000-4000-8000-0000000000a1",
      state: {
        firstAt: NOW - 60_000,
        last: {
          index: 2,
          type: "RUN_COMMAND",
          status: "RUNNING",
          toolCalls: false,
          at: NOW - 30_000,
        },
        since: NOW - 60_000,
        lastAt: NOW - 30_000,
        lastIndex: 2,
        tokens: null,
      },
      live: true,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.lastWriteAt).toBe(NOW - 10_000);
    expect(session.name).toBe("00000000-0000-4000-8000-0000000000a1");
    expect(session.cwd).toBeNull();
    expect(session).not.toHaveProperty("jump");
    expect(session).not.toHaveProperty("stop");
    expect(session).not.toHaveProperty("pid");
    expect(session.links).toEqual({});
    expect(ANTIGRAVITY_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(ANTIGRAVITY_CAPABILITIES.tokens.level).toBe("yes");
    expect(ANTIGRAVITY_CAPABILITIES.names.level).toBe("partly");
    expect(ANTIGRAVITY_CAPABILITIES.jump.level).toBe("no");
    expect(ANTIGRAVITY_CAPABILITIES.stop.level).toBe("no");
    expect(ANTIGRAVITY_CAPABILITIES.answer.level).toBe("no");
  });

  test("Antigravity: only a wait read from its database makes a chat need you, and only an error of its own fails", () => {
    const steps = ANTIGRAVITY_STEP_TYPES.flatMap((type) =>
      ANTIGRAVITY_STEP_STATUSES.flatMap((status) =>
        [true, false].map((toolCalls) => ({ type, status, toolCalls })),
      ),
    );
    // No step of its transcript, write or process makes a chat need you on its own.
    const mapped = statuses(
      [...steps, null, undefined].flatMap((last) =>
        ([true, false, "unknown"] as const).flatMap((live) =>
          [true, false].map((writing) => mapAntigravityStatus({ last, live, writing })),
        ),
      ),
    );
    expect(mapped).toEqual(new Set(["working", "idle", "finished", "failed", "unknown"]));
    // A wait from its database does, unless the app is closed or the chat failed.
    const asking = statuses(
      [...steps, null].flatMap((last) =>
        ([true, false, "unknown"] as const).map((live) =>
          mapAntigravityStatus({ last, live, asking: true }),
        ),
      ),
    );
    expect(asking).toEqual(new Set(["needs-you", "finished", "failed", "unknown"]));
    expect(ANTIGRAVITY_APP_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(ANTIGRAVITY_APP_CAPABILITIES.answer.level).toBe("no");
    expect(ANTIGRAVITY_APP_CAPABILITIES.failed.level).toBe("partly");
    expect(ANTIGRAVITY_APP_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Antigravity: a chat has the time of its last write and its newest reply's token counts, and no jump or stop", () => {
    const session = antigravitySession({
      profile: APP_PROFILE,
      conversationId: "00000000-0000-4000-8000-0000000000a1",
      state: {
        firstAt: NOW - 60_000,
        last: {
          index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          toolCalls: false,
          at: NOW - 30_000,
        },
        since: NOW - 30_000,
        lastAt: NOW - 30_000,
        lastIndex: 1,
        tokens: { input: 2_000, cached: 800, output: 64 },
      },
      live: true,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.lastWriteAt).toBe(NOW - 10_000);
    expect(session.tokens).toEqual({ input: 2_000, cached: 800, output: 64 });
    expect(session).not.toHaveProperty("jump");
    expect(session).not.toHaveProperty("stop");
    expect(session).not.toHaveProperty("pid");
    expect(session.links).toEqual({});
    expect(ANTIGRAVITY_APP_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(ANTIGRAVITY_APP_CAPABILITIES.tokens.level).toBe("yes");
    expect(ANTIGRAVITY_APP_CAPABILITIES.jump.level).toBe("no");
    expect(ANTIGRAVITY_APP_CAPABILITIES.stop.level).toBe("no");
  });

  test("Mistral Vibe: no status or lease makes a session need you yet, and only a turn Vibe records as failed fails", () => {
    const types = ["idle", "running", "blocked", "failed", "archived", "something_else", undefined];
    const mapped = statuses(
      types.flatMap((statusType) =>
        ([true, false, "unknown"] as const).flatMap((held) =>
          [true, false].map((tooNew) => mapMistralVibeStatus({ statusType, held, tooNew })),
        ),
      ),
    );
    expect(mapped).toEqual(new Set(["working", "idle", "finished", "failed", "unknown"]));
    expect(MISTRAL_VIBE_CAPABILITIES["needs-you"].level).toBe("no");
    expect(MISTRAL_VIBE_CAPABILITIES.failed.level).toBe("partly");
    expect(MISTRAL_VIBE_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Mistral Vibe: a session has the time of its last write, and no jump, stop, pid or tokens", () => {
    const session = mistralVibeSession({
      sessionId: "00000000-0000-4000-8000-0000000000e1",
      envelope: {
        title: null,
        statusType: "running",
        createdAt: NOW - 60_000,
        updatedAt: NOW - 30_000,
        turnStatus: "in_progress",
        turnStartedAt: NOW - 30_000,
        turnCompletedAt: null,
      },
      title: null,
      cwd: "/Users/example/code/demo",
      held: true,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.lastWriteAt).toBe(NOW - 10_000);
    expect(session.name).toBe("demo");
    for (const key of ["jump", "stop", "pid", "alive", "tokens"]) {
      expect(session, key).not.toHaveProperty(key);
    }
    expect(session.links).toEqual({});
    expect(MISTRAL_VIBE_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(MISTRAL_VIBE_CAPABILITIES.names.level).toBe("partly");
    expect(MISTRAL_VIBE_CAPABILITIES.tokens.level).toBe("no");
    expect(MISTRAL_VIBE_CAPABILITIES.jump.level).toBe("no");
    expect(MISTRAL_VIBE_CAPABILITIES.stop.level).toBe("no");
    expect(MISTRAL_VIBE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Gemini CLI: no line ever makes a session need you, finish or fail", () => {
    const shapes = [false, true].flatMap((empty) =>
      [false, true].flatMap((functionCall) =>
        [false, true].flatMap((functionResponse) =>
          [false, true].flatMap((thoughtOnly) =>
            [false, true].map((note) => ({
              empty,
              functionCall,
              functionResponse,
              thoughtOnly,
              note,
            })),
          ),
        ),
      ),
    );
    const toolCalls = [
      null,
      { allCancelled: false, lastAt: NOW },
      { allCancelled: true, lastAt: NOW },
    ];
    const messages = [...GEMINI_CLI_MESSAGE_TYPES, "other" as const].flatMap((type) =>
      [...shapes, null].flatMap((content) =>
        toolCalls.map((calls) => ({ id: "m2", type, at: NOW, content, toolCalls: calls })),
      ),
    );
    const before: GeminiCliRecord[] = [
      { kind: "header", startedAt: NOW - 60_000, updatedAt: NOW - 60_000 },
      {
        kind: "message",
        message: {
          id: ENVIRONMENT_CONTEXT_ID,
          type: "user",
          at: NOW - 60_000,
          content: null,
          toolCalls: null,
        },
      },
    ];
    const endings: GeminiCliRecord[][] = [
      [],
      [{ kind: "rewind", id: "m2" }],
      [{ kind: "set", reattach: true }],
    ];
    const mapped = statuses(
      messages.flatMap((message) =>
        endings.flatMap((ending) =>
          [true, false].map(
            (fromStart) =>
              mapGeminiCliStatus(
                replayGeminiCliRecords(
                  [...before, { kind: "message", message }, ...ending],
                  fromStart,
                ),
              ).status,
          ),
        ),
      ),
    );
    expect(mapped).toEqual(new Set(["working", "idle", "unknown"]));
    expect(GEMINI_CLI_CAPABILITIES["needs-you"].level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.finished.level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.failed.level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES["working-and-idle"].level).toBe("partly");
  });

  test("Gemini CLI: a session has the time of its last write, and no tokens, jump, stop or link", () => {
    const session = geminiCliSession({
      state: {
        header: {
          sessionId: "00000000-0000-4000-8000-0000000000e1",
          kind: "main",
          startedAt: NOW - 60_000,
          updatedAt: NOW - 60_000,
        },
        status: { status: "working", since: NOW - 30_000 },
        updatedAt: NOW - 30_000,
        messageAt: NOW - 30_000,
        toolAt: null,
        skipped: 0,
      },
      slug: "demo",
      cwd: "/Users/example/code/demo",
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session?.lastWriteAt).toBe(NOW - 10_000);
    expect(session).not.toHaveProperty("tokens");
    expect(session).not.toHaveProperty("jump");
    expect(session).not.toHaveProperty("stop");
    expect(session).not.toHaveProperty("pid");
    expect(session?.links).toEqual({});
    expect(GEMINI_CLI_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(GEMINI_CLI_CAPABILITIES.tokens.level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.names.level).toBe("partly");
    expect(GEMINI_CLI_CAPABILITIES.jump.level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.stop.level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.answer.level).toBe("no");
  });

  test("OpenCode: no message ever makes a session need you, and only an error OpenCode records fails", () => {
    const messages = [
      null,
      ...["user", "assistant", "system", 7].flatMap((role) =>
        [null, NOW - 1_000, NOW - 60_000, "soon"].flatMap((completedAt) =>
          [null, "MessageAbortedError", "APIError", "SomeNewError"].flatMap((error) =>
            [null, "stop", "tool-calls", "unknown"].flatMap((finish) =>
              [0, 1].flatMap((tools) =>
                [0, 1].map((shell) => ({ role, completedAt, error, finish, tools, shell })),
              ),
            ),
          ),
        ),
      ),
    ];
    const mapped = statuses(
      messages.flatMap((message) =>
        [true, false].map((open) => mapOpencodeStatus({ message, open, now: NOW })),
      ),
    );
    expect(mapped).toEqual(new Set(["working", "idle", "finished", "failed", "unknown"]));
    // With OpenCode closed, nothing is working or idle.
    const closed = statuses(
      messages.map((message) => mapOpencodeStatus({ message, open: false, now: NOW })),
    );
    expect(closed).toEqual(new Set(["finished", "failed", "unknown"]));
    expect(OPENCODE_CAPABILITIES["needs-you"].level).toBe("no");
    expect(OPENCODE_CAPABILITIES.failed.level).toBe("partly");
    expect(OPENCODE_CAPABILITIES.finished.level).toBe("partly");
    expect(OPENCODE_CAPABILITIES["working-and-idle"].level).toBe("partly");
  });

  test("OpenCode: a session has no time of its last write, no tokens, jump, stop or link, and its title for a name", () => {
    const session = opencodeSession({
      row: {
        id: "ses_000000000000000000000000a1",
        folder: "/Users/example/code/demo",
        title: "Rename the helper",
        createdAt: NOW - 60_000,
        updatedAt: NOW - 30_000,
        message: {
          createdAt: NOW - 30_000,
          updatedAt: NOW - 30_000,
          role: "assistant",
          completedAt: null,
          error: null,
          finish: null,
          tools: 1,
          shell: 0,
          partsUpdatedAt: NOW - 10_000,
        },
        userCreatedAt: NOW - 40_000,
      },
      open: true,
      now: NOW,
    });
    expect(session).toMatchObject({ status: "working", name: "Rename the helper" });
    for (const absent of ["lastWriteAt", "tokens", "jump", "stop", "pid", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session?.links).toEqual({});
    expect(OPENCODE_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(OPENCODE_CAPABILITIES.tokens.level).toBe("no");
    expect(OPENCODE_CAPABILITIES.names.level).toBe("yes");
    expect(OPENCODE_CAPABILITIES.jump.level).toBe("no");
    expect(OPENCODE_CAPABILITIES.stop.level).toBe("no");
    expect(OPENCODE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Qwen Code: no line of its chat files makes a session need you, fail or finish", () => {
    const records: QwenCodeRecord[] = [
      { type: "user", at: NOW - 60_000 },
      { type: "user", subtype: "notification", at: NOW - 60_000 },
      { type: "user", subtype: "mid_turn_user_message", at: NOW - 60_000 },
      { type: "assistant", at: NOW - 50_000, message: true, calls: true },
      { type: "assistant", at: NOW - 50_000, message: true },
      { type: "assistant", at: NOW - 50_000, oversized: true },
      { type: "tool_result", at: NOW - 40_000 },
      { type: "tool_result", at: NOW - 40_000, cancelled: true },
      { type: "system", subtype: "rewind", at: NOW - 30_000 },
      { type: "system", subtype: "turn_result", at: NOW - 30_000 },
      {
        type: "system",
        subtype: "ui_telemetry",
        at: NOW - 30_000,
        lifecycle: { phase: "ended", outcome: "error", subagent: false },
      },
      { type: "summary", at: NOW - 20_000 },
    ];
    const mapped = statuses(
      records.flatMap((first) =>
        records.flatMap((second) =>
          [true, false].map(
            (whole) =>
              mapQwenCodeStatus(
                [first, second].reduce(foldQwenCodeRecord, startQwenCodeFold(whole)),
                NOW - 90_000,
              ).status,
          ),
        ),
      ),
    );
    expect(mapped).toEqual(new Set(["working", "idle", "unknown"]));
    expect(QWEN_CODE_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(QWEN_CODE_CAPABILITIES["needs-you"].level).toBe("no");
    expect(QWEN_CODE_CAPABILITIES.failed.level).toBe("no");
    expect(QWEN_CODE_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Qwen Code: a session has its process and the time of its last write, and no tokens, jump or stop", () => {
    const session = qwenCodeSession({
      entry: {
        pid: 41001,
        sessionId: "00000000-0000-4000-8000-000000000001",
        cwd: "/Users/example/code/demo",
        startedAt: NOW - 60_000,
        kind: "tui",
        linux: false,
      },
      chat: {
        fold: foldQwenCodeRecord(startQwenCodeFold(true), { type: "user", at: NOW - 30_000 }),
        firstAt: NOW - 30_000,
      },
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.lastWriteAt).toBe(NOW - 10_000);
    expect(session.pid).toBe(41001);
    expect(session).not.toHaveProperty("tokens");
    expect(session).not.toHaveProperty("jump");
    expect(session).not.toHaveProperty("stop");
    expect(session).not.toHaveProperty("ask");
    expect(session.links).toEqual({});
    expect(QWEN_CODE_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(QWEN_CODE_CAPABILITIES.tokens.level).toBe("no");
    expect(QWEN_CODE_CAPABILITIES.names.level).toBe("partly");
    expect(QWEN_CODE_CAPABILITIES.jump.level).toBe("no");
    expect(QWEN_CODE_CAPABILITIES.stop.level).toBe("no");
    expect(QWEN_CODE_CAPABILITIES.answer.level).toBe("no");
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
