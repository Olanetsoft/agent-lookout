import { describe, expect, test } from "vitest";

import {
  ANSWER_AGAIN_MS,
  createTailLimits,
  createTailReader,
  MAX_KEPT,
  READS_PER_SECOND,
  type TailReaderOptions,
} from "@collector/messages/tailReader";
import type { LastMessageResponse } from "@core/api";
import { handClock, memoryFiles } from "@tests/support/adapters/codexAdapter";

const FIRST = "/Users/example/transcripts/first.jsonl";
const SECOND = "/Users/example/transcripts/second.jsonl";

/** An agent whose target names its transcript by a letter, and whose answer is the tail's last line. */
function setUp(options: Partial<TailReaderOptions<string>> = {}) {
  const clock = handClock();
  const files = memoryFiles(clock.now);
  const looked: string[] = [];
  const reader = createTailReader<string>({
    find: async (target) => {
      looked.push(target);
      return target === "first" ? FIRST : target === "second" ? SECOND : null;
    },
    answerFrom: (tail): LastMessageResponse => ({
      message: { text: tail.trim().split("\n").at(-1) ?? "", cut: false },
    }),
    io: files.io,
    now: clock.now,
    later: () => {},
    ...options,
  });
  files.write(FIRST, "one\nfrom the first\n");
  files.write(SECOND, "two\nfrom the second\n");
  return { clock, files, looked, reader };
}

const text = (answer: unknown) =>
  (answer as { message: { text: string } | null } | null)?.message?.text;

describe("the reader every agent's last messages share", () => {
  test("finds a transcript once, through the agent's own find, and reads its end from there", async () => {
    const { clock, files, looked, reader } = setUp();
    reader.keep(new Map([["agent:1", "first"]]));
    expect(text(await reader.read("agent:1"))).toBe("from the first");
    clock.advance(ANSWER_AGAIN_MS);
    files.append(FIRST, "and more\n");
    expect(text(await reader.read("agent:1"))).toBe("and more");
    expect(looked).toEqual(["first"]);
  });

  test("a listed session with no target is not found, and nothing is looked for", async () => {
    const { files, looked, reader } = setUp();
    reader.keep(new Map([["agent:1", null]]));
    await expect(reader.read("agent:1")).resolves.toEqual({ message: null, reason: "not-found" });
    expect(looked).toEqual([]);
    expect(files.calls).toEqual([]);
  });

  test("a target whose key changes at a poll is found afresh, and without a key it stays where it was found", async () => {
    const keyed = setUp({ keyOf: (target) => target });
    keyed.reader.keep(new Map([["agent:1", "first"]]));
    await keyed.reader.read("agent:1");
    keyed.reader.keep(new Map([["agent:1", "second"]]));
    expect(keyed.reader.size).toBe(0);
    keyed.clock.advance(ANSWER_AGAIN_MS);
    expect(text(await keyed.reader.read("agent:1"))).toBe("from the second");

    const unkeyed = setUp();
    unkeyed.reader.keep(new Map([["agent:1", "first"]]));
    await unkeyed.reader.read("agent:1");
    unkeyed.reader.keep(new Map([["agent:1", "second"]]));
    expect(unkeyed.reader.size).toBe(1);
    unkeyed.clock.advance(ANSWER_AGAIN_MS);
    expect(text(await unkeyed.reader.read("agent:1"))).toBe("from the first");
    expect(unkeyed.looked).toEqual(["first"]);
  });

  test("a transcript not found is looked for again after the agent's wait, or at the next ask after a second", async () => {
    const waiting = setUp({ lookAgainMs: 10_000 });
    waiting.reader.keep(new Map([["agent:1", "missing"]]));
    await waiting.reader.read("agent:1");
    waiting.clock.advance(9_999);
    await waiting.reader.read("agent:1");
    expect(waiting.looked).toEqual(["missing"]);
    waiting.clock.advance(1);
    await waiting.reader.read("agent:1");
    expect(waiting.looked).toEqual(["missing", "missing"]);

    const prompt = setUp();
    prompt.reader.keep(new Map([["agent:1", "missing"]]));
    await prompt.reader.read("agent:1");
    prompt.clock.advance(ANSWER_AGAIN_MS);
    await prompt.reader.read("agent:1");
    expect(prompt.looked).toEqual(["missing", "missing"]);
  });

  test(`readers that share limits read at most ${READS_PER_SECOND} transcripts a second and keep at most ${MAX_KEPT} sessions, all together`, async () => {
    const clock = handClock();
    const files = memoryFiles(clock.now);
    const limits = createTailLimits();
    const readerFor = () =>
      createTailReader<string>({
        find: async (target) => target,
        answerFrom: (tail): LastMessageResponse => ({ message: { text: tail.trim(), cut: false } }),
        limits,
        io: files.io,
        now: clock.now,
        later: () => {},
      });
    const one = readerFor();
    const two = readerFor();
    const file = (index: number) => `/Users/example/transcripts/${index}.jsonl`;
    for (let index = 0; index <= MAX_KEPT; index += 1) files.write(file(index), "said\n");
    const oneTargets = new Map([0, 1, 2, 3, 4].map((index) => [`one:${index}`, file(index)]));
    const twoTargets = new Map([5, 6, 7, 8].map((index) => [`two:${index}`, file(index)]));
    one.keep(oneTargets);
    two.keep(twoTargets);

    const answers = [
      await one.read("one:0"),
      await one.read("one:1"),
      await two.read("two:5"),
      await two.read("two:6"),
      await two.read("two:7"),
    ];
    expect(answers.map((answer) => answer === "busy")).toEqual([false, false, false, false, true]);
    expect(files.count("openRegular")).toBe(READS_PER_SECOND);
    // A reader that forgets what it kept has still made its reads.
    two.forget();
    two.keep(twoTargets);
    await expect(two.read("two:7")).resolves.toBe("busy");

    // One more ask a second, so none is busy: the one asked for least recently, by either, goes first.
    const asks = ["one:2", "one:3", "one:4", "two:5", "two:6", "two:7", "two:8"];
    for (const id of asks) {
      clock.advance(1_000);
      await (id.startsWith("one") ? one : two).read(id);
    }
    expect(one.size + two.size).toBe(MAX_KEPT);
    expect([one.size, two.size]).toEqual([4, 4]);
  });
});
