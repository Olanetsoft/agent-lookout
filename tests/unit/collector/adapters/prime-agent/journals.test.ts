import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createJournalReader,
  FIRST_READ_BYTES,
  MAX_ADDED_BYTES,
  MAX_RECORD_LINE_BYTES,
  parseQueueLine,
  parseRecordLine,
} from "@collector/adapters/prime-agent/journals";
import {
  checkpoint,
  iso,
  journalOf,
  oldQueueLine,
  PRIVATE_FOLDER,
  PRIVATE_WORDS,
  queueLine,
  recordLine,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  STARTED_AT,
  WORKER_ID,
  workerIdOf,
} from "@tests/fixtures/prime-agent/primeAgent";
import { primeAgentFiles } from "@tests/support/adapters/prime-agent/primeAgentAdapter";

const AT = STARTED_AT + 10 * SECOND;
const JOURNAL = journalOf();
const bytes = (text: string) => Buffer.from(text.replace(/\n$/, ""));

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every call that turns bytes into text or parses text, while `run` runs. */
function decodingDuring<T>(run: () => T): { result: T; decoded: number[]; parsed: number } {
  const toString = vi.spyOn(Buffer.prototype, "toString");
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  const parse = vi.spyOn(JSON, "parse");
  const result = run();
  const decoded = toString.mock.calls.map((args, index) => {
    const self = toString.mock.contexts[index] as Buffer;
    const [, start = 0, end = self.byteLength] = args as [unknown, number?, number?];
    return Math.min(end, self.byteLength) - start;
  });
  for (const [input] of decode.mock.calls) {
    decoded.push((input as ArrayBufferView | undefined)?.byteLength ?? 0);
  }
  const parsed = parse.mock.calls.length;
  vi.restoreAllMocks();
  return { result, decoded, parsed };
}

describe("a record line", () => {
  test("keeps its worker, session, file's name, busy flag, step and time, and nothing else", () => {
    const line = bytes(recordLine({ busy: true, operation: "prompt_accepted", at: AT }));
    expect(parseRecordLine(line)).toStrictEqual({
      slot: WORKER_ID,
      sessionId: SESSION_ID,
      sessionFile: `${SESSION_ID}.jsonl`,
      busy: true,
      operation: "prompt_accepted",
      recordedAt: AT,
    });
    expect(JSON.stringify(parseRecordLine(line))).not.toContain(PRIVATE_FOLDER);
  });

  test("with no file is kept with none", () => {
    const line = bytes(
      recordLine({ busy: false, operation: "turn_end", at: AT, sessionFile: null }),
    );
    expect(parseRecordLine(line)?.sessionFile).toBeNull();
  });

  test("is not read when it does not begin, end and measure as Prime Agent writes one", () => {
    const good = recordLine({ busy: true, operation: "prompt_accepted", at: AT });
    expect(parseRecordLine(bytes(` ${good}`))).toBeNull();
    expect(parseRecordLine(bytes(good.replace('"recordedAt"', '"recorded_at"')))).toBeNull();
    expect(parseRecordLine(bytes(good.replace(/"}\n$/, '", "x": 1}')))).toBeNull();
    const long = recordLine({
      busy: true,
      operation: "prompt_accepted",
      at: AT,
      sessionFile: `/${"a".repeat(MAX_RECORD_LINE_BYTES)}/${SESSION_ID}.jsonl`,
    });
    expect(parseRecordLine(bytes(long))).toBeNull();
  });

  test("of the wrong types is not kept", () => {
    const line = (fields: Record<string, unknown>) =>
      bytes(JSON.stringify({ activeSessionId: WORKER_ID, ...fields, recordedAt: iso(AT) }));
    expect(
      parseRecordLine(line({ sessionId: SESSION_ID, busy: "yes", operation: "x" })),
    ).toBeNull();
    expect(parseRecordLine(line({ sessionId: 1, busy: true, operation: "x" }))).toBeNull();
    expect(
      parseRecordLine(line({ sessionId: SESSION_ID, sessionFile: 1, busy: true, operation: "x" })),
    ).toBeNull();
  });

  test("torn and glued to a queue line is never turned into text", () => {
    const record = recordLine({ busy: true, operation: "prompt_accepted", at: AT });
    const torn = record.slice(0, record.length - 20) + queueLine({ suspended: false, at: AT });
    const { result, decoded, parsed } = decodingDuring(() => parseRecordLine(bytes(torn)));
    expect(result).toBeNull();
    // Only the time at its end is decoded, to see that it is no record's.
    expect(Math.max(0, ...decoded)).toBeLessThanOrEqual(30);
    expect(parsed).toBe(0);
  });
});

describe("a queue line", () => {
  test("gives only its worker, whether it is parked, and its time", () => {
    for (const suspended of [true, false]) {
      expect(parseQueueLine(bytes(queueLine({ suspended, at: AT })))).toStrictEqual({
        slot: WORKER_ID,
        queue: { suspended, recordedAt: AT },
      });
    }
  });

  test("never turns the queued messages into text, whatever they hold", () => {
    // A message holding words, a raw control byte that JSON.parse refuses, a
    // stray bracket, an escaped ending that would read as parked, and bytes
    // that are not UTF-8.
    const start = Buffer.from(
      `{"version":2,"type":"queue_snapshot","active_session_id":"${WORKER_ID}","steering":[{"message":"${PRIVATE_WORDS} ] \\",\\"suspended\\":true,\\"recorded_at\\":\\"`,
    );
    const middle = Buffer.from([0x01, 0xff, 0xfe, 0x22, 0x5d]);
    const end = Buffer.from(`"}],"follow_up":[],"suspended":false,"recorded_at":"${iso(AT)}"}`);
    const line = Buffer.concat([start, middle, end]);
    const { result, decoded, parsed } = decodingDuring(() => parseQueueLine(line));
    expect(result).toStrictEqual({ slot: WORKER_ID, queue: { suspended: false, recordedAt: AT } });
    expect(parsed).toBe(0);
    for (const length of decoded) expect(length).toBeLessThanOrEqual(128);
    expect(decoded.filter((length) => length > 30)).toEqual([]);
  });

  test("that begins as one and does not end as one cannot be read", () => {
    const good = queueLine({ suspended: false, at: AT });
    expect(parseQueueLine(bytes(good.replace('"suspended":false', '"suspended":0')))).toEqual({
      slot: WORKER_ID,
      queue: "unreadable",
    });
    expect(parseQueueLine(bytes(good.replace(/"}\n$/, '","x":1}')))?.queue).toBe("unreadable");
    expect(
      parseQueueLine(
        bytes(good.replace(`"active_session_id":"${WORKER_ID}"`, '"active_session_id":"a\\"b"')),
      )?.queue,
    ).toBe("unreadable");
  });

  test("of the first format, or any other line, is not a queue line", () => {
    expect(parseQueueLine(bytes(oldQueueLine({ suspended: false, at: AT })))).toBeNull();
    expect(
      parseQueueLine(bytes(recordLine({ busy: true, operation: "create", at: AT }))),
    ).toBeNull();
    expect(parseRecordLine(bytes(queueLine({ suspended: false, at: AT })))).toBeNull();
  });
});

describe("reading a journal", () => {
  const read = async (
    files: ReturnType<typeof primeAgentFiles>,
    reader = createJournalReader(files.io),
  ) => reader.read(JOURNAL, await files.io.lstat(JOURNAL), WORKER_ID);

  test("keeps the slot's records, each with the queue line before it, and its newest queue line", async () => {
    const files = primeAgentFiles();
    files.write(
      JOURNAL,
      recordLine({ busy: true, operation: "create", at: AT }) +
        checkpoint({ busy: true, operation: "prompt_accepted", at: AT + SECOND }) +
        queueLine({ suspended: true, at: AT + 2 * SECOND }),
    );
    const state = await read(files);
    expect(state?.trail.map(({ record }) => record.operation)).toEqual([
      "create",
      "prompt_accepted",
    ]);
    expect(state?.trail[1]?.queue).toEqual({ suspended: false, recordedAt: AT + SECOND });
    expect(state?.queue).toEqual({ suspended: true, recordedAt: AT + 2 * SECOND });
  });

  test("passes over the lines of another slot and of the first queue format", async () => {
    const files = primeAgentFiles();
    files.write(
      JOURNAL,
      recordLine({ busy: true, operation: "prompt_accepted", at: AT }) +
        recordLine({
          activeSessionId: workerIdOf(2),
          busy: false,
          operation: "turn_end",
          at: AT + SECOND,
        }) +
        queueLine({ activeSessionId: workerIdOf(2), suspended: true, at: AT + SECOND }) +
        oldQueueLine({ suspended: true, at: AT + 2 * SECOND }),
    );
    const state = await read(files);
    expect(state?.trail.map(({ record }) => record.operation)).toEqual(["prompt_accepted"]);
    expect(state?.queue).toBeNull();
  });

  test("leaves a last line with no newline for the next read, and then reads only what was added", async () => {
    const files = primeAgentFiles();
    const first = recordLine({ busy: true, operation: "prompt_accepted", at: AT });
    const second = recordLine({ busy: false, operation: "turn_end", at: AT + SECOND });
    files.write(JOURNAL, first + second.slice(0, 30));
    const reader = createJournalReader(files.io);
    expect((await read(files, reader))?.trail.map(({ record }) => record.operation)).toEqual([
      "prompt_accepted",
    ]);
    files.append(JOURNAL, second.slice(30));
    files.forget();
    const state = await read(files, reader);
    expect(state?.trail.map(({ record }) => record.operation)).toEqual(["turn_end"]);
    expect(files.reads).toEqual([{ path: JOURNAL, position: first.length, length: second.length }]);
  });

  test("reads at most its last 1 MiB the first time, from the line after the one it began in", async () => {
    const files = primeAgentFiles();
    const filler = queueLine({
      suspended: false,
      at: AT,
      steering: [{ message: "x".repeat(4000) }],
    });
    const lines = filler.repeat(Math.ceil((FIRST_READ_BYTES * 1.5) / filler.length));
    files.write(JOURNAL, recordLine({ busy: true, operation: "create", at: AT }) + lines);
    const state = await read(files);
    expect(state?.trail).toEqual([]);
    expect(state?.queue).toEqual({ suspended: false, recordedAt: AT });
    expect(files.reads.map(({ length }) => length)).toEqual([FIRST_READ_BYTES]);
  });

  test("reads a journal rewritten to a new file, or one that shrank, from its end again", async () => {
    const files = primeAgentFiles();
    const reader = createJournalReader(files.io);
    files.write(JOURNAL, recordLine({ busy: true, operation: "prompt_accepted", at: AT }));
    await read(files, reader);
    // Compaction: the newest record of each slot, renamed into place.
    files.write(JOURNAL, recordLine({ busy: false, operation: "turn_end", at: AT + SECOND }));
    expect((await read(files, reader))?.trail.map(({ record }) => record.operation)).toEqual([
      "turn_end",
    ]);
    files.rewrite(
      JOURNAL,
      recordLine({ busy: false, operation: "queue_cleared", at: AT + 2 * SECOND }).slice(0, 10),
    );
    files.forget();
    expect((await read(files, reader))?.trail).toEqual([]);
    expect(files.reads[0]?.position).toBe(0);
  });

  test("keeps when the slot's run of idle records of one session began, as lines are added", async () => {
    const files = primeAgentFiles();
    const reader = createJournalReader(files.io);
    files.write(JOURNAL, recordLine({ busy: false, operation: "turn_end", at: AT }));
    expect((await read(files, reader))?.idleSince).toBe(AT);
    files.append(JOURNAL, recordLine({ busy: false, operation: "queue_purged", at: AT + SECOND }));
    files.forget();
    expect((await read(files, reader))?.idleSince).toBe(AT);
  });

  test("keeps when the run of idle records began past a prompt cancelled while it waited", async () => {
    const files = primeAgentFiles();
    files.write(
      JOURNAL,
      recordLine({ busy: false, operation: "turn_end", at: AT }) +
        recordLine({ busy: false, operation: "queue_dropped", at: AT + SECOND }),
    );
    expect((await read(files))?.idleSince).toBe(AT);
  });

  test("starts the run of idle records again after a prompt, or a record of another session", async () => {
    for (const [name, between] of [
      ["a prompt", recordLine({ busy: true, operation: "prompt_accepted", at: AT + SECOND })],
      [
        "another session's record",
        recordLine({
          busy: false,
          operation: "turn_end",
          at: AT + SECOND,
          sessionId: sessionIdOf(2),
          sessionFile: `/x/${sessionIdOf(2)}.jsonl`,
        }),
      ],
    ]) {
      const files = primeAgentFiles();
      files.write(
        JOURNAL,
        recordLine({ busy: false, operation: "turn_end", at: AT }) +
          between +
          recordLine({ busy: false, operation: "queue_purged", at: AT + 2 * SECOND }),
      );
      expect((await read(files))?.idleSince, name).toBe(AT + 2 * SECOND);
    }
    const working = primeAgentFiles();
    working.write(JOURNAL, recordLine({ busy: true, operation: "prompt_accepted", at: AT }));
    expect((await read(working))?.idleSince).toBeNull();
  });

  test("keeps when the run of idle records began across a rewrite of the file to its newest record", async () => {
    const files = primeAgentFiles();
    const reader = createJournalReader(files.io);
    files.write(
      JOURNAL,
      recordLine({ busy: false, operation: "turn_end", at: AT }) +
        queueLine({ suspended: false, at: AT }),
    );
    await read(files, reader);
    // Compaction: the slot's newest record and the newest queue line, renamed into place.
    files.write(
      JOURNAL,
      recordLine({ busy: false, operation: "queue_cleared", at: AT + SECOND }) +
        queueLine({ suspended: false, at: AT + SECOND }),
    );
    const state = await read(files, reader);
    expect(state?.trail.map(({ record }) => record.operation)).toEqual(["queue_cleared"]);
    expect(state?.idleSince).toBe(AT);
  });

  test("keeps when the run of idle records began past a second idle record, added or rewritten, and a rewrite after", async () => {
    for (const how of ["added", "rewritten"] as const) {
      const files = primeAgentFiles();
      const reader = createJournalReader(files.io);
      files.write(
        JOURNAL,
        recordLine({ busy: false, operation: "turn_end", at: AT }) +
          queueLine({ suspended: false, at: AT }),
      );
      await read(files, reader);
      const purged = recordLine({ busy: false, operation: "queue_purged", at: AT + SECOND });
      if (how === "added") files.append(JOURNAL, purged);
      else files.write(JOURNAL, purged + queueLine({ suspended: false, at: AT + SECOND }));
      expect((await read(files, reader))?.idleSince, how).toBe(AT);
      // Compaction again: the slot's newest record and the newest queue line, renamed into place.
      files.write(
        JOURNAL,
        recordLine({ busy: false, operation: "queue_cleared", at: AT + 2 * SECOND }) +
          queueLine({ suspended: false, at: AT + 2 * SECOND }),
      );
      expect((await read(files, reader))?.idleSince, how).toBe(AT);
    }
  });

  test("starts the run of idle records again at a turn's end, added or after a rewrite", async () => {
    for (const how of ["added", "rewritten"] as const) {
      const files = primeAgentFiles();
      const reader = createJournalReader(files.io);
      files.write(
        JOURNAL,
        recordLine({ busy: false, operation: "turn_end", at: AT }) +
          queueLine({ suspended: false, at: AT }),
      );
      await read(files, reader);
      // A turn ran and ended between two polls, and only its end is read.
      const ended =
        recordLine({ busy: false, operation: "turn_end", at: AT + 5 * SECOND }) +
        queueLine({ suspended: false, at: AT + 5 * SECOND });
      if (how === "added") files.append(JOURNAL, ended);
      else files.write(JOURNAL, ended);
      expect((await read(files, reader))?.idleSince, how).toBe(AT + 5 * SECOND);
    }
  });

  test("keeps no start of a run of idle records past 8 MiB added on one poll", async () => {
    const files = primeAgentFiles();
    const reader = createJournalReader(files.io);
    files.write(JOURNAL, recordLine({ busy: false, operation: "turn_end", at: AT }));
    await read(files, reader);
    const filler = queueLine({
      suspended: false,
      at: AT,
      steering: [{ message: "x".repeat(8000) }],
    });
    files.append(
      JOURNAL,
      filler.repeat(Math.ceil((MAX_ADDED_BYTES + 1024) / filler.length)) +
        recordLine({ busy: false, operation: "queue_purged", at: AT + 2 * SECOND }),
    );
    files.forget();
    expect((await read(files, reader))?.idleSince).toBe(AT + 2 * SECOND);
  });

  test("past 8 MiB added on one poll, reads its last 1 MiB again and drops what it had", async () => {
    const files = primeAgentFiles();
    const reader = createJournalReader(files.io);
    files.write(JOURNAL, recordLine({ busy: true, operation: "prompt_accepted", at: AT }));
    await read(files, reader);
    const filler = queueLine({
      suspended: true,
      at: AT,
      steering: [{ message: "x".repeat(8000) }],
    });
    files.append(JOURNAL, filler.repeat(Math.ceil((MAX_ADDED_BYTES + 1024) / filler.length)));
    files.forget();
    const state = await read(files, reader);
    expect(state?.trail).toEqual([]);
    expect(files.reads.map(({ length }) => length)).toEqual([FIRST_READ_BYTES]);
  });

  test("is not opened again while it has not changed, and gives null for one that cannot be read", async () => {
    const files = primeAgentFiles();
    const reader = createJournalReader(files.io);
    files.write(JOURNAL, recordLine({ busy: true, operation: "prompt_accepted", at: AT }));
    await read(files, reader);
    files.forget();
    await read(files, reader);
    expect(files.opened()).toEqual([]);
    files.failOpen(JOURNAL);
    files.append(JOURNAL, recordLine({ busy: false, operation: "turn_end", at: AT + SECOND }));
    expect(await read(files, reader)).toBeNull();
    expect(files.openHandles()).toBe(0);
  });
});
