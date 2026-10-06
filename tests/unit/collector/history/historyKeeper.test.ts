import { describe, expect, test } from "vitest";

import { encodeRecord, type HistoryRecord } from "@collector/history/historyFormat";
import { createHistoryKeeper, type HistoryKeeperOptions } from "@collector/history/historyKeeper";
import type { HistoryPoint, SessionEvent } from "@core/sessions/session";
import { fakeHistoryFs } from "@tests/support/node/historyFs";

const DIR = "/Users/example/.agent-lookout/history";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-06T09:00:00.000Z");
const LIMITS = { events: 1_000, points: 10_800 };
/** What restoring gives when nothing could be read. */
const NOTHING = {
  events: [],
  points: [],
  restarts: [],
  lastAt: null,
  whole: { waitEvents: [], measured: [] },
};

const file = (name: string) => `${DIR}/${name}`;

function point(at: number, working = 1): HistoryPoint {
  return { at, needsYou: 0, working, idle: 0, total: working };
}

function event(at: number, name = "demo-project"): SessionEvent {
  return {
    id: `status-files:${name}@${at}:status-changed`,
    at,
    sessionId: `status-files:${name}`,
    sessionName: name,
    kind: "status-changed",
    from: "working",
    to: "needs-you",
    severity: "warning",
  };
}

function lines(...records: HistoryRecord[]): string {
  return records.map((record) => encodeRecord(record)).join("");
}

/** A keeper on a folder held in memory, with a clock of the test's own, that writes only when told to. */
function setUp(options: Partial<HistoryKeeperOptions> & { alive?: number[] } = {}) {
  let now = options.now?.() ?? T0;
  const fs = fakeHistoryFs(() => now);
  const warnings: string[] = [];
  const alive = new Set(options.alive ?? []);
  /** A keeper of this folder, as a copy of Agent Lookout in process `pid` would have. */
  const copy = (pid: number, more: Partial<HistoryKeeperOptions> = {}) =>
    createHistoryKeeper({
      dir: DIR,
      folder: "~/.agent-lookout/history",
      fs,
      pid,
      isAlive: (alivePid) => alive.has(alivePid),
      // Never on its own: each test writes with `flush`.
      flushIntervalMs: 1_000_000_000,
      warn: (line) => warnings.push(line),
      ...options,
      ...more,
      now: () => now,
    });
  const keeper = copy(100);
  return {
    fs,
    keeper,
    copy,
    warnings,
    alive,
    setNow: (at: number) => {
      now = at;
    },
  };
}

/** Every record in the folder's files of this format, file by file in order. */
function written(fs: ReturnType<typeof fakeHistoryFs>): string {
  return [...fs.entries.entries()]
    .filter(([name]) => /\/v1-.*\.jsonl$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry.text)
    .join("");
}

describe("writing", () => {
  test("nothing is written as it is added: it waits for the next beat, which writes it after a start", async () => {
    const { fs, keeper } = setUp();
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toBe(lines({ kind: "start", at: T0 }));

    keeper.addPoint(point(T0 + 2_000));
    keeper.addEvents([event(T0 + 2_000)]);
    // Added, and still only in memory.
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toBe(lines({ kind: "start", at: T0 }));

    await keeper.flush();
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toBe(
      lines(
        { kind: "start", at: T0 },
        { kind: "point", point: point(T0 + 2_000) },
        { kind: "event", event: event(T0 + 2_000) },
      ),
    );
    keeper.stop();
  });

  test("the folder is made before anything is read, and the lock is taken before anything is written", async () => {
    const { fs, keeper } = setUp();
    await keeper.restore(LIMITS);
    expect(fs.changes).toEqual([`make ${DIR}`]);
    keeper.start();
    await keeper.flush();
    expect(fs.changes.slice(1, 3)).toEqual(["create writer.lock", "append v1-2026-10-06.jsonl"]);
    keeper.stop();
  });

  test("a day's file that is full goes on in the next file of that day, and a new day starts a file of its own", async () => {
    const { fs, keeper, setNow } = setUp({ maxFileBytes: 200 });
    await keeper.restore(LIMITS);
    keeper.start();
    for (let index = 0; index < 12; index += 1) keeper.addPoint(point(T0 + index * 2_000));
    await keeper.flush();
    const names = [...fs.entries.keys()].filter((name) => name.endsWith(".jsonl")).sort();
    expect(names.map((name) => name.slice(DIR.length + 1))).toEqual([
      "v1-2026-10-06-2.jsonl",
      "v1-2026-10-06-3.jsonl",
      "v1-2026-10-06.jsonl",
    ]);
    for (const name of names) {
      expect(Buffer.byteLength(fs.text(name) as string)).toBeLessThanOrEqual(200);
    }
    // Every point is there once, in order, across the three.
    expect(written(fs).match(/"point"/g)).toHaveLength(12);

    setNow(T0 + DAY);
    keeper.addPoint(point(T0 + DAY));
    await keeper.flush();
    expect(fs.text(file("v1-2026-10-07.jsonl"))).toBe(
      lines({ kind: "point", point: point(T0 + DAY) }),
    );
    keeper.stop();
  });

  test("days more than 8 days past go as soon as this copy writes, and so does the oldest once the files hold 20 MB", async () => {
    const { fs, keeper, setNow } = setUp({ maxBytes: 1_000 });
    fs.folders.add(DIR);
    fs.put(file("v1-2026-09-27.jsonl"), lines({ kind: "start", at: T0 - 9 * DAY }));
    fs.put(file("v1-2026-10-01.jsonl"), "x".repeat(600));
    fs.put(file("v1-2026-10-05.jsonl"), lines({ kind: "point", point: point(T0 - DAY) }));
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    expect(fs.entries.has(file("v1-2026-09-27.jsonl"))).toBe(false);
    expect(fs.entries.has(file("v1-2026-10-01.jsonl"))).toBe(true);

    // About 660 bytes held, and 460 more coming: over 1,000, so the oldest goes.
    keeper.addEvents([event(T0 + 1), event(T0 + 2)]);
    await keeper.flush();
    expect(fs.entries.has(file("v1-2026-10-01.jsonl"))).toBe(false);
    expect(fs.entries.has(file("v1-2026-10-05.jsonl"))).toBe(true);
    expect(keeper.status().bytes).toBeLessThanOrEqual(1_000);

    // A week on, the 5th has gone too, and the 6th is kept.
    setNow(Date.parse("2026-10-14T00:00:01.000Z"));
    keeper.addPoint(point(Date.parse("2026-10-14T00:00:01.000Z")));
    await keeper.flush();
    expect(fs.entries.has(file("v1-2026-10-05.jsonl"))).toBe(false);
    expect(fs.entries.has(file("v1-2026-10-06.jsonl"))).toBe(true);
    keeper.stop();
  });

  test("stopping writes what is left at once, and lets the lock go", async () => {
    const { fs, keeper } = setUp();
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    keeper.addPoint(point(T0 + 2_000));
    keeper.stop();
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toContain(`"point":[${T0 + 2_000},`);
    expect(fs.entries.has(file("writer.lock"))).toBe(false);
    // Nothing added after stopping is held.
    keeper.addPoint(point(T0 + 4_000));
    expect(fs.text(file("v1-2026-10-06.jsonl"))).not.toContain(`${T0 + 4_000}`);
  });

  test("a write that fails is said once, and the next that works says it is fine again", async () => {
    const { fs, keeper, warnings } = setUp();
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    fs.broken = true;
    keeper.addPoint(point(T0 + 2_000));
    await keeper.flush();
    keeper.addPoint(point(T0 + 4_000));
    await keeper.flush();
    expect(warnings).toEqual([
      "Agent Lookout could not write to its history folder, ~/.agent-lookout/history, so new history is kept in memory until it can.",
    ]);
    expect(keeper.status().problem).toBe(warnings[0]);

    fs.broken = false;
    keeper.addPoint(point(T0 + 6_000));
    await keeper.flush();
    expect(keeper.status().problem).toBeNull();
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toContain(`${T0 + 6_000}`);
    keeper.stop();
  });

  test("a day's file that a crash left ending in half a line goes on from a line of its own", async () => {
    const { fs, keeper, copy } = setUp();
    fs.folders.add(DIR);
    fs.put(
      file("v1-2026-10-06.jsonl"),
      `${lines({ kind: "start", at: T0 - 60_000 })}{"point":[${T0 - 58_000},0,1`,
    );
    await keeper.restore(LIMITS);
    keeper.start();
    keeper.addPoint(point(T0 + 2_000));
    await keeper.flush();
    keeper.addPoint(point(T0 + 4_000));
    await keeper.flush();
    keeper.stop();
    // Only the first write of this run starts with a line break.
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toBe(
      `${lines({ kind: "start", at: T0 - 60_000 })}{"point":[${T0 - 58_000},0,1\n${lines(
        { kind: "start", at: T0 },
        { kind: "point", point: point(T0 + 2_000) },
        { kind: "point", point: point(T0 + 4_000) },
      )}`,
    );
    // So the next run reads the start and both points back.
    const next = copy(300);
    const restored = await next.restore(LIMITS);
    expect(restored.points.map((kept) => kept.at)).toEqual([T0 + 2_000, T0 + 4_000]);
    expect(restored.restarts).toEqual([{ at: T0, lastBefore: T0 - 60_000 }]);
  });

  test("the files never hold what a waiting session is asking, whatever an event is handed with", async () => {
    const { fs, keeper } = setUp();
    await keeper.restore(LIMITS);
    keeper.start();
    const carrying = { ...event(T0 + 2_000), waitingText: "Run: npm run deploy" };
    keeper.addEvents([carrying as SessionEvent]);
    await keeper.flush();
    keeper.stop();
    expect(written(fs)).toContain('"sessionName":"demo-project"');
    expect(written(fs)).not.toContain("waitingText");
    expect(written(fs)).not.toContain("npm run deploy");
  });
});

describe("reading back", () => {
  test("the events and points kept come back oldest first, as many as memory takes, once each", async () => {
    const { fs, keeper } = setUp();
    fs.folders.add(DIR);
    fs.put(
      file("v1-2026-10-05.jsonl"),
      lines(
        { kind: "start", at: T0 - DAY },
        { kind: "point", point: point(T0 - DAY + 10) },
        { kind: "event", event: event(T0 - DAY + 10) },
        { kind: "point", point: point(T0 - DAY + 2_010) },
      ),
    );
    fs.put(
      file("v1-2026-10-06.jsonl"),
      lines(
        { kind: "start", at: T0 - 60_000 },
        { kind: "point", point: point(T0 - 60_000 + 10) },
        { kind: "event", event: event(T0 - 60_000 + 10) },
        // The same event written twice is one event.
        { kind: "event", event: event(T0 - 60_000 + 10) },
        { kind: "point", point: point(T0 - 60_000 + 2_010) },
      ),
    );
    const restored = await keeper.restore({ events: 10, points: 3 });
    expect(restored.events.map((kept) => kept.at)).toEqual([T0 - DAY + 10, T0 - 60_000 + 10]);
    expect(restored.points.map((kept) => kept.at)).toEqual([
      T0 - DAY + 2_010,
      T0 - 60_000 + 10,
      T0 - 60_000 + 2_010,
    ]);
    expect(keeper.since()).toEqual({ at: T0 - DAY, by: "started" });
    expect(keeper.status()).toMatchObject({ where: "disk", folder: "~/.agent-lookout/history" });
  });

  test("all of it comes back as well, however much memory takes: every event of a wait, and the stretches measured, broken at each start", async () => {
    const { fs, keeper } = setUp();
    fs.folders.add(DIR);
    const answered: SessionEvent = {
      ...event(T0 - DAY + 6_000),
      id: "status-files:demo-project@answered",
      from: "needs-you",
      to: "working",
      severity: "advisory",
    };
    const idle: SessionEvent = {
      ...answered,
      id: "status-files:demo-project@idle",
      at: T0 - 30_000,
      from: "working",
      to: "idle",
    };
    fs.put(
      file("v1-2026-10-05.jsonl"),
      lines(
        { kind: "start", at: T0 - DAY },
        { kind: "point", point: point(T0 - DAY + 2_000) },
        { kind: "event", event: event(T0 - DAY + 2_000) },
        { kind: "point", point: point(T0 - DAY + 4_000) },
        { kind: "point", point: point(T0 - DAY + 6_000) },
        { kind: "event", event: answered },
      ),
    );
    fs.put(
      file("v1-2026-10-06.jsonl"),
      lines(
        { kind: "start", at: T0 - 60_000 },
        { kind: "point", point: point(T0 - 58_000) },
        // A stop of a second and a half is a break all the same.
        { kind: "start", at: T0 - 56_500 },
        { kind: "point", point: point(T0 - 56_000) },
        { kind: "point", point: point(T0 - 54_000) },
        { kind: "event", event: idle },
      ),
    );
    const restored = await keeper.restore({ events: 1, points: 1 });
    expect(restored.events).toEqual([idle]);
    expect(restored.points).toEqual([point(T0 - 54_000)]);
    // A move from working to idle is no part of a wait.
    expect(restored.whole.waitEvents).toEqual([event(T0 - DAY + 2_000), answered]);
    expect(restored.whole.measured).toEqual([
      { from: T0 - DAY + 2_000, to: T0 - DAY + 6_000 },
      { from: T0 - 58_000, to: T0 - 58_000 },
      { from: T0 - 56_000, to: T0 - 54_000 },
    ]);
  });

  test("each start that followed history kept from before is a restart, from the newest moment before it", async () => {
    const { fs, keeper } = setUp();
    fs.folders.add(DIR);
    fs.put(
      file("v1-2026-10-05.jsonl"),
      lines(
        { kind: "start", at: T0 - DAY },
        { kind: "point", point: point(T0 - DAY + 2_000) },
        { kind: "event", event: event(T0 - DAY + 3_000) },
      ),
    );
    fs.put(
      file("v1-2026-10-06.jsonl"),
      lines(
        { kind: "start", at: T0 - 60_000 },
        { kind: "point", point: point(T0 - 58_000) },
        // A stop of a second and a half: no gap between the points says so.
        { kind: "start", at: T0 - 56_500 },
        { kind: "point", point: point(T0 - 56_000) },
      ),
    );
    const restored = await keeper.restore(LIMITS);
    expect(restored.restarts).toEqual([
      { at: T0 - 60_000, lastBefore: T0 - DAY + 3_000 },
      { at: T0 - 56_500, lastBefore: T0 - 58_000 },
    ]);
    expect(restored.lastAt).toBe(T0 - 56_000);
    // The first start began the history, and is no restart.
    expect(keeper.since()).toEqual({ at: T0 - DAY, by: "started" });
  });

  test("a record dated well ahead of the clock was written while it was wrong, and is not read back", async () => {
    const { fs, keeper } = setUp();
    fs.folders.add(DIR);
    fs.put(
      file("v1-2026-10-06.jsonl"),
      lines(
        { kind: "start", at: T0 - 10_000 },
        { kind: "point", point: point(T0 - 8_000) },
        { kind: "event", event: event(T0 - 8_000) },
        // A minute ahead is allowed for, as a clock set a little fast.
        { kind: "point", point: point(T0 + 50_000) },
        { kind: "point", point: point(T0 + 2 * 60 * 60_000) },
        { kind: "event", event: event(T0 + 2 * 60 * 60_000) },
        { kind: "start", at: T0 + 3 * 60 * 60_000 },
      ),
    );
    const restored = await keeper.restore(LIMITS);
    expect(restored.points.map((kept) => kept.at)).toEqual([T0 - 8_000, T0 + 50_000]);
    expect(restored.events.map((kept) => kept.at)).toEqual([T0 - 8_000]);
    expect(restored.restarts).toEqual([]);
    expect(restored.lastAt).toBe(T0 + 50_000);
  });

  test("history kept from a clearing begins there, and history whose start was let go begins at the oldest kept", async () => {
    const cleared = setUp();
    cleared.fs.folders.add(DIR);
    cleared.fs.put(file("v1-2026-10-06.jsonl"), lines({ kind: "cleared", at: T0 - 5_000 }));
    await cleared.keeper.restore(LIMITS);
    expect(cleared.keeper.since()).toEqual({ at: T0 - 5_000, by: "cleared" });

    const trimmed = setUp();
    trimmed.fs.folders.add(DIR);
    trimmed.fs.put(
      file("v1-2026-10-05-2.jsonl"),
      lines({ kind: "point", point: point(T0 - DAY) }, { kind: "start", at: T0 - DAY + 5 }),
    );
    await trimmed.keeper.restore(LIMITS);
    expect(trimmed.keeper.since()).toEqual({ at: T0 - DAY, by: "trimmed" });

    const empty = setUp();
    await empty.keeper.restore(LIMITS);
    expect(empty.keeper.since()).toBeNull();
  });

  test("a corrupt or cut-short line is passed over, and the rest of the file is read", async () => {
    const { fs, keeper } = setUp();
    fs.folders.add(DIR);
    fs.put(
      file("v1-2026-10-06.jsonl"),
      `${lines({ kind: "start", at: T0 - 9_000 })}{"point":[17\nnot json\n${lines({
        kind: "point",
        point: point(T0 - 5_000),
      })}{"event":{"id":"cut`,
    );
    const restored = await keeper.restore(LIMITS);
    expect(restored.points.map((kept) => kept.at)).toEqual([T0 - 5_000]);
    expect(restored.events).toEqual([]);
    expect(keeper.since()).toEqual({ at: T0 - 9_000, by: "started" });
  });

  test("a file of a later format is not read, not written to and not deleted for its age", async () => {
    const { fs, keeper, setNow } = setUp();
    fs.folders.add(DIR);
    const later = lines({ kind: "point", point: point(T0 - 30 * DAY) });
    fs.put(file("v2-2026-09-01.jsonl"), later);
    fs.put(file("v2-2026-10-06.jsonl"), later);
    const restored = await keeper.restore(LIMITS);
    expect(restored.points).toEqual([]);
    expect(keeper.since()).toBeNull();
    keeper.start();
    setNow(T0 + 2_000);
    keeper.addPoint(point(T0 + 2_000));
    await keeper.flush();
    keeper.stop();
    expect(fs.text(file("v2-2026-09-01.jsonl"))).toBe(later);
    expect(fs.text(file("v2-2026-10-06.jsonl"))).toBe(later);
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toContain(`${T0 + 2_000}`);
    // Nor do they count towards what is held.
    expect(keeper.status().bytes).toBe(
      Buffer.byteLength(fs.text(file("v1-2026-10-06.jsonl")) ?? ""),
    );
  });

  test("a link, or anything else that is not an ordinary file, is never read or written through", async () => {
    const { fs, keeper } = setUp();
    fs.folders.add(DIR);
    fs.put(file("v1-2026-10-06.jsonl"), lines({ kind: "point", point: point(T0 - 1) }), "link");
    fs.put(file("v1-2026-10-05.jsonl"), lines({ kind: "point", point: point(T0 - DAY) }), "pipe");
    const restored = await keeper.restore(LIMITS);
    expect(restored.points).toEqual([]);
    keeper.start();
    await keeper.flush();
    keeper.stop();
    // The day goes on in its next file, past the link.
    expect(fs.entries.get(file("v1-2026-10-06.jsonl"))?.kind).toBe("link");
    expect(fs.text(file("v1-2026-10-06-2.jsonl"))).toBe(lines({ kind: "start", at: T0 }));
  });

  test("a file larger than a file may grow is not read", async () => {
    const { fs, keeper } = setUp({ maxFileBytes: 100 });
    fs.folders.add(DIR);
    fs.put(
      file("v1-2026-10-05.jsonl"),
      lines(
        ...Array.from({ length: 5 }, (_, index) => ({
          kind: "point" as const,
          point: point(T0 - DAY + index),
        })),
      ),
    );
    const restored = await keeper.restore(LIMITS);
    expect(restored.points).toEqual([]);
    expect(keeper.since()).toBeNull();
  });

  test("a folder that cannot be made keeps this run in memory, says so once, and writes nothing", async () => {
    const { fs, keeper, warnings } = setUp();
    fs.broken = true;
    expect(await keeper.restore(LIMITS)).toEqual(NOTHING);
    keeper.start();
    keeper.addPoint(point(T0));
    await keeper.flush();
    keeper.stop();
    expect(warnings).toEqual([
      "Agent Lookout could not make its history folder, ~/.agent-lookout/history, so this run keeps history in memory only.",
    ]);
    expect(keeper.status()).toMatchObject({ canClear: false, problem: warnings[0] });
    expect(fs.entries.size).toBe(0);
  });

  test("a folder that does not answer in time keeps this run in memory", async () => {
    const { fs, keeper, warnings } = setUp({ restoreDeadlineMs: 20 });
    fs.list = () => new Promise(() => {});
    expect(await keeper.restore(LIMITS)).toEqual(NOTHING);
    expect(warnings).toEqual([
      "Agent Lookout could not read its history folder, ~/.agent-lookout/history, in time, so this run keeps history in memory only.",
    ]);
    keeper.start();
    expect(keeper.status().canClear).toBe(false);
    keeper.stop();
  });
});

describe("another copy", () => {
  test("while another running copy holds the lock, this one writes nothing and says why, and takes over once it stops", async () => {
    const { fs, keeper, alive } = setUp({ alive: [200] });
    fs.folders.add(DIR);
    fs.put(file("writer.lock"), '{"pid":200}\n');
    await keeper.restore(LIMITS);
    keeper.start();
    keeper.addPoint(point(T0 + 2_000));
    await keeper.flush();
    expect(fs.entries.has(file("v1-2026-10-06.jsonl"))).toBe(false);
    expect(keeper.status()).toMatchObject({
      canClear: false,
      problem:
        "Another copy of Agent Lookout on this computer is writing the history. This one keeps what it sees in memory, and takes over when that one stops.",
    });

    alive.delete(200);
    keeper.addPoint(point(T0 + 4_000));
    await keeper.flush();
    keeper.addPoint(point(T0 + 6_000));
    await keeper.flush();
    keeper.stop();
    // What it saw while the other copy wrote is that copy's to write, and
    // what it saw from when it took over is its own. It does not claim to have
    // started watching then.
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toBe(
      lines(
        { kind: "point", point: point(T0 + 4_000) },
        { kind: "point", point: point(T0 + 6_000) },
      ),
    );
  });
});

describe("another copy, and taking over from it", () => {
  test("a copy that takes over goes by the files as they are then, not as they were when it started", async () => {
    // Small files, so the first copy's writes fill and make files the second
    // never read.
    const { fs, copy, alive, setNow } = setUp({ maxFileBytes: 1_000, alive: [1, 2] });
    const first = copy(1);
    const second = copy(2);
    await first.restore(LIMITS);
    await second.restore(LIMITS);
    first.start();
    second.start();
    for (let index = 1; index <= 25; index += 1) first.addPoint(point(T0 + index * 2_000));
    await first.flush();
    first.stop();
    alive.delete(1);

    for (let index = 26; index <= 50; index += 1) second.addPoint(point(T0 + index * 2_000));
    await second.flush();
    await second.flush();
    second.stop();

    const names = [...fs.entries.keys()].filter((name) => name.endsWith(".jsonl"));
    for (const name of names) {
      expect(Buffer.byteLength(fs.text(name) as string), name).toBeLessThanOrEqual(1_000);
    }
    // Every point is read back by the next copy, those of each.
    setNow(T0 + 60_000 + 50 * 2_000);
    const third = copy(3);
    const restored = await third.restore(LIMITS);
    expect(restored.points).toHaveLength(50);
    expect(restored.points[0]?.at).toBe(T0 + 2_000);
    expect(restored.points.at(-1)?.at).toBe(T0 + 100_000);
    expect(third.status().bytes).toBe(
      names.reduce((sum, name) => sum + Buffer.byteLength(fs.text(name) as string), 0),
    );
  });

  test("while another copy writes, what this one says the files hold and where they begin follows them", async () => {
    const { fs, copy, setNow } = setUp({ alive: [1, 2], maxBytes: 380 });
    fs.folders.add(DIR);
    fs.put(file("v1-2026-10-05.jsonl"), lines({ kind: "start", at: T0 - DAY }));
    const writer = copy(1);
    const reader = copy(2);
    await writer.restore(LIMITS);
    await reader.restore(LIMITS);
    writer.start();
    reader.start();
    await writer.flush();
    await reader.flush();
    expect(reader.status().canClear).toBe(false);

    setNow(T0 + DAY);
    for (let index = 0; index < 10; index += 1) writer.addPoint(point(T0 + DAY + index));
    await writer.flush();
    // The writer made a file for the new day and let the oldest go for the cap.
    expect(fs.entries.has(file("v1-2026-10-07.jsonl"))).toBe(true);
    expect(fs.entries.has(file("v1-2026-10-05.jsonl"))).toBe(false);
    expect(reader.since()).toEqual({ at: T0 - DAY, by: "started" });
    await reader.flush();
    const total = [...fs.entries.keys()]
      .filter((name) => name.endsWith(".jsonl"))
      .reduce((sum, name) => sum + Buffer.byteLength(fs.text(name) as string), 0);
    expect(reader.status().bytes).toBe(total);
    // The writer's own start, in a file the reader had not read, now begins it.
    expect(reader.since()).toEqual({ at: T0, by: "started" });
    writer.stop();
    reader.stop();
  });

  test("a copy whose lock another took over meanwhile writes nothing more as it stops, and leaves that lock", async () => {
    const { fs, keeper } = setUp({ alive: [200] });
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    const before = fs.text(file("v1-2026-10-06.jsonl"));
    fs.put(file("writer.lock"), '{"pid":200,"token":"bbbb"}\n');
    keeper.addPoint(point(T0 + 2_000));
    keeper.stop();
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toBe(before);
    expect(fs.text(file("writer.lock"))).toBe('{"pid":200,"token":"bbbb"}\n');
  });

  test("a copy that reads sessions from other folders than the writer's says so", async () => {
    const { fs, keeper } = setUp({ alive: [200], sources: "f1f1" });
    fs.folders.add(DIR);
    fs.put(file("writer.lock"), '{"pid":200,"token":"bbbb","sources":"e2e2"}\n');
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    expect(keeper.status()).toMatchObject({
      canClear: false,
      problem:
        "Another copy of Agent Lookout on this computer is writing the history, and it reads sessions from other folders than this one. This one keeps what it sees in memory, and takes over when that one stops.",
    });
    keeper.stop();
  });
});

describe("clearing", () => {
  test("every history file of this format goes, the stores are emptied, and the history begins again with the clearing", async () => {
    const { fs, keeper, setNow } = setUp();
    fs.folders.add(DIR);
    fs.put(file("v1-2026-10-05.jsonl"), lines({ kind: "start", at: T0 - DAY }));
    fs.put(file("v2-2026-10-05.jsonl"), "{}\n");
    fs.put(file("notes.txt"), "kept");
    fs.put(file("v1-2026-10-04.jsonl"), "", "link");
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    keeper.addPoint(point(T0 + 2_000));

    setNow(T0 + 3_000);
    let forgotten = 0;
    expect(await keeper.clear(() => (forgotten += 1))).toEqual({ ok: true, at: T0 + 3_000 });
    expect(forgotten).toBe(1);
    // A file of a later format is left alone, as a link and anything else is.
    expect([...fs.entries.keys()].map((name) => name.slice(DIR.length + 1)).sort()).toEqual([
      "notes.txt",
      "v1-2026-10-04.jsonl",
      "v1-2026-10-06.jsonl",
      "v2-2026-10-05.jsonl",
      "writer.lock",
    ]);
    expect(fs.text(file("v2-2026-10-05.jsonl"))).toBe("{}\n");
    // What was waiting from before is not written either.
    await keeper.flush();
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toBe(lines({ kind: "cleared", at: T0 + 3_000 }));
    expect(keeper.since()).toEqual({ at: T0 + 3_000, by: "cleared" });

    keeper.addPoint(point(T0 + 4_000));
    await keeper.flush();
    keeper.stop();
    expect(fs.text(file("v1-2026-10-06.jsonl"))).toBe(
      lines({ kind: "cleared", at: T0 + 3_000 }, { kind: "point", point: point(T0 + 4_000) }),
    );
  });

  test("a copy that is not writing the files does not clear them", async () => {
    const { fs, keeper } = setUp({ alive: [200] });
    fs.folders.add(DIR);
    fs.put(file("writer.lock"), '{"pid":200}\n');
    fs.put(file("v1-2026-10-05.jsonl"), lines({ kind: "start", at: T0 - DAY }));
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    let forgotten = 0;
    const outcome = await keeper.clear(() => (forgotten += 1));
    expect(outcome).toMatchObject({ ok: false, reason: "not-writing" });
    expect(forgotten).toBe(0);
    expect(fs.entries.has(file("v1-2026-10-05.jsonl"))).toBe(true);
    keeper.stop();
  });

  test("files that cannot be deleted are said, and nothing in memory is emptied", async () => {
    const { fs, keeper } = setUp();
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    const remove = fs.remove;
    fs.remove = async (target) => {
      if (target.endsWith(".jsonl")) throw Object.assign(new Error("Denied."), { code: "EACCES" });
      return remove(target);
    };
    let forgotten = 0;
    expect(await keeper.clear(() => (forgotten += 1))).toEqual({
      ok: false,
      reason: "failed",
      error: "One history file could not be deleted.",
    });
    expect(forgotten).toBe(0);
    keeper.stop();
  });

  test("files left behind by a clearing that failed part way still count, towards the cap and what the card says", async () => {
    const { fs, keeper } = setUp();
    fs.folders.add(DIR);
    fs.put(file("v1-2026-10-04.jsonl"), lines({ kind: "start", at: T0 - 2 * DAY }));
    fs.put(file("v1-2026-10-05.jsonl"), lines({ kind: "point", point: point(T0 - DAY) }));
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    const remove = fs.remove;
    fs.remove = async (target) => {
      if (target.endsWith("v1-2026-10-04.jsonl")) {
        throw Object.assign(new Error("Denied."), { code: "EACCES" });
      }
      return remove(target);
    };
    expect(await keeper.clear(() => {})).toMatchObject({ ok: false, reason: "failed" });
    expect(fs.entries.has(file("v1-2026-10-05.jsonl"))).toBe(false);
    expect(keeper.status().bytes).toBe(
      Buffer.byteLength(fs.text(file("v1-2026-10-04.jsonl")) as string),
    );
    expect(keeper.since()).toEqual({ at: T0 - 2 * DAY, by: "started" });
    keeper.stop();
  });
});
