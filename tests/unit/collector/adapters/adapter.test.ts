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
import { CLINE_CAPABILITIES, createClineAdapter } from "@collector/adapters/cline/index";
import { clineSession } from "@collector/adapters/cline/toSession";
import { CODEX_CAPABILITIES, createCodexAdapter } from "@collector/adapters/codex/index";
import { codexSession } from "@collector/adapters/codex/toSession";
import { createCrushAdapter, CRUSH_CAPABILITIES } from "@collector/adapters/crush/index";
import { crushSession } from "@collector/adapters/crush/toSession";
import { createGooseAdapter, GOOSE_CAPABILITIES } from "@collector/adapters/goose/index";
import { gooseSession } from "@collector/adapters/goose/toSession";
import { createKimiCodeAdapter, KIMI_CODE_CAPABILITIES } from "@collector/adapters/kimi-code/index";
import { kimiCodeSession } from "@collector/adapters/kimi-code/toSession";
import {
  createGeminiCliAdapter,
  GEMINI_CLI_CAPABILITIES,
} from "@collector/adapters/gemini-cli/index";
import { geminiCliSession } from "@collector/adapters/gemini-cli/toSession";
import {
  createHermesAgentAdapter,
  HERMES_AGENT_CAPABILITIES,
} from "@collector/adapters/hermes-agent/index";
import {
  createMistralVibeAdapter,
  MISTRAL_VIBE_CAPABILITIES,
} from "@collector/adapters/mistral-vibe/index";
import { mistralVibeSession } from "@collector/adapters/mistral-vibe/toSession";
import {
  createKiloCodeAdapter,
  KILO_CODE_CAPABILITIES,
  SOURCE_ID as KILO_CODE_SOURCE_ID,
} from "@collector/adapters/kilo-code/index";
import {
  createMimoCodeAdapter,
  MIMO_CODE_CAPABILITIES,
  MIMO_FAILED_ERRORS,
  SOURCE_ID as MIMO_CODE_SOURCE_ID,
} from "@collector/adapters/mimo-code/index";
import {
  createKimchiAdapter,
  KIMCHI_CAPABILITIES,
  SOURCE_ID as KIMCHI_SOURCE_ID,
} from "@collector/adapters/kimchi/index";
import { createOpencodeAdapter, OPENCODE_CAPABILITIES } from "@collector/adapters/opencode/index";
import { opencodeSession } from "@collector/adapters/opencode/toSession";
import { CONTINUE_CAPABILITIES, createContinueAdapter } from "@collector/adapters/continue/index";
import { continueSession } from "@collector/adapters/continue/toSession";
import {
  COPILOT_CLI_CAPABILITIES,
  createCopilotCliAdapter,
} from "@collector/adapters/copilot-cli/index";
import { copilotCliSession } from "@collector/adapters/copilot-cli/toSession";
import { createFxAdapter, FX_CAPABILITIES } from "@collector/adapters/fx/index";
import { fxSession } from "@collector/adapters/fx/toSession";
import {
  createUnrealAgentAdapter,
  UNREAL_AGENT_CAPABILITIES,
} from "@collector/adapters/unreal-agent/index";
import { unrealAgentSession } from "@collector/adapters/unreal-agent/toSession";
import {
  AUTOHAND_CODE_CAPABILITIES,
  createAutohandCodeAdapter,
} from "@collector/adapters/autohand-code/index";
import {
  autohandCodeSession,
  withJump as autohandCodeJump,
} from "@collector/adapters/autohand-code/toSession";
import {
  createDeepseekHarnessAdapter,
  DEEPSEEK_HARNESS_CAPABILITIES,
} from "@collector/adapters/deepseek-harness/index";
import { deepseekHarnessSession } from "@collector/adapters/deepseek-harness/toSession";
import { createDroidAdapter, DROID_CAPABILITIES } from "@collector/adapters/droid/index";
import { droidSession } from "@collector/adapters/droid/toSession";
import {
  createGrokBuildAdapter,
  GROK_BUILD_CAPABILITIES,
} from "@collector/adapters/grok-build/index";
import {
  grokBuildSession,
  withJump as grokBuildJump,
} from "@collector/adapters/grok-build/toSession";
import { createMuseCodeAdapter, MUSE_CODE_CAPABILITIES } from "@collector/adapters/muse-code/index";
import { museCodeSession } from "@collector/adapters/muse-code/toSession";
import { createOhMyPiAdapter, OH_MY_PI_CAPABILITIES } from "@collector/adapters/oh-my-pi/index";
import { ohMyPiSession } from "@collector/adapters/oh-my-pi/toSession";
import { createPiAdapter, PI_CAPABILITIES } from "@collector/adapters/pi/index";
import { piSession } from "@collector/adapters/pi/toSession";
import {
  createPrimeAgentAdapter,
  PRIME_AGENT_CAPABILITIES,
  SOURCE_ID as PRIME_AGENT_SOURCE_ID,
} from "@collector/adapters/prime-agent/index";
import { createQwenCodeAdapter, QWEN_CODE_CAPABILITIES } from "@collector/adapters/qwen-code/index";
import { qwenCodeSession, withJump } from "@collector/adapters/qwen-code/toSession";
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
import { mapClineStatus } from "@core/mapping/cline/clineMapping";
import {
  applyCopilotRecord,
  startCopilotFold,
  type CopilotRecord,
} from "@core/mapping/copilot-cli/copilotCliFold";
import { copilotCliStatusOf } from "@core/mapping/copilot-cli/copilotCliMapping";
import { mapCrushStatus } from "@core/mapping/crush/crushMapping";
import { mapDroidStatus } from "@core/mapping/droid/droidMapping";
import { emptyGrokBuildTurn, mapGrokBuildStatus } from "@core/mapping/grok-build/grokBuildMapping";
import { mapFxStatus } from "@core/mapping/fx/fxMapping";
import { mapGooseStatus } from "@core/mapping/goose/gooseMapping";
import { mapKimiCodeStatus } from "@core/mapping/kimi-code/kimiCodeMapping";
import { startMuseFold, type MuseFold } from "@core/mapping/muse-code/museCodeFold";
import { museCodeStatusOf, type MuseCodeFacts } from "@core/mapping/muse-code/museCodeMapping";
import { ohMyPiStatusOf, type OhMyPiFacts } from "@core/mapping/oh-my-pi/ohMyPiMapping";
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
import { mapPiStatus } from "@core/mapping/pi/piMapping";
import {
  primeAgentHolderStatus,
  primeAgentJournalStatus,
  type JournalRecord,
} from "@core/mapping/prime-agent/primeAgentMapping";
import {
  foldQwenCodeRecord,
  mapQwenCodeStatus,
  startQwenCodeFold,
  type QwenCodeRecord,
} from "@core/mapping/qwen-code/qwenCodeMapping";
import { mapStatusFileStatus } from "@core/mapping/statusFileMapping";
import { mapUnrealAgentStatus } from "@core/mapping/unreal-agent/unrealAgentMapping";
import {
  autohandStatusOf,
  type AutohandEvidence,
  type HeartbeatClass,
} from "@core/mapping/autohand-code/autohandCodeMapping";
import {
  deepseekHarnessStatusOf,
  type DeepseekHarnessTurn,
  type DeepseekHarnessWriter,
} from "@core/mapping/deepseek-harness/deepseekHarnessMapping";
import {
  applyUnrealAgentLine,
  startUnrealAgentReplay,
  type UnrealAgentItem,
} from "@core/mapping/unreal-agent/unrealAgentReplay";
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
  ["Hermes Agent", HERMES_AGENT_CAPABILITIES],
  ["Cline", CLINE_CAPABILITIES],
  ["Goose", GOOSE_CAPABILITIES],
  ["Pi", PI_CAPABILITIES],
  ["Kimi Code", KIMI_CODE_CAPABILITIES],
  ["Continue", CONTINUE_CAPABILITIES],
  ["Crush", CRUSH_CAPABILITIES],
  ["Kilo Code", KILO_CODE_CAPABILITIES],
  ["MiMo Code", MIMO_CODE_CAPABILITIES],
  ["Kimchi", KIMCHI_CAPABILITIES],
  ["Prime Agent", PRIME_AGENT_CAPABILITIES],
  ["fx", FX_CAPABILITIES],
  ["Unreal Agent", UNREAL_AGENT_CAPABILITIES],
  ["Autohand Code", AUTOHAND_CODE_CAPABILITIES],
  ["DeepSeek Harness", DEEPSEEK_HARNESS_CAPABILITIES],
  ["Droid", DROID_CAPABILITIES],
  ["Grok Build", GROK_BUILD_CAPABILITIES],
  ["Oh My Pi", OH_MY_PI_CAPABILITIES],
  ["Muse Code", MUSE_CODE_CAPABILITIES],
  ["Copilot CLI", COPILOT_CLI_CAPABILITIES],
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
    expect(
      createHermesAgentAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(HERMES_AGENT_CAPABILITIES);
    expect(
      createClineAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(CLINE_CAPABILITIES);
    expect(
      createGooseAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(GOOSE_CAPABILITIES);
    expect(createPiAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities).toBe(
      PI_CAPABILITIES,
    );
    expect(
      createKimiCodeAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(KIMI_CODE_CAPABILITIES);
    expect(
      createContinueAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(CONTINUE_CAPABILITIES);
    expect(
      createCrushAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(CRUSH_CAPABILITIES);
    expect(
      createKiloCodeAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(KILO_CODE_CAPABILITIES);
    expect(
      createMimoCodeAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(MIMO_CODE_CAPABILITIES);
    expect(
      createKimchiAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(KIMCHI_CAPABILITIES);
    expect(
      createPrimeAgentAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(PRIME_AGENT_CAPABILITIES);
    expect(createFxAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities).toBe(
      FX_CAPABILITIES,
    );
    expect(
      createUnrealAgentAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(UNREAL_AGENT_CAPABILITIES);
    expect(
      createAutohandCodeAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(AUTOHAND_CODE_CAPABILITIES);
    expect(
      createDeepseekHarnessAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(DEEPSEEK_HARNESS_CAPABILITIES);
    expect(
      createDroidAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(DROID_CAPABILITIES);
    expect(
      createGrokBuildAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(GROK_BUILD_CAPABILITIES);
    expect(
      createOhMyPiAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(OH_MY_PI_CAPABILITIES);
    expect(
      createMuseCodeAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(MUSE_CODE_CAPABILITIES);
    expect(
      createCopilotCliAdapter({ env: {}, homeDir: home, io: files.io, platform }).capabilities,
    ).toBe(COPILOT_CLI_CAPABILITIES);
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

  test("Cline: the manifest can say a session needs you, finished or failed, and the rest is unknown", () => {
    const mapped = statuses(
      ["running", "pending", "idle", "completed", "cancelled", "failed", "archived", null].flatMap(
        (status) =>
          [true, false, null].map((processRuns) => mapClineStatus({ status, processRuns }).status),
      ),
    );
    expect(mapped).toEqual(
      new Set(["working", "needs-you", "idle", "finished", "failed", "unknown"]),
    );
    expect(mapClineStatus({ status: "pending", processRuns: true })).toEqual({
      status: "needs-you",
      waitingReason: "permission",
    });
    expect(CLINE_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(CLINE_CAPABILITIES.finished.level).toBe("partly");
    expect(CLINE_CAPABILITIES.failed.level).toBe("partly");
  });

  test("Cline: a session has a name, the time of its last write, and no tokens, jump or stop", () => {
    const session = clineSession({
      manifest: {
        sessionId: "1790000000000_demo1",
        pid: 4242,
        status: "running",
        cwd: "/Users/example/code/demo",
        startedAt: NOW - 60_000,
        endedAt: null,
      },
      processRuns: true,
      statusWrittenAt: NOW - 30_000,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.name).toBe("demo");
    expect(session.lastWriteAt).toBe(NOW - 10_000);
    expect(session).not.toHaveProperty("tokens");
    expect(session).not.toHaveProperty("jump");
    expect(session).not.toHaveProperty("stop");
    expect(session.links).toEqual({});
    expect(CLINE_CAPABILITIES.names.level).toBe("partly");
    expect(CLINE_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(CLINE_CAPABILITIES.tokens.level).toBe("no");
    expect(CLINE_CAPABILITIES.jump.level).toBe("no");
    expect(CLINE_CAPABILITIES.stop.level).toBe("no");
    expect(CLINE_CAPABILITIES.answer.level).toBe("no");
  });

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

  test("Mistral Vibe: only a wait makes a session need you, and only a turn Vibe records as failed fails", () => {
    const types = ["idle", "running", "blocked", "failed", "archived", "something_else", undefined];
    const mapped = statuses(
      types.flatMap((statusType) =>
        ([true, false, "unknown"] as const).flatMap((held) =>
          [true, false].map((tooNew) => mapMistralVibeStatus({ statusType, held, tooNew })),
        ),
      ),
    );
    expect(mapped).toEqual(new Set(["working", "idle", "finished", "failed", "unknown"]));
    expect(mapMistralVibeStatus({ statusType: "running", held: true, waiting: true })).toBe(
      "needs-you",
    );
    expect(MISTRAL_VIBE_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(MISTRAL_VIBE_CAPABILITIES.failed.level).toBe("partly");
    expect(MISTRAL_VIBE_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Mistral Vibe: a session has the time of its last write, its tokens, and no jump, stop or pid", () => {
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
        tokens: { input: 2_000, cached: 800, output: 64 },
      },
      title: null,
      cwd: "/Users/example/code/demo",
      held: true,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.lastWriteAt).toBe(NOW - 10_000);
    expect(session.name).toBe("demo");
    expect(session.tokens).toEqual({ input: 2_000, cached: 800, output: 64 });
    for (const key of ["jump", "stop", "pid", "alive"]) {
      expect(session, key).not.toHaveProperty(key);
    }
    expect(session.links).toEqual({});
    expect(MISTRAL_VIBE_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(MISTRAL_VIBE_CAPABILITIES.names.level).toBe("partly");
    expect(MISTRAL_VIBE_CAPABILITIES.tokens.level).toBe("yes");
    expect(MISTRAL_VIBE_CAPABILITIES.jump.level).toBe("no");
    expect(MISTRAL_VIBE_CAPABILITIES.stop.level).toBe("no");
    expect(MISTRAL_VIBE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Gemini CLI: no line ever makes a session need you or finish, and only a failed request's error fails it", () => {
    const shapes = [false, true].flatMap((empty) =>
      [false, true].flatMap((functionCall) =>
        [false, true].flatMap((functionResponse) =>
          [false, true].flatMap((thoughtOnly) =>
            [false, true].flatMap((note) =>
              [false, true].map((failedRequest) => ({
                empty,
                functionCall,
                functionResponse,
                thoughtOnly,
                note,
                failedRequest,
              })),
            ),
          ),
        ),
      ),
    );
    const toolCalls = [
      null,
      { allCancelled: false, state: "ended" as const, lastAt: NOW },
      { allCancelled: true, state: "ended" as const, lastAt: NOW },
      { allCancelled: false, state: "open" as const, lastAt: NOW },
      { allCancelled: false, state: "unknown" as const, lastAt: NOW },
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
    expect(mapped).toEqual(new Set(["working", "idle", "failed", "unknown"]));
    const failing = messages.filter(
      (message) =>
        mapGeminiCliStatus(replayGeminiCliRecords([...before, { kind: "message", message }]))
          .status === "failed",
    );
    expect(failing.length).toBeGreaterThan(0);
    for (const { type, content } of failing) {
      expect(type).toBe("error");
      expect(content?.failedRequest).toBe(true);
    }
    expect(GEMINI_CLI_CAPABILITIES["needs-you"].level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.finished.level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.failed.level).toBe("partly");
    expect(GEMINI_CLI_CAPABILITIES["working-and-idle"].level).toBe("partly");
  });

  test("Gemini CLI: a session has the time of its last write and its newest reply's token counts, and no jump, stop or link", () => {
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
        tokens: { input: 2_000, cached: 800, output: 64 },
        skipped: 0,
      },
      slug: "demo",
      cwd: "/Users/example/code/demo",
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session?.lastWriteAt).toBe(NOW - 10_000);
    expect(session?.tokens).toEqual({ input: 2_000, cached: 800, output: 64 });
    expect(session).not.toHaveProperty("jump");
    expect(session).not.toHaveProperty("stop");
    expect(session).not.toHaveProperty("pid");
    expect(session?.links).toEqual({});
    expect(GEMINI_CLI_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(GEMINI_CLI_CAPABILITIES.tokens.level).toBe("yes");
    expect(GEMINI_CLI_CAPABILITIES.names.level).toBe("partly");
    expect(GEMINI_CLI_CAPABILITIES.jump.level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.stop.level).toBe("no");
    expect(GEMINI_CLI_CAPABILITIES.answer.level).toBe("no");
  });

  test("OpenCode: only a step under way with a call that waits needs you, and only an error OpenCode records fails", () => {
    const messages = [
      null,
      ...["user", "assistant", "system", 7].flatMap((role) =>
        [null, NOW - 1_000, NOW - 60_000, "soon"].flatMap((completedAt) =>
          [null, "MessageAbortedError", "APIError", "SomeNewError"].flatMap((error) =>
            [null, "stop", "tool-calls", "unknown"].flatMap((finish) =>
              [0, 1].flatMap((tools) =>
                [0, 1].flatMap((shell) =>
                  [null, NOW - 60_000].map((askedAt) => ({
                    role,
                    completedAt,
                    error,
                    finish,
                    tools,
                    shell,
                    askedAt,
                  })),
                ),
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
    expect(mapped).toEqual(
      new Set(["needs-you", "working", "idle", "finished", "failed", "unknown"]),
    );
    const waiting = messages.filter(
      (message) => mapOpencodeStatus({ message, open: true, now: NOW }) === "needs-you",
    );
    expect(waiting.length).toBeGreaterThan(0);
    for (const message of waiting) {
      expect(message).toMatchObject({
        role: "assistant",
        completedAt: null,
        error: null,
        askedAt: NOW - 60_000,
      });
    }
    // With OpenCode closed, nothing is working, idle or waiting.
    const closed = statuses(
      messages.map((message) => mapOpencodeStatus({ message, open: false, now: NOW })),
    );
    expect(closed).toEqual(new Set(["finished", "failed", "unknown"]));
    expect(OPENCODE_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(OPENCODE_CAPABILITIES.failed.level).toBe("partly");
    expect(OPENCODE_CAPABILITIES.finished.level).toBe("partly");
    expect(OPENCODE_CAPABILITIES["working-and-idle"].level).toBe("partly");
  });

  test("OpenCode: a session has its newest finished reply's token counts, no time of its last write, jump, stop or link, and its title for a name", () => {
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
          askedAt: null,
          partsUpdatedAt: NOW - 10_000,
        },
        userCreatedAt: NOW - 40_000,
        tokens: { input: 2_000, cached: 800, output: 64 },
        turn: null,
      },
      open: true,
      now: NOW,
    });
    expect(session).toMatchObject({ status: "working", name: "Rename the helper" });
    expect(session?.tokens).toEqual({ input: 2_000, cached: 800, output: 64 });
    for (const absent of ["lastWriteAt", "jump", "stop", "pid", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session?.links).toEqual({});
    expect(OPENCODE_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(OPENCODE_CAPABILITIES.tokens.level).toBe("partly");
    expect(OPENCODE_CAPABILITIES.names.level).toBe("yes");
    expect(OPENCODE_CAPABILITIES.jump.level).toBe("no");
    expect(OPENCODE_CAPABILITIES.stop.level).toBe("no");
    expect(OPENCODE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Kilo Code: a question needs you, a suggestion waits as idle, and only an error Kilo Code records fails", () => {
    const messages = [
      null,
      ...["user", "assistant", "system"].flatMap((role) =>
        [null, NOW - 1_000, NOW - 60_000].flatMap((completedAt) =>
          [null, "MessageAbortedError", "APIError", "SomeNewError"].flatMap((error) =>
            [null, "stop", "tool-calls"].flatMap((finish) =>
              [null, NOW - 60_000].flatMap((askedAt) =>
                [0, 1].map((idleCall) => ({
                  role,
                  completedAt,
                  error,
                  finish,
                  tools: 1,
                  shell: 0,
                  askedAt,
                  idleCall,
                })),
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
    expect(mapped).toEqual(
      new Set(["needs-you", "working", "idle", "finished", "failed", "unknown"]),
    );
    // A step under way whose one call not over is a suggestion is idle, as Kilo Code shows it.
    const suggesting = {
      role: "assistant",
      completedAt: null,
      error: null,
      finish: null,
      tools: 1,
      shell: 0,
      askedAt: null,
      idleCall: 1,
    };
    expect(mapOpencodeStatus({ message: suggesting, open: true, now: NOW })).toBe("idle");
    expect(
      mapOpencodeStatus({ message: { ...suggesting, idleCall: 0 }, open: true, now: NOW }),
    ).toBe("working");
    // Only a call that waits for the person needs you, whatever else the step holds.
    for (const message of messages) {
      if (mapOpencodeStatus({ message, open: true, now: NOW }) !== "needs-you") continue;
      expect(message).toMatchObject({ completedAt: null, error: null, askedAt: NOW - 60_000 });
    }
    expect(KILO_CODE_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(KILO_CODE_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(KILO_CODE_CAPABILITIES.finished.level).toBe("partly");
    expect(KILO_CODE_CAPABILITIES.failed.level).toBe("partly");
  });

  test("Kilo Code: a session has its newest finished reply's token counts, no time of its last write, jump, stop or link, and its title for a name", () => {
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
          completedAt: NOW - 20_000,
          error: null,
          finish: "stop",
          tools: 0,
          shell: 0,
          askedAt: null,
          idleCall: 0,
          partsUpdatedAt: NOW - 20_000,
        },
        userCreatedAt: NOW - 40_000,
        tokens: { input: 2_000, cached: 800, output: 64 },
        turn: null,
      },
      sourceId: KILO_CODE_SOURCE_ID,
      open: true,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "kilo-code:ses_000000000000000000000000a1",
      source: "kilo-code",
      status: "idle",
      name: "Rename the helper",
    });
    expect(session?.tokens).toEqual({ input: 2_000, cached: 800, output: 64 });
    for (const absent of ["lastWriteAt", "jump", "stop", "pid", "ask", "tokensNotRead"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session?.links).toEqual({});
    expect(KILO_CODE_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(KILO_CODE_CAPABILITIES.tokens.level).toBe("yes");
    expect(KILO_CODE_CAPABILITIES.names.level).toBe("yes");
    expect(KILO_CODE_CAPABILITIES.jump.level).toBe("no");
    expect(KILO_CODE_CAPABILITIES.stop.level).toBe("no");
    expect(KILO_CODE_CAPABILITIES.answer.level).toBe("no");
  });

  test("MiMo Code: a question or a plan needs you, a subagent at work keeps a session working, and only an error MiMo Code records fails", () => {
    const messages = [
      null,
      ...["user", "assistant", "system"].flatMap((role) =>
        [null, NOW - 1_000, NOW - 60_000].flatMap((completedAt) =>
          [null, "MessageAbortedError", "ModelError", "SomeNewError"].flatMap((error) =>
            [null, "stop", "tool-calls"].flatMap((finish) =>
              [null, NOW - 60_000].map((askedAt) => ({
                role,
                completedAt,
                error,
                finish,
                tools: 1,
                shell: 0,
                askedAt,
              })),
            ),
          ),
        ),
      ),
    ];
    const map = (message: (typeof messages)[number], open: boolean, subagents: boolean) =>
      mapOpencodeStatus({ message, open, now: NOW, subagents, failedErrors: MIMO_FAILED_ERRORS });
    const mapped = statuses(
      messages.flatMap((message) =>
        [true, false].flatMap((open) =>
          [true, false].map((subagents) => map(message, open, subagents)),
        ),
      ),
    );
    expect(mapped).toEqual(
      new Set(["needs-you", "working", "idle", "finished", "failed", "unknown"]),
    );
    for (const message of messages) {
      // A subagent at work never leaves a session idle while it is open.
      expect(map(message, true, true)).not.toBe("idle");
      // Only a call that waits for the person needs you, whatever else the step holds.
      if (map(message, true, true) !== "needs-you") continue;
      expect(message).toMatchObject({ completedAt: null, error: null, askedAt: NOW - 60_000 });
    }
    expect(MIMO_CODE_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(MIMO_CODE_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(MIMO_CODE_CAPABILITIES.finished.level).toBe("partly");
    expect(MIMO_CODE_CAPABILITIES.failed.level).toBe("partly");
  });

  test("MiMo Code: a session has its main agent's newest finished reply's token counts, no time of its last write, jump, stop or link, and its title for a name", () => {
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
          completedAt: NOW - 20_000,
          error: null,
          finish: "stop",
          tools: 0,
          shell: 0,
          askedAt: null,
          partsUpdatedAt: NOW - 20_000,
        },
        userCreatedAt: NOW - 40_000,
        tokens: { input: 2_000, cached: 800, output: 64 },
        turn: null,
        subagentsAt: null,
      },
      sourceId: MIMO_CODE_SOURCE_ID,
      open: true,
      now: NOW,
      failedErrors: MIMO_FAILED_ERRORS,
    });
    expect(session).toMatchObject({
      id: "mimo-code:ses_000000000000000000000000a1",
      source: "mimo-code",
      status: "idle",
      name: "Rename the helper",
    });
    expect(session?.tokens).toEqual({ input: 2_000, cached: 800, output: 64 });
    for (const absent of ["lastWriteAt", "jump", "stop", "pid", "ask", "tokensNotRead"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session?.links).toEqual({});
    expect(MIMO_CODE_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(MIMO_CODE_CAPABILITIES.tokens.level).toBe("yes");
    expect(MIMO_CODE_CAPABILITIES.names.level).toBe("partly");
    expect(MIMO_CODE_CAPABILITIES.jump.level).toBe("no");
    expect(MIMO_CODE_CAPABILITIES.stop.level).toBe("no");
    expect(MIMO_CODE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Goose: a session is unknown or finished, and never working, idle, waiting or failed", () => {
    expect(statuses([mapGooseStatus(true), mapGooseStatus(false)])).toEqual(
      new Set(["unknown", "finished"]),
    );
    expect(GOOSE_CAPABILITIES["working-and-idle"].level).toBe("no");
    expect(GOOSE_CAPABILITIES["needs-you"].level).toBe("no");
    expect(GOOSE_CAPABILITIES.failed.level).toBe("no");
    expect(GOOSE_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Goose: a session has its folder's name, and no time of its last write, tokens, jump, stop or link", () => {
    const session = gooseSession({
      row: {
        id: "20261001_1",
        folder: "/Users/example/code/demo",
        ownName: null,
        createdAt: NOW - 60_000,
        updatedAt: NOW - 10_000,
      },
      open: true,
      now: NOW,
    });
    expect(session.name).toBe("demo");
    for (const absent of ["lastWriteAt", "tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(GOOSE_CAPABILITIES.names.level).toBe("partly");
    expect(GOOSE_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(GOOSE_CAPABILITIES.tokens.level).toBe("no");
    expect(GOOSE_CAPABILITIES.jump.level).toBe("no");
    expect(GOOSE_CAPABILITIES.stop.level).toBe("no");
    expect(GOOSE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Crush: a session is unknown or finished, and never working, idle, waiting or failed", () => {
    expect(statuses([mapCrushStatus(true), mapCrushStatus(false)])).toEqual(
      new Set(["unknown", "finished"]),
    );
    expect(CRUSH_CAPABILITIES["working-and-idle"].level).toBe("no");
    expect(CRUSH_CAPABILITIES["needs-you"].level).toBe("no");
    expect(CRUSH_CAPABILITIES.failed.level).toBe("no");
    expect(CRUSH_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Crush: a session has its folder's name, and no time of its last write, tokens, jump, stop or link", () => {
    const session = crushSession({
      folder: "/Users/example/code/demo",
      row: {
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: NOW - 60_000,
        updatedAt: NOW - 10_000,
      },
      open: true,
      now: NOW,
    });
    expect(session.name).toBe("demo");
    for (const absent of ["lastWriteAt", "tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(CRUSH_CAPABILITIES.names.level).toBe("partly");
    expect(CRUSH_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(CRUSH_CAPABILITIES.tokens.level).toBe("no");
    expect(CRUSH_CAPABILITIES.jump.level).toBe("no");
    expect(CRUSH_CAPABILITIES.stop.level).toBe("no");
    expect(CRUSH_CAPABILITIES.answer.level).toBe("no");
  });

  test("Pi: a session is unknown or finished, and never working, idle, waiting or failed", () => {
    expect(statuses([mapPiStatus(true), mapPiStatus(false)])).toEqual(
      new Set(["unknown", "finished"]),
    );
    expect(PI_CAPABILITIES["working-and-idle"].level).toBe("no");
    expect(PI_CAPABILITIES["needs-you"].level).toBe("no");
    expect(PI_CAPABILITIES.failed.level).toBe("no");
    expect(PI_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Pi: a session has its folder's name, and no time of its last write, tokens, jump, stop or link", () => {
    const session = piSession({
      file: {
        id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        cwd: "/Users/example/code/demo",
        startedAt: NOW - 60_000,
        ownName: null,
      },
      open: true,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.name).toBe("demo");
    for (const absent of ["lastWriteAt", "tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(PI_CAPABILITIES.names.level).toBe("partly");
    expect(PI_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(PI_CAPABILITIES.tokens.level).toBe("no");
    expect(PI_CAPABILITIES.jump.level).toBe("no");
    expect(PI_CAPABILITIES.stop.level).toBe("no");
    expect(PI_CAPABILITIES.answer.level).toBe("no");
  });

  test("Kimchi: a session is unknown or finished, and never working, idle, waiting or failed", () => {
    // Kimchi's sessions are mapped as Pi's are.
    expect(statuses([mapPiStatus(true), mapPiStatus(false)])).toEqual(
      new Set(["unknown", "finished"]),
    );
    expect(KIMCHI_CAPABILITIES["working-and-idle"].level).toBe("no");
    expect(KIMCHI_CAPABILITIES["needs-you"].level).toBe("no");
    expect(KIMCHI_CAPABILITIES.failed.level).toBe("no");
    expect(KIMCHI_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Kimchi: a session has its folder's name, and no time of its last write, tokens, jump, stop or link", () => {
    const session = piSession({
      file: {
        id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        cwd: "/Users/example/code/demo",
        startedAt: NOW - 60_000,
        // The Kimchi profile reads no name, so a file never has one.
        ownName: null,
      },
      open: true,
      writtenAt: NOW - 10_000,
      now: NOW,
      sourceId: KIMCHI_SOURCE_ID,
    });
    expect(session).toMatchObject({
      id: "kimchi:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      source: "kimchi",
      name: "demo",
    });
    for (const absent of ["lastWriteAt", "tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(KIMCHI_CAPABILITIES.names.level).toBe("partly");
    expect(KIMCHI_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(KIMCHI_CAPABILITIES.tokens.level).toBe("no");
    expect(KIMCHI_CAPABILITIES.jump.level).toBe("no");
    expect(KIMCHI_CAPABILITIES.stop.level).toBe("no");
    expect(KIMCHI_CAPABILITIES.answer.level).toBe("no");
  });

  test("Droid: a session is unknown or finished, and never working, idle, waiting or failed", () => {
    expect(statuses([mapDroidStatus(true), mapDroidStatus(false)])).toEqual(
      new Set(["unknown", "finished"]),
    );
    expect(DROID_CAPABILITIES["working-and-idle"].level).toBe("no");
    expect(DROID_CAPABILITIES["needs-you"].level).toBe("no");
    expect(DROID_CAPABILITIES.failed.level).toBe("no");
    expect(DROID_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Droid: a session has its folder's name, and no time of its last write, tokens, jump, stop or link", () => {
    const session = droidSession({
      file: { id: "00000000-0000-4000-8000-000000000001", cwd: "/Users/example/code/demo" },
      open: true,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "droid:00000000-0000-4000-8000-000000000001",
      source: "droid",
      name: "demo",
      startedAt: null,
    });
    for (const absent of ["lastWriteAt", "tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(DROID_CAPABILITIES.names.level).toBe("partly");
    expect(DROID_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(DROID_CAPABILITIES.tokens.level).toBe("no");
    expect(DROID_CAPABILITIES.jump.level).toBe("no");
    expect(DROID_CAPABILITIES.stop.level).toBe("no");
    expect(DROID_CAPABILITIES.answer.level).toBe("no");
  });

  test("Grok Build: a session can be any status, and needs you only for a question or a plan", () => {
    const turn = (fields: Partial<ReturnType<typeof emptyGrokBuildTurn>>) => ({
      ...emptyGrokBuildTurn(),
      schemaOk: true,
      outputSeen: true,
      ...fields,
    });
    const facts = (log: ReturnType<typeof turn> | null, fields = {}) => ({
      alive: true,
      listed: true,
      log: log === null ? { state: "unreadable" as const } : { state: "ok" as const, turn: log },
      writtenAt: NOW - 1_000,
      plan: false as const,
      planWrittenAt: null,
      openedAt: NOW - 60_000,
      now: NOW,
      ...fields,
    });
    const mapped = [
      facts(turn({ boundary: "started", at: NOW - 5_000 })),
      facts(turn({ boundary: "started", at: NOW - 5_000, openQuestions: 1, questionSince: NOW })),
      facts(turn({ boundary: "ended", at: NOW - 5_000, outcome: "completed" })),
      facts(turn({ boundary: "ended", at: NOW - 5_000, outcome: "error" })),
      facts(turn({ boundary: "ended", at: NOW - 5_000, outcome: "completed" }), { plan: true }),
      facts(null),
      facts(turn({}), { alive: false }),
    ].map((given) => mapGrokBuildStatus(given));
    expect(statuses(mapped.map((status) => status.status))).toEqual(
      new Set(["working", "needs-you", "idle", "failed", "unknown", "finished"]),
    );
    expect(new Set(mapped.flatMap((status) => status.waitingReason ?? []))).toEqual(
      new Set(["question"]),
    );
    expect(GROK_BUILD_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(GROK_BUILD_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(GROK_BUILD_CAPABILITIES.failed.level).toBe("partly");
    expect(GROK_BUILD_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Grok Build: a session has its process, its log's last write and a Jump, and no tokens, stop or link", () => {
    const session = grokBuildSession({
      entry: {
        sessionId: "019a9a00-0000-7000-8000-000000000001",
        pid: 4242,
        cwd: "/Users/example/code/demo",
        openedAt: NOW - 60_000,
      },
      title: null,
      status: { status: "working", since: NOW - 5_000 },
      writtenAt: NOW - 1_000,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "grok-build:019a9a00-0000-7000-8000-000000000001",
      source: "grok-build",
      name: "demo",
      pid: 4242,
      alive: true,
      lastWriteAt: NOW - 1_000,
    });
    for (const absent of ["tokens", "stop", "ask", "waitingText"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(
      grokBuildJump(session, { pid: 4242, id: "%1", place: "demo:0.1" }, undefined).jump,
    ).toEqual({ kind: "tmux", place: "demo:0.1" });
    expect(GROK_BUILD_CAPABILITIES.names.level).toBe("partly");
    expect(GROK_BUILD_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(GROK_BUILD_CAPABILITIES.tokens.level).toBe("no");
    expect(GROK_BUILD_CAPABILITIES.jump.level).toBe("partly");
    expect(GROK_BUILD_CAPABILITIES.stop.level).toBe("no");
    expect(GROK_BUILD_CAPABILITIES.answer.level).toBe("no");
  });

  test("Oh My Pi: a session is working, needs you for a question, finished, failed or unknown, and never idle", () => {
    const facts = (fields: Partial<OhMyPiFacts>): OhMyPiFacts => ({
      newest: { sort: "prompt" },
      behind: null,
      cutOff: null,
      writtenAt: NOW - 1_000,
      startedAt: NOW - 60_000,
      writer: "backed",
      now: NOW,
      ...fields,
    });
    const mapped = [
      facts({}),
      facts({ newest: { sort: "ask", at: NOW - 5_000 } }),
      facts({ newest: { sort: "exit", fatal: false, at: NOW - 5_000 } }),
      facts({
        newest: { sort: "reply", at: NOW - 1_000 },
        behind: { sort: "exit", fatal: true, at: NOW - 5_000 },
      }),
      facts({ newest: { sort: "reply", at: NOW - 1_000 } }),
      facts({ newest: { sort: "unreadable" } }),
      facts({ newest: null }),
      facts({ writer: "gone" }),
      facts({ writer: "maybe" }),
    ].map((given) => ohMyPiStatusOf(given));
    expect(statuses(mapped.map((status) => status.status))).toEqual(
      new Set(["working", "needs-you", "finished", "failed", "unknown"]),
    );
    expect(new Set(mapped.flatMap((status) => status.waitingReason ?? []))).toEqual(
      new Set(["question"]),
    );
    expect(OH_MY_PI_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(OH_MY_PI_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(OH_MY_PI_CAPABILITIES.failed.level).toBe("partly");
    expect(OH_MY_PI_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Oh My Pi: a session has its title or folder's name and its last write while it works, and no tokens, jump, stop or link", () => {
    const session = ohMyPiSession({
      file: {
        id: "019a9a00-0000-7000-8000-000000000001",
        cwd: "/Users/example/code/demo",
        startedAt: NOW - 60_000,
        title: null,
        tail: { state: "ok", newest: { sort: "prompt" }, behind: null, cutOff: null },
      },
      status: { status: "working", since: null, showsLastWrite: true },
      writtenAt: NOW - 1_000,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "oh-my-pi:019a9a00-0000-7000-8000-000000000001",
      source: "oh-my-pi",
      name: "demo",
      lastWriteAt: NOW - 1_000,
    });
    for (const absent of ["tokens", "stop", "ask", "waitingText", "jump", "pid"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(OH_MY_PI_CAPABILITIES.names.level).toBe("partly");
    expect(OH_MY_PI_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(OH_MY_PI_CAPABILITIES.tokens.level).toBe("no");
    expect(OH_MY_PI_CAPABILITIES.jump.level).toBe("no");
    expect(OH_MY_PI_CAPABILITIES.stop.level).toBe("no");
    expect(OH_MY_PI_CAPABILITIES.answer.level).toBe("no");
  });

  test("Muse Code: a session is working, idle, needs you for a question or an approval, finished, failed or unknown", () => {
    const fold = (change: (fold: MuseFold) => void = () => {}): MuseFold => {
      const made = startMuseFold({ sort: "started", run: "run-1", at: NOW - 60_000 });
      change(made);
      return made;
    };
    const facts = (fields: Partial<MuseCodeFacts>): MuseCodeFacts => ({
      view: { state: "ok", fold: fold() },
      writer: "backed",
      writtenAt: NOW - 1_000,
      decidedAt: NOW - 1_000,
      now: NOW,
      waited: new Set(),
      ...fields,
    });
    const ended = (end: "completed" | "failed") =>
      fold((made) => {
        made.run.state = "ended";
        made.lastEnd = { end, at: NOW - 5_000 };
      });
    const mapped = [
      facts({}),
      facts({ view: { state: "ok", fold: ended("completed") } }),
      facts({ view: { state: "ok", fold: ended("failed") } }),
      facts({ view: { state: "ok", fold: fold((made) => made.prompts.set("p-1", NOW - 5_000)) } }),
      facts({
        view: {
          state: "ok",
          fold: fold((made) =>
            made.approvals.set("a-1", {
              requestedAt: NOW - 5_000,
              phase: "human_pending",
              reviewed: false,
              completion: null,
            }),
          ),
        },
      }),
      facts({ writer: "gone" }),
      facts({ writer: "maybe" }),
      facts({ view: { state: "unsure" } }),
    ].map((given) => museCodeStatusOf(given));
    expect(statuses(mapped.map((status) => status.status))).toEqual(
      new Set(["working", "idle", "needs-you", "finished", "failed", "unknown"]),
    );
    expect(new Set(mapped.flatMap((status) => status.waitingReason ?? []))).toEqual(
      new Set(["question", "permission"]),
    );
    expect(MUSE_CODE_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(MUSE_CODE_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(MUSE_CODE_CAPABILITIES.failed.level).toBe("partly");
    expect(MUSE_CODE_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Muse Code: a session has its workspace folder's name and its last write while it works, and no tokens, jump, stop or link", () => {
    const session = museCodeSession({
      folderName: "019a9a00-0000-7000-8000-000000000001",
      cwd: "/Users/example/code/demo",
      metadataAt: NOW - 60_000,
      status: { status: "working", since: NOW - 60_000, showsLastWrite: true },
      writtenAt: NOW - 1_000,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "muse-code:019a9a00-0000-7000-8000-000000000001",
      source: "muse-code",
      name: "demo",
      lastWriteAt: NOW - 1_000,
    });
    for (const absent of ["tokens", "stop", "ask", "waitingText", "jump", "pid"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(MUSE_CODE_CAPABILITIES.names.level).toBe("partly");
    expect(MUSE_CODE_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(MUSE_CODE_CAPABILITIES.tokens.level).toBe("no");
    expect(MUSE_CODE_CAPABILITIES.jump.level).toBe("no");
    expect(MUSE_CODE_CAPABILITIES.stop.level).toBe("no");
    expect(MUSE_CODE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Copilot CLI: a session is working, idle, needs you for a permission or a question, finished, failed or unknown", () => {
    const fold = (...records: CopilotRecord[]) => {
      const made = startCopilotFold();
      for (const record of [
        { sort: "start", cwd: null, at: NOW - 60_000 } as CopilotRecord,
        ...records,
      ]) {
        applyCopilotRecord(made, record);
      }
      return made;
    };
    const facts = (made = fold(), live: boolean | null = true) => ({
      fold: made,
      live,
      writtenAt: NOW - 1_000,
      changedAt: NOW - 1_000,
      now: NOW,
      seen: new Map<string, number>(),
      waited: new Set<string>(),
    });
    const mapped = [
      facts(fold({ sort: "user", at: NOW - 5_000 })),
      facts(),
      facts(fold({ sort: "permission", request: "r-1", byHook: false, at: NOW - 5_000 })),
      facts(fold({ sort: "tool-start", call: "c-1", ask: true, at: NOW - 5_000 })),
      facts(fold(), false),
      facts(fold({ sort: "shutdown", kind: "error", at: NOW - 5_000 })),
      facts(fold({ sort: "error", at: NOW - 5_000 })),
    ].map((given) => copilotCliStatusOf(given));
    expect(statuses(mapped.map((status) => status.status))).toEqual(
      new Set(["working", "idle", "needs-you", "finished", "failed", "unknown"]),
    );
    expect(new Set(mapped.flatMap((status) => status.waitingReason ?? []))).toEqual(
      new Set(["question", "permission"]),
    );
    expect(COPILOT_CLI_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(COPILOT_CLI_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(COPILOT_CLI_CAPABILITIES.finished.level).toBe("partly");
    expect(COPILOT_CLI_CAPABILITIES.failed.level).toBe("partly");
  });

  test("Copilot CLI: a session has its working folder's name and its last write while it works, and no tokens, jump, stop or link", () => {
    const session = copilotCliSession({
      folderName: "0aaa0000-0000-4000-8000-000000000001",
      cwd: "/Users/example/code/demo",
      startedAt: NOW - 60_000,
      status: { status: "working", since: NOW - 60_000, showsLastWrite: true },
      writtenAt: NOW - 1_000,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "copilot-cli:0aaa0000-0000-4000-8000-000000000001",
      source: "copilot-cli",
      name: "demo",
      lastWriteAt: NOW - 1_000,
    });
    for (const absent of ["tokens", "stop", "ask", "waitingText", "jump", "pid"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(COPILOT_CLI_CAPABILITIES.names.level).toBe("partly");
    expect(COPILOT_CLI_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(COPILOT_CLI_CAPABILITIES.tokens.level).toBe("no");
    expect(COPILOT_CLI_CAPABILITIES.jump.level).toBe("no");
    expect(COPILOT_CLI_CAPABILITIES.stop.level).toBe("no");
    expect(COPILOT_CLI_CAPABILITIES.answer.level).toBe("no");
  });

  test("Prime Agent: a session is working, idle, finished or unknown, and never waiting or failed", () => {
    const record = (operation: string, busy: boolean): JournalRecord => ({
      sessionId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      sessionFile: null,
      busy,
      operation,
      recordedAt: NOW,
    });
    const shown: SessionStatus[] = [];
    for (const holder of ["runs", "none", "unknown"] as const) {
      const status = primeAgentHolderStatus(holder);
      if (status !== null) shown.push(status);
    }
    for (const operation of ["create", "prompt_accepted", "steer_queued", "turn_end", "killed"]) {
      for (const busy of [true, false]) {
        for (const suspended of [true, false]) {
          shown.push(
            primeAgentJournalStatus({
              sessionId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
              sessionFile: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl",
              createdAt: NOW - 1_000,
              trail: [{ record: record(operation, busy), queue: null }],
              queue: { suspended, recordedAt: NOW },
              idleSince: null,
            }).status,
          );
        }
      }
    }
    expect(statuses(shown)).toEqual(new Set(["working", "idle", "finished", "unknown"]));
    expect(PRIME_AGENT_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(PRIME_AGENT_CAPABILITIES["needs-you"].level).toBe("no");
    expect(PRIME_AGENT_CAPABILITIES.failed.level).toBe("no");
    expect(PRIME_AGENT_CAPABILITIES.finished.level).toBe("partly");
  });

  test("fx: a session is working, finished, failed or unknown, and never idle or waiting", () => {
    const shown: SessionStatus[] = [];
    for (const tail of [
      { turn: "open" as const },
      { turn: "ended" as const, failed: false, at: NOW },
      { turn: "ended" as const, failed: true, at: NOW },
      { turn: "none" as const },
      { turn: "unknown" as const },
    ]) {
      for (const programs of ["none", "some", "unknown"] as const) {
        for (const writerGone of [true, false]) {
          for (const writtenAt of [NOW - 1_000, NOW - 60 * 60_000]) {
            shown.push(mapFxStatus({ tail, programs, writerGone, writtenAt, now: NOW }));
          }
        }
      }
    }
    expect(statuses(shown)).toEqual(new Set(["working", "finished", "failed", "unknown"]));
    expect(FX_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(FX_CAPABILITIES["needs-you"].level).toBe("no");
    expect(FX_CAPABILITIES.failed.level).toBe("partly");
    expect(FX_CAPABILITIES.finished.level).toBe("partly");
  });

  test("fx: a session has its folder's name and its log's last write, and no tokens, jump, stop or link", () => {
    const session = fxSession({
      log: {
        id: "aB3dE5fG7hJ9",
        cwd: "/Users/example/code/demo",
        createdAt: NOW - 60_000,
        tail: { turn: "open" },
        why: null,
        newestTs: NOW - 10_000,
      },
      programs: "some",
      writerGone: false,
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "fx:aB3dE5fG7hJ9",
      source: "fx",
      name: "demo",
      status: "working",
      lastWriteAt: NOW - 10_000,
    });
    for (const absent of ["tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(FX_CAPABILITIES.names.level).toBe("partly");
    expect(FX_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(FX_CAPABILITIES.tokens.level).toBe("no");
    expect(FX_CAPABILITIES.jump.level).toBe("no");
    expect(FX_CAPABILITIES.stop.level).toBe("no");
    expect(FX_CAPABILITIES.answer.level).toBe("no");
  });

  test("Unreal Agent: a session is working, idle, finished, failed or unknown, and never waiting", () => {
    const turn = "00000003-c3d4-4e5f-8a9b-000000000001";
    const op = "00000005-c3d4-4e5f-8a9b-000000000001";
    const files: UnrealAgentItem[][] = [
      [{ kind: "turn", id: turn, type: "regular" }],
      [
        { kind: "turn", id: turn, type: "regular" },
        { kind: "reply", turnId: turn, outcome: "complete" },
      ],
      [
        { kind: "turn", id: turn, type: "regular" },
        { kind: "reply", turnId: turn, outcome: "failed" },
      ],
      [
        { kind: "turn", id: turn, type: "regular" },
        { kind: "reply", turnId: turn, outcome: "complete" },
        { kind: "status-created", ids: [op] },
      ],
      [{ kind: "input", input: "hard" }],
      [{ kind: "unread" }],
    ];
    const shown: SessionStatus[] = [];
    for (const items of files) {
      const replay = startUnrealAgentReplay(true);
      for (const [index, item] of items.entries()) {
        applyUnrealAgentLine(replay, { kind: "item", sequence: index + 1, at: NOW - 60_000, item });
      }
      for (const liveness of ["closed", "may-be-open", "cannot-tell"] as const) {
        for (const writtenAt of [NOW - 10_000, NOW - 60 * 60_000]) {
          shown.push(mapUnrealAgentStatus({ replay, liveness, writtenAt, now: NOW }));
        }
      }
    }
    expect(statuses(shown)).toEqual(new Set(["working", "idle", "finished", "failed", "unknown"]));
    expect(UNREAL_AGENT_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(UNREAL_AGENT_CAPABILITIES["needs-you"].level).toBe("no");
    expect(UNREAL_AGENT_CAPABILITIES.failed.level).toBe("partly");
    expect(UNREAL_AGENT_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Unreal Agent: a session has its folder's name and its file's last write, and no tokens, jump, stop or link", () => {
    const replay = startUnrealAgentReplay(true);
    applyUnrealAgentLine(replay, {
      kind: "item",
      sequence: 1,
      at: NOW - 20_000,
      item: { kind: "turn", id: "00000003-c3d4-4e5f-8a9b-000000000001", type: "regular" },
    });
    const session = unrealAgentSession({
      file: {
        id: "00000001-c3d4-4e5f-8a9b-000000000001",
        createdAt: NOW - 60_000,
        folder: "/Users/example/code/demo",
        replay,
        tooLong: false,
        writtenAt: NOW - 10_000,
      },
      liveness: "may-be-open",
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "unreal-agent:00000001-c3d4-4e5f-8a9b-000000000001",
      source: "unreal-agent",
      name: "demo",
      status: "working",
      lastWriteAt: NOW - 10_000,
    });
    for (const absent of ["tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(UNREAL_AGENT_CAPABILITIES.names.level).toBe("partly");
    expect(UNREAL_AGENT_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(UNREAL_AGENT_CAPABILITIES.tokens.level).toBe("no");
    expect(UNREAL_AGENT_CAPABILITIES.jump.level).toBe("no");
    expect(UNREAL_AGENT_CAPABILITIES.stop.level).toBe("no");
    expect(UNREAL_AGENT_CAPABILITIES.answer.level).toBe("no");
  });

  test("Autohand Code: a session is working, idle, needs you, finished, failed or unknown", () => {
    const shown: SessionStatus[] = [];
    const classes: HeartbeatClass[] = ["fresh", "quiet", "just-dead", "gone"];
    const phases = ["idle", "thinking", "waiting_input", null] as const;
    for (const heartbeatClass of classes) {
      for (const phase of phases) {
        for (const metadata of ["active", "completed", "crashed", "other", null] as const) {
          const evidence: AutohandEvidence = {
            chosen: { name: "a.json", pid: 7, updatedAt: NOW, phase, heartbeatClass },
            metadata,
            movedOn: false,
            standIn: null,
            ended: false,
            lastProcessGone: false,
          };
          shown.push(autohandStatusOf(evidence).status);
          shown.push(autohandStatusOf({ ...evidence, chosen: null }).status);
        }
      }
    }
    expect(statuses(shown)).toEqual(
      new Set(["needs-you", "working", "idle", "finished", "failed", "unknown"]),
    );
    expect(AUTOHAND_CODE_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(AUTOHAND_CODE_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(AUTOHAND_CODE_CAPABILITIES.finished.level).toBe("partly");
    expect(AUTOHAND_CODE_CAPABILITIES.failed.level).toBe("partly");
  });

  test("Autohand Code: a session has its folder's name and its metadata.json's last write, a Jump only for a pane or a tab, and no tokens, stop or link", () => {
    const session = autohandCodeSession({
      sessionId: "0b5d6c1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e-1762772400000",
      status: "working",
      statusSince: NOW - 10_000,
      facts: {
        status: "active",
        createdAt: NOW - 60_000,
        lastActiveAt: NOW - 20_000,
        closedAt: null,
        importedAt: null,
        projectPath: "/Users/example/code/demo",
        title: null,
        client: "terminal",
      },
      writtenAt: NOW - 20_000,
      heartbeat: { workspaceRoot: null, mode: "interactive", startedAt: null },
      process: { pid: 7, alive: true },
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "autohand-code:0b5d6c1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e-1762772400000",
      source: "autohand-code",
      name: "demo",
      status: "working",
      lastWriteAt: NOW - 20_000,
    });
    for (const absent of ["tokens", "jump", "stop", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    // Jump is added once a fresh heartbeat's process is found in a tmux pane or a tab.
    expect(
      autohandCodeJump(session, { pid: 7, id: "%1", place: "demo:0.1" }, undefined).jump,
    ).toEqual({ kind: "tmux", place: "demo:0.1" });
    expect(AUTOHAND_CODE_CAPABILITIES.names.level).toBe("partly");
    expect(AUTOHAND_CODE_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(AUTOHAND_CODE_CAPABILITIES.tokens.level).toBe("no");
    expect(AUTOHAND_CODE_CAPABILITIES.jump.level).toBe("partly");
    expect(AUTOHAND_CODE_CAPABILITIES.stop.level).toBe("no");
    expect(AUTOHAND_CODE_CAPABILITIES.answer.level).toBe("no");
  });

  test("DeepSeek Harness: a session is working, idle, needs you, finished, failed or unknown", () => {
    const shown: SessionStatus[] = [];
    const open = (waits: boolean): DeepseekHarnessTurn => ({
      state: "open",
      since: NOW - 60_000,
      approvals: new Map(waits ? [["a", NOW - 30_000]] : []),
      questions: new Map(),
      waitSince: waits ? NOW - 30_000 : null,
    });
    const turns: (DeepseekHarnessTurn | null)[] = [
      null,
      { state: "unsure" },
      { state: "none", since: NOW - 60_000 },
      open(false),
      open(true),
      ...(["completed", "error", "disposed", "other"] as const).map((end): DeepseekHarnessTurn => ({
        state: "ended",
        end,
        at: NOW - 10_000,
      })),
    ];
    const writers: DeepseekHarnessWriter[] = ["gone", "backed", "maybe"];
    for (const own of turns) {
      for (const writer of writers) {
        for (const writtenAt of [NOW - 10_000, null]) {
          shown.push(
            deepseekHarnessStatusOf({ own, children: [], writtenAt, writer, now: NOW }).status,
          );
        }
      }
    }
    expect(statuses(shown)).toEqual(
      new Set(["needs-you", "working", "idle", "finished", "failed", "unknown"]),
    );
    expect(DEEPSEEK_HARNESS_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(DEEPSEEK_HARNESS_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(DEEPSEEK_HARNESS_CAPABILITIES.finished.level).toBe("partly");
    expect(DEEPSEEK_HARNESS_CAPABILITIES.failed.level).toBe("partly");
  });

  test("DeepSeek Harness: a working session has its title and its last write, and no tokens, jump, stop or link", () => {
    const session = deepseekHarnessSession({
      folderName: "session-0b5d6c1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e",
      header: {
        id: "session-0b5d6c1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e",
        createdAt: NOW - 60_000,
        cwd: "/Users/example/code/demo",
        parentSession: null,
        subagent: false,
      },
      title: "Fix the build",
      status: { status: "working", since: NOW - 30_000, showsLastWrite: true },
      writtenAt: NOW - 20_000,
      now: NOW,
    });
    expect(session).toMatchObject({
      id: "deepseek-harness:session-0b5d6c1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e",
      source: "deepseek-harness",
      name: "Fix the build",
      project: "demo",
      status: "working",
      lastWriteAt: NOW - 20_000,
    });
    for (const absent of ["tokens", "jump", "stop", "ask", "pid"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(DEEPSEEK_HARNESS_CAPABILITIES.names.level).toBe("partly");
    expect(DEEPSEEK_HARNESS_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(DEEPSEEK_HARNESS_CAPABILITIES.tokens.level).toBe("no");
    expect(DEEPSEEK_HARNESS_CAPABILITIES.jump.level).toBe("no");
    expect(DEEPSEEK_HARNESS_CAPABILITIES.stop.level).toBe("no");
    expect(DEEPSEEK_HARNESS_CAPABILITIES.answer.level).toBe("no");
  });

  test("Prime Agent: a working session has the time of its file's last write, and no tokens, jump, stop or link", () => {
    const file = {
      id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      cwd: "/Users/example/code/demo",
      startedAt: NOW - 60_000,
      ownName: "demo name",
    };
    const at = { file, open: true, writtenAt: NOW - 10_000, now: NOW };
    const session = piSession({
      ...at,
      sourceId: PRIME_AGENT_SOURCE_ID,
      evidence: { status: "working", since: NOW - 30_000 },
    });
    expect(session).toMatchObject({
      id: "prime-agent:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      source: "prime-agent",
      name: "demo name",
      status: "working",
      statusSince: NOW - 30_000,
      lastWriteAt: NOW - 10_000,
    });
    for (const absent of ["tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    const idle = piSession({
      ...at,
      sourceId: PRIME_AGENT_SOURCE_ID,
      evidence: { status: "idle", since: NOW - 5_000 },
    });
    expect(idle).not.toHaveProperty("lastWriteAt");
    expect(PRIME_AGENT_CAPABILITIES.names.level).toBe("partly");
    expect(PRIME_AGENT_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(PRIME_AGENT_CAPABILITIES.tokens.level).toBe("no");
    expect(PRIME_AGENT_CAPABILITIES.jump.level).toBe("no");
    expect(PRIME_AGENT_CAPABILITIES.stop.level).toBe("no");
    expect(PRIME_AGENT_CAPABILITIES.answer.level).toBe("no");
  });

  test("Continue: a session is unknown, and never working, idle, waiting, finished or failed", () => {
    const session = continueSession(
      { id: "00000000-0000-4000-8000-000000000001", folder: null, createdAt: null },
      NOW,
    );
    expect(session.status).toBe("unknown");
    for (const row of ["working-and-idle", "needs-you", "finished", "failed"] as const) {
      expect(CONTINUE_CAPABILITIES[row].level, row).toBe("no");
    }
  });

  test("Continue: a session has its folder's name, and no time of its last write, tokens, jump, stop or link", () => {
    const session = continueSession(
      {
        id: "00000000-0000-4000-8000-000000000001",
        folder: "/Users/example/code/demo",
        createdAt: NOW - 60_000,
      },
      NOW,
    );
    expect(session.name).toBe("demo");
    for (const absent of ["lastWriteAt", "tokens", "jump", "stop", "pid", "alive", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(CONTINUE_CAPABILITIES.names.level).toBe("partly");
    expect(CONTINUE_CAPABILITIES["quiet-for"].level).toBe("no");
    expect(CONTINUE_CAPABILITIES.tokens.level).toBe("no");
    expect(CONTINUE_CAPABILITIES.jump.level).toBe("no");
    expect(CONTINUE_CAPABILITIES.stop.level).toBe("no");
    expect(CONTINUE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Kimi Code: every status a session can show comes from what it declares", () => {
    const all = [true, false];
    const found = all.flatMap((held) =>
      all.flatMap((waiting) =>
        all.flatMap((lastHolderRuns) =>
          all.map((lastTurnFailed) =>
            mapKimiCodeStatus({ held, waiting, lastHolderRuns, lastTurnFailed }),
          ),
        ),
      ),
    );
    expect(statuses(found)).toEqual(
      new Set(["working", "needs-you", "idle", "finished", "failed"]),
    );
    for (const row of ["working-and-idle", "needs-you", "finished", "failed"] as const) {
      expect(KIMI_CODE_CAPABILITIES[row].level, row).toBe("partly");
    }
  });

  test("Kimi Code: a session has its folder's name, and no tokens, jump, stop or link", () => {
    const session = kimiCodeSession({
      session: {
        id: "session_00000000-0000-4000-8000-000000000001",
        bucket: "wd_demo_0a1b2c3d4e5f",
        folder: "/Users/example/code/demo",
      },
      state: {
        folder: "/Users/example/code/demo",
        ownName: null,
        createdAt: NOW - 60_000,
        updatedAt: NOW - 10_000,
        lastTurnFailed: false,
        listed: true,
      },
      lock: null,
      lastHolder: null,
      wait: null,
      stateWrittenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.name).toBe("demo");
    for (const absent of ["tokens", "jump", "stop", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
    expect(KIMI_CODE_CAPABILITIES.names.level).toBe("partly");
    expect(KIMI_CODE_CAPABILITIES["quiet-for"].level).toBe("partly");
    expect(KIMI_CODE_CAPABILITIES.tokens.level).toBe("no");
    expect(KIMI_CODE_CAPABILITIES.jump.level).toBe("no");
    expect(KIMI_CODE_CAPABILITIES.stop.level).toBe("no");
    expect(KIMI_CODE_CAPABILITIES.answer.level).toBe("no");
  });

  test("Qwen Code: only a reply that asks you a question or for a plan's approval makes a session need you, and no line fails or finishes one", () => {
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
    const asking: QwenCodeRecord[] = [
      {
        type: "assistant",
        at: NOW - 50_000,
        message: true,
        calls: true,
        waitsOn: "ask_user_question",
      },
      {
        type: "assistant",
        at: NOW - 50_000,
        message: true,
        calls: true,
        waitsOn: "exit_plan_mode",
      },
    ];
    const pairsOf = (lines: QwenCodeRecord[]) =>
      statuses(
        lines.flatMap((first) =>
          lines.flatMap((second) =>
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
    // A reply that calls any other tool, as one waiting for its approval, is working.
    expect(pairsOf(records)).toEqual(new Set(["working", "idle", "unknown"]));
    expect(pairsOf([...records, ...asking])).toEqual(
      new Set(["working", "needs-you", "idle", "unknown"]),
    );
    expect(QWEN_CODE_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(QWEN_CODE_CAPABILITIES["needs-you"].level).toBe("partly");
    expect(QWEN_CODE_CAPABILITIES.failed.level).toBe("no");
    expect(QWEN_CODE_CAPABILITIES.finished.level).toBe("partly");
  });

  test("Qwen Code: a session has its process, the time of its last write and its newest reply's token counts, a jump only for a pane or a tab, and no stop", () => {
    const records: QwenCodeRecord[] = [
      { type: "user", at: NOW - 30_000 },
      {
        type: "assistant",
        at: NOW - 20_000,
        message: true,
        tokens: { input: 2_000, cached: 800, output: 64 },
      },
    ];
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
        fold: records.reduce(foldQwenCodeRecord, startQwenCodeFold(true)),
        firstAt: NOW - 30_000,
      },
      writtenAt: NOW - 10_000,
      now: NOW,
    });
    expect(session.lastWriteAt).toBe(NOW - 10_000);
    expect(session.pid).toBe(41001);
    expect(session.tokens).toEqual({ input: 2_000, cached: 800, output: 64 });
    expect(session).not.toHaveProperty("jump");
    expect(session).not.toHaveProperty("stop");
    expect(session).not.toHaveProperty("ask");
    expect(session.links).toEqual({});
    // Jump is added once its process is found in a tmux pane or a tab, and never as a link.
    expect(withJump(session, { pid: 4100, id: "%3", place: "work:0.1" }, undefined).jump).toEqual({
      kind: "tmux",
      place: "work:0.1",
    });
    expect(QWEN_CODE_CAPABILITIES["quiet-for"].level).toBe("yes");
    expect(QWEN_CODE_CAPABILITIES.tokens.level).toBe("yes");
    expect(QWEN_CODE_CAPABILITIES.names.level).toBe("partly");
    expect(QWEN_CODE_CAPABILITIES.jump.level).toBe("partly");
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
