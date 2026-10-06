import { describe, expect, test } from "vitest";

import {
  byFileOrder,
  dayOf,
  encodeRecord,
  historyFileName,
  MAX_LINE_LENGTH,
  parseHistoryText,
  parseRecord,
  readHistoryFileName,
  restartsAmong,
  type HistoryFileName,
} from "@collector/history/historyFormat";
import type { Session, SessionEvent } from "@core/sessions/session";

const T0 = Date.parse("2026-10-06T09:00:00.000Z");

const EVENT: SessionEvent = {
  id: `claude-code:demo@${T0}:status-changed`,
  at: T0,
  sessionId: "claude-code:demo",
  sessionName: "demo-project",
  kind: "status-changed",
  from: "working",
  to: "needs-you",
  severity: "warning",
};

describe("file names", () => {
  test("a day's first file, and the files after it", () => {
    expect(historyFileName("2026-10-06")).toBe("v1-2026-10-06.jsonl");
    expect(historyFileName("2026-10-06", 2)).toBe("v1-2026-10-06-2.jsonl");
    expect(dayOf(T0)).toBe("2026-10-06");
    // The day is the UTC one.
    expect(dayOf(Date.parse("2026-10-06T23:59:59.999Z"))).toBe("2026-10-06");
    expect(dayOf(Date.parse("2026-10-07T00:00:00.000Z"))).toBe("2026-10-07");
  });

  test("a name is read back with its format, its day and its part", () => {
    expect(readHistoryFileName("v1-2026-10-06.jsonl")).toEqual({
      name: "v1-2026-10-06.jsonl",
      version: 1,
      day: "2026-10-06",
      dayStart: Date.parse("2026-10-06T00:00:00.000Z"),
      part: 1,
    });
    expect(readHistoryFileName("v1-2026-10-06-12.jsonl")?.part).toBe(12);
    // A later format's file is still a history file, of that format.
    expect(readHistoryFileName("v2-2026-10-06.jsonl")?.version).toBe(2);
  });

  test("anything else is not a history file", () => {
    for (const name of [
      "writer.lock",
      "2026-10-06.jsonl",
      "v1-2026-10-06.json",
      "v1-2026-02-31.jsonl",
      "v1-2026-13-01.jsonl",
      "v0-2026-10-06.jsonl",
      "v1-2026-10-06-0.jsonl",
      "v1-2026-10-06.jsonl.tmp",
      ".v1-2026-10-06.jsonl",
    ]) {
      expect([name, readHistoryFileName(name)]).toEqual([name, null]);
    }
  });

  test("files are put in order by day, then by part", () => {
    const names = [
      "v1-2026-10-06-2.jsonl",
      "v1-2026-10-07.jsonl",
      "v1-2026-10-06.jsonl",
      "v1-2026-09-30.jsonl",
      "v1-2026-10-06-10.jsonl",
    ];
    const ordered = names
      .map((name) => readHistoryFileName(name) as HistoryFileName)
      .sort(byFileOrder)
      .map((file) => file.name);
    expect(ordered).toEqual([
      "v1-2026-09-30.jsonl",
      "v1-2026-10-06.jsonl",
      "v1-2026-10-06-2.jsonl",
      "v1-2026-10-06-10.jsonl",
      "v1-2026-10-07.jsonl",
    ]);
  });
});

describe("encoding", () => {
  test("each record is one line of JSON", () => {
    expect(encodeRecord({ kind: "start", at: T0 })).toBe(`{"start":${T0}}\n`);
    expect(encodeRecord({ kind: "cleared", at: T0 })).toBe(`{"cleared":${T0}}\n`);
    expect(
      encodeRecord({
        kind: "point",
        point: { at: T0, needsYou: 1, working: 2, idle: 3, total: 7 },
      }),
    ).toBe(`{"point":[${T0},1,2,3,7]}\n`);
    expect(JSON.parse(encodeRecord({ kind: "event", event: EVENT }))).toEqual({ event: EVENT });
  });

  test("an event is written with its own fields and nothing else, so what a waiting session is asking never reaches a file", () => {
    // What a poll's session carries, handed in where an event should be.
    const carrying = {
      ...EVENT,
      waitingText: "Run: rm -rf ./build",
      cwd: "/Users/example/code/demo",
    } as unknown as SessionEvent & Pick<Session, "waitingText" | "cwd">;
    const line = encodeRecord({ kind: "event", event: carrying });
    expect(line).not.toContain("waitingText");
    expect(line).not.toContain("Run: rm -rf");
    expect(line).not.toContain("/Users/example");
    expect(Object.keys((JSON.parse(line) as { event: object }).event)).toEqual([
      "id",
      "at",
      "sessionId",
      "sessionName",
      "kind",
      "from",
      "to",
      "severity",
    ]);
  });

  test("an event with no statuses is written without them", () => {
    const appeared: SessionEvent = { ...EVENT, kind: "appeared", from: undefined, to: undefined };
    expect(
      Object.keys(
        (JSON.parse(encodeRecord({ kind: "event", event: appeared })) as { event: object }).event,
      ),
    ).toEqual(["id", "at", "sessionId", "sessionName", "kind", "severity"]);
  });

  test("a stopped event keeps who stopped it, and reads back as it was written", () => {
    const stopped: SessionEvent = {
      id: `claude-code:demo@${T0}:stopped`,
      at: T0,
      sessionId: "claude-code:demo",
      sessionName: "demo-project",
      kind: "stopped",
      from: "working",
      severity: "advisory",
      by: "agent-lookout",
    };
    const line = encodeRecord({ kind: "event", event: stopped });
    expect(Object.keys((JSON.parse(line) as { event: object }).event)).toEqual([
      "id",
      "at",
      "sessionId",
      "sessionName",
      "kind",
      "from",
      "severity",
      "by",
    ]);
    expect(parseRecord(line.trim())).toEqual({ kind: "event", event: stopped });
    // Someone this version does not know of spoils the event.
    const odd = JSON.stringify({ event: { ...stopped, by: "somebody" } });
    expect(parseRecord(odd)).toBeNull();
  });

  test("an answered event keeps the decision alone, and reads back as it was written", () => {
    const answered: SessionEvent = {
      id: `claude-code:demo@${T0}:answered`,
      at: T0,
      sessionId: "claude-code:demo",
      sessionName: "demo-project",
      kind: "answered",
      from: "needs-you",
      severity: "advisory",
      by: "agent-lookout",
      decision: "deny",
    };
    const line = encodeRecord({ kind: "event", event: answered });
    expect(Object.keys((JSON.parse(line) as { event: object }).event)).toEqual([
      "id",
      "at",
      "sessionId",
      "sessionName",
      "kind",
      "from",
      "severity",
      "by",
      "decision",
    ]);
    expect(parseRecord(line.trim())).toEqual({ kind: "event", event: answered });
    // Nothing else a held request carries reaches the file, and an answer this version does not know spoils it.
    const withMore = { ...answered, ask: { command: "npm test" } } as SessionEvent;
    expect(encodeRecord({ kind: "event", event: withMore })).not.toContain("npm test");
    expect(parseRecord(JSON.stringify({ event: { ...answered, decision: "maybe" } }))).toBeNull();
  });

  test("every record reads back as it was written", () => {
    const appeared: SessionEvent = {
      id: "x",
      at: T0,
      sessionId: "claude-code:demo",
      sessionName: "demo-project",
      kind: "appeared",
      severity: "advisory",
    };
    const records = [
      { kind: "start", at: T0 },
      { kind: "point", point: { at: T0 + 2_000, needsYou: 0, working: 1, idle: 0, total: 1 } },
      { kind: "event", event: EVENT },
      { kind: "event", event: appeared },
      { kind: "cleared", at: T0 + 9_000 },
    ] as const;
    const text = records.map((record) => encodeRecord(record)).join("");
    const parsed = parseHistoryText(text);
    expect(parsed.skipped).toBe(0);
    expect(parsed.records).toEqual(records);
  });
});

describe("parsing", () => {
  test("a corrupt or cut-short line is passed over, and the lines around it are read", () => {
    const good = encodeRecord({ kind: "start", at: T0 });
    const point = encodeRecord({
      kind: "point",
      point: { at: T0 + 2_000, needsYou: 0, working: 1, idle: 0, total: 1 },
    });
    const text = [
      good,
      '{"point":[1791204000000,0,1\n',
      "not json at all\n",
      "\n",
      '{"point":"nope"}\n',
      point,
      // The last write never finished.
      point.slice(0, 12),
    ].join("");
    const parsed = parseHistoryText(text);
    expect(parsed.records.map((record) => record.kind)).toEqual(["start", "point"]);
    expect(parsed.skipped).toBe(4);
  });

  test("a last line with no line break is read when it is whole", () => {
    const parsed = parseHistoryText(`{"start":${T0}}`);
    expect(parsed.records).toEqual([{ kind: "start", at: T0 }]);
  });

  test("a record this version does not know is passed over", () => {
    expect(parseRecord(`{"pause":${T0}}`)).toBeNull();
    expect(parseRecord("[1,2,3]")).toBeNull();
    expect(parseRecord("null")).toBeNull();
    expect(parseRecord('"start"')).toBeNull();
  });

  test("a point needs a time and four counts, each a whole number", () => {
    expect(parseRecord(`{"point":[${T0},1,2,3,6]}`)).toEqual({
      kind: "point",
      point: { at: T0, needsYou: 1, working: 2, idle: 3, total: 6 },
    });
    for (const bad of [
      `{"point":[${T0},1,2,3]}`,
      `{"point":[${T0},1,2,3,6,7]}`,
      `{"point":[${T0},-1,2,3,6]}`,
      `{"point":[${T0},1.5,2,3,6]}`,
      `{"point":[0,1,2,3,6]}`,
      `{"point":["${T0}",1,2,3,6]}`,
      `{"point":[${T0},1,2,3,null]}`,
    ]) {
      expect([bad, parseRecord(bad)]).toEqual([bad, null]);
    }
  });

  test("an event needs its fields, of the kinds an event has", () => {
    const line = (event: Record<string, unknown>) => JSON.stringify({ event });
    expect(parseRecord(line({ ...EVENT }))).toEqual({ kind: "event", event: EVENT });
    for (const bad of [
      { ...EVENT, id: "" },
      { ...EVENT, at: "yesterday" },
      { ...EVENT, sessionName: 7 },
      { ...EVENT, kind: "renamed" },
      { ...EVENT, severity: "loud" },
      { ...EVENT, to: "asleep" },
      { ...EVENT, sessionId: "x".repeat(2_000) },
    ]) {
      expect(parseRecord(line(bad))).toBeNull();
    }
    // Fields an event does not have are not read.
    const extra = parseRecord(line({ ...EVENT, waitingText: "Run: npm test" }));
    expect(extra).toEqual({ kind: "event", event: EVENT });
  });

  test("a line longer than any record is not read", () => {
    const long = JSON.stringify({ event: { ...EVENT, sessionName: "x".repeat(MAX_LINE_LENGTH) } });
    expect(parseRecord(long)).toBeNull();
  });
});

describe("restarts", () => {
  test("each start with history before it is a restart, from the newest moment before it, whatever order the records were written in", () => {
    const starts = [T0 + 60_000, T0, T0 + 10_000];
    const times = [T0 + 70_000, T0 + 2_000, T0 + 60_000, T0 + 4_000, T0, T0 + 10_000, T0 + 9_000];
    expect(restartsAmong(starts, times)).toEqual([
      { at: T0 + 10_000, lastBefore: T0 + 9_000 },
      { at: T0 + 60_000, lastBefore: T0 + 10_000 },
    ]);
  });

  test("a start with nothing before it began the history, and a start written twice is one", () => {
    expect(restartsAmong([T0], [T0, T0 + 2_000])).toEqual([]);
    expect(restartsAmong([T0 + 5_000, T0 + 5_000], [T0, T0 + 5_000])).toEqual([
      { at: T0 + 5_000, lastBefore: T0 },
    ]);
    expect(restartsAmong([], [T0])).toEqual([]);
  });
});
