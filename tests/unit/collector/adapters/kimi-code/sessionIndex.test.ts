import { describe, expect, test } from "vitest";

import {
  createIndexReader,
  folderOf,
  INDEX_LIMIT_BYTES,
  parseIndex,
} from "@collector/adapters/kimi-code/sessionIndex";
import {
  BUCKET,
  deletedLine,
  indexFile,
  indexLine,
  KIMI_HOME,
  NOW,
  PROJECT,
  sessionIdOf,
} from "@tests/fixtures/kimi-code/kimiCode";
import { memoryFiles, oneChangeEach } from "@tests/support/adapters/kimi-code/kimiCodeAdapter";

const ID = sessionIdOf(1);
const OTHER = sessionIdOf(2);

describe("parseIndex", () => {
  const parsed = (text: string, platform: NodeJS.Platform = "darwin") => [
    ...parseIndex(text, platform).values(),
  ];

  test("takes each session's id, bucket and folder", () => {
    expect(parsed(indexLine(ID))).toEqual([{ id: ID, bucket: BUCKET, folder: PROJECT }]);
  });

  test("a later line replaces an earlier one, and a deletion removes it", () => {
    const moved = indexLine(ID, { workDir: `${PROJECT}-two` });
    expect(parsed(indexLine(ID) + moved)[0]?.folder).toBe(`${PROJECT}-two`);
    expect(parsed(indexLine(ID) + indexLine(OTHER) + deletedLine(ID))).toEqual([
      { id: OTHER, bucket: BUCKET, folder: PROJECT },
    ]);
  });

  test("takes the bucket from a folder written on Windows", () => {
    const sessionDir = `C:\\Users\\example\\.kimi-code\\sessions\\${BUCKET}\\${ID}`;
    expect(parsed(indexLine(ID, { sessionDir }), "win32")[0]?.bucket).toBe(BUCKET);
  });

  test("never takes a path that leaves the folder of sessions", () => {
    for (const sessionDir of [
      `/elsewhere/${BUCKET}/${ID}`,
      `/Users/example/.kimi-code/sessions/../${ID}`,
      `/Users/example/.kimi-code/sessions/${BUCKET}/${OTHER}`,
      `/Users/example/.kimi-code/sessions/.hidden/${ID}`,
    ]) {
      expect(parsed(indexLine(ID, { sessionDir })), sessionDir).toEqual([]);
    }
  });

  test("skips a broken line, a line of another kind and an id that could not name a folder", () => {
    const text = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ sessionId: 5, sessionDir: "x" }),
      JSON.stringify({ alias: "demo" }),
      indexLine("../escape").trim(),
      indexLine(ID).trim(),
    ].join("\n");
    expect(parsed(text).map(({ id }) => id)).toEqual([ID]);
  });

  test("a session whose folder is no folder keeps the rest of its line", () => {
    for (const workDir of ["relative/path", 7, "", `${PROJECT}\u0000x`, "/x".repeat(3000)]) {
      expect(parsed(indexLine(ID, { workDir }))[0]?.folder).toBeNull();
    }
  });
});

describe("folderOf", () => {
  test("goes by the system's own rules", () => {
    expect(folderOf("C:\\Users\\example\\code", "win32")).toBe("C:\\Users\\example\\code");
    expect(folderOf("C:\\Users\\example\\code", "darwin")).toBeNull();
    expect(folderOf(PROJECT, "linux")).toBe(PROJECT);
  });
});

describe("createIndexReader", () => {
  const reader = (files: ReturnType<typeof memoryFiles>) =>
    createIndexReader(indexFile(), files.io, "darwin");

  test("says when there is no index", async () => {
    expect(await reader(memoryFiles(() => NOW)).read()).toEqual({ state: "missing" });
  });

  test("reads the file only when it changes", async () => {
    const files = memoryFiles(() => NOW);
    files.write(indexFile(), indexLine(ID));
    const index = reader(files);
    await index.read();
    await index.read();
    expect(files.opened()).toEqual([indexFile()]);

    files.append(indexFile(), indexLine(OTHER), { mtimeMs: NOW + 1 });
    const read = await index.read();
    expect(read.state === "ok" && [...read.sessions.keys()]).toEqual([ID, OTHER]);
    expect(files.opened()).toHaveLength(2);
  });

  test.each(oneChangeEach(indexLine(ID), NOW))(
    "reads the file again when only its %s changes",
    async (_what, change) => {
      const files = memoryFiles(() => NOW);
      files.write(indexFile(), indexLine(ID));
      const index = reader(files);
      await index.read();
      change(files, indexFile());
      files.forget();
      await index.read();
      expect(files.opened()).toEqual([indexFile()]);
    },
  );

  test("reads at most the end of a long index, and drops the line it cut into", async () => {
    const files = memoryFiles(() => NOW);
    const long = indexLine(OTHER, { padding: "x".repeat(INDEX_LIMIT_BYTES) });
    files.write(indexFile(), long + indexLine(ID));
    const read = await reader(files).read();
    expect(files.reads).toEqual([
      {
        path: indexFile(),
        position: long.length + indexLine(ID).length - INDEX_LIMIT_BYTES,
        length: INDEX_LIMIT_BYTES,
      },
    ]);
    expect(read.state === "ok" && [...read.sessions.keys()]).toEqual([ID]);
  });

  test("a link at its name is not read", async () => {
    const files = memoryFiles(() => NOW);
    files.special(indexFile());
    expect(await reader(files).read()).toEqual({ state: "unreadable" });
    expect(files.opened()).toEqual([]);
  });

  test("a read that fails leaves what was read before, and is tried again", async () => {
    const files = memoryFiles(() => NOW);
    files.write(indexFile(), indexLine(ID));
    const index = reader(files);
    await index.read();

    files.append(indexFile(), indexLine(OTHER), { mtimeMs: NOW + 1 });
    files.failOpen(indexFile());
    const stood = await index.read();
    expect(stood.state === "ok" && [...stood.sessions.keys()]).toEqual([ID]);

    files.heal(indexFile());
    const read = await index.read();
    expect(read.state === "ok" && [...read.sessions.keys()]).toEqual([ID, OTHER]);
  });

  test("a read that fails with nothing read before cannot be used", async () => {
    const files = memoryFiles(() => NOW);
    files.write(indexFile(), indexLine(ID));
    files.failOpen(indexFile());
    expect(await reader(files).read()).toEqual({ state: "unreadable" });
  });

  test("a look that fails says nothing about the file, so what was read stands", async () => {
    const files = memoryFiles(() => NOW);
    files.write(indexFile(), indexLine(ID));
    const index = reader(files);
    await index.read();
    files.fail(indexFile());
    const stood = await index.read();
    expect(stood.state === "ok" && [...stood.sessions.keys()]).toEqual([ID]);
  });

  test("a home other than the default reads its own index", async () => {
    const files = memoryFiles(() => NOW);
    files.write(indexFile("/tmp/kimi"), indexLine(ID));
    expect(KIMI_HOME).not.toBe("/tmp/kimi");
    const read = await createIndexReader(indexFile("/tmp/kimi"), files.io, "linux").read();
    expect(read.state).toBe("ok");
  });
});
