import { describe, expect, test } from "vitest";

import {
  createAgyLogReader,
  LINE_LIMIT_BYTES,
  LOG_LIMIT_BYTES,
  logStartOf,
  matchLogs,
  RELIST_MS,
} from "@collector/adapters/antigravity/agyLogs";
import {
  AGY_HOME,
  answeredLine,
  askingLine,
  askingLog,
  conversationId,
  logLine,
  logName,
  logPath,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  SECOND,
  streamingLine,
  WORKSPACE,
} from "@tests/fixtures/antigravity";
import { memoryFiles } from "@tests/support/adapters/antigravityAdapter";

const ID = conversationId("a1");
const START = NOW - 30 * MINUTE;

describe("a log's name", () => {
  test("gives the local time its program started", () => {
    expect(logStartOf("cli-20261007_125834.log")).toBe(new Date(2026, 9, 7, 12, 58, 34).getTime());
    expect(logStartOf(logName(START))).toBe(START);
  });

  test("of any other form, or a time that does not exist, gives none", () => {
    for (const name of [
      "cli.log",
      "cli-20261007_125834.log.1",
      "cli-20261007-125834.log",
      "cli-20261332_125834.log",
      "cli-20260230_125834.log",
      "cli-20261007_255834.log",
      "other-20261007_125834.log",
    ]) {
      expect(logStartOf(name), name).toBeNull();
    }
  });
});

describe("which log each program wrote", () => {
  const logs = (...starts: number[]) => new Map(starts.map((at) => [logName(at), at]));

  test("the one named in the seconds after it started", () => {
    expect(
      matchLogs(
        [{ startedAt: START }, { startedAt: START + 5 * MINUTE }],
        logs(START + SECOND, START + 5 * MINUTE + 2 * SECOND, START - MINUTE),
      ),
    ).toEqual([logName(START + SECOND), logName(START + 5 * MINUTE + 2 * SECOND)]);
  });

  test("the one named up to 2 seconds before the start ps gives, which can be late", () => {
    expect(matchLogs([{ startedAt: START }], logs(START - 2 * SECOND))).toEqual([
      logName(START - 2 * SECOND),
    ]);
  });

  test("none named well before it started or long after", () => {
    expect(
      matchLogs([{ startedAt: START }], logs(START - 3 * SECOND, START + 11 * SECOND)),
    ).toEqual([null]);
  });

  test("none when two programs could have written it, or a program could be two logs", () => {
    expect(
      matchLogs([{ startedAt: START }, { startedAt: START + SECOND }], logs(START + 2 * SECOND)),
    ).toEqual([null, null]);
    expect(matchLogs([{ startedAt: START }], logs(START + SECOND, START + 3 * SECOND))).toEqual([
      null,
    ]);
  });

  test("none for a program whose start is not known", () => {
    expect(matchLogs([{ startedAt: null }], logs(START + SECOND))).toEqual([null]);
  });
});

describe("the log reader", () => {
  const file = logPath(AGY_HOME, logName(START + SECOND));

  function setUp(lines: string[]) {
    let at = NOW;
    const files = memoryFiles(() => at);
    files.write(file, lines.join(""));
    const reader = createAgyLogReader({ home: AGY_HOME, io: files.io, now: () => at });
    return { files, reader, wait: (ms: number) => (at += ms) };
  }

  test("reads what a running program's log says, and nothing else of it", async () => {
    const { reader } = setUp(askingLog(START, ID, 2));
    const [state] = await reader.read([{ startedAt: START }]);
    expect(state).toMatchObject({
      folder: WORKSPACE,
      current: ID,
      ask: { conversation: ID, step: 2, tool: "RunCommand" },
    });
    expect(JSON.stringify({ ...state, opened: [...(state?.opened ?? [])] })).not.toContain(
      PRIVATE_WORDS,
    );
  });

  test("reads only what was added, and sees the answer", async () => {
    const { files, reader } = setUp(askingLog(START, ID, 2));
    await reader.read([{ startedAt: START }]);
    const before = files.reads.length;
    files.append(file, answeredLine(NOW, ID, 2));
    const [state] = await reader.read([{ startedAt: START }]);
    expect(state?.ask).toBeNull();
    const onward = files.reads.slice(before).filter((read) => read.path === file);
    expect(onward).toHaveLength(1);
    expect(onward[0]?.position).toBeGreaterThan(0);
  });

  test("does not read a log that did not change", async () => {
    const { files, reader } = setUp(askingLog(START, ID, 2));
    await reader.read([{ startedAt: START }]);
    const before = files.reads.length;
    await reader.read([{ startedAt: START }]);
    expect(files.reads.length).toBe(before);
  });

  test("the rest of a line too long to use is passed over, up to its newline, and the next line counts", async () => {
    const { files, reader } = setUp(askingLog(START, ID, 2));
    await reader.read([{ startedAt: START }]);
    const long = logLine(NOW, `Error report: ${"x".repeat(2 * LINE_LIMIT_BYTES)}`);
    files.append(file, long.slice(0, LINE_LIMIT_BYTES + 100));
    await reader.read([{ startedAt: START }]);
    // What follows on the same line looks like a whole line of agy's, and is not one.
    files.append(file, answeredLine(NOW, ID, 2));
    expect((await reader.read([{ startedAt: START }]))[0]?.ask).not.toBeNull();
    files.append(file, answeredLine(NOW, ID, 2));
    expect((await reader.read([{ startedAt: START }]))[0]?.ask).toBeNull();
  });

  test("more added at once than the limit is read from near its end, from the first whole line", async () => {
    const { files, reader } = setUp(askingLog(START, ID, 2));
    await reader.read([{ startedAt: START }]);
    const filler = logLine(NOW, `Error report: ${PRIVATE_WORDS}`);
    files.append(
      file,
      filler.repeat(Math.ceil((LOG_LIMIT_BYTES + 1000) / filler.length)) +
        streamingLine(NOW, conversationId("b2")) +
        askingLine(NOW, 5),
    );
    const [state] = await reader.read([{ startedAt: START }]);
    expect(state).toMatchObject({
      folder: WORKSPACE,
      current: conversationId("b2"),
      ask: { conversation: conversationId("b2"), step: 5 },
    });
    expect(Math.max(...files.reads.map((read) => read.length))).toBeLessThanOrEqual(
      LOG_LIMIT_BYTES,
    );
  });

  test("a line written in two parts counts once it is whole", async () => {
    const { files, reader } = setUp(askingLog(START, ID, 2));
    await reader.read([{ startedAt: START }]);
    const answer = answeredLine(NOW, ID, 2);
    files.append(file, answer.slice(0, 30));
    expect((await reader.read([{ startedAt: START }]))[0]?.ask).not.toBeNull();
    files.append(file, answer.slice(30));
    expect((await reader.read([{ startedAt: START }]))[0]?.ask).toBeNull();
  });

  test("a log too long to read whole is read only near its end, where an approval tied to no conversation read is none", async () => {
    const filler = logLine(START + 2 * SECOND, `Error report: ${PRIVATE_WORDS}`);
    const lines = [
      ...askingLog(START, ID, 2).slice(0, 6),
      filler.repeat(Math.ceil((LOG_LIMIT_BYTES + 1000) / filler.length)),
      askingLine(NOW - SECOND, 8),
    ];
    const { files, reader } = setUp(lines);
    const [state] = await reader.read([{ startedAt: START }]);
    // The start, with the folder and the conversation, is past the limit.
    expect(state).toMatchObject({ folder: null, current: null, ask: null });
    expect(Math.max(...files.reads.map((read) => read.length))).toBeLessThanOrEqual(
      LOG_LIMIT_BYTES,
    );
  });

  test("a log that was replaced is read afresh", async () => {
    const { files, reader } = setUp(askingLog(START, ID, 2));
    await reader.read([{ startedAt: START }]);
    files.write(file, streamingLine(START + 3 * SECOND, conversationId("b2")));
    const [state] = await reader.read([{ startedAt: START }]);
    expect(state).toMatchObject({ folder: null, current: conversationId("b2"), ask: null });
  });

  test("reads no log for a program it cannot match, or one that is not an ordinary file", async () => {
    const { files, reader } = setUp(askingLog(START, ID, 2));
    expect(await reader.read([{ startedAt: START - 5 * MINUTE }])).toEqual([null]);
    files.special(logPath(AGY_HOME, logName(NOW - MINUTE + SECOND)));
    expect(await reader.read([{ startedAt: NOW - MINUTE }])).toEqual([null]);
    expect(files.calls.filter((call) => call.method === "openRegular")).toEqual([]);
  });

  test("reads nothing, and lists nothing, while no agy program runs", async () => {
    const { files, reader } = setUp(askingLog(START, ID, 2));
    expect(await reader.read([])).toEqual([]);
    expect(files.calls).toEqual([]);
  });

  test("lists the folder again every 10 seconds, and at once for a program it has not seen", async () => {
    let at = NOW;
    const files = memoryFiles(() => at);
    files.mkdir(`${AGY_HOME}/log`);
    const reader = createAgyLogReader({ home: AGY_HOME, io: files.io, now: () => at });
    const listed = () => files.calls.filter((call) => call.method === "readdir").length;
    expect(await reader.read([{ startedAt: START }])).toEqual([null]);
    files.write(file, askingLog(START, ID, 2).join(""));
    // Not before 10 seconds have passed: the folder is not listed on each poll.
    expect(await reader.read([{ startedAt: START }])).toEqual([null]);
    expect(listed()).toBe(1);
    at += RELIST_MS;
    expect((await reader.read([{ startedAt: START }]))[0]?.current).toBe(ID);
    expect(listed()).toBe(2);
    // A program `ps` shows for the first time has the folder listed at once.
    await reader.read([{ startedAt: START }, { startedAt: NOW - MINUTE }]);
    expect(listed()).toBe(3);
  });

  test("a second log that could be the program's, seen when the folder is listed again, makes it no one's", async () => {
    const { files, reader, wait } = setUp(askingLog(START, ID, 2));
    expect((await reader.read([{ startedAt: START }]))[0]).not.toBeNull();
    files.write(logPath(AGY_HOME, logName(START + 3 * SECOND)), askingLog(START, ID, 2).join(""));
    wait(RELIST_MS);
    expect(await reader.read([{ startedAt: START }])).toEqual([null]);
  });

  test("a log folder that cannot be listed gives no logs, and does not throw", async () => {
    const files = memoryFiles(() => NOW);
    files.fail(`${AGY_HOME}/log`, "EACCES");
    const reader = createAgyLogReader({ home: AGY_HOME, io: files.io });
    expect(await reader.read([{ startedAt: START }])).toEqual([null]);
  });
});
