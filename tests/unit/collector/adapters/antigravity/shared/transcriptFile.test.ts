import { describe, expect, test } from "vitest";

import {
  createTranscriptReader,
  parseStepTime,
  readStepLine,
  TAIL_LIMIT_BYTES,
} from "@collector/adapters/antigravity/shared/transcriptFile";
import { ANTIGRAVITY_STEP_TYPES } from "@core/mapping/antigravityMapping";
import {
  AGY_HOME,
  checkpoint,
  conversationId,
  failedTurn,
  finishedTurn,
  NOW,
  PRIVATE_WORDS,
  SECOND,
  step,
  transcriptPath,
  workingTurn,
  type ReplyCounts,
} from "@tests/fixtures/antigravity";
import { memoryFiles } from "@tests/support/adapters/antigravityAdapter";

const FILE = transcriptPath(AGY_HOME, conversationId("a1"));
const START = NOW - 60 * SECOND;

function setUp(content: string) {
  const files = memoryFiles(() => NOW);
  files.write(FILE, content);
  const reader = createTranscriptReader(files.io);
  const read = async () => reader.read(FILE, await files.io.lstat(FILE));
  return { files, reader, read };
}

describe("readStepLine", () => {
  test("keeps the type, the status, whether there are tool calls, the index and the time, and nothing else", () => {
    const line = step({ index: 3, type: "PLANNER_RESPONSE", at: START, tools: ["run_command"] });
    expect(line).toContain(PRIVATE_WORDS);
    const kept = readStepLine(line);
    expect(kept).toEqual({
      index: 3,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      toolCalls: true,
      at: START,
    });
    expect(JSON.stringify(kept)).not.toContain("rename");
    expect(JSON.stringify(kept)).not.toContain("npm test");
  });

  test("an empty list of tool calls is none, and a step index that is not a whole number is not known", () => {
    expect(readStepLine('{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[]}')).toEqual({
      index: null,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      toolCalls: false,
      at: null,
    });
    expect(readStepLine('{"step_index":-1,"type":"USER_INPUT"}')?.index).toBeNull();
    expect(readStepLine('{"step_index":1.5,"type":"USER_INPUT"}')?.index).toBeNull();
    expect(readStepLine('{"step_index":"2","type":"USER_INPUT"}')?.index).toBeNull();
  });

  test("a line that is not a step is passed over", () => {
    for (const line of [
      "",
      "not json",
      '{"type":"USER_INPUT"',
      "[1,2]",
      '"USER_INPUT"',
      "null",
      '{"content":"no type or status"}',
      '{"type":7,"status":false}',
    ]) {
      expect(readStepLine(line), line).toBeNull();
    }
  });

  test("keeps a reply's token counts: the whole prompt is the part not read from a cache and the part read from one", () => {
    const line = step({
      index: 3,
      type: "PLANNER_RESPONSE",
      at: START,
      counts: { input_tokens: 3_120, cache_read_tokens: 12_288, output_tokens: 412 },
    });
    expect(line).toContain(PRIVATE_WORDS);
    const kept = readStepLine(line);
    expect(kept).toEqual({
      index: 3,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      toolCalls: false,
      at: START,
      tokens: { input: 15_408, cached: 12_288, output: 412 },
    });
    expect(JSON.stringify(kept)).not.toContain("rename");
    expect(JSON.stringify(kept)).not.toContain("thinking");
  });

  test("a reply with no cache count counts it as 0 and leaves the cached part out", () => {
    const kept = readStepLine(
      step({
        index: 1,
        type: "PLANNER_RESPONSE",
        at: START,
        counts: { input_tokens: 900, output_tokens: 40 },
      }),
    );
    expect(kept?.tokens).toEqual({ input: 900, output: 40 });
    expect(kept?.tokens).not.toHaveProperty("cached");
  });

  test("a reply all read from a cache still has its whole prompt as its input", () => {
    const counts = { input_tokens: 0, cache_read_tokens: 6_144, output_tokens: 18 };
    expect(readStepLine(step({ index: 1, type: "PLANNER_RESPONSE", at: START, counts }))).toEqual(
      expect.objectContaining({ tokens: { input: 6_144, cached: 6_144, output: 18 } }),
    );
  });

  test.each<[string, ReplyCounts]>([
    ["an input that is text", { input_tokens: "900", cache_read_tokens: 0, output_tokens: 40 }],
    ["no input", { cache_read_tokens: 100, output_tokens: 40 }],
    ["a negative input", { input_tokens: -1, cache_read_tokens: 100, output_tokens: 40 }],
    [
      "a cache count that is not whole",
      { input_tokens: 900, cache_read_tokens: 1.5, output_tokens: 40 },
    ],
    [
      "a cache count that is null",
      { input_tokens: 900, cache_read_tokens: null, output_tokens: 40 },
    ],
    ["a negative cache count", { input_tokens: 900, cache_read_tokens: -5, output_tokens: 40 }],
    ["no output", { input_tokens: 900, cache_read_tokens: 100 }],
    ["an output that is text", { input_tokens: 900, cache_read_tokens: 100, output_tokens: "40" }],
    ["no prompt at all", { input_tokens: 0, cache_read_tokens: 0, output_tokens: 0 }],
    [
      "a prompt too large to be exact",
      { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_tokens: 1, output_tokens: 40 },
    ],
  ])("a reply with %s says its counts could not be right", (_what, counts) => {
    const kept = readStepLine(step({ index: 1, type: "PLANNER_RESPONSE", at: START, counts }));
    expect(kept).toMatchObject({ type: "PLANNER_RESPONSE", status: "DONE" });
    expect(kept?.tokens).toBeNull();
  });

  test("only a reply's line has counts: a reply that names none, and any other step, has none", () => {
    expect(
      readStepLine(step({ index: 1, type: "PLANNER_RESPONSE", at: START })),
    ).not.toHaveProperty("tokens");
    const counts = { input_tokens: 900, cache_read_tokens: 100, output_tokens: 40 };
    for (const type of ["USER_INPUT", "RUN_COMMAND", "ERROR_MESSAGE", "CHECKPOINT"]) {
      expect(readStepLine(step({ index: 1, type, at: START, counts })), type).not.toHaveProperty(
        "tokens",
      );
    }
  });

  test("times are ISO 8601, in UTC or with an offset, to the nanosecond", () => {
    expect(parseStepTime("2026-10-01T12:00:00Z")).toBe(NOW);
    expect(parseStepTime("2026-10-01T12:00:00.123456789Z")).toBe(NOW + 123);
    expect(parseStepTime("2026-10-01T14:00:00+02:00")).toBe(NOW);
    for (const value of [
      "2026-10-01",
      "yesterday",
      "2026-10-01 12:00:00",
      1_790_856_000_000,
      null,
    ]) {
      expect(parseStepTime(value)).toBeNull();
    }
  });
});

describe("a transcript", () => {
  test("whose turn is over is idle since the last reply, and began with its first step", async () => {
    const { read } = setUp(finishedTurn(0, START).join(""));
    expect(await read()).toEqual({
      firstAt: START,
      last: {
        index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        toolCalls: false,
        at: START + 4 * SECOND,
      },
      since: START + 4 * SECOND,
      lastAt: START + 4 * SECOND,
      lastIndex: 3,
      tokens: null,
    });
  });

  test("gives the index of its last step, read whole or onward, passing over steps agy cleared", async () => {
    const { files, read } = setUp(finishedTurn(0, START).join(""));
    expect((await read()).lastIndex).toBe(3);
    // agy went back and cleared a step: what it writes next counts from where it went on.
    files.append(
      FILE,
      step({ index: 9, type: "PLANNER_RESPONSE", status: "CLEARED", at: START + 5 * SECOND }) +
        step({ index: 4, type: "USER_INPUT", at: START + 6 * SECOND }),
      { mtimeMs: NOW + 1 },
    );
    expect((await read()).lastIndex).toBe(4);
    const fresh = setUp(
      [
        ...finishedTurn(0, START),
        step({ index: 9, type: "PLANNER_RESPONSE", status: "CLEARED", at: START + 5 * SECOND }),
      ].join(""),
    );
    expect((await fresh.read()).lastIndex).toBe(3);
  });

  test("whose turn goes on is working since the person's prompt", async () => {
    const { read } = setUp(
      [...finishedTurn(0, START - 600 * SECOND), ...workingTurn(4, START)].join(""),
    );
    const state = await read();
    expect(state.last).toMatchObject({ type: "RUN_COMMAND", status: "RUNNING" });
    expect(state.since).toBe(START);
    expect(state.firstAt).toBe(START - 600 * SECOND);
  });

  test("that ended on an error is failed since the error", async () => {
    const { read } = setUp(failedTurn(0, START).join(""));
    const state = await read();
    expect(state.last).toMatchObject({ type: "ERROR_MESSAGE" });
    expect(state.since).toBe(START + SECOND);
  });

  test("passes over the steps that say nothing of whose turn it is, and steps that were cleared", async () => {
    const { read } = setUp(
      [
        ...finishedTurn(0, START),
        step({ index: 4, type: "CHECKPOINT", at: START + 5 * SECOND }),
        step({ index: 5, type: "RUN_COMMAND", status: "CLEARED", at: START + 6 * SECOND }),
        step({ index: 6, type: "SUGGESTED_RESPONSES", at: START + 7 * SECOND }),
        step({ index: 7, type: "EPHEMERAL_MESSAGE", source: "SYSTEM", at: START + 8 * SECOND }),
      ].join(""),
    );
    const state = await read();
    expect(state.last).toMatchObject({ index: 3, type: "PLANNER_RESPONSE" });
    expect(state.since).toBe(START + 4 * SECOND);
    // The last step of any kind still says when agy last wrote a step.
    expect(state.lastAt).toBe(START + 8 * SECOND);
  });

  test("with no steps, or only steps passed over, has none", async () => {
    expect((await setUp("").read()).last).toBeNull();
    const asides = setUp(step({ index: 0, type: "CONVERSATION_HISTORY", at: START }));
    expect(await asides.read()).toMatchObject({ last: null, lastAt: START });
  });

  test("passes over a broken line, as agy can leave when it compacts", async () => {
    const lines = finishedTurn(0, START);
    lines.splice(2, 0, '{"step_index":2,"type":"RUN_COMM\n');
    const { read } = setUp(lines.join(""));
    expect((await read()).last).toMatchObject({ index: 3, type: "PLANNER_RESPONSE" });
  });

  test("leaves a last line that is still being written for later, and takes it once it is whole", async () => {
    const done = finishedTurn(0, START).join("");
    const next = step({ index: 4, type: "USER_INPUT", at: START + 10 * SECOND });
    const { files, read } = setUp(done + next.slice(0, 20));
    expect((await read()).last).toMatchObject({ index: 3 });

    files.append(FILE, next.slice(20));
    const state = await read();
    expect(state.last).toMatchObject({ index: 4, type: "USER_INPUT" });
    expect(state.since).toBe(START + 10 * SECOND);
  });

  test("takes a whole last step that has no newline yet, and reading its newline later changes nothing", async () => {
    const lines = finishedTurn(0, START);
    const last = lines.pop() as string;
    const { files, read } = setUp(lines.join("") + last.trimEnd());
    const first = await read();
    expect(first.last).toMatchObject({ index: 3, type: "PLANNER_RESPONSE" });

    files.append(FILE, "\n");
    expect(await read()).toEqual(first);
  });

  test("reads only what agy added since the last read", async () => {
    const { files, read } = setUp(finishedTurn(0, START).join(""));
    await read();
    const size = (await files.io.lstat(FILE)).size;
    files.forget();

    files.append(FILE, workingTurn(4, START + 30 * SECOND).join(""));
    const state = await read();
    expect(state.last).toMatchObject({ index: 6, status: "RUNNING" });
    expect(state.since).toBe(START + 30 * SECOND);
    // The first 4 KiB are hashed again, then only the bytes after the old end are read.
    expect(files.reads.some((range) => range.position === size - 1)).toBe(true);
    expect(files.reads.every((range) => range.position === 0 || range.position >= size - 1)).toBe(
      true,
    );

    files.forget();
    await read();
    expect(files.count("openRegular")).toBe(0);
  });

  test("is read afresh once agy rewrites it as it compacts the conversation", async () => {
    const { files, read } = setUp(
      [...finishedTurn(0, START), ...finishedTurn(4, START + 30 * SECOND)].join(""),
    );
    expect((await read()).firstAt).toBe(START);

    // Shorter: the earlier steps folded into one.
    files.rewrite(
      FILE,
      [
        step({ index: 0, type: "CONVERSATION_HISTORY", at: START + 60 * SECOND }),
        ...workingTurn(1, START + 61 * SECOND),
      ].join(""),
    );
    const shorter = await read();
    expect(shorter.last).toMatchObject({ type: "RUN_COMMAND", status: "RUNNING" });
    expect(shorter.since).toBe(START + 61 * SECOND);
    // The file now begins later than the conversation did, which was seen before.
    expect(shorter.firstAt).toBe(START);
  });

  test("rewritten longer, in place, is noticed by its start", async () => {
    const { files, read } = setUp(finishedTurn(0, START).join(""));
    await read();
    files.rewrite(
      FILE,
      [
        step({ index: 0, type: "CONVERSATION_HISTORY", at: START + 60 * SECOND }),
        ...failedTurn(1, START + 61 * SECOND),
        ...failedTurn(3, START + 62 * SECOND),
        ...failedTurn(5, START + 63 * SECOND),
      ].join(""),
    );
    const state = await read();
    expect(state.last).toMatchObject({ index: 6, type: "ERROR_MESSAGE" });
    expect(state.since).toBe(START + 64 * SECOND);
  });

  test("does not say when it began unless it begins with step 0", async () => {
    const { read } = setUp(finishedTurn(7, START).join(""));
    expect((await read()).firstAt).toBeNull();
  });

  test("reads at most its last 2 MiB, and says no more than that part shows", async () => {
    const filler = step({
      index: 5,
      type: "EPHEMERAL_MESSAGE",
      source: "SYSTEM",
      at: START + 10 * SECOND,
    });
    const many = filler.repeat(Math.ceil((TAIL_LIMIT_BYTES + 1) / filler.length));
    const { files, read } = setUp(finishedTurn(0, START).join("") + many);
    const state = await read();
    expect(state.last).toBeUndefined();
    expect(state.lastAt).toBe(START + 10 * SECOND);
    const read_ = files.reads.filter((range) => range.position > 0);
    expect(read_.reduce((sum, range) => sum + range.length, 0)).toBeLessThanOrEqual(
      TAIL_LIMIT_BYTES,
    );
  });

  test("a file that grew by more than 2 MiB after it was looked at is read afresh, within the limit", async () => {
    const { files, reader, read } = setUp(finishedTurn(0, START).join(""));
    await read();
    files.append(FILE, step({ index: 4, type: "USER_INPUT", at: START + 9 * SECOND }));
    // What the poll's `lstat` said, a moment before agy wrote a great deal more.
    const looked = await files.io.lstat(FILE);
    const tool = step({ index: 5, type: "VIEW_FILE", at: START + 10 * SECOND });
    files.append(FILE, tool.repeat(Math.ceil((TAIL_LIMIT_BYTES + 1) / tool.length)));
    files.forget();

    const state = await reader.read(FILE, looked);
    expect(state.last).toMatchObject({ type: "VIEW_FILE" });
    expect(files.reads.every((range) => range.length <= TAIL_LIMIT_BYTES)).toBe(true);
    const tail = files.reads.filter((range) => range.position > 0);
    expect(tail.reduce((sum, range) => sum + range.length, 0)).toBeLessThanOrEqual(
      TAIL_LIMIT_BYTES,
    );
  });

  test("a working run longer than the part read has no known start", async () => {
    const tool = step({ index: 9, type: "VIEW_FILE", at: START + 10 * SECOND });
    const many = tool.repeat(Math.ceil((TAIL_LIMIT_BYTES + 1) / tool.length));
    const { read } = setUp(workingTurn(0, START).join("") + many);
    const state = await read();
    expect(state.last).toMatchObject({ type: "VIEW_FILE" });
    expect(state.since).toBeNull();
  });

  test("that is not an ordinary file is not read", async () => {
    const files = memoryFiles(() => NOW);
    files.special(FILE);
    const reader = createTranscriptReader(files.io);
    await expect(reader.read(FILE, await files.io.lstat(FILE))).rejects.toThrow();
    expect(files.openHandles()).toBe(0);
  });

  test("closes every file it opens", async () => {
    const { files, read } = setUp(finishedTurn(0, START).join(""));
    await read();
    files.append(FILE, step({ index: 4, type: "USER_INPUT", at: START + 9 * SECOND }));
    await read();
    expect(files.openHandles()).toBe(0);
  });
});

describe("the newest reply's token counts", () => {
  const A = { input_tokens: 2_048, cache_read_tokens: 10_240, output_tokens: 96 };
  const B = { input_tokens: 1_536, cache_read_tokens: 14_336, output_tokens: 288 };
  const C = { input_tokens: 4_096, cache_read_tokens: 16_384, output_tokens: 512 };
  const counts = (reply: ReplyCounts) => ({
    input: (reply.input_tokens as number) + (reply.cache_read_tokens as number),
    cached: reply.cache_read_tokens,
    output: reply.output_tokens,
  });
  const reply = (index: number, at: number, given: ReplyCounts, tools?: string[]) =>
    step({ index, type: "PLANNER_RESPONSE", at, counts: given, tools });

  test("are the newest reply's, which a tool step after it keeps, on the first read and on each read onward", async () => {
    const { files, read } = setUp(
      [
        step({ index: 0, type: "USER_INPUT", at: START }),
        reply(1, START + SECOND, A, ["run_command"]),
        step({ index: 2, type: "RUN_COMMAND", at: START + 2 * SECOND }),
        reply(3, START + 3 * SECOND, B, ["view_file"]),
        step({ index: 4, type: "VIEW_FILE", status: "RUNNING", at: START + 4 * SECOND }),
      ].join(""),
    );
    const first = await read();
    expect(first.tokens).toEqual(counts(B));
    // The last step is still the tool step, and the counts did not move it.
    expect(first.last).toMatchObject({ index: 4, type: "VIEW_FILE" });
    expect(first.since).toBe(START);

    const size = (await files.io.lstat(FILE)).size;
    files.forget();
    files.append(FILE, step({ index: 5, type: "VIEW_FILE", at: START + 5 * SECOND }));
    expect((await read()).tokens).toEqual(counts(B));

    files.append(FILE, reply(6, START + 6 * SECOND, C));
    const state = await read();
    expect(state.tokens).toEqual(counts(C));
    expect(state.last).toMatchObject({ index: 6, type: "PLANNER_RESPONSE", toolCalls: false });
    // Both were read onward: past the hashed start, only from the end of what was read before.
    expect(files.reads.every((range) => range.position === 0 || range.position >= size - 1)).toBe(
      true,
    );
  });

  test("a newest reply whose counts could not be right gives none, never an older reply's", async () => {
    const broken = { input_tokens: 900, cache_read_tokens: "lots", output_tokens: 40 };
    const fresh = setUp(
      [
        step({ index: 0, type: "USER_INPUT", at: START }),
        reply(1, START + SECOND, A, ["run_command"]),
        step({ index: 2, type: "RUN_COMMAND", at: START + 2 * SECOND }),
        reply(3, START + 3 * SECOND, broken),
      ].join(""),
    );
    expect((await fresh.read()).tokens).toBeNull();

    const onward = setUp(finishedTurn(0, START).join("") + reply(4, START + 5 * SECOND, A));
    expect((await onward.read()).tokens).toEqual(counts(A));
    onward.files.append(FILE, reply(5, START + 6 * SECOND, broken));
    expect((await onward.read()).tokens).toBeNull();
    onward.files.append(FILE, reply(6, START + 7 * SECOND, B));
    expect((await onward.read()).tokens).toEqual(counts(B));
  });

  test("a reply that names no counts says nothing of them, and one agy cleared is passed over", async () => {
    const lines = [
      step({ index: 0, type: "USER_INPUT", at: START }),
      reply(1, START + SECOND, A),
      step({ index: 2, type: "USER_INPUT", at: START + 10 * SECOND }),
      step({ index: 3, type: "PLANNER_RESPONSE", status: "GENERATING", at: START + 11 * SECOND }),
      step({
        index: 9,
        type: "PLANNER_RESPONSE",
        status: "CLEARED",
        at: START + 12 * SECOND,
        counts: B,
      }),
    ];
    const fresh = setUp(lines.join(""));
    expect((await fresh.read()).tokens).toEqual(counts(A));

    const onward = setUp(lines.slice(0, 2).join(""));
    await onward.read();
    onward.files.append(FILE, lines.slice(2).join(""));
    const state = await onward.read();
    expect(state.tokens).toEqual(counts(A));
    expect(state.last).toMatchObject({ index: 3, status: "GENERATING" });
  });

  test("a turn just begun has the counts of the reply that ended the one before, even past an error", async () => {
    const { read } = setUp(
      [
        step({ index: 0, type: "USER_INPUT", at: START }),
        reply(1, START + SECOND, A),
        step({ index: 2, type: "USER_INPUT", at: START + 10 * SECOND }),
        reply(3, START + 11 * SECOND, B, ["run_command"]),
        step({ index: 4, type: "RUN_COMMAND", at: START + 12 * SECOND }),
        step({ index: 5, type: "ERROR_MESSAGE", source: "SYSTEM", at: START + 13 * SECOND }),
        step({ index: 6, type: "EPHEMERAL_MESSAGE", source: "SYSTEM", at: START + 14 * SECOND }),
        step({ index: 7, type: "USER_INPUT", at: START + 20 * SECOND }),
      ].join(""),
    );
    const state = await read();
    expect(state.tokens).toEqual(counts(B));
    // Looking past the run's start for the counts changes nothing else the read says.
    expect(state).toMatchObject({
      last: { index: 7, type: "USER_INPUT" },
      since: START + 20 * SECOND,
      lastAt: START + 20 * SECOND,
      lastIndex: 7,
    });
  });

  test("a transcript with no counts at all has none", async () => {
    const { read } = setUp(
      [...finishedTurn(0, START), ...workingTurn(4, START + 60 * SECOND)].join(""),
    );
    expect((await read()).tokens).toBeNull();
  });

  /** A transcript whose only counted reply is `before` bytes of tool steps before the steps that end it. */
  function withReplyBefore(before: number): string {
    const filler = step({ index: 2, type: "VIEW_FILE", at: START + 2 * SECOND });
    const lines = [step({ index: 0, type: "USER_INPUT", at: START }), reply(1, START + SECOND, A)];
    for (let size = 0; size < before; size += filler.length) lines.push(filler);
    lines.push(
      step({ index: 3, type: "ERROR_MESSAGE", source: "SYSTEM", at: START + 3 * SECOND }),
      step({ index: 4, type: "USER_INPUT", at: START + 4 * SECOND }),
    );
    return lines.join("");
  }

  /** How much of the file's end a fresh read took, beside its start. */
  function tailRead(files: ReturnType<typeof setUp>["files"]): number {
    return files.reads
      .filter((range) => range.position > 0)
      .reduce((sum, range) => sum + range.length, 0);
  }

  test("past the run's start, the counts are looked for in 256 KiB more, and no further", async () => {
    const PIECE = 64 * 1024;
    const LOOK_BACK = 256 * 1024;

    // Within 256 KiB: found.
    const near = setUp(withReplyBefore(200 * 1024));
    expect((await near.read()).tokens).toEqual(counts(A));

    // A reply's line holds its content and thinking, so it can be longer than
    // a piece. One just before the run's start is found too.
    const longReply = JSON.parse(reply(1, START + SECOND, A, ["run_command"])) as object;
    const long = setUp(
      [
        step({ index: 0, type: "USER_INPUT", at: START }),
        `${JSON.stringify({ ...longReply, content: "word ".repeat(32 * 1024) })}\n`,
        step({ index: 2, type: "RUN_COMMAND", at: START + 2 * SECOND }),
        step({ index: 3, type: "ERROR_MESSAGE", source: "SYSTEM", at: START + 3 * SECOND }),
      ].join(""),
    );
    const failed = await long.read();
    expect(failed.last).toMatchObject({ index: 3, type: "ERROR_MESSAGE" });
    expect(failed.tokens).toEqual(counts(A));

    // Further back: not looked for, so a transcript with no counts near its end
    // costs 256 KiB more than its last steps did, not the whole tail limit.
    const far = setUp(withReplyBefore(1024 * 1024));
    const state = await far.read();
    expect(state.last).toMatchObject({ index: 4, type: "USER_INPUT" });
    expect(state.since).toBe(START + 4 * SECOND);
    expect(state.tokens).toBeNull();
    expect(tailRead(far.files)).toBe(PIECE + LOOK_BACK);
  });

  test("the steps read past the run's start, only for a reply's counts, give no time and no index", async () => {
    // The steps up to the one that settles the run have no `created_at` and no
    // `step_index`; the reply further back has both.
    const untimed = (fields: Record<string, unknown>) =>
      `${JSON.stringify({ ...fields, content: PRIVATE_WORDS })}\n`;
    const { read } = setUp(
      [
        step({ index: 0, type: "USER_INPUT", at: START }),
        reply(1, START + SECOND, A, ["run_command"]),
        untimed({ type: "ERROR_MESSAGE", status: "DONE", source: "SYSTEM" }),
        untimed({ type: "USER_INPUT", status: "DONE", source: "USER_EXPLICIT" }),
      ].join(""),
    );
    const state = await read();
    expect(state.tokens).toEqual(counts(A));
    expect(state).toMatchObject({
      last: { index: null, type: "USER_INPUT" },
      since: null,
      lastAt: null,
      lastIndex: null,
    });
  });
});

describe("a finished checkpoint", () => {
  const A = { input_tokens: 2_048, cache_read_tokens: 10_240, output_tokens: 96 };
  const B = { input_tokens: 1_536, cache_read_tokens: 512, output_tokens: 288 };
  const COUNTS_A = { input: 12_288, cached: 10_240, output: 96 };
  const COUNTS_B = { input: 2_048, cached: 512, output: 288 };
  const reply = (index: number, at: number, given?: ReplyCounts, tools?: string[]) =>
    step({ index, type: "PLANNER_RESPONSE", at, counts: given, tools });
  const prompt = (index: number, at: number) => step({ index, type: "USER_INPUT", at });
  /** A turn that ended on a reply with counts. */
  const turn = [prompt(0, START), reply(1, START + SECOND, A)];
  /** A turn still going, its newest reply's counts those of A. */
  const toolTurn = [
    prompt(0, START),
    reply(1, START + SECOND, A, ["run_command"]),
    step({ index: 2, type: "RUN_COMMAND", at: START + 2 * SECOND }),
  ];

  /** What it is, the lines read first, the lines added one by one, and the counts after each. */
  const cases: [string, string[], string[], (typeof COUNTS_A | null)[]][] = [
    [
      "after a bare /compact, until the next turn's reply",
      turn,
      [
        prompt(2, START + 9 * SECOND),
        checkpoint(3, START + 10 * SECOND),
        prompt(4, START + 60 * SECOND),
        reply(5, START + 61 * SECOND, B),
      ],
      [COUNTS_A, null, null, COUNTS_B],
    ],
    [
      "after /compact with a message, until the reply to it",
      [...turn, prompt(2, START + 9 * SECOND)],
      [checkpoint(3, START + 10 * SECOND), reply(4, START + 11 * SECOND, B)],
      [null, COUNTS_B],
    ],
    [
      "in the middle of a turn, as agy compacts on its own, until the turn's next reply",
      toolTurn,
      [
        checkpoint(3, START + 10 * SECOND),
        step({ index: 4, type: "VIEW_FILE", at: START + 11 * SECOND }),
        reply(5, START + 12 * SECOND, B),
        step({ index: 6, type: "EPHEMERAL_MESSAGE", source: "SYSTEM", at: START + 13 * SECOND }),
      ],
      [null, null, COUNTS_B, COUNTS_B],
    ],
    [
      "twice in a row",
      turn,
      [
        checkpoint(2, START + 10 * SECOND),
        checkpoint(3, START + 20 * SECOND),
        reply(4, START + 30 * SECOND, B),
        checkpoint(5, START + 40 * SECOND),
      ],
      [null, null, COUNTS_B, null],
    ],
    [
      "which a reply that names no counts, or one agy cleared, does not bring back",
      turn,
      [
        checkpoint(2, START + 10 * SECOND),
        reply(3, START + 11 * SECOND),
        step({
          index: 4,
          type: "PLANNER_RESPONSE",
          status: "CLEARED",
          at: START + 12 * SECOND,
          counts: B,
        }),
        reply(5, START + 13 * SECOND, { ...B, output_tokens: "lots" }),
      ],
      [null, null, null, null],
    ],
    [
      "written with the prefix agy's program uses, in any case",
      turn,
      [
        step({
          index: 2,
          type: "cortex_step_type_checkpoint",
          status: "cortex_step_status_done",
          at: START + 10 * SECOND,
        }),
      ],
      [null],
    ],
  ];

  test.each(cases)("clears the counts: %s", async (_what, before, after, expected) => {
    const onward = setUp(before.join(""));
    expect((await onward.read()).tokens).toEqual(COUNTS_A);
    for (const [index, line] of after.entries()) {
      onward.files.append(FILE, line);
      const state = await onward.read();
      expect(state.tokens, line).toEqual(expected[index]);
      // A first read of the same file says the same, of the counts and of everything else.
      const fresh = setUp([...before, ...after.slice(0, index + 1)].join(""));
      expect(await fresh.read(), line).toEqual(state);
      expect(JSON.stringify(state)).not.toContain(PRIVATE_WORDS);
    }
    // Read onward all at once, it says the same too.
    const atOnce = setUp(before.join(""));
    await atOnce.read();
    atOnce.files.append(FILE, after.join(""));
    expect(await atOnce.read()).toEqual(await onward.read());
  });

  test.each([
    ["is PENDING", "PENDING"],
    ["is RUNNING", "RUNNING"],
    ["is GENERATING", "GENERATING"],
    ["is WAITING", "WAITING"],
    ["is QUEUED", "QUEUED"],
    ["is CANCELED", "CANCELED"],
    ["is INTERRUPTED", "INTERRUPTED"],
    ["is ERROR", "ERROR"],
    ["is CLEARED", "CLEARED"],
    ["is INVALID", "INVALID"],
    ["is UNSPECIFIED", "UNSPECIFIED"],
    ["has a status this adapter does not know", "COMPLETED"],
    ["has a status that only begins as DONE", "DONE_WITH_ERRORS"],
    ["has an empty status", ""],
    ["has a status that is no word", 3],
    ["has no status", undefined],
  ])("that %s is not a finished one, and leaves the counts as they were", async (_what, status) => {
    const line = `${JSON.stringify({ ...(JSON.parse(checkpoint(2, START + 10 * SECOND)) as object), status })}\n`;
    const onward = setUp(turn.join(""));
    await onward.read();
    onward.files.append(FILE, line);
    const state = await onward.read();
    expect(state.tokens).toEqual(COUNTS_A);
    const fresh = setUp([...turn, line].join(""));
    expect(await fresh.read()).toEqual(state);
  });

  test("is the only finished step that clears the counts", async () => {
    const types = [
      ...ANTIGRAVITY_STEP_TYPES.filter(
        (type) => type !== "CHECKPOINT" && type !== "PLANNER_RESPONSE",
      ),
      "CHECKPOINTS",
      "CHECKPOINT_REVERTED",
      "PRE_CHECKPOINT",
    ];
    for (const type of types) {
      const line = step({ index: 2, type, at: START + 10 * SECOND, counts: B });
      const onward = setUp(turn.join(""));
      await onward.read();
      onward.files.append(FILE, line);
      const state = await onward.read();
      expect(state.tokens, type).toEqual(COUNTS_A);
      const fresh = setUp([...turn, line].join(""));
      expect(await fresh.read(), type).toEqual(state);
    }
  });

  test("is still passed over for the status, and counts for when agy last wrote a step", async () => {
    const idle = setUp([...turn, checkpoint(2, START + 10 * SECOND)].join(""));
    expect(await idle.read()).toEqual({
      firstAt: START,
      last: {
        index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        toolCalls: false,
        at: START + SECOND,
        tokens: COUNTS_A,
      },
      since: START + SECOND,
      lastAt: START + 10 * SECOND,
      lastIndex: 2,
      tokens: null,
    });

    const working = setUp([...toolTurn, checkpoint(3, START + 10 * SECOND)].join(""));
    expect(await working.read()).toMatchObject({
      last: { index: 2, type: "RUN_COMMAND" },
      since: START,
      tokens: null,
    });
  });

  test("with a long summary, or still being written, clears the counts once its line is whole", async () => {
    const short = JSON.parse(checkpoint(2, START + 10 * SECOND)) as object;
    const long = `${JSON.stringify({ ...short, content: "word ".repeat(40 * 1024) })}\n`;
    const onward = setUp(turn.join(""));
    await onward.read();
    onward.files.append(FILE, long.slice(0, -20));
    expect((await onward.read()).tokens).toEqual(COUNTS_A);
    onward.files.append(FILE, long.slice(-20));
    const state = await onward.read();
    expect(state.tokens).toBeNull();
    expect(await setUp(turn.join("") + long).read()).toEqual(state);

    // Whole, with no newline yet: it counts, and reading its newline later changes nothing.
    const whole = setUp(turn.join("") + long.trimEnd());
    expect(await whole.read()).toEqual(state);
    whole.files.append(FILE, "\n");
    expect(await whole.read()).toEqual(state);
    whole.files.append(FILE, reply(3, START + 20 * SECOND, B));
    expect((await whole.read()).tokens).toEqual(COUNTS_B);
  });

  test("a line that is broken, or that names a checkpoint in its text alone, clears nothing", async () => {
    const quoted = `${JSON.stringify({
      step_index: 2,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      content: checkpoint(2, START + 10 * SECOND),
    })}\n`;
    for (const line of [quoted, `${checkpoint(2, START).slice(0, 60)}\n`]) {
      const onward = setUp(turn.join(""));
      await onward.read();
      onward.files.append(FILE, line);
      const state = await onward.read();
      expect(state.tokens, line).toEqual(COUNTS_A);
      expect(await setUp(turn.join("") + line).read()).toEqual(state);
    }
  });

  test("past the run's start ends the look for a reply's counts", async () => {
    const PIECE = 64 * 1024;
    const filler = step({ index: 2, type: "VIEW_FILE", at: START + 2 * SECOND });
    const earlier = [
      ...turn.slice(0, 1),
      reply(1, START + SECOND, A, ["view_file"]),
      ...Array.from({ length: Math.ceil((200 * 1024) / filler.length) }, () => filler),
    ];
    const ending = [
      step({ index: 4, type: "ERROR_MESSAGE", source: "SYSTEM", at: START + 4 * SECOND }),
      prompt(5, START + 5 * SECOND),
    ];
    const tail = async (lines: string[]) => {
      const { files, read } = setUp(lines.join(""));
      const state = await read();
      const size = files.reads
        .filter((range) => range.position > 0)
        .reduce((sum, range) => sum + range.length, 0);
      return { state, size };
    };
    // With no checkpoint, the reply is found within the 256 KiB looked through.
    const without = await tail([...earlier, ...ending]);
    expect(without.state.tokens).toEqual(COUNTS_A);
    expect(without.size).toBeGreaterThan(PIECE);
    // With one, the older reply is not looked for, and its counts are not taken.
    const within = await tail([...earlier, checkpoint(3, START + 3 * SECOND), ...ending]);
    expect(within.state).toMatchObject({
      last: { index: 5, type: "USER_INPUT" },
      since: START + 5 * SECOND,
      tokens: null,
    });
    expect(within.size).toBe(PIECE);
  });
});
