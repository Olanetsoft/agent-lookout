import { describe, expect, test } from "vitest";

import {
  foldQwenCodeRecord,
  mapQwenCodeStatus,
  startQwenCodeFold,
  type QwenCodeFold,
  type QwenCodeRecord,
} from "@core/mapping/qwen-code/qwenCodeMapping";
import type { SessionStatus } from "@core/sessions/session";

const NOW = Date.UTC(2026, 9, 1, 12);
/** When the session's process registered it, a minute before the lines below. */
const LIVE_SINCE = NOW - 60_000;

/** The lines folded in order, from the file's start unless said otherwise. */
function fold(records: QwenCodeRecord[], whole = true): QwenCodeFold {
  return records.reduce(foldQwenCodeRecord, startQwenCodeFold(whole));
}

function statusOf(records: QwenCodeRecord[], whole = true, liveSince = LIVE_SINCE) {
  return mapQwenCodeStatus(fold(records, whole), liveSince);
}

/** A line at this many seconds after NOW. */
const at = (seconds: number) => NOW + seconds * 1000;

const prompt = (s = 0): QwenCodeRecord => ({ type: "user", at: at(s) });
const calls = (s: number): QwenCodeRecord => ({
  type: "assistant",
  at: at(s),
  message: true,
  calls: true,
});
const reply = (s: number): QwenCodeRecord => ({ type: "assistant", at: at(s), message: true });
const result = (s: number, cancelled = false): QwenCodeRecord => ({
  type: "tool_result",
  at: at(s),
  ...(cancelled ? { cancelled: true as const } : {}),
});
const lifecycle = (
  s: number,
  phase: "started" | "ended",
  outcome?: string,
  subagent = false,
): QwenCodeRecord => ({
  type: "system",
  subtype: "ui_telemetry",
  at: at(s),
  lifecycle: { phase, ...(outcome ? { outcome } : {}), subagent },
});
const system = (s: number, subtype: string): QwenCodeRecord => ({
  type: "system",
  subtype,
  at: at(s),
});

describe("foldQwenCodeRecord, a line at a time", () => {
  // Every row of the table in qwenCodeMapping.ts and docs/adapters/qwen-code.md.
  test.each<[string, QwenCodeRecord, SessionStatus]>([
    ["a prompt", prompt(), "working"],
    ["a scheduled prompt", { type: "user", subtype: "cron", at: at(0) }, "working"],
    ["a goal's turn", { type: "user", subtype: "goal_runtime", at: at(0) }, "working"],
    [
      "a notification Qwen Code sent as a turn",
      { type: "user", subtype: "notification", deliveredTurn: true, at: at(0) },
      "working",
    ],
    [
      "something typed while a turn runs",
      { type: "user", subtype: "mid_turn_user_message", at: at(0) },
      "working",
    ],
    ["a reply that calls tools", calls(0), "working"],
    ["a reply with no call", reply(0), "idle"],
    ["results", result(0), "working"],
    ["a stopped result", result(0, true), "idle"],
    ["a request of its own to the model", lifecycle(0, "started"), "working"],
    ["a rewind", system(0, "rewind"), "idle"],
    ["a turn's end", system(0, "turn_result"), "idle"],
    ["a request stopped with Esc", lifecycle(0, "ended", "cancelled"), "idle"],
    ["a line of a type it does not know", { type: "summary", at: at(0) }, "unknown"],
    [
      "a reply too long to read whole",
      { type: "assistant", at: at(0), oversized: true },
      "unknown",
    ],
  ])("%s alone is %s", (_name, record, status) => {
    expect(statusOf([record]).status).toBe(status);
  });

  test.each<[string, QwenCodeRecord]>([
    [
      "a notification saved before any turn ran",
      { type: "user", subtype: "notification", at: at(0) },
    ],
    ["a message from another agent", { type: "user", subtype: "agent_message", at: at(0) }],
    ["a mention of an agent", { type: "user", subtype: "agent_mention", at: at(0) }],
    ["a spoken line", { type: "user", subtype: "realtime_message", at: at(0) }],
    ["an assistant line with no reply", { type: "assistant", at: at(0) }],
    [
      "a spoken reply",
      { type: "assistant", subtype: "realtime_message", at: at(0), message: true },
    ],
    ["a compression", system(0, "chat_compression")],
    ["a file history snapshot", system(0, "file_history_snapshot")],
    ["an attribution snapshot", system(0, "attribution_snapshot")],
    ["a slash command", system(0, "slash_command")],
    ["a change of model", system(0, "session_model")],
    ["another event", { type: "system", subtype: "ui_telemetry", at: at(0) }],
    ["a request that ended well", lifecycle(0, "ended", "success")],
    ["a request that failed", lifecycle(0, "ended", "error")],
    ["a title", { type: "system", subtype: "custom_title", at: at(0), title: "Fix the tests" }],
  ])("%s says nothing of the status after a reply", (_name, record) => {
    const before = fold([prompt(0), reply(1)]);
    const after = foldQwenCodeRecord(before, { ...record, at: at(2) });
    expect(after.event).toBe("reply");
    expect(after.eventAt).toBe(at(1));
    expect(mapQwenCodeStatus(after, LIVE_SINCE).status).toBe("idle");
  });

  test("does not change the fold it is given", () => {
    const before = fold([prompt(0)]);
    const copy = structuredClone(before);
    foldQwenCodeRecord(before, reply(1));
    foldQwenCodeRecord(before, lifecycle(1, "started"));
    expect(before).toEqual(copy);
  });

  test("keeps the newest title", () => {
    const folded = fold([
      { type: "system", subtype: "custom_title", at: at(0), title: "First" },
      prompt(1),
      { type: "system", subtype: "custom_title", at: at(2), title: "Second" },
    ]);
    expect(folded.title).toBe("Second");
  });

  test("a line of a Managed Session log marks the fold", () => {
    expect(fold([system(0, "managed_session_header_v1")]).managed).toBe(true);
    expect(
      fold([{ type: "system", subtype: "session_execution_engine", at: at(0), managed: true }])
        .managed,
    ).toBe(true);
    expect(fold([system(0, "session_execution_engine")]).managed).toBe(false);
  });
});

describe("mapQwenCodeStatus, over a whole turn", () => {
  test("a prompt, a reply calling tools, their results and a reply: working, then idle", () => {
    const lines = [prompt(0), calls(5), result(9), reply(14)];
    expect(statusOf(lines.slice(0, 1))).toEqual({ status: "working", since: at(0) });
    expect(statusOf(lines.slice(0, 2))).toEqual({ status: "working", since: at(0) });
    expect(statusOf(lines.slice(0, 3))).toEqual({ status: "working", since: at(0) });
    expect(statusOf(lines)).toEqual({ status: "idle", since: at(14) });
  });

  test("tools waiting for approval write nothing, so the session stays working", () => {
    expect(statusOf([prompt(0), calls(5)])).toEqual({ status: "working", since: at(0) });
  });

  test("every call declined ends the turn: idle", () => {
    expect(statusOf([prompt(0), calls(5), result(9, true), result(9, true)])).toEqual({
      status: "idle",
      since: at(9),
    });
  });

  test("Esc while tools run ends the turn even when some finished: idle", () => {
    expect(statusOf([prompt(0), calls(5), result(9), result(9, true)]).status).toBe("idle");
    expect(statusOf([prompt(0), calls(5), result(9, true), result(9)]).status).toBe("idle");
  });

  test("when a declined call's turn goes on, the next request shows it working again", () => {
    const lines = [
      lifecycle(0, "started"),
      prompt(0),
      lifecycle(5, "ended", "success"),
      calls(5),
      result(9),
      result(9, true),
      lifecycle(10, "started"),
    ];
    expect(statusOf(lines)).toEqual({ status: "working", since: at(10) });
    expect(statusOf([...lines, lifecycle(12, "ended", "success"), reply(12)])).toEqual({
      status: "idle",
      since: at(12),
    });
  });

  test("the next calls start the batch afresh", () => {
    const lines = [prompt(0), calls(1), result(2, true), calls(3), result(4)];
    expect(statusOf(lines).status).toBe("working");
  });

  test("a request under way is working, and a request that ended well, with no reply yet, stays working", () => {
    expect(statusOf([prompt(0), lifecycle(1, "started")]).status).toBe("working");
    expect(
      statusOf([prompt(0), lifecycle(1, "started"), lifecycle(4, "ended", "success")]),
    ).toEqual({ status: "working", since: at(0) });
  });

  test.each(["success", "error", "interrupted"])(
    "a request after a reply that ended with %s and no line after it is idle again",
    (outcome) => {
      // Qwen Code's check of who speaks next asks the model after a reply, and writes no reply of its own.
      const lines = [prompt(0), reply(5), lifecycle(6, "started")];
      expect(statusOf(lines)).toEqual({ status: "working", since: at(6) });
      expect(statusOf([...lines, lifecycle(7, "ended", outcome)])).toEqual({
        status: "idle",
        since: at(7),
      });
    },
  );

  test("a request that ended puts back only the event before it, and only while it is the newest", () => {
    // Two requests under way at once: the event before the first comes back.
    expect(
      statusOf([
        prompt(0),
        reply(5),
        lifecycle(6, "started"),
        lifecycle(7, "started"),
        lifecycle(8, "ended", "success"),
      ]),
    ).toEqual({ status: "idle", since: at(8) });
    // A newer line than the request stands.
    expect(
      statusOf([prompt(0), lifecycle(1, "started"), calls(4), lifecycle(4, "ended", "success")]),
    ).toEqual({ status: "working", since: at(0) });
    // In a file read whole, a request with nothing before it leaves nothing that says anything.
    expect(statusOf([lifecycle(1, "started"), lifecycle(2, "ended", "success")])).toEqual({
      status: "idle",
      since: LIVE_SINCE,
    });
  });

  test("Esc while the model replies is idle, and so is the partial reply after it", () => {
    const stopped = [prompt(0), lifecycle(1, "started"), lifecycle(3, "ended", "cancelled")];
    expect(statusOf(stopped)).toEqual({ status: "idle", since: at(3) });
    expect(statusOf([...stopped, reply(3)])).toEqual({ status: "idle", since: at(3) });
  });

  test("Esc after a call has come in is idle: the partial reply that calls a tool runs nothing", () => {
    const stopped = [prompt(0), lifecycle(1, "started"), lifecycle(3, "ended", "cancelled")];
    expect(statusOf([...stopped, calls(3)])).toEqual({ status: "idle", since: at(3) });
    expect(statusOf([...stopped, { type: "assistant", at: at(3), oversized: true }])).toEqual({
      status: "idle",
      since: at(3),
    });
    // A title between them changes nothing.
    expect(
      statusOf([
        ...stopped,
        { type: "system", subtype: "custom_title", at: at(3), title: "Fix the tests" },
        calls(3),
      ]).status,
    ).toBe("idle");
    // The next request, prompt or result reads replies as before.
    expect(statusOf([...stopped, calls(3), lifecycle(4, "started"), calls(6)])).toEqual({
      status: "working",
      since: at(4),
    });
    expect(statusOf([...stopped, prompt(8), calls(9)])).toEqual({
      status: "working",
      since: at(8),
    });
  });

  test("retries after an error stay working", () => {
    const lines = [
      prompt(0),
      lifecycle(1, "started"),
      lifecycle(2, "ended", "error"),
      system(2, "ui_telemetry"),
      lifecycle(5, "started"),
    ];
    expect(statusOf(lines)).toEqual({ status: "working", since: at(0) });
    // A request that fails for good writes no line that ends the turn: the declared gap.
    expect(statusOf([...lines, lifecycle(6, "ended", "error")]).status).toBe("working");
  });

  test("a subagent's requests and events change nothing", () => {
    const idle = [prompt(0), reply(5)];
    expect(statusOf([...idle, lifecycle(6, "started", undefined, true)])).toEqual({
      status: "idle",
      since: at(5),
    });
    expect(
      statusOf([
        prompt(0),
        lifecycle(1, "started", undefined, true),
        lifecycle(2, "ended", "cancelled", true),
      ]).status,
    ).toBe("working");
  });

  test("a newer reply outlasts a request whose end was never written", () => {
    const lines = [prompt(0), lifecycle(1, "started"), reply(4)];
    expect(statusOf(lines)).toEqual({ status: "idle", since: at(4) });
  });

  test("lines from before the session registered are an earlier process's: idle since it registered", () => {
    const liveSince = at(600);
    // A turn that an earlier Qwen Code left mid-way, then resumed.
    expect(statusOf([prompt(0), calls(5)], true, liveSince)).toEqual({
      status: "idle",
      since: liveSince,
    });
    expect(statusOf([prompt(0), lifecycle(1, "started")], true, liveSince)).toEqual({
      status: "idle",
      since: liveSince,
    });
    // A second's slack: lines written just before the record are the session's own.
    expect(statusOf([prompt(599.5)], true, liveSince)).toEqual({
      status: "working",
      since: at(599.5),
    });
    // An idle session is never idle from before it registered.
    expect(statusOf([prompt(599.2), reply(599.6)], true, liveSince)).toEqual({
      status: "idle",
      since: liveSince,
    });
  });

  test("a rewind and a turn's end are idle", () => {
    expect(statusOf([prompt(0), calls(1), system(2, "rewind")]).status).toBe("idle");
    expect(statusOf([prompt(0), calls(1), system(2, "turn_result")]).status).toBe("idle");
  });

  test("a line of a type it does not know, or a reply too long to read, is unknown with no time", () => {
    expect(statusOf([prompt(0), { type: "summary", at: at(1) }])).toEqual({
      status: "unknown",
      since: null,
    });
    expect(statusOf([prompt(0), { type: "assistant", at: at(1), oversized: true }])).toEqual({
      status: "unknown",
      since: null,
    });
    // A newer line that says something decides again.
    expect(
      statusOf([prompt(0), { type: "assistant", at: at(1), oversized: true }, result(2)]).status,
    ).toBe("working");
  });

  test("a Managed Session log is unknown whatever its lines say", () => {
    expect(statusOf([system(0, "managed_session_header_v1"), prompt(1), reply(2)])).toEqual({
      status: "unknown",
      since: null,
    });
  });

  test("no chat file, or one read whole with nothing that says anything, is idle since the session registered", () => {
    expect(mapQwenCodeStatus(null, LIVE_SINCE)).toEqual({ status: "idle", since: LIVE_SINCE });
    expect(statusOf([])).toEqual({ status: "idle", since: LIVE_SINCE });
    expect(statusOf([system(0, "session_model"), system(1, "custom_title")])).toEqual({
      status: "idle",
      since: LIVE_SINCE,
    });
  });

  test("a file read from its middle with nothing that says anything is unknown", () => {
    expect(statusOf([system(0, "file_history_snapshot")], false)).toEqual({
      status: "unknown",
      since: null,
    });
  });

  test("a file read from its middle does not know when the work began, until a prompt", () => {
    expect(statusOf([calls(1), result(2)], false)).toEqual({ status: "working", since: null });
    expect(statusOf([calls(1), result(2), reply(3), prompt(4)], false)).toEqual({
      status: "working",
      since: at(4),
    });
    // An idle stretch it saw only the end of is idle since its first line read.
    expect(statusOf([reply(1), system(2, "rewind")], false)).toEqual({
      status: "idle",
      since: at(1),
    });
  });

  test("never says a session needs you, failed or finished", () => {
    const records: QwenCodeRecord[] = [
      prompt(0),
      { type: "user", subtype: "notification", at: at(0) },
      calls(1),
      reply(1),
      result(1),
      result(1, true),
      system(1, "rewind"),
      system(1, "turn_result"),
      lifecycle(1, "started"),
      lifecycle(1, "ended", "error"),
      lifecycle(1, "ended", "cancelled"),
      { type: "summary", at: at(1) },
      { type: "assistant", at: at(1), oversized: true },
    ];
    const seen = new Set<SessionStatus>();
    for (const first of records) {
      for (const second of records) {
        for (const whole of [true, false]) {
          seen.add(statusOf([first, second], whole).status);
          seen.add(statusOf([first, second], whole, at(600)).status);
        }
      }
    }
    expect([...seen].sort()).toEqual(["idle", "unknown", "working"]);
  });
});
