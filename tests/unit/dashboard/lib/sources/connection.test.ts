import { expect, test } from "vitest";

import type { Session, SourceHealth } from "@core/sessions/session";
import {
  appsIn,
  problemTitle,
  sourceLine,
  statusSentence,
} from "@dashboard/lib/sources/connection";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_000_000;

const source = (state: SourceHealth["state"], label = "Claude Code"): SourceHealth => ({
  id: "claude-code",
  label,
  state,
  checkedAt: NOW - 2_000,
});

function sessions(...surfaces: Session["surface"][]): Session[] {
  return surfaces.map((surface, index) =>
    makeSession({ id: `claude-code:${index}`, name: `demo-${index}`, surface }),
  );
}

test("while answers arrive with sessions, it says how many and the apps they run in", () => {
  const status = statusSentence(
    "live",
    { sources: [source("ok")], sessions: sessions("terminal", "vscode", "desktop", "vscode") },
    NOW,
  );
  expect(status).toEqual({
    key: "watching",
    text: "Watching 4 sessions in VS Code, the desktop app and a terminal",
    short: "4 sessions",
    fact: { text: "checked 2s ago", ticking: true },
  });
  // A terminal session can run in any terminal, so it is "a terminal".
  const one = statusSentence(
    "live",
    { sources: [source("ok")], sessions: sessions("terminal") },
    NOW,
  );
  expect([one.text, one.short]).toEqual(["Watching 1 session in a terminal", "1 session"]);
});

test("the apps are named once each, in a fixed order, and an unknown app is another app", () => {
  expect(appsIn(sessions("unknown", "terminal", "terminal"))).toBe("a terminal and another app");
  expect(appsIn(sessions("browser", "cloud", "vscode"))).toBe("VS Code, the cloud and a browser");
  expect(appsIn([])).toBe("");
});

test("with no sessions, each state of the source has its own sentence", () => {
  const sentence = (state: SourceHealth["state"]) =>
    statusSentence("live", { sources: [source(state)], sessions: [] }, NOW);

  expect(sentence("ok")).toMatchObject({
    key: "none-running",
    text: "Watching Claude Code, no sessions running",
    short: "No sessions",
  });
  expect(sentence("searching")).toMatchObject({
    key: "searching",
    text: "Looking for Claude Code sessions",
    short: "Looking for sessions",
  });
  expect(sentence("unavailable")).toMatchObject({
    key: "not-found",
    text: "Claude Code was not found",
    short: "Source not found",
  });
  expect(sentence("error")).toMatchObject({
    key: "not-working",
    text: "Claude Code could not be read",
    short: "Source not working",
  });
  // Each still says when it was last checked.
  expect(sentence("error").fact).toEqual({ text: "checked 2s ago", ticking: true });
});

test("with no sources, it says nothing is being watched", () => {
  expect(statusSentence("live", { sources: [], sessions: [] }, NOW)).toEqual({
    key: "no-sources",
    text: "Not watching any agent tool",
    short: "Not watching",
    fact: null,
  });
});

test("before the first answer, and when there never was one, it says so", () => {
  expect(statusSentence("connecting", null, NOW)).toEqual({
    key: "connecting",
    text: "Connecting to the local server",
    short: "Connecting",
    fact: null,
  });
  expect(statusSentence("unreachable", null, NOW)).toEqual({
    key: "not-connected",
    text: "Not connected to the local server",
    short: "Not connected",
    fact: null,
  });
});

test("when answers stop, it names no source and gives the time of the last answer", () => {
  const healthy = { sources: [source("ok")], sessions: sessions("vscode") };
  const lastOkAt = new Date(2026, 9, 3, 14, 32, 7).getTime();
  const status = statusSentence("stalled", healthy, NOW, lastOkAt);

  expect(status).toEqual({
    key: "not-updating",
    text: "Not updating",
    short: "Not updating",
    fact: { text: "since 14:32:07", ticking: false },
  });
  expect(status.text).not.toMatch(/Watching|Claude Code/);
  expect(statusSentence("stalled", healthy, NOW, null).fact).toBeNull();
});

test("the short form keeps the count and drops the names, and says more than one source in the plural", () => {
  const two = (state: SourceHealth["state"]) => [
    source(state),
    { ...source(state, "Other tool"), id: "other-tool" as SourceHealth["id"] },
  ];
  const short = (state: SourceHealth["state"]) =>
    statusSentence("live", { sources: two(state), sessions: [] }, NOW).short;

  expect(short("unavailable")).toBe("Sources not found");
  expect(short("error")).toBe("Sources not working");
  const many = statusSentence(
    "live",
    { sources: [source("ok")], sessions: sessions("vscode", "terminal", "desktop") },
    NOW,
  );
  expect(many.short).toBe("3 sessions");
  expect(many.short).not.toMatch(/VS Code|terminal|desktop/);
});

test("a state the page does not know reads as a problem in the status line too", () => {
  const odd = { ...source("ok"), state: "paused" as SourceHealth["state"] };
  expect(statusSentence("live", { sources: [odd], sessions: [] }, NOW).key).toBe("not-working");
});

test("a source is its state in words, and once answers stop, the last known state", () => {
  expect(sourceLine(source("ok"), false)).toEqual({
    key: "claude-code",
    name: "Claude Code",
    state: "Watching",
  });
  expect(sourceLine(source("searching"), false).state).toBe("Searching");
  expect(sourceLine(source("unavailable"), false).state).toBe("Not found");
  expect(sourceLine(source("error"), false).state).toBe("Not working");

  expect(sourceLine(source("ok"), true).state).toBe("Last known: watching");
  expect(sourceLine(source("searching"), true).state).toBe("Last known: searching");
  expect(sourceLine(source("unavailable"), true).state).toBe("Last known: not found");
  expect(sourceLine(source("error"), true).state).toBe("Last known: not working");
});

test("a source state the page does not know is shown as a problem, not as healthy", () => {
  const odd = { ...source("ok"), state: "paused" as SourceHealth["state"] };
  expect(sourceLine(odd, false).state).toBe("Not working");
  expect(sourceLine(odd, true).state).toBe("Last known: not working");
});

test("each kind of connection failure has its own title", () => {
  expect(problemTitle("no-answer")).toBe("Agent Lookout is not answering");
  expect(problemTitle(null)).toBe("Agent Lookout is not answering");
  expect(problemTitle("error-status")).toBe("Agent Lookout answered with an error");
  expect(problemTitle("not-data")).toBe("The answer was not session data");
});

const codex = (state: SourceHealth["state"]): SourceHealth => ({
  id: "codex",
  label: "Codex",
  state,
  checkedAt: NOW - 2_000,
});

test("a Codex that is not on this computer leaves every sentence as it is with Claude Code alone", () => {
  const cases: [SourceHealth["state"], Session[]][] = [
    ["ok", sessions("terminal", "vscode")],
    ["ok", []],
    ["searching", []],
    ["error", []],
    ["error", sessions("desktop")],
  ];
  for (const [state, list] of cases) {
    const alone = statusSentence("live", { sources: [source(state)], sessions: list }, NOW);
    const both = statusSentence(
      "live",
      { sources: [source(state), codex("unavailable")], sessions: list },
      NOW,
    );
    expect(both, `${state} with ${list.length} sessions`).toEqual(alone);
  }
  for (const phase of ["connecting", "unreachable", "stalled"] as const) {
    const snapshot = {
      sources: [source("ok"), codex("unavailable")],
      sessions: sessions("vscode"),
    };
    expect(statusSentence(phase, snapshot, NOW, NOW - 5_000)).toEqual(
      statusSentence(phase, { ...snapshot, sources: [source("ok")] }, NOW, NOW - 5_000),
    );
  }
});

test("with both tools found, the sentence names them in place of the apps", () => {
  const list = [
    ...sessions("terminal", "vscode"),
    makeSession({ id: "codex:0", source: "codex", name: "demo-codex", surface: "terminal" }),
  ];
  const status = statusSentence(
    "live",
    { sources: [source("ok"), codex("ok")], sessions: list },
    NOW,
  );
  expect(status).toMatchObject({
    key: "watching",
    text: "Watching 3 sessions from Claude Code and Codex",
    short: "3 sessions",
  });
  expect(
    statusSentence("live", { sources: [source("ok"), codex("ok")], sessions: [] }, NOW),
  ).toMatchObject({
    key: "none-running",
    text: "Watching Claude Code and Codex, no sessions running",
  });
  // A tool that cannot be read is not named as watched.
  expect(
    statusSentence("live", { sources: [source("ok"), codex("error")], sessions: list }, NOW).text,
  ).toBe("Watching 3 sessions in VS Code and a terminal");
});

test("with neither tool found, both are named", () => {
  expect(
    statusSentence(
      "live",
      { sources: [source("unavailable"), codex("unavailable")], sessions: [] },
      NOW,
    ),
  ).toMatchObject({
    key: "not-found",
    text: "Claude Code and Codex were not found",
    short: "Sources not found",
  });
  // Codex alone found reads as Codex alone.
  expect(
    statusSentence("live", { sources: [source("unavailable"), codex("ok")], sessions: [] }, NOW)
      .text,
  ).toBe("Watching Codex, no sessions running");
});
