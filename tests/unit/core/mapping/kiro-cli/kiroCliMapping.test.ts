import { describe, expect, test } from "vitest";

import {
  foldV2Record,
  foldV3Row,
  isV2TurnStart,
  isV3TurnRow,
  mapKiroV2Status,
  mapKiroV3Status,
  startV2Scan,
  startV3Scan,
  type KiroLiveness,
  type KiroV2Record,
  type KiroV3Row,
} from "@core/mapping/kiro-cli/kiroCliMapping";

const T = 1_790_000_000_000;

const v3 = (rows: KiroV3Row[], whole = false) => rows.reduce(foldV3Row, startV3Scan(whole));
const v2 = (records: KiroV2Record[], whole = false) =>
  records.reduce(foldV2Record, startV2Scan(whole));

const start = (at = T): KiroV3Row => ({ kind: "turn-start", at });
const end = (at = T + 5): KiroV3Row => ({ kind: "turn-end", at });
const pending = (toolCallId: string, approval = true, at = T + 1): KiroV3Row => ({
  kind: "pending",
  toolCallId,
  approval,
  at,
});
const resolved = (toolCallId: string): KiroV3Row => ({ kind: "resolved", toolCallId });

describe("a V3 row log", () => {
  test("works from a turn's start to its end, and is idle after it", () => {
    expect(mapKiroV3Status("open", v3([start()]))).toEqual({ status: "working" });
    expect(mapKiroV3Status("open", v3([start(), { kind: "other" }, end()]))).toEqual({
      status: "idle",
    });
    expect(v3([start(T), end(T + 9)]).turnAt).toBe(T + 9);
  });

  test("needs you while an approval asked in the turn has no answer, and for anything else asked", () => {
    const asked = v3([start(), pending("call-1")]);
    expect(mapKiroV3Status("open", asked)).toEqual({
      status: "needs-you",
      waitingReason: "permission",
    });
    expect(asked.waits).toEqual([{ toolCallId: "call-1", reason: "permission", at: T + 1 }]);
    expect(mapKiroV3Status("open", v3([start(), pending("call-1", false)]))).toEqual({
      status: "needs-you",
      waitingReason: "other",
    });
    expect(mapKiroV3Status("open", v3([start(), pending("call-1"), resolved("call-1")]))).toEqual({
      status: "working",
    });
  });

  test("keeps the oldest wait first, and lets an answer close only its own", () => {
    const scan = v3([start(), pending("call-1"), pending("call-2", false), resolved("call-1")]);
    expect(scan.waits.map((wait) => wait.toolCallId)).toEqual(["call-2"]);
    expect(mapKiroV3Status("open", scan).waitingReason).toBe("other");
    // The same call asked again while it waits keeps the time it was first asked.
    const again = v3([start(), pending("call-1", true, T + 1), pending("call-1", true, T + 3)]);
    expect(again.waits).toEqual([{ toolCallId: "call-1", reason: "permission", at: T + 1 }]);
  });

  test("forgets every wait at the turn's end and at a new turn's start", () => {
    expect(v3([start(), pending("call-1"), end()]).waits).toEqual([]);
    expect(v3([start(), pending("call-1"), start(T + 9)]).waits).toEqual([]);
    // A wait outside a started turn is not one.
    expect(mapKiroV3Status("open", v3([start(), end(), pending("call-1")]))).toEqual({
      status: "idle",
    });
    expect(v3([pending("call-1")], true).waits).toEqual([]);
  });

  test("is idle with no turn row in the whole file, and with no log at all", () => {
    expect(mapKiroV3Status("open", v3([{ kind: "other" }], true))).toEqual({ status: "idle" });
    expect(mapKiroV3Status("unknown", null)).toEqual({ status: "idle" });
  });

  test("is unknown with no turn row in the part read, a turn row not recognised, or a line that cannot be read since the newest turn row", () => {
    expect(mapKiroV3Status("open", v3([{ kind: "other" }]))).toEqual({ status: "unknown" });
    expect(mapKiroV3Status("open", v3([start(), { kind: "turn-other" }]))).toEqual({
      status: "unknown",
    });
    expect(mapKiroV3Status("open", v3([start(), { kind: "unreadable" }]))).toEqual({
      status: "unknown",
    });
    expect(mapKiroV3Status("open", v3([{ kind: "unreadable" }], true))).toEqual({
      status: "unknown",
    });
    // A newer turn row reads past it.
    expect(mapKiroV3Status("open", v3([start(), { kind: "unreadable" }, end()]))).toEqual({
      status: "idle",
    });
  });

  test("reads the same whether a session is open or not known to be closed, and is finished once closed, whatever it says", () => {
    const scans = [
      v3([start()]),
      v3([start(), pending("call-1")]),
      v3([start(), end()]),
      v3([{ kind: "unreadable" }], true),
      v3([]),
      null,
    ];
    for (const scan of scans) {
      expect(mapKiroV3Status("unknown", scan)).toEqual(mapKiroV3Status("open", scan));
      expect(mapKiroV3Status("closed", scan)).toEqual({ status: "finished" });
    }
  });

  test("goes back from the end to its newest turn row and no further", () => {
    expect(isV3TurnRow(start())).toBe(true);
    expect(isV3TurnRow(end())).toBe(true);
    expect(isV3TurnRow({ kind: "turn-other" })).toBe(true);
    for (const row of [pending("call-1"), resolved("call-1"), { kind: "other" }] as const) {
      expect(isV3TurnRow(row)).toBe(false);
    }
  });
});

describe("a V2 transcript", () => {
  const prompt: KiroV2Record = { kind: "prompt", at: T };
  const tool: KiroV2Record = { kind: "reply", toolUse: true };
  const reply: KiroV2Record = { kind: "reply", toolUse: false };
  const results: KiroV2Record = { kind: "tool-results" };
  const clear: KiroV2Record = { kind: "clear" };

  test("works after a prompt, a reply that uses a tool and a tool's results, and is idle after a reply with none", () => {
    for (const records of [[prompt], [prompt, tool], [prompt, tool, results]]) {
      expect(mapKiroV2Status("open", v2(records))).toEqual({ status: "working" });
    }
    expect(mapKiroV2Status("open", v2([prompt, tool, results, reply]))).toEqual({
      status: "idle",
    });
    expect(v2([prompt, tool]).promptAt).toBe(T);
  });

  test("passes over a Clear", () => {
    expect(mapKiroV2Status("open", v2([prompt, reply, clear]))).toEqual({ status: "idle" });
    expect(mapKiroV2Status("open", v2([prompt, tool, clear]))).toEqual({ status: "working" });
    expect(mapKiroV2Status("open", v2([clear], true))).toEqual({ status: "idle" });
  });

  test("is idle when empty or missing, and unknown for a kind not recognised or nothing found in the part read", () => {
    expect(mapKiroV2Status("open", v2([], true))).toEqual({ status: "idle" });
    expect(mapKiroV2Status("open", null)).toEqual({ status: "idle" });
    expect(mapKiroV2Status("open", v2([prompt, { kind: "unknown" }]))).toEqual({
      status: "unknown",
    });
    expect(mapKiroV2Status("open", v2([clear]))).toEqual({ status: "unknown" });
    // A record after it reads past it.
    expect(mapKiroV2Status("open", v2([{ kind: "unknown" }, reply]))).toEqual({ status: "idle" });
  });

  test("never needs you, and is finished once closed", () => {
    const unknown: KiroV2Record = { kind: "unknown" };
    for (const records of [[prompt], [prompt, tool], [prompt, reply], [unknown]]) {
      for (const live of ["open", "unknown"] as KiroLiveness[]) {
        expect(mapKiroV2Status(live, v2(records)).status).not.toBe("needs-you");
      }
      expect(mapKiroV2Status("closed", v2(records))).toEqual({ status: "finished" });
    }
  });

  test("goes back from the end to its newest prompt and no further", () => {
    expect(isV2TurnStart(prompt)).toBe(true);
    for (const record of [tool, reply, results, clear, { kind: "unknown" } as const]) {
      expect(isV2TurnStart(record)).toBe(false);
    }
  });
});
