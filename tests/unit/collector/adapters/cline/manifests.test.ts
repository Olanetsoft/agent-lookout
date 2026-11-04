import { describe, expect, test } from "vitest";

import {
  createManifestReader,
  isSessionFolderName,
  MAX_MANIFEST_BYTES,
  parseManifest,
} from "@collector/adapters/cline/manifests";
import {
  manifestFile,
  manifestText,
  messagesFile,
  NOW,
  PID,
  PLACEHOLDER,
  PRIVATE_SYSTEM_PROMPT,
  PRIVATE_WORDS,
  PROJECT,
  SESSIONS_DIR,
  sessionIdOf,
  STARTED_AT,
} from "@tests/fixtures/cline/cline";
import { memoryFiles } from "@tests/support/adapters/cline/clineAdapter";

const ID = sessionIdOf(1);
const FILE = manifestFile(ID);

const parse = (changes: Record<string, unknown> = {}, platform: NodeJS.Platform = "darwin") =>
  parseManifest(manifestText(ID, changes), ID, platform);

describe("isSessionFolderName", () => {
  test.each(["1790000000000_abc12", "demo.session-1_a"])("takes %s", (name) => {
    expect(isSessionFolderName(name)).toBe(true);
  });

  test.each(["", ".", "..", "../up", "a/b", "a\\b", ".hidden", "a b", "x".repeat(201)])(
    "does not take %j",
    (name) => {
      expect(isSessionFolderName(name)).toBe(false);
    },
  );
});

describe("parseManifest", () => {
  test("keeps the fields it needs and nothing else", () => {
    const manifest = parse({ ended_at: new Date(NOW).toISOString() });
    expect(manifest).toEqual({
      sessionId: ID,
      pid: PID,
      status: "running",
      cwd: PROJECT,
      startedAt: STARTED_AT,
      endedAt: NOW,
    });
    for (const word of [
      PRIVATE_WORDS,
      PRIVATE_SYSTEM_PROMPT,
      "demo task",
      "demo-model",
      "demo-provider",
      "compaction",
    ]) {
      expect(JSON.stringify(manifest)).not.toContain(word);
    }
  });

  test.each([
    ["not JSON", "{ half written"],
    ["empty", ""],
    ["an array", "[]"],
    ["a word", '"running"'],
    ["no version", JSON.stringify({ session_id: ID, status: "running" })],
    ["a version as text", manifestText(ID, { version: "1" })],
    ["a version before the first", manifestText(ID, { version: 0 })],
    ["another session's", manifestText(sessionIdOf(2))],
    ["no id", manifestText(ID, { session_id: undefined })],
  ])("%s is not a manifest", (_case, content) => {
    expect(parseManifest(content, ID, "darwin")).toBeNull();
  });

  test("a newer format is named, with nothing kept of it", () => {
    expect(parse({ version: 2 })).toBe("newer");
  });

  test.each([
    ["a word", "41001"],
    ["a fraction", 41001.5],
    ["zero", 0],
    ["below zero", -1],
    ["too large to be whole", 2 ** 60],
    ["no number", null],
  ])("a pid that is %s is none", (_case, pid) => {
    expect(parse({ pid })).toMatchObject({ pid: null });
  });

  test.each([
    ["a number", 3],
    ["null", null],
    ["a list", ["running"]],
    ["too long to be a word", "x".repeat(33)],
  ])("a status that is %s is none", (_case, status) => {
    expect(parse({ status })).toMatchObject({ status: null });
  });

  test.each([
    ["a number", 1_790_000_000_000],
    ["a day", "2026-10-01"],
    ["words", "yesterday"],
    ["a month that is not one", "2026-13-01T00:00:00.000Z"],
    ["no zone", "2026-10-01T12:00:00"],
    ["null", null],
  ])("a time that is %s is none", (_case, value) => {
    expect(parse({ started_at: value, ended_at: value })).toMatchObject({
      startedAt: null,
      endedAt: null,
    });
  });

  test.each([
    ["a number", 3],
    ["relative", "code/demo"],
    ["empty", ""],
    ["with a line break", "/Users/example/a\nb"],
    ["too long", `/${"x".repeat(4096)}`],
  ])("a folder that is %s is none", (_case, cwd) => {
    expect(parse({ cwd })).toMatchObject({ cwd: null });
  });

  test("a folder is judged by the system's own rules", () => {
    expect(parse({ cwd: "C:\\code\\demo" }, "win32")).toMatchObject({ cwd: "C:\\code\\demo" });
    expect(parse({ cwd: "C:\\code\\demo" }, "darwin")).toMatchObject({ cwd: null });
  });

  test.each([
    ["made from the first prompt", PRIVATE_WORDS],
    ["set with Cline's own command", "renamed"],
  ])("a title %s is not kept", (_case, title) => {
    expect(JSON.stringify(parse({ metadata: { title } }))).not.toContain(title);
  });
});

describe("createManifestReader", () => {
  async function setUp(content = manifestText(ID), mtimeMs = NOW) {
    const files = memoryFiles(() => NOW);
    files.write(FILE, content, { mtimeMs });
    files.write(messagesFile(ID), PLACEHOLDER, { mtimeMs });
    const reader = createManifestReader(SESSIONS_DIR, files.io, "darwin");
    const read = async () => reader.read(ID, await files.io.lstat(FILE));
    return { files, reader, read };
  }

  test("opens a manifest once until it changes, and closes it", async () => {
    const { files, read } = await setUp();
    expect(await read()).toMatchObject({ state: "ok", statusWrittenAt: NOW });
    await read();
    await read();
    expect(files.opened()).toEqual([FILE]);
    expect(files.openHandles()).toBe(0);

    files.rewrite(FILE, manifestText(ID, { status: "idle" }), { mtimeMs: NOW + 1_000 });
    expect(await read()).toMatchObject({
      state: "ok",
      manifest: { status: "idle" },
      statusWrittenAt: NOW + 1_000,
    });
    expect(files.opened()).toEqual([FILE, FILE]);
  });

  test("never opens the messages file", async () => {
    const { files, read } = await setUp();
    await read();
    expect(files.opened()).not.toContain(messagesFile(ID));
  });

  test("a file rewritten with the same status keeps the time that status began", async () => {
    const { files, read } = await setUp(manifestText(ID, { status: "pending" }));
    await read();
    files.rewrite(FILE, manifestText(ID, { status: "pending", metadata: { title: "renamed" } }), {
      mtimeMs: NOW + 5_000,
    });
    expect(await read()).toMatchObject({ state: "ok", statusWrittenAt: NOW });
    expect(files.opened()).toEqual([FILE, FILE]);
  });

  test("a manifest of exactly the limit is read, and one over it is not opened for its bytes", async () => {
    const padded = (size: number) => {
      const start = manifestText(ID, { prompt: "" });
      return manifestText(ID, { prompt: "x".repeat(size - start.length) });
    };
    const fits = await setUp(padded(MAX_MANIFEST_BYTES));
    expect(await fits.read()).toMatchObject({ state: "ok" });

    const over = await setUp(padded(MAX_MANIFEST_BYTES + 1));
    expect(await over.read()).toEqual({ state: "too-large" });
    expect(over.files.reads).toEqual([]);
    expect(over.files.openHandles()).toBe(0);
  });

  test("a manifest caught half written keeps what was read before, once", async () => {
    const { files, read } = await setUp();
    await read();

    files.rewrite(FILE, '{ "version": 1, "sess', { mtimeMs: NOW + 1_000 });
    expect(await read()).toMatchObject({ state: "ok", manifest: { status: "running" } });
    expect(await read()).toEqual({ state: "broken" });

    files.rewrite(FILE, manifestText(ID, { status: "idle" }), { mtimeMs: NOW + 2_000 });
    expect(await read()).toMatchObject({ state: "ok", manifest: { status: "idle" } });
  });

  test("a broken manifest with nothing read before is broken, and is not opened again", async () => {
    const { files, read } = await setUp("{ broken");
    expect(await read()).toEqual({ state: "broken" });
    expect(await read()).toEqual({ state: "broken" });
    expect(files.opened()).toEqual([FILE]);
  });

  test("a manifest of a newer format is said to be", async () => {
    const { read } = await setUp(manifestText(ID, { version: 9 }));
    expect(await read()).toEqual({ state: "newer" });
  });

  test("nothing at the folder's name, or a link there, is none", async () => {
    const { files, reader } = await setUp();
    const info = await files.io.lstat(FILE);
    files.remove(`${SESSIONS_DIR}/${ID}`);
    expect(await reader.read(ID, info)).toEqual({ state: "none" });
    expect(await reader.read(ID, { ...info, size: info.size + 1 })).toEqual({ state: "none" });

    files.special(`${SESSIONS_DIR}/${ID}`);
    expect(await reader.read(ID, { ...info, size: info.size + 2 })).toEqual({ state: "none" });
    expect(files.opened()).toEqual([]);
  });

  test("a link at the manifest's name is none", async () => {
    const { files, reader } = await setUp();
    const info = await files.io.lstat(FILE);
    files.special(FILE);
    expect(await reader.read(ID, { ...info, kind: "file" })).toEqual({ state: "none" });
    expect(files.reads).toEqual([]);
  });

  test("a file of a new size is opened", async () => {
    const { files, read } = await setUp();
    await read();
    files.rewrite(FILE, manifestText(ID, { status: "idle" }), { mtimeMs: NOW });
    expect(await read()).toMatchObject({ manifest: { status: "idle" } });
  });

  test("a new file of the same size and time is opened", async () => {
    const { files, read } = await setUp();
    await read();
    files.write(FILE, manifestText(ID, { status: "pending" }), { mtimeMs: NOW });
    expect(await read()).toMatchObject({ manifest: { status: "pending" } });
  });

  test("what was read before does not stand in for a newer format", async () => {
    const { files, read } = await setUp();
    await read();
    files.rewrite(FILE, manifestText(ID, { version: 2 }), { mtimeMs: NOW + 1 });
    expect(await read()).toEqual({ state: "newer" });
  });

  test("what was read before does not stand in for a file over the limit", async () => {
    const { files, read } = await setUp();
    await read();
    files.rewrite(FILE, manifestText(ID, { prompt: "x".repeat(MAX_MANIFEST_BYTES) }), {
      mtimeMs: NOW + 1,
    });
    expect(await read()).toEqual({ state: "too-large" });
  });

  test("what was read before does not stand in for a file that went", async () => {
    const { files, read, reader } = await setUp();
    await read();
    const info = await files.io.lstat(FILE);
    files.remove(FILE);
    expect(await reader.read(ID, { ...info, mtimeMs: NOW + 1 })).toEqual({ state: "none" });
  });

  test("a file that could not be opened is not tried again until it changes", async () => {
    const { files, reader } = await setUp();
    const info = await files.io.lstat(FILE);
    files.fail(FILE);
    expect(await reader.read(ID, info)).toEqual({ state: "none" });
    files.heal(FILE);
    expect(await reader.read(ID, info)).toEqual({ state: "none" });
    expect(files.opened()).toEqual([FILE]);
    expect(await reader.read(ID, { ...info, mtimeMs: NOW + 1 })).toMatchObject({ state: "ok" });
  });

  test("forgets the sessions it is told to", async () => {
    const { files, read, reader } = await setUp();
    await read();
    reader.keepOnly(new Set());
    await read();
    expect(files.opened()).toEqual([FILE, FILE]);
  });
});
