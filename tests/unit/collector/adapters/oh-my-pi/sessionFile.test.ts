import { describe, expect, test } from "vitest";

import {
  codexImport,
  createOmpSessionReader,
  LINE3_BYTES,
  SLOT_BYTES,
  slotShape,
  slotTitle,
} from "@collector/adapters/oh-my-pi/sessionFile";
import { MAX_TAIL_BYTES } from "@collector/adapters/oh-my-pi/tail";
import { INSTANT, MAX_HEAD_BYTES } from "@collector/adapters/pi/sessionFile";
import type { FileInfo, OpenFile, ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  codexLines,
  CWD,
  header,
  HOUR,
  line,
  message,
  MINUTE,
  NOW,
  PRIVATE_CODEX_TITLE,
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  PROJECT_FOLDER,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  SESSIONS,
  sessionText,
  titleSlot,
  toolStart,
} from "@tests/fixtures/oh-my-pi/ohMyPi";
import { watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/oh-my-pi/ohMyPiAdapter";
import { asWritten } from "@tests/support/paths";

const FILE = sessionPath();
/** Written an hour ago, so a read now is long after. */
const WRITTEN = NOW - HOUR;

const slotOf = (options: Parameters<typeof titleSlot>[0]) => Buffer.from(titleSlot(options));

function readerOf(files: MemoryFiles, io: ReadOnlyIo = files.io) {
  return createOmpSessionReader(SESSIONS, io, "darwin");
}

async function readAt(
  reader: ReturnType<typeof readerOf>,
  files: MemoryFiles,
  now: number = NOW,
  file: string = FILE,
) {
  return reader.read({ path: file, info: await files.io.lstat(file) }, now);
}

/** What two reads in a row of a file written long ago show. */
async function shown(text: string, file: string = FILE) {
  const files = memoryFiles();
  files.write(file, text, { mtimeMs: WRITTEN });
  const reader = readerOf(files);
  await readAt(reader, files, NOW, file);
  return readAt(reader, files, NOW + 2 * SECOND, file);
}

const titleOf = async (text: string) => {
  const read = await shown(text);
  return read.state === "ok" ? read.file.title : read.state;
};

describe("the title slot", () => {
  test("is 256 bytes, a title, who set it, a time and spaces", () => {
    for (const source of ["user", "auto", undefined] as const) {
      const slot = slotOf({ title: "Fix the flaky tests", source });
      expect(slot.byteLength).toBe(SLOT_BYTES);
      expect(slotShape(slot)).toMatchObject({ state: "ok", source: source ?? null });
    }
    // A title that fills the slot leaves no spaces.
    const full = slotOf({ title: "x".repeat(150), source: "user" });
    expect(slotShape(full)).toMatchObject({ state: "ok", source: "user" });
  });

  test("a title set by the person or a model is shown, and one with no source is not decoded", async () => {
    expect(
      await titleOf(
        sessionText(undefined, { slot: { title: "Fix the flaky tests", source: "user" } }),
      ),
    ).toBe("Fix the flaky tests");
    expect(
      await titleOf(
        sessionText(undefined, { slot: { title: "Fix the flaky tests", source: "auto" } }),
      ),
    ).toBe("Fix the flaky tests");
    expect(await titleOf(sessionText(undefined, { slot: { title: PRIVATE_TITLE } }))).toBeNull();
    expect(slotTitle(slotOf({ title: PRIVATE_TITLE }), false)).toBeNull();
  });

  test("a title that holds the bytes of a source is read as one string", () => {
    const tricky = 'a","source":"user","updatedAt":"x';
    const slot = slotOf({ title: tricky });
    expect(slotShape(slot)).toMatchObject({ state: "ok", source: null });
    expect(slotTitle(slot, false)).toBeNull();
    expect(slotTitle(slotOf({ title: tricky, source: "auto" }), false)).toBe(tricky);
  });

  test("a leading icon of a font's own is dropped, and an emoji is kept", () => {
    expect(
      slotTitle(slotOf({ title: "\u{F0668} FLAKY: Fix the tests", source: "auto" }), false),
    ).toBe("FLAKY: Fix the tests");
    expect(slotTitle(slotOf({ title: "\uE7A8\uE7A8 Fix", source: "auto" }), false)).toBe("Fix");
    expect(
      slotTitle(slotOf({ title: "\u{1F9EA} FLAKY: Fix the tests", source: "auto" }), false),
    ).toBe("\u{1F9EA} FLAKY: Fix the tests");
    // Nine of them are not an icon.
    const nine = `${"\uE7A8".repeat(9)} Fix`;
    expect(slotTitle(slotOf({ title: nine, source: "auto" }), false)).toBe(nine);
  });

  test("a slot not as Oh My Pi writes it is not read", () => {
    const good = slotOf({ title: "Fix", source: "user" });
    const unread = [
      Buffer.concat([good.subarray(0, 100), Buffer.from("\n"), good.subarray(101)]),
      Buffer.from(good.toString().replace('"updatedAt"', '"updatedXt"')),
      Buffer.from(good.toString().replace('"pad":"', '"pad":"x')),
      Buffer.from(good.toString().replace('"source":"user"', '"source":"else"')),
    ];
    for (const slot of unread) {
      expect(slotShape(slot).state).toBe("unread");
      expect(slotTitle(slot, false)).toBeUndefined();
    }
  });

  test("a title is shown only once two reads in a row agree", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(), { mtimeMs: WRITTEN });
    const reader = readerOf(files);
    expect(await readAt(reader, files)).toMatchObject({ state: "ok", file: { title: null } });
    expect(await readAt(reader, files, NOW + 2 * SECOND)).toMatchObject({
      file: { title: "Fix the flaky tests" },
    });
  });

  test("a read that caught a rewrite half done is never shown", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(undefined, { slot: { title: "Re", source: "user" } }), {
      mtimeMs: WRITTEN,
    });
    let torn: Buffer | null = null;
    const io: ReadOnlyIo = {
      ...files.io,
      async openRegular(target) {
        const file = await files.io.openRegular(target);
        return {
          ...file,
          async read(position, length) {
            if (position === 0 && torn !== null) {
              const once = torn;
              torn = null;
              return once;
            }
            return file.read(position, length);
          },
        } satisfies OpenFile;
      },
    };
    const reader = readerOf(files, io);
    const titles: (string | null)[] = [];
    const poll = async (at: number) => {
      const read = await readAt(reader, files, at);
      titles.push(read.state === "ok" ? read.file.title : null);
    };
    await poll(NOW);
    await poll(NOW + 2 * SECOND);
    // Oh My Pi rewrites "Re" as "Fix bug", and one read catches half of each, which parses.
    files.rewrite(FILE, sessionText(undefined, { slot: { title: "Fix bug", source: "user" } }), {
      mtimeMs: NOW + 3 * SECOND,
    });
    torn = slotOf({ title: "Rex bug", source: "user", updatedAt: NOW - HOUR });
    await poll(NOW + 4 * SECOND);
    await poll(NOW + 6 * SECOND);
    await poll(NOW + 8 * SECOND);
    expect(titles).toEqual([null, "Re", "Re", "Re", "Fix bug"]);
  });

  test("a rewrite that leaves the file's size and time as they were is still read, while the slot is not settled", async () => {
    const files = memoryFiles();
    const at = NOW - SECOND;
    files.write(FILE, sessionText(undefined, { slot: { title: "Old", source: "user" } }), {
      mtimeMs: at,
    });
    const reader = readerOf(files);
    await readAt(reader, files, NOW);
    expect(await readAt(reader, files, NOW + 1)).toMatchObject({ file: { title: "Old" } });
    // Within 2 seconds of the last write, at the same size, with the time as a disk rounds it.
    files.rewrite(FILE, sessionText(undefined, { slot: { title: "New", source: "user" } }), {
      mtimeMs: at,
    });
    await readAt(reader, files, NOW + 2);
    expect(await readAt(reader, files, NOW + 3)).toMatchObject({ file: { title: "New" } });
    // Settled, 2 seconds after the last write: not opened again while it holds still.
    await readAt(reader, files, at + 2 * SECOND);
    const opened = files.count("openRegular");
    await readAt(reader, files, at + 3 * SECOND);
    expect(files.count("openRegular")).toBe(opened);
  });

  test("a new file at the name is read afresh, keeping the title until its slot agrees", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(undefined, { slot: { title: "Old", source: "user" } }), {
      mtimeMs: WRITTEN,
    });
    const reader = readerOf(files);
    await readAt(reader, files, NOW);
    await readAt(reader, files, NOW + 2 * SECOND);
    files.write(FILE, sessionText(undefined, { slot: { title: "New", source: "user" } }), {
      mtimeMs: WRITTEN,
    });
    expect(await readAt(reader, files, NOW + 4 * SECOND)).toMatchObject({ file: { title: "Old" } });
    expect(await readAt(reader, files, NOW + 6 * SECOND)).toMatchObject({ file: { title: "New" } });
  });

  test("a new file at the name that holds another session shows no title from before", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(undefined, { slot: { title: "Old", source: "user" } }), {
      mtimeMs: WRITTEN,
    });
    const reader = readerOf(files);
    await readAt(reader, files, NOW);
    expect(await readAt(reader, files, NOW + 2 * SECOND)).toMatchObject({ file: { title: "Old" } });
    files.write(
      FILE,
      sessionText(undefined, {
        slot: { title: "New", source: "user" },
        header: { id: sessionIdOf(2) },
      }),
      { mtimeMs: WRITTEN },
    );
    expect(await readAt(reader, files, NOW + 4 * SECOND)).toMatchObject({
      file: { id: sessionIdOf(2), title: null },
    });
    expect(await readAt(reader, files, NOW + 6 * SECOND)).toMatchObject({ file: { title: "New" } });
  });

  test("a read again after the clock was set back reads the slot again", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(), { mtimeMs: WRITTEN });
    const reader = readerOf(files);
    await readAt(reader, files, NOW);
    await readAt(reader, files, NOW + 2 * SECOND);
    const opened = files.count("openRegular");
    await readAt(reader, files, NOW - HOUR / 2);
    expect(files.count("openRegular")).toBe(opened + 1);
  });
});

describe("a Codex session's copy", () => {
  test("is told from its third line, whichever number its first ID has", () => {
    expect(codexImport(Buffer.from(codexLines(1)))).toBe(true);
    expect(codexImport(Buffer.from(codexLines(2)))).toBe(true);
    expect(codexImport(Buffer.from(codexLines(40)))).toBe(true);
    expect(codexImport(Buffer.from(message("user")))).toBe(false);
    expect(codexImport(Buffer.from(message("user", { id: "codex1" })))).toBe(false);
    expect(codexImport(Buffer.from(message("user", { id: "codex-" })))).toBe(false);
    expect(codexImport(Buffer.from(message("user", { id: "codex-A1" })))).toBe(false);
    // Not yet written, or cut off before it can be told.
    expect(codexImport(Buffer.from(""))).toBeNull();
    expect(codexImport(Buffer.from('{"type":"message","id":"cod'))).toBeNull();
    expect(codexImport(Buffer.from(codexLines(1)).subarray(0, LINE3_BYTES))).toBe(true);
  });

  test("hides a model's title, which is the first prompt typed in Codex, and shows the person's", async () => {
    const slot = { title: PRIVATE_CODEX_TITLE, source: "auto" as const };
    expect(await titleOf(sessionText(codexLines(1), { slot }))).toBeNull();
    expect(await titleOf(sessionText(codexLines(2), { slot }))).toBeNull();
    expect(
      await titleOf(sessionText(codexLines(1), { slot: { title: "Mine", source: "user" } })),
    ).toBe("Mine");
    const seen = await watchDecodingWhile(() => shown(sessionText(codexLines(1), { slot })));
    expect(seen.join("\n")).not.toContain("PRIVATE_CODEX_TITLE");
  });

  test("a third line written after the header is looked at once it is there", async () => {
    const files = memoryFiles();
    const slot = { title: PRIVATE_CODEX_TITLE, source: "auto" as const };
    files.write(FILE, sessionText("", { slot }), { mtimeMs: WRITTEN });
    const reader = readerOf(files);
    expect(await readAt(reader, files)).toEqual({ state: "none" });
    files.append(FILE, codexLines(1), { mtimeMs: WRITTEN + SECOND });
    await readAt(reader, files, NOW + SECOND);
    expect(await readAt(reader, files, NOW + 3 * SECOND)).toMatchObject({ file: { title: null } });
    const plain = memoryFiles();
    plain.write(FILE, sessionText("", { slot: { title: "Mine", source: "auto" } }), {
      mtimeMs: WRITTEN,
    });
    const other = readerOf(plain);
    await readAt(other, plain);
    plain.append(FILE, message("user"), { mtimeMs: WRITTEN + SECOND });
    await readAt(other, plain, NOW + SECOND);
    expect(await readAt(other, plain, NOW + 3 * SECOND)).toMatchObject({ file: { title: "Mine" } });
  });

  test("an auto title read twice before its third line shows once a plain third line is added in place", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText("", { slot: { title: "Mine", source: "auto" } }), {
      mtimeMs: WRITTEN,
    });
    const reader = readerOf(files);
    expect(await readAt(reader, files, NOW)).toEqual({ state: "none" });
    expect(await readAt(reader, files, NOW + 2 * SECOND)).toEqual({ state: "none" });
    files.append(FILE, message("user"), { mtimeMs: WRITTEN + SECOND });
    // The first read after the line is added: the slot is as it was, and the Codex check now says no.
    expect(await readAt(reader, files, NOW + 4 * SECOND)).toMatchObject({
      file: { title: "Mine" },
    });
  });
});

describe("the header", () => {
  test("keeps only the ID, the folder and the time it began", async () => {
    const read = await shown(sessionText());
    expect(read).toEqual({
      state: "ok",
      file: {
        id: SESSION_ID,
        cwd: CWD,
        startedAt: NOW - HOUR,
        title: "Fix the flaky tests",
        tail: {
          state: "ok",
          newest: { sort: "reply", at: NOW - MINUTE },
          behind: null,
          cutOff: null,
        },
      },
      writtenAt: WRITTEN,
      // The file as its lines were read.
      info: {
        kind: "file",
        size: Buffer.byteLength(sessionText()),
        mtimeMs: WRITTEN,
        ino: expect.any(Number),
      },
    });
  });

  test("of a newer format says so, through Pi's reader with Oh My Pi's newest version", async () => {
    expect(await shown(sessionText(undefined, { header: { version: 4 } }))).toEqual({
      state: "newer",
    });
    expect((await shown(sessionText(undefined, { header: { version: 3 } }))).state).toBe("ok");
  });

  test("longer than 64 KiB, or not a session's, is not one this reads", async () => {
    const long =
      titleSlot({ title: "x", source: "user" }) +
      line({ type: "session", id: SESSION_ID, cwd: "x".repeat(MAX_HEAD_BYTES) }) +
      message("user");
    expect(await shown(long)).toEqual({ state: "other" });
    expect(
      await shown(
        titleSlot({ title: "x", source: "user" }) + line({ type: "message" }) + message("user"),
      ),
    ).toEqual({
      state: "other",
    });
  });

  test("a file of a session's start alone, as /new makes, is not shown until a line decides", async () => {
    expect(await shown(sessionText(""))).toEqual({ state: "none" });
    expect(await shown(titleSlot({ title: "x" }) + header().slice(0, 30))).toEqual({
      state: "none",
    });
    expect(await shown(titleSlot({ title: "x" }).slice(0, 100))).toEqual({ state: "none" });
  });
});

describe("files that are not Oh My Pi's sessions", () => {
  test("one that begins with its header, as an older Oh My Pi's or Pi's does, is left out with nothing decoded", async () => {
    const headerFirst = header() + message("user") + toolStart("ask");
    expect(await shown(headerFirst)).toEqual({ state: "other" });
    const pi =
      line({
        type: "session",
        version: 3,
        id: SESSION_ID,
        timestamp: new Date(NOW).toISOString(),
        cwd: CWD,
      }) + message("user");
    expect(await shown(pi)).toEqual({ state: "other" });
    for (const text of [headerFirst, pi]) {
      const files = memoryFiles();
      files.write(FILE, text, { mtimeMs: WRITTEN });
      const reader = readerOf(files);
      const seen = await watchDecodingWhile(async () => {
        await readAt(reader, files);
        await readAt(reader, files, NOW + 2 * SECOND);
      });
      expect(seen).toEqual([]);
      // Only its first 256 bytes are read.
      expect(files.reads).toEqual([{ path: asWritten(FILE), position: 0, length: SLOT_BYTES }]);
    }
  });
});

describe("what is turned into text", () => {
  test("only the title, the header and the times kept", async () => {
    const text = sessionText(message("user") + toolStart("ask", NOW - MINUTE));
    const headerLine = header().replace(/\n$/, "");
    const seen = await watchDecodingWhile(() => shown(text));
    for (const made of seen) {
      const allowed =
        made === headerLine ||
        made === '"Fix the flaky tests"' ||
        made === "Fix the flaky tests" ||
        INSTANT.test(made);
      expect(allowed, made).toBe(true);
    }
    // The header's own copy of the title is parsed with it and dropped: nothing else holds a private word.
    for (const word of PRIVATE_WORDS) {
      expect(seen.filter((made) => made !== headerLine).join("\n")).not.toContain(word);
    }
  });

  test("nothing of a title with no source", async () => {
    const text = sessionText(message("user"), { slot: { title: PRIVATE_TITLE } });
    const headerLine = header().replace(/\n$/, "");
    const seen = await watchDecodingWhile(() => shown(text));
    expect(seen.filter((made) => made !== headerLine)).toEqual([]);
  });
});

describe("opening a file", () => {
  test("goes by the open file's time when it is later than the lstat's", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(), { mtimeMs: WRITTEN });
    const reader = readerOf(files);
    const before = await files.io.lstat(FILE);
    files.append(FILE, message("user"), { mtimeMs: WRITTEN + MINUTE });
    const read = await reader.read({ path: FILE, info: before }, NOW);
    expect(read).toMatchObject({
      state: "ok",
      writtenAt: WRITTEN + MINUTE,
      file: { tail: { newest: { sort: "prompt" } } },
    });
  });

  test("judges whether the slot is settled by the open file's time when it is later than the lstat's", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(), { mtimeMs: WRITTEN });
    const reader = readerOf(files);
    await readAt(reader, files, NOW);
    // A write between the next lstat and the open, a second before that poll.
    const before = await files.io.lstat(FILE);
    files.append(FILE, message("user"), { mtimeMs: NOW + SECOND });
    await reader.read({ path: FILE, info: before }, NOW + 2 * SECOND);
    // Less than 2 seconds after that write: the slot is read again on the next poll.
    const opened = files.count("openRegular");
    await readAt(reader, files, NOW + 2 * SECOND + 1);
    expect(files.count("openRegular")).toBe(opened + 1);
  });

  test("never one in a project folder that is not a real folder, and takes no note of it", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(), { mtimeMs: WRITTEN });
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
    const reader = readerOf(files, io);
    const ref = { path: FILE, info: await files.io.lstat(FILE) };
    expect(await reader.read(ref, NOW)).toEqual({ state: "none" });
    expect(files.count("openRegular")).toBe(0);
    linked = false;
    expect((await reader.read(ref, NOW)).state).toBe("ok");
  });

  test("looks up no folder above a file loose in the sessions folder", async () => {
    const files = memoryFiles();
    const loose = sessionPath(SESSION_ID, SESSIONS);
    files.write(loose, sessionText(), { mtimeMs: WRITTEN });
    expect((await shown(sessionText(), loose)).state).toBe("ok");
    const reader = readerOf(files);
    await readAt(reader, files, NOW, loose);
    expect(files.count("lstat", (target) => target === SESSIONS)).toBe(0);
  });

  test("a file replaced since its lstat, or one that is not an ordinary file, is tried again next poll", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(), { mtimeMs: WRITTEN });
    const reader = readerOf(files);
    const before = await files.io.lstat(FILE);
    files.write(FILE, sessionText(), { mtimeMs: WRITTEN });
    expect(await reader.read({ path: FILE, info: before }, NOW)).toEqual({ state: "none" });
    expect(reader.kept).toBe(0);
    expect(files.openHandles()).toBe(0);
    files.special(FILE);
    expect(await readAt(reader, files)).toEqual({ state: "none" });
    expect(reader.kept).toBe(0);
  });

  test("forgets every file it is not told to keep", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(), { mtimeMs: WRITTEN });
    const reader = readerOf(files);
    await readAt(reader, files);
    expect(reader.kept).toBe(1);
    reader.keepOnly(new Set());
    expect(reader.kept).toBe(0);
  });

  test("a file cut back to its last whole line, as Oh My Pi cuts a line it could not write, is read afresh", async () => {
    const whole = sessionText(message("user") + toolStart("ask"));
    // A half-written line of 8 MiB puts the ask too far back.
    const half = '{"type":"model_usage","pad":"'.padEnd(MAX_TAIL_BYTES, "x");
    const files = memoryFiles();
    files.write(FILE, whole + half, { mtimeMs: WRITTEN });
    const reader = readerOf(files);
    expect(await readAt(reader, files)).toMatchObject({ file: { tail: { state: "too-far" } } });
    files.rewrite(FILE, whole, { mtimeMs: WRITTEN + SECOND });
    expect(await readAt(reader, files, NOW + 2 * SECOND)).toMatchObject({
      state: "ok",
      file: { tail: { state: "ok", newest: { sort: "ask" } } },
    });
  });
});
