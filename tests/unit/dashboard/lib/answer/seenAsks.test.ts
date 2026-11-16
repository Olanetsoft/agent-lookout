import { expect, test } from "vitest";

import type { PermissionAsk, Session } from "@core/sessions/session";
import { NO_ASKS_SEEN, rememberAsks, seenInRun } from "@dashboard/lib/answer/seenAsks";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_600_000;
const SINCE = NOW - 60_000;
const ID = "claude-code:00000000-0000-4000-8000-000000000001";

const ASK: PermissionAsk = {
  requestId: "0123456789abcdef0123456789abcdef",
  tool: "Bash",
  command: "npm test",
  allow: true,
  until: SINCE + 300_000,
};

/** A Claude Code session on this computer waiting for permission since `SINCE`. */
function waiting(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: ID,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: SINCE,
    alive: true,
    ...overrides,
  });
}

test("a request the snapshot holds is remembered: its id, when it is let go and the wait it is in", () => {
  const seen = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })], NOW);
  expect(seen.get(ID)).toEqual({
    requestId: ASK.requestId,
    until: ASK.until,
    statusSince: SINCE,
    seenAt: NOW,
  });
});

test("once the request has gone from the snapshot, it is kept while the session is in that wait", () => {
  const held = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })], NOW);
  const after = rememberAsks(held, [waiting()], NOW);
  expect(after.get(ID)).toEqual(held.get(ID));
  // An answer the collector has marked is still that wait.
  expect(rememberAsks(after, [waiting({ answered: true })], NOW).get(ID)).toEqual(held.get(ID));
});

test("a newer request in the same wait takes the place of the one before", () => {
  const held = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })], NOW);
  const newer = { ...ASK, requestId: "fedcba9876543210fedcba9876543210", until: NOW + 300_000 };
  expect(rememberAsks(held, [waiting({ ask: newer })], NOW).get(ID)).toEqual({
    requestId: newer.requestId,
    until: newer.until,
    statusSince: SINCE,
    seenAt: NOW,
  });
});

test.each<[string, Session[]]>([
  ["has left the list", []],
  ["works again", [waiting({ status: "working", waitingReason: undefined })]],
  ["asks a question", [waiting({ waitingReason: "question" })]],
  ["waits since another time", [waiting({ statusSince: SINCE + 90_000 })]],
])("a session that %s is in another wait, and its request is forgotten", (_what, sessions) => {
  const held = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })], NOW);
  expect(rememberAsks(held, sessions, NOW).has(ID)).toBe(false);
});

test("a time that either side does not know says nothing about the wait, and one given later is the wait's", () => {
  const unknown = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK, statusSince: null })], NOW);
  expect(unknown.get(ID)?.statusSince).toBeNull();
  const known = rememberAsks(unknown, [waiting()], NOW);
  expect(known.get(ID)).toEqual({
    requestId: ASK.requestId,
    until: ASK.until,
    statusSince: SINCE,
    seenAt: NOW,
  });
  // Not known for a moment, it is still that wait; then a later time is another wait.
  const blank = rememberAsks(known, [waiting({ statusSince: null })], NOW);
  expect(blank.get(ID)?.statusSince).toBe(SINCE);
  expect(rememberAsks(blank, [waiting({ statusSince: SINCE + 90_000 })], NOW).has(ID)).toBe(false);
});

test("a request the page could not read is remembered with no time it is let go", () => {
  const seen = rememberAsks(NO_ASKS_SEEN, [waiting({ askNotRead: true })], NOW);
  expect(seen.get(ID)).toEqual({ requestId: null, until: null, statusSince: SINCE, seenAt: NOW });
  expect(rememberAsks(seen, [waiting()], NOW).get(ID)).toEqual(seen.get(ID));
});

test("a wait no request was seen in is not remembered", () => {
  expect(rememberAsks(NO_ASKS_SEEN, [waiting(), makeSession({ id: "codex:1" })], NOW).size).toBe(0);
});

test("a request kept while it is no longer in the snapshot keeps the time it was last read", () => {
  const held = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })], NOW);
  expect(rememberAsks(held, [waiting()], NOW + 2_000).get(ID)?.seenAt).toBe(NOW);
  expect(rememberAsks(held, [waiting({ ask: ASK })], NOW + 2_000).get(ID)?.seenAt).toBe(
    NOW + 2_000,
  );
});

test("in a run, only the requests read since it began are kept", () => {
  const other = "claude-code:00000000-0000-4000-8000-000000000002";
  const before = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })], NOW - 1);
  const since = rememberAsks(before, [waiting(), waiting({ id: other, ask: ASK })], NOW);
  const kept = seenInRun(since, NOW);
  expect([...kept.keys()]).toEqual([other]);
  // Nothing to forget leaves the memory as it is.
  expect(seenInRun(kept, NOW)).toBe(kept);
  expect(seenInRun(NO_ASKS_SEEN, NOW)).toBe(NO_ASKS_SEEN);
});
