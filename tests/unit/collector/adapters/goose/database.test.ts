import { describe, expect, test } from "vitest";

import { createDatabaseReader, RETRY_MS } from "@collector/adapters/goose/database";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/goose/sessionRows";
import {
  DATA_DIR,
  DATABASE,
  NOW,
  printedRow,
  probeJson,
  SECOND,
  SESSIONS_DIR,
} from "@tests/fixtures/goose/goose";
import {
  gooseFiles,
  memoryFiles,
  standInSqlite,
  type MemoryFiles,
  type StandInSqlite,
} from "@tests/support/adapters/goose/gooseAdapter";

const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;

function readerOf(files: MemoryFiles, sqlite: StandInSqlite, platform: NodeJS.Platform = "darwin") {
  return createDatabaseReader({
    file: DATABASE,
    io: files.io,
    platform,
    run: sqlite.run,
    find: sqlite.find,
  });
}

/** The address `sqlite3` was last given, which says how it opened the database. */
const lastAddress = (sqlite: StandInSqlite) => sqlite.runs.at(-1)?.at(-2);

describe("how the database is opened", () => {
  test("with no -wal, as a whole file nothing changes", async () => {
    const sqlite = standInSqlite([printedRow()]);
    const read = await readerOf(gooseFiles(), sqlite).read(NOW);
    expect(read.state).toBe("read");
    expect(read.rows).toHaveLength(1);
    expect(lastAddress(sqlite)).toMatch(/\?mode=ro&immutable=1$/);
  });

  test("with an empty -wal, the same: it holds nothing to read", async () => {
    const files = gooseFiles();
    files.write(WAL, "");
    files.write(SHM, "index");
    const sqlite = standInSqlite();
    await readerOf(files, sqlite).read(NOW);
    expect(lastAddress(sqlite)).toMatch(/\?mode=ro&immutable=1$/);
  });

  test("with an empty -wal and no -shm, the same, as a read Goose closed under can leave it", async () => {
    const files = gooseFiles();
    files.write(WAL, "");
    const sqlite = standInSqlite();
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("read");
    expect(lastAddress(sqlite)).toMatch(/\?mode=ro&immutable=1$/);
  });

  test("with a -wal that holds something, with it, the -shm opened read-only", async () => {
    const files = gooseFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const sqlite = standInSqlite();
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("read");
    expect(lastAddress(sqlite)).toMatch(/\?mode=ro&readonly_shm=1$/);
  });

  test("always with no settings of the person's own, as JSON, and one question", async () => {
    const sqlite = standInSqlite();
    await readerOf(gooseFiles(), sqlite).read(NOW);
    expect(sqlite.runs).toHaveLength(1);
    expect(sqlite.runs[0]?.slice(0, 4)).toEqual(["-init", "/dev/null", "-batch", "-json"]);
    expect(sqlite.runs[0]?.at(-1)).toBe(SESSIONS_QUERY);
  });
});

describe("what is not read", () => {
  test("no database, and sqlite3 is not run", async () => {
    const sqlite = standInSqlite();
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    expect(await readerOf(files, sqlite).read(NOW)).toEqual({ state: "missing", rows: [] });
    expect(sqlite.runs).toEqual([]);
  });

  test("no folder for it", async () => {
    expect((await readerOf(memoryFiles(), standInSqlite()).read(NOW)).state).toBe("missing");
  });

  test("an empty database, as SQLite would delete a -wal beside it", async () => {
    const sqlite = standInSqlite();
    const files = memoryFiles();
    files.write(DATABASE, "");
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("missing");
    expect(sqlite.runs).toEqual([]);
  });

  test("a -wal that holds something with no -shm, as reading it would make one", async () => {
    const sqlite = standInSqlite();
    const files = gooseFiles();
    files.write(WAL, "frames");
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("not-safe");
    expect(sqlite.runs).toEqual([]);
  });

  test.each([
    ["the database", DATABASE],
    ["the -wal", WAL],
    ["the -shm", SHM],
  ])("a link in place of %s", async (_case, target) => {
    const sqlite = standInSqlite();
    const files = gooseFiles();
    files.special(target);
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("not-safe");
    expect(sqlite.runs).toEqual([]);
  });

  test.each([
    ["the sessions folder", SESSIONS_DIR],
    ["Goose's data folder", DATA_DIR],
  ])("a link in place of %s", async (_case, folder) => {
    const sqlite = standInSqlite();
    const files = gooseFiles();
    files.remove(folder);
    files.special(folder);
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("not-safe");
    expect(sqlite.runs).toEqual([]);
  });

  test("a folder at the database's name", async () => {
    const files = memoryFiles();
    files.mkdir(DATABASE);
    expect((await readerOf(files, standInSqlite()).read(NOW)).state).toBe("not-safe");
  });

  test("nothing on Windows: no file is looked at and no program run", async () => {
    const sqlite = standInSqlite();
    const files = gooseFiles();
    files.forget();
    expect(await readerOf(files, sqlite, "win32").read(NOW)).toEqual({
      state: "not-on-windows",
      rows: [],
    });
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("with no sqlite3 to run, it says so", async () => {
    const sqlite = standInSqlite();
    sqlite.gone();
    expect((await readerOf(gooseFiles(), sqlite).read(NOW)).state).toBe("no-sqlite");
  });
});

describe("when a read does not work", () => {
  test("the probe says when the database is laid out as another version", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("question");
    sqlite.setProbe(probeJson(["archived_at"]));
    expect((await readerOf(gooseFiles(), sqlite).read(NOW)).state).toBe("unsupported");
    expect(sqlite.runs.map((args) => args.at(-1))).toEqual([SESSIONS_QUERY, PROBE_QUERY]);
  });

  test("a database laid out as Goose's that still cannot be read has failed", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("question");
    expect((await readerOf(gooseFiles(), sqlite).read(NOW)).state).toBe("failed");
  });

  test("a file that is no database has failed, as neither question is answered", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("both");
    expect((await readerOf(gooseFiles(), sqlite).read(NOW)).state).toBe("failed");
  });

  test("an answer that cannot be read has failed", async () => {
    const sqlite = standInSqlite();
    sqlite.set("not json");
    expect((await readerOf(gooseFiles(), sqlite).read(NOW)).state).toBe("failed");
  });

  test("a program that throws has failed, and the read after it asks again", async () => {
    const sqlite = standInSqlite();
    let throwing = true;
    const reader = createDatabaseReader({
      file: DATABASE,
      io: gooseFiles().io,
      platform: "darwin",
      find: sqlite.find,
      run: (binary, args) => {
        if (throwing) throw new Error("A stand-in that throws.");
        return sqlite.run(binary, args);
      },
    });
    expect((await reader.read(NOW)).state).toBe("failed");
    throwing = false;
    expect((await reader.read(NOW)).state).toBe("read");
  });

  test("the probe opens the database the way the question did", async () => {
    const files = gooseFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const sqlite = standInSqlite();
    sqlite.fail("question");
    await readerOf(files, sqlite).read(NOW);
    expect(sqlite.runs.map((args) => args.at(-2))).toEqual([
      expect.stringMatching(/readonly_shm=1$/),
      expect.stringMatching(/readonly_shm=1$/),
    ]);
  });

  test("no sqlite3 is looked for again 10 seconds on, with the database unchanged", async () => {
    const sqlite = standInSqlite([printedRow()]);
    let found: string | null = null;
    const reader = createDatabaseReader({
      file: DATABASE,
      io: gooseFiles().io,
      platform: "linux",
      run: sqlite.run,
      find: async () => found,
    });
    expect((await reader.read(NOW)).state).toBe("no-sqlite");
    found = "/usr/bin/sqlite3";
    expect((await reader.read(NOW + RETRY_MS - SECOND)).state).toBe("no-sqlite");
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("read");
  });

  test("it is tried again 10 seconds on, or when the database changes, and not before", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("both");
    const files = gooseFiles();
    const reader = readerOf(files, sqlite);
    await reader.read(NOW);
    const runs = sqlite.runs.length;

    expect((await reader.read(NOW + RETRY_MS - SECOND)).state).toBe("failed");
    expect(sqlite.runs).toHaveLength(runs);

    expect((await reader.read(NOW + RETRY_MS)).state).toBe("failed");
    expect(sqlite.runs.length).toBeGreaterThan(runs);

    const later = sqlite.runs.length;
    files.rewrite(DATABASE, "database, changed", { mtimeMs: NOW + 1 });
    await reader.read(NOW + RETRY_MS + SECOND);
    expect(sqlite.runs.length).toBeGreaterThan(later);
  });

  test("a clock set back counts as time enough", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("both");
    const reader = readerOf(gooseFiles(), sqlite);
    await reader.read(NOW);
    const runs = sqlite.runs.length;
    await reader.read(NOW - SECOND);
    expect(sqlite.runs.length).toBeGreaterThan(runs);
  });
});

describe("how often it is asked", () => {
  test("not again until the database or its -wal changes, however many polls come", async () => {
    const sqlite = standInSqlite([printedRow()]);
    const files = gooseFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const reader = readerOf(files, sqlite);
    const first = await reader.read(NOW);
    for (let poll = 1; poll <= 5; poll += 1) {
      expect(await reader.read(NOW + poll * 2 * SECOND)).toEqual(first);
    }
    expect(sqlite.runs).toHaveLength(1);

    files.append(WAL, "more frames", { mtimeMs: NOW + 1 });
    await reader.read(NOW + 20 * SECOND);
    expect(sqlite.runs).toHaveLength(2);

    // The -shm alone is SQLite's index, which a reader's lock can touch.
    files.append(SHM, "more", { mtimeMs: NOW + 2 });
    await reader.read(NOW + 22 * SECOND);
    expect(sqlite.runs).toHaveLength(2);
  });

  test.each([
    [
      "the -wal's time alone, as SQLite writes over a -wal it has checkpointed",
      (files: MemoryFiles) => files.rewrite(WAL, "FRAMES", { mtimeMs: NOW + 1 }),
    ],
    [
      "the -wal's size alone",
      (files: MemoryFiles) => files.rewrite(WAL, "frames and more", { mtimeMs: NOW }),
    ],
    [
      "the database's identity alone",
      (files: MemoryFiles) => files.write(DATABASE, "database", { mtimeMs: NOW }),
    ],
  ])("again for a change of %s", async (_case, change) => {
    const sqlite = standInSqlite([printedRow()]);
    const files = gooseFiles();
    files.write(WAL, "frames", { mtimeMs: NOW });
    files.write(SHM, "index");
    const reader = readerOf(files, sqlite);
    await reader.read(NOW);
    change(files);
    await reader.read(NOW + SECOND);
    expect(sqlite.runs).toHaveLength(2);
  });

  test("again when the -wal goes, as it does when SQLite moves it into the database", async () => {
    const sqlite = standInSqlite();
    const files = gooseFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const reader = readerOf(files, sqlite);
    await reader.read(NOW);
    files.remove(WAL);
    files.remove(SHM);
    await reader.read(NOW + SECOND);
    expect(sqlite.runs).toHaveLength(2);
    expect(lastAddress(sqlite)).toMatch(/immutable=1$/);
  });

  test("a database laid out as another version stands until it changes", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("question");
    sqlite.setProbe(probeJson(["archived_at"]));
    const reader = readerOf(gooseFiles(), sqlite);
    await reader.read(NOW);
    const runs = sqlite.runs.length;
    await reader.read(NOW + 60 * SECOND);
    expect(sqlite.runs).toHaveLength(runs);
  });
});
