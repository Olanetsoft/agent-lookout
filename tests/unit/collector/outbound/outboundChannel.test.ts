import { describe, expect, test } from "vitest";

import {
  createOutboundChannel,
  type OverFacts,
  type SendOutcome,
  type WaitFacts,
} from "@collector/outbound/outboundChannel";
import { HOUR_MS } from "@collector/outbound/outboundTiming";
import { SENDS_PER_HOUR } from "@core/api";
import type { NoticeEvent } from "@core/notices/sessionChanges";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { waitingText } from "@core/text";
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
    asking: false,
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
      asking: false,
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

describe("what a waiting session is asking", () => {
  /** A channel that writes down the facts each message is written from. */
  function recording(asking: boolean, clock: { now: number }, afterMs = 0) {
    const waits: WaitFacts[] = [];
    const overs: OverFacts[] = [];
    const made = createOutboundChannel({
      events: ["needs-you", "finished", "ended"],
      afterMs,
      asking,
      waitMessage: (facts) => {
        waits.push(facts);
        return "wait";
      },
      overMessage: (facts) => {
        overs.push(facts);
        return "over";
      },
      send: () => Promise.resolve<SendOutcome>({ sent: true }),
      failure: "it could not be sent",
      now: () => clock.now,
    });
    return { made, waits, overs };
  }
  const askingFor = (n: number, text: string): Session => ({
    ...waiting(n),
    statusSince: T0 + 2_000,
    waitingText: text,
  });

  test("with the setting off, no message is handed it, and the session is handed over without it", async () => {
    const clock = { now: T0 };
    const { made, waits } = recording(false, clock);
    made.handle(snapshot([working(1)]));
    clock.now = T0 + 2_000;
    made.handle(snapshot([askingFor(1, "Run: npm test")]));
    await made.settled();

    expect(waits).toHaveLength(1);
    expect(waits[0]?.asking).toBeNull();
    expect(waits[0]?.session).not.toHaveProperty("waitingText");
    expect(JSON.stringify(waits)).not.toContain("npm test");
  });

  test("with it on, the wait's message is handed it as the dashboard shows it, and the session still without it", async () => {
    const clock = { now: T0 };
    const { made, waits } = recording(true, clock);
    const raw = `Run: npm test\u0000\u202e\n${"--watch ".repeat(40)}`;
    made.handle(snapshot([working(1), working(2)]));
    clock.now = T0 + 2_000;
    made.handle(snapshot([askingFor(1, raw), { ...waiting(2), statusSince: T0 + 2_000 }]));
    await made.settled();

    expect(waits.map((facts) => facts.asking)).toEqual([waitingText(raw), null]);
    expect(waits[0]?.asking?.startsWith("Run: npm test --watch")).toBe(true);
    expect(Array.from(waits[0]?.asking ?? "")).toHaveLength(200);
    expect(waits[0]?.session).not.toHaveProperty("waitingText");
  });

  test("it is read at the poll the wait is sent at, not when the wait began, so nothing of it is held meanwhile", async () => {
    const clock = { now: T0 };
    const { made, waits } = recording(true, clock, 60_000);
    made.handle(snapshot([working(1)]));
    clock.now = T0 + 2_000;
    made.handle(snapshot([askingFor(1, "Run: npm test")]));
    clock.now = T0 + 30_000;
    // The same wait, now asking about the next tool.
    made.handle(snapshot([askingFor(1, "Edit: src/app.ts")]));
    // A poll that read no text for it.
    clock.now = T0 + 50_000;
    made.handle(snapshot([{ ...waiting(1), statusSince: T0 + 2_000 }]));
    clock.now = T0 + 62_000;
    made.handle(snapshot([askingFor(1, "Run: npm run build")]));
    await made.settled();

    expect(waits.map((facts) => facts.asking)).toEqual(["Run: npm run build"]);
  });

  test("a wait the hourly limit held back says what the session asks when it goes", async () => {
    const clock = { now: T0 };
    const { made, waits } = recording(true, clock);
    const many = Array.from({ length: SENDS_PER_HOUR }, (_, index) => index + 1);
    const held = SENDS_PER_HOUR + 1;
    made.handle(snapshot([...many.map(working), working(held)]));
    clock.now = T0 + 2_000;
    made.handle(
      snapshot([...many.map((n) => askingFor(n, `Run: step ${n}`)), askingFor(held, "Run: first")]),
    );
    await made.settled();
    expect(waits).toHaveLength(SENDS_PER_HOUR);

    // The others still wait, already sent, so only the one held back is due.
    clock.now = T0 + 2_000 + HOUR_MS;
    made.handle(
      snapshot([
        ...many.map((n) => askingFor(n, `Run: step ${n}`)),
        askingFor(held, "Run: second"),
      ]),
    );
    await made.settled();
    expect(waits.at(-1)?.asking).toBe("Run: second");
    expect(JSON.stringify(waits)).not.toContain("Run: first");
  });

  test("a session that finished or ended is never handed it, even with the setting on", async () => {
    const clock = { now: T0 };
    const { made, overs } = recording(true, clock);
    made.handle(snapshot([working(1), askingFor(2, "Run: npm test")]));
    clock.now = T0 + 2_000;
    // No adapter gives a finished session the text. Were one to, it would still not go.
    made.handle(snapshot([{ ...working(1), status: "finished", waitingText: "Run: npm publish" }]));
    await made.settled();

    expect(overs.map((facts) => facts.event)).toEqual(["finished", "ended"]);
    for (const facts of overs) {
      expect(facts).not.toHaveProperty("asking");
      expect(facts.session).not.toHaveProperty("waitingText");
    }
    expect(JSON.stringify(overs)).not.toMatch(/npm (test|publish)/);
  });

  test("neither the last result nor the hourly limit says anything of it", async () => {
    const clock = { now: T0 };
    const { made } = recording(true, clock);
    made.handle(snapshot([working(1)]));
    clock.now = T0 + 2_000;
    made.handle(snapshot([askingFor(1, "Run: npm test")]));
    await made.settled();
    expect(JSON.stringify([made.last(), made.limitedUntil()])).not.toContain("npm test");
  });
});
