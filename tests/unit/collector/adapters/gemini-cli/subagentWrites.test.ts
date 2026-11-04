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
    (await writes.newest(dirs, now)).times.get(DIR);
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
    expect((await writes.newest([DIR], NOW)).times).toEqual(new Map());
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
    expect((await writes.newest([DIR], NOW)).times).toEqual(new Map());
    refuses = false;
    expect((await writes.newest([DIR], NOW + 2 * SECOND)).times).toEqual(
      new Map([[DIR, NOW - HOUR]]),
    );
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

describe("a look that tells nothing", () => {
  const NONE = { refused: 0, failed: 0 };
  const REFUSED = { refused: 1, failed: 0 };
  const FAILED = { refused: 0, failed: 1 };

  /** An error of this code, as the system gives it. */
  const errno = (code: string) => Object.assign(new Error(code), { code });

  /** Calls `newest` for the one folder, and gives what it said of its time and of failures. */
  async function lookAt(writes: ReturnType<typeof setUp>["writes"], now = NOW) {
    const { times, unread } = await writes.newest([DIR], now);
    return { at: times.get(DIR), unread };
  }

  /** A folder of one file, listed once and looked at by a call. */
  async function seen(mtimeMs = NOW - 5 * SECOND) {
    const context = setUp();
    context.files.write(agentFile(1), NEVER_OPENED, { mtimeMs });
    expect(await lookAt(context.writes)).toEqual({ at: mtimeMs, unread: NONE });
    return context;
  }

  test("a session with no folder is no failure, and costs one lstat", async () => {
    const { files, writes } = setUp();
    expect(await lookAt(writes)).toEqual({ at: undefined, unread: NONE });
    expect(files.calls).toEqual([{ method: "lstat", path: FOLDER }]);
  });

  test("a folder with nothing in it, or a link in its place, is no failure", async () => {
    const empty = setUp();
    empty.files.mkdir(FOLDER);
    expect((await lookAt(empty.writes)).unread).toEqual(NONE);

    const linked = setUp();
    linked.files.special(FOLDER);
    expect((await lookAt(linked.writes)).unread).toEqual(NONE);
  });

  test.each(["ENOENT", "ENOTDIR"])(
    "a folder that goes between its lstat and its readdir, with %s, is no failure",
    async (code) => {
      const files = memoryFiles();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      let goes = false;
      const io = {
        ...files.io,
        readdir: async (dir: string) => {
          if (goes) throw errno(code);
          return files.io.readdir(dir);
        },
      };
      const writes = createSubagentWrites({ io });
      expect(await lookAt(writes)).toEqual({ at: NOW - HOUR, unread: NONE });

      goes = true;
      expect(await lookAt(writes, NOW + CHATS_REFRESH_MS)).toEqual({ at: undefined, unread: NONE });
      expect(writes.size).toBe(0);
    },
  );

  test.each(["ENOENT", "ENOTDIR"])(
    "a file that goes between the listing and its lstat, with %s, is no failure",
    async (code) => {
      const { files, writes } = setUp();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - 2 * HOUR });
      files.fail(agentFile(1), code);
      expect(await lookAt(writes)).toEqual({ at: NOW - 2 * HOUR, unread: NONE });
    },
  );

  test("a folder whose lstat is refused is counted, with no listing", async () => {
    const { files, writes } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.fail(FOLDER);
    expect(await lookAt(writes)).toEqual({ at: undefined, unread: REFUSED });
    expect(files.count("readdir")).toBe(0);
  });

  test("a folder that cannot be listed is counted, with no file looked at", async () => {
    const files = memoryFiles();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    const io = {
      ...files.io,
      readdir: async () => {
        throw errno("EACCES");
      },
    };
    const writes = createSubagentWrites({ io });
    expect(await lookAt(writes)).toEqual({ at: undefined, unread: REFUSED });
    expect(files.count("lstat", (target) => target === agentFile(1))).toBe(0);
  });

  test("a file refused is counted, and leaves the time of those that were not", async () => {
    const { files, writes } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - 2 * HOUR });
    files.fail(agentFile(1));
    expect(await lookAt(writes)).toEqual({ at: NOW - 2 * HOUR, unread: REFUSED });
  });

  test.each([
    ["EACCES", REFUSED],
    ["EPERM", REFUSED],
    ["EIO", FAILED],
    ["EMFILE", FAILED],
    ["EBUSY", FAILED],
  ])("%s is told by its kind", async (code, unread) => {
    const { files, writes } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.fail(agentFile(1), code);
    expect((await lookAt(writes)).unread).toEqual(unread);
  });

  test.each([1, 20])(
    "a folder counts once, however many of its files are refused, and as refused if any is, wherever another failure falls (file %i)",
    async (other) => {
      const { files, writes } = setUp();
      for (let number = 1; number <= 20; number += 1) {
        files.write(agentFile(number), NEVER_OPENED, { mtimeMs: NOW - HOUR });
        files.fail(agentFile(number), number === other ? "EIO" : "EACCES");
      }
      expect((await lookAt(writes)).unread).toEqual(REFUSED);
    },
  );

  test("a refused folder and a failed one are each counted once, and the others give their times", async () => {
    const { files, writes } = setUp();
    const folders = ["agents-a", "agents-b", "agents-c", "agents-d"].map(
      (name) => `${TMP_DIR}/${SLUG}/chats/${name}`,
    );
    for (const dir of folders) {
      files.write(`${dir}/agent-0001.jsonl`, NEVER_OPENED, { mtimeMs: NOW - HOUR });
    }
    const [refused, failed] = folders;
    files.fail(refused as string);
    files.fail(`${failed as string}/agent-0001.jsonl`, "EIO");
    const { times, unread } = await writes.newest(folders, NOW);
    expect(unread).toEqual({ refused: 1, failed: 1 });
    expect([...times.keys()]).toEqual(folders.slice(2));
  });

  test("a folder asked for twice in one call counts once", async () => {
    const { files, writes } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.fail(FOLDER);
    expect((await writes.newest([DIR, DIR], NOW)).unread).toEqual(REFUSED);
  });

  test("the count starts anew at each call, and a folder not asked for is not in it", async () => {
    const { files, writes } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.fail(FOLDER);
    for (let call = 0; call < 3; call += 1) {
      expect((await lookAt(writes, NOW + call * 2 * SECOND)).unread).toEqual(REFUSED);
    }
    expect((await writes.newest([], NOW + 6 * SECOND)).unread).toEqual(NONE);
    expect(writes.size).toBe(0);
  });

  describe("and then recovers", () => {
    test("a folder is counted no more at the next call, and gives its time", async () => {
      const { files, writes } = setUp();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      files.fail(FOLDER);
      await lookAt(writes);
      files.heal(FOLDER);
      expect(await lookAt(writes, NOW + 2 * SECOND)).toEqual({ at: NOW - HOUR, unread: NONE });
    });

    test("a file a listing could not look at is counted no more at the next call, with no listing, and gives its time", async () => {
      const { files, writes } = setUp();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - 5 * SECOND });
      files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      files.fail(agentFile(1));
      expect(await lookAt(writes)).toEqual({ at: NOW - HOUR, unread: REFUSED });

      files.heal(agentFile(1));
      files.forget();
      expect(await lookAt(writes, NOW + 2 * SECOND)).toEqual({
        at: NOW - 5 * SECOND,
        unread: NONE,
      });
      expect(files.count("readdir")).toBe(0);
    });

    test("a folder that could not be listed is listed at the next call", async () => {
      const files = memoryFiles();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      let refuses = false;
      const io = {
        ...files.io,
        readdir: async (dir: string) => {
          if (refuses) throw errno("EACCES");
          return files.io.readdir(dir);
        },
      };
      const writes = createSubagentWrites({ io });
      await lookAt(writes);

      refuses = true;
      const later = NOW + CHATS_REFRESH_MS;
      expect((await lookAt(writes, later)).unread).toEqual(REFUSED);
      expect((await lookAt(writes, later + 2 * SECOND)).unread).toEqual(REFUSED);

      refuses = false;
      files.write(agentFile(2), NEVER_OPENED, { mtimeMs: later });
      expect(await lookAt(writes, later + 4 * SECOND)).toEqual({ at: later, unread: NONE });
    });
  });

  describe("from one call to the next", () => {
    test.each([
      ["EACCES", REFUSED],
      ["EIO", FAILED],
    ])(
      "a file giving %s at a listing is counted at every call until the next, and after it",
      async (code, unread) => {
        const { files, writes } = setUp();
        files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
        files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - 2 * HOUR });
        files.fail(agentFile(1), code);
        for (let at = NOW; at <= NOW + 2 * CHATS_REFRESH_MS; at += 2 * SECOND) {
          expect((await lookAt(writes, at)).unread).toEqual(unread);
        }
      },
    );

    test("a file refused after its listing is counted at once", async () => {
      const { files, writes } = await seen();
      files.fail(agentFile(1));
      expect((await lookAt(writes, NOW + 2 * SECOND)).unread).toEqual(REFUSED);
    });

    test("between listings, at most so many refused files are looked at, beside those written to last", async () => {
      const { files, writes } = setUp();
      const refused = 3 * SUBAGENT_FILES_WATCHED;
      const total = refused + SUBAGENT_FILES_WATCHED;
      for (let number = 1; number <= total; number += 1) {
        files.write(agentFile(number), NEVER_OPENED, { mtimeMs: NOW - HOUR });
        if (number <= refused) files.fail(agentFile(number));
      }
      await lookAt(writes);
      expect(files.count("lstat", (target) => target.endsWith(".jsonl"))).toBe(total);

      files.forget();
      expect((await lookAt(writes, NOW + 2 * SECOND)).unread).toEqual(REFUSED);
      expect(files.count("lstat", (target) => target.endsWith(".jsonl"))).toBe(
        2 * SUBAGENT_FILES_WATCHED,
      );
    });

    test("a folder with nothing refused costs what it did: only those written to last are looked at", async () => {
      const { files, writes } = setUp();
      for (let number = 1; number <= SUBAGENT_FILES_WATCHED + 4; number += 1) {
        files.write(agentFile(number), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      }
      await lookAt(writes);
      files.forget();
      await lookAt(writes, NOW + 2 * SECOND);
      expect(files.count("lstat", (target) => target.endsWith(".jsonl"))).toBe(
        SUBAGENT_FILES_WATCHED,
      );
    });
  });

  describe("does not take the time back", () => {
    /** When the folder is next due a listing, counted from `NOW`. */
    const LISTING = NOW + CHATS_REFRESH_MS;

    /** Writes over a folder of these files, whose listings fail with this code once `stopListing` is called. */
    function listingThatStops(files: ReturnType<typeof memoryFiles>, code: string) {
      let stopped = false;
      const writes = createSubagentWrites({
        io: {
          ...files.io,
          readdir: async (dir) => {
            if (stopped) throw errno(code);
            return files.io.readdir(dir);
          },
        },
      });
      return {
        writes,
        stopListing: () => {
          stopped = true;
        },
      };
    }

    /** A folder of one file, listed once, that cannot be listed from then on. */
    async function seenThenNotListed(code: string) {
      const files = memoryFiles();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - 5 * SECOND });
      const { writes, stopListing } = listingThatStops(files, code);
      await lookAt(writes);
      stopListing();
      return { files, writes };
    }

    /**
     * A folder of more files than are looked at between listings, looked at
     * once. The file written to last is the last by name, so a cut to the first
     * names leaves it out.
     */
    async function seenManyFiles() {
      const context = setUp();
      const last = agentFile(SUBAGENT_FILES_WATCHED + 4);
      const all = Array.from({ length: SUBAGENT_FILES_WATCHED + 4 }, (_, index) =>
        agentFile(index + 1),
      );
      for (const file of all) {
        context.files.write(file, NEVER_OPENED, {
          mtimeMs: file === last ? NOW - 5 * SECOND : NOW - HOUR,
        });
      }
      expect(await lookAt(context.writes)).toEqual({ at: NOW - 5 * SECOND, unread: NONE });
      return {
        ...context,
        last,
        failAll: () => all.forEach((file) => context.files.fail(file)),
        healAll: () => all.forEach((file) => context.files.heal(file)),
      };
    }

    test("when the folder's lstat is refused", async () => {
      const { files, writes } = await seen();
      files.fail(FOLDER);
      expect(await lookAt(writes, NOW + 2 * SECOND)).toEqual({
        at: NOW - 5 * SECOND,
        unread: REFUSED,
      });
    });

    test("for as long as the folder's lstat is refused", async () => {
      const { files, writes } = await seen();
      files.fail(FOLDER);
      for (const at of [NOW + 2 * SECOND, NOW + 4 * SECOND, LISTING]) {
        expect(await lookAt(writes, at)).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
      }
    });

    test("when the folder cannot be listed", async () => {
      const { writes } = await seenThenNotListed("EIO");
      expect(await lookAt(writes, LISTING)).toEqual({ at: NOW - 5 * SECOND, unread: FAILED });
    });

    test("for as long as the folder cannot be listed", async () => {
      const { writes } = await seenThenNotListed("EACCES");
      for (const at of [LISTING, LISTING + 2 * SECOND]) {
        expect(await lookAt(writes, at)).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
      }
    });

    test("and a write to a file it knows moves it on while the folder cannot be listed", async () => {
      const { files, writes } = await seenThenNotListed("EACCES");
      for (const at of [LISTING, LISTING + 2 * SECOND, LISTING + 4 * SECOND]) {
        files.append(agentFile(1), "\n", { mtimeMs: at - SECOND });
        expect(await lookAt(writes, at)).toEqual({ at: at - SECOND, unread: REFUSED });
      }
    });

    test("when a file it knows goes while the folder cannot be listed", async () => {
      const { files, writes } = await seenThenNotListed("EACCES");
      files.remove(agentFile(1));
      expect(await lookAt(writes, LISTING)).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
    });

    test("while the folder cannot be listed, only the files looked at until then are looked at", async () => {
      const files = memoryFiles();
      for (let number = 1; number <= SUBAGENT_FILES_WATCHED + 4; number += 1) {
        files.write(agentFile(number), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      }
      const { writes, stopListing } = listingThatStops(files, "EACCES");
      await lookAt(writes);
      stopListing();
      files.forget();
      await lookAt(writes, LISTING);
      expect(files.count("lstat", (target) => target.endsWith(".jsonl"))).toBe(
        SUBAGENT_FILES_WATCHED,
      );
    });

    test.each([
      ["EIO", "EACCES", REFUSED],
      ["EACCES", "EIO", REFUSED],
      ["EIO", "EIO", FAILED],
    ])(
      "a listing that gives %s and a file that gives %s count once, as refused if either is",
      async (listing, file, unread) => {
        const { files, writes } = await seenThenNotListed(listing);
        files.fail(agentFile(1), file);
        expect(await lookAt(writes, LISTING)).toEqual({ at: NOW - 5 * SECOND, unread });
      },
    );

    test("when the file that gave it is refused between listings, or at one", async () => {
      const { files, writes } = setUp();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - 5 * SECOND });
      files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      await lookAt(writes);
      files.fail(agentFile(1));
      const between = await lookAt(writes, NOW + 2 * SECOND);
      expect(between).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
      const listing = await lookAt(writes, NOW + CHATS_REFRESH_MS);
      expect(listing).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
    });

    test("past the listing that finds its file refused", async () => {
      const { files, writes } = setUp();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - 5 * SECOND });
      files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      await lookAt(writes);
      files.fail(agentFile(1));
      for (const at of [LISTING, LISTING + 2 * SECOND]) {
        expect(await lookAt(writes, at)).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
      }
    });

    test("when more files are refused at a listing than are looked at until the next, and they recover", async () => {
      const { failAll, healAll, writes } = await seenManyFiles();
      failAll();
      expect(await lookAt(writes, LISTING)).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
      healAll();
      for (const at of [LISTING + 2 * SECOND, LISTING + 4 * SECOND]) {
        expect(await lookAt(writes, at)).toEqual({ at: NOW - 5 * SECOND, unread: NONE });
      }
    });

    test("when they are refused again before the next listing", async () => {
      const { failAll, healAll, writes } = await seenManyFiles();
      failAll();
      await lookAt(writes, LISTING);
      healAll();
      await lookAt(writes, LISTING + 2 * SECOND);
      failAll();
      for (const at of [LISTING + 4 * SECOND, LISTING + 6 * SECOND, 2 * LISTING - NOW]) {
        expect(await lookAt(writes, at)).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
      }
    });

    test("and the file that led is still looked at past such a listing, so a write to it is seen at once", async () => {
      const { failAll, files, healAll, last, writes } = await seenManyFiles();
      failAll();
      await lookAt(writes, LISTING);
      healAll();
      files.append(last, "\n", { mtimeMs: LISTING + SECOND });
      files.forget();
      expect(await lookAt(writes, LISTING + 2 * SECOND)).toEqual({
        at: LISTING + SECOND,
        unread: NONE,
      });
      expect(files.count("readdir")).toBe(0);
    });

    test("when a listing leaves out the file that led, until one has looked at every file", async () => {
      const { failAll, files, healAll, last, writes } = await seenManyFiles();
      // It is the only one refused, so it goes behind those written to last.
      files.fail(last);
      await lookAt(writes, LISTING);
      // So the next listing, which can look at none, is the one that cuts it.
      failAll();
      const cut = 2 * LISTING - NOW;
      expect(await lookAt(writes, cut)).toEqual({ at: NOW - 5 * SECOND, unread: REFUSED });
      files.forget();
      healAll();
      expect(await lookAt(writes, cut + 2 * SECOND)).toEqual({
        at: NOW - 5 * SECOND,
        unread: NONE,
      });
      expect(files.count("lstat", (target) => target === last)).toBe(0);

      // A listing that looks at them all says what is there, which is lower.
      files.remove(last);
      expect(await lookAt(writes, cut + CHATS_REFRESH_MS)).toEqual({
        at: NOW - HOUR,
        unread: NONE,
      });
    });

    test("and a newer write to a file that can be looked at still moves it on", async () => {
      const { files, writes } = setUp();
      files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - 5 * SECOND });
      files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - HOUR });
      await lookAt(writes);
      files.fail(agentFile(1));
      files.append(agentFile(2), "\n", { mtimeMs: NOW + SECOND });
      expect((await lookAt(writes, NOW + 2 * SECOND)).at).toBe(NOW + SECOND);
      // What it moved to stands, though that file is refused too by then.
      files.fail(agentFile(2));
      expect((await lookAt(writes, NOW + 4 * SECOND)).at).toBe(NOW + SECOND);
    });

    test("though a time that could no longer be right is not stood by", async () => {
      const { files, writes } = await seen();
      files.fail(FOLDER);
      expect(await lookAt(writes, NOW - HOUR)).toEqual({ at: undefined, unread: REFUSED });
    });

    test("a folder that goes takes its time with it, as a look that told something", async () => {
      const { files, writes } = await seen();
      files.fail(FOLDER);
      await lookAt(writes, NOW + 2 * SECOND);
      files.heal(FOLDER);
      files.remove(FOLDER);
      expect(await lookAt(writes, NOW + 4 * SECOND)).toEqual({ at: undefined, unread: NONE });
      expect(writes.size).toBe(0);
    });

    test("what is kept of it goes with the rest", async () => {
      const { files, writes } = await seen();
      files.fail(FOLDER);
      writes.forget();
      expect(await lookAt(writes, NOW + 2 * SECOND)).toEqual({ at: undefined, unread: REFUSED });
    });
  });

  test("nothing is opened, and only lstat and readdir are asked", async () => {
    const { files, writes } = setUp();
    files.write(agentFile(1), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.write(agentFile(2), NEVER_OPENED, { mtimeMs: NOW - HOUR });
    files.fail(agentFile(1));
    await lookAt(writes);
    await lookAt(writes, NOW + 2 * SECOND);
    expect(new Set(files.calls.map(({ method }) => method))).toEqual(new Set(["lstat", "readdir"]));
  });
});
