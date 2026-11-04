import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createIndexReader,
  folderOf,
  MAX_INDEX_BYTES,
  parseIndex,
} from "@collector/adapters/continue/sessionIndex";
import {
  CREATED_AT,
  entryOf,
  INDEX,
  indexText,
  NOW,
  PRIVATE_TITLE,
  PROJECT,
  PROJECT_URI,
  SESSION_ID,
  sessionIdOf,
} from "@tests/fixtures/continue/continue";
import { memoryFiles } from "@tests/support/adapters/continue/continueAdapter";

const readerOf = (files: ReturnType<typeof memoryFiles>) =>
  createIndexReader(path.resolve(INDEX), files.io, "darwin");

describe("a session's folder", () => {
  test("cn's is the path it runs in", () => {
    expect(folderOf(PROJECT, "darwin")).toBe(PROJECT);
    expect(folderOf(PROJECT, "linux")).toBe(PROJECT);
    expect(folderOf("C:\\Users\\example\\code\\demo", "win32")).toBe(
      "C:\\Users\\example\\code\\demo",
    );
  });

  test("an editor's is the URI of its first workspace folder", () => {
    expect(folderOf(PROJECT_URI, "darwin")).toBe(PROJECT);
    expect(folderOf("file:///home/example/my%20demo", "linux")).toBe("/home/example/my demo");
    expect(folderOf("file:///Users/example/c%C3%B3digo", "darwin")).toBe("/Users/example/código");
  });

  test("on Windows, as VS Code writes one and as a JetBrains editor does", () => {
    expect(folderOf("file:///c%3A/Users/example/code/demo", "win32")).toBe(
      "c:\\Users\\example\\code\\demo",
    );
    expect(folderOf("file:///C:/Users/example/code/demo", "win32")).toBe(
      "C:\\Users\\example\\code\\demo",
    );
  });

  test("a workspace on another machine is no folder here", () => {
    expect(folderOf("vscode-remote://ssh-remote%2Bdevbox/home/example/demo", "darwin")).toBeNull();
    expect(folderOf("vscode-remote://ssh-remote%2Bdevbox/home/example/demo", "win32")).toBeNull();
    expect(folderOf("file://devbox/home/example/demo", "darwin")).toBeNull();
  });

  test.each([
    ["nothing", ""],
    ["a relative path", "code/demo"],
    ["a number", 7],
    ["null", null],
    ["no value", undefined],
    ["an object", { path: PROJECT }],
    ["a line break", "/Users/example/de\nmo"],
    ["a line break in a URI", "file:///Users/example/de%0Amo"],
    ["a broken URI", "file:///Users/example/%E0%A4%A"],
    ["a folder too long to be one", `/${"a".repeat(5_000)}`],
  ])("%s is no folder", (_name, value) => {
    expect(folderOf(value, "darwin")).toBeNull();
  });
});

describe("parsing the list", () => {
  test("keeps a session's id, folder and time, and nothing else", () => {
    expect(parseIndex(indexText([entryOf(SESSION_ID)]), "darwin")).toEqual([
      { id: SESSION_ID, folder: PROJECT, createdAt: CREATED_AT },
    ]);
  });

  test("never keeps a title", () => {
    const text = indexText([entryOf(SESSION_ID)]);
    expect(text).toContain(PRIVATE_TITLE);
    expect(JSON.stringify(parseIndex(text, "darwin"))).not.toContain(PRIVATE_TITLE);
  });

  test("an empty file is an empty list, as it is for Continue", () => {
    expect(parseIndex("", "darwin")).toEqual([]);
    expect(parseIndex("  \n", "darwin")).toEqual([]);
    expect(parseIndex("[]", "darwin")).toEqual([]);
  });

  test.each([
    ["half a file", '[\n  {\n    "sessionId": "abc'],
    ["an object", "{}"],
    ["a number", "7"],
    ["null", "null"],
    ["a word", "not json"],
  ])("%s is no list", (_name, text) => {
    expect(parseIndex(text, "darwin")).toBeNull();
  });

  test.each([
    ["no id", { sessionId: undefined }],
    ["a number for an id", { sessionId: 7 }],
    ["an id that would leave the folder", { sessionId: "../../elsewhere" }],
    ["an id with a separator", { sessionId: "one/two" }],
    ["an id of dots", { sessionId: ".." }],
    ["an id too long to be one", { sessionId: "a".repeat(201) }],
  ])("an entry with %s is passed over", (_name, changes) => {
    expect(parseIndex(indexText([entryOf(SESSION_ID, changes)]), "darwin")).toEqual([]);
  });

  test("an id of 200 characters is kept", () => {
    const id = "a".repeat(200);
    expect(parseIndex(indexText([entryOf(id)]), "darwin")).toEqual([
      { id, folder: PROJECT, createdAt: CREATED_AT },
    ]);
  });

  test("an entry in Continue's old format is passed over, as Continue passes it over", () => {
    const old = { session_id: sessionIdOf(2), title: PRIVATE_TITLE, date_created: "1" };
    const sessions = parseIndex(indexText([old, entryOf(SESSION_ID)]), "darwin");
    expect(sessions?.map((session) => session.id)).toEqual([SESSION_ID]);
  });

  test.each([[7], ["null"], [null], [[]], ["not a list"]])(
    "an entry of %j among good ones is passed over",
    (entry) => {
      const sessions = parseIndex(indexText([entry, entryOf(SESSION_ID)]), "darwin");
      expect(sessions?.map((session) => session.id)).toEqual([SESSION_ID]);
    },
  );

  test.each([
    ["a time in words", "yesterday"],
    ["a date", "2026-10-01T12:00:00.000Z"],
    ["a number", CREATED_AT],
    ["a negative time", "-1"],
    ["a fraction", "1790000000000.5"],
    ["more digits than a time has", "9".repeat(40)],
    ["null", null],
  ])("%s for a time is treated as none", (_name, dateCreated) => {
    const [session] = parseIndex(indexText([entryOf(SESSION_ID, { dateCreated })]), "darwin") ?? [];
    expect(session).toEqual({ id: SESSION_ID, folder: PROJECT, createdAt: null });
  });

  test("a bad folder is treated as none, and leaves the session listed", () => {
    const [session] =
      parseIndex(indexText([entryOf(SESSION_ID, { workspaceDirectory: 7 })]), "darwin") ?? [];
    expect(session).toEqual({ id: SESSION_ID, folder: null, createdAt: CREATED_AT });
  });

  test("one id written twice is one session, and the later entry stands", () => {
    const sessions = parseIndex(
      indexText([entryOf(SESSION_ID), entryOf(SESSION_ID, { workspaceDirectory: "/elsewhere" })]),
      "darwin",
    );
    expect(sessions).toEqual([{ id: SESSION_ID, folder: "/elsewhere", createdAt: CREATED_AT }]);
  });
});

describe("reading the list", () => {
  const list = indexText([entryOf(SESSION_ID)]);

  test("is opened once, and again only when it changes", async () => {
    const files = memoryFiles();
    files.write(INDEX, list, { mtimeMs: NOW });
    const reader = readerOf(files);

    const first = await reader.read();
    expect(first).toMatchObject({ state: "ok" });
    await reader.read();
    await reader.read();
    expect(files.opened()).toHaveLength(1);

    files.rewrite(INDEX, indexText([entryOf(SESSION_ID), entryOf(sessionIdOf(2))]), {
      mtimeMs: NOW + 1,
    });
    const next = await reader.read();
    expect(next.state === "ok" && next.sessions).toHaveLength(2);
    expect(files.opened()).toHaveLength(2);
    expect(files.openHandles()).toBe(0);
  });

  test("is read again when only its size changes", async () => {
    const files = memoryFiles();
    files.write(INDEX, list, { mtimeMs: NOW });
    const reader = readerOf(files);
    await reader.read();
    files.rewrite(INDEX, indexText([entryOf(SESSION_ID), entryOf(sessionIdOf(2))]), {
      mtimeMs: NOW,
    });
    const next = await reader.read();
    expect(next.state === "ok" && next.sessions).toHaveLength(2);
  });

  test("is read again when only its identity changes", async () => {
    const files = memoryFiles();
    files.write(INDEX, list, { mtimeMs: NOW });
    const reader = readerOf(files);
    await reader.read();
    files.write(INDEX, indexText([entryOf(sessionIdOf(2))]), { mtimeMs: NOW });
    const next = await reader.read();
    expect(next.state === "ok" && next.sessions.map((one) => one.id)).toEqual([sessionIdOf(2)]);
  });

  test("a folder in any script comes through whole", async () => {
    const folder = "/Users/example/código/デモ";
    const files = memoryFiles();
    files.write(INDEX, indexText([entryOf(SESSION_ID, { workspaceDirectory: folder })]), {
      mtimeMs: NOW,
    });
    const read = await readerOf(files).read();
    expect(read.state === "ok" && read.sessions[0].folder).toBe(folder);
  });

  test("a missing file is said to be missing", async () => {
    expect(await readerOf(memoryFiles()).read()).toEqual({ state: "missing" });
  });

  test("a link or anything else in place of the file is not opened", async () => {
    const files = memoryFiles();
    files.special(INDEX);
    expect(await readerOf(files).read()).toEqual({ state: "unreadable" });
    expect(files.opened()).toEqual([]);
  });

  test("a file over the most read is not read at all", async () => {
    const files = memoryFiles();
    files.write(INDEX, "x".repeat(MAX_INDEX_BYTES + 1), { mtimeMs: NOW });
    expect(await readerOf(files).read()).toEqual({ state: "too-large" });
    expect(files.reads).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("a file of exactly the most read is read", async () => {
    const files = memoryFiles();
    files.write(INDEX, list.padEnd(MAX_INDEX_BYTES, " "), { mtimeMs: NOW });
    expect(await readerOf(files).read()).toMatchObject({ state: "ok" });
  });

  test("a broken file with nothing read before is said to be broken, and not read again until it changes", async () => {
    const files = memoryFiles();
    files.write(INDEX, "not json", { mtimeMs: NOW });
    const reader = readerOf(files);
    expect(await reader.read()).toEqual({ state: "broken" });
    expect(await reader.read()).toEqual({ state: "broken" });
    expect(files.opened()).toHaveLength(1);
  });

  describe("caught as Continue writes it", () => {
    test("half written, what was read before stands in once", async () => {
      const files = memoryFiles();
      files.write(INDEX, list, { mtimeMs: NOW });
      const reader = readerOf(files);
      const good = await reader.read();

      files.rewrite(INDEX, list.slice(0, 20), { mtimeMs: NOW + 1 });
      expect(await reader.read()).toEqual(good);

      // Still broken on the next poll: it is not caught half way, and is broken.
      expect(await reader.read()).toEqual({ state: "broken" });
      expect(await reader.read()).toEqual({ state: "broken" });
    });

    test("empty, what was read before stands in once, so no session seems to end", async () => {
      const files = memoryFiles();
      files.write(INDEX, list, { mtimeMs: NOW });
      const reader = readerOf(files);
      const good = await reader.read();

      files.rewrite(INDEX, "", { mtimeMs: NOW + 1 });
      expect(await reader.read()).toEqual(good);
      expect(await reader.read()).toEqual({ state: "ok", sessions: [] });
    });

    test("whole again on the next poll, it is read as usual", async () => {
      const files = memoryFiles();
      files.write(INDEX, list, { mtimeMs: NOW });
      const reader = readerOf(files);
      await reader.read();

      files.rewrite(INDEX, list.slice(0, 20), { mtimeMs: NOW + 1 });
      await reader.read();
      files.rewrite(INDEX, indexText([entryOf(sessionIdOf(2))]), { mtimeMs: NOW + 2 });
      const next = await reader.read();
      expect(next.state === "ok" && next.sessions.map((one) => one.id)).toEqual([sessionIdOf(2)]);

      // And what is read then can stand in once more.
      files.rewrite(INDEX, "", { mtimeMs: NOW + 3 });
      expect(await reader.read()).toEqual(next);
    });

    test("broken after a list with no sessions, it is said to be broken at once", async () => {
      const files = memoryFiles();
      files.write(INDEX, "[]", { mtimeMs: NOW });
      const reader = readerOf(files);
      await reader.read();
      files.rewrite(INDEX, "not json", { mtimeMs: NOW + 1 });
      expect(await reader.read()).toEqual({ state: "broken" });
    });

    test("grown past the most read, it is said to be too large at once", async () => {
      const files = memoryFiles();
      files.write(INDEX, list, { mtimeMs: NOW });
      const reader = readerOf(files);
      await reader.read();
      files.rewrite(INDEX, "x".repeat(MAX_INDEX_BYTES + 1), { mtimeMs: NOW + 1 });
      expect(await reader.read()).toEqual({ state: "too-large" });
    });

    test("a list that went and came back empty has nothing to stand in", async () => {
      const files = memoryFiles();
      files.write(INDEX, list, { mtimeMs: NOW });
      const reader = readerOf(files);
      await reader.read();
      files.remove(INDEX);
      await reader.read();
      files.write(INDEX, "", { mtimeMs: NOW + 1 });
      expect(await reader.read()).toEqual({ state: "ok", sessions: [] });
    });

    test("a link in between leaves nothing to stand in", async () => {
      const files = memoryFiles();
      files.write(INDEX, list, { mtimeMs: NOW });
      const reader = readerOf(files);
      await reader.read();
      files.remove(INDEX);
      files.special(INDEX);
      await reader.read();
      files.remove(INDEX);
      files.write(INDEX, "", { mtimeMs: NOW + 1 });
      expect(await reader.read()).toEqual({ state: "ok", sessions: [] });
    });
  });

  test("an open that fails leaves what was read before, and is tried again", async () => {
    const files = memoryFiles();
    files.write(INDEX, list, { mtimeMs: NOW });
    const reader = readerOf(files);
    const good = await reader.read();

    files.rewrite(INDEX, indexText([entryOf(sessionIdOf(2))]), { mtimeMs: NOW + 1 });
    files.failOpen(INDEX);
    expect(await reader.read()).toEqual(good);

    files.heal(INDEX);
    const next = await reader.read();
    expect(next.state === "ok" && next.sessions.map((one) => one.id)).toEqual([sessionIdOf(2)]);
  });

  test("an open that fails with nothing read before is unreadable", async () => {
    const files = memoryFiles();
    files.write(INDEX, list, { mtimeMs: NOW });
    files.failOpen(INDEX);
    expect(await readerOf(files).read()).toEqual({ state: "unreadable" });
  });

  test("a look that fails leaves what was read before", async () => {
    const files = memoryFiles();
    files.write(INDEX, list, { mtimeMs: NOW });
    const reader = readerOf(files);
    const good = await reader.read();
    files.fail(INDEX);
    expect(await reader.read()).toEqual(good);
  });

  test("a look that fails with nothing read before is unreadable", async () => {
    const files = memoryFiles();
    files.write(INDEX, list, { mtimeMs: NOW });
    files.fail(INDEX);
    expect(await readerOf(files).read()).toEqual({ state: "unreadable" });
  });

  test("a file removed after it was read is missing", async () => {
    const files = memoryFiles();
    files.write(INDEX, list, { mtimeMs: NOW });
    const reader = readerOf(files);
    await reader.read();
    files.remove(INDEX);
    expect(await reader.read()).toEqual({ state: "missing" });
  });
});
