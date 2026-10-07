import { describe, expect, test } from "vitest";

import type { ReminderFacts, SummaryFacts, WaitFacts } from "@collector/outbound/outboundChannel";
import {
  isWaitKind,
  MAX_PHONE_MESSAGE,
  MAX_PHONE_TITLE,
  overMessage,
  reminderMessage,
  summaryMessage,
  testMessage,
  waitMessage,
} from "@collector/outbound/phoneMessage";
import type { Session } from "@core/sessions/session";
import { waitingText } from "@core/text";
import { makeSession } from "@tests/fixtures/session";

/** 14:01:05 on this computer's clock, as the push says it. */
const BEGUN = new Date(2026, 9, 5, 14, 1, 5).getTime();
const MINUTE = 60_000;

function facts(overrides: Partial<Session> = {}, more: Partial<WaitFacts> = {}): WaitFacts {
  return {
    session: makeSession({
      name: "checkout-flow",
      cwd: "/Users/example/code/storefront",
      project: "storefront",
      surface: "vscode",
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      ...overrides,
    }),
    agent: "Claude Code",
    asking: null,
    begunAt: BEGUN,
    // Four minutes and twelve seconds later.
    now: BEGUN + 252_000,
    ...more,
  };
}

function reminder(more: Partial<ReminderFacts> = {}): ReminderFacts {
  return {
    ...facts(),
    now: BEGUN + 10 * MINUTE,
    thresholdMs: 10 * MINUTE,
    everyMs: null,
    repeat: 0,
    ...more,
  };
}

describe("waitMessage", () => {
  test("names the session and why in the title, and how long, where and in what under it", () => {
    expect(waitMessage(facts())).toEqual({
      kind: "needs-you",
      title: "checkout-flow is waiting for permission",
      message: "4m 12s · storefront · VS Code · Claude Code",
    });
    expect(waitMessage(facts({ waitingReason: "question" })).title).toBe(
      "checkout-flow asked you a question",
    );
  });

  test("leaves out what is not known, and still has a line under the title", () => {
    expect(waitMessage(facts({ project: "", surface: "unknown" }, { agent: null }))).toEqual({
      kind: "needs-you",
      title: "checkout-flow is waiting for permission",
      message: "4m 12s",
    });
  });

  test("says what the session is asking first only when it is handed it, and never in the title", () => {
    const asked = waitMessage(facts({}, { asking: "Run: npm test" }));
    expect(asked).toEqual({
      kind: "needs-you",
      title: "checkout-flow is waiting for permission",
      message: "Asking: Run: npm test\n4m 12s · storefront · VS Code · Claude Code",
    });
    // The session's own text is never read here: only what the channel hands over.
    const own = waitMessage(facts({ waitingText: "Run: npm test" }));
    expect(JSON.stringify(own)).not.toContain("npm test");
  });

  test("a line break in a name or in what is asked cannot add a line, and the folder's path is never in it", () => {
    const message = waitMessage(
      facts(
        { name: "checkout\nflow‮", project: "store\rfront" },
        { asking: "Run: npm test\nrm -rf ~" },
      ),
    );
    expect(message.title).toBe("checkout flow is waiting for permission");
    expect(message.message.split("\n")).toEqual([
      "Asking: Run: npm test rm -rf ~",
      "4m 12s · store front · VS Code · Claude Code",
    ]);
    expect(JSON.stringify(message)).not.toContain("/Users/example");
  });

  test("a long name is cut by the rule every name is, so the title stays inside its limit", () => {
    const message = waitMessage(facts({ name: "n".repeat(500) }, { asking: "a".repeat(500) }));
    expect(Array.from(message.title).length).toBeLessThanOrEqual(MAX_PHONE_TITLE);
    expect(Array.from(message.message).length).toBeLessThanOrEqual(MAX_PHONE_MESSAGE);
    // What is asked is cut as the dashboard's line is.
    expect(message.message.split("\n")[0]).toBe(`Asking: ${waitingText("a".repeat(500))}`);
  });
});

describe("reminderMessage", () => {
  test("says how long it has waited in the title, and since when under it", () => {
    expect(reminderMessage(reminder())).toEqual({
      kind: "reminder",
      title: "checkout-flow has waited 10 minutes for permission",
      message: "Since 14:01 · storefront · VS Code · Claude Code",
    });
  });

  test("a repeat says how long by then, and is a reminder all the same", () => {
    expect(
      reminderMessage(reminder({ now: BEGUN + 40 * MINUTE, everyMs: 30 * MINUTE, repeat: 1 })),
    ).toEqual({
      kind: "reminder",
      title: "checkout-flow has waited 40 minutes for permission",
      message: "Since 14:01 · storefront · VS Code · Claude Code",
    });
  });

  test("says what the session is asking first only when it is handed it", () => {
    expect(reminderMessage(reminder({ asking: "Run: npm test" })).message).toBe(
      "Asking: Run: npm test\nSince 14:01 · storefront · VS Code · Claude Code",
    );
    expect(reminderMessage(reminder()).message).not.toContain("Asking");
  });
});

describe("summaryMessage", () => {
  const FROM = new Date(2026, 9, 5, 22, 0).getTime();
  const TO = new Date(2026, 9, 6, 8, 0).getTime();
  const session = (name: string) => makeSession({ id: `claude-code:${name}`, name });

  function summary(items: SummaryFacts["items"]): SummaryFacts {
    return { from: FROM, to: TO, items, now: TO };
  }

  test("is headed While quiet, with the line of what quiet hours held under it", () => {
    expect(
      summaryMessage(
        summary([
          {
            event: "needs-you",
            session: session("checkout-flow"),
            at: FROM + 10 * MINUTE,
            waitedMs: 25 * MINUTE,
            times: 1,
            agent: "Claude Code",
          },
          {
            event: "finished",
            session: session("billing-webhooks"),
            at: FROM + 40 * MINUTE,
            agent: "Claude Code",
          },
        ]),
      ),
    ).toEqual({
      kind: "quiet-summary",
      title: "While quiet",
      message: "checkout-flow waited 25 minutes and billing-webhooks finished",
    });
  });

  test("names the first few and counts the rest, within its limit however many and however long their names", () => {
    const items: SummaryFacts["items"] = Array.from({ length: 300 }, (_, n) => ({
      event: "ended",
      session: session(`${"x".repeat(300)}-${n}`),
      at: FROM + n,
      agent: null,
    }));
    const message = summaryMessage(summary(items));
    expect(message.message).toMatch(/ and 296 more$/);
    expect(Array.from(message.message).length).toBeLessThanOrEqual(MAX_PHONE_MESSAGE);
  });
});

describe("overMessage", () => {
  test("names the session and what happened, and when it was seen", () => {
    expect(
      overMessage({
        event: "finished",
        session: makeSession({ name: "billing-webhooks", project: "billing", surface: "terminal" }),
        agent: "Claude Code",
        seenAt: BEGUN,
        now: BEGUN + 1_000,
      }),
    ).toEqual({
      kind: "finished",
      title: "billing-webhooks finished",
      message: "Seen at 14:01 · billing · Terminal · Claude Code",
    });
  });
});

describe("testMessage", () => {
  test("says only that it is a test, and sounds as a wait would", () => {
    expect(testMessage()).toEqual({
      kind: "test",
      title: "Agent Lookout test",
      message: "Pushes from Agent Lookout reach this device.",
    });
    expect(isWaitKind("test")).toBe(true);
    expect(isWaitKind("needs-you")).toBe(true);
    expect(isWaitKind("reminder")).toBe(true);
    for (const kind of ["finished", "failed", "ended", "quiet-summary"] as const) {
      expect(isWaitKind(kind)).toBe(false);
    }
  });
});
