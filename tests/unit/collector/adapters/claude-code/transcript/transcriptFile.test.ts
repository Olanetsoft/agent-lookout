import { describe, expect, test } from "vitest";

import {
  findTranscript,
  isSessionId,
  projectFolderName,
  readTranscriptTail,
  TRANSCRIPT_TAIL_BYTES,
} from "@collector/adapters/claude-code/transcript/transcriptFile";
import { ids } from "@tests/fixtures/claudeCode";
import { memoryFiles } from "@tests/support/adapters/codexAdapter";
import { asWritten } from "@tests/support/paths";

/** The transcript found, as the tests write paths, whatever system joined it. */
const written = (found: string | null) => found && asWritten(found);

const PROJECTS = "/Users/example/.claude/projects";
const CWD = "/Users/example/code/demo-api";
const ID = ids.permission;

describe("isSessionId", () => {
  test("only a session id in the shape Claude Code gives one may name a transcript", () => {
    expect(isSessionId(ID)).toBe(true);
    expect(isSessionId(ID.toUpperCase())).toBe(true);
    for (const value of [
      "",
      "job-0001",
      "../../etc/passwd",
      `${ID}/../x`,
      `${ID}.jsonl`,
      `${ID} `,
      "00000000-0000-4000-8000-00000000000",
      4242,
      null,
      undefined,
    ]) {
      expect(isSessionId(value), String(value)).toBe(false);
    }
  });
});

describe("projectFolderName", () => {
  test("every character that is not a letter or a digit becomes a dash", () => {
    expect(projectFolderName("/Users/a/b.c")).toBe("-Users-a-b-c");
    expect(projectFolderName("/Users/example/code/demo_api 2")).toBe(
      "-Users-example-code-demo-api-2",
    );
    // Nothing it gives can climb out of the projects folder.
    expect(projectFolderName("/../..")).toBe("------");
    expect(projectFolderName("C:\\code\\démo")).toBe("C--code-d-mo");
  });
});

describe("findTranscript", () => {
  test("looks in the folder named for the session's folder first, and lists nothing then", async () => {
    const files = memoryFiles();
    const file = `${PROJECTS}/-Users-example-code-demo-api/${ID}.jsonl`;
    files.write(file, "{}\n");
    expect(written(await findTranscript(PROJECTS, ID, CWD, files.io))).toBe(file);
    expect(files.count("readdir")).toBe(0);
  });

  test("otherwise looks in every folder in projects, and finds it where it is", async () => {
    const files = memoryFiles();
    files.mkdir(`${PROJECTS}/-Users-example-code-other`);
    const file = `${PROJECTS}/-Users-example-code-moved/${ID}.jsonl`;
    files.write(file, "{}\n");
    expect(written(await findTranscript(PROJECTS, ID, CWD, files.io))).toBe(file);
    expect(written(await findTranscript(PROJECTS, ID, null, files.io))).toBe(file);
  });

  test("a transcript that is a link, or is in no folder, is not found", async () => {
    const files = memoryFiles();
    files.special(`${PROJECTS}/-Users-example-code-demo-api/${ID}.jsonl`);
    expect(await findTranscript(PROJECTS, ID, CWD, files.io)).toBeNull();
    expect(await findTranscript("/Users/example/nowhere", ID, CWD, files.io)).toBeNull();
  });

  test("a session id that is not one is never made part of a path", async () => {
    const files = memoryFiles();
    expect(await findTranscript(PROJECTS, "../../sessions/4242", CWD, files.io)).toBeNull();
    expect(files.calls).toEqual([]);
  });
});

describe("readTranscriptTail", () => {
  const file = `${PROJECTS}/-Users-example-code-demo-api/${ID}.jsonl`;

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
});
