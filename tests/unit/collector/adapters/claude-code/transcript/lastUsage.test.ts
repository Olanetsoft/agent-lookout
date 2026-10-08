import { describe, expect, test } from "vitest";

import { lastUsageInTail } from "@collector/adapters/claude-code/transcript/lastUsage";
import {
  compactSummary,
  otherLines,
  prompt,
  said,
  saidInParts,
  thought,
  toolResult,
  toolUse,
  toolUseId,
  transcript,
  usage,
  type TranscriptLine,
} from "@tests/fixtures/claudeTranscript";

/** The counts a whole transcript of these lines gives for the session's newest reply. */
function lastUsage(lines: readonly TranscriptLine[]) {
  return lastUsageInTail(transcript(lines), true);
}

/** An older reply's counts, which must never stand in for a newer reply's. */
const OLDER = usage({ uncached: 5, written: 1_202, read: 40_312, output: 517 });
const OLDER_COUNTS = { input: 41_519, cached: 40_312, output: 517 };

/** The newest reply's counts, most of its prompt read from a cache. */
const NEWER = usage({ uncached: 6, written: 2_382, read: 61_090, output: 1_244 });
const NEWER_COUNTS = { input: 63_478, cached: 61_090, output: 1_244 };

describe("the counts of the newest reply", () => {
  test("are the whole prompt, the part of it read from a cache, and what the reply wrote", () => {
    expect(lastUsage([prompt("Tidy the docs"), said("I tidied them.", { usage: NEWER })])).toEqual(
      NEWER_COUNTS,
    );
  });

  test("are the newest assistant line's, past the prompts, results and notes after it", () => {
    const use = toolUseId();
    expect(
      lastUsage([
        prompt("Tidy the docs"),
        said("A first reply.", { messageId: "msg_older", usage: OLDER }),
        prompt("And the tests"),
        toolUse(use, "Bash", { command: "npm test" }, { messageId: "msg_newer", usage: NEWER }),
        toolResult(use),
        ...otherLines,
        prompt("Thanks"),
      ]),
    ).toEqual(NEWER_COUNTS);
  });

  test("of a reply written as several lines are its last line's, never their sum", () => {
    const parts = [
      thought("About the docs", { messageId: "msg_reply", usage: OLDER }),
      ...saidInParts(["First part.", "Second part."], { messageId: "msg_reply", usage: OLDER }),
    ];
    expect(lastUsage(parts)).toEqual(OLDER_COUNTS);

    // Should the lines of one reply ever differ, the newest still wins alone.
    expect(
      lastUsage([
        ...parts,
        toolUse(toolUseId(), "Read", {}, { messageId: "msg_reply", usage: NEWER }),
      ]),
    ).toEqual(NEWER_COUNTS);
  });

  test("skip a subagent's lines, the lines Claude Code writes itself and errors of the API", () => {
    const skipped: TranscriptLine[] = [
      said("A subagent's reply.", { sidechain: true, usage: NEWER }),
      said("No response requested.", { model: "<synthetic>", usage: NEWER }),
      { ...said("API Error: 529 Overloaded", { usage: NEWER }), isApiErrorMessage: true },
    ];
    expect(lastUsage([said("The reply.", { usage: OLDER }), ...skipped])).toEqual(OLDER_COUNTS);
    expect(lastUsage(skipped)).toBeNull();
  });

  test("a newest reply whose counts could not be right has none, never an older reply's", () => {
    const counts = { input_tokens: 6, cache_read_input_tokens: 61_090, output_tokens: 1_244 };
    for (const bad of [
      { ...counts, input_tokens: "6" },
      { ...counts, input_tokens: -6 },
      { ...counts, input_tokens: 2.5 },
      { ...counts, input_tokens: Number.MAX_SAFE_INTEGER },
      { ...counts, output_tokens: undefined },
      { ...counts, output_tokens: null },
      { ...counts, cache_read_input_tokens: "61090" },
      { ...counts, cache_read_input_tokens: null },
      { ...counts, cache_creation_input_tokens: -1 },
      { ...counts, cache_creation_input_tokens: 0.5 },
      {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
      [6, 61_090, 1_244],
      "6 in, 1244 out",
      null,
    ]) {
      const lines = [
        said("An older reply.", { messageId: "msg_older", usage: OLDER }),
        said("The newest reply.", { messageId: "msg_newer", usage: bad }),
      ];
      expect(lastUsage(lines), JSON.stringify(bad)).toBeNull();
    }
  });

  test("read past an assistant line with no usage, to the reply before it", () => {
    const older = said("Older.", { messageId: "msg_older", usage: OLDER });
    expect(lastUsage([older, said("Newer.", { messageId: "msg_newer" })])).toEqual(OLDER_COUNTS);
    // Whatever else on the line names a usage, such as what a tool was given.
    const use = toolUse(toolUseId(), "Edit", { usage: "a key of the tool's own" }, {});
    expect(lastUsage([older, use])).toEqual(OLDER_COUNTS);
  });

  test("are none once the conversation was compacted after the newest reply, until the next reply", () => {
    const before = said("Before it was compacted.", { messageId: "msg_older", usage: OLDER });
    const summary = compactSummary("What the conversation was about.");
    expect(lastUsage([before, ...otherLines, summary])).toBeNull();
    expect(lastUsage([before, summary, prompt("Go on")])).toBeNull();
    expect(
      lastUsage([
        before,
        summary,
        prompt("Go on"),
        said("After.", { messageId: "msg_newer", usage: NEWER }),
      ]),
    ).toEqual(NEWER_COUNTS);
    // A subagent's summary, or words that name one, are no compaction of the session's own.
    expect(lastUsage([before, compactSummary("A subagent's.", { sidechain: true })])).toEqual(
      OLDER_COUNTS,
    );
    expect(lastUsage([before, prompt('Why is "isCompactSummary":true there?')])).toEqual(
      OLDER_COUNTS,
    );
  });

  test("with a cache count left out, count it as 0 in the input, and with the cache read left out, leave the cached part out", () => {
    const counted = (given: Record<string, unknown>) =>
      lastUsage([said("The reply.", { usage: given })]);
    expect(counted({ input_tokens: 1_830, output_tokens: 96 })).toEqual({
      input: 1_830,
      output: 96,
    });
    expect(
      counted({ input_tokens: 4, cache_creation_input_tokens: 9_412, output_tokens: 96 }),
    ).toEqual({ input: 9_416, output: 96 });
    // With only the cache write left out, the cached part is still the cache read.
    expect(counted({ input_tokens: 4, cache_read_input_tokens: 9_412, output_tokens: 96 })).toEqual(
      { input: 9_416, cached: 9_412, output: 96 },
    );
    // A cache count that was recorded as 0 is kept.
    expect(
      counted({
        input_tokens: 5_120,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 96,
      }),
    ).toEqual({ input: 5_120, cached: 0, output: 96 });
  });

  test("take the four counts and nothing else: no cost, nothing nested and no service tier", () => {
    const line = {
      ...said("The reply.", {
        usage: { ...NEWER, costUSD: 0.42, cost: 0.42, total_tokens: 9 },
        model: "claude-model",
      }),
      costUSD: 0.42,
      durationMs: 5_210,
      requestId: "req_000000000000000000000001",
    };
    const counts = lastUsage([line]);
    expect(counts).toEqual(NEWER_COUNTS);
    expect(Object.keys(counts ?? {})).toEqual(["input", "cached", "output"]);
    expect(JSON.stringify(counts)).not.toMatch(
      /cost|USD|0\.42|thinking|server_tool|ephemeral|service_tier|standard|5210|req_/,
    );
  });

  test("are never taken from words in a prompt or a reply that quote a line with counts", () => {
    const quoted = JSON.stringify(said("Quoted.", { usage: NEWER }));
    expect(lastUsage([prompt(`Why does this line count? ${quoted}`)])).toBeNull();
    expect(
      lastUsage([
        said("The reply.", { usage: OLDER }),
        prompt(`Look at ${quoted}`),
        toolResult(toolUseId()),
      ]),
    ).toEqual(OLDER_COUNTS);
    // A reply's own words that quote one are its words, and its counts are its own.
    expect(lastUsage([said(`Here is the line: ${quoted}`, { usage: OLDER })])).toEqual(
      OLDER_COUNTS,
    );
  });

  test("are none when no reply of the session's own is in the tail", () => {
    expect(lastUsage([])).toBeNull();
    expect(lastUsage([prompt("Start the work"), ...otherLines])).toBeNull();
    expect(lastUsageInTail("not json\n{\n", true)).toBeNull();
  });
});

describe("the end of a transcript", () => {
  test("has its first line dropped when it is not the whole file, as a line cut short", () => {
    const tail = transcript([said("The only reply.", { usage: NEWER })]);
    expect(lastUsageInTail(tail, true)).toEqual(NEWER_COUNTS);
    expect(lastUsageInTail(tail, false)).toBeNull();

    // Cut part way through a line, the rest of that line is never read.
    const whole = transcript([
      said("An older reply.", { usage: OLDER }),
      prompt("Go on"),
      said("The newest reply.", { usage: NEWER }),
    ]);
    const cut = whole.slice(whole.indexOf("Go on") - 20);
    expect(lastUsageInTail(cut, false)).toEqual(NEWER_COUNTS);
    const newest = whole.lastIndexOf('{"type":"assistant"');
    expect(lastUsageInTail(whole.slice(newest + 1), false)).toBeNull();
  });

  test("a line that does not parse is read past", () => {
    const tail = `${transcript([said("The reply.", { usage: OLDER })])}{"type":"assistant","message":{"usage":\n`;
    expect(lastUsageInTail(tail, true)).toEqual(OLDER_COUNTS);
  });
});
