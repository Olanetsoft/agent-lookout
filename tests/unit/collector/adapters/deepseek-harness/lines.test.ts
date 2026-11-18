import { describe, expect, test } from "vitest";

import {
  isTitleLine,
  LINE_HEAD_BYTES,
  readEvent,
  readHeader,
  TITLE_LINE_MAX,
  TITLE_MAX,
} from "@collector/adapters/deepseek-harness/lines";
import {
  CHILD_ID,
  childHeaderLine,
  CWD,
  event,
  headerLine,
  importedEvent,
  line,
  NOW,
  PRIVATE_WORDS,
  SESSION_ID,
  STARTED_AT,
  uuidOf,
} from "@tests/fixtures/deepseek-harness/deepseekHarness";
import { watchDecoding } from "@tests/support/adapters/unreal-agent/decodeSpy";

const bytes = (text: string) => new TextEncoder().encode(text);
const header = (text: string) => readHeader(bytes(text.replace(/\n$/, "")), "darwin");
const read = (text: string, titles = true) => {
  const data = bytes(text);
  return readEvent(data, data.byteLength, titles);
};
const T = NOW - 60_000;

describe("the header", () => {
  test("keeps the ID, the start, the folder, the parent and whether it is a subagent's", () => {
    expect(header(headerLine())).toEqual({
      id: SESSION_ID,
      createdAt: STARTED_AT,
      cwd: CWD,
      parentSession: null,
      subagent: false,
    });
    expect(header(childHeaderLine())).toEqual({
      id: CHILD_ID,
      createdAt: STARTED_AT,
      cwd: CWD,
      parentSession: SESSION_ID,
      subagent: true,
    });
    expect(header(headerLine({ isSeeded: true, agentPreset: "demo", cwd: null }))).toMatchObject({
      cwd: null,
    });
  });

  test("of another format, kind or shape, is not one", () => {
    expect(header(headerLine({ version: 3 }))).toBeNull();
    expect(header(headerLine({ version: 5 }))).toBeNull();
    expect(header(headerLine().replace('"type":"session"', '"type":"other"'))).toBeNull();
    // Unknown keys, as DeepSeek Harness refuses them.
    expect(
      header(headerLine().replace('"delegationDepth":0', '"delegationDepth":0,"sandboxMode":"x"')),
    ).toBeNull();
    expect(header(headerLine().replace('"isSeeded":false', '"isSeeded":"no"'))).toBeNull();
    expect(header(headerLine().replace('"delegationDepth":0', '"delegationDepth":-1'))).toBeNull();
    expect(
      header(headerLine().replace(`"createdAt":${STARTED_AT}`, '"createdAt":"soon"')),
    ).toBeNull();
    expect(header(headerLine().replace('"isSeeded"', '"origin":"other","isSeeded"'))).toBeNull();
    expect(header("{not json")).toBeNull();
    // Keys in another order are not read as a header's first bytes.
    expect(
      header(
        `{"version":4,"type":"session","id":"${SESSION_ID}","createdAt":1,"isSeeded":false,"delegationDepth":0}`,
      ),
    ).toBeNull();
  });

  test("checks its first bytes before it is parsed", () => {
    const seen = watchDecoding(() => {
      expect(header(`{"type":"turn/start","seq":0,"time":${T},"data":{"turn":1}}`)).toBeNull();
    });
    expect(seen).toEqual([]);
  });

  test("a start before 2020 is none, and the session is still read; one ahead of the clock is kept as written, for each poll to judge", () => {
    expect(header(headerLine({ createdAt: 5 }))?.createdAt).toBeNull();
    expect(header(headerLine({ createdAt: NOW + 2 * 60_000 }))?.createdAt).toBe(NOW + 2 * 60_000);
  });

  test("a folder that is not absolute, too long or holds a control character is none", () => {
    expect(header(headerLine({ cwd: "relative/demo" }))?.cwd).toBeNull();
    expect(header(headerLine({ cwd: `/${"a".repeat(4096)}` }))?.cwd).toBeNull();
    expect(header(headerLine({ cwd: "/Users/example/bad\u0007name" }))?.cwd).toBeNull();
    expect(
      readHeader(bytes(headerLine({ cwd: "C:\\Users\\example\\demo" }).trim()), "win32")?.cwd,
    ).toBe("C:\\Users\\example\\demo");
  });

  test("a parent ID over 1,024 characters is none, and an ID over that is no header", () => {
    expect(
      header(headerLine({ parentSession: "p".repeat(1025), origin: "subagent" }))?.parentSession,
    ).toBeNull();
    expect(header(headerLine({ id: "s".repeat(1025) }))).toBeNull();
  });
});

describe("an event line", () => {
  test("gives its number, and for a turn its start or its end's kind and time", () => {
    expect(read(line.turnStart(3, T))).toEqual({ seq: 3, line: { kind: "turn-start", time: T } });
    for (const kind of ["completed", "blocked", "max-tokens", "interrupted", "forked", "error"]) {
      expect(read(line.turnEnd(4, T, kind)).line, kind).toEqual({
        kind: "turn-end",
        end: kind,
        time: T,
      });
    }
    expect(read(line.turnEnd(4, T, "new-kind")).line).toEqual({
      kind: "turn-end",
      end: "other",
      time: T,
    });
  });

  test("an aborted turn is disposed only when its own reason's kind is, not when a hook's words say so", () => {
    expect(read(line.aborted(4, T, "disposed")).line).toMatchObject({ end: "disposed" });
    for (const why of ["user", "parent", "hook", "legacy"]) {
      expect(read(line.aborted(4, T, why)).line, why).toMatchObject({ end: "aborted" });
    }
    const hook = event("turn/end", 4, T, {
      turn: 1,
      reason: { kind: "aborted", reason: { kind: "hook", reason: '"kind":"disposed"' } },
    });
    expect(read(hook).line).toMatchObject({ end: "aborted" });
  });

  test("an approval asked or answered gives its ID", () => {
    expect(read(line.approvalAsked(5, T)).line).toEqual({
      kind: "approval-asked",
      id: uuidOf(7, 1),
      time: T,
    });
    expect(read(line.approvalDecided(6, T)).line).toEqual({
      kind: "approval-decided",
      id: uuidOf(7, 1),
    });
  });

  test("a call of ask_user_question or exit_plan_mode is a question, and no other call", () => {
    expect(read(line.toolCall(7, T, "call_1", "ask_user_question")).line).toEqual({
      kind: "question-asked",
      callId: "call_1",
      time: T,
    });
    expect(read(line.toolCall(7, T, "call_2", "exit_plan_mode", '{"plan":"# Plan"}')).line).toEqual(
      {
        kind: "question-asked",
        callId: "call_2",
        time: T,
      },
    );
    expect(read(line.toolCall(7, T, "call_3", "bash")).line).toEqual({ kind: "other" });
    expect(read(line.toolCall(7, T, "call_3", "ask_user_question_v2")).line).toEqual({
      kind: "other",
    });
  });

  test("the names inside another call's arguments do not count", () => {
    const args = JSON.stringify({ note: ',"name":"ask_user_question","arguments":' });
    expect(read(line.toolCall(7, T, "call_3", "bash", args)).line).toEqual({ kind: "other" });
  });

  test("a result gives its call's ID, and null in another layout", () => {
    expect(read(line.toolResult(8, T, "call_1")).line).toEqual({
      kind: "tool-result",
      callId: "call_1",
    });
    expect(read(line.syntheticResult(8, T, "call_1")).line).toEqual({
      kind: "tool-result",
      callId: null,
    });
  });

  test("a call ID of any printable bytes, up to 128, is taken; one with an escape or longer makes the line unsure", () => {
    expect(read(line.toolCall(7, T, "toolu_01 A.b:c-d", "ask_user_question")).line).toMatchObject({
      callId: "toolu_01 A.b:c-d",
    });
    expect(read(line.toolCall(7, T, "c".repeat(128), "ask_user_question")).line).toMatchObject({
      kind: "question-asked",
    });
    expect(read(line.toolCall(7, T, "c".repeat(129), "ask_user_question")).line).toEqual({
      kind: "unsure",
    });
    expect(read(line.toolCall(7, T, 'a"b', "ask_user_question")).line).toEqual({ kind: "unsure" });
  });

  test("a fork's end of what it copied is told from a reopened session's", () => {
    expect(read(line.endSeed(9, T, true)).line).toEqual({
      kind: "end-seed",
      inherited: true,
      time: T,
    });
    expect(read(line.endSeed(9, T, false)).line).toEqual({
      kind: "end-seed",
      inherited: false,
      time: T,
    });
  });

  test("a wanted kind in another layout is unsure, and any other kind is nothing", () => {
    expect(read(event("turn/start", 0, T, { step: 1 })).line).toEqual({ kind: "unsure" });
    expect(read(event("turn/end", 0, T, { reason: { kind: "completed" }, turn: 1 })).line).toEqual({
      kind: "unsure",
    });
    expect(
      read(event("approval/asked", 0, T, { toolName: "bash", id: uuidOf(7, 1) })).line,
    ).toEqual({
      kind: "unsure",
    });
    expect(read(event("approval/asked", 0, T, { id: "not-a-uuid" })).line).toEqual({
      kind: "unsure",
    });
    expect(
      read(event("tool/call", 0, T, { callId: "c", turn: 1, step: 1, name: "x" })).line,
    ).toEqual({
      kind: "unsure",
    });
    expect(read(line.userMessage(1, T))).toEqual({ seq: 1, line: { kind: "other" } });
    expect(read(line.plugin(2, T))).toEqual({ seq: 2, line: { kind: "other" } });
  });

  test("a line that is not an event has no number and is unsure", () => {
    for (const text of [
      "",
      "{}",
      '{"seq":1,"type":"turn/start"}',
      `{"type":"turn/start","seq":x}`,
    ]) {
      expect(read(text), text).toEqual({ seq: null, line: { kind: "unsure" } });
    }
    // More than 16 digits is no number.
    expect(read(`{"type":"other","seq":12345678901234567,"time":1,"data":{}}`).seq).toBeNull();
  });

  test("a time before 2020 is none, and the line is still read; one ahead of the clock is kept as written, for each poll to judge", () => {
    expect(read(line.turnStart(0, 5)).line).toEqual({ kind: "turn-start", time: null });
    expect(read(line.turnStart(0, NOW + 2 * 60_000)).line).toEqual({
      kind: "turn-start",
      time: NOW + 2 * 60_000,
    });
  });

  test(`only the first ${LINE_HEAD_BYTES} bytes of a line are looked at`, () => {
    const long = event("tool/call", 7, T, {
      turn: 1,
      step: 1,
      callId: "x".repeat(100),
      name: "ask_user_question",
      arguments: PRIVATE_WORDS[2].repeat(100),
    });
    // Cut where a line's first bytes end, it reads as it does whole.
    const data = bytes(long);
    expect(readEvent(data.subarray(0, LINE_HEAD_BYTES), data.byteLength, true)).toEqual(read(long));
    // A kind's bytes past the first ones are not looked for.
    const late = event("tool/call", 7, T, {
      turn: 1,
      step: 1,
      callId: "y".repeat(120),
      name: `ask_user_question${"z".repeat(LINE_HEAD_BYTES)}`,
      arguments: "{}",
    });
    expect(read(late).line).toEqual({ kind: "other" });
  });
});

describe("an event line the chat import wrote, its data before its number and time", () => {
  test("gives its number, time and kind as a line in the usual order does", () => {
    expect(read(importedEvent("turn/start", 0, T, { turn: 1 }))).toEqual({
      seq: 0,
      line: { kind: "turn-start", time: T },
    });
    for (const kind of ["completed", "error"]) {
      const reason = kind === "error" ? { kind, error: { message: PRIVATE_WORDS[5] } } : { kind };
      expect(read(importedEvent("turn/end", 6, T, { turn: 1, reason })), kind).toEqual({
        seq: 6,
        line: { kind: "turn-end", end: kind, time: T },
      });
    }
    const call = { turn: 1, step: 1, callId: "call_1", name: "ask_user_question", arguments: "{}" };
    expect(read(importedEvent("tool/call", 4, T, call))).toEqual({
      seq: 4,
      line: { kind: "question-asked", callId: "call_1", time: T },
    });
    const bash = { ...call, name: "bash" };
    expect(read(importedEvent("tool/call", 4, T, bash))).toEqual({
      seq: 4,
      line: { kind: "other" },
    });
  });

  test("of any other kind is nothing, with its surface keys too", () => {
    expect(read(importedEvent("step/start", 1, T, { turn: 1, step: 1 }))).toEqual({
      seq: 1,
      line: { kind: "other" },
    });
    const message = { role: "user", content: [{ type: "text", text: PRIVATE_WORDS[0] }] };
    expect(
      read(importedEvent("user/message", 3, T, { turn: 1, message }, { surfaceOp: "append" })),
    ).toEqual({ seq: 3, line: { kind: "other" } });
    const result = importedEvent(
      "tool/result",
      5,
      T,
      { turn: 1, step: 1, message: { role: "assistant" } },
      { surfaceOp: "append", sourceEventSeqs: [4] },
    );
    expect(read(result)).toEqual({ seq: 5, line: { kind: "tool-result", callId: null } });
  });

  test("gives a title marked as the person's", () => {
    const title = importedEvent("session/title", 7, T, {
      title: "Imported chat",
      messageSeqs: [],
      source: { kind: "user" },
    });
    expect(isTitleLine(bytes(title))).toBe(true);
    expect(read(title)).toEqual({ seq: 7, line: { kind: "other" }, title: "Imported chat" });
  });

  test(`over ${LINE_HEAD_BYTES} bytes keeps its kind, with no number or time`, () => {
    const long = importedEvent("turn/end", 6, T, {
      turn: 1,
      reason: { kind: "error", error: { message: PRIVATE_WORDS[5].repeat(40) } },
    });
    const data = bytes(long);
    expect(data.byteLength).toBeGreaterThan(LINE_HEAD_BYTES);
    expect(readEvent(data.subarray(0, LINE_HEAD_BYTES), data.byteLength, true)).toEqual({
      seq: null,
      line: { kind: "turn-end", end: "error", time: null },
    });
    // Its first bytes end as a line's own number and time would, inside its data.
    const start = `{"type":"turn/start","data":{"turn":1,"pad":"`;
    const inner = `","o":{"a":1,"seq":5,"time":${T}}`;
    const pad = "p".repeat(LINE_HEAD_BYTES - start.length - inner.length);
    const cut = JSON.stringify({
      type: "turn/start",
      data: { turn: 1, pad, o: { a: 1, seq: 5, time: T }, more: "m".repeat(64) },
      seq: 0,
      time: T,
    });
    expect(cut.slice(0, LINE_HEAD_BYTES).endsWith(`,"seq":5,"time":${T}}`)).toBe(true);
    const cutData = bytes(cut);
    expect(readEvent(cutData.subarray(0, LINE_HEAD_BYTES), cutData.byteLength, true)).toEqual({
      seq: null,
      line: { kind: "turn-start", time: null },
    });
  });

  test("takes its number and time only from its very end", () => {
    // A number and time inside its data, and none of its own.
    const inner = JSON.stringify({
      type: "turn/start",
      data: { turn: 1, o: { a: 1, seq: 5, time: T } },
      note: "x",
    });
    expect(read(inner)).toEqual({ seq: null, line: { kind: "turn-start", time: null } });
    const extra = `${importedEvent("turn/start", 0, T, { turn: 1 }).slice(0, -1)},"x":1}`;
    expect(read(extra)).toEqual({ seq: null, line: { kind: "turn-start", time: null } });
    // A time before 2020 is none, and the line is still read.
    expect(read(importedEvent("turn/start", 0, 5, { turn: 1 }))).toEqual({
      seq: 0,
      line: { kind: "turn-start", time: null },
    });
  });

  test("a wanted kind in neither order is unsure", () => {
    const other = JSON.stringify({ type: "turn/start", time: T, seq: 0, data: { turn: 1 } });
    expect(read(other)).toEqual({ seq: null, line: { kind: "unsure" } });
    const between = JSON.stringify({ type: "turn/start", seq: 0, data: { turn: 1 }, time: T });
    expect(read(between)).toEqual({ seq: null, line: { kind: "unsure" } });
  });
});

describe("a title", () => {
  test("its model wrote, or marked as the person's, is read", () => {
    expect(read(line.title(9, T, "Fix the build", "provider")).title).toBe("Fix the build");
    expect(read(line.title(9, T, "My rename", "user")).title).toBe("My rename");
    expect(read(line.title(9, T, 'Quote "and" \\ slash ünïcode', "provider")).title).toBe(
      'Quote "and" \\ slash ünïcode',
    );
  });

  test("of the first words of a prompt, or of a kind this does not know, gives no name and is never decoded", () => {
    const seen = watchDecoding(() => {
      expect(read(line.title(9, T, PRIVATE_WORDS[8], "fallback")).title).toBeNull();
      const other = event("session/title", 9, T, {
        title: PRIVATE_WORDS[8],
        messageSeqs: [1],
        source: { kind: "pasted" },
      });
      expect(read(other).title).toBeNull();
    });
    expect(seen.join(" ")).not.toContain(PRIVATE_WORDS[8]);
  });

  test("whose text holds what its source's kind looks like is read by where the title ends", () => {
    const tricky = line.title(9, T, '","messageSeqs":[1],"source":{"kind":"provider"}', "fallback");
    expect(read(tricky).title).toBeNull();
    const shown = line.title(9, T, '","messageSeqs":[1],"source":{"kind":"fallback"}', "user");
    expect(read(shown).title).toBe('","messageSeqs":[1],"source":{"kind":"fallback"}');
  });

  test(`on a line over ${TITLE_LINE_MAX} bytes, or over ${TITLE_MAX} bytes itself, gives no name`, () => {
    const at = (text: string) => line.title(9, T, text, "provider");
    expect(read(at("t".repeat(TITLE_MAX))).title).toBe("t".repeat(TITLE_MAX));
    expect(read(at("t".repeat(TITLE_MAX + 1))).title).toBeNull();
    const long = event("session/title", 9, T, {
      title: "Short",
      messageSeqs: Array.from({ length: 2000 }, (_, n) => n),
      source: { kind: "provider" },
    });
    expect(long.length).toBeGreaterThan(TITLE_LINE_MAX);
    expect(read(long).title).toBeNull();
  });

  test("of a subagent's log is never decoded", () => {
    const seen = watchDecoding(() => {
      expect(read(line.title(9, T, "Child title", "provider"), false)).toEqual({
        seq: 9,
        line: { kind: "other" },
      });
    });
    expect(seen.join(" ")).not.toContain("Child title");
  });

  test("is told from its first bytes", () => {
    expect(isTitleLine(bytes(line.title(9, T, "x", "provider")))).toBe(true);
    expect(isTitleLine(bytes(line.turnStart(0, T)))).toBe(false);
  });
});

test("of every kind, only the IDs, a title its model wrote and nothing private is turned into text", () => {
  const lines = [
    line.turnStart(0, T),
    line.userMessage(1, T),
    line.assistantMessage(2, T),
    line.approvalAsked(3, T),
    line.approvalDecided(4, T),
    line.toolCall(5, T, "call_1", "ask_user_question"),
    line.toolCall(6, T, "call_2", "exit_plan_mode", JSON.stringify({ plan: PRIVATE_WORDS[7] })),
    line.toolResult(7, T, "call_1"),
    line.syntheticResult(8, T, "call_2"),
    line.title(9, T, PRIVATE_WORDS[8], "fallback"),
    line.title(10, T, "Fix the build", "provider"),
    line.turnEnd(11, T, "error"),
    line.aborted(12, T, "hook"),
    line.plugin(13, T),
  ];
  const seen = watchDecoding(() => {
    for (const text of lines) read(text);
  });
  for (const word of PRIVATE_WORDS) expect(seen.join(" "), word).not.toContain(word);
  // The kinds compared, the IDs, and the title its model wrote, as it was given to JSON.parse and as it came out.
  const allowed = [
    uuidOf(7, 1),
    "call_1",
    "call_2",
    "provider",
    "fallback",
    "error",
    "aborted",
    "hook",
    '"Fix the build"',
    "Fix the build",
  ];
  for (const text of seen) expect(allowed, text).toContain(text);
  expect(seen).toContain("Fix the build");
  expect(seen).toContain(uuidOf(7, 1));
});
