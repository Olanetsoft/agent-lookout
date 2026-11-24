import { describe, expect, test } from "vitest";

import {
  foldLine,
  judgeLine,
  LINE_HEAD_BYTES,
  MAX_OPEN_APPROVALS,
  MAX_STARTED_CALLS,
  MAX_TAIL_BYTES,
  ownCopy,
  PIECE_BYTES,
  readFromEnd,
  readOnwards,
  viewOf,
  type Tail,
  type TailView,
} from "@collector/adapters/oh-my-pi/tail";
import type { OpenFile } from "@collector/files/readOnlyIo";
import { NO_APPROVALS } from "@core/mapping/oh-my-pi/ohMyPiMapping";
import { INSTANT } from "@collector/adapters/pi/sessionFile";
import {
  approvalEnd,
  approvalRequest,
  custom,
  iso,
  line,
  message,
  MINUTE,
  NOW,
  passedLines,
  PRIVATE_PROMPT,
  PRIVATE_REASON,
  PRIVATE_REPLY,
  PRIVATE_WORDS,
  refusal,
  sessionExit,
  sessionText,
  toolStart,
} from "@tests/fixtures/oh-my-pi/ohMyPi";
import { watchDecoding, watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";

const AT = NOW - MINUTE;

/** The bytes of the ID of the fixture's call. */
const CALL = Buffer.from("call-1");

/** What one line is, from its bytes. */
const judge = (text: string) => judgeLine(Buffer.from(text.replace(/\n$/, "")));

/** An open file of these bytes, which notes every read. */
function openBytes(data: Buffer) {
  const reads: { position: number; length: number }[] = [];
  const file: OpenFile = {
    info: { kind: "file", size: data.byteLength, mtimeMs: NOW, ino: 1 },
    async read(position, length) {
      reads.push({ position, length });
      return data.subarray(position, position + Math.max(0, length));
    },
    async close() {},
  };
  return { file, reads };
}

/** What a first read of these bytes keeps, and says. */
async function fresh(text: string | Buffer) {
  const data = typeof text === "string" ? Buffer.from(text) : text;
  const tail = await readFromEnd(openBytes(data).file, data.byteLength);
  return { tail, view: viewOf(tail, data.byteLength) };
}

/** What reading on from `before` to `after` keeps, or null when it reads afresh. */
async function onwards(before: Buffer, after: Buffer) {
  const known = await readFromEnd(openBytes(before).file, before.byteLength);
  return readOnwards(openBytes(after).file, after.byteLength, known);
}

/** How many bytes these reads asked for. */
const total = (reads: readonly { length: number }[]) =>
  reads.reduce((sum, { length }) => sum + length, 0);

/** A line of `bytes` bytes that is passed over, with its line break. */
function passedOf(bytes: number): string {
  const start = '{"type":"model_usage","pad":"';
  const end = '"}\n';
  return `${start}${"x".repeat(bytes - start.length - end.length)}${end}`;
}

describe("each line, from its first bytes", () => {
  test("an exit, of each kind, with its time", () => {
    expect(judge(sessionExit("normal", AT))).toEqual({ sort: "exit", fatal: false, at: AT });
    expect(judge(sessionExit("signal", AT))).toEqual({ sort: "exit", fatal: false, at: AT });
    expect(judge(sessionExit("process_exit", AT))).toEqual({ sort: "exit", fatal: false, at: AT });
    expect(judge(sessionExit("fatal", AT))).toEqual({ sort: "exit", fatal: true, at: AT });
  });

  test("an exit of a kind or a reason this does not know, or with no time, cannot be read", () => {
    expect(judge(sessionExit("normal", AT).replace('"kind":"normal"', '"kind":"other"')).sort).toBe(
      "unreadable",
    );
    expect(judge(sessionExit("normal", AT, "Dispose")).sort).toBe("unreadable");
    expect(judge(sessionExit("normal", AT).replace(iso(AT), "soon")).sort).toBe("unreadable");
    // Keys in another order.
    const moved = custom("session_exit", {
      kind: "normal",
      reason: "dispose",
      recordedAt: iso(AT),
    });
    expect(judge(moved).sort).toBe("unreadable");
  });

  test("the ask tool's start, with its call and its time, and any other tool's, with its call", () => {
    expect(judge(toolStart("ask", AT))).toEqual({ sort: "ask", at: AT, call: CALL });
    expect(judge(toolStart("bash", AT))).toEqual({ sort: "tool", call: CALL });
    expect(judge(toolStart("task", AT))).toEqual({ sort: "tool", call: CALL });
    expect(judge(toolStart("asking", AT))).toEqual({ sort: "tool", call: CALL });
    expect(judge(toolStart("bash", AT, { callId: "" }))).toEqual({ sort: "tool", call: null });
    // An ask with no time after its name cannot be read.
    const noTime = custom("tool_execution_start", { toolCallId: "c", toolName: "ask" });
    expect(judge(noTime).sort).toBe("unreadable");
  });

  test("a call ID with escaped quotes is skipped as one string", () => {
    expect(judge(toolStart("ask", AT, { callId: 'call "one" \\ two' }))).toEqual({
      sort: "ask",
      at: AT,
      call: Buffer.from(JSON.stringify('call "one" \\ two').slice(1, -1)),
    });
    // One longer than 512 bytes is not.
    expect(judge(toolStart("ask", AT, { callId: "c".repeat(600) })).sort).toBe("unreadable");
  });

  test("a provider's refusal is a reply with no time, since its line's time is after its data", () => {
    expect(judge(refusal())).toEqual({ sort: "reply", at: null });
    expect(watchDecoding(() => judge(refusal()))).toEqual([]);
  });

  test("an approval's request, with its call, the call that dispatched it and its time, and nothing else turned into text", () => {
    expect(judge(approvalRequest(AT))).toEqual({
      sort: "request",
      call: CALL,
      parent: null,
      at: AT,
    });
    expect(judge(approvalRequest(AT, { reason: null }))).toEqual({
      sort: "request",
      call: CALL,
      parent: null,
      at: AT,
    });
    const nested = approvalRequest(AT, { callId: "call-9", parentId: "call-1" });
    expect(judge(nested)).toEqual({
      sort: "request",
      call: Buffer.from("call-9"),
      parent: CALL,
      at: AT,
    });
    expect(new Set(watchDecoding(() => judge(nested)))).toEqual(new Set([iso(AT)]));
  });

  test("a request's name, mode and reason are stepped over, whatever they hold", () => {
    const reason = `","requestedAt":"${iso(AT - MINUTE)}"} \\ "`;
    expect(judge(approvalRequest(AT, { reason, toolName: 'na"me' }))).toMatchObject({
      sort: "request",
      at: AT,
    });
    // One that runs past the first 1 KiB leaves the time unknown, and the request stands.
    expect(judge(approvalRequest(AT, { reason: "r".repeat(LINE_HEAD_BYTES) }))).toEqual({
      sort: "request",
      call: CALL,
      parent: null,
      at: null,
    });
    // So does a time that is not one, or a key this does not know before it.
    expect(judge(approvalRequest(AT).replace(iso(AT), "soon"))).toMatchObject({ at: null });
    expect(judge(approvalRequest(AT).replace('"reason":', '"note":"x","reason":'))).toMatchObject({
      sort: "request",
      call: CALL,
      at: null,
    });
  });

  test("a request whose call, or the call that dispatched it, cannot be read has none", () => {
    const unread = { sort: "request", call: null, parent: null, at: null };
    for (const text of [
      approvalRequest(AT, { callId: "" }),
      approvalRequest(AT, { callId: "c".repeat(513) }),
      approvalRequest(AT, { parentId: "" }),
      approvalRequest(AT, { parentId: "c".repeat(513) }),
      approvalRequest(AT, { parentId: "call-9" }).replace('"call-9"', "null"),
      approvalRequest(AT).replace('"toolName"', '"name"'),
      approvalRequest(AT).replace('"toolCallId"', '"call"'),
      approvalRequest(AT).replace(',"data":{', ',"data":null,"x":{'),
    ]) {
      expect(judge(text)).toEqual(unread);
    }
    expect(judge(approvalRequest(AT, { callId: "c".repeat(512) }))).toMatchObject({
      call: Buffer.from("c".repeat(512)),
    });
  });

  test("an approval's end, with its call, however it ended, and nothing turned into text", () => {
    for (const approved of [true, false]) {
      const end = approvalEnd(AT, { approved });
      expect(judge(end)).toEqual({ sort: "resolved", call: CALL });
      expect(watchDecoding(() => judge(end))).toEqual([]);
    }
    for (const text of [
      approvalEnd(AT, { callId: "" }),
      approvalEnd(AT, { callId: "c".repeat(513) }),
      approvalEnd(AT).replace('"toolName"', '"name"'),
      approvalEnd(AT).replace('"toolCallId"', '"call"'),
    ]) {
      expect(judge(text)).toEqual({ sort: "resolved", call: null });
    }
  });

  test("a call's ID is compared as the bytes its line holds, its escapes among them", () => {
    const callId = 'call "one" \\ twö';
    const written = Buffer.from(JSON.stringify(callId).slice(1, -1));
    expect(judge(approvalRequest(AT, { callId }))).toMatchObject({ call: written });
    expect(judge(approvalEnd(AT, { callId }))).toEqual({ sort: "resolved", call: written });
    expect(judge(message("toolResult", { callId }))).toMatchObject({ call: written });
  });

  test("a result's call is the ID after its role, and none when that cannot be read", () => {
    expect(judge(message("toolResult", { callId: "call-7" }))).toEqual({
      sort: "result",
      at: AT,
      call: Buffer.from("call-7"),
    });
    const whole = message("toolResult");
    for (const text of [
      message("toolResult", { callId: "" }),
      message("toolResult", { callId: "c".repeat(513) }),
      message("toolResult").replace('"toolCallId"', '"call"'),
      // Its ID's closing quote past the first 1 KiB, and its role within it.
      whole.replace('"0abc"', `"${"b".repeat(LINE_HEAD_BYTES - whole.indexOf('call-1"'))}"`),
    ]) {
      expect(judge(text)).toEqual({ sort: "result", at: AT, call: null });
    }
  });

  test("each role of a message", () => {
    expect(judge(message("user"))).toEqual({ sort: "prompt" });
    expect(judge(message("developer"))).toEqual({ sort: "prompt" });
    expect(judge(message("toolResult"))).toEqual({ sort: "result", at: AT, call: CALL });
    expect(judge(message("assistant"))).toEqual({ sort: "reply", at: AT });
    for (const role of [
      "bashExecution",
      "pythonExecution",
      "fileMention",
      "hookMessage",
      "custom",
    ]) {
      expect(judge(message(role))).toEqual({ sort: "passed" });
    }
    expect(judge(message("someone")).sort).toBe("unreadable");
  });

  test("a reply's and a result's time, as Oh My Pi wrote it on the line, and no time of any other message", () => {
    const at = AT - 5_000;
    expect(judge(message("assistant", { at }))).toEqual({ sort: "reply", at });
    expect(judge(message("toolResult", { at, runtime: false }))).toEqual({
      sort: "result",
      at,
      call: CALL,
    });
    // One decoding can pass through more than one of Node's ways, each noted.
    expect(new Set(watchDecoding(() => judge(message("assistant", { at }))))).toEqual(
      new Set([iso(at)]),
    );
    // A prompt's time, and a passed-over message's, is never turned into text.
    for (const role of ["user", "developer", "bashExecution", "custom"]) {
      expect(watchDecoding(() => judge(message(role, { at })))).toEqual([]);
    }
  });

  test("a reply's or a result's time that is not a time is none, and the line still decides", () => {
    for (const timestamp of [
      "2026-10-01T11:59:00",
      "2026-10-01",
      "2026-13-45T99:99:99.000Z",
      `2026-10-01T11:59:00.${"0".repeat(30)}Z`,
    ]) {
      for (const [role, sort] of [
        ["assistant", "reply"],
        ["toolResult", "result"],
      ] as const) {
        const text = line({
          type: "message",
          id: "a1",
          parentId: null,
          timestamp,
          message: { role },
        });
        // The message has no call here, so a result's cannot be read.
        expect(judge(text)).toEqual({ sort, at: null, ...(sort === "result" && { call: null }) });
      }
    }
  });

  test("a message with no runtime, as one Oh My Pi made from another agent's session, and one with an empty one", () => {
    expect(judge(message("user", { runtime: false }))).toEqual({ sort: "prompt" });
    const empty = line({
      type: "message",
      id: "a1",
      parentId: "a0",
      timestamp: iso(AT),
      runtime: {},
      message: { role: "assistant" },
    });
    expect(judge(empty)).toEqual({ sort: "reply", at: AT });
  });

  test("a message of another shape cannot be read", () => {
    const shapes = [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: iso(AT),
        message: { content: "x", role: "user" },
      },
      { type: "message", parentId: null, id: "a1", timestamp: iso(AT), message: { role: "user" } },
      { type: "message", id: "a1", parentId: 7, timestamp: iso(AT), message: { role: "user" } },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: iso(AT),
        runtime: { n: 1 },
        message: { role: "user" },
      },
      { type: "message", id: "a1", parentId: null, timestamp: "", message: { role: "user" } },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "unknown",
        message: { role: "assistant" },
      },
    ];
    for (const shape of shapes) expect(judge(line(shape)).sort).toBe("unreadable");
  });

  test("a message whose role is past its first 1 KiB cannot be read", () => {
    const long = line({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: iso(AT),
      runtime: { version: "19.0.0", branch: "b".repeat(LINE_HEAD_BYTES) },
      message: { role: "user" },
    });
    expect(judge(long).sort).toBe("unreadable");
  });

  test("every other kind of line is passed over, the title slot and the header among them", () => {
    for (const text of passedLines().split("\n").filter(Boolean)) {
      expect(judge(text)).toEqual({ sort: "passed" });
    }
    const [slot, head] = sessionText("").split("\n");
    expect(judge(slot as string)).toEqual({ sort: "passed" });
    expect(judge(head as string)).toEqual({ sort: "passed" });
    expect(judge(custom("system-prompt-digest", { x: 1 }))).toEqual({ sort: "passed" });
  });

  test("a tool's start, a refusal or a custom line of a longer kind than any that decides, of another shape, ends no wait", () => {
    const longKind = "k".repeat(70);
    for (const text of [
      toolStart("bash", AT, { callId: "c".repeat(600) }),
      toolStart("bash", AT).replace('"toolCallId"', '"call"'),
      toolStart("bash", AT).replace('"toolName":"bash"', '"toolName":""'),
      toolStart("ask", AT).replace(iso(AT), "soon"),
      refusal().replace('"provider_refusal",', '"provider_refusal"}'),
      custom(longKind, { x: 1 }),
    ]) {
      expect(judge(text)).toEqual({ sort: "unreadable", endsNone: true });
    }
    for (const text of [
      // A kind whose end is not in reach, or that holds a control character, is of no known form.
      custom("k".repeat(LINE_HEAD_BYTES), { x: 1 }),
      custom(longKind, { x: 1 }).replace(longKind, `${longKind}\t`),
      sessionExit("normal", AT).replace(iso(AT), "soon"),
      message("someone"),
      "garbage",
    ]) {
      expect(judge(text)).toEqual({ sort: "unreadable" });
    }
  });

  test("a line that does not begin as Oh My Pi's do cannot be read", () => {
    for (const text of [
      "",
      "garbage",
      '{ "type":"message"}',
      '{"type":"Message","id":"a"}',
      '{"type":"message"}',
    ]) {
      expect(judge(text).sort).toBe("unreadable");
    }
  });

  test("text inside a line that looks like a marker is not one", () => {
    const fake = line({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: iso(AT),
      message: {
        role: "user",
        content: `\n{"type":"custom","customType":"session_exit","data":{"reason":"dispose","kind":"normal","recordedAt":"${iso(AT)}"`,
      },
    });
    // JSON writes the line break inside the string as \n, so the line is still one prompt.
    expect(fake.split("\n").filter(Boolean)).toHaveLength(1);
    expect(judge(fake)).toEqual({ sort: "prompt" });
  });
});

describe("the newest line that decides, read from the end", () => {
  test("a file whose lines are all passed over has none", async () => {
    expect((await fresh(sessionText(""))).view).toEqual({ state: "none" });
    expect((await fresh(sessionText(passedLines()))).view).toEqual({ state: "none" });
  });

  test("the newest line that decides, past the lines passed over after it", async () => {
    const { view } = await fresh(
      sessionText(message("user") + toolStart("ask", AT) + passedLines()),
    );
    expect(view).toEqual({
      state: "ok",
      newest: { sort: "ask", at: AT },
      behind: null,
      cutOff: null,
      approvals: NO_APPROVALS,
    });
  });

  test("a last line with no line break waits until it is whole", async () => {
    const text = sessionText(message("user") + message("assistant").replace(/\n$/, ""));
    const { tail, view } = await fresh(text);
    expect(view).toMatchObject({ newest: { sort: "prompt" } });
    expect(tail.end).toBe(Buffer.byteLength(text) - Buffer.byteLength(message("assistant")) + 1);
  });

  test("a quit mid-turn: the exit, then an aborted result and reply, reads as the exit", async () => {
    for (const kind of ["fatal", "signal"] as const) {
      const text = sessionText(
        message("user") +
          toolStart("bash") +
          sessionExit(kind, AT) +
          passedLines() +
          message("toolResult") +
          message("assistant"),
      );
      const exit = { sort: "exit", fatal: kind === "fatal", at: AT };
      expect((await fresh(text)).view).toEqual({
        state: "ok",
        newest: { sort: "reply", at: AT },
        behind: exit,
        cutOff: exit,
        approvals: NO_APPROVALS,
      });
    }
  });

  test("a quit mid-turn whose abort starts tools after the exit: no exit behind, and the exit cut off, afresh and read on", async () => {
    const start = sessionText(message("user") + toolStart("bash"));
    for (const kind of ["signal", "fatal"] as const) {
      const exit = { sort: "exit", fatal: kind === "fatal", at: AT };
      for (const [lines, newest] of [
        [
          [message("toolResult"), toolStart("bash"), message("toolResult"), message("assistant")],
          "reply",
        ],
        [[message("assistant"), toolStart("bash"), message("toolResult")], "result"],
      ] as const) {
        const added = [sessionExit(kind, AT), ...lines];
        const whole = start + added.join("");
        expect((await fresh(whole)).view).toEqual({
          state: "ok",
          newest: { sort: newest, at: AT },
          behind: null,
          cutOff: exit,
          approvals: NO_APPROVALS,
        });
        // Read on a line at a time from before the exit, as a poll after each write would.
        let text = start;
        let known = (await fresh(text)).tail;
        for (const step of added) {
          text += step;
          const data = Buffer.from(text);
          known = (await readOnwards(openBytes(data).file, data.byteLength, known)) as Tail;
        }
        expect(viewOf(known, Buffer.byteLength(text))).toEqual((await fresh(whole)).view);
      }
    }
  });

  test("an exit, then a reply, then a prompt, is a prompt", async () => {
    const text = sessionText(sessionExit("normal", AT) + message("assistant") + message("user"));
    expect((await fresh(text)).view).toEqual({
      state: "ok",
      newest: { sort: "prompt" },
      behind: null,
      cutOff: null,
      approvals: NO_APPROVALS,
    });
  });

  test("a tool or an ask stops the exit behind but not the exit cut off, and a prompt or a line that cannot be read stops both", async () => {
    const exit = { sort: "exit", fatal: false, at: AT };
    for (const stop of [toolStart("bash"), toolStart("ask")]) {
      const text = sessionText(sessionExit("normal", AT) + stop + message("assistant"));
      expect((await fresh(text)).view).toEqual({
        state: "ok",
        newest: { sort: "reply", at: AT },
        behind: null,
        cutOff: exit,
        approvals: NO_APPROVALS,
      });
    }
    // A newest tool or ask looks back too.
    expect((await fresh(sessionText(sessionExit("normal", AT) + toolStart("bash")))).view).toEqual({
      state: "ok",
      newest: { sort: "tool" },
      behind: null,
      cutOff: exit,
      approvals: NO_APPROVALS,
    });
    expect(
      (await fresh(sessionText(sessionExit("normal", AT) + toolStart("ask", AT)))).view,
    ).toEqual({
      state: "ok",
      newest: { sort: "ask", at: AT },
      behind: null,
      cutOff: exit,
      approvals: NO_APPROVALS,
    });
    for (const stop of [message("user"), "garbage\n"]) {
      const text = sessionText(sessionExit("normal", AT) + stop + message("assistant"));
      expect((await fresh(text)).view).toEqual({
        state: "ok",
        newest: { sort: "reply", at: AT },
        behind: null,
        cutOff: null,
        approvals: NO_APPROVALS,
      });
      const tooled = sessionText(sessionExit("normal", AT) + stop + toolStart("bash"));
      expect((await fresh(tooled)).view).toMatchObject({ newest: { sort: "tool" }, cutOff: null });
    }
  });

  test("a line that cannot be read decides as one", async () => {
    expect((await fresh(sessionText(message("user") + "garbage\n"))).view).toEqual({
      state: "ok",
      newest: { sort: "unreadable" },
      behind: null,
      cutOff: null,
      approvals: NO_APPROVALS,
    });
  });

  test("reads lines across a 64 KiB piece's edge", async () => {
    const before = sessionText(message("user"));
    // An ask whose line begins 10 bytes before the end of the last piece read first.
    const ask = toolStart("ask", AT);
    const filler = passedOf(PIECE_BYTES - Buffer.byteLength(before) - 10);
    const data = Buffer.from(
      before + filler + ask + passedOf(PIECE_BYTES - Buffer.byteLength(ask) + 10),
    );
    expect((await fresh(data)).view).toEqual({
      state: "ok",
      newest: { sort: "ask", at: AT },
      behind: null,
      cutOff: null,
      approvals: NO_APPROVALS,
    });
  });

  test("looks through 8 MiB and the byte before them, no further, a piece at a time, twice over with a start in them", async () => {
    for (const [decides, sort, times] of [
      [message("user"), "prompt", 1],
      [toolStart("ask", AT), "ask", 2],
    ] as const) {
      // The line begins exactly 8 MiB from the end: in reach.
      const tailBytes = MAX_TAIL_BYTES - Buffer.byteLength(decides);
      const reached = Buffer.from(sessionText("") + decides + passedOf(tailBytes));
      const { file, reads } = openBytes(reached);
      const tail = await readFromEnd(file, reached.byteLength);
      expect(viewOf(tail, reached.byteLength)).toMatchObject({ newest: { sort } });
      expect(Math.max(...reads.map(({ length }) => length))).toBeLessThanOrEqual(PIECE_BYTES);
      expect(total(reads)).toBeLessThanOrEqual(times * (MAX_TAIL_BYTES + 1));
      // One byte more after it, and it is too far back.
      const past = Buffer.concat([reached, Buffer.from(passedOf(64))]);
      expect((await fresh(past)).view).toEqual({ state: "too-far" });
    }
  });

  test("an exit behind, or one cut off, that is more than 8 MiB back is not found", async () => {
    for (const between of ["", toolStart("bash")]) {
      const text = Buffer.from(
        sessionText(
          sessionExit("normal", AT) + between + passedOf(MAX_TAIL_BYTES) + message("assistant"),
        ),
      );
      expect((await fresh(text)).view).toEqual({
        state: "ok",
        newest: { sort: "reply", at: AT },
        behind: null,
        cutOff: null,
        approvals: NO_APPROVALS,
      });
    }
  });

  test("a last line longer than 8 MiB is too far back", async () => {
    const text = Buffer.from(sessionText(message("user") + passedOf(MAX_TAIL_BYTES + 10)));
    expect((await fresh(text)).view).toEqual({ state: "too-far" });
  });

  test("turns no byte into text but the times kept", async () => {
    const text = sessionText(
      message("user") +
        toolStart("bash") +
        approvalRequest(AT, { callId: "call-9", parentId: "call-1" }) +
        approvalEnd(AT, { callId: "call-9", approved: false }) +
        sessionExit("signal", AT) +
        passedLines() +
        refusal() +
        message("assistant") +
        toolStart("bash") +
        approvalRequest(AT) +
        message("toolResult", { callId: "call-8" }),
    );
    const seen = await watchDecodingWhile(() => fresh(text));
    for (const made of seen) expect(made).toMatch(INSTANT);
    for (const word of PRIVATE_WORDS) expect(seen.join("\n")).not.toContain(word);
  });
});

describe("reading on from the last line read", () => {
  const start = sessionText(message("user"));

  test("folds only what was added, and keeps what a first read of the same file gives", async () => {
    const steps = [
      toolStart("bash"),
      sessionExit("signal", AT),
      message("toolResult"),
      passedLines(),
      message("assistant"),
      message("user"),
      toolStart("ask", AT),
      refusal(),
      "garbage\n",
      message("assistant"),
      toolStart("bash"),
      approvalRequest(AT),
      toolStart("read"),
      approvalRequest(AT, { callId: "call-2" }),
      message("toolResult", { callId: "call-3" }),
      approvalEnd(AT),
      sessionExit("signal", AT),
      approvalEnd(AT, { callId: "call-2", approved: false }),
      message("toolResult", { callId: "call-2" }),
      message("assistant"),
    ];
    let text = start;
    let known = (await fresh(text)).tail;
    for (const step of steps) {
      const next = text + step;
      const data = Buffer.from(next);
      const { file, reads } = openBytes(data);
      const onward = await readOnwards(file, data.byteLength, known);
      expect(onward).not.toBeNull();
      // From the byte before what was added, and no further back.
      expect(Math.min(...reads.map(({ position }) => position))).toBe(Buffer.byteLength(text) - 1);
      expect(viewOf(onward as Tail, data.byteLength)).toEqual((await fresh(next)).view);
      known = onward as Tail;
      text = next;
    }
  });

  test("a half-written line is read once it is whole", async () => {
    const half = message("assistant").slice(0, 40);
    const onward = await onwards(Buffer.from(start), Buffer.from(start + half));
    expect(onward?.end).toBe(Buffer.byteLength(start));
    const whole = await readOnwards(
      openBytes(Buffer.from(start + message("assistant"))).file,
      Buffer.byteLength(start + message("assistant")),
      onward as Tail,
    );
    expect(viewOf(whole as Tail, Buffer.byteLength(start + message("assistant")))).toMatchObject({
      newest: { sort: "reply", at: AT },
    });
  });

  test("a file that shrank, grew by more than 8 MiB, or does not go on from the last line read is read afresh", async () => {
    const longer = start + message("assistant");
    expect(await onwards(Buffer.from(longer), Buffer.from(start))).toBeNull();
    expect(
      await onwards(Buffer.from(start), Buffer.from(start + passedOf(MAX_TAIL_BYTES + 64))),
    ).toBeNull();
    // The same size before the last end, but another line there.
    const other = start.slice(0, -1) + "x" + message("assistant");
    expect(await onwards(Buffer.from(start), Buffer.from(other))).toBeNull();
  });

  test("a file of more than 8 MiB, with no exit in reach, is read on from too", async () => {
    const before = Buffer.from(sessionText(passedOf(MAX_TAIL_BYTES) + message("user")));
    const after = Buffer.concat([before, Buffer.from(message("assistant"))]);
    const known = (await fresh(before)).tail;
    expect(known.whole).toBe(true);
    const { file, reads } = openBytes(after);
    const onward = await readOnwards(file, after.byteLength, known);
    expect(viewOf(onward as Tail, after.byteLength)).toEqual((await fresh(after)).view);
    // Only what was added and the byte before it.
    expect(total(reads)).toBe(after.byteLength - before.byteLength + 1);
  });

  test("a line that decides, pushed more than 8 MiB back by lines passed over, is too far back, as afresh", async () => {
    const decided = sessionText(message("user") + toolStart("ask", AT));
    let known = (await fresh(decided)).tail;
    let text = decided;
    const piece = passedOf(1024 * 1024);
    for (let added = 0; added < 9; added += 1) {
      const next = text + piece;
      const data = Buffer.from(next);
      known = (await readOnwards(openBytes(data).file, data.byteLength, known)) as Tail;
      expect(viewOf(known, data.byteLength)).toEqual((await fresh(data)).view);
      text = next;
    }
    expect(viewOf(known, Buffer.byteLength(text))).toEqual({ state: "too-far" });
  });

  test("an exit behind a reply that falls more than 8 MiB back is dropped, as afresh", async () => {
    const exitLine = sessionExit("normal", AT);
    const reply = message("assistant");
    const decided = sessionText(exitLine + reply);
    const known = (await fresh(decided)).tail;
    // The reply stays in the last 8 MiB, and the exit before it does not.
    const added =
      MAX_TAIL_BYTES - Buffer.byteLength(reply) - Math.floor(Buffer.byteLength(exitLine) / 2);
    const next = Buffer.from(decided + passedOf(added));
    const onward = (await readOnwards(openBytes(next).file, next.byteLength, known)) as Tail;
    expect(viewOf(onward, next.byteLength)).toEqual((await fresh(next)).view);
    expect(viewOf(onward, next.byteLength)).toEqual({
      state: "ok",
      newest: { sort: "reply", at: AT },
      behind: null,
      cutOff: null,
      approvals: NO_APPROVALS,
    });
  });

  test("an exit cut off before a reply that falls more than 8 MiB back is dropped, as afresh", async () => {
    const exitLine = sessionExit("normal", AT);
    const tool = toolStart("bash");
    const reply = message("assistant");
    const decided = sessionText(exitLine + tool + reply);
    const known = (await fresh(decided)).tail;
    expect(viewOf(known, Buffer.byteLength(decided))).toMatchObject({
      behind: null,
      cutOff: { sort: "exit" },
    });
    // The tool and the reply stay in the last 8 MiB, and the exit before them does not.
    const added =
      MAX_TAIL_BYTES -
      Buffer.byteLength(reply) -
      Buffer.byteLength(tool) -
      Math.floor(Buffer.byteLength(exitLine) / 2);
    const next = Buffer.from(decided + passedOf(added));
    const onward = (await readOnwards(openBytes(next).file, next.byteLength, known)) as Tail;
    expect(onward.cutOff).toMatchObject({ sort: "exit" });
    expect(viewOf(onward, next.byteLength)).toEqual((await fresh(next)).view);
    expect(viewOf(onward, next.byteLength)).toEqual({
      state: "ok",
      newest: { sort: "reply", at: AT },
      behind: null,
      cutOff: null,
      approvals: NO_APPROVALS,
    });
  });

  test("a file with no line that decides that grows past 8 MiB of lines passed over is too far back, as afresh", async () => {
    const empty = sessionText("");
    const known = (await fresh(empty)).tail;
    const next = Buffer.from(empty + passedOf(MAX_TAIL_BYTES));
    const onward = (await readOnwards(openBytes(next).file, next.byteLength, known)) as Tail;
    expect(viewOf(onward, next.byteLength)).toEqual({ state: "too-far" });
    expect((await fresh(next)).view).toEqual({ state: "too-far" });
  });

  test("holds a piece and the start of a line, never more, and turns no byte into text but the times kept", async () => {
    const data = Buffer.from(
      start + passedOf(3 * PIECE_BYTES) + sessionExit("normal", AT) + message("assistant"),
    );
    const known = (await fresh(start)).tail;
    const { file, reads } = openBytes(data);
    const seen = await watchDecodingWhile(() => readOnwards(file, data.byteLength, known));
    expect(Math.max(...reads.map(({ length }) => length))).toBeLessThanOrEqual(PIECE_BYTES);
    for (const made of seen) expect(made).toMatch(INSTANT);
  });
});

describe("the approvals that wait", () => {
  const start = sessionText(message("user") + message("assistant") + toolStart("bash", AT));

  /**
   * What a file of these lines says of approvals, read afresh after each of
   * them and read on from there, a line at a time, which must all agree.
   */
  async function approvalsIn(lines: readonly string[], from = start) {
    const texts = [from];
    for (const step of lines) texts.push(`${texts.at(-1)}${step}`);
    const firsts = await Promise.all(texts.map((text) => fresh(text)));
    for (const [first, { tail }] of firsts.entries()) {
      let known = tail;
      for (let next = first + 1; next < texts.length; next += 1) {
        const data = Buffer.from(texts[next] as string);
        known = (await readOnwards(openBytes(data).file, data.byteLength, known)) as Tail;
        expect(viewOf(known, data.byteLength)).toEqual(firsts[next]?.view);
        expect(known.started).toEqual(firsts[next]?.tail.started);
      }
    }
    const view = firsts.at(-1)?.view as TailView;
    return view.state === "ok" ? view.approvals : view.state;
  }

  /** Where each line of `lines` begins after `from`. */
  const startsOf = (lines: readonly string[], from = start) =>
    lines.map((_, index) => Buffer.byteLength(from + lines.slice(0, index).join("")));

  /** An approval that waits, whose line begins there, with a prompt or a reply after it or none. */
  const waits = (at: number | undefined, asked: number | null = AT, replied = false) => ({
    start: at,
    at: asked,
    replied,
  });

  const request = approvalRequest(AT);
  const second = approvalRequest(AT + 1_000, { callId: "call-2" });
  /** A tool a command of the bash call runs, which asks with an ID of its own and no parent. */
  const command = approvalRequest(AT, { callId: "call-1:cmd:0", toolName: "mcp__x" });
  /** One that code in a cell of the eval tool calls, which asks with the eval's call as its parent. */
  const nested = approvalRequest(AT, { callId: "call-9", parentId: "call-1" });

  test("a file from before Oh My Pi 19.1.0, with neither line, has none, and is read once with no start since its newest reply", async () => {
    expect(await approvalsIn([])).toEqual(NO_APPROVALS);
    expect(
      await approvalsIn([message("toolResult"), toolStart("bash"), passedLines(), "garbage\n"]),
    ).toEqual(NO_APPROVALS);
    const data = Buffer.from(start + passedOf(3 * PIECE_BYTES) + message("assistant"));
    const { file, reads } = openBytes(data);
    await readFromEnd(file, data.byteLength);
    expect(total(reads)).toBeLessThanOrEqual(data.byteLength);
    // With one, the lines from that reply on are read once more.
    const more = Buffer.concat([data, Buffer.from(toolStart("bash"))]);
    const since = Buffer.byteLength(message("assistant") + toolStart("bash"));
    const again = openBytes(more);
    expect((await readFromEnd(again.file, more.byteLength)).started).toEqual([CALL]);
    expect(total(again.reads)).toBeLessThanOrEqual(more.byteLength + since + 1);
  });

  test("a request with nothing after it that ends it waits, and changes no line that decides", async () => {
    const { view } = await fresh(start + request);
    expect(view).toEqual({
      state: "ok",
      newest: { sort: "tool" },
      behind: null,
      cutOff: null,
      approvals: { open: [waits(Buffer.byteLength(start))], unsure: null },
    });
  });

  test("lines that are no end of it leave it waiting", async () => {
    for (const other of [
      toolStart("bash", AT, { callId: "call-2" }),
      toolStart("ask", AT, { callId: "call-2" }),
      // Its own start can be added after it.
      toolStart("bash", AT),
      passedLines(),
      message("bashExecution"),
      message("toolResult", { callId: "call-2" }),
      message("toolResult", { callId: "call-12" }),
      approvalEnd(AT, { callId: "call-2" }),
      approvalRequest(AT, { callId: "call-2" }) + approvalEnd(AT, { callId: "call-2" }),
    ]) {
      expect(await approvalsIn([request, other])).toEqual({
        open: [waits(Buffer.byteLength(start))],
        unsure: null,
      });
    }
  });

  test("a line that cannot be read, of a kind that ends none, leaves it waiting", async () => {
    for (const other of [
      toolStart("bash", AT, { callId: "c".repeat(600) }),
      toolStart("ask", AT).replace(iso(AT), "soon"),
      custom("k".repeat(60), { x: 1 }),
      custom("k".repeat(70), { x: 1 }),
    ]) {
      expect(await approvalsIn([request, other])).toEqual({
        open: [waits(Buffer.byteLength(start))],
        unsure: null,
      });
      expect(await approvalsIn([request, other, approvalEnd(AT)])).toEqual(NO_APPROVALS);
    }
  });

  test("its end, approved or not, ends it", async () => {
    for (const approved of [true, false]) {
      expect(await approvalsIn([request, approvalEnd(AT, { approved })])).toEqual(NO_APPROVALS);
    }
  });

  test("a result for its call ends it, as a resumed session's repair writes", async () => {
    expect(await approvalsIn([request, message("toolResult")])).toEqual(NO_APPROVALS);
  });

  test("a result for the call that dispatched it ends it, and that call's own approval does not", async () => {
    expect(await approvalsIn([nested, message("toolResult")])).toEqual(NO_APPROVALS);
    expect(await approvalsIn([nested, message("toolResult", { callId: "call-9" })])).toEqual(
      NO_APPROVALS,
    );
    expect(await approvalsIn([nested, approvalEnd(AT)])).toEqual({
      open: [waits(Buffer.byteLength(start))],
      unsure: null,
    });
  });

  test("one a command run in the background asks for waits on, whatever prompt or reply follows", async () => {
    const result = message("toolResult");
    for (const [lines, asked] of [
      // As its bash call's result is written while its prompt is open, or its request after that result.
      [[command, result], 0],
      [[result, command], 1],
    ] as const) {
      for (const next of [
        message("assistant"),
        refusal(),
        message("developer"),
        message("user"),
        message("assistant") + toolStart("read", AT, { callId: "call-2" }),
        message("user") + message("assistant") + message("user") + message("assistant"),
      ]) {
        const open = waits(startsOf(lines)[asked], AT, true);
        expect(await approvalsIn([...lines, next])).toEqual({ open: [open], unsure: null });
        expect(
          await approvalsIn([...lines, next, message("toolResult", { callId: "call-2" })]),
        ).toEqual({ open: [open], unsure: null });
        const ended = approvalEnd(AT, { callId: "call-1:cmd:0" });
        expect(await approvalsIn([...lines, next, ended])).toEqual(NO_APPROVALS);
      }
    }
  });

  test("one a command asks for in a bash call an eval made waits on past the eval's result", async () => {
    const inEval = (callId: string) => approvalRequest(AT, { callId, parentId: "call-1" });
    for (const callId of ["js-bash-1:cmd:0", "js-bash-1:cmd:12"]) {
      const lines = [inEval(callId), message("toolResult")];
      const open = waits(startsOf(lines)[0]);
      expect(await approvalsIn(lines)).toEqual({ open: [open], unsure: null });
      expect(await approvalsIn([...lines, message("assistant")])).toEqual({
        open: [{ ...open, replied: true }],
        unsure: null,
      });
      expect(await approvalsIn([...lines, approvalEnd(AT, { callId })])).toEqual(NO_APPROVALS);
      expect(await approvalsIn([...lines, sessionExit("normal", AT)])).toEqual(NO_APPROVALS);
      // A crash leaves the eval with no result.
      expect(await approvalsIn([inEval(callId), message("assistant")])).toEqual(NO_APPROVALS);
    }
    // An ID that is not a command's, as any other call an eval made has.
    for (const callId of ["js-read-1", "js:cmd:", ":cmd:0", "js-bash-1:cmd:0x", "js-bash-1:cm:0"]) {
      expect(await approvalsIn([inEval(callId), message("toolResult")])).toEqual(NO_APPROVALS);
    }
  });

  test("one an eval in the background asks for, after the eval's result, waits on too", async () => {
    const lines = [message("toolResult"), nested];
    expect(await approvalsIn([...lines, message("assistant")])).toEqual({
      open: [waits(startsOf(lines)[1], AT, true)],
      unsure: null,
    });
    // And after a reply since, though the eval was started before it.
    const later = [message("toolResult"), message("assistant"), nested];
    expect(await approvalsIn([...later, message("assistant")])).toEqual({
      open: [waits(startsOf(later)[2], AT, true)],
      unsure: null,
    });
    // One code the person runs asks for has no call that dispatched it.
    const own = approvalRequest(AT, { callId: "js-read-1" });
    expect(await approvalsIn([own, message("user"), message("assistant")])).toEqual({
      open: [waits(Buffer.byteLength(start), AT, true)],
      unsure: null,
    });
  });

  test("a reply ends one whose call, or the call that dispatched it, was started and has no result, as a crash leaves it", async () => {
    for (const asked of [request, nested]) {
      for (const reply of [message("assistant"), refusal()]) {
        expect(await approvalsIn([asked, reply])).toEqual(NO_APPROVALS);
        // The prompt a resumed session goes on with does not.
        expect(await approvalsIn([asked, message("user")])).toEqual({
          open: [waits(Buffer.byteLength(start), AT, true)],
          unsure: null,
        });
        expect(await approvalsIn([asked, message("user"), reply])).toEqual(NO_APPROVALS);
        expect(
          await approvalsIn([asked, message("toolResult", { callId: "call-2" }), reply]),
        ).toEqual(NO_APPROVALS);
      }
    }
    // Its start can come after its request.
    const bare = sessionText(message("user") + message("assistant"));
    expect(await approvalsIn([request, toolStart("bash", AT), message("assistant")], bare)).toEqual(
      NO_APPROVALS,
    );
    // A call started before the last reply is not one of these.
    const lines = [message("assistant"), request, message("assistant")];
    expect(await approvalsIn(lines)).toEqual({
      open: [waits(startsOf(lines)[1], AT, true)],
      unsure: null,
    });
  });

  test("a call an ask, or an approved call, dispatched is ended by a reply as any started call's is", async () => {
    const bare = sessionText(message("user") + message("assistant"));
    expect(await approvalsIn([toolStart("ask", AT), nested, message("assistant")], bare)).toEqual(
      NO_APPROVALS,
    );
    // Its own approval's end is not its result.
    expect(await approvalsIn([request, approvalEnd(AT), nested, message("assistant")])).toEqual(
      NO_APPROVALS,
    );
    // Nor is a line that cannot be read.
    expect(await approvalsIn([request, "garbage\n", nested, message("assistant")])).toEqual(
      NO_APPROVALS,
    );
  });

  test("of the calls started since the newest reply, the newest 64 are kept, however it is read", async () => {
    expect(MAX_STARTED_CALLS).toBe(64);
    const bare = sessionText(message("user") + message("assistant"));
    const starts = Array.from({ length: 65 }, (_, index) =>
      toolStart("bash", AT, { callId: `call-${index}` }),
    );
    const oldest = approvalRequest(AT, { callId: "call-0" });
    const next = approvalRequest(AT, { callId: "call-1" });
    const newest = approvalRequest(AT, { callId: "call-64" });
    const asked = [starts.join(""), oldest, next, newest];
    // Which the reply ends, with every start read before the first request, or the last call's result too.
    for (const lines of [
      asked,
      [starts.join(""), message("toolResult", { callId: "call-64" }), oldest, next],
    ]) {
      const at = startsOf(lines, bare)[lines.indexOf(oldest)];
      expect(await approvalsIn([...lines, message("assistant")], bare)).toEqual({
        open: [waits(at, AT, true)],
        unsure: null,
      });
    }
  });

  test("a first read compares each call with no more than those it keeps, however many started since the newest reply", async () => {
    const lines: string[] = [message("assistant")];
    for (let index = 0; index < 20_000; index += 1) {
      const callId = `call-${index}`;
      lines.push(toolStart("bash", AT, { callId }));
      if (index % 2 === 0) lines.push(message("toolResult", { callId, runtime: false }));
    }
    const data = Buffer.from(sessionText(lines.join("")));
    const { file } = openBytes(data);
    /** How many IDs were compared: `equals` is what an ID is compared with another by. */
    let compared = 0;
    const { equals } = Buffer.prototype;
    Buffer.prototype.equals = function (other: Uint8Array) {
      compared += 1;
      return equals.call(this, other);
    };
    try {
      expect((await readFromEnd(file, data.byteLength)).started).toHaveLength(MAX_STARTED_CALLS);
    } finally {
      Buffer.prototype.equals = equals;
    }
    expect(compared).toBeLessThan(3 * MAX_STARTED_CALLS * lines.length);
  });

  test("an exit ends every one, and one asked for after it waits", async () => {
    for (const kind of ["normal", "signal", "fatal", "process_exit"] as const) {
      const exit = sessionExit(kind, AT);
      const before = [command, message("toolResult"), message("assistant"), request, second];
      expect(await approvalsIn([...before, exit])).toEqual(NO_APPROVALS);
      expect(await approvalsIn([...before, exit, message("user")])).toEqual(NO_APPROVALS);
      const lines = [...before, exit, second];
      expect(await approvalsIn(lines)).toEqual({
        open: [waits(startsOf(lines).at(-1), AT + 1_000)],
        unsure: null,
      });
    }
  });

  test("of several at once, each waits until its own end", async () => {
    const lines = [request, second];
    const [first, other] = startsOf(lines);
    const both = [waits(first), waits(other, AT + 1_000)];
    expect(await approvalsIn(lines)).toEqual({ open: both, unsure: null });
    expect(await approvalsIn([...lines, approvalEnd(AT)])).toEqual({
      open: [both[1]],
      unsure: null,
    });
    expect(await approvalsIn([...lines, approvalEnd(AT, { callId: "call-2" })])).toEqual({
      open: [both[0]],
      unsure: null,
    });
    // Results come in the order the reply named the calls, so an earlier call's can come while a later waits.
    expect(await approvalsIn([...lines, approvalEnd(AT), message("toolResult")])).toEqual({
      open: [both[1]],
      unsure: null,
    });
    expect(
      await approvalsIn([...lines, approvalEnd(AT), message("toolResult", { callId: "call-2" })]),
    ).toEqual(NO_APPROVALS);
  });

  test("a call asked for again takes the place of its earlier request", async () => {
    const lines = [request, approvalRequest(AT + 5_000)];
    expect(await approvalsIn(lines)).toEqual({
      open: [waits(startsOf(lines)[1], AT + 5_000)],
      unsure: null,
    });
    expect(await approvalsIn([...lines, approvalEnd(AT + 6_000)])).toEqual(NO_APPROVALS);
  });

  test("a line that could end one and cannot be read leaves none known to wait, until the next prompt, reply or exit", async () => {
    const unsure = { open: [], unsure: "unread" };
    for (const bad of [
      "garbage\n",
      message("someone"),
      approvalEnd(AT, { callId: "c".repeat(600) }),
      message("toolResult", { callId: "c".repeat(600) }),
    ]) {
      expect(await approvalsIn([request, bad])).toEqual(unsure);
      expect(await approvalsIn([request, bad, toolStart("bash")])).toEqual(unsure);
      expect(await approvalsIn([request, bad, message("toolResult")])).toEqual(unsure);
      // With none waiting it could end nothing.
      expect(await approvalsIn([request, approvalEnd(AT), bad])).toEqual(NO_APPROVALS);
      // One asked for after it waits.
      const lines = [request, bad, second];
      expect(await approvalsIn(lines)).toEqual({
        open: [waits(startsOf(lines)[2], AT + 1_000)],
        unsure: "unread",
      });
      // One from before the newest reply is not kept either, and holds up no turn.
      const earlier = [command, message("toolResult"), message("assistant"), bad];
      expect(await approvalsIn([...earlier, toolStart("bash")])).toEqual(NO_APPROVALS);
      for (const end of [message("user"), message("assistant"), sessionExit("normal", AT)]) {
        expect(await approvalsIn([request, bad, end])).toEqual(NO_APPROVALS);
      }
      // One of the turn's own among others from before it could be the one that ended.
      const next = toolStart("bash", AT, { callId: "call-2" });
      const before = [command, message("toolResult"), message("assistant"), next];
      expect(await approvalsIn([...before, second, bad])).toEqual(unsure);
      // A request of the turn's that could not be read is still not known to have ended.
      const unread = approvalRequest(AT, { callId: "call-2" }).replace('"toolName"', '"name"');
      expect(await approvalsIn([...before, unread, bad, toolStart("read")])).toEqual(unsure);
    }
  });

  test("a request that cannot be read could be one, and the others still wait", async () => {
    const bad = approvalRequest(AT).replace('"toolName"', '"name"');
    expect(await approvalsIn([bad])).toEqual({ open: [], unsure: "unread" });
    expect(await approvalsIn([request, bad])).toEqual({
      open: [waits(Buffer.byteLength(start))],
      unsure: "unread",
    });
    expect(await approvalsIn([bad, message("assistant")])).toEqual(NO_APPROVALS);
  });

  test("a request and an end after an exit change neither the exit behind nor the one cut off", async () => {
    const exit = { sort: "exit", fatal: false, at: AT };
    const quit = sessionText(
      message("user") +
        toolStart("bash") +
        request +
        sessionExit("normal", AT) +
        approvalEnd(AT, { approved: false }) +
        message("toolResult") +
        message("assistant"),
    );
    expect((await fresh(quit)).view).toEqual({
      state: "ok",
      newest: { sort: "reply", at: AT },
      behind: exit,
      cutOff: exit,
      approvals: NO_APPROVALS,
    });
    const dispatched = sessionText(
      sessionExit("normal", AT) + approvalRequest(AT, { callId: "call-9", parentId: "call-1" }),
    );
    expect((await fresh(dispatched)).view).toMatchObject({ newest: exit, behind: null });
  });

  test("a file with no line that decides is shown while an approval waits in it", async () => {
    const empty = sessionText("");
    expect(await approvalsIn([], empty)).toBe("none");
    const { view } = await fresh(empty + request);
    expect(view).toEqual({
      state: "ok",
      newest: null,
      behind: null,
      cutOff: null,
      approvals: { open: [waits(Buffer.byteLength(empty))], unsure: null },
    });
    expect(await approvalsIn([request, approvalEnd(AT)], empty)).toBe("none");
  });

  test("keeps the newest of more than 64 at once, and whether another waits is then not known", async () => {
    expect(MAX_OPEN_APPROVALS).toBe(64);
    const many = Array.from({ length: MAX_OPEN_APPROVALS + 1 }, (_, index) =>
      approvalRequest(AT + index, { callId: `call-${index}` }),
    );
    const { tail, view } = await fresh(start + many.join(""));
    expect(tail.open).toHaveLength(MAX_OPEN_APPROVALS);
    expect(tail.open[0]?.at).toBe(AT + 1);
    expect(view).toMatchObject({ approvals: { unsure: "too-many" } });
    expect(await approvalsIn([many.slice(1).join("")])).toMatchObject({ unsure: null });
    const ends = many.slice(1).map((_, index) => approvalEnd(AT, { callId: `call-${index + 1}` }));
    expect(await approvalsIn([many.join(""), ends.join("")])).toEqual({
      open: [],
      unsure: "too-many",
    });
    // Until the next prompt or reply, and not for one asked before it, which holds up no turn.
    for (const turn of [message("user"), message("assistant")]) {
      expect(await approvalsIn([many.join(""), ends.join(""), turn])).toEqual(NO_APPROVALS);
      const [first, ...rest] = many as [string, ...string[]];
      expect(await approvalsIn([message("toolResult"), first, turn, rest.join("")])).toMatchObject({
        unsure: null,
      });
    }
  });

  test("reads a request and its end across a 64 KiB piece's edge, a piece at a time, at most twice over", async () => {
    const before = start + passedOf(PIECE_BYTES - Buffer.byteLength(start) - 10);
    const open = Buffer.from(before + request + passedOf(2 * PIECE_BYTES));
    const { file, reads } = openBytes(open);
    const tail = await readFromEnd(file, open.byteLength);
    expect(viewOf(tail, open.byteLength)).toMatchObject({
      approvals: { open: [waits(Buffer.byteLength(before))], unsure: null },
    });
    expect(Math.max(...reads.map(({ length }) => length))).toBeLessThanOrEqual(PIECE_BYTES);
    expect(total(reads)).toBeLessThanOrEqual(2 * open.byteLength + 1);
    expect((await fresh(Buffer.concat([open, Buffer.from(approvalEnd(AT))]))).view).toMatchObject({
      approvals: NO_APPROVALS,
    });
  });

  test("reads no further back than the newest exit, and once only with no request since", async () => {
    const before = sessionText(
      message("assistant") + command + passedOf(3 * PIECE_BYTES) + sessionExit("normal", AT),
    );
    const turn =
      message("user") + toolStart("bash") + passedOf(3 * PIECE_BYTES) + message("assistant");
    const without = Buffer.from(before + turn);
    const once = openBytes(without);
    const tail = await readFromEnd(once.file, without.byteLength);
    expect(tail).toMatchObject({ open: [], whole: true });
    expect(total(once.reads)).toBeLessThanOrEqual(Buffer.byteLength(turn) + PIECE_BYTES);
    // With one, the lines from the reply before it on are read once more.
    const since = message("assistant") + toolStart("bash") + request;
    const asked = Buffer.from(before + turn + since);
    const twice = openBytes(asked);
    expect((await readFromEnd(twice.file, asked.byteLength)).open).toHaveLength(1);
    expect(total(twice.reads)).toBeLessThanOrEqual(
      Buffer.byteLength(turn + since) + PIECE_BYTES + Buffer.byteLength(since) + 1,
    );
  });

  test("with no look further back than its turn, an earlier turn's is not seen, and it is not read on from there", async () => {
    const since = message("assistant") + toolStart("bash");
    const text = Buffer.from(
      start +
        command +
        message("toolResult") +
        message("assistant") +
        passedOf(3 * PIECE_BYTES) +
        message("user") +
        since,
    );
    const { file, reads } = openBytes(text);
    const near = await readFromEnd(file, text.byteLength, false);
    expect(total(reads)).toBeLessThanOrEqual(PIECE_BYTES + Buffer.byteLength(since) + 1);
    expect(near).toMatchObject({ newest: { sort: "tool" }, open: [], whole: false });
    expect(await readOnwards(openBytes(text).file, text.byteLength, near)).toBeNull();
    expect((await fresh(text)).tail).toMatchObject({ open: [{ at: AT }], whole: true });
    // One of the turn's own is seen, and so is one after an exit that could decide.
    const own = Buffer.from(
      start + message("user") + message("assistant") + toolStart("bash") + request,
    );
    expect(await readFromEnd(openBytes(own).file, own.byteLength, false)).toMatchObject({
      open: [{ at: AT }],
      whole: false,
    });
    const exited = Buffer.from(
      sessionText(sessionExit("normal", AT) + command + message("assistant")),
    );
    expect(await readFromEnd(openBytes(exited).file, exited.byteLength, false)).toMatchObject({
      behind: { sort: "exit" },
      open: [{ at: AT }],
      whole: true,
    });
  });

  /** Every ID a tail keeps. */
  const keptIn = (tail: Tail) => [
    ...tail.open.flatMap(({ call, parent }) => [call, ...(parent === null ? [] : [parent])]),
    ...tail.started,
  ];

  /** Every text and every run of bytes in a value, however deep, the bytes with all the memory they are part of. */
  function textIn(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (value instanceof Uint8Array) return [Buffer.from(value.buffer).toString("latin1")];
    if (typeof value !== "object" || value === null) return [];
    return Object.values(value).flatMap(textIn);
  }

  test("keeps no text, and of the bytes only the IDs of the calls that wait, of those that dispatched them and of those that run", async () => {
    const { tail } = await fresh(start + nested);
    expect(tail.open).toEqual([
      {
        start: Buffer.byteLength(start),
        at: AT,
        call: Buffer.from("call-9"),
        parent: CALL,
        turn: Buffer.byteLength(sessionText(message("user"))),
      },
    ]);
    expect(tail.started).toEqual([CALL]);
    const lines = start + nested + message("toolResult", { callId: "call-8" });
    const onward = await onwards(Buffer.from(start + nested), Buffer.from(lines));
    const first = (await fresh(lines)).tail;
    for (const [kept, newest] of [
      [tail, "tool"],
      [onward, "result"],
      [first, "result"],
    ] as const) {
      // Nothing beside what is named, and no text or byte of a line but those IDs and the newest line's sort.
      expect(Object.keys(kept as Tail).sort()).toEqual([
        "behind",
        "behindStart",
        "crowded",
        "cutOff",
        "cutOffStart",
        "end",
        "newest",
        "newestStart",
        "open",
        "replyStart",
        "started",
        "turnStart",
        "unread",
        "whole",
      ]);
      expect(textIn(kept).sort()).toEqual(["call-1", "call-1", "call-9", newest].sort());
    }
    for (const end of [message("toolResult"), message("assistant"), sessionExit("normal", AT)]) {
      const ended = await fresh(start + nested + end);
      expect(keptIn(ended.tail)).toEqual([]);
      const data = Buffer.from(start + nested + end);
      const onward = await readOnwards(openBytes(data).file, data.byteLength, tail);
      expect(keptIn(onward as Tail)).toEqual([]);
    }
    // At most 64 of those that run.
    const starts = Array.from({ length: MAX_STARTED_CALLS + 1 }, (_, index) =>
      toolStart("bash", AT, { callId: `call-${index}` }),
    ).join("");
    const many = await fresh(sessionText(message("assistant") + starts));
    expect(many.tail.started).toHaveLength(MAX_STARTED_CALLS);
    const on = await onwards(
      Buffer.from(sessionText(message("assistant"))),
      Buffer.from(sessionText(message("assistant")) + starts),
    );
    expect(on?.started).toHaveLength(MAX_STARTED_CALLS);
  });

  test("keeps each ID in memory of its own, with none of the bytes read beside it", async () => {
    const copy = ownCopy(CALL);
    expect(copy).toEqual(CALL);
    expect(copy.buffer.byteLength).toBe(CALL.byteLength);
    // As a file read keeps it, each piece in memory of its own, and as one line's first bytes are joined.
    for (const tail of [
      (await fresh(start + nested)).tail,
      await onwards(Buffer.from(start), Buffer.from(start + nested)),
      await onwards(Buffer.from(sessionText("")), Buffer.from(start + nested)),
    ]) {
      const kept = keptIn(tail as Tail);
      expect(kept).toHaveLength(3);
      for (const id of kept) {
        expect(id.buffer.byteLength).toBe(id.byteLength);
        const beside = Buffer.from(id.buffer).toString("latin1");
        for (const word of [PRIVATE_REASON, PRIVATE_PROMPT, PRIVATE_REPLY]) {
          expect(beside).not.toContain(word);
        }
      }
    }
  });

  describe("more than 8 MiB back", () => {
    const lead = message("assistant") + toolStart("bash", AT);
    const result = message("toolResult", { callId: "call-2" });

    /** What these lines say read afresh, and read on from the first of them, which must agree. */
    async function both(first: string, ...added: string[]) {
      let text = Buffer.from(first);
      let known = (await fresh(text)).tail;
      for (const step of added) {
        text = Buffer.concat([text, Buffer.from(step)]);
        known = (await readOnwards(openBytes(text).file, text.byteLength, known)) as Tail;
      }
      const { view } = await fresh(text);
      expect(viewOf(known, text.byteLength)).toEqual(view);
      return view;
    }

    const half = passedOf(MAX_TAIL_BYTES / 2);

    test("a request there could wait, so none is known to and none is ruled out", async () => {
      expect(await both(sessionText(lead + request), half, half, result)).toEqual({
        state: "ok",
        newest: { sort: "result", at: AT },
        behind: null,
        cutOff: null,
        approvals: { open: [], unsure: "too-far" },
      });
    });

    test("with no request there either, as from before 19.1.0, that is not known", async () => {
      expect(await both(sessionText(lead), half, half, result)).toMatchObject({
        approvals: { open: [], unsure: "too-far" },
      });
    });

    test("one within it, with no end after it, waits, whatever came before", async () => {
      const first = sessionText(lead + approvalRequest(AT, { callId: "call-5" }));
      const view = await both(first, half, half, result, second);
      expect(view).toMatchObject({
        newest: { sort: "result" },
        approvals: { open: [{ at: AT + 1_000 }], unsure: "too-far" },
      });
      // Even when no line that decides is in reach.
      expect(await both(first, half, half, second)).toMatchObject({
        state: "ok",
        newest: null,
        approvals: { open: [{ at: AT + 1_000 }], unsure: "too-far" },
      });
    });

    test("an end within it of a request there leaves the rest not known", async () => {
      expect(
        await both(sessionText(lead + request), half, half, approvalEnd(AT), result),
      ).toMatchObject({
        approvals: { open: [], unsure: "too-far" },
      });
      expect(
        await both(sessionText(lead + request), half, half, second, "garbage\n", result),
      ).toMatchObject({ approvals: { open: [], unsure: "too-far" } });
    });

    test("one from an earlier turn there is not seen, and holds up no turn", async () => {
      const earlier = sessionText(lead + command + message("toolResult") + message("assistant"));
      const turn = message("assistant") + toolStart("bash");
      expect(await both(earlier, half, half, turn)).toMatchObject({
        newest: { sort: "tool" },
        approvals: NO_APPROVALS,
      });
      // One in reach is, until it is pushed past it.
      const within = await both(earlier, half, turn);
      expect(within).toMatchObject({
        approvals: { open: [{ at: AT, replied: true }], unsure: null },
      });
    });

    test("one whose call's start is there, with the one before it, is not seen once a reply follows", async () => {
      // Whether a reply ends it depends on a start that is not read.
      const first = sessionText(lead);
      const rest = [request, toolStart("read", AT, { callId: "call-3" })];
      expect(await both(first, half, half, ...rest)).toMatchObject({
        approvals: { open: [{ at: AT, replied: false }], unsure: "too-far" },
      });
      for (const asked of [request, command]) {
        expect(
          await both(first, half, half, asked, message("assistant"), toolStart("read")),
        ).toMatchObject({ approvals: NO_APPROVALS });
        // A prompt ends none, whatever came before.
        expect(await both(first, half, half, asked, message("user"))).toMatchObject({
          approvals: { open: [{ at: AT, replied: true }], unsure: null },
        });
      }
    });

    test("one exactly 8 MiB back is in reach, and a byte further is not", async () => {
      const at = MAX_TAIL_BYTES - Buffer.byteLength(command);
      const turn = message("user") + toolStart("bash");
      const filler = passedOf(at - Buffer.byteLength(turn));
      const text = sessionText(message("user")) + command + filler + turn;
      expect((await fresh(text)).view).toMatchObject({
        approvals: { open: [{ at: AT, replied: true }], unsure: null },
      });
      expect(await both(sessionText(message("user")) + command, filler, turn)).toMatchObject({
        approvals: { open: [{ at: AT, replied: true }], unsure: null },
      });
      expect(
        await both(sessionText(message("user")) + command, filler.replace("xx", "xxx"), turn),
      ).toMatchObject({ approvals: NO_APPROVALS });
    });

    test("one whose turn begins at an exit within it, or at the start of a file of 8 MiB, is seen past a reply", async () => {
      const reply = message("assistant");
      const exited = await both(
        sessionText(lead),
        half,
        sessionExit("normal", AT) + request,
        half,
        reply,
      );
      expect(exited).toMatchObject({ approvals: { open: [{ at: AT, replied: true }] } });
      const first = sessionText("");
      const bytes = MAX_TAIL_BYTES - Buffer.byteLength(first + request + reply);
      expect(await both(first, request, passedOf(bytes), reply)).toMatchObject({
        approvals: { open: [{ at: AT, replied: true }], unsure: null },
      });
      expect(await both(first, request, passedOf(bytes + 1), reply)).toMatchObject({
        approvals: NO_APPROVALS,
      });
    });

    test("the next prompt or reply within it makes it known again", async () => {
      for (const end of [message("user"), message("assistant")]) {
        expect(
          await both(sessionText(lead + request), half, half, end, toolStart("bash")),
        ).toMatchObject({ newest: { sort: "tool" }, approvals: NO_APPROVALS });
      }
    });

    test("one whose call's start is there, with a prompt since that is not, is not seen once a reply follows", async () => {
      const prompt = message("user");
      expect(
        await both(sessionText(lead), half, prompt, half, request, message("assistant")),
      ).toMatchObject({ approvals: NO_APPROVALS });
    });

    test("the reply before it exactly 8 MiB back is in reach", async () => {
      const bytes = MAX_TAIL_BYTES - Buffer.byteLength(lead + request);
      const text = sessionText("") + lead + request + passedOf(bytes);
      expect((await fresh(text)).view).toMatchObject({
        approvals: { open: [{ at: AT }], unsure: null },
      });
    });
  });
});

describe("the fold", () => {
  const empty: Tail = {
    end: 0,
    newest: null,
    newestStart: 0,
    behind: null,
    behindStart: 0,
    cutOff: null,
    cutOffStart: 0,
    open: [],
    started: [],
    unread: false,
    crowded: false,
    turnStart: 0,
    replyStart: 0,
    whole: true,
  };
  const exit = { sort: "exit" as const, fatal: false, at: AT };

  test("a reply or a result keeps the exit behind and the exit cut off, or takes the newest exit as both", () => {
    const exited = foldLine(empty, exit, 10);
    const replied = foldLine(exited, { sort: "reply", at: AT }, 20);
    expect(replied).toMatchObject({
      newest: { sort: "reply", at: AT },
      behind: exit,
      behindStart: 10,
      cutOff: exit,
      cutOffStart: 10,
    });
    expect(foldLine(replied, { sort: "result", at: AT, call: CALL }, 30)).toMatchObject({
      behind: exit,
      behindStart: 10,
      cutOff: exit,
      cutOffStart: 10,
    });
  });

  test("a tool or an ask drops the exit behind and keeps the exit cut off, or takes the newest exit as it", () => {
    const replied = foldLine(foldLine(empty, exit, 10), { sort: "reply", at: AT }, 20);
    for (const start of [
      { sort: "tool", call: CALL },
      { sort: "ask", at: AT, call: CALL },
    ] as const) {
      const started = foldLine(replied, start, 30);
      expect(started).toMatchObject({ behind: null, cutOff: exit, cutOffStart: 10 });
      // Kept without its call, which only an approval is compared with.
      const { call, ...newest } = start;
      expect(started.newest).toEqual(newest);
      expect(started.started).toEqual([call]);
      // A reply or a result after it takes no exit behind back.
      expect(foldLine(started, { sort: "result", at: AT, call: CALL }, 40)).toMatchObject({
        behind: null,
        cutOff: exit,
        cutOffStart: 10,
      });
      expect(foldLine(foldLine(empty, exit, 10), start, 20)).toMatchObject({
        behind: null,
        cutOff: exit,
        cutOffStart: 10,
      });
    }
  });

  test("a prompt, a line that cannot be read or another exit drops both, and a line passed over changes nothing", () => {
    const replied = foldLine(foldLine(empty, exit, 10), { sort: "reply", at: AT }, 20);
    expect(foldLine(replied, { sort: "passed" }, 30)).toBe(replied);
    for (const other of [
      { sort: "prompt" },
      { sort: "unreadable" },
      { sort: "exit", fatal: true, at: AT },
    ] as const) {
      expect(foldLine(replied, other, 30)).toMatchObject({
        newest: other,
        behind: null,
        cutOff: null,
      });
    }
  });
});
