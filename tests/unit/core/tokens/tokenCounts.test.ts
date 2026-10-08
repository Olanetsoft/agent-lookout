import { describe, expect, test } from "vitest";

import { tokenCountsOf } from "@core/tokens/tokenCounts";

describe("tokenCountsOf", () => {
  test("keeps whole counts that could be right, with the cached part when there is one", () => {
    expect(tokenCountsOf({ input: 182_431, cached: 141_002, output: 9_120 })).toEqual({
      input: 182_431,
      cached: 141_002,
      output: 9_120,
    });
    expect(tokenCountsOf({ input: 1, output: 0 })).toEqual({ input: 1, output: 0 });
  });

  test("a cached part that was recorded as 0 is kept, and one as large as the input is too", () => {
    expect(tokenCountsOf({ input: 2_048, cached: 0, output: 64 })).toEqual({
      input: 2_048,
      cached: 0,
      output: 64,
    });
    expect(tokenCountsOf({ input: 2_048, cached: 2_048, output: 64 })?.cached).toBe(2_048);
  });

  test("with no cached part, the key is left out, not set to 0", () => {
    const counts = tokenCountsOf({ input: 2_048, output: 64 });
    expect(counts).toEqual({ input: 2_048, output: 64 });
    expect(counts).not.toHaveProperty("cached");
  });

  test("copies only the three counts, whatever else comes with them", () => {
    const counts = tokenCountsOf({
      input: 2_048,
      cached: 1_024,
      output: 64,
      total: 2_112,
      reasoning: 32,
      costUSD: 0.42,
      plan_type: "pro",
      rate_limits: { credits: { balance: "10" } },
    });
    expect(Object.keys(counts ?? {})).toEqual(["input", "cached", "output"]);
  });

  test("an input of 0 is a reset, not a count, as Codex writes after it compacts", () => {
    expect(tokenCountsOf({ input: 0, cached: 0, output: 0 })).toBeNull();
    expect(tokenCountsOf({ input: 0, output: 12 })).toBeNull();
  });

  test("a cached part larger than the input cannot be part of it", () => {
    expect(tokenCountsOf({ input: 1_000, cached: 1_001, output: 10 })).toBeNull();
  });

  test.each([
    ["a negative input", { input: -5, output: 10 }],
    ["a negative output", { input: 5, output: -1 }],
    ["a negative cached part", { input: 5, cached: -1, output: 1 }],
    ["a fraction", { input: 10.5, output: 1 }],
    ["a fractional output", { input: 10, output: 0.5 }],
    ["a fractional cached part", { input: 10, cached: 2.5, output: 1 }],
    ["NaN", { input: Number.NaN, output: 1 }],
    ["Infinity", { input: Number.POSITIVE_INFINITY, output: 1 }],
    ["an output of Infinity", { input: 10, output: Number.POSITIVE_INFINITY }],
    ["a number too large to be exact", { input: Number.MAX_SAFE_INTEGER + 1, output: 1 }],
    ["a count written as text", { input: "182431", output: 9_120 }],
    ["a cached part written as text", { input: 10, cached: "2", output: 1 }],
    ["a cached part that is null", { input: 10, cached: null, output: 1 }],
    ["a missing input", { output: 10 }],
    ["a missing output", { input: 10 }],
    ["a big integer", { input: 10n, output: 1 }],
  ])("%s is no count at all", (_what, value) => {
    expect(tokenCountsOf(value)).toBeNull();
  });

  test.each([null, undefined, 42, "182431 in", [182_431, 9_120], true])(
    "%j is not counts",
    (value) => {
      expect(tokenCountsOf(value)).toBeNull();
    },
  );
});
