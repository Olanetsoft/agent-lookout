import { describe, expect, test } from "vitest";

import { createOutboundChannel, type SendOutcome } from "@collector/outbound/outboundChannel";
import { HOUR_MS } from "@collector/outbound/outboundTiming";
import { SENDS_PER_HOUR } from "@core/api";
import type { NoticeEvent } from "@core/notices/sessionChanges";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

// The rules themselves are tested through email, in
// tests/unit/collector/email/emailNotifications.test.ts, whose tests were
// written before they were shared. These check what sharing adds.

const T0 = 1_700_000_000_000;

const id = (n: number) => `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const working = (n: number): Session =>
  makeSession({ id: id(n), name: `session-${n}`, status: "working", statusSince: null });
const waiting = (n: number): Session =>
  makeSession({
    id: id(n),
    name: `session-${n}`,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: null,
  });
const snapshot = (sessions: Session[]): SessionsSnapshot => ({
  generatedAt: T0,
  sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 }],
  sessions,
});

/** A channel that writes down what it would send, as the words it would send. */
function channel(events: readonly NoticeEvent[], clock: { now: number }) {
  const sent: string[] = [];
  const made = createOutboundChannel({
    events,
    afterMs: 0,
    waitMessage: (facts) => `wait ${facts.session.name}`,
    overMessage: (facts) => `${facts.event} ${facts.session.name}`,
    send: (words) => {
      sent.push(words);
      return Promise.resolve<SendOutcome>({ sent: true });
    },
    failure: "it could not be sent",
    now: () => clock.now,
  });
  return { made, sent };
}

describe("createOutboundChannel", () => {
  test("two channels over the same snapshots send by the same rules, each with its own hourly count", async () => {
    const clock = { now: T0 };
    const first = channel(["needs-you"], clock);
    const second = channel(["needs-you", "ended"], clock);
    /** Hands both the same snapshot, and waits until what they handed over has been tried. */
    const both = async (sessions: Session[]) => {
      first.made.handle(snapshot(sessions));
      second.made.handle(snapshot(sessions));
      await Promise.all([first.made.settled(), second.made.settled()]);
    };
    const many = (make: (n: number) => Session) =>
      Array.from({ length: SENDS_PER_HOUR + 2 }, (_, index) => make(index + 1));

    await both(many(working));
    clock.now = T0 + 2_000;
    await both(many(waiting));
    expect(first.sent).toHaveLength(SENDS_PER_HOUR);
    expect(second.sent).toEqual(first.sent);

    // One full hour does not hold the other back: each counts only its own.
    clock.now = T0 + 4_000;
    await both([]);
    expect(first.sent).toHaveLength(SENDS_PER_HOUR);
    expect(second.sent).toHaveLength(SENDS_PER_HOUR);
    expect(second.made.limitedUntil()).toBe(T0 + 2_000 + HOUR_MS);

    clock.now = T0 + 2_000 + HOUR_MS;
    await both([]);
    expect(second.sent.slice(SENDS_PER_HOUR, SENDS_PER_HOUR + 2)).toEqual([
      "ended session-1",
      "ended session-2",
    ]);
    expect(first.sent).toHaveLength(SENDS_PER_HOUR);
  });

  test("a message that cannot be written stops nothing, and the next is still sent", async () => {
    const clock = { now: T0 };
    let calls = 0;
    const sent: string[] = [];
    const made = createOutboundChannel({
      events: ["needs-you"],
      afterMs: 0,
      waitMessage: (facts) => {
        calls += 1;
        if (calls === 1) throw new Error("broken");
        return facts.session.name;
      },
      overMessage: () => "",
      send: (words) => {
        sent.push(words);
        return Promise.resolve<SendOutcome>({ sent: true });
      },
      failure: "it could not be sent",
      now: () => clock.now,
    });
    made.handle(snapshot([working(1), working(2)]));
    clock.now = T0 + 2_000;
    expect(() => made.handle(snapshot([waiting(1), working(2)]))).not.toThrow();
    clock.now = T0 + 4_000;
    made.handle(snapshot([waiting(1), waiting(2)]));
    await made.settled();
    expect(sent).toEqual(["session-2"]);
  });
});
