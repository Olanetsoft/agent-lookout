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
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
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
    reminderMessage: (facts) => `reminder ${facts.session.name}`,
    summaryMessage: (facts) => `summary ${facts.items.length}`,
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
      reminderMessage: () => "",
      summaryMessage: () => "",
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
      reminderMessage: () => "reminder",
      summaryMessage: () => "summary",
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

describe("the time rules", () => {
  /** Monday 5 October 2026 at 21:55, on the local clock. */
  const EVENING = new Date(2026, 9, 5, 21, 55).getTime();
  const MORNING = new Date(2026, 9, 6, 8, 0).getTime();
  const MINUTE = 60_000;

  const QUIET: TimeRules = {
    ...DEFAULT_TIME_RULES,
    quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, from: "22:00", to: "08:00" },
  };
  const REMINDING: TimeRules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 10 } };

  /** A channel that writes down what it sends, with a delay of a minute before a wait goes. */
  function ruled(events: readonly NoticeEvent[], afterMs = MINUTE) {
    const clock = { now: EVENING };
    const sent: string[] = [];
    const made = createOutboundChannel({
      events,
      afterMs,
      asking: true,
      waitMessage: (facts) =>
        `wait ${facts.session.name} ${Math.round((facts.now - facts.begunAt) / MINUTE)}m`,
      overMessage: (facts) => `${facts.event} ${facts.session.name}`,
      reminderMessage: (facts) =>
        `reminder ${facts.session.name} ${Math.round((facts.now - facts.begunAt) / MINUTE)}m of ${facts.thresholdMs / MINUTE}m${facts.asking ? `: ${facts.asking}` : ""}`,
      summaryMessage: (facts) =>
        `summary ${facts.items
          .map((item) =>
            item.event === "needs-you"
              ? `${item.session.name} waited ${item.waitedMs / MINUTE}m`
              : `${item.session.name} ${item.event}`,
          )
          .join(", ")}`,
      send: (words) => {
        sent.push(words);
        return Promise.resolve<SendOutcome>({ sent: true });
      },
      failure: "it could not be sent",
      now: () => clock.now,
    });
    return {
      sent,
      made,
      async poll(at: number, rules: TimeRules, sessions: Session[]) {
        clock.now = at;
        made.handle({ ...snapshot(sessions), generatedAt: at, timeRules: rules });
        await made.settled();
      },
    };
  }

  const waitingSince = (n: number, at: number, overrides: Partial<Session> = {}) => ({
    ...waiting(n),
    statusSince: at,
    ...overrides,
  });
  const finished = (n: number): Session => ({ ...working(n), status: "finished" });

  test("nothing goes in quiet hours; when they end one summary goes first, then each wait still open as usual", async () => {
    const { poll, sent } = ruled(["needs-you", "finished"]);
    await poll(EVENING, QUIET, [working(1), working(2), working(3)]);
    // 22:05: two waits begin and one session finishes.
    const later = EVENING + 10 * MINUTE;
    await poll(later, QUIET, [waitingSince(1, later), waitingSince(2, later), finished(3)]);
    // A minute later both are due, and held.
    await poll(later + MINUTE, QUIET, [
      waitingSince(1, later),
      waitingSince(2, later),
      finished(3),
    ]);
    // session-1 is answered at 22:30.
    await poll(later + 25 * MINUTE, QUIET, [working(1), waitingSince(2, later), finished(3)]);
    expect(sent).toEqual([]);

    await poll(MORNING, QUIET, [working(1), waitingSince(2, later), finished(3)]);
    expect(sent).toEqual([
      "summary session-1 waited 25m, session-3 finished",
      "wait session-2 595m",
    ]);
  });

  test.each([
    ["reads as another status for one poll", [working(1)]],
    ["is missing from its source's answer for one poll", []],
  ])(
    "a wait held through quiet hours whose session %s is still open when they end: sent as usual, and in no summary",
    async (_, between) => {
      const { poll, sent } = ruled(["needs-you"]);
      await poll(EVENING, QUIET, [working(1)]);
      const later = EVENING + 10 * MINUTE;
      await poll(later, QUIET, [waitingSince(1, later)]);
      // Due, and held.
      await poll(later + MINUTE, QUIET, [waitingSince(1, later)]);
      await poll(later + 2 * MINUTE, QUIET, between);
      // Back, with the time its wait began.
      await poll(later + 3 * MINUTE, QUIET, [waitingSince(1, later)]);
      expect(sent).toEqual([]);

      await poll(MORNING, QUIET, [waitingSince(1, later)]);
      expect(sent).toEqual(["wait session-1 595m"]);
      await poll(MORNING + MINUTE, QUIET, [waitingSince(1, later)]);
      expect(sent).toEqual(["wait session-1 595m"]);
    },
  );

  test("a wait answered before its delay, in quiet hours, was never due, and is not in the summary", async () => {
    const { poll, sent } = ruled(["needs-you"], 5 * MINUTE);
    await poll(EVENING, QUIET, [working(1)]);
    const later = EVENING + 10 * MINUTE;
    await poll(later, QUIET, [waitingSince(1, later)]);
    await poll(later + 2 * MINUTE, QUIET, [working(1)]);
    await poll(MORNING, QUIET, [working(1)]);
    expect(sent).toEqual([]);
  });

  test("leaving answered waits out, the summary has the rest", async () => {
    const rules: TimeRules = {
      ...QUIET,
      quietHours: { ...QUIET.quietHours, leaveOutAnswered: true },
    };
    const { poll, sent } = ruled(["needs-you", "ended"]);
    await poll(EVENING, rules, [working(1), working(2)]);
    const later = EVENING + 10 * MINUTE;
    await poll(later, rules, [waitingSince(1, later), working(2)]);
    await poll(later + 2 * MINUTE, rules, [waitingSince(1, later), working(2)]);
    await poll(later + 3 * MINUTE, rules, [working(1)]);
    await poll(MORNING, rules, [working(1)]);
    expect(sent).toEqual(["summary session-2 ended"]);
  });

  test("what the hourly limit held when quiet hours began waits for them to end, after the summary", async () => {
    const { poll, sent } = ruled(["ended"]);
    const many = Array.from({ length: SENDS_PER_HOUR + 1 }, (_, index) => working(index + 1));
    const day = new Date(2026, 9, 5, 21, 40).getTime();
    await poll(day, QUIET, many);
    await poll(day + 2_000, QUIET, []);
    expect(sent).toHaveLength(SENDS_PER_HOUR);
    // An hour on, in quiet hours, the limit lets the last one go, and it is held.
    await poll(day + 61 * MINUTE, QUIET, []);
    expect(sent).toHaveLength(SENDS_PER_HOUR);
    await poll(MORNING, QUIET, []);
    expect(sent.slice(SENDS_PER_HOUR)).toEqual([`ended session-${SENDS_PER_HOUR + 1}`]);
  });

  test("a wait that has been sent is reminded of once it has lasted the rule's minutes, with what it is asking, once", async () => {
    const { poll, sent } = ruled(["needs-you"]);
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    await poll(noon, REMINDING, [working(1)]);
    const asking = { waitingText: "Run: npm test" };
    await poll(noon + 2_000, REMINDING, [waitingSince(1, noon + 2_000, asking)]);
    await poll(noon + 2_000 + MINUTE, REMINDING, [waitingSince(1, noon + 2_000, asking)]);
    await poll(noon + 2_000 + 10 * MINUTE, REMINDING, [waitingSince(1, noon + 2_000, asking)]);
    await poll(noon + 2_000 + 20 * MINUTE, REMINDING, [waitingSince(1, noon + 2_000, asking)]);
    expect(sent).toEqual(["wait session-1 1m", "reminder session-1 10m of 10m: Run: npm test"]);
  });

  test("a wait whose own email went only once it had lasted the minutes is not reminded of as well", async () => {
    const { poll, sent } = ruled(["needs-you"], 15 * MINUTE);
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    await poll(noon, REMINDING, [working(1)]);
    await poll(noon + 2_000, REMINDING, [waitingSince(1, noon + 2_000)]);
    await poll(noon + 2_000 + 10 * MINUTE, REMINDING, [waitingSince(1, noon + 2_000)]);
    await poll(noon + 2_000 + 15 * MINUTE, REMINDING, [waitingSince(1, noon + 2_000)]);
    await poll(noon + 2_000 + 30 * MINUTE, REMINDING, [waitingSince(1, noon + 2_000)]);
    expect(sent).toEqual(["wait session-1 15m"]);
  });

  test("a wait open when the collector started is reminded of, if it was seen before it had lasted the minutes", async () => {
    const { poll, sent } = ruled(["needs-you"]);
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    await poll(noon, REMINDING, [
      waitingSince(1, noon - 3 * MINUTE),
      waitingSince(2, noon - 30 * MINUTE),
    ]);
    await poll(noon + 7 * MINUTE, REMINDING, [
      waitingSince(1, noon - 3 * MINUTE),
      waitingSince(2, noon - 30 * MINUTE),
    ]);
    await poll(noon + 30 * MINUTE, REMINDING, [
      waitingSince(1, noon - 3 * MINUTE),
      waitingSince(2, noon - 30 * MINUTE),
    ]);
    expect(sent).toEqual(["reminder session-1 10m of 10m"]);
  });

  test("with waits not among the events sent, there is no reminder", async () => {
    const { poll, sent } = ruled(["finished"]);
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    await poll(noon, REMINDING, [waitingSince(1, noon)]);
    await poll(noon + 30 * MINUTE, REMINDING, [waitingSince(1, noon)]);
    expect(sent).toEqual([]);
  });
});
