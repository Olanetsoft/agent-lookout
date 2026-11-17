import { afterEach, describe, expect, test, vi } from "vitest";

import {
  crc32c,
  isSessionId,
  judgeLine,
  MAX_LINE_BYTES,
  readFirstLine,
} from "@collector/adapters/fx/logLines";
import {
  CHILD_ID,
  crc32cBitwise,
  firstLine,
  frame,
  ITEM_DATA,
  OTHER_ID,
  PRIVATE_WORDS,
  SESSION_ID,
  STARTED_AT,
  WORKSPACE,
} from "@tests/fixtures/fx/fx";

const bytes = (text: string) => Buffer.from(text, "utf8");
const judge = (text: string) => judgeLine(bytes(text), 0, Buffer.byteLength(text));
const first = (text: string, id = SESSION_ID) =>
  readFirstLine(bytes(text), Buffer.byteLength(text), id);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the checksum", () => {
  test("is fx's own CRC32C, by fx's check value (`log.zig:675`)", () => {
    expect(crc32c(bytes("123456789"))).toBe(0xe3069283);
  });

  test("agrees with a loop of its own, one bit at a time, over any bytes", () => {
    for (const text of ["", "a", PRIVATE_WORDS, firstLine(), "é中\n\u0000"]) {
      expect(crc32c(bytes(text)), text).toBe(crc32cBitwise(bytes(text)));
    }
  });

  test("reads only the bytes it is given", () => {
    const data = bytes("xx123456789yy");
    expect(crc32c(data, 2, 11)).toBe(0xe3069283);
  });
});

describe("a line counts only as fx's own reader counts it", () => {
  const good = frame({ seq: 4, ts: STARTED_AT, kind: "turn_committed" }, ',"turn":2');

  test("a whole line of fx's shape counts, with its seq and ts", () => {
    expect(judge(good)).toEqual({ seq: 4, ts: STARTED_AT, sort: "ended", failed: false });
  });

  test("a line whose checksum is not its own does not count", () => {
    expect(judge(frame({ seq: 4, ts: 1, kind: "item" }, ',"turn":1', "00000000"))).toBeNull();
    // Any byte changed is found.
    const changed = good.replace('"turn":2', '"turn":3');
    expect(judge(changed)).toBeNull();
  });

  test("uppercase digits, a short or long checksum, or no newline do not count", () => {
    const crc = good.slice(good.indexOf(',"crc":"') + 8, good.indexOf(',"crc":"') + 16);
    expect(judge(good.replace(crc, crc.toUpperCase()))).toEqual(
      crc === crc.toUpperCase() ? judge(good) : null,
    );
    expect(judge(good.replace(`"${crc}"`, `"${crc.slice(1)}"`))).toBeNull();
    expect(judge(good.replace(`"${crc}"`, `"${crc}0"`))).toBeNull();
    expect(judgeLine(bytes(good), 0, good.length - 1)).toBeNull();
  });

  test("a header out of fx's order, with a leading zero, a zero v or seq, or a bad kind, does not count", () => {
    for (const payload of [
      '{"seq":1,"v":1,"ts":0,"kind":"item"',
      '{"v":01,"seq":1,"ts":0,"kind":"item"',
      '{"v":1,"seq":01,"ts":0,"kind":"item"',
      '{"v":1,"seq":1,"ts":00,"kind":"item"',
      '{"v":0,"seq":1,"ts":0,"kind":"item"',
      '{"v":1,"seq":0,"ts":0,"kind":"item"',
      '{"v":1,"seq":1,"ts":0,"kind":""',
      '{"v":1,"seq":1,"ts":0,"kind":"Item"',
      '{"v":1,"seq":1,"ts":0,"kind":"abcdefghijklmnopqrstuvwxyzabcdefg"',
      ' {"v":1,"seq":1,"ts":0,"kind":"item"',
      '{"v":1,"seq":1,"ts":0,"kind":"item"x',
    ]) {
      const digits = crc32cBitwise(bytes(payload)).toString(16).padStart(8, "0");
      expect(judge(`${payload},"crc":"${digits}"}\n`), payload).toBeNull();
    }
  });

  test("a line longer than fx's cap does not count, nor one shorter than its frame", () => {
    const long = frame({ seq: 2, ts: 1, kind: "item" }, `,"data":"${"x".repeat(MAX_LINE_BYTES)}"`);
    expect(judge(long)).toBeNull();
    expect(judge('"}\n')).toBeNull();
  });

  test("ts may be 0, and a kind of 32 letters is read", () => {
    expect(judge(frame({ seq: 2, ts: 0, kind: "item" }, ',"turn":1'))).toMatchObject({ ts: 0 });
    expect(judge(frame({ seq: 2, ts: 0, kind: "a".repeat(32) }))).toMatchObject({ sort: "odd" });
  });
});

describe("what a line that counts says", () => {
  const at = (kind: string, body = "", v?: number) =>
    judge(frame({ v, seq: 5, ts: 9, kind }, body));

  test("a turn's start, or any item, is an open turn, and its data is never looked at", () => {
    expect(at("turn_started", ',"turn":3')).toMatchObject({ sort: "open" });
    expect(at("item", `,"turn":3,"type":"user","data":${ITEM_DATA}`)).toMatchObject({
      sort: "open",
    });
    // An item fx 0.0.17 could not write still says a turn is open: only its header is read.
    expect(at("item", ',"anything":1')).toMatchObject({ sort: "open" });
  });

  test("a commit ends a turn, and each interruption does, failed only for failed", () => {
    expect(at("turn_committed", ',"turn":3')).toMatchObject({ sort: "ended", failed: false });
    for (const reason of ["cancel", "closed", "crash"]) {
      expect(at("turn_interrupted", `,"turn":3,"reason":"${reason}"`), reason).toMatchObject({
        sort: "ended",
        failed: false,
      });
    }
    expect(at("turn_interrupted", ',"turn":3,"reason":"failed"')).toMatchObject({
      sort: "ended",
      failed: true,
    });
  });

  test("a turn line of any other shape is odd", () => {
    for (const [kind, body] of [
      ["turn_started", ""],
      ["turn_started", ',"turn":03'],
      ["turn_started", ',"turn":3,"extra":1'],
      ["turn_committed", ',"turn":"3"'],
      ["turn_interrupted", ',"turn":3'],
      ["turn_interrupted", ',"turn":3,"reason":"cancelled"'],
      ["turn_interrupted", ',"turn":3,"reason":"failed","more":1'],
      ["closed", ',"turn":3'],
    ]) {
      expect(at(kind, body), `${kind}${body}`).toMatchObject({ sort: "odd" });
    }
  });

  test("closed, the settings, snapshots, compactions and subagents' lines are read by their header", () => {
    expect(at("closed")).toMatchObject({ sort: "closed" });
    for (const kind of ["set", "snapshot", "compacted", "child_spawned", "child_finished"]) {
      expect(at(kind, `,"value":${JSON.stringify(PRIVATE_WORDS)}`), kind).toMatchObject({
        sort: "neutral",
      });
    }
  });

  test("a kind fx 0.0.17 does not write is odd, a first line is said to be one, and a higher v is newer", () => {
    expect(at("future_kind")).toMatchObject({ sort: "odd" });
    expect(at("session_created", ',"id":"x"')).toMatchObject({ sort: "created" });
    expect(at("turn_committed", ',"turn":3', 2)).toMatchObject({ sort: "newer" });
    expect(at("future_kind", "", 2)).toMatchObject({ sort: "newer" });
  });

  test("a header fx would write inside an item's data is not a line of its own", () => {
    // The fake header is a raw object inside `data`, as fx writes raw JSON.
    const fake = '{"v":1,"seq":99,"ts":1,"kind":"turn_committed","turn":1,"crc":"00000000"}';
    expect(at("item", `,"turn":1,"type":"tool_call","data":{"args":${fake}}`)).toMatchObject({
      seq: 5,
      sort: "open",
    });
  });
});

describe("the first line", () => {
  test("gives the id, the folder, the time, the role and where a fork's copied lines end", () => {
    expect(first(firstLine())).toEqual({
      id: SESSION_ID,
      cwd: WORKSPACE,
      ts: STARTED_AT,
      child: false,
      forkSeq: 0,
    });
    expect(first(firstLine({ forkedFrom: { id: OTHER_ID, seq: 7 } }))).toMatchObject({
      forkSeq: 7,
    });
    expect(
      first(
        firstLine({ id: CHILD_ID, role: "child", host: "child", parent: SESSION_ID }),
        CHILD_ID,
      ),
    ).toMatchObject({ child: true });
  });

  test("a child imported with another host is a child too", () => {
    expect(
      first(firstLine({ id: CHILD_ID, role: "child", host: "app", parent: SESSION_ID }), CHILD_ID),
    ).toMatchObject({ child: true });
  });

  test("another folder's id, another seq or kind, or a bad checksum is no first line", () => {
    expect(first(firstLine(), OTHER_ID)).toBeNull();
    expect(first(firstLine({ seq: 2 }))).toBeNull();
    expect(first(firstLine({ kind: "turn_started" }))).toBeNull();
    expect(first(firstLine({ role: "admin" }))).toBeNull();
    expect(first(firstLine({ host: "App" }))).toBeNull();
    expect(first(firstLine({ parent: ".hidden" }))).toBeNull();
    expect(first(firstLine().replace(/"crc":"[0-9a-f]{8}"/, '"crc":"00000000"'))).toBeNull();
    // fx's ids never need escaping, so one that does is not one.
    expect(first(firstLine({ id: 'a"b' }), 'a"b')).toBeNull();
  });

  test("a higher v, or a field fx 0.0.17 does not write, is a newer fx's", () => {
    expect(first(firstLine({ v: 2 }))).toBe("newer");
    expect(first(firstLine({ extra: ',"pid":123' }))).toBe("newer");
    expect(first(firstLine({ forkedFrom: { id: OTHER_ID, seq: 2 }, extra: ',"pid":1' }))).toBe(
      "newer",
    );
  });

  test("a field fx writes twice, or out of its order, is no first line", () => {
    expect(first(firstLine({ extra: ',"host":"app"' }))).toBeNull();
    const swapped = frame(
      { seq: 1, ts: STARTED_AT, kind: "session_created" },
      `,"workspace":"${WORKSPACE}","id":"${SESSION_ID}","role":"root","host":"app"`,
    );
    expect(first(swapped)).toBeNull();
  });

  test("a folder with a control character, or one that is not absolute, is no folder", () => {
    expect(first(firstLine({ workspace: "/Users/example/demo\u001bproject" }))).toMatchObject({
      cwd: null,
    });
    expect(first(firstLine({ workspace: "demo-project" }))).toMatchObject({ cwd: null });
    expect(first(firstLine({ workspace: "" }))).toMatchObject({ cwd: null });
    expect(first(firstLine({ workspace: `/${"a".repeat(4096)}` }))).toMatchObject({ cwd: null });
    expect(first(firstLine({ workspace: "/Users/example/café 中" }))).toMatchObject({
      cwd: "/Users/example/café 中",
    });
  });

  test("the folder is the one part of the line turned into text, once", () => {
    const line = bytes(firstLine());
    const toString = vi.spyOn(Buffer.prototype, "toString");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const parse = vi.spyOn(JSON, "parse");
    readFirstLine(line, line.byteLength, SESSION_ID);
    expect(toString).toHaveBeenCalledTimes(1);
    expect(toString.mock.contexts[0]).toEqual(bytes(JSON.stringify(WORKSPACE)));
    expect(decode).not.toHaveBeenCalled();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(JSON.stringify(WORKSPACE));
  });

  test("no other line is turned into text", () => {
    const toString = vi.spyOn(Buffer.prototype, "toString");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const parse = vi.spyOn(JSON, "parse");
    judge(frame({ seq: 2, ts: 1, kind: "item" }, `,"turn":1,"type":"user","data":${ITEM_DATA}`));
    judge(frame({ seq: 3, ts: 1, kind: "set" }, `,"key":"title","value":"${PRIVATE_WORDS}"`));
    judge(frame({ seq: 4, ts: 1, kind: "turn_interrupted" }, ',"turn":1,"reason":"failed"'));
    expect(toString).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("a session's id", () => {
  test("is a name fx gives a folder", () => {
    expect(isSessionId(SESSION_ID)).toBe(true);
    expect(isSessionId("1786460757753-1786460757753277000-ef75d8fd94fdab1")).toBe(true);
    expect(isSessionId("a".repeat(255))).toBe(true);
    for (const name of [
      "",
      ".tmp",
      ".trash",
      "index.jsonl",
      "index.lock",
      "a b",
      "a/b",
      "a".repeat(256),
    ]) {
      expect(isSessionId(name), name).toBe(false);
    }
  });
});
