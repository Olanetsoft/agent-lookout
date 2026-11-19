import { describe, expect, test } from "vitest";

import {
  createDroidSessionReader,
  FIRST_READ_BYTES,
  holdsSessionStart,
  isDroidProjectFolder,
  MAX_FIRST_LINE_BYTES,
  parseFirstLine,
  sessionIdOf,
} from "@collector/adapters/droid/sessionFile";
import type { FileInfo, ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  CWD,
  messageLine,
  NOW,
  OWNER,
  PRIVATE_PROMPT,
  PRIVATE_TITLE,
  PROJECT_FOLDER,
  SECOND,
  SESSION_ID,
  sessionIdOf as idOf,
  sessionPath,
  SESSIONS,
  sessionStart,
  sessionStartFields,
  sessionText,
} from "@tests/fixtures/droid/droid";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/droid/droidAdapter";
import { watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";
import { asWritten } from "@tests/support/paths";

const FILE = sessionPath();

/** A reader of the stand-in files, on a Mac's rules unless a test says otherwise. */
const readerOf = (files: MemoryFiles, platform: NodeJS.Platform = "darwin") =>
  createDroidSessionReader(SESSIONS, files.io, platform);

/** What one read of a file says, given its `lstat` now. */
async function readOnce(
  files: MemoryFiles,
  reader = readerOf(files),
  file = FILE,
  id = SESSION_ID,
) {
  return reader.read({ path: file, info: await files.io.lstat(file) }, id);
}

describe("names", () => {
  test("a project folder is any name in the sessions folder that begins with -", () => {
    for (const name of ["-", "-Users-example-code-demo-project", "-C-Users-example", "--x--"]) {
      expect(isDroidProjectFolder(name), name).toBe(true);
    }
    for (const name of [".favorites", "notes", "Users-example", ""]) {
      expect(isDroidProjectFolder(name), name).toBe(false);
    }
  });

  test("a session's ID is its file's name without .jsonl, when that is an ID Droid gives", () => {
    expect(sessionIdOf(`${SESSION_ID}.jsonl`)).toBe(SESSION_ID);
    // Factory's own examples name sessions that are not UUIDs.
    expect(sessionIdOf("session-abc123.jsonl")).toBe("session-abc123");
    expect(sessionIdOf("abc123.jsonl")).toBe("abc123");
    for (const name of [
      "my plan.jsonl",
      ".jsonl",
      `${SESSION_ID}.settings.json`,
      `${SESSION_ID}.json`,
      "-x.jsonl",
      `${"a".repeat(201)}.jsonl`,
    ]) {
      expect(sessionIdOf(name), name).toBeNull();
    }
  });
});

describe("the bytes that let a first line be parsed", () => {
  test('hold "session_start" as a key or a value, never inside a string', () => {
    const of = (text: string) => holdsSessionStart(Buffer.from(text));
    expect(of('{"type":"session_start","title":"x"}')).toBe(true);
    // Python's json.dumps puts a space after each colon, as Factory's own test writes.
    expect(of('{"type": "session_start", "title": "x"}')).toBe(true);
    // Two backslashes are one escaped backslash, and leave the quote after them unescaped.
    expect(of('\\\\"session_start"')).toBe(true);
    expect(of('\\"session_start"')).toBe(false);
    expect(of(messageLine().trimEnd())).toBe(false);
    expect(of(JSON.stringify({ type: "message", text: '"session_start"' }))).toBe(false);
    expect(of(JSON.stringify({ type: "message", text: 'x"session_start' }))).toBe(false);
    expect(of('{"type":"session_started"}')).toBe(false);
    expect(of("")).toBe(false);
  });
});

describe("a first line", () => {
  test("keeps only its folder, and never its title, owner or session ID", () => {
    const kept = parseFirstLine(sessionStart().trimEnd(), "darwin");
    expect(kept).toEqual({ cwd: CWD });
    expect(JSON.stringify(kept)).not.toContain(PRIVATE_TITLE);
    expect(JSON.stringify(kept)).not.toContain(OWNER);
  });

  test("is a session's only with type session_start and a title, as Factory's SDKs require", () => {
    const of = (changes: Record<string, unknown>) =>
      parseFirstLine(JSON.stringify(sessionStartFields(changes)), "darwin");
    expect(of({})).toEqual({ cwd: CWD });
    // Python's isinstance(title, str), with an empty one too.
    expect(of({ title: "" })).toEqual({ cwd: CWD });
    for (const title of [undefined, 5, null, ["x"], { x: 1 }]) {
      expect(of({ title }), String(title)).toBeNull();
    }
    // The TypeScript SDK takes the older sessionTitle in place of a title, when it is not blank.
    expect(of({ title: undefined, sessionTitle: PRIVATE_TITLE })).toEqual({ cwd: CWD });
    expect(of({ title: 5, sessionTitle: "x" })).toEqual({ cwd: CWD });
    expect(of({ title: undefined, sessionTitle: "  " })).toBeNull();
    expect(of({ title: undefined, sessionTitle: 5 })).toBeNull();
    for (const type of ["message", "session", "Session_start", undefined]) {
      expect(of({ type }), String(type)).toBeNull();
    }
    for (const text of ["", "[]", "null", '"session_start"', "{", "{} {}"]) {
      expect(parseFirstLine(text, "darwin"), text).toBeNull();
    }
  });

  test("names a folder only when it is a full path of a sensible length, with no control character", () => {
    const cwdOf = (cwd: unknown, platform: NodeJS.Platform = "darwin") =>
      parseFirstLine(JSON.stringify(sessionStartFields({ cwd })), platform)?.cwd;
    for (const cwd of [5, "", "code/demo", `/${"a".repeat(4096)}`, "/Users/example/\u0007x"]) {
      expect(cwdOf(cwd), String(cwd).slice(0, 20)).toBeNull();
    }
    expect(cwdOf(undefined)).toBeNull();
    expect(cwdOf("C:\\Users\\example\\code\\demo", "win32")).toBe("C:\\Users\\example\\code\\demo");
    expect(cwdOf("C:\\Users\\example\\code\\demo", "darwin")).toBeNull();
  });
});

describe("reading a session file", () => {
  test("gives the file's name as its ID and the first line's folder, and nothing else", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    const read = await readOnce(files);
    expect(read).toEqual({
      state: "ok",
      session: { id: SESSION_ID, cwd: CWD },
      writtenAt: NOW,
    });
    expect(JSON.stringify(read)).not.toContain(PRIVATE_TITLE);
    expect(JSON.stringify(read)).not.toContain(OWNER);
    expect(JSON.stringify(read)).not.toContain("ffffffff");
    expect(files.openHandles()).toBe(0);
  });

  test("turns no byte after the first line break into text, whatever follows", async () => {
    const files = memoryFiles();
    // A second line with another session's start and words where a prompt goes.
    const second = sessionStart({ cwd: "/Users/example/code/other", title: PRIVATE_PROMPT });
    files.write(FILE, sessionStart() + second + messageLine());
    const reader = readerOf(files);
    let read: unknown;
    const seen = await watchDecodingWhile(async () => {
      read = await readOnce(files, reader);
    });
    expect(read).toMatchObject({ state: "ok", session: { cwd: CWD } });
    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) {
      expect(text).not.toContain(PRIVATE_PROMPT);
      expect(text).not.toContain("code/other");
    }
  });

  test("never turns a first line that is not a session's into text", async () => {
    const files = memoryFiles();
    files.write(FILE, messageLine() + sessionStart());
    let read: unknown;
    const seen = await watchDecodingWhile(async () => {
      read = await readOnce(files);
    });
    expect(read).toEqual({ state: "other" });
    for (const text of seen) expect(text).not.toContain(PRIVATE_PROMPT);
  });

  test("reads the first 4 KiB, and past them only for a first line that runs on, up to 64 KiB", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    await readOnce(files);
    expect(files.reads).toEqual([{ path: asWritten(FILE), position: 0, length: FIRST_READ_BYTES }]);

    // A long conversation after a short first line: nothing past the first read.
    files.forget();
    files.write(FILE, sessionText({}, messageLine("a".repeat(10_000))));
    expect(await readOnce(files)).toMatchObject({ state: "ok" });
    expect(files.reads).toEqual([{ path: asWritten(FILE), position: 0, length: FIRST_READ_BYTES }]);

    files.forget();
    files.write(FILE, sessionText({ cwd: `/Users/example/${"a".repeat(5000)}` }));
    expect(await readOnce(files)).toMatchObject({ state: "ok" });
    expect(files.reads).toEqual([
      { path: asWritten(FILE), position: 0, length: FIRST_READ_BYTES },
      {
        path: asWritten(FILE),
        position: FIRST_READ_BYTES,
        length: MAX_FIRST_LINE_BYTES - FIRST_READ_BYTES,
      },
    ]);

    files.forget();
    files.write(FILE, sessionText({ padding: "a".repeat(70 * 1024) }));
    expect(await readOnce(files)).toEqual({ state: "other" });
    expect(files.reads).toHaveLength(2);
    for (const { position, length } of files.reads) {
      expect(position + length).toBeLessThanOrEqual(MAX_FIRST_LINE_BYTES);
    }
    expect(files.openHandles()).toBe(0);
  });

  test("shows nothing yet for a file still being made, and nothing for a file with only its first line", async () => {
    const cases = [
      "",
      sessionStart().trimEnd(),
      sessionStart(),
      "\n" + sessionText(),
      "  \t\r\n" + sessionText(),
      sessionStart().slice(0, 20),
    ];
    for (const text of cases) {
      const files = memoryFiles();
      files.write(FILE, text);
      expect(await readOnce(files), JSON.stringify(text.slice(0, 30))).toEqual({ state: "none" });
    }
  });

  test("shows a session once anything follows its first line", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionStart());
    const reader = readerOf(files);
    expect(await readOnce(files, reader)).toEqual({ state: "none" });
    files.append(FILE, "\n");
    expect(await readOnce(files, reader)).toMatchObject({ state: "ok" });
  });

  test("opens a file again only when its size, modified time or identity changes", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    const reader = readerOf(files);
    await readOnce(files, reader);
    await readOnce(files, reader);
    expect(files.count("openRegular")).toBe(1);

    files.append(FILE, messageLine(), { mtimeMs: NOW + SECOND });
    expect(await readOnce(files, reader)).toMatchObject({ writtenAt: NOW + SECOND });
    expect(files.count("openRegular")).toBe(2);
    // Read from its start again: only the first line is looked at.
    expect(files.reads.at(-1)).toEqual({
      path: asWritten(FILE),
      position: 0,
      length: FIRST_READ_BYTES,
    });

    files.write(FILE, sessionText({ cwd: "/Users/example/code/moved" }), { mtimeMs: NOW + SECOND });
    expect(await readOnce(files, reader)).toMatchObject({
      session: { cwd: "/Users/example/code/moved" },
    });
    expect(files.count("openRegular")).toBe(3);
  });

  test("takes the open file's modified time when it is later than its lstat's", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    const reader = readerOf(files);
    const info = await files.io.lstat(FILE);
    // Written between the lstat and the open.
    files.append(FILE, messageLine(), { mtimeMs: NOW + 3 * SECOND });
    expect(await reader.read({ path: FILE, info }, SESSION_ID)).toMatchObject({
      state: "ok",
      writtenAt: NOW + 3 * SECOND,
    });
    // Not opened again for the same lstat, whose time is then given.
    expect(await reader.read({ path: FILE, info }, SESSION_ID)).toMatchObject({ writtenAt: NOW });
    expect(files.count("openRegular")).toBe(1);
  });

  test("goes on showing a session while its file is rewritten, until it holds still for a poll", async () => {
    for (const rewritten of ["", sessionStart().slice(0, 30), sessionStart(), messageLine()]) {
      const files = memoryFiles();
      files.write(FILE, sessionText());
      const reader = readerOf(files);
      expect(await readOnce(files, reader)).toMatchObject({ state: "ok" });

      // Caught as Droid rewrites it, and again a moment later.
      files.rewrite(FILE, rewritten, { mtimeMs: NOW + SECOND });
      expect(await readOnce(files, reader), rewritten).toMatchObject({ state: "ok" });
      files.rewrite(FILE, rewritten, { mtimeMs: NOW + 2 * SECOND });
      expect(await readOnce(files, reader), rewritten).toMatchObject({ state: "ok" });

      // Unchanged since: what it holds is what it shows, as for a reader that never saw it before.
      const holds = await readOnce(files, readerOf(files));
      expect(await readOnce(files, reader), rewritten).toEqual(holds);
      expect(holds.state).not.toBe("ok");
      expect(await readOnce(files, reader)).toEqual(holds);

      // And written whole again, it shows the session.
      files.rewrite(FILE, sessionText(), { mtimeMs: NOW + 3 * SECOND });
      expect(await readOnce(files, reader)).toMatchObject({ state: "ok" });
    }
  });

  test("shows a rewritten file as it is when it shows another session", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    const reader = readerOf(files);
    await readOnce(files, reader);
    files.rewrite(FILE, sessionText({ cwd: "/Users/example/code/moved" }), {
      mtimeMs: NOW + SECOND,
    });
    expect(await readOnce(files, reader)).toMatchObject({
      session: { cwd: "/Users/example/code/moved" },
    });
  });

  test("never holds a file that showed no session", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionStart());
    const reader = readerOf(files);
    expect(await readOnce(files, reader)).toEqual({ state: "none" });
    files.rewrite(FILE, messageLine(), { mtimeMs: NOW + SECOND });
    expect(await readOnce(files, reader)).toEqual({ state: "other" });
  });

  test("a file that cannot be read shows what it showed, and is tried again on the next poll", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    const reader = readerOf(files);
    expect(await readOnce(files, reader)).toMatchObject({ state: "ok" });

    files.append(FILE, messageLine(), { mtimeMs: NOW + SECOND });
    files.failOpen(FILE);
    expect(await readOnce(files, reader)).toMatchObject({ state: "ok", writtenAt: NOW + SECOND });
    expect(await readOnce(files, reader)).toMatchObject({ state: "ok" });
    expect(files.count("openRegular")).toBe(3);
    files.heal(FILE);

    // One never read shows nothing until it can be.
    const other = sessionPath(idOf(2));
    files.write(other, sessionText());
    files.failOpen(other);
    expect(await readOnce(files, reader, other, idOf(2))).toEqual({ state: "none" });
    files.heal(other);
    expect(await readOnce(files, reader, other, idOf(2))).toMatchObject({ state: "ok" });
    expect(files.openHandles()).toBe(0);
  });

  test("a file replaced between its lstat and its open is read again on the next poll", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    const reader = readerOf(files);
    const before = await files.io.lstat(FILE);
    // A new file at the name, as through a folder made a link since.
    files.write(FILE, sessionText({ cwd: "/Users/example/elsewhere" }));
    expect(await reader.read({ path: FILE, info: before }, SESSION_ID)).toEqual({ state: "none" });
    expect(files.openHandles()).toBe(0);
    expect(await readOnce(files, reader)).toMatchObject({
      session: { cwd: "/Users/example/elsewhere" },
    });
  });

  test("never opens a file in a project folder that is not a real folder, and does not take note of it", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    let linked = true;
    const io: ReadOnlyIo = {
      ...files.io,
      async lstat(target) {
        const info = await files.io.lstat(target);
        return linked && asWritten(target) === PROJECT_FOLDER
          ? ({ ...info, kind: "other" } satisfies FileInfo)
          : info;
      },
    };
    const reader = createDroidSessionReader(SESSIONS, io, "darwin");
    const ref = { path: FILE, info: await files.io.lstat(FILE) };
    expect(await reader.read(ref, SESSION_ID)).toEqual({ state: "none" });
    expect(files.count("openRegular")).toBe(0);
    // A real folder again: the same file is read, as nothing was kept of the look.
    linked = false;
    expect(await reader.read(ref, SESSION_ID)).toMatchObject({ state: "ok" });
  });

  test("looks up no folder above a file loose in the sessions folder", async () => {
    const files = memoryFiles();
    const loose = sessionPath(SESSION_ID, SESSIONS);
    files.write(loose, sessionText());
    expect(await readOnce(files, readerOf(files), loose)).toMatchObject({ state: "ok" });
    expect(files.count("lstat", (target) => target === SESSIONS)).toBe(0);
  });

  test("forgets every file it is not told to keep", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText());
    const reader = readerOf(files);
    await readOnce(files, reader);
    reader.keepOnly(new Set());
    await readOnce(files, reader);
    expect(files.count("openRegular")).toBe(2);
    reader.keepOnly(new Set([FILE]));
    await readOnce(files, reader);
    expect(files.count("openRegular")).toBe(2);
  });

  test("takes a folder by Windows' rules on Windows", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText({ cwd: "C:\\Users\\example\\code\\demo-project" }));
    expect(await readOnce(files, readerOf(files, "win32"))).toMatchObject({
      session: { cwd: "C:\\Users\\example\\code\\demo-project" },
    });
    expect(await readOnce(files, readerOf(files, "darwin"))).toMatchObject({
      session: { cwd: null },
    });
  });
});
