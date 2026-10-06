import { describe, expect, test } from "vitest";

import type { CleanUpOutcome } from "@core/api";
import type { Session } from "@core/sessions/session";
import {
  cleanUpEntries,
  cleanUpSummary,
  endLabel,
  leftRunning,
} from "@dashboard/lib/stop/leftRunning";
import { makeSession } from "@tests/fixtures/session";

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000 + 100 * HOUR;

/** A session idle since so many hours ago, alive, that the collector can stop. */
function idle(n: number, hours: number, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${n}`,
    name: `demo-${n}`,
    status: "idle",
    statusSince: NOW - hours * HOUR,
    stale: hours >= 24,
    pid: 4240 + n,
    alive: true,
    surface: "vscode",
    stop: { how: "signal" },
    ...overrides,
  });
}

describe("the sessions left running", () => {
  test("are the live Claude Code sessions idle a day or more that can be stopped, the longest idle first", () => {
    const found = leftRunning([idle(1, 30), idle(2, 72), idle(3, 25)], NOW);
    expect(found.map((one) => [one.session.id, one.idleMs / HOUR, one.endable])).toEqual([
      ["claude-code:2", 72, true],
      ["claude-code:1", 30, true],
      ["claude-code:3", 25, true],
    ]);
  });

  test.each<[string, Session]>([
    ["idle less than a day", idle(1, 23)],
    ["working", idle(1, 30, { status: "working", stale: false })],
    ["whose process has gone", idle(1, 30, { alive: false })],
    ["whose process is not known", idle(1, 30, { alive: undefined })],
    ["of another source", idle(1, 30, { source: "codex", stop: undefined })],
    ["that cannot be stopped", idle(1, 30, { stop: undefined, surface: "terminal" })],
    ["with no status time", idle(1, 30, { statusSince: null })],
  ])("leave out a session %s", (_what, session) => {
    expect(leftRunning([session], NOW)).toEqual([]);
  });

  test("hold a session in the desktop app too, which cannot be ended from here", () => {
    const [one] = leftRunning([idle(1, 30, { surface: "desktop", stop: undefined })], NOW);
    expect(one).toMatchObject({ endable: false });
    expect(cleanUpEntries([one as never])).toEqual([]);
  });
});

describe("what End asks for", () => {
  test("each one that can be ended, with the moment its idle began as shown, at most twenty", () => {
    const many = Array.from({ length: 25 }, (_, index) => idle(index + 1, 30 + index));
    const found = leftRunning(many, NOW);
    const entries = cleanUpEntries(found);

    expect(entries).toHaveLength(20);
    expect(entries[0]).toEqual({ sessionId: "claude-code:25", statusSince: NOW - 54 * HOUR });
  });

  test("the button says how many", () => {
    expect(endLabel(3)).toBe("End 3 sessions");
    expect(endLabel(1)).toBe("End 1 session");
    expect(endLabel(0)).toBe("End 0 sessions");
  });
});

describe("what a clean-up came to", () => {
  test.each<[CleanUpOutcome[], string]>([
    [["ended", "ended"], "Ended 2."],
    [["ended", "ended", "became-active"], "Ended 2. Left 1 running because it became active."],
    [["became-active", "became-active"], "Ended none. Left 2 running because they became active."],
    [["ended", "not-stale"], "Ended 1. Left 1 running because it has been idle less than a day."],
    [
      ["cannot-confirm"],
      "Ended none. Left 1 running because Agent Lookout could not confirm its process.",
    ],
    [["ended", "still-running"], "Ended 1. 1 asked to stop is still running."],
    [["gone", "failed", "not-allowed"], "Ended none. 1 had already ended. 2 could not be stopped."],
  ])("%j is said as %j", (outcomes, said) => {
    expect(cleanUpSummary(outcomes)).toBe(said);
  });
});

test("one idle less than the idle rule says is said to be, in its words", () => {
  expect(cleanUpSummary(["not-stale"], 2 * 24 * 60 * 60 * 1000)).toBe(
    "Ended none. Left 1 running because it has been idle less than 2 days.",
  );
  expect(cleanUpSummary(["not-stale", "not-stale"], 5 * 60 * 60 * 1000)).toBe(
    "Ended none. Left 2 running because they have been idle less than 5 hours.",
  );
});
