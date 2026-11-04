import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { afterAll, describe, expect, onTestFinished, test, vi } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { createCollector } from "@collector/collector";
import {
  dayOf,
  encodeRecord,
  historyFileName,
  recordAt,
  type HistoryRecord,
} from "@collector/history/historyFormat";
import type { WaitsResponse } from "@core/api";
import type { Session, SessionEvent, SessionStatus } from "@core/sessions/session";
import { readWaits } from "@dashboard/lib/api/readApi";
import { makeSession } from "@tests/fixtures/session";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { listen, request } from "@tests/support/node/http";
import { NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The days are this computer's own. The tests are in a zone whose clocks do
// not change in the week they use, whatever the zone of the computer that runs them.
vi.stubEnv("TZ", "UTC");
afterAll(() => {
  vi.unstubAllEnvs();
});

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A moment on the local clock in a week of October. */
const at = (day: number, hours: number, minutes = 0, seconds = 0) =>
  new Date(2026, 9, day, hours, minutes, seconds).getTime();

/** Tuesday at three in the afternoon, when Agent Lookout starts again. */
const NOW = at(6, 15);

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function changed(n: number, moment: number, from: SessionStatus, to: SessionStatus): HistoryRecord {
  const event: SessionEvent = {
    id: `${id(n)}@${moment}:status-changed`,
    at: moment,
    sessionId: id(n),
    sessionName: `demo-project-${n}`,
    kind: "status-changed",
    from,
    to,
    severity: to === "needs-you" ? "warning" : "advisory",
  };
  return { kind: "event", event };
}

/** One point every two seconds, as a poll adds them, from `from` up to and including `to`. */
function polls(from: number, to: number): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (let moment = from; moment <= to; moment += 2 * SECOND) {
    records.push({
      kind: "point",
      point: { at: moment, needsYou: 0, working: 1, idle: 0, total: 1 },
    });
  }
  return records;
}

/**
 * Writes records into a history folder as Agent Lookout writes them: one file
 * for each UTC day, in the format `historyFormat.ts` reads.
 */
async function writeHistory(dir: string, records: HistoryRecord[]): Promise<void> {
  const byDay = new Map<string, string>();
  for (const record of [...records].sort((a, b) => recordAt(a) - recordAt(b))) {
    const name = historyFileName(dayOf(recordAt(record)));
    byDay.set(name, (byDay.get(name) ?? "") + encodeRecord(record));
  }
  for (const [name, text] of byDay) await writeFile(path.join(dir, name), text, { mode: 0o600 });
}

/**
 * Three days of history:
 *
 *   Sunday     09:00 to 11:00 watched; demo-project-1 waits 10:00 to 10:20
 *   Monday     22:00 to Tuesday 01:00 watched; demo-project-2 waits 23:50 to 00:10
 *   Tuesday    13:00 to 14:00 watched, then asleep until 14:30, then watched to
 *              14:59:58; demo-project-1 waits 13:50 to 14:40, across the sleep;
 *              demo-project-3 begins to wait at 14:55 and still waits
 *
 * More points than memory takes: the stores hold six hours of them.
 */
function threeDays(): HistoryRecord[] {
  return [
    { kind: "start", at: at(4, 9) },
    ...polls(at(4, 9), at(4, 11)),
    changed(1, at(4, 10), "working", "needs-you"),
    changed(1, at(4, 10, 20), "needs-you", "working"),
    { kind: "start", at: at(5, 22) },
    ...polls(at(5, 22), at(6, 1)),
    changed(2, at(5, 23, 50), "working", "needs-you"),
    changed(2, at(6, 0, 10), "needs-you", "idle"),
    { kind: "start", at: at(6, 13) },
    ...polls(at(6, 13), at(6, 14)),
    ...polls(at(6, 14, 30), at(6, 14, 59, 58)),
    changed(1, at(6, 13, 50), "working", "needs-you"),
    changed(1, at(6, 14, 40), "needs-you", "working"),
    changed(3, at(6, 14, 55), "working", "needs-you"),
  ];
}

/**
 * A collector over a stand-in Claude Code, started as a host starts it, with
 * its history in `dir`, and polled once. The clock stands at `NOW` unless the
 * test moves it. `read` names the way the sessions are read, which a test can
 * change, and `sessions` is read at each poll.
 */
async function startIn(
  dir: string,
  sessions: Session[],
  env: Record<string, string> = {},
  clock = { now: NOW },
  read: { way?: string } = {},
) {
  const adapter: Adapter = {
    id: "claude-code",
    label: "Claude Code",
    lookingIn: "Looking for sessions in a test.",
    poll: async () => ({
      health: { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: clock.now },
      sessions,
      ...(read.way !== undefined && { basis: read.way }),
    }),
  };
  const collector = createCollector({
    version: "9.9.9-test",
    adapters: [adapter],
    env: { AGENT_LOOKOUT_HISTORY_DIR: dir, AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE, ...env },
    notifier: fakeSystemNotifier(),
    now: () => clock.now,
    intervalMs: 1_000_000_000,
  });
  const port = await listen(createServer(collector.handler));
  collector.start();
  onTestFinished(() => collector.stop());
  await collector.whenStarted();
  await collector.poller.pollOnce();
  /** Polls every two seconds for `ms`, as the poller does, moving the clock on. */
  const pollFor = async (ms: number) => {
    for (const end = clock.now + ms; clock.now < end;) {
      clock.now += 2 * SECOND;
      await collector.poller.pollOnce();
    }
  };
  return { port, pollFor, stop: () => collector.stop() };
}

/** What the Events log holds of a session, oldest first. */
async function eventsOf(port: number, sessionId: string) {
  const response = await request(port, "/api/events");
  const { events } = response.json() as { events: SessionEvent[] };
  return events
    .filter((event) => event.sessionId === sessionId)
    .sort((a, b) => a.at - b.at)
    .map((event) => [event.kind, event.from, event.to]);
}

async function waitsFrom(port: number): Promise<WaitsResponse> {
  const response = await request(port, "/api/waits");
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const waits = readWaits(response.json());
  expect(waits).not.toBeNull();
  return waits as WaitsResponse;
}

const stillWaiting = () =>
  makeSession({
    id: id(3),
    name: "demo-project-3",
    status: "needs-you",
    waitingReason: "question",
  });

describe("a wait whose session a way of reading leaves out, over a history folder on disk", () => {
  const waiting = makeSession({ id: id(5), name: "demo-project-5", status: "needs-you" });
  const busy: Session = { ...waiting, status: "working" };

  /** Ten minutes' wait, then read another way that leaves the session out for twenty. */
  async function lostForTwentyMinutes() {
    const dir = await tempDir();
    const clock = { now: at(6, 12) };
    const read = { way: "main" };
    const sessions = [busy];
    const first = await startIn(dir, sessions, {}, clock, read);
    await first.pollFor(MINUTE);
    sessions[0] = waiting;
    await first.pollFor(10 * MINUTE);
    read.way = "fallback";
    sessions.length = 0;
    await first.pollFor(20 * MINUTE);
    return { dir, clock, read, sessions, first };
  }

  test("it stops counting at the last poll that listed it, and the Events log says nothing", async () => {
    const { first } = await lostForTwentyMinutes();
    const waits = await waitsFrom(first.port);
    expect(waits.today).toMatchObject({ waitedMs: 10 * MINUTE - 2 * SECOND, openMs: 0, waits: 1 });
    expect(await eventsOf(first.port, id(5))).toEqual([["status-changed", "working", "needs-you"]]);
  });

  test("across a restart it stays stopped and silent, and when it is seen waiting it is one wait, open, with what was measured", async () => {
    const { dir, clock, read, sessions, first } = await lostForTwentyMinutes();
    first.stop();

    clock.now += 5 * MINUTE;
    const second = await startIn(dir, sessions, {}, clock, read);
    await second.pollFor(10 * MINUTE);
    const stayed = await waitsFrom(second.port);
    expect(stayed.today).toMatchObject({ waitedMs: 10 * MINUTE - 2 * SECOND, openMs: 0, waits: 1 });
    expect(await eventsOf(second.port, id(5))).toEqual([
      ["status-changed", "working", "needs-you"],
    ]);

    read.way = "main";
    sessions[0] = waiting;
    await second.pollFor(MINUTE);
    const back = await waitsFrom(second.port);
    // Thirty of the first run and eleven of this one, less the polls the wait began after.
    expect(back.today).toMatchObject({ waits: 1, sessionCount: 1 });
    expect(back.today.waitedMs).toBe(back.today.openMs);
    expect(back.today.waitedMs).toBe(41 * MINUTE - 2 * SECOND);
    expect(await eventsOf(second.port, id(5))).toEqual([
      ["status-changed", "working", "needs-you"],
    ]);
  });

  test("across a restart, gone when the main way is back, it ended there, and the count stays where it stopped", async () => {
    const { dir, clock, read, sessions, first } = await lostForTwentyMinutes();
    first.stop();

    clock.now += 5 * MINUTE;
    const second = await startIn(dir, sessions, {}, clock, read);
    await second.pollFor(MINUTE);
    read.way = "main";
    await second.pollFor(MINUTE);
    expect(await eventsOf(second.port, id(5))).toEqual([
      ["status-changed", "working", "needs-you"],
      ["ended", "needs-you", undefined],
    ]);
    const waits = await waitsFrom(second.port);
    expect(waits.today).toMatchObject({ waitedMs: 10 * MINUTE - 2 * SECOND, openMs: 0, waits: 1 });
  });
});

describe("GET /api/waits over a history folder on disk", () => {
  test("totals today and the last seven days from all the history kept, day by day, counting only what was measured", async () => {
    const dir = await tempDir();
    await writeHistory(dir, threeDays());
    const { port } = await startIn(dir, [stillWaiting()]);

    const waits = await waitsFrom(port);
    expect(waits).toMatchObject({ at: NOW, where: "disk", since: { at: at(4, 9), by: "started" } });

    const open = 4 * MINUTE + 58 * SECOND;
    expect(waits.today).toMatchObject({
      from: at(6, 0),
      to: NOW,
      // demo-project-2 after midnight, demo-project-1 either side of the sleep, and demo-project-3 so far.
      waitedMs: 10 * MINUTE + 20 * MINUTE + open,
      openMs: open,
      waits: 3,
      measuredMs: HOUR + HOUR + 29 * MINUTE + 58 * SECOND,
      sessionCount: 3,
    });

    const { sevenDays } = waits;
    expect(sevenDays.from).toBe(new Date(2026, 8, 30).getTime());
    expect(sevenDays).toMatchObject({
      waitedMs: 20 * MINUTE + 20 * MINUTE + 20 * MINUTE + open,
      // The wait across midnight is one.
      waits: 4,
      sessionCount: 3,
    });
    expect(sevenDays.days.map((day) => [day.day, day.waitedMs, day.waits, day.measuredMs])).toEqual(
      [
        ["2026-09-30", 0, 0, 0],
        ["2026-10-01", 0, 0, 0],
        ["2026-10-02", 0, 0, 0],
        ["2026-10-03", 0, 0, 0],
        ["2026-10-04", 20 * MINUTE, 1, 2 * HOUR],
        ["2026-10-05", 10 * MINUTE, 1, 2 * HOUR],
        ["2026-10-06", 30 * MINUTE + open, 3, waits.today.measuredMs],
      ],
    );
    expect(sevenDays.sessions).toEqual([
      { sessionId: id(1), name: "demo-project-1", waitedMs: 40 * MINUTE, waits: 2, open: false },
      { sessionId: id(2), name: "demo-project-2", waitedMs: 20 * MINUTE, waits: 1, open: false },
      { sessionId: id(3), name: "demo-project-3", waitedMs: open, waits: 1, open: true },
    ]);
  });

  test("it only reads: asking changes nothing in the folder, and the answer holds no folder and nothing a session asks", async () => {
    const dir = await tempDir();
    await writeHistory(dir, threeDays());
    const { port } = await startIn(dir, [{ ...stillWaiting(), waitingText: "Run: npm test" }]);
    const first = (await request(port, "/api/waits")).body;
    const second = (await request(port, "/api/waits")).body;
    expect(second).toBe(first);
    expect(first).not.toContain("npm test");
    expect(first).not.toContain("/Users/example");
    expect(first).not.toContain(dir);
  });

  test("with AGENT_LOOKOUT_HISTORY=off the folder is not read, and only the time since Agent Lookout started counts", async () => {
    const dir = await tempDir();
    await writeHistory(dir, threeDays());
    const { port, pollFor } = await startIn(dir, [stillWaiting()], {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
    });
    // demo-project-3 was waiting as Agent Lookout started, and still waits ten minutes on.
    await pollFor(10 * MINUTE);

    const waits = await waitsFrom(port);
    expect(waits).toMatchObject({
      at: NOW + 10 * MINUTE,
      where: "memory",
      since: { at: NOW, by: "started" },
    });
    expect(waits.today).toMatchObject({
      waitedMs: 10 * MINUTE,
      openMs: 10 * MINUTE,
      waits: 1,
      measuredMs: 10 * MINUTE,
      sessionCount: 1,
    });
    // Nothing from the folder: the seven days hold only this run.
    expect(waits.sevenDays).toMatchObject({
      waitedMs: 10 * MINUTE,
      waits: 1,
      measuredMs: 10 * MINUTE,
      sessionCount: 1,
    });
    expect(waits.sevenDays.sessions).toEqual([
      { sessionId: id(3), name: "demo-project-3", waitedMs: 10 * MINUTE, waits: 1, open: true },
    ]);
  });

  test("a wait under way when Agent Lookout stopped, older than the newest thousand events, ends when a poll finds it answered or gone", async () => {
    const dir = await tempDir();
    // Watched from 9:00 to noon. demo-project-1 waits from 9:10 and
    // demo-project-3 from 9:15, and demo-project-2 changes 1,200 times after.
    const churn: HistoryRecord[] = Array.from({ length: 1_200 }, (_, n) =>
      changed(
        2,
        at(6, 9, 20) + n * 5 * SECOND,
        n % 2 ? "idle" : "working",
        n % 2 ? "working" : "idle",
      ),
    );
    await writeHistory(dir, [
      { kind: "start", at: at(6, 9) },
      ...polls(at(6, 9), at(6, 12)),
      changed(1, at(6, 9, 10), "working", "needs-you"),
      changed(3, at(6, 9, 15), "working", "needs-you"),
      ...churn,
    ]);
    // Started again at 14:00: demo-project-1 was answered meanwhile and is
    // idle, and demo-project-3 has gone.
    const clock = { now: at(6, 14) };
    const idle = makeSession({ id: id(1), name: "demo-project-1", status: "idle" });
    const { port, pollFor } = await startIn(dir, [idle], {}, clock);
    await pollFor(HOUR);

    const waits = await waitsFrom(port);
    const own = (n: number) => waits.today.sessions.find((session) => session.sessionId === id(n));
    expect(own(1)).toMatchObject({ waitedMs: 2 * HOUR + 50 * MINUTE, waits: 1, open: false });
    expect(own(3)).toMatchObject({ waitedMs: 2 * HOUR + 45 * MINUTE, waits: 1, open: false });
    expect(waits.today.openMs).toBe(0);

    // The first poll after the start says what changed while it was stopped.
    const events = (await request(port, "/api/events")).json<{ events: SessionEvent[] }>().events;
    const moved = events.filter((event) => event.at === at(6, 14) && event.from === "needs-you");
    expect(moved.map((event) => [event.sessionId, event.kind, event.to]).sort()).toEqual(
      [
        [id(1), "status-changed", "idle"],
        [id(3), "ended", undefined],
      ].sort(),
    );
  });
});
