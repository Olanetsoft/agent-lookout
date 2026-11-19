import { describe, expect, test } from "vitest";

import {
  foldLine,
  judgeLine,
  LINE_HEAD_BYTES,
  MAX_TAIL_BYTES,
  PIECE_BYTES,
  readFromEnd,
  readOnwards,
  viewOf,
  type Tail,
} from "@collector/adapters/oh-my-pi/tail";
import type { OpenFile } from "@collector/files/readOnlyIo";
import { INSTANT } from "@collector/adapters/pi/sessionFile";
import {
  custom,
  iso,
  line,
  message,
  MINUTE,
  NOW,
  passedLines,
  PRIVATE_WORDS,
  refusal,
  sessionExit,
  sessionText,
  toolStart,
} from "@tests/fixtures/oh-my-pi/ohMyPi";
import { watchDecoding, watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";

const AT = NOW - MINUTE;

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

  test("the ask tool's start, with its time, and any other tool's", () => {
    expect(judge(toolStart("ask", AT))).toEqual({ sort: "ask", at: AT });
    expect(judge(toolStart("bash", AT))).toEqual({ sort: "tool" });
    expect(judge(toolStart("task", AT))).toEqual({ sort: "tool" });
    expect(judge(toolStart("asking", AT))).toEqual({ sort: "tool" });
    // An ask with no time after its name cannot be read.
    const noTime = custom("tool_execution_start", { toolCallId: "c", toolName: "ask" });
    expect(judge(noTime).sort).toBe("unreadable");
  });

  test("a call ID with escaped quotes is skipped as one string", () => {
    expect(judge(toolStart("ask", AT, { callId: 'call "one" \\ two' }))).toEqual({
      sort: "ask",
      at: AT,
    });
    // One longer than 512 bytes is not.
    expect(judge(toolStart("ask", AT, { callId: "c".repeat(600) })).sort).toBe("unreadable");
  });

  test("a provider's refusal is a reply with no time, since its line's time is after its data", () => {
    expect(judge(refusal())).toEqual({ sort: "reply", at: null });
    expect(watchDecoding(() => judge(refusal()))).toEqual([]);
  });

  test("each role of a message", () => {
    expect(judge(message("user"))).toEqual({ sort: "prompt" });
    expect(judge(message("developer"))).toEqual({ sort: "prompt" });
    expect(judge(message("toolResult"))).toEqual({ sort: "result", at: AT });
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
    expect(judge(message("toolResult", { at, runtime: false }))).toEqual({ sort: "result", at });
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
        expect(judge(text)).toEqual({ sort, at: null });
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
      });
    }
    // A newest tool or ask looks back too.
    expect((await fresh(sessionText(sessionExit("normal", AT) + toolStart("bash")))).view).toEqual({
      state: "ok",
      newest: { sort: "tool" },
      behind: null,
      cutOff: exit,
    });
    expect(
      (await fresh(sessionText(sessionExit("normal", AT) + toolStart("ask", AT)))).view,
    ).toEqual({ state: "ok", newest: { sort: "ask", at: AT }, behind: null, cutOff: exit });
    for (const stop of [message("user"), "garbage\n"]) {
      const text = sessionText(sessionExit("normal", AT) + stop + message("assistant"));
      expect((await fresh(text)).view).toEqual({
        state: "ok",
        newest: { sort: "reply", at: AT },
        behind: null,
        cutOff: null,
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
    });
  });

  test("looks through 8 MiB and the byte before them, no further, a piece at a time", async () => {
    const decides = toolStart("ask", AT);
    // The ask begins exactly 8 MiB from the end: in reach.
    const tailBytes = MAX_TAIL_BYTES - Buffer.byteLength(decides);
    const reached = Buffer.from(sessionText("") + decides + passedOf(tailBytes));
    const { file, reads } = openBytes(reached);
    const tail = await readFromEnd(file, reached.byteLength);
    expect(viewOf(tail, reached.byteLength)).toMatchObject({ newest: { sort: "ask" } });
    expect(Math.max(...reads.map(({ length }) => length))).toBeLessThanOrEqual(PIECE_BYTES);
    const read = reads.reduce((sum, { length }) => sum + length, 0);
    expect(read).toBeLessThanOrEqual(MAX_TAIL_BYTES + 1);
    // One byte more after it, and it is too far back.
    const past = Buffer.concat([reached, Buffer.from(passedOf(64))]);
    expect((await fresh(past)).view).toEqual({ state: "too-far" });
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
        sessionExit("signal", AT) +
        passedLines() +
        refusal() +
        message("assistant"),
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

describe("the fold", () => {
  const empty: Tail = {
    end: 0,
    newest: null,
    newestStart: 0,
    behind: null,
    behindStart: 0,
    cutOff: null,
    cutOffStart: 0,
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
    expect(foldLine(replied, { sort: "result", at: AT }, 30)).toMatchObject({
      behind: exit,
      behindStart: 10,
      cutOff: exit,
      cutOffStart: 10,
    });
  });

  test("a tool or an ask drops the exit behind and keeps the exit cut off, or takes the newest exit as it", () => {
    const replied = foldLine(foldLine(empty, exit, 10), { sort: "reply", at: AT }, 20);
    for (const start of [{ sort: "tool" }, { sort: "ask", at: AT }] as const) {
      const started = foldLine(replied, start, 30);
      expect(started).toMatchObject({ newest: start, behind: null, cutOff: exit, cutOffStart: 10 });
      // A reply or a result after it takes no exit behind back.
      expect(foldLine(started, { sort: "result", at: AT }, 40)).toMatchObject({
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
