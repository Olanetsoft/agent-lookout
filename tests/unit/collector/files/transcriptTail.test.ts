import { describe, expect, test } from "vitest";

import { readTranscriptTail, TRANSCRIPT_TAIL_BYTES } from "@collector/files/transcriptTail";
import { ids } from "@tests/fixtures/claudeCode";
import { CODEX_HOME, ids as codexIds, rolloutPath } from "@tests/fixtures/codex";
import { memoryFiles } from "@tests/support/adapters/codexAdapter";

describe("readTranscriptTail", () => {
  const file = `/Users/example/.claude/projects/-Users-example-code-demo-api/${ids.permission}.jsonl`;

  test("reads a short file whole", async () => {
    const files = memoryFiles();
    files.write(file, "one\ntwo\n");
    const read = await readTranscriptTail(file, files.io, null);
    expect(read).toMatchObject({ unchanged: false, tail: "one\ntwo\n", fromStart: true });
    expect(files.openHandles()).toBe(0);
  });

  test("reads only the last 256 KB of a long one, by position", async () => {
    const files = memoryFiles();
    const size = TRANSCRIPT_TAIL_BYTES * 3;
    files.write(file, "x".repeat(size - 4) + "end\n");
    const read = await readTranscriptTail(file, files.io, null);
    expect(read.unchanged).toBe(false);
    if (read.unchanged) return;
    expect(read.fromStart).toBe(false);
    expect(read.tail).toHaveLength(TRANSCRIPT_TAIL_BYTES);
    expect(read.tail.endsWith("end\n")).toBe(true);
    expect(files.reads).toEqual([
      { path: file, position: size - TRANSCRIPT_TAIL_BYTES, length: TRANSCRIPT_TAIL_BYTES },
    ]);
  });

  test("reads nothing when the file is as it was, and again once it has changed", async () => {
    const files = memoryFiles();
    files.write(file, "one\n", { mtimeMs: 1_000 });
    const first = await readTranscriptTail(file, files.io, null);
    files.forget();
    const again = await readTranscriptTail(file, files.io, first.stamp);
    expect(again.unchanged).toBe(true);
    expect(files.reads).toEqual([]);

    files.append(file, "two\n", { mtimeMs: 2_000 });
    const changed = await readTranscriptTail(file, files.io, first.stamp);
    expect(changed).toMatchObject({ unchanged: false, tail: "one\ntwo\n" });
  });

  test("refuses a link or a pipe, and a file that is not there", async () => {
    const files = memoryFiles();
    files.special(file);
    await expect(readTranscriptTail(file, files.io, null)).rejects.toThrow();
    await expect(readTranscriptTail(`${file}.gone`, files.io, null)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("reads a Codex session file the same way", async () => {
    const files = memoryFiles();
    const rollout = rolloutPath(CODEX_HOME, "2026-10-01T09-00-00", codexIds.working);
    files.write(rollout, "y".repeat(TRANSCRIPT_TAIL_BYTES) + "\nlast\n");
    const read = await readTranscriptTail(rollout, files.io, null);
    expect(read).toMatchObject({ unchanged: false, fromStart: false });
    if (read.unchanged) return;
    expect(read.tail.endsWith("\nlast\n")).toBe(true);
    expect(files.reads).toHaveLength(1);
  });
});
