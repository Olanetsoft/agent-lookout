import { expect, test } from "vitest";

import { sessionHash, sessionIdFromHash } from "@core/sessions/sessionHash";

test("a session's details are under the Overview, with the colon after its source kept", () => {
  expect(sessionHash("claude-code:00000000-0000-4000-8000-000000000001")).toBe(
    "#overview/session/claude-code:00000000-0000-4000-8000-000000000001",
  );
});

test.each([
  "claude-code:00000000-0000-4000-8000-000000000001",
  "codex:019a2b3c-0000-7000-8000-000000000002",
  "status-files:my agent.json",
  "status-files:50% done #2.json",
  "status-files:naïve é.json",
])("the fragment of %j names it again", (id) => {
  expect(sessionIdFromHash(sessionHash(id))).toBe(id);
});

test("a character that would end the fragment or start a query is escaped", () => {
  expect(sessionHash("status-files:a#b?c/d.json")).toBe(
    "#overview/session/status-files:a%23b%3Fc%2Fd.json",
  );
});

test.each(["", "#", "#overview", "#overview/session/", "#sources", "#overview/sessions/codex:1"])(
  "%j names no session",
  (hash) => {
    expect(sessionIdFromHash(hash)).toBeNull();
  },
);

test("a fragment typed by hand with a bad escape is read as written", () => {
  expect(sessionIdFromHash("#overview/session/status-files:100%.json")).toBe(
    "status-files:100%.json",
  );
});
