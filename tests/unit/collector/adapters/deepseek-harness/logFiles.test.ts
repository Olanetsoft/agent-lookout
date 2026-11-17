import { describe, expect, test } from "vitest";

import {
  chooseLog,
  createLogFinder,
  MAX_LOGS,
  NotAFolderError,
  SWEEP_MS,
} from "@collector/adapters/deepseek-harness/logFiles";
import {
  DAY,
  headerLine,
  logPath,
  NOW,
  PROJECT_FOLDER,
  SESSION_ID,
  SESSIONS_DIR,
  sessionFolder,
  sessionIdOf,
} from "@tests/fixtures/deepseek-harness/deepseekHarness";
import {
  memoryFiles,
  writeLog,
} from "@tests/support/adapters/deepseek-harness/deepseekHarnessAdapter";
import { asWritten } from "@tests/support/paths";

const finderFor = (files: ReturnType<typeof memoryFiles>, readsCompressed = true) =>
  createLogFinder({ sessionsDir: SESSIONS_DIR, io: files.io, readsCompressed });

const paths = (found: { logs: { path: string }[] }) => found.logs.map((ref) => asWritten(ref.path));

describe("which log of a session folder is read", () => {
  test("the one of the highest format, of format 4", () => {
    expect(chooseLog(["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.lock"])).toEqual({
      kind: "log",
      name: "session.v4.jsonl.zstd",
      zstd: true,
    });
    expect(chooseLog(["session.v4.jsonl"])).toEqual({
      kind: "log",
      name: "session.v4.jsonl",
      zstd: false,
    });
  });

  test("a newer format leaves it out, naming the log of format 4 beside it", () => {
    expect(chooseLog(["session.v4.jsonl.zstd", "session.v5.jsonl.zstd"])).toEqual({
      kind: "newer",
      name: "session.v5.jsonl.zstd",
      current: "session.v4.jsonl.zstd",
    });
    expect(chooseLog(["session.v12.jsonl"])).toEqual({
      kind: "newer",
      name: "session.v12.jsonl",
      current: null,
    });
  });

  test("only older formats, session.jsonl among them, are older", () => {
    expect(chooseLog(["session.v3.jsonl.zstd", "session.jsonl.zstd"])).toEqual({
      kind: "older",
      name: "session.v3.jsonl.zstd",
    });
    expect(chooseLog(["session.jsonl"])).toEqual({ kind: "older", name: "session.jsonl" });
  });

  test("names of both kinds, or no log at all, are none", () => {
    expect(chooseLog(["session.v4.jsonl.zstd", "session.v3.jsonl"])).toEqual({ kind: "none" });
    expect(chooseLog(["session.lock", "session.v4.jsonl.zstd.0a1b2c3d4e5f.tmp"])).toEqual({
      kind: "none",
    });
    expect(
      chooseLog([
        "session.migration.0123456789abcdef.jsonl.zstd.tmp",
        "session.v04.jsonl",
        "session.v0.jsonl",
      ]),
    ).toEqual({ kind: "none" });
    expect(chooseLog(["Session.v4.jsonl", "session.v4.JSONL", "session.v4.jsonl.zst"])).toEqual({
      kind: "none",
    });
  });
});

describe("the finder", () => {
  test("finds each session's log, newest first, and looks up nothing else in its folder", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine(), { mtimeMs: NOW - 2_000 });
    writeLog(files, headerLine({ id: sessionIdOf(2) }), {
      id: sessionIdOf(2),
      mtimeMs: NOW - 1_000,
    });
    files.write(`${sessionFolder()}/session.lock`, "");
    files.write(`${sessionFolder()}/session.v4.jsonl.zstd.0a1b2c3d4e5f.tmp`, "x");
    files.write(`${sessionFolder()}/session.v3.jsonl.zstd`, "x");
    const found = await finderFor(files).find(NOW);
    expect(paths(found)).toEqual([logPath(sessionIdOf(2)), logPath()]);
    expect(found).toMatchObject({ newer: [], older: 0, compressed: 0 });
    const looked = files.calls.map((call) => asWritten(call.path));
    for (const target of looked) {
      expect(target, target).not.toMatch(/session\.lock|\.tmp$|session\.v3/);
      expect(target.startsWith(SESSIONS_DIR), target).toBe(true);
    }
    expect(files.count("openRegular")).toBe(0);
  });

  test("a file in a project folder, of the flat layout DeepSeek Harness refuses, is passed over", async () => {
    const files = memoryFiles();
    files.write(`${SESSIONS_DIR}/${PROJECT_FOLDER}/${SESSION_ID}.jsonl.zstd`, "x");
    files.write(`${SESSIONS_DIR}/${PROJECT_FOLDER}/${SESSION_ID}.jsonl`, "x");
    const found = await finderFor(files).find(NOW);
    expect(found.logs).toEqual([]);
    expect(
      files.count(undefined, (target) => target.endsWith(".jsonl") || target.endsWith(".zstd")),
    ).toBe(0);
  });

  test("a link, or anything that is not a folder, at a project or session folder's name is not gone into, nor one at a log's", async () => {
    const files = memoryFiles();
    files.special(`${SESSIONS_DIR}/--linked-project--`);
    files.special(`${SESSIONS_DIR}/${PROJECT_FOLDER}/session-linked`);
    files.special(logPath(sessionIdOf(3)));
    files.touch(sessionFolder(sessionIdOf(3)));
    const found = await finderFor(files).find(NOW);
    expect(found.logs).toEqual([]);
    expect(files.count("readdir", (target) => target.includes("linked"))).toBe(0);
  });

  test("a link put at a listed session folder's name is not gone into before the next sweep", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    expect(paths(await finder.find(NOW))).toEqual([logPath()]);
    // The log stays where the folder was, as one behind a link would be found.
    files.special(sessionFolder());
    files.touch(`${SESSIONS_DIR}/${PROJECT_FOLDER}`, NOW);
    files.forget();
    expect((await finder.find(NOW + 2_000)).logs).toEqual([]);
    const under = (target: string) => target.startsWith(`${sessionFolder()}/`);
    expect(files.count("lstat", under)).toBe(0);
    expect(files.count("openRegular", under)).toBe(0);
    // A folder there again is listed afresh, with whatever log it now holds.
    files.remove(sessionFolder());
    writeLog(files, headerLine(), { compressed: false });
    expect(paths(await finder.find(NOW + 4_000))).toEqual([
      logPath(SESSION_ID, { compressed: false }),
    ]);
  });

  test("a session folder is looked up once a poll, with its log, and not again when it was just listed", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    await finder.find(NOW);
    expect(files.count("lstat", (target) => target === sessionFolder())).toBe(1);
    files.forget();
    await finder.find(NOW + 2_000);
    expect(files.count("lstat", (target) => target === sessionFolder())).toBe(1);
    expect(files.count("lstat", (target) => target === logPath())).toBe(1);
  });

  test("a log older than a day is passed over until the next sweep, and is found again once written", async () => {
    const files = memoryFiles();
    const file = writeLog(files, headerLine(), { mtimeMs: NOW - DAY - 1 });
    const finder = finderFor(files);
    expect((await finder.find(NOW)).logs).toEqual([]);
    files.forget();
    expect((await finder.find(NOW + 2_000)).logs).toEqual([]);
    expect(files.count("lstat", (target) => target === file)).toBe(0);
    files.append(file, "x", { mtimeMs: NOW + 3_000 });
    expect((await finder.find(NOW + 4_000)).logs).toEqual([]);
    expect(paths(await finder.find(NOW + SWEEP_MS))).toEqual([file]);
  });

  test("a session folder is listed when it first appears and at each sweep, not on every poll", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    await finder.find(NOW);
    files.forget();
    await finder.find(NOW + 2_000);
    expect(files.count("readdir", (target) => target === sessionFolder())).toBe(0);
    expect(files.count("lstat", (target) => target === logPath())).toBe(1);
    files.forget();
    await finder.find(NOW + SWEEP_MS);
    expect(files.count("readdir", (target) => target === sessionFolder())).toBe(1);
  });

  test("a newer format written beside a log is found at the next sweep", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    expect((await finder.find(NOW)).logs).toHaveLength(1);
    files.write(logPath(SESSION_ID, { version: 5 }), "x");
    expect((await finder.find(NOW + 2_000)).logs).toHaveLength(1);
    const swept = await finder.find(NOW + SWEEP_MS);
    expect(swept.logs).toEqual([]);
    expect(
      swept.newer.map((one) => [asWritten(one.folder), one.current && asWritten(one.current)]),
    ).toEqual([[sessionFolder(), logPath()]]);
  });

  test("a session folder that holds no log yet is listed again on each poll, while it was changed in the last day", async () => {
    const files = memoryFiles();
    files.write(`${sessionFolder()}/session.lock`, "");
    files.touch(sessionFolder(), NOW);
    const finder = finderFor(files);
    expect((await finder.find(NOW)).logs).toEqual([]);
    writeLog(files, headerLine());
    expect(paths(await finder.find(NOW + 2_000))).toEqual([logPath()]);

    const old = memoryFiles();
    old.write(`${sessionFolder()}/session.lock`, "");
    old.touch(sessionFolder(), NOW - 2 * DAY);
    const oldFinder = finderFor(old);
    await oldFinder.find(NOW);
    old.forget();
    await oldFinder.find(NOW + 2_000);
    expect(old.count("readdir", (target) => target === sessionFolder())).toBe(0);
  });

  test("a project folder is listed again only when its time moves", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    await finder.find(NOW);
    files.forget();
    await finder.find(NOW + 2_000);
    const project = `${SESSIONS_DIR}/${PROJECT_FOLDER}`;
    expect(files.count("readdir", (target) => target === project)).toBe(0);
    writeLog(files, headerLine({ id: sessionIdOf(2) }), { id: sessionIdOf(2) });
    expect(paths(await finder.find(NOW + 4_000))).toHaveLength(2);
    expect(files.count("readdir", (target) => target === project)).toBe(1);
  });

  test(`at most the ${MAX_LOGS} newest logs are looked at, the rest until the next sweep`, async () => {
    const files = memoryFiles();
    for (let n = 0; n < MAX_LOGS + 3; n++) {
      writeLog(files, headerLine({ id: sessionIdOf(n + 10) }), {
        id: sessionIdOf(n + 10),
        mtimeMs: NOW - n,
      });
    }
    const finder = finderFor(files);
    const found = await finder.find(NOW);
    expect(found.logs).toHaveLength(MAX_LOGS);
    expect(asWritten(found.logs[0]!.path)).toBe(logPath(sessionIdOf(10)));
    files.forget();
    await finder.find(NOW + 2_000);
    expect(files.count("lstat", (target) => target === logPath(sessionIdOf(MAX_LOGS + 12)))).toBe(
      0,
    );
  });

  test("sessions of an older or newer format written in the last day are counted, and their logs never opened", async () => {
    const files = memoryFiles();
    files.write(logPath(sessionIdOf(4), { version: 3 }), "x");
    files.write(logPath(sessionIdOf(5), { version: 5 }), "x");
    files.write(logPath(sessionIdOf(6), { version: 3 }), "x", { mtimeMs: NOW - 2 * DAY });
    const found = await finderFor(files).find(NOW);
    expect(found).toMatchObject({ logs: [], older: 1 });
    expect(found.newer).toHaveLength(1);
    expect(files.count("openRegular")).toBe(0);
  });

  test("with no Zstandard, a compressed log is only counted, and an uncompressed one found", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    writeLog(files, headerLine({ id: sessionIdOf(2) }), { id: sessionIdOf(2), compressed: false });
    const found = await finderFor(files, false).find(NOW);
    expect(paths(found)).toEqual([logPath(sessionIdOf(2), { compressed: false })]);
    expect(found.compressed).toBe(1);
  });

  test("a sessions folder that is missing rejects as missing, one that is not a folder as such", async () => {
    await expect(finderFor(memoryFiles()).find(NOW)).rejects.toMatchObject({ code: "ENOENT" });
    const file = memoryFiles();
    file.write(SESSIONS_DIR, "x");
    await expect(finderFor(file).find(NOW)).rejects.toBeInstanceOf(NotAFolderError);
  });

  test("a sessions folder that cannot be listed rejects with its error", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    files.fail(SESSIONS_DIR, "EACCES");
    await expect(finder.find(NOW)).rejects.toMatchObject({ code: "EACCES" });
  });

  test("a project or session folder that cannot be listed keeps what it last held", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    expect((await finder.find(NOW)).logs).toHaveLength(1);
    files.fail(`${SESSIONS_DIR}/${PROJECT_FOLDER}`, "EIO");
    expect((await finder.find(NOW + SWEEP_MS)).logs).toHaveLength(1);
  });

  test("forgets every folder that went, and everything when told to", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    await finder.find(NOW);
    files.remove(`${SESSIONS_DIR}/${PROJECT_FOLDER}`);
    files.touch(SESSIONS_DIR, 99);
    expect((await finder.find(NOW + 2_000)).logs).toEqual([]);
    writeLog(files, headerLine());
    finder.forget();
    expect((await finder.find(NOW + 4_000)).logs).toHaveLength(1);
  });

  test("a clock set back counts as time enough for a sweep", async () => {
    const files = memoryFiles();
    writeLog(files, headerLine());
    const finder = finderFor(files);
    await finder.find(NOW);
    files.forget();
    await finder.find(NOW - 10 * 60_000);
    expect(files.count("readdir", (target) => target === sessionFolder())).toBe(1);
  });
});
