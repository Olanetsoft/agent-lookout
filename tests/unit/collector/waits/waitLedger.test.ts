import { describe, expect, test } from "vitest";

import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import {
  createWaitLedger,
  LEDGER_KEPT_MS,
  ledgerEventStore,
  ledgerHistoryStore,
} from "@collector/waits/waitLedger";
import type { HistoryPoint, SessionEvent, SessionStatus } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Mid-afternoon on the local clock, so the minutes before it are all today. */
const T0 = new Date(2026, 9, 6, 15, 0).getTime();
const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const SINCE = { at: T0 - 60 * MINUTE, by: "started" as const };

function point(at: number): HistoryPoint {
  return { at, needsYou: 0, working: 1, idle: 0, total: 1 };
}

function changed(at: number, from: SessionStatus, to: SessionStatus): SessionEvent {
  return {
    id: `${ID}@${at}:status-changed`,
    at,
    sessionId: ID,
    sessionName: "demo-project",
    kind: "status-changed",
    from,
    to,
    severity: to === "needs-you" ? "warning" : "advisory",
  };
}

/** Polls every two seconds from `from` up to and including `to`. */
function pollEvery2s(add: (point: HistoryPoint) => void, from: number, to: number) {
  for (let at = from; at <= to; at += 2 * SECOND) add(point(at));
}

const nobodyWaiting = { sessions: [] };

describe("createWaitLedger", () => {
  test("the stores hand it what they take, and are read as before", () => {
    const ledger = createWaitLedger();
    const events = ledgerEventStore(createEventStore(), ledger);
    const history = ledgerHistoryStore(createHistoryStore(), ledger);
    ledger.beginRun();
    pollEvery2s((added) => history.add(added), T0 - 10 * MINUTE, T0);
    events.add([
      changed(T0 - 9 * MINUTE, "idle", "working"),
      changed(T0 - 8 * MINUTE, "working", "needs-you"),
      changed(T0 - 5 * MINUTE, "needs-you", "working"),
    ]);
    expect(events.size).toBe(3);
    expect(events.list().map((event) => event.at)).toEqual([
      T0 - 5 * MINUTE,
      T0 - 8 * MINUTE,
      T0 - 9 * MINUTE,
    ]);
    expect(history.list(60 * MINUTE, T0)).toHaveLength(301);

    const answer = ledger.answer({
      now: T0,
      snapshot: nobodyWaiting,
      since: SINCE,
      runStarts: [T0 - 10 * MINUTE],
      where: "memory",
    });
    expect(answer).toMatchObject({ at: T0, since: SINCE, where: "memory" });
    expect(answer.today).toMatchObject({ waitedMs: 3 * MINUTE, waits: 1, measuredMs: 10 * MINUTE });
    expect(answer.today.sessions).toEqual([
      { sessionId: ID, name: "demo-project", waitedMs: 3 * MINUTE, waits: 1, open: false },
    ]);
  });

  test("what the history kept on disk held comes first, and a new run begins a stretch of its own", () => {
    const ledger = createWaitLedger();
    ledger.restore({
      waitEvents: [changed(T0 - 30 * MINUTE, "working", "needs-you")],
      measured: [{ from: T0 - 40 * MINUTE, to: T0 - 20 * MINUTE }],
    });
    // Started again four seconds after the last poll held: still a break.
    ledger.beginRun();
    pollEvery2s((added) => ledger.addPoint(added), T0 - 20 * MINUTE + 4 * SECOND, T0);
    const answer = ledger.answer({
      now: T0,
      snapshot: { sessions: [makeSession({ id: ID, status: "needs-you" })] },
      since: { at: T0 - 40 * MINUTE, by: "started" },
      runStarts: [T0 - 40 * MINUTE, T0 - 20 * MINUTE + 4 * SECOND],
      where: "disk",
    });
    // It waited from 14:30 and still does, less the four seconds nobody measured.
    expect(answer.today).toMatchObject({
      waitedMs: 30 * MINUTE - 4 * SECOND,
      openMs: 30 * MINUTE - 4 * SECOND,
      waits: 1,
      measuredMs: 40 * MINUTE - 4 * SECOND,
    });
    expect(answer.today.sessions[0]).toMatchObject({ open: true, waits: 1 });
  });

  test("a session is named as the latest poll found it, though it waits no longer", () => {
    const ledger = createWaitLedger();
    ledger.beginRun();
    pollEvery2s((added) => ledger.addPoint(added), T0 - 10 * MINUTE, T0);
    ledger.addEvents([
      changed(T0 - 8 * MINUTE, "working", "needs-you"),
      changed(T0 - 5 * MINUTE, "needs-you", "working"),
    ]);
    const answer = ledger.answer({
      now: T0,
      snapshot: { sessions: [makeSession({ id: ID, name: "renamed-since", status: "working" })] },
      since: SINCE,
      runStarts: [T0 - 10 * MINUTE],
      where: "memory",
    });
    expect(answer.today.sessions[0]).toMatchObject({ name: "renamed-since", waitedMs: 3 * MINUTE });
  });

  test("a session in a wait Agent Lookout answered is not waiting now, though it still reads so", () => {
    const ledger = createWaitLedger();
    ledger.beginRun();
    pollEvery2s((added) => ledger.addPoint(added), T0 - 10 * MINUTE, T0);
    const answered = makeSession({
      id: ID,
      status: "needs-you",
      waitingReason: "permission",
      answered: true,
    });
    const answer = ledger.answer({
      now: T0,
      snapshot: { sessions: [answered] },
      since: SINCE,
      runStarts: [T0 - 10 * MINUTE],
      where: "memory",
    });
    // No event says it began to wait, and it is not counted from the run's start.
    expect(answer.today).toMatchObject({ waitedMs: 0, openMs: 0, waits: 0 });
  });

  test("clearing lets everything go", () => {
    const ledger = createWaitLedger();
    ledger.beginRun();
    pollEvery2s((added) => ledger.addPoint(added), T0 - 10 * MINUTE, T0);
    ledger.addEvents([changed(T0 - 8 * MINUTE, "working", "needs-you")]);
    ledger.clear();
    const answer = ledger.answer({
      now: T0,
      snapshot: nobodyWaiting,
      since: { at: T0, by: "cleared" },
      runStarts: [],
      where: "disk",
    });
    expect(answer.today).toMatchObject({ waitedMs: 0, waits: 0, measuredMs: 0 });
  });

  test("it holds nine days, and lets older go as polls come: a wait begun before then is counted from the run that saw it end", () => {
    const ledger = createWaitLedger();
    const old = T0 - LEDGER_KEPT_MS - 60 * MINUTE;
    ledger.restore({
      waitEvents: [
        changed(old, "working", "needs-you"),
        changed(T0 - 10 * MINUTE, "needs-you", "idle"),
      ],
      measured: [{ from: old - MINUTE, to: T0 - 2 * SECOND }],
    });
    ledger.addPoint(point(T0));
    const answer = ledger.answer({
      now: T0,
      snapshot: nobodyWaiting,
      since: { at: old - 60 * MINUTE, by: "started" },
      runStarts: [T0 - 30 * MINUTE],
      where: "disk",
    });
    expect(answer.today).toMatchObject({ waitedMs: 20 * MINUTE, waits: 1 });
  });
});
