import { describe, expect, test } from "vitest";

import {
  LINE_HEAD_BYTES,
  TITLE_LINE_MAX,
  TITLE_MAX,
} from "@collector/adapters/deepseek-harness/lines";
import type { LogRef } from "@collector/adapters/deepseek-harness/logFiles";
import {
  createDeepseekHarnessLogReader,
  HEADER_FIRST_BYTES,
  HEADER_MAX_BYTES,
  PIECE_BYTES,
  READ_MAX_COMPRESSED,
  READ_MAX_PLAIN,
} from "@collector/adapters/deepseek-harness/logReader";
import type { ZstdDecoder } from "@collector/adapters/deepseek-harness/zstdFrames";
import {
  batch,
  endedTurn,
  event,
  headerLine,
  line,
  logPath,
  NOW,
  sessionFolder,
  SESSION_ID,
  STARTED_AT,
} from "@tests/fixtures/deepseek-harness/deepseekHarness";
import {
  memoryFiles,
  ZSTD,
  type MemoryFiles,
} from "@tests/support/adapters/deepseek-harness/deepseekHarnessAdapter";
import {
  compressedLog,
  frame,
  HAS_ZSTD,
  joined,
  NO_ZSTD_REASON,
  streamedFrame,
  withDescriptor,
} from "@tests/support/adapters/deepseek-harness/frames";

const T = NOW - 10 * 60_000;
const PLAIN = logPath(SESSION_ID, { compressed: false });
const COMPRESSED = logPath();

/** A decoder that counts the frames it is handed, and how much may come out of each. */
function countingDecoder(inner: ZstdDecoder | null = ZSTD) {
  const calls: number[] = [];
  const decoder: ZstdDecoder = {
    frame(data, max) {
      calls.push(max);
      return inner!.frame(data, max);
    },
  };
  return { decoder, calls };
}

async function refOf(files: MemoryFiles, path: string): Promise<LogRef> {
  return {
    folder: sessionFolder(),
    path,
    zstd: path.endsWith(".zstd"),
    info: await files.io.lstat(path),
  };
}

/** The log read once: its first line, then on. */
async function readOnce(
  reader: ReturnType<typeof createDeepseekHarnessLogReader>,
  files: MemoryFiles,
  path: string,
  titles = true,
) {
  const ref = await refOf(files, path);
  await reader.header(ref, NOW);
  return reader.readOn(ref, titles, NOW);
}

const readerFor = (files: MemoryFiles, decoder: ZstdDecoder | null = ZSTD) =>
  createDeepseekHarnessLogReader(files.io, decoder, "darwin");

/** A title its model wrote, with `count` message numbers, as a long conversation gives one. */
const providerTitle = (seq: number, title: string, count: number) =>
  event("session/title", seq, T, {
    title,
    messageSeqs: Array.from({ length: count }, (_, n) => n),
    source: { kind: "provider", provider: "demo-provider", model: "demo-model" },
  });

describe("an uncompressed log", () => {
  test("is read from its first line, then only what was added", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    expect(await readOnce(reader, files, PLAIN)).toMatchObject({
      header: { id: SESSION_ID, createdAt: STARTED_AT },
      turn: { state: "open", since: T },
      mark: "ok",
    });
    const size = (await files.io.lstat(PLAIN)).size;
    files.forget();
    files.append(PLAIN, batch(line.turnEnd(1, T + 5, "completed")));
    expect(await reader.readOn(await refOf(files, PLAIN), true, NOW)).toMatchObject({
      turn: { state: "ended", end: "completed", at: T + 5 },
    });
    // The byte before what was added, and what was added, and nothing before it.
    expect(Math.min(...files.reads.map((one) => one.position))).toBe(size - 1);
  });

  test("that has not changed is not opened again", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(...endedTurn(0, T)));
    const reader = readerFor(files);
    await readOnce(reader, files, PLAIN);
    files.forget();
    await reader.header(await refOf(files, PLAIN), NOW);
    await reader.readOn(await refOf(files, PLAIN), true, NOW);
    expect(files.count("openRegular")).toBe(0);
  });

  test("leaves a last line still being written, and reads it once it is whole", async () => {
    const files = memoryFiles();
    const end = line.turnEnd(1, T + 5, "completed");
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)) + end.slice(0, 20));
    const reader = readerFor(files);
    expect((await readOnce(reader, files, PLAIN))?.turn.state).toBe("open");
    files.append(PLAIN, `${end.slice(20)}\n`);
    expect((await reader.readOn(await refOf(files, PLAIN), true, NOW))?.turn).toMatchObject({
      state: "ended",
    });
  });

  test("is read from its start again when it grew shorter, as when an append is rolled back", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T), line.turnEnd(1, T + 1, "error")));
    const reader = readerFor(files);
    expect((await readOnce(reader, files, PLAIN))?.turn).toMatchObject({ end: "error" });
    files.rewrite(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    expect((await readOnce(reader, files, PLAIN))?.turn.state).toBe("open");
    files.append(PLAIN, batch(line.turnEnd(1, T + 2, "completed")));
    expect((await reader.readOn(await refOf(files, PLAIN), true, NOW))?.turn).toMatchObject({
      end: "completed",
    });
  });

  test("is read from its start again when the byte before what was added is not a newline", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    await readOnce(reader, files, PLAIN);
    // Rewritten in place, as long as before and more, with no newline where the read stopped.
    const header = headerLine();
    files.rewrite(
      PLAIN,
      header + batch(event("other", 0, T, { pad: "x".repeat(40) }), line.turnStart(1, T + 3)),
    );
    files.forget();
    const read = await reader.readOn(await refOf(files, PLAIN), true, NOW);
    expect(read).toMatchObject({ mark: "ok", turn: { state: "open", since: T + 3 } });
    expect(files.reads.some((one) => one.position === 0)).toBe(true);
  });

  test("whose line numbers skip is read from its start again, and is stuck when they skip there too", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    await readOnce(reader, files, PLAIN);
    files.append(PLAIN, batch(line.turnEnd(5, T + 1, "completed")));
    files.forget();
    expect(await reader.readOn(await refOf(files, PLAIN), true, NOW)).toMatchObject({
      mark: "stuck",
    });
    expect(files.reads.some((one) => one.position === 0)).toBe(true);
    // Stuck until it is another file or grows shorter: not opened again as it grows.
    files.forget();
    files.append(PLAIN, batch(line.turnStart(6, T + 2)));
    expect(await reader.readOn(await refOf(files, PLAIN), true, NOW)).toMatchObject({
      mark: "stuck",
    });
    expect(files.count("openRegular")).toBe(0);
    // Another file is read afresh.
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    expect(await readOnce(reader, files, PLAIN)).toMatchObject({ mark: "ok" });
  });

  test("rewritten in place with the same lines and more is read on from where it stopped", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    await readOnce(reader, files, PLAIN);
    // Rewritten in place with the same first bytes and more lines: the numbers do not go on from 1.
    files.rewrite(
      PLAIN,
      headerLine() +
        batch(line.turnStart(0, T), line.turnEnd(1, T + 1, "error"), line.turnStart(2, T + 2)),
    );
    const read = await reader.readOn(await refOf(files, PLAIN), true, NOW);
    expect(read).toMatchObject({ mark: "ok", turn: { state: "open", since: T + 2 } });
  });

  test("of a line longer than a piece is read whole, and only its first bytes kept", async () => {
    const files = memoryFiles();
    const long = event("assistant/message", 1, T, { text: "w".repeat(3 * 1024 * 1024) });
    files.write(
      PLAIN,
      headerLine() + batch(line.turnStart(0, T), long, line.turnEnd(2, T + 1, "completed")),
    );
    expect((await readOnce(readerFor(files), files, PLAIN))?.turn).toMatchObject({
      end: "completed",
    });
  });

  test("keeps its newest title of its own, and a later title of none clears it", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.title(0, T, "Fix the build", "provider")));
    const reader = readerFor(files);
    expect((await readOnce(reader, files, PLAIN))?.title).toBe("Fix the build");
    files.append(PLAIN, batch(line.title(1, T, "My rename", "user")));
    expect((await reader.readOn(await refOf(files, PLAIN), true, NOW))?.title).toBe("My rename");
    files.append(PLAIN, batch(line.title(2, T, "first words", "fallback")));
    expect((await reader.readOn(await refOf(files, PLAIN), true, NOW))?.title).toBeNull();
  });

  test(`keeps a title line past its first ${LINE_HEAD_BYTES} bytes, up to ${TITLE_LINE_MAX}, as a compressed log does`, async () => {
    const long = line.title(0, T, "t".repeat(TITLE_MAX), "provider");
    const seqs = providerTitle(0, "Fix the build", 150);
    for (const title of [long, seqs]) {
      expect(title.length).toBeGreaterThan(LINE_HEAD_BYTES);
      expect(title.length).toBeLessThanOrEqual(TITLE_LINE_MAX);
    }
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(long));
    expect((await readOnce(readerFor(files), files, PLAIN))?.title).toBe("t".repeat(TITLE_MAX));
    files.write(PLAIN, headerLine() + batch(seqs));
    const plainRead = await readOnce(readerFor(files), files, PLAIN);
    expect(plainRead).toMatchObject({ title: "Fix the build", mark: "ok" });
    if (HAS_ZSTD) {
      files.write(COMPRESSED, compressedLog(headerLine(), batch(seqs)));
      expect(await readOnce(readerFor(files), files, COMPRESSED)).toEqual(plainRead);
    }
  });

  test(`keeps a title line whose first ${LINE_HEAD_BYTES} bytes span two pieces`, async () => {
    const files = memoryFiles();
    const header = headerLine();
    // A first line whose end, and so the next line's start, falls 300 bytes before a piece ends.
    const empty = event("assistant/message", 0, T, { text: "" });
    const filler = event("assistant/message", 0, T, {
      text: "w".repeat(PIECE_BYTES - 300 - empty.length - 1),
    });
    const title = providerTitle(1, "Fix the build", 150);
    files.write(PLAIN, header + batch(filler, title));
    const reader = readerFor(files);
    expect((await readOnce(reader, files, PLAIN))?.title).toBe("Fix the build");
    // Its start is 300 bytes before the first piece's end.
    expect(header.length + filler.length + 1 + 300).toBe(header.length + PIECE_BYTES);
  });

  test(`a title line over ${TITLE_LINE_MAX} bytes gives no name`, async () => {
    const files = memoryFiles();
    const long = providerTitle(1, "Fix the build", 2000);
    expect(long.length).toBeGreaterThan(TITLE_LINE_MAX);
    files.write(PLAIN, headerLine() + batch(line.title(0, T, "First name", "provider"), long));
    expect((await readOnce(readerFor(files), files, PLAIN))?.title).toBeNull();
  });

  test("of a subagent keeps no title", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.title(0, T, "Child title", "provider")));
    expect((await readOnce(readerFor(files), files, PLAIN, false))?.title).toBeNull();
  });

  test(`longer than ${READ_MAX_PLAIN / 1024 / 1024} MiB is not read past its first line, and not opened again as it grows`, async () => {
    const files = memoryFiles();
    const header = headerLine();
    const big = new Uint8Array(READ_MAX_PLAIN + 1);
    big.set(new TextEncoder().encode(header));
    big.fill(0x0a, header.length);
    files.write(PLAIN, big);
    const reader = readerFor(files);
    expect(await readOnce(reader, files, PLAIN)).toMatchObject({
      mark: "too-long",
      turn: { state: "none" },
    });
    expect(Math.max(...files.reads.map((one) => one.position + one.length))).toBeLessThanOrEqual(
      HEADER_MAX_BYTES,
    );
    files.forget();
    files.append(PLAIN, "\n");
    expect(await reader.readOn(await refOf(files, PLAIN), true, NOW)).toMatchObject({
      mark: "too-long",
    });
    expect(files.count("openRegular")).toBe(0);
  });

  test("read before it grew too long keeps nothing of that read, as a fresh read of it", async () => {
    const files = memoryFiles();
    const start =
      headerLine() + batch(line.title(0, T, "Fix the build", "provider"), line.turnStart(1, T));
    files.write(PLAIN, start);
    const reader = readerFor(files);
    expect(await readOnce(reader, files, PLAIN)).toMatchObject({
      title: "Fix the build",
      turn: { state: "open" },
    });
    files.append(PLAIN, new Uint8Array(READ_MAX_PLAIN).fill(0x0a));
    const read = await reader.readOn(await refOf(files, PLAIN), true, NOW);
    expect(read).toMatchObject({ mark: "too-long", title: null, turn: { state: "none" } });
    expect(read).toEqual(await readOnce(readerFor(files), files, PLAIN));
    // Shorter again, past where it was read, with a line of no number: read from its first line, as a fresh read reads it.
    files.rewrite(PLAIN, `${start}\n`);
    const shorter = await reader.readOn(await refOf(files, PLAIN), true, NOW);
    expect(shorter).toMatchObject({
      mark: "ok",
      title: "Fix the build",
      turn: { state: "unsure" },
    });
    expect(shorter).toEqual(await readOnce(readerFor(files), files, PLAIN));
  });

  test("a read that fails leaves what was known, and is tried again", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    await readOnce(reader, files, PLAIN);
    files.append(PLAIN, batch(line.turnEnd(1, T + 1, "completed")));
    files.failOpen(PLAIN);
    expect((await reader.readOn(await refOf(files, PLAIN), true, NOW))?.turn.state).toBe("open");
    files.heal(PLAIN);
    expect((await reader.readOn(await refOf(files, PLAIN), true, NOW))?.turn.state).toBe("ended");
  });

  test("takes its time as it was opened, which can be later than its lstat's", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)), { mtimeMs: NOW - 5_000 });
    const reader = readerFor(files);
    const ref = await refOf(files, PLAIN);
    await reader.header(ref, NOW);
    files.append(PLAIN, batch(line.turnEnd(1, T + 1, "completed")), { mtimeMs: NOW - 1_000 });
    const read = await reader.readOn(
      { ...ref, info: { ...ref.info, size: ref.info.size + 1 } },
      true,
      NOW,
    );
    expect(read).toMatchObject({ writtenAt: NOW - 1_000, turn: { state: "ended" } });
  });

  test("replaced by another file between its lstat and its open is read from its start", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    const ref = await refOf(files, PLAIN);
    await reader.header(ref, NOW);
    await reader.readOn(ref, true, NOW);
    files.write(
      PLAIN,
      headerLine({ createdAt: STARTED_AT + 1 }) +
        batch(line.turnStart(0, T), line.turnEnd(1, T + 1, "error")),
    );
    const read = await reader.readOn(
      { ...ref, info: { ...ref.info, mtimeMs: ref.info.mtimeMs + 1 } },
      true,
      NOW,
    );
    expect(read).toMatchObject({ header: { createdAt: STARTED_AT + 1 }, turn: { end: "error" } });
  });
});

describe("a log replaced between its lstat and its open", () => {
  test("by one too long to read is not read past its first line", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine() + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    const ref = await refOf(files, PLAIN);
    await reader.header(ref, NOW);
    await reader.readOn(ref, true, NOW);
    const header = headerLine();
    const big = new Uint8Array(READ_MAX_PLAIN + 1);
    big.set(new TextEncoder().encode(header));
    big.fill(0x0a, header.length);
    files.write(PLAIN, big);
    files.forget();
    const read = await reader.readOn(
      { ...ref, info: { ...ref.info, mtimeMs: ref.info.mtimeMs + 1 } },
      true,
      NOW,
    );
    expect(read).toMatchObject({ mark: "too-long" });
    expect(Math.max(...files.reads.map((one) => one.position + one.length))).toBeLessThanOrEqual(
      HEADER_MAX_BYTES,
    );
  });
});

describe("a log's first line", () => {
  test(`is looked for in its first ${HEADER_FIRST_BYTES / 1024} KiB, then up to ${HEADER_MAX_BYTES / 1024} KiB`, async () => {
    const files = memoryFiles();
    const long = headerLine({ agentPreset: "p".repeat(10_000) });
    files.write(PLAIN, long + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    expect((await reader.header(await refOf(files, PLAIN), NOW)).state).toBe("ok");
    expect(files.reads.map((one) => [one.position, one.length])).toEqual([
      [0, HEADER_FIRST_BYTES],
      [0, long.length + batch(line.turnStart(0, T)).length],
    ]);
  });

  test(`over ${HEADER_MAX_BYTES / 1024} KiB leaves the session out, and one not yet whole is looked at again`, async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine({ agentPreset: "p".repeat(HEADER_MAX_BYTES) }));
    const reader = readerFor(files);
    expect(await reader.header(await refOf(files, PLAIN), NOW)).toEqual({ state: "bad" });
    expect(Math.max(...files.reads.map((one) => one.position + one.length))).toBe(HEADER_MAX_BYTES);
    expect(reader.needsHeader(await refOf(files, PLAIN))).toBe(false);

    const part = memoryFiles();
    part.write(PLAIN, headerLine().slice(0, 30));
    const partReader = readerFor(part);
    expect(await partReader.header(await refOf(part, PLAIN), NOW)).toEqual({ state: "later" });
    expect(partReader.needsHeader(await refOf(part, PLAIN))).toBe(true);
    expect(await partReader.readOn(await refOf(part, PLAIN), true, NOW)).toBeNull();
  });

  test("that is not a header DeepSeek Harness would read leaves the session out, until it is another file", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine({ version: 3 }) + batch(line.turnStart(0, T)));
    const reader = readerFor(files);
    expect(await reader.header(await refOf(files, PLAIN), NOW)).toEqual({ state: "bad" });
    expect(await reader.readOn(await refOf(files, PLAIN), true, NOW)).toBeNull();
    files.forget();
    expect(await reader.header(await refOf(files, PLAIN), NOW)).toEqual({ state: "bad" });
    expect(files.count("openRegular")).toBe(0);
  });

  test("a read that fails is tried again on the next poll", async () => {
    const files = memoryFiles();
    files.write(PLAIN, headerLine());
    files.failOpen(PLAIN);
    const reader = readerFor(files);
    expect(await reader.header(await refOf(files, PLAIN), NOW)).toEqual({ state: "later" });
    files.heal(PLAIN);
    expect((await reader.header(await refOf(files, PLAIN), NOW)).state).toBe("ok");
  });
});

describe.skipIf(!HAS_ZSTD)(`a compressed log (${NO_ZSTD_REASON} otherwise)`, () => {
  test("is read a frame at a time, with at most 8 MiB out of each, then only what was added", async () => {
    const files = memoryFiles();
    files.write(COMPRESSED, compressedLog(headerLine(), batch(line.turnStart(0, T))));
    const { decoder, calls } = countingDecoder();
    const reader = readerFor(files, decoder);
    expect((await readOnce(reader, files, COMPRESSED))?.turn).toMatchObject({ state: "open" });
    // Its first line with at most 64 KiB out of it, then its batch.
    expect(calls).toEqual([HEADER_MAX_BYTES, 8 * 1024 * 1024]);
    const size = (await files.io.lstat(COMPRESSED)).size;
    files.forget();
    files.append(COMPRESSED, frame(batch(line.turnEnd(1, T + 1, "completed"))));
    expect((await reader.readOn(await refOf(files, COMPRESSED), true, NOW))?.turn).toMatchObject({
      end: "completed",
    });
    expect(Math.min(...files.reads.map((one) => one.position))).toBe(size);
    expect(calls).toHaveLength(3);
  });

  test("whose first frame is more than its first line leaves the session out", async () => {
    const files = memoryFiles();
    files.write(COMPRESSED, frame(headerLine() + batch(line.turnStart(0, T))));
    expect(await readerFor(files).header(await refOf(files, COMPRESSED), NOW)).toEqual({
      state: "bad",
    });
  });

  test("leaves a frame still being written, and reads it once it is whole or once DeepSeek Harness repairs it", async () => {
    const files = memoryFiles();
    const whole = frame(batch(line.turnEnd(1, T + 1, "completed")));
    const start = compressedLog(headerLine(), batch(line.turnStart(0, T)));
    files.write(COMPRESSED, joined(start, whole.subarray(0, whole.byteLength - 3)));
    const reader = readerFor(files);
    expect((await readOnce(reader, files, COMPRESSED))?.turn.state).toBe("open");
    // The repair cuts the log back to where the frame began and writes what it held again.
    files.rewrite(COMPRESSED, start);
    expect((await reader.readOn(await refOf(files, COMPRESSED), true, NOW))?.turn.state).toBe(
      "open",
    );
    files.append(COMPRESSED, whole);
    expect((await reader.readOn(await refOf(files, COMPRESSED), true, NOW))?.turn).toMatchObject({
      end: "completed",
    });
  });

  test("passes over a frame that says it holds more than 8 MiB without undoing it, and reads the frames after it", async () => {
    const files = memoryFiles();
    const huge = frame(new Uint8Array(9 * 1024 * 1024).fill(0x0a));
    files.write(COMPRESSED, joined(compressedLog(headerLine(), batch(line.turnStart(0, T))), huge));
    const { decoder, calls } = countingDecoder();
    const reader = readerFor(files, decoder);
    expect((await readOnce(reader, files, COMPRESSED))?.turn).toEqual({ state: "unsure" });
    expect(calls).toHaveLength(2);
    // The next line's number is taken as it is, and the next turn's start settles it.
    files.append(COMPRESSED, frame(batch(line.turnStart(70_000, T + 2))));
    expect(await reader.readOn(await refOf(files, COMPRESSED), true, NOW)).toMatchObject({
      mark: "ok",
      turn: { state: "open", since: T + 2 },
    });
  });

  test("stops a frame that says nothing of its size once more than 8 MiB came out, and reads the frames after it", async () => {
    const files = memoryFiles();
    const huge = await streamedFrame([
      new Uint8Array(5 * 1024 * 1024).fill(0x0a),
      new Uint8Array(4 * 1024 * 1024).fill(0x0a),
    ]);
    files.write(
      COMPRESSED,
      joined(
        compressedLog(headerLine(), batch(line.turnStart(0, T))),
        huge,
        frame(batch(line.turnEnd(9, T + 1, "completed"))),
      ),
    );
    const read = await readOnce(readerFor(files), files, COMPRESSED);
    expect(read).toMatchObject({ mark: "ok", turn: { state: "ended", end: "completed" } });
  });

  test("a frame made by a stream that is not too large is read", async () => {
    const files = memoryFiles();
    const streamed = await streamedFrame([
      batch(line.turnStart(0, T)),
      batch(line.turnEnd(1, T + 1, "blocked")),
    ]);
    files.write(COMPRESSED, joined(frame(headerLine()), streamed));
    expect((await readOnce(readerFor(files), files, COMPRESSED))?.turn).toMatchObject({
      end: "blocked",
    });
  });

  test("a frame that cannot be undone, or is not DeepSeek Harness's, or does not end a line, makes it stuck until it is another file", async () => {
    const corrupt = new Uint8Array(frame(batch(line.turnStart(0, T))));
    corrupt[corrupt.byteLength - 1] ^= 0xff;
    const flagless = withDescriptor(frame(batch(line.turnStart(0, T))), 0x20);
    const unended = frame(line.turnStart(0, T));
    for (const bad of [corrupt, flagless, unended]) {
      const files = memoryFiles();
      files.write(COMPRESSED, joined(frame(headerLine()), bad));
      const reader = readerFor(files);
      expect(await readOnce(reader, files, COMPRESSED)).toMatchObject({ mark: "stuck" });
      files.forget();
      files.append(COMPRESSED, frame(batch(line.turnEnd(1, T + 1, "completed"))));
      expect(await reader.readOn(await refOf(files, COMPRESSED), true, NOW)).toMatchObject({
        mark: "stuck",
      });
      expect(files.count("openRegular")).toBe(0);
      files.write(COMPRESSED, compressedLog(headerLine(), batch(line.turnStart(0, T))));
      expect(await readOnce(reader, files, COMPRESSED)).toMatchObject({ mark: "ok" });
    }
  });

  test("stuck after it was read keeps nothing of that read, as a fresh read of it", async () => {
    const titled = compressedLog(
      headerLine(),
      batch(line.title(0, T, "Fix the build", "provider"), line.turnStart(1, T)),
    );
    const flagless = withDescriptor(frame(batch(line.turnEnd(2, T + 1, "completed"))), 0x20);
    const unended = frame(line.turnEnd(2, T + 1, "completed"));
    for (const bad of [flagless, unended]) {
      const files = memoryFiles();
      files.write(COMPRESSED, titled);
      const reader = readerFor(files);
      expect((await readOnce(reader, files, COMPRESSED))?.title).toBe("Fix the build");
      files.append(COMPRESSED, bad);
      const read = await reader.readOn(await refOf(files, COMPRESSED), true, NOW);
      expect(read).toMatchObject({ mark: "stuck", title: null, turn: { state: "none" } });
      expect(read).toEqual(await readOnce(readerFor(files), files, COMPRESSED));
      // Shorter again: read on from its first line, as a fresh read reads on, not from its start.
      files.rewrite(COMPRESSED, titled);
      files.forget();
      const shorter = await reader.readOn(await refOf(files, COMPRESSED), true, NOW);
      expect(shorter).toMatchObject({
        mark: "ok",
        title: "Fix the build",
        turn: { state: "open" },
      });
      expect(files.reads.every((one) => one.position > 0)).toBe(true);
      expect(shorter).toEqual(await readOnce(readerFor(files), files, COMPRESSED));
    }
  });

  test("whose bytes after the last read do not begin a frame is read from its start again", async () => {
    const files = memoryFiles();
    const log = compressedLog(headerLine(), batch(line.turnStart(0, T)));
    files.write(COMPRESSED, log);
    const reader = readerFor(files);
    await readOnce(reader, files, COMPRESSED);
    // A longer second frame, so what was read ends inside it.
    files.rewrite(
      COMPRESSED,
      joined(
        frame(headerLine()),
        frame(batch(line.userMessage(0, T + 6), line.turnStart(1, T + 7))),
        frame(batch(line.turnEnd(2, T + 8, "completed"))),
      ),
    );
    files.forget();
    const read = await reader.readOn(await refOf(files, COMPRESSED), true, NOW);
    expect(read).toMatchObject({ mark: "ok", turn: { end: "completed" } });
    expect(files.reads.some((one) => one.position === 0)).toBe(true);
  });

  test(`longer than ${READ_MAX_COMPRESSED / 1024 / 1024} MiB is not read past its first line`, async () => {
    const files = memoryFiles();
    const first = frame(headerLine());
    const big = new Uint8Array(READ_MAX_COMPRESSED + 1);
    big.set(first);
    files.write(COMPRESSED, big);
    const { decoder, calls } = countingDecoder();
    const reader = readerFor(files, decoder);
    expect(await readOnce(reader, files, COMPRESSED)).toMatchObject({ mark: "too-long" });
    expect(calls).toEqual([HEADER_MAX_BYTES]);
  });

  test("with no decoder, is not read at all", async () => {
    const files = memoryFiles();
    files.write(COMPRESSED, compressedLog(headerLine(), batch(line.turnStart(0, T))));
    const reader = readerFor(files, null);
    expect(await reader.header(await refOf(files, COMPRESSED), NOW)).toEqual({ state: "bad" });
  });
});
