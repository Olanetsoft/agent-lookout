import { expect, test } from "vitest";

import type { SourceHealth } from "@core/sessions/session";
import {
  agentLabel,
  overviewSources,
  showsAgents,
  sourceNames,
} from "@dashboard/lib/sources/sources";

const NOW = 1_700_000_000_000;

const claude = (state: SourceHealth["state"]): SourceHealth => ({
  id: "claude-code",
  label: "Claude Code",
  state,
  checkedAt: NOW,
});
const codex = (state: SourceHealth["state"]): SourceHealth => ({
  id: "codex",
  label: "Codex",
  state,
  checkedAt: NOW,
});
const statusFiles = (state: SourceHealth["state"]): SourceHealth => ({
  id: "status-files",
  label: "Status files",
  state,
  checkedAt: NOW,
});

test("source names read as a phrase", () => {
  expect(sourceNames([])).toBe("your agent tools");
  expect(sourceNames([{ label: "Claude Code" }])).toBe("Claude Code");
  expect(sourceNames([{ label: "One" }, { label: "Two" }, { label: "Three" }])).toBe(
    "One, Two and Three",
  );
  // The folder of status files is no product, so in a sentence it is in lower case.
  expect(sourceNames([claude("ok"), codex("ok"), statusFiles("ok")])).toBe(
    "Claude Code, Codex and status files",
  );
});

test("the Overview leaves out a tool that is not on this computer, unless no tool is", () => {
  expect(overviewSources([claude("ok"), codex("unavailable")])).toEqual([claude("ok")]);
  expect(overviewSources([claude("error"), codex("unavailable")])).toEqual([claude("error")]);
  expect(overviewSources([claude("unavailable"), codex("ok")])).toEqual([codex("ok")]);
  // Searching and broken sources are kept: they are news.
  expect(overviewSources([claude("searching"), codex("searching")])).toHaveLength(2);
  expect(overviewSources([claude("ok"), codex("error")])).toHaveLength(2);
  // When nothing is found, that is the whole story, so every source stays.
  const none = [claude("unavailable"), codex("unavailable")];
  expect(overviewSources(none)).toEqual(none);
  // One source alone is untouched, whatever its state.
  expect(overviewSources([claude("unavailable")])).toEqual([claude("unavailable")]);
  expect(overviewSources([])).toEqual([]);
});

test("sessions name their tool only when more than one tool is on this computer", () => {
  expect(showsAgents([claude("ok")])).toBe(false);
  expect(showsAgents([claude("ok"), codex("unavailable")])).toBe(false);
  expect(showsAgents([claude("unavailable"), codex("unavailable")])).toBe(false);
  expect(showsAgents([claude("ok"), codex("ok")])).toBe(true);
  // A tool that is there but cannot be read is still there.
  expect(showsAgents([claude("ok"), codex("error")])).toBe(true);
  expect(showsAgents([claude("searching"), codex("searching")])).toBe(true);
  expect(showsAgents([])).toBe(false);
});

test("a session's tool is its source's own label, or its id when the source is not listed", () => {
  const sources = [claude("ok"), codex("ok")];
  expect(agentLabel({ source: "codex" }, sources)).toBe("Codex");
  expect(agentLabel({ source: "claude-code" }, sources)).toBe("Claude Code");
  expect(agentLabel({ source: "codex" }, [claude("ok")])).toBe("codex");
});

test("a folder of status files that is not set up is never on the Overview", () => {
  expect(overviewSources([claude("ok"), codex("ok"), statusFiles("not-set-up")])).toEqual([
    claude("ok"),
    codex("ok"),
  ]);
  // Not even when nothing is found: the tools that were not found are the story.
  expect(
    overviewSources([claude("unavailable"), codex("unavailable"), statusFiles("not-set-up")]),
  ).toEqual([claude("unavailable"), codex("unavailable")]);
  expect(overviewSources([statusFiles("not-set-up")])).toEqual([]);
  // Once it is read, it is a source like the others.
  expect(overviewSources([claude("unavailable"), statusFiles("ok")])).toEqual([statusFiles("ok")]);
  expect(overviewSources([claude("ok"), statusFiles("error")])).toHaveLength(2);
});

test("agents named by status files count as agents, and the folder itself does not", () => {
  const nightShift = { agent: "Night Shift" };
  const myAgent = { agent: "my-agent" };
  // The folder alone, read or not, is no second agent.
  expect(showsAgents([claude("ok"), statusFiles("ok")])).toBe(false);
  expect(showsAgents([claude("ok"), statusFiles("not-set-up")])).toBe(false);
  // An agent it names is.
  expect(showsAgents([claude("ok"), statusFiles("ok")], [{}, nightShift])).toBe(true);
  // Two agents of its own are two, with no tool found at all.
  expect(
    showsAgents([claude("unavailable"), statusFiles("ok")], [nightShift, myAgent, myAgent]),
  ).toBe(true);
  // One agent alone, however many sessions, says the same thing on every row.
  expect(showsAgents([claude("unavailable"), statusFiles("ok")], [nightShift, nightShift])).toBe(
    false,
  );
  expect(showsAgents([claude("ok"), codex("ok"), statusFiles("not-set-up")])).toBe(true);
});

test("a session from a status file is its own agent's", () => {
  const sources = [claude("ok"), statusFiles("ok")];
  expect(agentLabel({ source: "status-files", agent: "Night Shift" }, sources)).toBe("Night Shift");
  expect(agentLabel({ source: "status-files" }, sources)).toBe("Status files");
});
