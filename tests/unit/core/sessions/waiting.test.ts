import { expect, test } from "vitest";

import { sessionTitle, waitingLabel, waitingPhrase, waitNotice } from "@core/sessions/waiting";
import { makeSession } from "@tests/fixtures/session";

test("a waiting reason is said in plain words", () => {
  expect(waitingLabel({ waitingReason: "permission" })).toBe("Waiting for permission");
  expect(waitingLabel({ waitingReason: "question" })).toBe("Asked you a question");
  expect(waitingLabel({ waitingReason: "other" })).toBe("Waiting for you");
  expect(waitingLabel({})).toBe("Waiting for you");
});

test("the same reasons are said of a session by its name, for the subject of an email", () => {
  expect(waitingPhrase({ waitingReason: "permission" })).toBe("is waiting for permission");
  expect(waitingPhrase({ waitingReason: "question" })).toBe("asked you a question");
  expect(waitingPhrase({ waitingReason: "other" })).toBe("is waiting for you");
  expect(waitingPhrase({})).toBe("is waiting for you");
});

test("a session is called by its name, then its folder, then its id", () => {
  expect(sessionTitle(makeSession({ name: "docs-site" }))).toBe("docs-site");
  expect(sessionTitle(makeSession({ name: " ", project: "docs-site" }))).toBe("docs-site");
  expect(sessionTitle(makeSession({ id: "claude-code:7", name: "", project: null }))).toBe(
    "claude-code:7",
  );
});

test("a notification of a wait is the session's name and the reason, and nothing else", () => {
  const session = makeSession({
    name: "checkout-flow",
    cwd: "/Users/example/code/checkout-flow",
    project: "checkout-flow",
    status: "needs-you",
    waitingReason: "question",
    waitingDetail: "input needed",
  });

  expect(waitNotice(session)).toEqual({ title: "checkout-flow", body: "Asked you a question" });
});

test("a name is passed on as it is, whatever is in it", () => {
  const name = 'api-rate-limits" & (do shell script "id") & "\\\nsecond line';
  expect(waitNotice(makeSession({ name })).title).toBe(name);
});

test("a session with no name is called by its folder, then by its id", () => {
  expect(waitNotice(makeSession({ name: "  ", project: "billing-webhooks" })).title).toBe(
    "billing-webhooks",
  );
  expect(waitNotice(makeSession({ id: "claude-code:4242", name: "", project: null })).title).toBe(
    "claude-code:4242",
  );
});
