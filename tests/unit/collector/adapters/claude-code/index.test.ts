import { describe, expect, test } from "vitest";

import {
  createClaudeCodeAdapter,
  FEED_FALLBACK_INTERVAL_MS,
  FEED_INTERVAL_MS,
} from "@collector/adapters/claude-code/index";
import type { RegistryIo } from "@collector/adapters/claude-code/registry";
import { HOME } from "@tests/fixtures/claudeCode";
import { adapterFor, now, watching, WITHHELD } from "@tests/support/claudeCodeAdapter";

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
