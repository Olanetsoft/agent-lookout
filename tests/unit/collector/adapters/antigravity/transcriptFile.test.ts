import { describe, expect, test } from "vitest";

import {
  createTranscriptReader,
  parseStepTime,
  readStepLine,
  TAIL_LIMIT_BYTES,
} from "@collector/adapters/antigravity/transcriptFile";
import {
  AGY_HOME,
  conversationId,
  failedTurn,
  finishedTurn,
  NOW,
  PRIVATE_WORDS,
  SECOND,
  step,
  transcriptPath,
  workingTurn,
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
    });
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
