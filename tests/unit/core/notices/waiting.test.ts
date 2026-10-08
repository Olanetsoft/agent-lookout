import { expect, test } from "vitest";

import {
  changeNotice,
  NOTICE_EVENT_LABEL,
  noticeTitle,
  overPhrase,
  sessionTitle,
  waitingLabel,
  waitingPhrase,
  waitNotice,
} from "@core/notices/waiting";
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

test("each event has a name for Settings, and the events but a wait are said of a session by its name", () => {
  expect(NOTICE_EVENT_LABEL).toEqual({
    "needs-you": "Needs you",
    finished: "Finished",
    failed: "Failed",
    ended: "Ended",
  });
  expect(overPhrase("finished")).toBe("finished");
  expect(overPhrase("failed")).toBe("failed");
  expect(overPhrase("ended")).toBe("ended");
});

test("a notification of any event names the session and says what happened", () => {
  const session = makeSession({
    name: "billing-webhooks",
    cwd: "/Users/example/code/billing-webhooks",
    project: "billing-webhooks",
    status: "finished",
  });
  expect(changeNotice({ event: "finished", session })).toEqual({
    title: "billing-webhooks",
    body: "Finished",
  });
  expect(changeNotice({ event: "failed", session })).toEqual({
    title: "billing-webhooks",
    body: "Failed",
  });
  expect(changeNotice({ event: "ended", session })).toEqual({
    title: "billing-webhooks",
    body: "Ended",
  });
  // A wait gives its reason, as it always has.
  const waiting = {
    ...session,
    status: "needs-you" as const,
    waitingReason: "permission" as const,
  };
  expect(changeNotice({ event: "needs-you", session: waiting })).toEqual({
    title: "billing-webhooks",
    body: "Waiting for permission",
  });
  // With no name it is called by its folder, then by its id.
  expect(
    changeNotice({ event: "ended", session: makeSession({ name: " ", project: "docs-site" }) })
      .title,
  ).toBe("docs-site");
});

test("a notification of a wait says what the session is asking after the reason, when that is known", () => {
  const session = makeSession({
    name: "checkout-flow",
    cwd: "/Users/example/code/checkout-flow",
    project: "checkout-flow",
    status: "needs-you",
    waitingReason: "permission",
    waitingDetail: "permission prompt",
    waitingText: "Run: npm test",
  });
  expect(waitNotice(session)).toEqual({
    title: "checkout-flow",
    body: "Waiting for permission: Run: npm test",
  });
  expect(changeNotice({ event: "needs-you", session })).toEqual(waitNotice(session));
  expect(
    waitNotice({ ...session, waitingReason: "question", waitingText: "Which port? (+1 more)" })
      .body,
  ).toBe("Asked you a question: Which port? (+1 more)");
  // Nothing to say, and the reason stands alone.
  expect(waitNotice({ ...session, waitingText: "  " }).body).toBe("Waiting for permission");
  // A session that is over says only what happened.
  expect(changeNotice({ event: "ended", session }).body).toBe("Ended");
});

test("a notification of a session on another machine names the machine after the session", () => {
  const session = makeSession({
    id: "remote:devbox:claude-code:4242",
    source: "remote:devbox",
    machine: "devbox",
    name: "billing-webhooks",
    status: "needs-you",
    waitingReason: "question",
  });
  expect(noticeTitle(session)).toBe("billing-webhooks on devbox");
  expect(waitNotice(session)).toEqual({
    title: "billing-webhooks on devbox",
    body: "Asked you a question",
  });
  expect(changeNotice({ event: "ended", session })).toEqual({
    title: "billing-webhooks on devbox",
    body: "Ended",
  });
  expect(noticeTitle(makeSession({ name: "billing-webhooks" }))).toBe("billing-webhooks");
});

test("no notification holds a session's token counts, which only its details show", () => {
  const tokens = { input: 873_215, cached: 641_331, output: 52_717 };
  const session = makeSession({
    name: "checkout-flow",
    project: "storefront",
    status: "needs-you",
    waitingReason: "permission",
    tokens,
  });
  const said = JSON.stringify([
    waitNotice(session),
    waitNotice({ ...session, waitingText: "Run: npm test" }),
    changeNotice({ event: "needs-you", session }),
    changeNotice({ event: "finished", session }),
    changeNotice({ event: "failed", session }),
    changeNotice({ event: "ended", session }),
  ]);
  for (const count of ["873215", "873,215", "641331", "52717", "tokens"]) {
    expect(said).not.toContain(count);
  }
});
