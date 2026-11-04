import { describe, expect, test } from "vitest";

import { CHATS_REFRESH_MS } from "@collector/adapters/gemini-cli/chats";
import {
  createSubagentWrites,
  SUBAGENT_FILES_LIMIT,
  SUBAGENT_FILES_WATCHED,
  subagentFolder,
} from "@collector/adapters/gemini-cli/subagentWrites";
import {
  HOUR,
  ids,
  NOW,
  SECOND,
  SLUG,
  subagentPath,
  TMP_DIR,
} from "@tests/fixtures/gemini-cli/geminiCli";
import { memoryFiles } from "@tests/support/adapters/geminiCliAdapter";

const SESSION = ids.working;
const FOLDER = `${TMP_DIR}/${SLUG}/chats/${SESSION}`;
const DIR = subagentFolder(`${TMP_DIR}/${SLUG}`, SESSION);

const NEVER_OPENED = "placeholder: must never be opened";

/** A subagent's file, by a number of the test's. */
const agentFile = (number: number) =>
  subagentPath(SESSION, `agent-${String(number).padStart(4, "0")}`);

function setUp(files = memoryFiles()) {
  const writes = createSubagentWrites({ io: files.io });
  const newest = async (now = NOW, dirs: readonly string[] = [DIR]) =>
    (await writes.newest(dirs, now)).get(DIR);
  return { files, newest, writes };
}

describe("when a session's subagents last wrote", () => {
  test("a session with no folder has no time, for one lstat and no listing", async () => {
    const { files, newest } = setUp();
    expect(await newest()).toBeUndefined();
    expect(files.count("lstat")).toBe(1);
    expect(files.count("readdir")).toBe(0);
  });

  test("is the newest time in its folder, from lstat alone: no file is opened", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - 5 * SECOND });
    files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    expect(await newest()).toBe(NOW - 5 * SECOND);
    expect(files.opened()).toEqual([]);
    expect(files.count("lstat", (target) => target === agentFile(1))).toBe(1);
  });

  test("the system's fraction of a millisecond is dropped", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - 5_000.6 });
    expect(await newest()).toBe(NOW - 5_001);
  });

  test("only files named like a subagent's are looked at", async () => {
    const { files, newest } = setUp();
    const others = [
      `${agentFile(1)}.tmp-123`,
      `${agentFile(1)}.unreadable-1790856000000`,
      `${FOLDER}/agent-0002.json`,
      `${FOLDER}/notes.txt`,
      `${FOLDER}/.hidden.jsonl`,
    ];
    for (const other of others) files.write(other, NEVER_OPENED, { mtimeMs: NOW });
    expect(await newest()).toBeUndefined();
    for (const other of others) expect(files.count("lstat", (target) => target === other)).toBe(0);
  });

  test("a name longer than an agent's is passed over, and one of the longest is looked at", async () => {
    const { files, newest } = setUp();
    files.write(`${FOLDER}/${"a".repeat(201)}.jsonl`, NEVER_OPENED, { mtimeMs: NOW });
    files.write(`${FOLDER}/${"a".repeat(200)}.jsonl`, NEVER_OPENED, { mtimeMs: NOW - HOUR });
    expect(await newest()).toBe(NOW - HOUR);
  });

  test("a link, a pipe or a folder under such a name is passed over, and nothing under it looked at", async () => {
    const { files, newest } = setUp();
    files.special(agentFile(1));
    files.mkdir(agentFile(2));
    files.write(`${agentFile(2)}/agent-0003.jsonl`, NEVER_OPENED, { mtimeMs: NOW });
    files.write(agentFile(4), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    expect(await newest()).toBe(NOW - HOUR);
    expect(files.count("readdir")).toBe(1);
    expect(files.count("stat")).toBe(0);
    expect(files.count("lstat", (target) => target.startsWith(`${agentFile(2)}/`))).toBe(0);
  });

  test("a link in the folder's place is not followed", async () => {
    const { files, newest } = setUp();
    files.special(FOLDER);
    expect(await newest()).toBeUndefined();
    expect(files.count("readdir")).toBe(0);
    expect(files.count("stat")).toBe(0);
  });

  test("a time that could not be right is left out, and does not hide the others", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW + HOUR });
    files.write(agentFile(2), NEVER_OPENED, { mtimeMs: 0 });
    files.write(agentFile(3), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    expect(await newest()).toBe(NOW - HOUR);
  });

  test("a folder with no time that could be right has no entry", async () => {
    const { files, writes } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW + HOUR });
    expect(await writes.newest([DIR], NOW)).toEqual(new Map());
  });

  test("a folder holding no file gives no time", async () => {
    const { files, newest } = setUp();
    files.mkdir(FOLDER);
    expect(await newest()).toBeUndefined();
  });

  test("a folder that cannot be listed gives no time, and is listed at the next call", async () => {
    const files = memoryFiles();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    let refuses = true;
    const io = {
      ...files.io,
      readdir: async (dir: string) => {
        if (refuses) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return files.io.readdir(dir);
      },
    };
    const writes = createSubagentWrites({ io });
    expect(await writes.newest([DIR], NOW)).toEqual(new Map());
    refuses = false;
    expect(await writes.newest([DIR], NOW + 2 * SECOND)).toEqual(new Map([[DIR, NOW - HOUR]]));
  });
});

describe("how often its folder is looked at", () => {
  test("a line added between listings is seen at once: the time of a file moves, and its folder's does not", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - 10 * SECOND });
    expect(await newest(NOW)).toBe(NOW - 10 * SECOND);
    files.forget();
    files.append(agentFile(1), "\n", { mtimeMs: NOW + SECOND });
    expect(await newest(NOW + 2 * SECOND)).toBe(NOW + SECOND);
    expect(files.count("readdir")).toBe(0);
  });

  test("between listings, the newest of the files looked at is taken, whichever led at the listing", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - 2 * HOUR });
    await newest(NOW);
    files.append(agentFile(2), "\n", { mtimeMs: NOW + SECOND });
    expect(await newest(NOW + 2 * SECOND)).toBe(NOW + SECOND);
  });

  test("the folder is listed again when its time moves, or at least every 30 seconds", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    await newest(NOW);

    // A new file is not seen until the folder is listed.
    files.forget();
    files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW + SECOND });
    expect(await newest(NOW + 2 * SECOND)).toBe(NOW - HOUR);
    expect(files.count("readdir")).toBe(0);

    files.touch(FOLDER, NOW + 3 * SECOND);
    expect(await newest(NOW + 4 * SECOND)).toBe(NOW + SECOND);
    expect(files.count("readdir")).toBe(1);

    files.forget();
    await newest(NOW + 6 * SECOND);
    expect(files.count("readdir")).toBe(0);
    await newest(NOW + 4 * SECOND + CHATS_REFRESH_MS);
    expect(files.count("readdir")).toBe(1);
  });

  test("a clock set back counts as time enough to list it", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    await newest(NOW);
    files.forget();
    await newest(NOW - 2 * SECOND);
    expect(files.count("readdir")).toBe(1);
  });

  test("a file that leaves between listings is passed over, and so is a folder that goes", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - 2 * HOUR });
    await newest(NOW);
    files.remove(agentFile(1));
    expect(await newest(NOW + 2 * SECOND)).toBe(NOW - 2 * HOUR);
    files.remove(FOLDER);
    expect(await newest(NOW + 4 * SECOND)).toBeUndefined();
  });

  test("a folder left out of a call is forgotten, and listed afresh when asked for again", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    await newest(NOW);
    await newest(NOW + 2 * SECOND, []);
    files.forget();
    await newest(NOW + 4 * SECOND);
    expect(files.count("readdir")).toBe(1);
  });

  test("forgetting drops what is kept of every folder, so each is listed afresh, and looks at nothing", async () => {
    const { files, newest, writes } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    await newest(NOW);
    expect(writes.size).toBe(1);

    files.forget();
    writes.forget();
    expect(writes.size).toBe(0);
    expect(files.calls).toEqual([]);

    await newest(NOW + 2 * SECOND);
    expect(files.count("readdir")).toBe(1);
    expect(writes.size).toBe(1);
  });

  test("between listings, only the files written to last are looked at, and the others at the next listing", async () => {
    const { files, newest } = setUp();
    const total = SUBAGENT_FILES_WATCHED + 4;
    for (let number = 1; number <= total; number += 1) {
      // The higher the number, the later it was written.
      files.write(agentFile(number), NEVER_OPENED, { mtimeMs: NOW - HOUR + number * SECOND });
    }
    expect(await newest(NOW)).toBe(NOW - HOUR + total * SECOND);
    expect(files.count("lstat", (target) => target.endsWith(".jsonl"))).toBe(total);

    files.forget();
    files.append(agentFile(1), "\n", { mtimeMs: NOW + SECOND });
    expect(await newest(NOW + 2 * SECOND)).toBe(NOW - HOUR + total * SECOND);
    expect(files.count("lstat", (target) => target.endsWith(".jsonl"))).toBe(
      SUBAGENT_FILES_WATCHED,
    );
    expect(files.count("lstat", (target) => target === agentFile(1))).toBe(0);
    expect(files.count("lstat", (target) => target === agentFile(total))).toBe(1);

    expect(await newest(NOW + CHATS_REFRESH_MS)).toBe(NOW + SECOND);
  });

  test("at most so many files are looked at in a listing", async () => {
    const { files, newest } = setUp();
    for (let number = 1; number <= SUBAGENT_FILES_LIMIT + 5; number += 1) {
      files.write(agentFile(number), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    }
    await newest(NOW);
    expect(files.count("lstat", (target) => target.endsWith(".jsonl"))).toBe(SUBAGENT_FILES_LIMIT);
    expect(files.opened()).toEqual([]);
  });

  test("past the limit, the first names are the ones looked at, whatever order the folder gives", async () => {
    const { files, newest } = setUp();
    for (let number = SUBAGENT_FILES_LIMIT + 5; number >= 1; number -= 1) {
      files.write(agentFile(number), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    }
    await newest(NOW);
    expect(files.count("lstat", (target) => target === agentFile(1))).toBe(1);
    expect(files.count("lstat", (target) => target === agentFile(SUBAGENT_FILES_LIMIT + 1))).toBe(
      0,
    );
  });

  test("a folder's files are looked at only when the folder is asked for", async () => {
    const { files, newest } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW });
    await newest(NOW, []);
    expect(files.calls).toEqual([]);
  });
});
