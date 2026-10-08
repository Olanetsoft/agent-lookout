import { describe, expect, test } from "vitest";

import type { Session } from "@core/sessions/session";
import type { SummaryItem } from "@core/time-rules/quietHold";
import {
  reminderNotice,
  reminderSentence,
  summaryItemPhrase,
  summaryLine,
  summaryNotice,
  waitedInWords,
} from "@core/time-rules/timeRulesWords";
import { makeSession } from "@tests/fixtures/session";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const named = (name: string, overrides: Partial<Session> = {}) =>
  makeSession({ name, status: "needs-you", waitingReason: "permission", ...overrides });

const waited = (name: string, waitedMs: number, times = 1): SummaryItem => ({
  event: "needs-you",
  session: named(name),
  at: 0,
  waitedMs,
  times,
});

const over = (name: string, event: "finished" | "failed" | "ended"): SummaryItem => ({
  event,
  session: named(name, { status: "working" }),
  at: 0,
});

describe("waitedInWords", () => {
  test.each([
    [30_000, "under a minute"],
    [MINUTE, "1 minute"],
    [10 * MINUTE + 4_000, "10 minutes"],
    [25 * MINUTE + 59_000, "25 minutes"],
    [HOUR + 4 * MINUTE, "1 hour 4 minutes"],
    [2 * HOUR, "2 hours"],
    [2 * 24 * HOUR + 3 * HOUR, "2 days 3 hours"],
  ])("%i ms is %s", (ms, words) => {
    expect(waitedInWords(ms)).toBe(words);
  });
});

describe("a reminder", () => {
  test("says how long the session has waited, and for what", () => {
    expect(reminderSentence(named("checkout-flow"), 10 * MINUTE)).toBe(
      "checkout-flow has waited 10 minutes for permission",
    );
    expect(reminderSentence(named("docs-site", { waitingReason: "question" }), 12 * MINUTE)).toBe(
      "docs-site has waited 12 minutes for an answer",
    );
    expect(reminderSentence(named("api", { waitingReason: undefined }), HOUR)).toBe(
      "api has waited 1 hour for you",
    );
  });

  test("a session named with spaces alone is called by its folder", () => {
    expect(reminderSentence(named("  ", { project: "storefront" }), 10 * MINUTE)).toBe(
      "storefront has waited 10 minutes for permission",
    );
  });

  test("its notification has the name as the title, and what the session is asking after the reason", () => {
    expect(reminderNotice(named("checkout-flow"), 10 * MINUTE)).toEqual({
      title: "checkout-flow",
      body: "Has waited 10 minutes for permission",
    });
    expect(
      reminderNotice(named("checkout-flow", { waitingText: "Run: npm test" }), 10 * MINUTE),
    ).toEqual({
      title: "checkout-flow",
      body: "Has waited 10 minutes for permission: Run: npm test",
    });
  });

  test("for a session on another machine, its notification names the machine, as the wait's own does, and its sentence does not", () => {
    const there = named("docs-site", { machine: "devbox" });
    expect(reminderNotice(there, 10 * MINUTE)).toEqual({
      title: "docs-site on devbox",
      body: "Has waited 10 minutes for permission",
    });
    expect(reminderSentence(there, 10 * MINUTE)).toBe(
      "docs-site has waited 10 minutes for permission",
    );
  });
});

describe("a summary", () => {
  test("names each session and what happened", () => {
    expect(summaryItemPhrase(waited("checkout-flow", 25 * MINUTE))).toBe(
      "checkout-flow waited 25 minutes",
    );
    // No comma inside an item, so a line of them still reads as a list.
    expect(summaryItemPhrase(waited("docs-site", HOUR + 5 * MINUTE, 2))).toBe(
      "docs-site waited 1 hour 5 minutes over 2 waits",
    );
    expect(
      summaryItemPhrase({
        event: "needs-you",
        session: named("checkout-flow"),
        at: 0,
        waitedMs: 25 * MINUTE,
        times: 1,
        then: { event: "ended", at: 30 * MINUTE },
      }),
    ).toBe("checkout-flow waited 25 minutes then ended");
    expect(summaryItemPhrase(over("billing-webhooks", "finished"))).toBe(
      "billing-webhooks finished",
    );
    expect(summaryItemPhrase(over("search-indexing", "failed"))).toBe("search-indexing failed");
    expect(summaryItemPhrase(over("docs-site", "ended"))).toBe("docs-site ended");
  });

  test("on one line, the first few by name and the rest counted", () => {
    expect(summaryLine([waited("checkout-flow", 25 * MINUTE)])).toBe(
      "checkout-flow waited 25 minutes",
    );
    expect(
      summaryLine([waited("checkout-flow", 25 * MINUTE), over("billing-webhooks", "finished")]),
    ).toBe("checkout-flow waited 25 minutes and billing-webhooks finished");
    const six = ["a", "b", "c", "d", "e", "f"].map((name) => over(name, "ended"));
    expect(
      summaryLine([
        waited("checkout-flow", 25 * MINUTE),
        waited("docs-site", HOUR + 5 * MINUTE, 2),
        over("billing-webhooks", "finished"),
      ]),
    ).toBe(
      "checkout-flow waited 25 minutes, docs-site waited 1 hour 5 minutes over 2 waits and billing-webhooks finished",
    );
    expect(summaryLine(six)).toBe("a ended, b ended, c ended, d ended and 2 more");
    expect(summaryLine(six, 2)).toBe("a ended, b ended and 4 more");
  });

  test("its notification is headed While quiet", () => {
    expect(summaryNotice([waited("checkout-flow", 25 * MINUTE), over("api", "failed")])).toEqual({
      title: "While quiet",
      body: "checkout-flow waited 25 minutes and api failed",
    });
  });

  test("its notification names the other machine a session runs on, and its line for an email or a post does not", () => {
    const there: SummaryItem = {
      event: "needs-you",
      session: named("docs-site", { machine: "devbox" }),
      at: 0,
      waitedMs: 25 * MINUTE,
      times: 1,
    };
    expect(summaryNotice([there, over("api", "failed")])).toEqual({
      title: "While quiet",
      body: "docs-site on devbox waited 25 minutes and api failed",
    });
    expect(summaryLine([there])).toBe("docs-site waited 25 minutes");
  });
});

test("no reminder or summary notification holds a session's token counts, which only its details show", () => {
  const tokens = { input: 873_215, cached: 641_331, output: 52_717 };
  const session = named("checkout-flow", { tokens });
  const said = JSON.stringify([
    reminderNotice(session, 10 * MINUTE),
    reminderNotice({ ...session, waitingText: "Run: npm test" }, 10 * MINUTE),
    summaryNotice([
      { event: "needs-you", session, at: 0, waitedMs: 25 * MINUTE, times: 1 },
      { event: "finished", session, at: 30 * MINUTE },
    ]),
  ]);
  for (const count of ["873215", "873,215", "641331", "52717", "tokens"]) {
    expect(said).not.toContain(count);
  }
});
