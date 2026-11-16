import { expect, test } from "vitest";

import type { PermissionAsk, Session } from "@core/sessions/session";
import { NO_ASKS_SEEN, rememberAsks } from "@dashboard/lib/answer/seenAsks";
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
  const seen = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })]);
  expect(seen.get(ID)).toEqual({ requestId: ASK.requestId, until: ASK.until, statusSince: SINCE });
});

test("once the request has gone from the snapshot, it is kept while the session is in that wait", () => {
  const held = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })]);
  const after = rememberAsks(held, [waiting()]);
  expect(after.get(ID)).toEqual(held.get(ID));
  // An answer the collector has marked is still that wait.
  expect(rememberAsks(after, [waiting({ answered: true })]).get(ID)).toEqual(held.get(ID));
});

test("a newer request in the same wait takes the place of the one before", () => {
  const held = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })]);
  const newer = { ...ASK, requestId: "fedcba9876543210fedcba9876543210", until: NOW + 300_000 };
  expect(rememberAsks(held, [waiting({ ask: newer })]).get(ID)).toEqual({
    requestId: newer.requestId,
    until: newer.until,
    statusSince: SINCE,
  });
});

test.each<[string, Session[]]>([
  ["has left the list", []],
  ["works again", [waiting({ status: "working", waitingReason: undefined })]],
  ["asks a question", [waiting({ waitingReason: "question" })]],
  ["waits since another time", [waiting({ statusSince: SINCE + 90_000 })]],
])("a session that %s is in another wait, and its request is forgotten", (_what, sessions) => {
  const held = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK })]);
  expect(rememberAsks(held, sessions).has(ID)).toBe(false);
});

test("a time that either side does not know says nothing about the wait, and one given later is the wait's", () => {
  const unknown = rememberAsks(NO_ASKS_SEEN, [waiting({ ask: ASK, statusSince: null })]);
  expect(unknown.get(ID)?.statusSince).toBeNull();
  const known = rememberAsks(unknown, [waiting()]);
  expect(known.get(ID)).toEqual({ requestId: ASK.requestId, until: ASK.until, statusSince: SINCE });
  // Not known for a moment, it is still that wait; then a later time is another wait.
  const blank = rememberAsks(known, [waiting({ statusSince: null })]);
  expect(blank.get(ID)?.statusSince).toBe(SINCE);
  expect(rememberAsks(blank, [waiting({ statusSince: SINCE + 90_000 })]).has(ID)).toBe(false);
});

test("a request the page could not read is remembered with no time it is let go", () => {
  const seen = rememberAsks(NO_ASKS_SEEN, [waiting({ askNotRead: true })]);
  expect(seen.get(ID)).toEqual({ requestId: null, until: null, statusSince: SINCE });
  expect(rememberAsks(seen, [waiting()]).get(ID)).toEqual(seen.get(ID));
});

test("a wait no request was seen in is not remembered", () => {
  expect(rememberAsks(NO_ASKS_SEEN, [waiting(), makeSession({ id: "codex:1" })]).size).toBe(0);
});
