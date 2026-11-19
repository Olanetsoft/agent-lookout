import { describe, expect, test } from "vitest";

import {
  createMuseLogReader,
  HEAD_BYTES,
  PIECE_BYTES,
  REACH_BYTES,
  type LogRef,
} from "@collector/adapters/muse-code/logReader";
import { LINE_MAX } from "@collector/adapters/muse-code/records";
import {
  ACTION,
  asked,
  CWD,
  logPath,
  metadata,
  NOW,
  opening,
  PROMPT,
  renamed,
  replied,
  requested,
  RUN,
  RUN_2,
  SECOND,
  SESSION_ID,
  sessionEnd,
  sessionResumed,
  settled,
  started,
  terminal,
} from "@tests/fixtures/muse-code/museCode";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/muse-code/museCodeAdapter";

const FILE = logPath();
const AT = NOW - 10 * 60 * SECOND;

/** The log as a poll's `lstat` finds it. */
async function refOf(files: MemoryFiles, file = FILE): Promise<LogRef> {
  return { path: file, id: SESSION_ID, info: await files.io.lstat(file) };
}

/** What a reader that has never seen the file reads of it now: a first read of the same file. */
async function fresh(files: MemoryFiles, file = FILE) {
  return createMuseLogReader(files.io, "darwin").read(await refOf(files, file));
}

/** A line passed over unwalked, of exactly `bytes` bytes with its line break. */
function filler(bytes: number): string {
  const start = '{"payload_type":"session.name.changed","text":"';
  const end = '"}\n';
  return `${start}${"x".repeat(bytes - start.length - end.length)}${end}`;
}

/**
 * Reads the log after each step with one reader that keeps what it read, and
 * checks every kept read against a first read of the same file.
 */
async function stepped(files: MemoryFiles, steps: (() => void)[]) {
  const reader = createMuseLogReader(files.io, "darwin");
  const seen = [];
  for (const step of steps) {
    step();
    const kept = await reader.read(await refOf(files));
    expect(kept).toEqual(await fresh(files));
    seen.push(kept);
  }
  return seen;
}

describe("what a log shows", () => {
  test("its newest run's fold, its workspace folder and its metadata record's time", async () => {
    const files = memoryFiles();
    files.write(FILE, `${opening(AT)}${asked(RUN, PROMPT, AT + SECOND)}`, {
      mtimeMs: AT + 2 * SECOND,
    });
    const read = await fresh(files);
    expect(read.cwd).toBe(CWD);
    expect(read.metadataAt).toBe(AT - SECOND);
    expect(read.writtenAt).toBe(AT + 2 * SECOND);
    expect(read.view).toMatchObject({
      state: "ok",
      fold: {
        run: { id: RUN, state: "open", openedAt: AT },
        prompts: new Map([[PROMPT, AT + SECOND]]),
      },
    });
  });

  test("none for a log with no run's start, as a session just made holds", async () => {
    const files = memoryFiles();
    files.write(FILE, metadata(AT));
    expect((await fresh(files)).view).toEqual({ state: "none" });
    files.write(FILE, "");
    expect((await fresh(files)).view).toEqual({ state: "none" });
  });

  test("the newest start decides, and an earlier run's records before it say nothing", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      `${opening(AT)}${asked(RUN, PROMPT, AT + 1)}${sessionEnd(AT + 2)}${started(RUN_2, AT + 3)}`,
    );
    expect((await fresh(files)).view).toMatchObject({
      state: "ok",
      fold: { run: { id: RUN_2, state: "open" }, marker: null, prompts: new Map() },
    });
  });

  test("a line that would decide and cannot be read, after the newest start, makes the log unsure until the next start", async () => {
    const files = memoryFiles();
    const broken = started(RUN, AT + 1).replace('"stream":{', '"stream":{,');
    files.write(FILE, `${opening(AT)}${broken}`);
    expect((await fresh(files)).view).toEqual({ state: "unsure", why: "unreadable" });
    files.append(FILE, started(RUN_2, AT + 2));
    expect((await fresh(files)).view).toMatchObject({ state: "ok", fold: { run: { id: RUN_2 } } });
    files.append(FILE, started(RUN, AT + 3, { schemaVersion: 2 }));
    expect((await fresh(files)).view).toEqual({ state: "unsure", why: "newer" });
  });
});

describe("a kept read is what a first read of the same file gives", () => {
  test("as lines are added, a partial last line among them, and the fold goes on", async () => {
    const files = memoryFiles();
    const lines = [
      opening(AT),
      replied(RUN, AT + 1),
      requested(RUN, ACTION, AT + 2, "human_pending"),
      asked(RUN, PROMPT, AT + 3),
      settled(RUN, PROMPT, AT + 4),
      terminal(RUN, AT + 5),
      sessionResumed(AT + 6),
      started(RUN_2, AT + 7),
      replied(RUN_2, AT + 8),
      sessionEnd(AT + 9),
    ];
    const partial = lines[3] as string;
    const seen = await stepped(files, [
      () => files.write(FILE, lines[0] as string, { mtimeMs: AT }),
      () => files.append(FILE, `${lines[1]}${lines[2]}`, { mtimeMs: AT + 2 }),
      () => files.append(FILE, partial.slice(0, 40), { mtimeMs: AT + 3 }),
      () => files.append(FILE, partial.slice(40), { mtimeMs: AT + 4 }),
      ...lines
        .slice(4)
        .map((line, index) => () => files.append(FILE, line, { mtimeMs: AT + 5 + index })),
    ]);
    // The half-written line counted for nothing until it was whole.
    expect(seen[2]?.view).toMatchObject({ fold: { prompts: new Map() } });
    expect(seen[3]?.view).toMatchObject({ fold: { prompts: new Map([[PROMPT, AT + 3]]) } });
    expect(seen.at(-1)?.view).toMatchObject({
      state: "ok",
      fold: { run: { id: RUN_2, state: "closed" }, marker: { sort: "end", at: AT + 9 } },
    });
  });

  test("when the file shrinks, is replaced, or a line is rewritten so the byte before the end is not a line break", async () => {
    const files = memoryFiles();
    await stepped(files, [
      () => files.write(FILE, `${opening(AT)}${replied(RUN, AT + 1)}`, { mtimeMs: AT }),
      () => files.rewrite(FILE, opening(AT), { mtimeMs: AT + 1 }),
      () => files.write(FILE, `${opening(AT + 5, RUN_2)}`, { mtimeMs: AT + 2 }),
      () =>
        files.rewrite(FILE, `${opening(AT + 5, RUN_2).slice(0, -1)}x${terminal(RUN_2, AT + 6)}`, {
          mtimeMs: AT + 3,
        }),
    ]);
  });

  test("when a newer line that cannot be read follows the newest start, and a start follows it", async () => {
    const files = memoryFiles();
    await stepped(files, [
      () => files.write(FILE, opening(AT)),
      () => files.append(FILE, terminal(RUN, AT + 1, "completed", { schemaVersion: 3 })),
      () => files.append(FILE, replied(RUN, AT + 2)),
      () => files.append(FILE, started(RUN_2, AT + 3)),
    ]);
  });

  test("when it grows past what is looked through, and the newest start falls out of reach", async () => {
    const files = memoryFiles();
    const seen = await stepped(files, [
      () => files.write(FILE, `${filler(PIECE_BYTES + 17)}${opening(AT)}`),
      () => files.append(FILE, filler(REACH_BYTES - 4 * 1024)),
      () => files.append(FILE, filler(8 * 1024)),
      () => files.append(FILE, started(RUN_2, AT + 1)),
      () => files.append(FILE, `${filler(REACH_BYTES / 2)}${filler(REACH_BYTES / 2 + 10)}`),
    ]);
    expect(seen.map(({ view }) => view.state)).toEqual(["ok", "ok", "too-far", "ok", "too-far"]);
  });

  test("a line that begins exactly the reach before the end is found whole", async () => {
    const files = memoryFiles();
    const tail = `${started(RUN, AT)}`;
    files.write(FILE, `${filler(100)}${tail}${filler(REACH_BYTES - tail.length)}`);
    const size = (await files.io.lstat(FILE)).size;
    expect(size - 100).toBe(REACH_BYTES);
    expect((await fresh(files)).view.state).toBe("ok");
    files.write(FILE, `${filler(100)}${tail}${filler(REACH_BYTES - tail.length + 1)}`);
    expect((await fresh(files)).view.state).toBe("too-far");
  });

  test("a log with no start in a file longer than the reach is too far, and none in one no longer", async () => {
    const files = memoryFiles();
    files.write(FILE, filler(REACH_BYTES));
    expect((await fresh(files)).view.state).toBe("none");
    files.write(FILE, filler(REACH_BYTES + 1));
    expect((await fresh(files)).view.state).toBe("too-far");
  });

  test("when a start, or a line that cannot be read, on the first line falls one byte out of reach", async () => {
    const start = started(RUN, AT);
    const broken = start.replace('"stream":{', '"stream":{,');
    for (const [first, state] of [
      [start, "ok"],
      [broken, "unsure"],
    ] as const) {
      for (const [size, then] of [
        [REACH_BYTES, state],
        [REACH_BYTES + 1, "too-far"],
      ] as const) {
        const files = memoryFiles();
        const seen = await stepped(files, [
          () => files.write(FILE, first),
          () => files.append(FILE, filler(size - first.length)),
        ]);
        expect((await files.io.lstat(FILE)).size).toBe(size);
        expect(seen.map(({ view }) => view.state)).toEqual([state, then]);
      }
    }
  });
});

describe("a line longer than 1 MiB", () => {
  test("is read by its first 1 MiB: its fields there decide, and one past them makes it unreadable", async () => {
    const files = memoryFiles();
    files.write(FILE, `${metadata(AT)}${started(RUN, AT, undefined, "p".repeat(LINE_MAX + 5))}`);
    expect((await fresh(files)).view).toMatchObject({ state: "ok", fold: { run: { id: RUN } } });
    const late = JSON.stringify({
      schema_version: 1,
      stream: { kind: "session", id: SESSION_ID },
      recorded_at: AT * 1000,
      payload_type: "runtime.session",
      payload: {
        event: { prompt: "p".repeat(LINE_MAX), kind: "started" },
        kind: "run",
        run_id: RUN,
      },
    });
    files.write(FILE, `${opening(AT)}${late}\n`);
    expect((await fresh(files)).view).toEqual({ state: "unsure", why: "unreadable" });
    // And so it is when it is read onwards.
    const reader = createMuseLogReader(files.io, "darwin");
    files.write(FILE, opening(AT));
    await reader.read(await refOf(files));
    files.append(FILE, `${late}\n`);
    expect((await reader.read(await refOf(files))).view).toEqual({
      state: "unsure",
      why: "unreadable",
    });
  });
});

describe("the metadata record", () => {
  test("is looked for in the first 64 KiB alone", async () => {
    const files = memoryFiles();
    files.write(FILE, `${filler(HEAD_BYTES - 10)}${metadata(AT)}${started(RUN, AT)}`);
    expect(await fresh(files)).toMatchObject({ cwd: null, metadataAt: null });
    files.write(
      FILE,
      `${filler(HEAD_BYTES - metadata(AT).length)}${metadata(AT)}${started(RUN, AT)}`,
    );
    expect(await fresh(files)).toMatchObject({ cwd: CWD, metadataAt: AT });
  });

  test("is looked for again on each change while the file is shorter and none was found, and not once one is", async () => {
    const files = memoryFiles();
    const reader = createMuseLogReader(files.io, "darwin");
    const half = metadata(AT);
    files.write(FILE, `${started(RUN, AT)}${half.slice(0, 30)}`);
    expect((await reader.read(await refOf(files))).cwd).toBeNull();
    files.append(FILE, half.slice(30));
    expect((await reader.read(await refOf(files))).cwd).toBe(CWD);
    files.forget();
    files.append(FILE, replied(RUN, AT + 1));
    expect((await reader.read(await refOf(files))).cwd).toBe(CWD);
    expect(files.reads.filter((read) => read.position === 0)).toEqual([]);
  });
});

describe("reading", () => {
  test("opens the file only when its size, time or identity changed", async () => {
    const files = memoryFiles();
    const reader = createMuseLogReader(files.io, "darwin");
    files.write(FILE, opening(AT), { mtimeMs: AT });
    await reader.read(await refOf(files));
    files.forget();
    await reader.read(await refOf(files));
    expect(files.opened()).toEqual([]);
    files.rewrite(FILE, opening(AT), { mtimeMs: AT + 1 });
    await reader.read(await refOf(files));
    expect(files.opened()).toHaveLength(1);
  });

  test("takes its write time from the file as it was opened, when that is later than its lstat's", async () => {
    const files = memoryFiles();
    const reader = createMuseLogReader(files.io, "darwin");
    files.write(FILE, opening(AT), { mtimeMs: AT });
    const ref = await refOf(files);
    files.append(FILE, replied(RUN, AT + 1), { mtimeMs: AT + 5 * SECOND });
    const read = await reader.read(ref);
    expect(read.writtenAt).toBe(AT + 5 * SECOND);
    // An open file whose time is earlier than the lstat's never moves it back.
    const later = await refOf(files);
    later.info = { ...later.info, mtimeMs: AT + 9 * SECOND };
    expect((await reader.read(later)).writtenAt).toBe(AT + 9 * SECOND);
  });

  test("reads nothing from a file put in place of the one its lstat found, and tries again next poll", async () => {
    const files = memoryFiles();
    const reader = createMuseLogReader(files.io, "darwin");
    files.write(FILE, opening(AT));
    const ref = await refOf(files);
    files.write(FILE, `${opening(AT)}${asked(RUN, PROMPT, AT + 1)}`);
    expect((await reader.read(ref)).view).toEqual({ state: "none" });
    expect(files.reads).toEqual([]);
    expect(files.openHandles()).toBe(0);
    expect((await reader.read(await refOf(files))).view).toMatchObject({ state: "ok" });
  });

  test("keeps what it read when a read fails, and closes every file it opens", async () => {
    const files = memoryFiles();
    const reader = createMuseLogReader(files.io, "darwin");
    files.write(FILE, opening(AT), { mtimeMs: AT });
    const first = await reader.read(await refOf(files));
    files.append(FILE, asked(RUN, PROMPT, AT + 1), { mtimeMs: AT + 1 });
    files.failOpen(FILE);
    const failed = await reader.read(await refOf(files));
    expect(failed.view).toEqual(first.view);
    expect(failed.writtenAt).toBe(AT + 1);
    files.heal(FILE);
    expect((await reader.read(await refOf(files))).view).toMatchObject({
      fold: { prompts: new Map([[PROMPT, AT + 1]]) },
    });
    expect(files.openHandles()).toBe(0);
  });

  test("never reads more than one line's first 1 MiB at once, nor holds the file's whole end", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      `${opening(AT)}${filler(3 * PIECE_BYTES)}${replied(RUN, AT + 1)}${filler(LINE_MAX * 3)}${replied(RUN, AT + 2)}${renamed(AT + 3)}`,
    );
    files.forget();
    expect((await fresh(files)).view.state).toBe("ok");
    const largest = Math.max(...files.reads.map((read) => read.length));
    expect(largest).toBeLessThanOrEqual(LINE_MAX);
    const total = files.reads.reduce((sum, read) => sum + read.length, 0);
    const size = (await files.io.lstat(FILE)).size;
    // Backwards once, the first bytes of each long line, onwards once from the start found, and the start of the file.
    expect(total).toBeLessThanOrEqual(2 * size + HEAD_BYTES + 2 * LINE_MAX);
  });

  test("forgets every log it is not told to keep", async () => {
    const files = memoryFiles();
    const reader = createMuseLogReader(files.io, "darwin");
    files.write(FILE, opening(AT));
    await reader.read(await refOf(files));
    expect(reader.kept).toBe(1);
    reader.keepOnly(new Set());
    expect(reader.kept).toBe(0);
  });
});
