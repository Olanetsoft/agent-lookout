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
      },
      HOME,
    ),
  ).toBe(defaults);
  // Codex's own variable counts as Agent Lookout's does.
  expect(sourcesFingerprint({ CODEX_HOME: "/Users/example/.codex" }, HOME)).toBe(defaults);

  const others = [
    sourcesFingerprint({ AGENT_LOOKOUT_CLAUDE_HOME: "/tmp/empty-claude" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_CODEX_HOME: "/tmp/empty-codex" }, HOME),
    sourcesFingerprint({ CODEX_HOME: "/tmp/empty-codex" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_STATUS_DIR: "/tmp/empty-status" }, HOME),
    sourcesFingerprint({ AGENT_LOOKOUT_ANTIGRAVITY_HOME: "/tmp/empty-antigravity" }, HOME),
    sourcesFingerprint({}, "/Users/someone-else"),
  ];
  for (const other of others) expect(other).not.toBe(defaults);
  expect(others.join(" ")).not.toContain("empty");
});
