import { describe, expect, test } from "vitest";

import { readHistoryFileName, type HistoryFileName } from "@collector/history/historyFormat";
import {
  filesToDelete,
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_BYTES,
  HISTORY_MAX_FILE_BYTES,
  memoryOnlyStatus,
  type KeptFile,
} from "@collector/history/historyLimits";

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/** Noon, UTC, on 2026-10-20: a clock of the test's own. */
const NOW = Date.parse("2026-10-20T12:00:00.000Z");

function file(name: string, size = 1_000): KeptFile {
  return { ...(readHistoryFileName(name) as HistoryFileName), size };
}

const limits = { now: NOW, maxBytes: HISTORY_MAX_BYTES, maxAgeMs: HISTORY_MAX_AGE_MS };

test("the limits are 20 MB in all, 2 MB a file and 8 days", () => {
  expect(HISTORY_MAX_BYTES).toBe(20 * MB);
  expect(HISTORY_MAX_FILE_BYTES).toBe(2 * MB);
  expect(HISTORY_MAX_AGE_MS).toBe(8 * DAY);
});

describe("age", () => {
  test("a day's file goes once its day ended more than 8 days ago, and not before", () => {
    const files = [
      file("v1-2026-10-11.jsonl"), // ended 2026-10-12 00:00, 8.5 days ago
      file("v1-2026-10-12.jsonl"), // ended 2026-10-13 00:00, 7.5 days ago
      file("v1-2026-10-20.jsonl"),
    ];
    expect(filesToDelete(files, "v1-2026-10-20.jsonl", 0, limits)).toEqual(["v1-2026-10-11.jsonl"]);
  });

  test("the moment it turns 8 days old, it stays; a moment after, it goes", () => {
    const files = [file("v1-2026-10-11.jsonl")];
    const ended = Date.parse("2026-10-12T00:00:00.000Z");
    expect(filesToDelete(files, null, 0, { ...limits, now: ended + 8 * DAY })).toEqual([]);
    expect(filesToDelete(files, null, 0, { ...limits, now: ended + 8 * DAY + 1 })).toEqual([
      "v1-2026-10-11.jsonl",
    ]);
  });

  test("every part of an old day goes, oldest first", () => {
    const files = [
      file("v1-2026-10-01-2.jsonl"),
      file("v1-2026-10-01.jsonl"),
      file("v1-2026-09-30.jsonl"),
      file("v1-2026-10-19.jsonl"),
    ];
    expect(filesToDelete(files, null, 0, limits)).toEqual([
      "v1-2026-09-30.jsonl",
      "v1-2026-10-01.jsonl",
      "v1-2026-10-01-2.jsonl",
    ]);
  });
});

describe("size", () => {
  test("under the cap, nothing goes", () => {
    const files = [file("v1-2026-10-18.jsonl", 2 * MB), file("v1-2026-10-19.jsonl", 2 * MB)];
    expect(filesToDelete(files, "v1-2026-10-20.jsonl", 1_000, limits)).toEqual([]);
  });

  test("over it, the oldest go until what is left and what is coming fit", () => {
    const files = [
      file("v1-2026-10-19.jsonl", 6 * MB),
      file("v1-2026-10-17.jsonl", 6 * MB),
      file("v1-2026-10-18.jsonl", 6 * MB),
      file("v1-2026-10-20.jsonl", 1 * MB),
    ];
    // 19 MB held, and 2 MB more coming: the oldest, the 17th, goes.
    expect(filesToDelete(files, "v1-2026-10-20.jsonl", 2 * MB, limits)).toEqual([
      "v1-2026-10-17.jsonl",
    ]);
    // 13 MB more coming: the 18th goes too.
    expect(filesToDelete(files, "v1-2026-10-20.jsonl", 13 * MB, limits)).toEqual([
      "v1-2026-10-17.jsonl",
      "v1-2026-10-18.jsonl",
    ]);
  });

  test("an exact fit is kept", () => {
    const files = [file("v1-2026-10-19.jsonl", 19 * MB)];
    expect(filesToDelete(files, "v1-2026-10-20.jsonl", 1 * MB, limits)).toEqual([]);
  });

  test("the file being written to never goes, even when it is the oldest", () => {
    const files = [file("v1-2026-10-19.jsonl", 15 * MB), file("v1-2026-10-20.jsonl", 6 * MB)];
    expect(filesToDelete(files, "v1-2026-10-19.jsonl", 0, limits)).toEqual(["v1-2026-10-20.jsonl"]);
  });

  test("what goes for its age counts towards the room it makes", () => {
    const files = [file("v1-2026-10-01.jsonl", 15 * MB), file("v1-2026-10-19.jsonl", 6 * MB)];
    expect(filesToDelete(files, "v1-2026-10-20.jsonl", 1 * MB, limits)).toEqual([
      "v1-2026-10-01.jsonl",
    ]);
  });
});

test("in memory only, the history has no folder, holds no bytes and cannot be cleared", () => {
  expect(memoryOnlyStatus()).toEqual({
    where: "memory",
    folder: null,
    bytes: null,
    maxBytes: HISTORY_MAX_BYTES,
    maxAgeMs: HISTORY_MAX_AGE_MS,
    canClear: false,
    problem: null,
  });
});
