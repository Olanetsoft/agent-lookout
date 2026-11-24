import { afterEach, describe, expect, test, vi } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { createEventStore } from "@collector/eventStore";
import {
  createHistoryKeeper,
  keptEventStore,
  keptHistoryStore,
} from "@collector/history/historyKeeper";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller } from "@collector/poller";
import {
  createWaitLedger,
  LEDGER_KEPT_MS,
  ledgerEventStore,
  ledgerHistoryStore,
} from "@collector/waits/waitLedger";
import type { HistoryPoint, SessionEvent, SessionStatus, SourceId } from "@core/sessions/session";
import type { WaitSighting } from "@core/waits/waitSightings";
import { isSighting, unendedWaits } from "@core/waits/waitTotals";
import { makeSession } from "@tests/fixtures/session";
import { fakeHistoryFs } from "@tests/support/node/historyFs";
import { modelDays, type SeenPoll } from "@tests/support/waits/waitModel";

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
    ledger.beginRun(T0 - 10 * MINUTE);
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
      marks: [
        { kind: "start", at: T0 - 40 * MINUTE },
        changed(T0 - 30 * MINUTE, "working", "needs-you"),
      ],
      measured: [{ from: T0 - 40 * MINUTE, to: T0 - 20 * MINUTE }],
    });
    // Started again four seconds after the last poll held: still a break.
    ledger.beginRun(T0 - 20 * MINUTE + 4 * SECOND);
    pollEvery2s((added) => ledger.addPoint(added), T0 - 20 * MINUTE + 4 * SECOND, T0);
    const answer = ledger.answer({
      now: T0,
      snapshot: { sessions: [makeSession({ id: ID, status: "needs-you" })] },
      since: { at: T0 - 40 * MINUTE, by: "started" },
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

  test("a wait whose session left every listing stops at the last poll that listed it, from what the history kept or what the poller says", () => {
    const sighting = {
      sessionId: ID,
      sessionName: "demo-project",
      at: T0 - 20 * MINUTE,
      way: "main",
      lastSeen: T0 - 20 * MINUTE - 2 * SECOND,
    };
    const asked = {
      now: T0,
      snapshot: nobodyWaiting,
      since: SINCE,
      where: "disk",
    } as const;

    const restored = createWaitLedger();
    restored.restore({
      marks: [changed(T0 - 30 * MINUTE, "working", "needs-you"), sighting],
      measured: [{ from: T0 - 40 * MINUTE, to: T0 }],
    });
    expect(restored.answer(asked).today.waitedMs).toBe(10 * MINUTE - 2 * SECOND);

    const told = createWaitLedger();
    told.restore({
      marks: [changed(T0 - 30 * MINUTE, "working", "needs-you")],
      measured: [{ from: T0 - 40 * MINUTE, to: T0 }],
    });
    told.addSightings([sighting]);
    expect(told.answer(asked).today.waitedMs).toBe(10 * MINUTE - 2 * SECOND);

    // Clearing lets it go with the rest: read from nothing, the wait runs to now.
    told.clear();
    told.restore({
      marks: [changed(T0 - 30 * MINUTE, "working", "needs-you")],
      measured: [{ from: T0 - 40 * MINUTE, to: T0 }],
    });
    expect(told.answer(asked).today.waitedMs).toBe(30 * MINUTE);
  });

  test("it holds no more marks than it can use: past the most it holds, the oldest go", () => {
    const ledger = createWaitLedger();
    ledger.beginRun(T0 - 40 * MINUTE);
    pollEvery2s((added) => ledger.addPoint(added), T0 - 40 * MINUTE, T0 - 10 * MINUTE);
    const sighting = (sessionId: string, at: number) => ({
      sessionId,
      sessionName: "demo-project",
      at,
      way: "main",
      lastSeen: at - 2 * SECOND,
    });
    const asked = {
      now: T0,
      snapshot: nobodyWaiting,
      since: SINCE,
      where: "disk",
    } as const;
    ledger.addSightings([sighting("claude-code:first", T0 - 20 * MINUTE)]);
    expect(ledger.answer(asked).today.sessions.map((one) => one.sessionId)).toEqual([
      "claude-code:first",
    ]);

    ledger.addSightings(
      Array.from({ length: 100_000 }, () => sighting("claude-code:later", T0 - 15 * MINUTE)),
    );
    ledger.addPoint(point(T0 - 10 * MINUTE + 2 * SECOND));
    expect(ledger.answer(asked).today.sessions.map((one) => one.sessionId)).toEqual([
      "claude-code:later",
    ]);
  });

  test("a session is named as the latest poll found it, though it waits no longer", () => {
    const ledger = createWaitLedger();
    ledger.beginRun(T0 - 10 * MINUTE);
    pollEvery2s((added) => ledger.addPoint(added), T0 - 10 * MINUTE, T0);
    ledger.addEvents([
      changed(T0 - 8 * MINUTE, "working", "needs-you"),
      changed(T0 - 5 * MINUTE, "needs-you", "working"),
    ]);
    const answer = ledger.answer({
      now: T0,
      snapshot: { sessions: [makeSession({ id: ID, name: "renamed-since", status: "working" })] },
      since: SINCE,
      where: "memory",
    });
    expect(answer.today.sessions[0]).toMatchObject({ name: "renamed-since", waitedMs: 3 * MINUTE });
  });

  test("a session in a wait Agent Lookout answered is not waiting now, though it still reads so", () => {
    const ledger = createWaitLedger();
    ledger.beginRun(T0 - 10 * MINUTE);
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
      where: "memory",
    });
    // No event says it began to wait, and it is not counted from the run's start.
    expect(answer.today).toMatchObject({ waitedMs: 0, openMs: 0, waits: 0 });
  });

  test("clearing lets everything go", () => {
    const ledger = createWaitLedger();
    ledger.beginRun(T0 - 10 * MINUTE);
    pollEvery2s((added) => ledger.addPoint(added), T0 - 10 * MINUTE, T0);
    ledger.addEvents([changed(T0 - 8 * MINUTE, "working", "needs-you")]);
    ledger.clear();
    const answer = ledger.answer({
      now: T0,
      snapshot: nobodyWaiting,
      since: { at: T0, by: "cleared" },
      where: "disk",
    });
    expect(answer.today).toMatchObject({ waitedMs: 0, waits: 0, measuredMs: 0 });
  });

  describe("a wait that began before the nine days it holds", () => {
    const DAY = 24 * 60 * MINUTE;
    const old = T0 - LEDGER_KEPT_MS - DAY;
    const start = (at: number) => ({ kind: "start" as const, at });
    const seen = (at: number, way = "main") => ({
      sessionId: ID,
      sessionName: "demo-project",
      at,
      way,
    });
    const begun = [start(old), changed(old + MINUTE, "working", "needs-you"), seen(old + MINUTE)];
    const back = seen(T0 - 5 * DAY, "fallback");

    test.each([
      ["seen another way since, is whole", [back], Infinity],
      ["seen by a run since, is whole", [start(T0 - 5 * DAY), seen(T0 - 5 * DAY)], Infinity],
      ["not seen by a run since, stops there", [start(T0 - 5 * DAY)], T0 - 5 * DAY],
      ["not seen by a run as old, counts for nothing", [start(old + DAY / 2)], old + DAY / 2],
      [
        "not seen by a run as old, and by the next, is one wait",
        [start(old + DAY / 2), start(T0 - 5 * DAY), seen(T0 - 5 * DAY)],
        Infinity,
      ],
    ])("%s", (_, since, stopped) => {
      const ledger = createWaitLedger();
      const answered = changed(T0 - 10 * MINUTE, "needs-you", "idle");
      // Let go by the second poll, once more has been let go by the first.
      const another = { ...seen(T0 - LEDGER_KEPT_MS + SECOND), sessionId: "claude-code:b" };
      ledger.restore({
        marks: [...begun, another, ...since, answered].sort((a, b) => a.at - b.at),
        measured: [{ from: old, to: T0 }],
      });
      for (const at of [T0, T0 + 2 * SECOND]) ledger.addPoint(point(at));
      const { sevenDays } = ledger.answer({
        now: T0,
        snapshot: nobodyWaiting,
        since: { at: old, by: "started" },
        where: "disk",
      });
      const ended = Math.min(answered.at, stopped);
      expect(sevenDays.waitedMs).toBe(Math.max(0, ended - sevenDays.from));
    });

    test("and ended before them is let go, and one found since counts from then", () => {
      const ledger = createWaitLedger();
      ledger.restore({
        marks: [...begun, changed(old + 2 * MINUTE, "needs-you", "idle"), back],
        measured: [{ from: old, to: T0 }],
      });
      ledger.addPoint(point(T0));
      const { sevenDays } = ledger.answer({
        now: T0,
        snapshot: { sessions: [makeSession({ id: ID, status: "needs-you" })] },
        since: { at: old, by: "started" },
        where: "disk",
      });
      expect(sevenDays.waitedMs).toBe(5 * DAY);
    });

    test("goes with the rest as the history is cleared", () => {
      const ledger = createWaitLedger();
      ledger.restore({ marks: [...begun, back], measured: [{ from: old, to: T0 }] });
      ledger.addPoint(point(T0));
      ledger.clear();
      pollEvery2s((added) => ledger.addPoint(added), T0, T0 + MINUTE);
      ledger.addSightings([seen(T0 + MINUTE)]);
      pollEvery2s((added) => ledger.addPoint(added), T0 + MINUTE, T0 + 2 * MINUTE);
      const { sevenDays } = ledger.answer({
        now: T0 + 2 * MINUTE,
        snapshot: { sessions: [makeSession({ id: ID, status: "needs-you" })] },
        since: { at: old, by: "started" },
        where: "disk",
      });
      expect(sevenDays.waitedMs).toBe(MINUTE);
    });
  });
});

describe("over histories made up at random, against a model that goes by what each poll saw", () => {
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const SOURCES: SourceId[] = ["claude-code", "opencode", "remote:devbox"];
  const IDS = SOURCES.flatMap((source) => [`${source}:a`, `${source}:b`]);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Numbers from 0 to 1, the same ones for the same seed. */
  function numbers(seed: number) {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
    };
  }

  /** One history: the sessions, the sources, the clock and Agent Lookout itself, each changed at random. */
  async function play(seed: number, { start, setBack }: { start: number; setBack: boolean }) {
    const random = numbers(seed);
    const one = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)] as T;
    const fs = fakeHistoryFs(() => now);
    const world = new Map<string, SessionStatus>();
    const states = new Map<SourceId, "ok" | "unavailable" | "error">();
    let now = start;
    let runs = 0;
    let polls: SeenPoll[] = [];

    const adapters: Adapter[] = SOURCES.map((id) => ({
      id,
      label: "A source",
      lookingIn: "Looking for sessions in a test.",
      poll: async () => {
        const state = states.get(id) ?? "ok";
        const own = [...world].filter(([session]) => session.startsWith(`${id}:`));
        return {
          health: { id, label: "A source", state, checkedAt: now },
          sessions:
            state === "ok"
              ? own.map(([session, status]) => makeSession({ id: session, source: id, status }))
              : [],
        };
      },
    }));

    /** A run of Agent Lookout over the same folder, some sources left out, built as the collector builds it. */
    async function begin() {
      const keeper = createHistoryKeeper({
        dir: "/Users/example/.agent-lookout/history",
        folder: "~/.agent-lookout/history",
        fs,
        pid: 100,
        flushIntervalMs: 1_000_000_000,
        now: () => now,
      });
      const ledger = createWaitLedger();
      const log = createEventStore();
      // A day's file goes 8 days after its day, and what its polls saw with it.
      polls = polls.filter(({ at }) => Math.floor(at / DAY) * DAY + 9 * DAY >= now);
      const kept = await keeper.restore({ events: 1_000, points: 1_000 });
      log.add(kept.events);
      ledger.restore(kept.whole);
      const read = adapters.filter(() => runs === 0 || random() < 0.9);
      const poller = createPoller({
        adapters: read,
        events: ledgerEventStore(keptEventStore(log, keeper), ledger),
        history: ledgerHistoryStore(keptHistoryStore(createHistoryStore(), keeper), ledger),
        now: () => now,
        onSightings: (sightings: readonly WaitSighting[]) => {
          keeper.addSightings(sightings);
          ledger.addSightings(sightings);
        },
      });
      poller.resume(
        [...unendedWaits(kept.whole.marks), ...kept.events],
        kept.whole.marks.filter(isSighting),
        kept.restarts.map(({ at }) => at),
      );
      ledger.beginRun(now);
      keeper.start();
      runs += 1;
      const told = new Set(log.list().map((event) => event.id));

      return {
        async poll() {
          await poller.pollOnce();
          await keeper.flush();
          const fresh = log.list().filter((event) => !told.has(event.id));
          for (const event of fresh) told.add(event.id);
          const waiting = new Set(
            [...world].filter(([, status]) => status === "needs-you").map(([id]) => id),
          );
          const sources = read.map(({ id }) => {
            const own = new Set([...waiting].filter((session) => session.startsWith(`${id}:`)));
            return [id, { state: states.get(id) ?? "ok", waiting: own }] as const;
          });
          const begun = fresh.filter((event) => event.kind !== "ended" && event.to === "needs-you");
          polls.push({
            at: now,
            run: runs,
            sources: new Map(sources),
            begun: new Set(begun.map((event) => event.sessionId)),
          });
        },
        check() {
          const since = keeper.since();
          if (!since) throw new Error("The history holds nothing.");
          const snapshot = poller.getSnapshot();
          const { sevenDays } = ledger.answer({ now, snapshot, since, where: "disk" });
          const model = modelDays(polls, now, since.at);
          const told = sevenDays.days.map(({ day, waitedMs, waits, measuredMs }) => {
            return { day, waitedMs, waits, measuredMs };
          });
          const known = sevenDays.days.map(({ day }) => {
            const own = model.get(day);
            const { waitedMs = 0, measuredMs = 0 } = own ?? {};
            return { day, waitedMs, waits: own?.waits.size ?? 0, measuredMs };
          });
          expect(told, `seed ${seed}`).toEqual(known);
        },
        stop: () => keeper.stop(),
      };
    }

    let run = await begin();
    await run.poll();
    for (let change = 0; change < 30; change += 1) {
      const kind = random();
      if (kind < 0.6) {
        const id = one(IDS);
        if (random() < 0.25) world.delete(id);
        else world.set(id, one(["working", "needs-you", "needs-you", "idle"]));
      } else if (kind < 0.75) {
        states.set(one(SOURCES), one(["ok", "ok", "unavailable", "error"]));
      } else if (setBack) {
        now -= Math.floor(random() * 3 * MINUTE) + 1;
      } else if (kind < 0.82) {
        // Asleep.
        now += Math.floor(random() * 3 * HOUR);
        await run.poll();
      } else {
        run.stop();
        now += SECOND + Math.floor(random() * one([MINUTE, HOUR, 4 * HOUR, 4 * DAY]));
        for (const id of IDS) if (random() < 0.2) world.set(id, one(["needs-you", "idle"]));
        run = await begin();
        await run.poll();
      }
      for (let polled = Math.floor(random() * 8); polled >= 0; polled -= 1) {
        now += 2 * SECOND;
        await run.poll();
      }
      run.check();
    }
    run.stop();
  }

  test.each([
    // Through midnight, and through the nights the clocks change.
    ["UTC", new Date(Date.UTC(2026, 9, 6, 22)).getTime()],
    ["Europe/London", Date.UTC(2026, 9, 24, 22)],
    ["America/New_York", Date.UTC(2026, 10, 1, 3)],
    ["Australia/Sydney", Date.UTC(2026, 9, 3, 13)],
  ])("restarts, sleep, sources away and in error, and days let go, in %s", async (zone, start) => {
    vi.stubEnv("TZ", zone);
    for (let seed = 1; seed <= 40; seed += 1) await play(seed, { start, setBack: false });
  });

  test("the clock set back again and again", async () => {
    vi.stubEnv("TZ", "UTC");
    for (let seed = 1; seed <= 60; seed += 1) {
      await play(seed, { start: Date.UTC(2026, 9, 6, 23, 58), setBack: true });
    }
  });
});
