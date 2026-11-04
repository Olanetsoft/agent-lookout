import path from "node:path";

import { expect, test } from "vitest";

import { readHistorySetup, sourcesFingerprint } from "@collector/history/historySettings";

const HOME = "/Users/example";

test("by default the history is kept in ~/.agent-lookout/history, beside the folder of status files", () => {
  expect(readHistorySetup({}, HOME)).toEqual({
    on: true,
    dir: path.resolve("/Users/example/.agent-lookout/history"),
    folder: "~/.agent-lookout/history",
    sources: sourcesFingerprint({}, HOME),
  });
});

test("AGENT_LOOKOUT_HISTORY_DIR names another folder", () => {
  expect(
    readHistorySetup({ AGENT_LOOKOUT_HISTORY_DIR: "/Volumes/notes/lookout" }, HOME),
  ).toMatchObject({
    on: true,
    dir: path.resolve("/Volumes/notes/lookout"),
    folder: path.resolve("/Volumes/notes/lookout"),
  });
  expect(
    readHistorySetup({ AGENT_LOOKOUT_HISTORY_DIR: " /Users/example/kept/history " }, HOME),
  ).toMatchObject({
    on: true,
    dir: path.resolve("/Users/example/kept/history"),
    folder: "~/kept/history",
  });
  // Set but empty is not set.
  expect(readHistorySetup({ AGENT_LOOKOUT_HISTORY_DIR: "  " }, HOME)).toMatchObject({
    dir: path.resolve("/Users/example/.agent-lookout/history"),
  });
});

test("AGENT_LOOKOUT_HISTORY=off keeps it in memory only, wherever a folder is named", () => {
  for (const value of ["off", "OFF", " Off "]) {
    expect(readHistorySetup({ AGENT_LOOKOUT_HISTORY: value }, HOME)).toEqual({ on: false });
  }
  expect(
    readHistorySetup(
      { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_HISTORY_DIR: "/Volumes/notes" },
      HOME,
    ),
  ).toEqual({ on: false });
  // Anything else leaves it on.
  expect(readHistorySetup({ AGENT_LOOKOUT_HISTORY: "on" }, HOME).on).toBe(true);
  expect(readHistorySetup({ AGENT_LOOKOUT_HISTORY: "no" }, HOME).on).toBe(true);
});

test("the fingerprint of the folders sessions are read from names none of them, and changes with any", () => {
  const defaults = sourcesFingerprint({}, HOME);
  expect(defaults).toMatch(/^[0-9a-f]{32}$/);
  // The folders the adapters read by default, named outright, are the same folders.
  expect(
    sourcesFingerprint(
      {
        AGENT_LOOKOUT_CLAUDE_HOME: "/Users/example/.claude",
        AGENT_LOOKOUT_CODEX_HOME: "/Users/example/.codex/",
        AGENT_LOOKOUT_STATUS_DIR: " /Users/example/.agent-lookout/sessions ",
        AGENT_LOOKOUT_ANTIGRAVITY_HOME: "/Users/example/.gemini/antigravity-cli",
        AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME: "/Users/example/.gemini/antigravity",
        AGENT_LOOKOUT_VIBE_SESSION_DIR: "/Users/example/.vibe/logs/session",
        AGENT_LOOKOUT_OPENCODE_HOME: "/Users/example/.local/share/opencode",
        AGENT_LOOKOUT_QWEN_HOME: "/Users/example/.qwen",
      },
      HOME,
    ),
  ).toBe(defaults);
  // Codex's own variable counts as Agent Lookout's does, and so do Vibe's and
  // Qwen Code's; Gemini CLI's names its home folder, and OpenCode's own name
  // its database.
  expect(sourcesFingerprint({ CODEX_HOME: "/Users/example/.codex" }, HOME)).toBe(defaults);
  expect(sourcesFingerprint({ VIBE_HOME: "/Users/example/.vibe" }, HOME)).toBe(defaults);
  expect(sourcesFingerprint({ GEMINI_CLI_HOME: "/Users/example" }, HOME)).toBe(defaults);
  expect(sourcesFingerprint({ XDG_DATA_HOME: "/Users/example/.local/share" }, HOME)).toBe(defaults);
  expect(sourcesFingerprint({ OPENCODE_DB: "opencode.db" }, HOME)).toBe(defaults);
  expect(
    sourcesFingerprint(
      { QWEN_HOME: "/Users/example/.qwen", QWEN_RUNTIME_DIR: "/Users/example/.qwen" },
      HOME,
    ),
  ).toBe(defaults);
  // Hermes Agent's own variable names its root, or a profile's folder in it.
  expect(sourcesFingerprint({ HERMES_HOME: "/Users/example/.hermes" }, HOME)).toBe(defaults);
  expect(sourcesFingerprint({ HERMES_HOME: "/Users/example/.hermes/profiles/coder" }, HOME)).toBe(
    defaults,
  );
  // Cline's own variables name its folder, its data folder or its sessions folder.
  expect(sourcesFingerprint({ CLINE_DIR: "/Users/example/.cline" }, HOME)).toBe(defaults);
  expect(sourcesFingerprint({ CLINE_DATA_DIR: "/Users/example/.cline/data" }, HOME)).toBe(defaults);
  expect(
    sourcesFingerprint({ CLINE_SESSION_DATA_DIR: "/Users/example/.cline/data/sessions" }, HOME),
  ).toBe(defaults);
  // Goose's data folder is `~/.local/share/goose`, and `data` in the root its own variable names.
  expect(sourcesFingerprint({ XDG_DATA_HOME: "relative/data" }, HOME)).toBe(defaults);
  // A relative folder of Pi's cannot be followed.
  expect(sourcesFingerprint({ PI_CODING_AGENT_SESSION_DIR: "relative/sessions" }, HOME)).toBe(
    defaults,
  );
  // Kimi Code's own variable can name the folder it has anyway.
  expect(sourcesFingerprint({ KIMI_CODE_HOME: "/Users/example/.kimi-code" }, HOME)).toBe(defaults);
  // A relative folder of Continue's cannot be followed.
  expect(sourcesFingerprint({ CONTINUE_GLOBAL_DIR: "relative/continue" }, HOME)).toBe(defaults);
  // A relative folder of Crush's cannot be followed.
  expect(sourcesFingerprint({ CRUSH_GLOBAL_DATA: "relative/crush" }, HOME)).toBe(defaults);
  // Agent Lookout's names the root outright. A home folder is a whole path,
  // with a drive on Windows, as the system gives it.
  const home = path.resolve(HOME);
  expect(sourcesFingerprint({ AGENT_LOOKOUT_HERMES_HOME: path.join(home, ".hermes") }, home)).toBe(
    sourcesFingerprint({}, home),
  );

  const others = [
    sourcesFingerprint({ AGENT_LOOKOUT_CLAUDE_HOME: "/tmp/empty-claude" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_CODEX_HOME: "/tmp/empty-codex" }, HOME),
    sourcesFingerprint({ CODEX_HOME: "/tmp/empty-codex" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_STATUS_DIR: "/tmp/empty-status" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_ANTIGRAVITY_HOME: "/tmp/empty-antigravity" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME: "/tmp/empty-antigravity-app" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_VIBE_SESSION_DIR: "/tmp/empty-vibe" }, HOME),
    sourcesFingerprint({ VIBE_HOME: "/tmp/empty-vibe-home" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_GEMINI_CLI_HOME: "/tmp/empty-gemini" }, HOME),
    sourcesFingerprint({ GEMINI_CLI_HOME: "/tmp/empty-gemini-home" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_OPENCODE_HOME: "/tmp/empty-opencode" }, HOME),
    sourcesFingerprint({ XDG_DATA_HOME: "/tmp/empty-data" }, HOME),
    sourcesFingerprint({ OPENCODE_DB: "/tmp/empty-opencode.db" }, HOME),
    sourcesFingerprint({ OPENCODE_DB: ":memory:" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_QWEN_HOME: "/tmp/empty-qwen" }, HOME),
    sourcesFingerprint({ QWEN_HOME: "/tmp/empty-qwen" }, HOME),
    sourcesFingerprint({ QWEN_RUNTIME_DIR: "/tmp/empty-qwen" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_HERMES_HOME: "/tmp/empty-hermes" }, HOME),
    sourcesFingerprint({ HERMES_HOME: "/tmp/empty-hermes" }, HOME),
    sourcesFingerprint({ HERMES_HOME: "/tmp/hermes/profiles/work" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_CLINE_HOME: "/tmp/empty-cline" }, HOME),
    sourcesFingerprint({ CLINE_DIR: "/tmp/empty-cline" }, HOME),
    sourcesFingerprint({ CLINE_DATA_DIR: "/tmp/empty-cline" }, HOME),
    sourcesFingerprint({ CLINE_SESSION_DATA_DIR: "/tmp/empty-cline" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_GOOSE_HOME: "/tmp/empty-goose" }, HOME),
    sourcesFingerprint({ GOOSE_PATH_ROOT: path.resolve("/tmp/empty-goose") }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_PI_HOME: "/tmp/empty-pi" }, HOME),
    sourcesFingerprint({ PI_CODING_AGENT_DIR: path.resolve("/tmp/empty-pi") }, HOME),
    sourcesFingerprint({ PI_CODING_AGENT_SESSION_DIR: path.resolve("/tmp/empty-pi") }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_KIMI_CODE_HOME: "/tmp/empty-kimi" }, HOME),
    sourcesFingerprint({ KIMI_CODE_HOME: "/tmp/empty-kimi" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_CONTINUE_HOME: "/tmp/empty-continue" }, HOME),
    sourcesFingerprint({ CONTINUE_GLOBAL_DIR: path.resolve("/tmp/empty-continue") }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_CRUSH_HOME: "/tmp/empty-crush" }, HOME),
    sourcesFingerprint({ CRUSH_GLOBAL_DATA: path.resolve("/tmp/empty-crush") }, HOME),
    sourcesFingerprint({}, "/Users/someone-else"),
  ];
  for (const other of others) expect(other).not.toBe(defaults);
  expect(others.join(" ")).not.toContain("empty");
});

test("on a Mac the fingerprint holds Gemini CLI's folder kept under macOS Seatbelt, which AGENT_LOOKOUT_GEMINI_CLI_HOME stops reading", () => {
  const mac = sourcesFingerprint({}, HOME, "darwin");
  const linux = sourcesFingerprint({}, HOME, "linux");
  const named = { AGENT_LOOKOUT_GEMINI_CLI_HOME: "/Users/example/.gemini" };
  // Elsewhere only ~/.gemini is read, so naming it outright is the same folders.
  expect(sourcesFingerprint(named, HOME, "linux")).toBe(linux);
  // On a Mac, naming it leaves ~/.cache/.gemini unread, so the copy sees other sessions.
  expect(sourcesFingerprint(named, HOME, "darwin")).not.toBe(mac);
  // Gemini CLI's own variable moves both folders: naming the home folder is the same.
  expect(sourcesFingerprint({ GEMINI_CLI_HOME: "/Users/example" }, HOME, "darwin")).toBe(mac);
  expect(sourcesFingerprint({ GEMINI_CLI_HOME: "/Volumes/work" }, HOME, "darwin")).not.toBe(mac);
  // The history's setup works it out for the system it is given.
  expect(readHistorySetup({}, HOME, "darwin")).toMatchObject({ sources: mac });
  expect(readHistorySetup({}, HOME, "linux")).toMatchObject({ sources: linux });
  expect(mac).not.toBe(linux);
});
