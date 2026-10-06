import { expect, test } from "vitest";

import { sessionFromHash, sessionHref } from "@dashboard/lib/shell/sessionDetails";
import { viewFromHash } from "@dashboard/lib/shell/view";

test("a session's details have an address under the Overview, with the colon after its source kept", () => {
  expect(sessionHref("claude-code:00000000-0000-4000-8000-000000000001")).toBe(
    "#overview/session/claude-code:00000000-0000-4000-8000-000000000001",
  );
  expect(viewFromHash(sessionHref("codex:1234"))).toBe("overview");
});

test.each([
  "claude-code:00000000-0000-4000-8000-000000000001",
  "codex:019a2b3c-0000-7000-8000-000000000002",
  "status-files:my agent.json",
  "status-files:50% done #2.json",
  "status-files:naïve é.json",
])("the address of %j names it again", (id) => {
  expect(sessionFromHash(sessionHref(id))).toBe(id);
});

test.each(["", "#", "#overview", "#overview/session/", "#sources", "#overview/sessions/codex:1"])(
  "%j names no session",
  (hash) => {
    expect(sessionFromHash(hash)).toBeNull();
  },
);

test("an address typed by hand with a bad escape is read as written", () => {
  expect(sessionFromHash("#overview/session/status-files:100%.json")).toBe(
    "status-files:100%.json",
  );
});
