import { describe, expect, test } from "vitest";

import {
  createSessionIndexReader,
  parseSessionIndex,
  SESSION_INDEX_FILE,
  SESSION_INDEX_LIMIT_BYTES,
} from "@collector/adapters/codex/sessionIndex";
import { CODEX_HOME, ids, indexLine, threadId } from "@tests/fixtures/codex";
import { memoryFiles } from "@tests/support/codexAdapter";

const FILE = `${CODEX_HOME}/${SESSION_INDEX_FILE}`;
const lines = (...all: string[]) => all.map((line) => `${line}\n`).join("");

describe("parseSessionIndex", () => {
  test("the newest name for a session wins", () => {
    const names = parseSessionIndex(
      lines(
        indexLine(ids.working, "first-try"),
        indexLine(ids.idle, "demo-api-review"),
        indexLine(ids.working, "demo-project"),
      ),
    );
    expect(names).toEqual(
      new Map([
        [ids.working, "demo-project"],
        [ids.idle, "demo-api-review"],
      ]),
    );
  });

  test("lines that are malformed, or have no id or no name, are skipped", () => {
    const names = parseSessionIndex(
      lines(
        indexLine(ids.working, "demo-project"),
        "not json",
        '{"id":"00000000-0000-4000-8000-0000000000c2","thread_name":"cut-of',
        "[]",
        "null",
        JSON.stringify({ thread_name: "no-id" }),
        JSON.stringify({ id: "", thread_name: "empty-id" }),
        JSON.stringify({ id: ids.idle }),
        JSON.stringify({ id: ids.idle, thread_name: 7 }),
        JSON.stringify({ id: ids.idle, thread_name: "   " }),
        // A blank later name does not wipe out a real earlier one.
        JSON.stringify({ id: ids.working, thread_name: "" }),
        "",
      ),
    );
    expect(names).toEqual(new Map([[ids.working, "demo-project"]]));
  });

  test("ids are matched in lowercase and names are trimmed", () => {
    const names = parseSessionIndex(
      lines(indexLine(ids.working.toUpperCase(), "  demo-project  ")),
    );
    expect(names.get(ids.working)).toBe("demo-project");
  });
});

describe("createSessionIndexReader", () => {
  test("no file means no names, and nothing is opened", async () => {
    const files = memoryFiles();
    const reader = createSessionIndexReader(FILE, files.io);
    expect(await reader.names()).toEqual(new Map());
    expect(files.opened()).toEqual([]);
  });

  test("the file is read again only when it has changed", async () => {
    const files = memoryFiles();
    files.write(FILE, lines(indexLine(ids.working, "first-try")), { mtimeMs: 1 });
    const reader = createSessionIndexReader(FILE, files.io);

    expect((await reader.names()).get(ids.working)).toBe("first-try");
    expect(await reader.names()).toEqual(new Map([[ids.working, "first-try"]]));
    expect(files.opened()).toHaveLength(1);

    // A rename is an appended line: the size changes.
    files.append(FILE, lines(indexLine(ids.working, "demo-project")), { mtimeMs: 2 });
    expect((await reader.names()).get(ids.working)).toBe("demo-project");
    expect(files.opened()).toHaveLength(2);

    // Rewritten in place to the same size: only the time says so.
    const sameSize = (name: string) =>
      lines(indexLine(ids.working, "first-try"), indexLine(ids.working, name));
    expect(sameSize("demo-projekt")).toHaveLength(sameSize("demo-project").length);
    files.rewrite(FILE, sameSize("demo-projekt"), { mtimeMs: 3 });
    expect((await reader.names()).get(ids.working)).toBe("demo-projekt");
    expect(files.opened()).toHaveLength(3);

    // Replaced by another file of the same size and time: only its identity says so.
    files.write(FILE, sameSize("demo-projecz"), { mtimeMs: 3 });
    expect((await reader.names()).get(ids.working)).toBe("demo-projecz");
    expect(files.opened()).toHaveLength(4);

    expect(files.openHandles()).toBe(0);
  });

  test("a file over the limit is read from its last 4 MiB, and the cut line before them is dropped", async () => {
    const files = memoryFiles();
    const early = indexLine(threadId("e1"), "early-name");
    const filler = indexLine(threadId("e2"), "x".repeat(1000));
    let content = `${early}\n`;
    while (content.length < SESSION_INDEX_LIMIT_BYTES + 10_000) content += `${filler}\n`;
    content += lines(indexLine(ids.working, "demo-project"));
    files.write(FILE, content);

    const names = await createSessionIndexReader(FILE, files.io).names();
    expect(names.get(ids.working)).toBe("demo-project");
    expect(names.get(threadId("e2"))).toBe("x".repeat(1000));
    // A name given only in the part before the last 4 MiB is not read.
    expect(names.has(threadId("e1"))).toBe(false);
    expect(Math.max(...files.reads.map((read) => read.length))).toBeLessThanOrEqual(
      SESSION_INDEX_LIMIT_BYTES,
    );
  });

  test("a file that cannot be read keeps the names it gave last time", async () => {
    const files = memoryFiles();
    files.write(FILE, lines(indexLine(ids.working, "demo-project")), { mtimeMs: 1 });
    const reader = createSessionIndexReader(FILE, files.io);
    await reader.names();

    files.append(FILE, lines(indexLine(ids.idle, "demo-api")), { mtimeMs: 2 });
    files.fail(FILE, "EACCES");
    expect(await reader.names()).toEqual(new Map([[ids.working, "demo-project"]]));

    files.heal(FILE);
    expect((await reader.names()).get(ids.idle)).toBe("demo-api");
  });

  test("a file that goes away takes its names with it", async () => {
    const files = memoryFiles();
    files.write(FILE, lines(indexLine(ids.working, "demo-project")));
    const reader = createSessionIndexReader(FILE, files.io);
    expect((await reader.names()).size).toBe(1);

    files.remove(FILE);
    expect(await reader.names()).toEqual(new Map());
  });

  test("a link or a pipe under that name is not read", async () => {
    const files = memoryFiles();
    files.special(FILE);
    expect(await createSessionIndexReader(FILE, files.io).names()).toEqual(new Map());
    expect(files.opened()).toEqual([]);
  });
});
