import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createLogReader,
  MAX_HEAD_BYTES,
  MAX_TAIL_BYTES,
  PIECE_BYTES,
  type LogRead,
} from "@collector/adapters/fx/logFile";
import {
  CHILD_ID,
  frame,
  fxLog,
  logPath,
  NOW,
  OTHER_ID,
  SESSION_ID,
  STARTED_AT,
  WORKSPACE,
} from "@tests/fixtures/fx/fx";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/fx/fxAdapter";

const PATH = logPath(SESSION_ID);

afterEach(() => {
  vi.restoreAllMocks();
});

async function refOf(files: MemoryFiles, id = SESSION_ID) {
  const path = logPath(id);
  return { id, path, info: await files.io.lstat(path) };
}

/** What the reader says of the fixture's log. */
async function readOnce(files: MemoryFiles, reader = createLogReader(files.io), id = SESSION_ID) {
  return reader.read(await refOf(files, id));
}

const tailOf = (read: LogRead) => (read.state === "ok" ? read.log.tail : read.state);
const whyOf = (read: LogRead) => (read.state === "ok" ? read.log.why : read.state);

/** The same log, read whole at once, and read in two parts, the first part then what was added. */
async function bothWays(build: (log: ReturnType<typeof fxLog>) => number) {
  const log = fxLog();
  const mark = build(log);
  const whole = memoryFiles();
  whole.write(PATH, log.text());
  const backward = await readOnce(whole);

  const parts = memoryFiles();
  parts.write(PATH, log.lines.slice(0, mark).join(""), { mtimeMs: NOW - 10_000 });
  const reader = createLogReader(parts.io);
  await readOnce(parts, reader);
  parts.append(PATH, log.since(mark), { mtimeMs: NOW });
  const onward = await readOnce(parts, reader);
  return { backward, onward, reads: parts.reads };
}

describe("the last turn, read backwards", () => {
  test("an item says a turn is open, and its end says it ended", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().turnStarted().item().item().text());
    expect(tailOf(await readOnce(files))).toEqual({ turn: "open" });
    files.write(
      PATH,
      fxLog()
        .turnStarted()
        .item()
        .turnCommitted(NOW - 5)
        .text(),
    );
    expect(tailOf(await readOnce(files))).toEqual({ turn: "ended", failed: false, at: NOW - 5 });
  });

  test("a failed turn says so, and stays failed with closed after it", async () => {
    const files = memoryFiles();
    files.write(
      PATH,
      fxLog()
        .turnStarted()
        .turnInterrupted("failed", NOW - 7)
        .closed()
        .text(),
    );
    expect(tailOf(await readOnce(files))).toEqual({ turn: "ended", failed: true, at: NOW - 7 });
  });

  test("cancel, closed and crash end a turn, and none of them is a failure", async () => {
    for (const reason of ["cancel", "closed", "crash"] as const) {
      const files = memoryFiles();
      files.write(PATH, fxLog().turnStarted().item().turnInterrupted(reason, NOW).text());
      expect(tailOf(await readOnce(files)), reason).toEqual({
        turn: "ended",
        failed: false,
        at: NOW,
      });
    }
  });

  test("the first line alone, or the settings before a first turn, is no turn yet", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().text());
    expect(tailOf(await readOnce(files))).toEqual({ turn: "none" });
    files.write(PATH, fxLog().set("prefs", "{}").set("language", '"en"').text());
    expect(tailOf(await readOnce(files))).toEqual({ turn: "none" });
  });

  test("an open turn with closed after it, which fx never writes, is unknown", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().turnStarted().item().closed().text());
    const read = await readOnce(files);
    expect(tailOf(read)).toEqual({ turn: "unknown" });
    expect(whyOf(read)).toBe("unknown-end");
  });

  test("a line of a kind or a shape fx 0.0.17 does not write, after the last turn's end, is unknown", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().turnStarted().turnCommitted().raw("future_kind", "").text());
    expect(whyOf(await readOnce(files))).toBe("unknown-end");
    files.write(
      PATH,
      fxLog().turnStarted().turnCommitted().raw("turn_started", ',"turn":"x"').text(),
    );
    expect(whyOf(await readOnce(files))).toBe("unknown-end");
    files.write(
      PATH,
      fxLog().turnStarted().turnCommitted().raw("session_created", ',"id":"x"').text(),
    );
    expect(whyOf(await readOnce(files))).toBe("unknown-end");
  });

  test("a line of a newer format is unknown", async () => {
    const files = memoryFiles();
    files.write(
      PATH,
      fxLog().turnStarted().turnCommitted().raw("turn_started", ',"turn":2', NOW, 2).text(),
    );
    const read = await readOnce(files);
    expect(tailOf(read)).toEqual({ turn: "unknown" });
    expect(whyOf(read)).toBe("newer");
  });

  test("a turn's start more than 8 MiB back, followed by items, is an open turn", async () => {
    const files = memoryFiles();
    const log = fxLog().turnStarted();
    const big = JSON.stringify({ text: "x".repeat(1024 * 1024) });
    for (let i = 0; i < 9; i++) log.item(undefined, big);
    files.write(PATH, log.text());
    expect(files.io.lstat(PATH).then((info) => info.size)).resolves.toBeGreaterThan(MAX_TAIL_BYTES);
    expect(tailOf(await readOnce(files))).toEqual({ turn: "open" });
  });

  test("more than 8 MiB with no line that decides is unknown, read within the bounds", async () => {
    const files = memoryFiles();
    const log = fxLog().turnStarted().turnCommitted();
    const big = JSON.stringify("x".repeat(512 * 1024));
    for (let i = 0; i < 18; i++) log.set("usage", big);
    files.write(PATH, log.text());
    const read = await readOnce(files);
    expect(tailOf(read)).toEqual({ turn: "unknown" });
    expect(whyOf(read)).toBe("too-far");
    const [head, ...pieces] = files.reads;
    expect(head).toEqual({ path: PATH, position: 0, length: MAX_HEAD_BYTES });
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(PIECE_BYTES);
    expect(pieces.reduce((sum, piece) => sum + piece.length, 0)).toBeLessThanOrEqual(
      MAX_TAIL_BYTES,
    );
  });
});

describe("lines that do not count", () => {
  test("a last line still being written is passed over", async () => {
    const files = memoryFiles();
    const log = fxLog().turnStarted().turnCommitted();
    const half = frame({ seq: log.seq + 1, ts: NOW, kind: "turn_started" }, ',"turn":2').slice(
      0,
      20,
    );
    files.write(PATH, log.text() + half);
    expect(tailOf(await readOnce(files))).toMatchObject({ turn: "ended" });
  });

  test("a whole last line with a bad checksum is passed over, as fx cuts it", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().turnStarted().turnCommitted().bad().text());
    expect(tailOf(await readOnce(files))).toMatchObject({ turn: "ended" });
  });

  test("a bad line with a whole line after it is unknown", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().turnStarted().turnCommitted().bad().set("usage", "{}").text());
    expect(whyOf(await readOnce(files))).toBe("unknown-end");
  });

  test("a bad last line with a part of a line after it is unknown, as fx takes it for damage", async () => {
    const files = memoryFiles();
    files.write(PATH, `${fxLog().turnStarted().turnCommitted().bad().text()}{"v":1`);
    expect(whyOf(await readOnce(files))).toBe("unknown-end");
  });

  test("a gap in seq is unknown", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().turnStarted().turnCommitted().skip().set("usage", "{}").text());
    expect(whyOf(await readOnce(files))).toBe("unknown-end");
    // Back at the first line, the line after it must be the second.
    files.write(PATH, fxLog().skip().set("usage", "{}").text());
    expect(whyOf(await readOnce(files))).toBe("unknown-end");
  });
});

describe("a fork", () => {
  test("its lines copied from the other session say nothing of its own turns", async () => {
    const files = memoryFiles();
    // Lines 2 to 4 are the source's, the last a failed turn.
    const log = fxLog({ forkedFrom: { id: OTHER_ID, seq: 4 }, ts: NOW - 1_000 })
      .turnStarted(STARTED_AT - 10_000)
      .item()
      .turnInterrupted("failed");
    files.write(PATH, log.text());
    const read = await readOnce(files);
    expect(tailOf(read)).toEqual({ turn: "none" });
    // Its newest time is its own first line's, not the copied lines'.
    expect(read.state === "ok" && read.log.newestTs).toBe(NOW - 1_000);

    log.turnStarted(NOW).item();
    files.append(PATH, log.since(4), { mtimeMs: NOW + 1 });
    expect(tailOf(await readOnce(files))).toEqual({ turn: "open" });
  });
});

describe("the same log read whole and read in two parts says the same", () => {
  const cases: [string, (log: ReturnType<typeof fxLog>) => number][] = [
    ["an open turn", (log) => (log.turnStarted(), log.mark() + (log.item(), 0))],
    [
      "an end after an open turn",
      (log) => (log.turnStarted().item(), log.mark() + (log.turnCommitted(), 0)),
    ],
    [
      "a failure then closed",
      (log) => (log.turnStarted(), log.mark() + (log.turnInterrupted("failed").closed(), 0)),
    ],
    [
      "an item then closed with no end",
      (log) => (log.turnStarted().item(), log.mark() + (log.closed(), 0)),
    ],
    [
      "a kind it does not know after the end",
      (log) => (log.turnStarted().turnCommitted(), log.mark() + (log.raw("future_kind", ""), 0)),
    ],
    [
      "a newer line after the end",
      (log) => (log.turnStarted().turnCommitted(), log.mark() + (log.raw("set", "", NOW, 2), 0)),
    ],
    [
      "a turn line of another shape",
      (log) => (log.turnStarted(), log.mark() + (log.raw("turn_committed", ""), 0)),
    ],
    [
      "a first line's kind after the start",
      (log) => (
        log.turnStarted().turnCommitted(),
        log.mark() + (log.raw("session_created", ""), 0)
      ),
    ],
    [
      "a bad line then a setting",
      (log) => (log.turnStarted().turnCommitted(), log.mark() + (log.bad().set("usage", "{}"), 0)),
    ],
    ["a bad line then an item", (log) => (log.turnStarted(), log.mark() + (log.bad().item(), 0))],
    [
      "settings after an end",
      (log) => (
        log.turnStarted().turnCommitted(),
        log.mark() + (log.set("usage", "{}").snapshot(), 0)
      ),
    ],
    [
      "a gap in seq before a new turn",
      (log) => (
        log.turnStarted().turnCommitted(),
        log.mark() + (log.set("usage", "{}").skip().turnStarted(), 0)
      ),
    ],
    [
      "a gap in seq after a new turn",
      (log) => (log.turnStarted(), log.mark() + (log.item().skip().set("usage", "{}"), 0)),
    ],
    [
      "a new turn after an unknown end",
      (log) => (
        log.turnStarted().raw("future_kind", ""),
        log.mark() + (log.turnStarted().item(), 0)
      ),
    ],
  ];

  for (const [name, build] of cases) {
    test(name, async () => {
      const { backward, onward } = await bothWays(build);
      expect(onward).toEqual(backward);
    });
  }

  test("an unknown first read stays unknown while only neutral lines are added", async () => {
    const { backward, onward } = await bothWays(
      (log) => (
        log.turnStarted().raw("future_kind", ""),
        log.mark() + (log.set("usage", "{}").snapshot(), 0)
      ),
    );
    expect(tailOf(onward)).toEqual({ turn: "unknown" });
    expect(onward).toEqual(backward);
  });
});

describe("what is read of a log", () => {
  test("the first read takes the start once and the end backwards, then only what was added", async () => {
    const files = memoryFiles();
    const log = fxLog().turnStarted().item();
    files.write(PATH, log.text(), { mtimeMs: NOW - 1 });
    const reader = createLogReader(files.io);
    await readOnce(files, reader);
    const size = Buffer.byteLength(log.text());
    expect(files.reads[0]).toEqual({
      path: PATH,
      position: 0,
      length: Math.min(size, MAX_HEAD_BYTES),
    });
    expect(files.reads).toHaveLength(2);
    // The end is read backwards, down to the first line's end, and no further.
    const tail = files.reads[1];
    expect(tail.position).toBe(Buffer.byteLength(log.lines[0]));
    expect(tail.position + tail.length).toBe(size);

    files.forget();
    const mark = log.mark();
    log.item(undefined, JSON.stringify({ text: "y".repeat(100 * 1024) }));
    files.append(PATH, log.since(mark), { mtimeMs: NOW });
    expect(tailOf(await readOnce(files, reader))).toEqual({ turn: "open" });
    // One read of what was added, from the byte before it.
    expect(files.reads).toEqual([
      { path: PATH, position: size - 1, length: Buffer.byteLength(log.text()) - size + 1 },
    ]);
  });

  test("a log replaced between its lookup and its opening is not read, and is read on the next poll", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().turnStarted().text(), { mtimeMs: NOW - 1 });
    const reader = createLogReader(files.io);
    const ref = await refOf(files);
    files.write(PATH, fxLog().turnStarted().turnInterrupted("failed").text(), { mtimeMs: NOW });
    expect(await reader.read(ref)).toEqual({ state: "none" });
    expect(tailOf(await readOnce(files, reader))).toMatchObject({ turn: "ended", failed: true });
  });

  test("an unchanged log is not opened again, and a log is opened without following a link", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog().turnStarted().text());
    const reader = createLogReader(files.io);
    await readOnce(files, reader);
    files.forget();
    await readOnce(files, reader);
    expect(files.opened()).toEqual([]);

    files.special(PATH);
    expect(await readOnce(files, createLogReader(files.io))).toEqual({ state: "none" });
  });

  test("more than 8 MiB added is read from the end again", async () => {
    const files = memoryFiles();
    const log = fxLog().turnStarted().turnCommitted();
    files.write(PATH, log.text(), { mtimeMs: NOW - 1 });
    const reader = createLogReader(files.io);
    await readOnce(files, reader);
    files.forget();
    const mark = log.mark();
    const big = JSON.stringify({ text: "z".repeat(1024 * 1024) });
    log.turnStarted();
    for (let i = 0; i < 9; i++) log.item(undefined, big);
    files.append(PATH, log.since(mark), { mtimeMs: NOW });
    expect(tailOf(await readOnce(files, reader))).toEqual({ turn: "open" });
    for (const read of files.reads) expect(read.length).toBeLessThanOrEqual(PIECE_BYTES);
  });

  test("a log that shrank, is another file, does not go on with a newline or with the next seq is read from its end again", async () => {
    const base = fxLog().turnStarted().turnCommitted();
    for (const change of ["shrink", "replace", "no-newline", "seq"] as const) {
      const files = memoryFiles();
      files.write(PATH, base.text(), { mtimeMs: NOW - 1 });
      const reader = createLogReader(files.io);
      await readOnce(files, reader);
      files.forget();
      const next = fxLog().turnStarted().turnCommitted().turnStarted().item();
      if (change === "shrink") files.rewrite(PATH, fxLog().turnStarted().text(), { mtimeMs: NOW });
      if (change === "replace") files.write(PATH, next.text(), { mtimeMs: NOW });
      if (change === "no-newline") {
        // Rewritten in place: the last read ends inside a line now, followed by
        // a setting, which decides nothing.
        const [first, ...rest] = base.lines;
        const length = rest.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
        const value = "x".repeat(length);
        const set = frame({ seq: 2, ts: NOW, kind: "set" }, `,"key":"usage","value":"${value}"`);
        const after = frame({ seq: 3, ts: NOW, kind: "set" }, ',"key":"language","value":"en"');
        files.rewrite(PATH, first + set + after, { mtimeMs: NOW });
      }
      if (change === "seq") {
        // Rewritten in place: a line ends where the last read did, and the
        // line after it does not go on with the next seq.
        const [first, ...rest] = base.lines;
        const length = rest.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
        const empty = frame({ seq: 2, ts: NOW, kind: "set" }, ',"key":"usage","value":""');
        const value = "x".repeat(length - Buffer.byteLength(empty));
        const set = frame({ seq: 2, ts: NOW, kind: "set" }, `,"key":"usage","value":"${value}"`);
        const commit = frame({ seq: 3, ts: NOW, kind: "turn_committed" }, ',"turn":1');
        files.rewrite(PATH, first + set + commit, { mtimeMs: NOW });
      }
      const read = await readOnce(files, reader);
      // It says what a reader that never saw the file says.
      expect(read, change).toEqual(await readOnce(files, createLogReader(files.io)));
      // A read from the end again is in pieces that end at the file's end.
      const last = files.reads.at(-1)!;
      const size = (await files.io.lstat(PATH)).size;
      expect(last.position + last.length, change).toBe(size);
      expect(last.length, change).toBeLessThanOrEqual(PIECE_BYTES);
    }
  });

  test("a bad last line is passed over, then cut and written again as a crash of the same length: the crash is read", async () => {
    const files = memoryFiles();
    const log = fxLog().turnStarted().item();
    // fx opens the log again, cuts the line it was writing as it crashed and
    // writes that the turn was cut off, a line of the same length.
    const crash = frame(
      { seq: log.seq + 1, ts: NOW, kind: "turn_interrupted" },
      ',"turn":1,"reason":"crash"',
    );
    const empty = frame(
      { seq: log.seq + 1, ts: NOW - 60_000, kind: "item" },
      ',"turn":1,"type":"a","data":""',
      "00000000",
    );
    const pad = "x".repeat(Buffer.byteLength(crash) - Buffer.byteLength(empty));
    const torn = frame(
      { seq: log.seq + 1, ts: NOW - 60_000, kind: "item" },
      `,"turn":1,"type":"a","data":"${pad}"`,
      "00000000",
    );
    expect(Buffer.byteLength(torn)).toBe(Buffer.byteLength(crash));
    files.write(PATH, log.text() + torn, { mtimeMs: NOW - 60_000 });
    const reader = createLogReader(files.io);
    expect(tailOf(await readOnce(files, reader))).toEqual({ turn: "open" });

    files.rewrite(PATH, log.text() + crash, { mtimeMs: NOW });
    expect(tailOf(await readOnce(files, reader))).toMatchObject({ turn: "ended", failed: false });
  });
});

describe("a subagent's log", () => {
  test("is read once, its first 16 KiB, and never again while it is the same file", async () => {
    const files = memoryFiles();
    const path = logPath(CHILD_ID);
    files.write(
      path,
      fxLog({ id: CHILD_ID, role: "child", host: "child", parent: SESSION_ID })
        .turnStarted()
        .text(),
    );
    const reader = createLogReader(files.io);
    expect(await readOnce(files, reader, CHILD_ID)).toEqual({ state: "child" });
    expect(files.reads).toEqual([{ path, position: 0, length: expect.any(Number) }]);
    expect(files.reads[0].length).toBeLessThanOrEqual(MAX_HEAD_BYTES);
    expect(reader.isChild(CHILD_ID)).toBe(true);

    files.forget();
    files.append(path, fxLog({ id: CHILD_ID, role: "child" }).turnStarted().item().since(2), {
      mtimeMs: NOW + 5,
    });
    expect(await readOnce(files, reader, CHILD_ID)).toEqual({ state: "child" });
    expect(files.opened()).toEqual([]);

    reader.keepOnly(new Set([SESSION_ID]));
    expect(reader.isChild(CHILD_ID)).toBe(false);
  });
});

describe("what the reader gives", () => {
  test("the session's id, folder, start, newest time and last turn", async () => {
    const files = memoryFiles();
    files.write(
      PATH,
      fxLog()
        .turnStarted(NOW - 30_000)
        .item(NOW - 20_000)
        .text(),
    );
    expect(await readOnce(files)).toEqual({
      state: "ok",
      log: {
        id: SESSION_ID,
        cwd: WORKSPACE,
        createdAt: STARTED_AT,
        tail: { turn: "open" },
        why: null,
        newestTs: NOW - 20_000,
      },
    });
  });

  test("a first line that is not the folder's, broken, or of a newer format is not a session", async () => {
    const files = memoryFiles();
    files.write(PATH, fxLog({ id: OTHER_ID }).text());
    expect(await readOnce(files)).toEqual({ state: "broken" });
    files.write(PATH, fxLog({ v: 2 }).text());
    expect(await readOnce(files)).toEqual({ state: "newer" });
    files.write(PATH, `${"x".repeat(MAX_HEAD_BYTES + 10)}\n`);
    expect(await readOnce(files)).toEqual({ state: "broken" });
  });

  test("of a first read and a read of what was added, only the first line's folder is turned into text", async () => {
    const files = memoryFiles();
    const log = fxLog().turnStarted().item().title().snapshot();
    files.write(PATH, log.text(), { mtimeMs: NOW - 1 });
    const reader = createLogReader(files.io);
    const toString = vi.spyOn(Buffer.prototype, "toString");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const parse = vi.spyOn(JSON, "parse");
    await readOnce(files, reader);
    expect(toString).toHaveBeenCalledTimes(1);
    expect(String(toString.mock.contexts[0])).toBe(JSON.stringify(WORKSPACE));
    expect(parse).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();

    const mark = log.mark();
    log.item().childSpawned().compacted().turnInterrupted("failed");
    files.append(PATH, log.since(mark), { mtimeMs: NOW });
    toString.mockClear();
    parse.mockClear();
    expect(tailOf(await readOnce(files, reader))).toMatchObject({ turn: "ended", failed: true });
    expect(toString).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });
});
