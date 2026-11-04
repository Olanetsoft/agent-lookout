import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createSessionFileReader,
  MAX_HEAD_BYTES,
  MAX_NAME_LINE_BYTES,
  MAX_TAIL_BYTES,
  nameOnLine,
  newestName,
  parseHeader,
} from "@collector/adapters/pi/sessionFile";
import type { SessionFileRef } from "@collector/adapters/pi/sessionFiles";
import {
  conversationLines,
  headerFields,
  line,
  nameLine,
  NOW,
  PRIVATE_ARGUMENTS,
  PRIVATE_SYSTEM_PROMPT,
  PRIVATE_WORDS,
  PROJECT,
  PROJECT_FOLDER,
  SECOND,
  SESSION_ID,
  sessionPath,
  sessionText,
  SESSIONS_DIR,
  STARTED_AT,
} from "@tests/fixtures/pi/pi";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/pi/piAdapter";

const FILE = sessionPath(SESSION_ID);

function readerOf(files: MemoryFiles, platform: NodeJS.Platform = "darwin") {
  const reader = createSessionFileReader(path.resolve(SESSIONS_DIR), files.io, platform);
  /** Reads the file as a poll would, from what a `lstat` of it says. */
  return async (file: string = FILE) => {
    const ref: SessionFileRef = { path: path.resolve(file), info: await files.io.lstat(file) };
    return reader.read(ref);
  };
}

const session = (ownName: string | null = null, id = SESSION_ID) => ({
  state: "ok",
  session: { id, cwd: PROJECT, startedAt: STARTED_AT, ownName },
});

describe("a header", () => {
  const parse = (changes: Record<string, unknown>, platform: NodeJS.Platform = "darwin") =>
    parseHeader(JSON.stringify(headerFields(SESSION_ID, changes)), platform);

  test("gives the id, the folder and the time, and nothing else", () => {
    expect(parse({})).toEqual({ id: SESSION_ID, cwd: PROJECT, startedAt: STARTED_AT });
  });

  test("of Pi's first format has no version, and an older one is read as it is", () => {
    expect(parse({ version: undefined })).toMatchObject({ id: SESSION_ID });
    expect(parse({ version: 1 })).toMatchObject({ id: SESSION_ID });
  });

  test("of a newer format is told apart", () => {
    expect(parse({ version: 4 })).toBe("newer");
  });

  test.each([
    ["no JSON", "not json"],
    ["a list", "[]"],
    ["another entry first", JSON.stringify({ type: "message", id: SESSION_ID })],
  ])("as %s is no header", (_case, text) => {
    expect(parseHeader(text, "darwin")).toBeNull();
  });

  test.each([
    ["a version that is not a number", { version: "3" }],
    ["no id", { id: undefined }],
    ["an id that is not text", { id: 12 }],
    ["an empty id", { id: "" }],
    ["an id that could leave a folder", { id: "../demo" }],
    ["an id that ends in punctuation", { id: "demo-" }],
    ["an id over 200 characters", { id: "a".repeat(201) }],
  ])("with %s is no header", (_case, changes) => {
    expect(parse(changes)).toBeNull();
  });

  test("a custom id, as --session-id gives, is read", () => {
    expect(parse({ id: "demo.session_1" })).toMatchObject({ id: "demo.session_1" });
  });

  test.each([
    ["a number", 12],
    ["empty", ""],
    ["relative", "code/demo"],
    ["over 4,096 characters", `/${"a".repeat(4096)}`],
    ["holding a control character", "/Users/example/\u0007demo"],
  ])("a folder that is %s is treated as none", (_case, cwd) => {
    expect(parse({ cwd })).toMatchObject({ id: SESSION_ID, cwd: null });
  });

  test("a folder is read by the system's own rules", () => {
    const folder = "C:\\Users\\example\\code\\demo";
    expect(parse({ cwd: folder }, "win32")).toMatchObject({ cwd: folder });
    expect(parse({ cwd: folder }, "darwin")).toMatchObject({ cwd: null });
  });

  test.each([
    ["a number", 1_700_000_000_000],
    ["words", "yesterday"],
    ["a date with no time", "2026-10-01"],
    ["a time that is not a day", "2026-13-41T00:00:00.000Z"],
  ])("a time that is %s is treated as none", (_case, timestamp) => {
    expect(parse({ timestamp })).toMatchObject({ id: SESSION_ID, startedAt: null });
  });
});

describe("a line that names a session", () => {
  const nameOf = (text: string) => nameOnLine(Buffer.from(text.trimEnd()));

  test("gives its name, without the spaces around it", () => {
    expect(nameOf(nameLine("  Release notes "))).toBe("Release notes");
  });

  test("that is empty clears the name", () => {
    expect(nameOf(nameLine(""))).toBeNull();
    expect(nameOf(nameLine("   "))).toBeNull();
  });

  test.each([
    ["no name at all", line({ type: "session_info", id: "a" })],
    ["a name that is not text", line({ type: "session_info", name: 12 })],
    ["broken JSON", '{"type":"session_info","name":"Rel'],
  ])("with %s gives none", (_case, text) => {
    expect(nameOf(text)).toBeNull();
  });

  test("over the most read gives none", () => {
    expect(nameOf(nameLine("x".repeat(MAX_NAME_LINE_BYTES)))).toBeNull();
  });
});

describe("the newest name in some bytes", () => {
  const newest = (text: string) => newestName(Buffer.from(text));
  const after = `${line(headerFields(SESSION_ID))}`;

  test("is undefined when no line names the session", () => {
    expect(newest(`${after}${conversationLines()}`)).toBeUndefined();
    expect(newest("")).toBeUndefined();
  });

  test("is the last whole one", () => {
    expect(newest(`${after}${nameLine("First")}${nameLine("Second")}`)).toBe("Second");
    expect(newest(`${after}${nameLine("First")}${nameLine("")}`)).toBeNull();
  });

  test("passes over one still being written", () => {
    expect(newest(`${after}${nameLine("Whole")}${nameLine("Half").slice(0, 40)}`)).toBe("Whole");
    expect(newest(`${after}${nameLine("Half").slice(0, 40)}`)).toBeUndefined();
  });

  test("never takes a line that only says the same inside a message", () => {
    const quoted = line({
      type: "message",
      message: { role: "user", content: `\n{"type":"session_info","name":"${PRIVATE_WORDS}"}\n` },
    });
    expect(newest(`${after}${quoted}`)).toBeUndefined();
  });

  test("takes a line at the very start of the bytes only with the line break before it", () => {
    expect(newest(nameLine("Cut off"))).toBeUndefined();
    expect(newest(`\n${nameLine("Whole")}`)).toBe("Whole");
  });
});

describe("reading a session file", () => {
  test("keeps its id, folder, time and name, and none of what was said", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID, nameLine("Release notes") + conversationLines()));
    const read = await readerOf(files)();

    expect(read).toEqual(session("Release notes"));
    const kept = JSON.stringify(read);
    for (const word of [PRIVATE_WORDS, PRIVATE_ARGUMENTS, PRIVATE_SYSTEM_PROMPT]) {
      expect(kept).not.toContain(word);
    }
    for (const field of ["usage", "demo-model", "parentSession", "earlier-session"]) {
      expect(kept).not.toContain(field);
    }
    expect(files.openHandles()).toBe(0);
  });

  test("with no name line has no name", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    expect(await readerOf(files)()).toEqual(session());
  });

  test("of a newer format is told apart, and of no format is broken", async () => {
    const files = memoryFiles();
    files.write(FILE, line(headerFields(SESSION_ID, { version: 9 })));
    expect((await readerOf(files)()).state).toBe("newer");
    files.write(FILE, "not json\n");
    expect((await readerOf(files)()).state).toBe("broken");
  });

  test("that is empty, or half a header, is broken", async () => {
    const files = memoryFiles();
    files.write(FILE, "");
    expect((await readerOf(files)()).state).toBe("broken");
    files.write(FILE, line(headerFields(SESSION_ID)).slice(0, 40));
    expect((await readerOf(files)()).state).toBe("broken");
  });

  test("whose first line is longer than the most read of it is broken, and only that is read", async () => {
    const files = memoryFiles();
    files.write(FILE, `${"x".repeat(MAX_HEAD_BYTES * 2)}\n`);
    expect((await readerOf(files)()).state).toBe("broken");
    expect(files.reads).toEqual([
      { path: expect.any(String), position: 0, length: MAX_HEAD_BYTES },
    ]);
  });

  test("is opened again only when it changes", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const read = readerOf(files);
    await read();
    await read();
    await read();
    expect(files.count("openRegular")).toBe(1);
    files.append(FILE, nameLine("Later"), { mtimeMs: NOW + SECOND });
    expect(await read()).toEqual(session("Later"));
    expect(files.count("openRegular")).toBe(2);
  });

  test("once read, only what Pi added is read", async () => {
    const files = memoryFiles();
    const start = sessionText(SESSION_ID);
    files.write(FILE, start);
    const read = readerOf(files);
    await read();
    files.forget();

    files.append(FILE, conversationLines(), { mtimeMs: NOW + SECOND });
    await read();
    const [reading, ...rest] = files.reads;
    expect(rest).toEqual([]);
    expect(reading.position).toBe(Buffer.byteLength(start) - 1);
    expect(reading.length).toBe(Buffer.byteLength(conversationLines()) + 1);
  });

  test("a name stays once the lines after it have moved on", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID, nameLine("Kept")));
    const read = readerOf(files);
    await read();
    const long = conversationLines().repeat(2_000);
    expect(Buffer.byteLength(long)).toBeGreaterThan(MAX_TAIL_BYTES);
    files.append(FILE, long, { mtimeMs: NOW + SECOND });
    expect(await read()).toEqual(session("Kept"));
    files.append(FILE, conversationLines(), { mtimeMs: NOW + 2 * SECOND });
    expect(await read()).toEqual(session("Kept"));
  });

  test("a name added and then cleared is gone", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID, nameLine("First")));
    const read = readerOf(files);
    await read();
    files.append(FILE, nameLine(""), { mtimeMs: NOW + SECOND });
    expect(await read()).toEqual(session(null));
  });

  test("a name still being written is read once it is whole", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const read = readerOf(files);
    await read();
    const name = nameLine("Whole at last");
    files.append(FILE, name.slice(0, 40), { mtimeMs: NOW + SECOND });
    expect(await read()).toEqual(session());
    files.append(FILE, name.slice(40), { mtimeMs: NOW + 2 * SECOND });
    expect(await read()).toEqual(session("Whole at last"));
  });

  test("a name half written at the first read is read once it is whole", async () => {
    const files = memoryFiles();
    const name = nameLine("Whole at last");
    files.write(FILE, sessionText(SESSION_ID, "") + name.slice(0, 40));
    const read = readerOf(files);
    expect(await read()).toEqual(session());
    files.append(FILE, name.slice(40), { mtimeMs: NOW + SECOND });
    expect(await read()).toEqual(session("Whole at last"));
  });

  test("a name across the end of the first 64 KiB is found", async () => {
    const files = memoryFiles();
    const start = sessionText(SESSION_ID, "");
    const padding = line({
      type: "custom",
      data: "x".repeat(MAX_HEAD_BYTES - Buffer.byteLength(start) - 70),
    });
    files.write(FILE, `${start}${padding}${nameLine("Across the edge")}`);
    expect(await readerOf(files)()).toEqual(session("Across the edge"));
  });

  test("of a large file reads a bounded part of each end, and finds the names there", async () => {
    const files = memoryFiles();
    const middle = conversationLines().repeat(4_000);
    const text = `${sessionText(SESSION_ID, nameLine("From the start"))}${middle}`;
    files.write(FILE, text);
    expect(await readerOf(files)()).toEqual(session("From the start"));
    const read = files.reads.reduce((total, one) => total + one.length, 0);
    expect(read).toBeLessThanOrEqual(MAX_HEAD_BYTES + MAX_TAIL_BYTES + 1);
    expect(Buffer.byteLength(text)).toBeGreaterThan(read * 2);

    const ended = memoryFiles();
    ended.write(FILE, `${text}${nameLine("From the end")}`);
    expect(await readerOf(ended)()).toEqual(session("From the end"));
  });

  test("a name between the two ends of a large file is not found the first time", async () => {
    const files = memoryFiles();
    const middle = conversationLines().repeat(4_000);
    files.write(FILE, `${sessionText(SESSION_ID, middle)}${nameLine("Lost")}${middle}`);
    expect(await readerOf(files)()).toEqual(session());
  });

  test("a rename between the two ends of a large file reads as the name before it", async () => {
    const files = memoryFiles();
    const middle = conversationLines().repeat(4_000);
    const start = sessionText(SESSION_ID, nameLine("Early"));
    files.write(FILE, `${start}${middle}${nameLine("Renamed")}${middle}`);
    expect(await readerOf(files)()).toEqual(session("Early"));
  });

  test("a file replaced under its name is read from the start", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID, nameLine("First")));
    const read = readerOf(files);
    await read();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW + SECOND });
    expect(await read()).toEqual(session());
  });

  test("a file rewritten shorter is read from the start", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID, conversationLines() + nameLine("First")));
    const read = readerOf(files);
    await read();
    files.rewrite(FILE, line(headerFields(SESSION_ID)), { mtimeMs: NOW + SECOND });
    expect(await read()).toEqual(session());
  });

  test("a link at the file's name is not opened", async () => {
    const files = memoryFiles();
    files.special(FILE);
    expect((await readerOf(files)()).state).toBe("none");
  });

  test("a link at the project folder's name is not opened through", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const reader = createSessionFileReader(path.resolve(SESSIONS_DIR), files.io, "darwin");
    const info = await files.io.lstat(FILE);
    files.remove(PROJECT_FOLDER);
    files.special(PROJECT_FOLDER);
    expect((await reader.read({ path: path.resolve(FILE), info })).state).toBe("none");
    expect(files.opened()).toEqual([]);
  });

  test("a file directly in the sessions folder needs no project folder", async () => {
    const files = memoryFiles();
    const flat = sessionPath(SESSION_ID, SESSIONS_DIR);
    files.write(flat, sessionText(SESSION_ID));
    expect(await readerOf(files)(flat)).toEqual(session());
    expect(files.count("lstat", (target) => target === SESSIONS_DIR)).toBe(0);
  });

  test("a read that fails keeps what was read, and is tried again on the next poll", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID, nameLine("Kept")));
    const read = readerOf(files);
    await read();

    files.append(FILE, nameLine("Newer"), { mtimeMs: NOW + SECOND });
    files.failOpen(FILE);
    expect(await read()).toEqual(session("Kept"));
    expect(await read()).toEqual(session("Kept"));
    files.heal(FILE);
    expect(await read()).toEqual(session("Newer"));
    expect(files.openHandles()).toBe(0);
  });

  test("a first read that fails is nothing, and is tried again on the next poll", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    files.failOpen(FILE);
    const read = readerOf(files);
    expect((await read()).state).toBe("none");
    files.heal(FILE);
    expect(await read()).toEqual(session());
  });

  test("forgets a file it is told to, and reads it whole again", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const reader = createSessionFileReader(path.resolve(SESSIONS_DIR), files.io, "darwin");
    const ref = { path: path.resolve(FILE), info: await files.io.lstat(FILE) };
    await reader.read(ref);
    reader.keepOnly(new Set());
    await reader.read(ref);
    expect(files.count("openRegular")).toBe(2);
  });

  test("a change of size alone is a change", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const read = readerOf(files);
    await read();
    files.append(FILE, nameLine("Later"), { mtimeMs: NOW });
    expect(await read()).toEqual(session("Later"));
  });

  test("a change of time alone is a change", async () => {
    const text = sessionText(SESSION_ID);
    const files = memoryFiles();
    files.write(FILE, text);
    const read = readerOf(files);
    await read();
    files.rewrite(FILE, text, { mtimeMs: NOW + SECOND });
    await read();
    expect(files.count("openRegular")).toBe(2);
  });

  test("a change of identity alone is a change", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID, nameLine("AAAA")));
    const read = readerOf(files);
    await read();
    files.write(FILE, sessionText(SESSION_ID, nameLine("BBBB")));
    expect(await read()).toEqual(session("BBBB"));
  });
});
