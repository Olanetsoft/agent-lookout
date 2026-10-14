import { describe, expect, test } from "vitest";

import {
  MAX_RECORD_BYTES,
  oneForEachSession,
  parseRecord,
  pidOfRecordName,
  readRegistry,
  type RegistryEntry,
} from "@collector/adapters/qwen-code/registry";
import {
  NOW,
  PRIVATE_TOKEN,
  PROJECT,
  QWEN_DIR,
  recordPath,
  registryRecord,
  sessionIdOf,
} from "@tests/fixtures/qwen-code/qwenCode";
import { memoryFiles } from "@tests/support/adapters/qwenCodeAdapter";

const SESSIONS = `${QWEN_DIR}/sessions`;

const entryOf = (pid: number, n: number, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
  pid,
  sessionId: sessionIdOf(n),
  cwd: PROJECT,
  startedAt: NOW - 30 * 60_000,
  kind: "tui",
  linux: false,
  ...extra,
});

describe("oneForEachSession", () => {
  const newer = entryOf(41001, 1, { startedAt: NOW - 10 * 60_000 });
  const older = entryOf(41002, 1, { startedAt: NOW - 60 * 60_000 });

  test("of two records whose processes run, gives the newest, in either order", () => {
    for (const entries of [
      [newer, older],
      [older, newer],
    ]) {
      expect(oneForEachSession(entries, () => true)).toEqual([{ entry: newer, alive: true }]);
    }
  });

  test("a newer record whose process has gone gives way to an older one whose process runs", () => {
    for (const entries of [
      [newer, older],
      [older, newer],
    ]) {
      expect(oneForEachSession(entries, (pid) => pid === older.pid)).toEqual([
        { entry: older, alive: true },
      ]);
    }
  });

  test("when no process of them runs, gives the newest", () => {
    expect(oneForEachSession([older, newer], () => false)).toEqual([
      { entry: newer, alive: false },
    ]);
  });

  test("keeps sessions apart, and asks once for each record", () => {
    const other = entryOf(41003, 2);
    const asked: number[] = [];
    const chosen = oneForEachSession([newer, older, other], (pid) => {
      asked.push(pid);
      return true;
    });
    expect(chosen.map(({ entry }) => entry.pid)).toEqual([41001, 41003]);
    expect(asked).toEqual([41001, 41002, 41003]);
  });
});

describe("pidOfRecordName", () => {
  test.each([
    ["41001.json", 41001],
    ["41002-0a1b2c3d.json", 41002],
  ])("%s is the record of pid %i", (name, pid) => {
    expect(pidOfRecordName(name)).toBe(pid);
  });

  test.each([
    "041001.json",
    "2026-notes.json",
    "2026-planning-notes.json",
    "41001.json.0123456789ab.tmp",
    ".41001.json",
    "41001-0A1B2C3D.json",
    "41001-0a1b2c3.json",
    "41001.JSON",
    "0.json",
    "notes.json",
    "41001",
  ])("%s is no record's name", (name) => {
    expect(pidOfRecordName(name)).toBeNull();
  });
});

describe("parseRecord", () => {
  test("keeps the pid, the session, its folder, when it began and its kind, and nothing else", () => {
    const entry = parseRecord(
      registryRecord({ pid: 41001, sessionId: sessionIdOf(1), kind: "tui" }),
      41001,
      "darwin",
    );
    expect(entry).toEqual(entryOf(41001, 1));
    // The socket and its token are dropped with the parsed record.
    const kept = JSON.stringify(entry);
    expect(kept).not.toContain(PRIVATE_TOKEN);
    expect(kept).not.toContain(".sock");
    expect(kept).not.toContain("demo-project-a1");
    expect(kept).not.toContain("0.25.1");
  });

  test("a record with no kind is a terminal's, and a kind it cannot read is too, as Qwen Code reads them", () => {
    const record = (kind?: unknown) =>
      parseRecord(
        registryRecord({ pid: 41001, sessionId: sessionIdOf(1), extra: { kind } }),
        41001,
        "darwin",
      );
    expect(record(undefined)).toMatchObject({ kind: "tui" });
    expect(record("Not A Kind")).toMatchObject({ kind: "tui" });
    expect(record("headless")).toMatchObject({ kind: "headless" });
    expect(record("a-new-kind")).toMatchObject({ kind: "a-new-kind" });
  });

  test("a record of a newer format is not read", () => {
    expect(
      parseRecord(
        registryRecord({ pid: 41001, sessionId: sessionIdOf(1), schemaVersion: 2 }),
        41001,
        "darwin",
      ),
    ).toBe("newer");
  });

  test.each<[string, string]>([
    ["a pid that is not the name's", registryRecord({ pid: 41009, sessionId: sessionIdOf(1) })],
    [
      "no format",
      registryRecord({
        pid: 41001,
        sessionId: sessionIdOf(1),
        extra: { schemaVersion: undefined },
      }),
    ],
    [
      "a format before the first",
      registryRecord({ pid: 41001, sessionId: sessionIdOf(1), schemaVersion: 0 }),
    ],
    ["no session id", registryRecord({ pid: 41001, sessionId: "" })],
    [
      "a session id that could name another file",
      registryRecord({ pid: 41001, sessionId: "../../settings" }),
    ],
    [
      "a session id with a slash",
      registryRecord({ pid: 41001, sessionId: "00000000-0000-4000-8000/00000001" }),
    ],
    ["a pid that is not one", registryRecord({ pid: -1, sessionId: sessionIdOf(1) })],
    ["JSON that is not an object", "[1, 2, 3]"],
    ["text that is not JSON", '{"schemaVersion": 1, "pid": 410'],
  ])("%s is not a record", (_name, content) => {
    expect(parseRecord(content, 41001, "darwin")).toBeNull();
  });

  test("a folder that is not an absolute path, or holds a control character, is not kept", () => {
    const folderOf = (cwd: string, platform: NodeJS.Platform = "darwin") =>
      (
        parseRecord(
          registryRecord({ pid: 41001, sessionId: sessionIdOf(1), cwd }),
          41001,
          platform,
        ) as RegistryEntry
      ).cwd;
    expect(folderOf("code/demo-project")).toBeNull();
    expect(folderOf("/Users/example/code/demo\u0007project")).toBeNull();
    expect(folderOf("")).toBeNull();
    expect(folderOf("C:\\Users\\example\\code\\demo-project", "win32")).toBe(
      "C:\\Users\\example\\code\\demo-project",
    );
  });

  test("a start token or a namespace id says the record was written on Linux", () => {
    const linuxOf = (procStart: string | null, pidNs: number | null) =>
      (
        parseRecord(
          registryRecord({ pid: 41001, sessionId: sessionIdOf(1), procStart, pidNs }),
          41001,
          "darwin",
        ) as RegistryEntry
      ).linux;
    expect(linuxOf(null, null)).toBe(false);
    expect(linuxOf("00000000-0000-4000-8000-000000000000:12345", null)).toBe(true);
    expect(linuxOf(null, 4026531836)).toBe(true);
  });
});

describe("readRegistry", () => {
  test("opens only the names Qwen Code writes, and reads each record whole", async () => {
    const files = memoryFiles();
    files.write(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({ pid: 41001, sessionId: sessionIdOf(1) }),
    );
    files.write(
      recordPath(QWEN_DIR, "41002-0a1b2c3d.json"),
      registryRecord({ pid: 41002, sessionId: sessionIdOf(2) }),
    );
    for (const name of [
      "041001.json",
      "2026-notes.json",
      "41001.json.0123456789ab.tmp",
      ".41001.json",
    ]) {
      files.write(
        recordPath(QWEN_DIR, name),
        registryRecord({ pid: 41001, sessionId: sessionIdOf(9) }),
      );
    }

    const read = await readRegistry(SESSIONS, files.io, "darwin");
    expect(read.readable && read.entries.map((entry) => entry.sessionId).sort()).toEqual([
      sessionIdOf(1),
      sessionIdOf(2),
    ]);
    expect(files.opened().sort()).toEqual([
      recordPath(QWEN_DIR, "41001.json"),
      recordPath(QWEN_DIR, "41002-0a1b2c3d.json"),
    ]);
    expect(files.openHandles()).toBe(0);
  });

  test("lists only terminal sessions, and counts those of a newer format", async () => {
    const files = memoryFiles();
    files.write(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({ pid: 41001, sessionId: sessionIdOf(1), kind: "tui" }),
    );
    files.write(
      recordPath(QWEN_DIR, "41002.json"),
      registryRecord({ pid: 41002, sessionId: sessionIdOf(2), kind: "headless" }),
    );
    files.write(
      recordPath(QWEN_DIR, "41003.json"),
      registryRecord({ pid: 41003, sessionId: sessionIdOf(3), kind: "serve" }),
    );
    files.write(
      recordPath(QWEN_DIR, "41004.json"),
      registryRecord({ pid: 41004, sessionId: sessionIdOf(4), kind: "external" }),
    );
    files.write(
      recordPath(QWEN_DIR, "41005.json"),
      registryRecord({ pid: 41005, sessionId: sessionIdOf(5), schemaVersion: 2 }),
    );
    files.write(
      recordPath(QWEN_DIR, "41006.json"),
      registryRecord({ pid: 41006, sessionId: sessionIdOf(6) }),
    );

    const read = await readRegistry(SESSIONS, files.io, "darwin");
    expect(read).toMatchObject({ readable: true, newer: 1, elsewhere: 0 });
    expect(read.readable && read.entries.map((entry) => entry.pid).sort()).toEqual([41001, 41006]);
  });

  test("on a Mac or Windows, leaves out a record a Linux process wrote, as one in a container does", async () => {
    const files = memoryFiles();
    files.write(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({ pid: 41001, sessionId: sessionIdOf(1) }),
    );
    files.write(
      recordPath(QWEN_DIR, "1.json"),
      registryRecord({
        pid: 1,
        sessionId: sessionIdOf(2),
        procStart: "0000:42",
        pidNs: 4026531836,
      }),
    );
    for (const platform of ["darwin", "win32"] as const) {
      const read = await readRegistry(SESSIONS, files.io, platform);
      expect(read.readable && read.entries.map((entry) => entry.pid), platform).toEqual([41001]);
      expect(read, platform).toMatchObject({ elsewhere: 1 });
    }
    const linux = await readRegistry(SESSIONS, files.io, "linux");
    expect(linux.readable && linux.entries.map((entry) => entry.pid).sort()).toEqual([1, 41001]);
  });

  test("skips a link, a pipe and a record over 64 KiB", async () => {
    const files = memoryFiles();
    files.special(recordPath(QWEN_DIR, "41001.json"));
    files.write(
      recordPath(QWEN_DIR, "41002.json"),
      registryRecord({
        pid: 41002,
        sessionId: sessionIdOf(2),
        extra: { padding: "x".repeat(MAX_RECORD_BYTES) },
      }),
    );
    files.write(
      recordPath(QWEN_DIR, "41003.json"),
      registryRecord({ pid: 41003, sessionId: sessionIdOf(3) }),
    );
    const read = await readRegistry(SESSIONS, files.io, "darwin");
    expect(read.readable && read.entries.map((entry) => entry.pid)).toEqual([41003]);
    // The large one is opened, found too large, and not read.
    expect(files.reads.filter((range) => range.path.endsWith("41002.json"))).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("a record caught mid-write keeps the entry it held before, once", async () => {
    const files = memoryFiles();
    const file = recordPath(QWEN_DIR, "41001.json");
    files.write(file, registryRecord({ pid: 41001, sessionId: sessionIdOf(1) }));
    const first = await readRegistry(SESSIONS, files.io, "darwin");
    if (!first.readable) throw new Error("unreadable");

    files.rewrite(file, '{"schemaVersion": 1, "pid": 410');
    const second = await readRegistry(SESSIONS, files.io, "darwin", first.parsed);
    expect(second.readable && second.entries.map((entry) => entry.pid)).toEqual([41001]);
    if (!second.readable) throw new Error("unreadable");

    const third = await readRegistry(SESSIONS, files.io, "darwin", second.parsed);
    expect(third.readable && third.entries).toEqual([]);
  });

  test("two records of one session are both read, and the newest whose process runs is chosen", async () => {
    const files = memoryFiles();
    // The newer is in the name read first, so neither the first nor the last read wins by its place.
    files.write(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({ pid: 41001, sessionId: sessionIdOf(1), startedAt: NOW - 10_000 }),
    );
    files.write(
      recordPath(QWEN_DIR, "41002.json"),
      registryRecord({ pid: 41002, sessionId: sessionIdOf(1), startedAt: NOW - 60_000 }),
    );
    const read = await readRegistry(SESSIONS, files.io, "darwin");
    if (!read.readable) throw new Error("unreadable");
    expect(read.entries.map((entry) => entry.pid)).toEqual([41001, 41002]);
    expect(oneForEachSession(read.entries, () => true).map(({ entry }) => entry.pid)).toEqual([
      41001,
    ]);
  });

  test("a folder that is not there, or cannot be listed, is said apart", async () => {
    const files = memoryFiles();
    expect(await readRegistry(SESSIONS, files.io, "darwin")).toEqual({
      readable: false,
      missing: true,
    });
    files.mkdir(SESSIONS);
    files.fail(SESSIONS);
    expect(await readRegistry(SESSIONS, files.io, "darwin")).toEqual({
      readable: false,
      missing: false,
    });
  });

  test("a record that cannot be opened is skipped without a word", async () => {
    const files = memoryFiles();
    files.write(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({ pid: 41001, sessionId: sessionIdOf(1) }),
    );
    files.write(
      recordPath(QWEN_DIR, "41002.json"),
      registryRecord({ pid: 41002, sessionId: sessionIdOf(2) }),
    );
    files.fail(recordPath(QWEN_DIR, "41001.json"), "ENOENT");
    const read = await readRegistry(SESSIONS, files.io, "darwin");
    expect(read.readable && read.entries.map((entry) => entry.pid)).toEqual([41002]);
  });

  test("never names a file outside the folder", async () => {
    const files = memoryFiles();
    files.write(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({ pid: 41001, sessionId: sessionIdOf(1) }),
    );
    await readRegistry(SESSIONS, files.io, "darwin");
    for (const call of files.calls) expect(call.path.startsWith(SESSIONS), call.path).toBe(true);
  });
});
