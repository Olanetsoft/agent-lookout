import { describe, expect, test } from "vitest";

import { createLogFinder, MAX_SESSIONS, SWEEP_MS } from "@collector/adapters/fx/logFiles";
import { DAY, fxLog, logPath, NOW, SESSION_ID, V2 } from "@tests/fixtures/fx/fx";
import { memoryFiles, writeSession, type MemoryFiles } from "@tests/support/adapters/fx/fxAdapter";
import { asWritten } from "@tests/support/paths";

const notChild = (_id: string) => false;

async function found(
  files: MemoryFiles,
  finder = createLogFinder({ sessionsDir: V2, io: files.io }),
  at = NOW,
  isChild = notChild,
) {
  return finder.recent(at, await files.io.lstat(V2), isChild);
}

describe("finding fx's logs", () => {
  test("takes only the names fx gives a session's folder, and never opens anything", async () => {
    const files = memoryFiles();
    writeSession(files, SESSION_ID, fxLog().text());
    files.write(`${V2}/index.jsonl`, "{}\n");
    files.write(`${V2}/index.lock`, "");
    files.write(`${V2}/.tmp/abc/log.jsonl`, fxLog().text());
    files.write(`${V2}/.trash/def/log.jsonl`, fxLog().text());
    const { ids, refs } = await found(files);
    expect([...ids]).toEqual([SESSION_ID]);
    expect(refs.map((ref) => asWritten(ref.path))).toEqual([logPath(SESSION_ID)]);
    expect(files.opened()).toEqual([]);
    expect(files.count("readdir")).toBe(1);
    expect(
      files.calls.filter((call) => call.method === "readdir").map((call) => call.path),
    ).toEqual([V2]);
  });

  test("lists v2 again only when its modified time moves, or at the sweep", async () => {
    const files = memoryFiles();
    writeSession(files, SESSION_ID, fxLog().text());
    const finder = createLogFinder({ sessionsDir: V2, io: files.io });
    await found(files, finder);
    files.forget();
    await found(files, finder, NOW + 2_000);
    expect(files.count("readdir")).toBe(0);
    // A session's folder renamed in moves v2's time.
    writeSession(files, "Zy8xW6vU4tS2", fxLog({ id: "Zy8xW6vU4tS2" }).text());
    const { refs } = await found(files, finder, NOW + 4_000);
    expect(files.count("readdir")).toBe(1);
    expect(refs).toHaveLength(2);
    files.forget();
    await found(files, finder, NOW + SWEEP_MS);
    expect(files.count("readdir")).toBe(1);
  });

  test("looks up each session's folder and log on every poll, and follows no link at either", async () => {
    const files = memoryFiles();
    writeSession(files, SESSION_ID, fxLog().text());
    files.special(`${V2}/Zy8xW6vU4tS2`);
    files.mkdir(`${V2}/linkedLog001`);
    files.special(`${V2}/linkedLog001/log.jsonl`);
    const finder = createLogFinder({ sessionsDir: V2, io: files.io });
    const { refs } = await found(files, finder);
    expect(refs.map((ref) => ref.id)).toEqual([SESSION_ID]);
    files.forget();
    await found(files, finder, NOW + 2_000);
    expect(files.count("lstat", (target) => target === `${V2}/${SESSION_ID}`)).toBe(1);
    expect(files.count("lstat", (target) => target === logPath(SESSION_ID))).toBe(1);
  });

  test("passes over a log not written to for a day, and a known subagent's, until the sweep", async () => {
    const files = memoryFiles();
    writeSession(files, SESSION_ID, fxLog().text(), { mtimeMs: NOW - DAY - 1 });
    writeSession(files, "cH1ldS3ss10n", fxLog({ id: "cH1ldS3ss10n" }).text());
    const finder = createLogFinder({ sessionsDir: V2, io: files.io });
    const isChild = (id: string) => id === "cH1ldS3ss10n";
    expect((await found(files, finder, NOW, isChild)).refs.map((ref) => ref.id)).toEqual([
      "cH1ldS3ss10n",
    ]);
    files.forget();
    expect((await found(files, finder, NOW + 2_000, isChild)).refs).toEqual([]);
    expect(files.count("lstat", (target) => target.includes(SESSION_ID))).toBe(0);
    expect(files.count("lstat", (target) => target.includes("cH1ldS3ss10n"))).toBe(0);
    // At the sweep both are looked up again, and the subagent's is given back to be checked.
    const swept = await found(files, finder, NOW + SWEEP_MS, isChild);
    expect(swept.refs.map((ref) => ref.id)).toEqual(["cH1ldS3ss10n"]);
    expect(files.count("lstat", (target) => target === logPath(SESSION_ID))).toBe(1);
  });

  test("gives the newest 200 logs, newest first, a subagent's not counted among them", async () => {
    const files = memoryFiles();
    const ids = Array.from(
      { length: MAX_SESSIONS + 5 },
      (_, n) => `s${String(n).padStart(4, "0")}`,
    );
    for (const [n, id] of ids.entries())
      writeSession(files, id, fxLog({ id }).text(), { mtimeMs: NOW - n * 1_000 });
    writeSession(files, "child0000001", fxLog({ id: "child0000001" }).text(), { mtimeMs: NOW });
    const finder = createLogFinder({ sessionsDir: V2, io: files.io });
    const isChild = (id: string) => id === "child0000001";
    const first = await found(files, finder, NOW, isChild);
    // At the first look every log is a sweep's, so the subagent's comes too, after the 200.
    expect(first.refs.map((ref) => ref.id)).toEqual([
      ...ids.slice(0, MAX_SESSIONS),
      "child0000001",
    ]);
    // The ones past the newest 200 wait for the next sweep.
    const later = await found(files, finder, NOW + 2_000, isChild);
    expect(later.refs.map((ref) => ref.id)).toEqual(ids.slice(0, MAX_SESSIONS));
  });

  test("rejects when v2 cannot be listed", async () => {
    const files = memoryFiles();
    files.mkdir(V2);
    files.fail(V2, "EACCES");
    const finder = createLogFinder({ sessionsDir: V2, io: files.io });
    await expect(
      finder.recent(NOW, { kind: "directory", size: 0, mtimeMs: 1, ino: 1 }, notChild),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});
