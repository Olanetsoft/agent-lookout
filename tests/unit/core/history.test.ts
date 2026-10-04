import { expect, test } from "vitest";

import { DEFAULT_HISTORY_WINDOW_MS, historyPointFor } from "@core/history";
import { makeSession } from "@tests/fixtures/session";

const at = 1_700_000_060_000;

test("the default window is 15 minutes", () => {
  expect(DEFAULT_HISTORY_WINDOW_MS).toBe(900_000);
});

test("no sessions is a point of zeros, not a missing point", () => {
  expect(historyPointFor([], at)).toEqual({ at, needsYou: 0, working: 0, idle: 0, total: 0 });
});

test("each status is counted, and the total includes the ones with no count of their own", () => {
  const sessions = [
    makeSession({ id: "claude-code:1", status: "needs-you" }),
    makeSession({ id: "claude-code:2", status: "working" }),
    makeSession({ id: "claude-code:3", status: "working" }),
    makeSession({ id: "claude-code:4", status: "idle" }),
    makeSession({ id: "claude-code:5", status: "idle" }),
    makeSession({ id: "claude-code:6", status: "idle" }),
    makeSession({ id: "claude-code:7", status: "finished" }),
    makeSession({ id: "claude-code:8", status: "failed" }),
    makeSession({ id: "claude-code:9", status: "unknown" }),
  ];
  expect(historyPointFor(sessions, at)).toEqual({
    at,
    needsYou: 1,
    working: 2,
    idle: 3,
    total: 9,
  });
});

test("a stale session is not counted as idle, as the tiles do not count it, but is in the total", () => {
  const sessions = [
    makeSession({ id: "claude-code:1", status: "idle" }),
    makeSession({ id: "claude-code:2", status: "idle", stale: true }),
    makeSession({ id: "claude-code:3", status: "idle", stale: true }),
  ];
  expect(historyPointFor(sessions, at)).toEqual({
    at,
    needsYou: 0,
    working: 0,
    idle: 1,
    total: 3,
  });
});
