import { describe, expect, test } from "vitest";

import { jsonValuesIn } from "@collector/adapters/claude-code/jsonValues";
import { feedEntries, feedJson, feedJsonWithTrailingText } from "@tests/fixtures/claudeCode";

/** The first value `jsonValuesIn` yields, which is all a caller looking for one array reads. */
function firstValue(text: string): { found: true; value: unknown } | { found: false } {
  const next = jsonValuesIn(text).next();
  return next.done ? { found: false } : { found: true, value: next.value };
}

describe("the first value jsonValuesIn yields", () => {
  test("reads an array that is alone on stdout", () => {
    expect(firstValue(feedJson)).toEqual({ found: true, value: feedEntries });
    expect(firstValue("[]\n")).toEqual({ found: true, value: [] });
  });

  test("ignores whatever another tool prints after the array", () => {
    expect(firstValue(feedJsonWithTrailingText)).toEqual({
      found: true,
      value: feedEntries,
    });
  });

  test("ignores a second JSON value after the first", () => {
    expect(firstValue('[1, 2]\n[3, 4]\n{"later": true}')).toEqual({
      found: true,
      value: [1, 2],
    });
  });

  test("ignores a banner printed before the array", () => {
    expect(firstValue('Session tracking is on.\n[{"pid": 1}]\n')).toEqual({
      found: true,
      value: [{ pid: 1 }],
    });
  });

  test("skips bracketed text that is not JSON, such as a log prefix or a colour code", () => {
    expect(firstValue('[info] starting\n[{"pid": 1}]')).toEqual({
      found: true,
      value: [{ pid: 1 }],
    });
    expect(firstValue('\u001b[32mready\u001b[0m\n[{"pid": 1}]')).toEqual({
      found: true,
      value: [{ pid: 1 }],
    });
  });

  test("brackets and quotes inside strings do not end the value early", () => {
    const tricky = [{ name: 'a "quoted" ] name', cwd: "C:\\code\\[demo]\\", note: "}{][" }];
    expect(firstValue(`${JSON.stringify(tricky)} trailing ] text`)).toEqual({
      found: true,
      value: tricky,
    });
  });

  test("returns the first value even when it is an object, so the caller can reject it", () => {
    expect(firstValue('{"error": "not logged in"}\n[]')).toEqual({
      found: true,
      value: { error: "not logged in" },
    });
  });

  test("finds nothing in empty, plain or cut-off output", () => {
    expect(firstValue("")).toEqual({ found: false });
    expect(firstValue("   \n")).toEqual({ found: false });
    expect(firstValue("command not found: claude")).toEqual({ found: false });
    expect(firstValue('[{"pid": 1}, {"pid"')).toEqual({ found: false });
  });

  test("a list that was cut off is never mistaken for a shorter one", () => {
    // Each of these holds a complete inner value. Returning it would report a
    // truncated list of sessions as a list of fewer, or of none.
    expect(firstValue('[{"pid": 1, "tags": ["a", "b"]}, {"pid": 2')).toEqual({
      found: false,
    });
    expect(firstValue("[[1, 2], [3, 4], [5")).toEqual({ found: false });
    expect(firstValue('banner\n[\n  {\n    "pid": 1\n  },\n  {\n    "pid"')).toEqual({
      found: false,
    });
  });

  test("does not look inside a bracketed run that failed to parse", () => {
    expect(firstValue('[oops {"pid": 1}]\n')).toEqual({ found: false });
    expect(firstValue('[oops {"pid": 1}]\n[{"pid": 2}]')).toEqual({
      found: true,
      value: [{ pid: 2 }],
    });
  });

  test("gives up on output that is nothing but brackets", () => {
    expect(firstValue("[x ".repeat(5_000))).toEqual({ found: false });
    expect(firstValue("[x] ".repeat(5_000))).toEqual({ found: false });
  });
});

describe("jsonValuesIn", () => {
  test("yields every complete JSON value, in order, and steps over what is not JSON", () => {
    const text =
      '[12345] wrapper started\n[info] ready\n{"hook": true}\n[]\n[{"pid": 1}] done {12m}';
    expect([...jsonValuesIn(text)]).toEqual([[12345], { hook: true }, [], [{ pid: 1 }]]);
  });

  test("does not look inside a value for further values", () => {
    expect([...jsonValuesIn('{"jobs": [{"pid": 1}]}')]).toEqual([{ jobs: [{ pid: 1 }] }]);
  });

  test("stops at a run that never closes, keeping what came before it", () => {
    expect([...jsonValuesIn('[]\n[{"pid": 1}, {"pid"')]).toEqual([[]]);
    expect([...jsonValuesIn('[warn unclosed\n[{"pid": 1}]')]).toEqual([]);
  });

  test("reads past more bracketed log lines than any wrapper would print", () => {
    const lines = Array.from({ length: 2_000 }, (_, line) => `[log ${line}] line`).join("\n");
    expect([...jsonValuesIn(`${lines}\n[{"pid": 1}]`)]).toEqual([[{ pid: 1 }]]);
  });

  test("gives up on a flood of brackets in bounded time", () => {
    const started = Date.now();
    expect([...jsonValuesIn("[x] ".repeat(500_000))]).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
