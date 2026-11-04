import { describe, expect, test } from "vitest";

import { TRUSTED_SCHEMA_OFF } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader, RETRY_MS } from "@collector/adapters/crush/database";
import { databaseOf } from "@collector/adapters/crush/projects";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/crush/sessionRows";
import { readTimeUntil } from "@collector/adapters/hermes-agent/sqlite";
import {
  DATA_FOLDER,
  DATABASE,
  DAY,
  HOME,
  NOW,
  printedRow,
  probeJson,
  PROJECT,
  SECOND,
} from "@tests/fixtures/crush/crush";
import {
  crushFiles,
  databaseIn,
  memoryFiles,
  standInSqlite,
  type MemoryFiles,
  type StandInSqlite,
} from "@tests/support/adapters/crush/crushAdapter";

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
    const read = await readerOf(crushFiles(), sqlite).read(NOW);
    expect(read.state).toBe("read");
    expect(read.rows).toHaveLength(1);
    expect(lastAddress(sqlite)).toMatch(/\?mode=ro&immutable=1$/);
  });

  test("with an empty -wal, the same: it holds nothing to read", async () => {
    const files = crushFiles();
    files.write(WAL, "");
    files.write(SHM, "index");
    const sqlite = standInSqlite();
    await readerOf(files, sqlite).read(NOW);
    expect(lastAddress(sqlite)).toMatch(/\?mode=ro&immutable=1$/);
  });

  test("with a -wal that holds something, with it, the -shm opened read-only", async () => {
    const files = crushFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const sqlite = standInSqlite();
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("read");
    expect(lastAddress(sqlite)).toMatch(/\?mode=ro&readonly_shm=1$/);
  });

  test("with the fixed arguments, no settings of the person's own, and nothing from a file in the question", async () => {
    const sqlite = standInSqlite();
    await readerOf(crushFiles(), sqlite).read(NOW);
    expect(sqlite.runs[0]).toEqual([
      "-init",
      "/dev/null",
      "-batch",
      "-json",
      "-cmd",
      "PRAGMA trusted_schema=OFF",
      `file:${DATABASE}?mode=ro&immutable=1`,
      SESSIONS_QUERY,
    ]);
  });

  test("with a database's schema not trusted on every run, a -wal's and the probe's too", async () => {
    const files = crushFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const sqlite = standInSqlite();
    sqlite.fail("both");
    await readerOf(files, sqlite).read(NOW);
    expect(sqlite.runs.map((args) => args.at(-1))).toEqual([SESSIONS_QUERY, PROBE_QUERY]);
    for (const args of sqlite.runs) {
      expect(args.slice(-4, -2)).toEqual(["-cmd", TRUSTED_SCHEMA_OFF]);
    }
  });

  test("a path that holds what would be an address's own marks cannot add to the address", async () => {
    const folder = `${HOME}/code/a?mode=rw&b#c%20d`;
    const file = databaseOf(folder);
    const files = memoryFiles();
    files.write(file, "database");
    const sqlite = standInSqlite();
    const reader = createDatabaseReader({
      file,
      io: files.io,
      platform: "darwin",
      run: sqlite.run,
      find: sqlite.find,
    });
    await reader.read(NOW);
    expect(lastAddress(sqlite)).toBe(
      `file:${HOME}/code/a%3Fmode%3Drw%26b%23c%2520d/.crush/crush.db?mode=ro&immutable=1`,
    );
    expect(databaseIn(sqlite.runs[0] ?? [])).toBe(file);
  });
});

describe("what is not read", () => {
  test("a project that has gone is nothing to read, and costs one look", async () => {
    const files = memoryFiles();
    const sqlite = standInSqlite();
    expect(await readerOf(files, sqlite).read(NOW)).toEqual({ state: "missing", rows: [] });
    expect(files.calls).toEqual([{ method: "lstat", path: PROJECT }]);
    expect(sqlite.runs).toEqual([]);
  });

  test("a project with no .crush, or no database, is nothing to read", async () => {
    const files = memoryFiles();
    files.mkdir(PROJECT);
    expect((await readerOf(files, standInSqlite()).read(NOW)).state).toBe("missing");
    files.mkdir(DATA_FOLDER);
    expect((await readerOf(files, standInSqlite()).read(NOW)).state).toBe("missing");
  });

  test("an empty database is nothing to read: SQLite would delete a -wal beside it", async () => {
    const files = memoryFiles();
    files.write(DATABASE, "");
    files.write(WAL, "frames");
    const sqlite = standInSqlite();
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("missing");
    expect(sqlite.runs).toEqual([]);
  });

  test.each([
    ["the project's folder", PROJECT],
    ["its .crush", DATA_FOLDER],
    ["the database", DATABASE],
    ["the -wal", WAL],
    ["the -shm", SHM],
  ])("%s that cannot be looked at is not taken for gone", async (_name, target) => {
    const files = crushFiles();
    files.fail(target);
    const sqlite = standInSqlite([printedRow()]);
    expect(await readerOf(files, sqlite).read(NOW)).toEqual({ state: "not-looked-at", rows: [] });
    expect(sqlite.runs).toEqual([]);
  });

  test("a failing disk is not taken for gone either, as any error but a missing path is not", async () => {
    const files = crushFiles();
    files.fail(DATA_FOLDER, "EIO");
    expect((await readerOf(files, standInSqlite()).read(NOW)).state).toBe("not-looked-at");
  });

  test("a file where a folder of its path should be is a project that has gone", async () => {
    const files = crushFiles();
    files.fail(DATA_FOLDER, "ENOTDIR");
    expect((await readerOf(files, standInSqlite()).read(NOW)).state).toBe("missing");
  });

  test("once it can be looked at again it is read", async () => {
    const files = crushFiles();
    files.fail(DATA_FOLDER);
    const reader = readerOf(files, standInSqlite([printedRow()]));
    await reader.read(NOW);
    files.heal(DATA_FOLDER);
    expect((await reader.read(NOW)).rows).toHaveLength(1);
  });

  test("a project gone since the last read drops its rows", async () => {
    const files = crushFiles();
    const reader = readerOf(files, standInSqlite([printedRow()]));
    expect((await reader.read(NOW)).rows).toHaveLength(1);
    files.remove(PROJECT);
    expect(await reader.read(NOW)).toEqual({ state: "missing", rows: [] });
  });

  test.each([
    ["the project's folder", (files: MemoryFiles) => files.special(PROJECT)],
    ["its .crush", (files: MemoryFiles) => files.special(DATA_FOLDER)],
    ["the database", (files: MemoryFiles) => files.special(DATABASE)],
    [
      "the -wal",
      (files: MemoryFiles) => {
        files.write(DATABASE, "database");
        files.special(WAL);
      },
    ],
    [
      "the -shm",
      (files: MemoryFiles) => {
        files.write(DATABASE, "database");
        files.special(SHM);
      },
    ],
  ])("a link at %s is not followed", async (_name, arrange) => {
    const files = memoryFiles();
    arrange(files);
    const sqlite = standInSqlite();
    expect(await readerOf(files, sqlite).read(NOW)).toEqual({ state: "not-safe", rows: [] });
    expect(sqlite.runs).toEqual([]);
  });

  test("a -wal that holds something with no -shm: reading it would make one", async () => {
    const files = crushFiles();
    files.write(WAL, "frames");
    const sqlite = standInSqlite();
    expect((await readerOf(files, sqlite).read(NOW)).state).toBe("not-safe");
    expect(sqlite.runs).toEqual([]);
  });

  test("nothing on Windows, with no look at any file", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite();
    files.forget();
    expect((await readerOf(files, sqlite, "win32").read(NOW)).state).toBe("not-on-windows");
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("a database nothing wrote for 48 hours: no sqlite3 is started", async () => {
    const files = memoryFiles();
    files.write(DATABASE, "database", { mtimeMs: NOW - 2 * DAY });
    const sqlite = standInSqlite([printedRow()]);
    expect(await readerOf(files, sqlite).read(NOW)).toEqual({ state: "read", rows: [] });
    expect(sqlite.runs).toEqual([]);
  });

  test("a -wal written since keeps it read, though the database is old", async () => {
    const files = memoryFiles();
    files.write(DATABASE, "database", { mtimeMs: NOW - 3 * DAY });
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const sqlite = standInSqlite([printedRow()]);
    expect((await readerOf(files, sqlite).read(NOW)).rows).toHaveLength(1);
  });

  test("a clock set back behind the database reads it", async () => {
    const files = memoryFiles();
    files.write(DATABASE, "database", { mtimeMs: NOW + DAY });
    const sqlite = standInSqlite([printedRow()]);
    expect((await readerOf(files, sqlite).read(NOW)).rows).toHaveLength(1);
  });
});

describe("when it is read", () => {
  test("once, and again only when the database changes", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite([printedRow()]);
    const reader = readerOf(files, sqlite);
    await reader.read(NOW);
    expect((await reader.read(NOW + SECOND)).rows).toHaveLength(1);
    expect(sqlite.runs).toHaveLength(1);

    files.write(DATABASE, "changed");
    await reader.read(NOW + 2 * SECOND);
    expect(sqlite.runs).toHaveLength(2);
  });

  test("again when the -wal comes, changes or goes", async () => {
    const files = crushFiles();
    files.write(SHM, "index");
    const sqlite = standInSqlite();
    const reader = readerOf(files, sqlite);
    await reader.read(NOW);
    files.write(WAL, "frames");
    await reader.read(NOW);
    files.append(WAL, "more");
    await reader.read(NOW);
    files.remove(WAL);
    await reader.read(NOW);
    expect(sqlite.runs).toHaveLength(4);
  });

  test("again when the -wal is written over at its own size, as SQLite does after a checkpoint", async () => {
    const files = crushFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const sqlite = standInSqlite();
    const reader = readerOf(files, sqlite);
    await reader.read(NOW);
    files.rewrite(WAL, "FRAMES", { mtimeMs: NOW + SECOND });
    await reader.read(NOW + SECOND);
    expect(sqlite.runs).toHaveLength(2);
  });

  test("again when a new file of the same size and time is put in its place", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite();
    const reader = readerOf(files, sqlite);
    await reader.read(NOW);
    files.write(DATABASE, "database");
    await reader.read(NOW);
    expect(sqlite.runs).toHaveLength(2);
  });

  test("a read that did not work is tried again on a change, or 10 seconds on", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite();
    sqlite.fail("both");
    const reader = readerOf(files, sqlite);
    expect((await reader.read(NOW)).state).toBe("failed");
    const runs = sqlite.runs.length;
    expect((await reader.read(NOW + RETRY_MS - 1)).state).toBe("failed");
    expect(sqlite.runs).toHaveLength(runs);

    sqlite.fail("no");
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("read");
  });

  test("a clock set back tries a failed read again", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("both");
    const reader = readerOf(crushFiles(), sqlite);
    await reader.read(NOW);
    const runs = sqlite.runs.length;
    await reader.read(NOW - 1);
    expect(sqlite.runs.length).toBeGreaterThan(runs);
  });
});

describe("what a failed read says", () => {
  test("no sqlite3 was found", async () => {
    const sqlite = standInSqlite();
    sqlite.gone();
    expect(await readerOf(crushFiles(), sqlite).read(NOW)).toEqual({
      state: "no-sqlite",
      rows: [],
    });
  });

  test("an answer that is no answer failed, and the probe is not asked", async () => {
    const sqlite = standInSqlite();
    sqlite.set("not json");
    expect((await readerOf(crushFiles(), sqlite).read(NOW)).state).toBe("failed");
    expect(sqlite.runs).toHaveLength(1);
  });

  test("a broken database, which answers neither question, failed", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("both");
    expect((await readerOf(crushFiles(), sqlite).read(NOW)).state).toBe("failed");
    expect(sqlite.runs.map((args) => args.at(-1))).toEqual([SESSIONS_QUERY, PROBE_QUERY]);
  });

  test("a database laid out as Crush's that still does not answer failed", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("question");
    expect((await readerOf(crushFiles(), sqlite).read(NOW)).state).toBe("failed");
  });

  test("a database laid out another way is unsupported, and stands until it changes", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite();
    sqlite.fail("question");
    sqlite.setProbe(probeJson(["message_count"]));
    const reader = readerOf(files, sqlite);
    expect((await reader.read(NOW)).state).toBe("unsupported");
    const runs = sqlite.runs.length;
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("unsupported");
    expect(sqlite.runs).toHaveLength(runs);
  });

  test("something that throws failed, and the next read starts over", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite([printedRow()]);
    const reader = createDatabaseReader({
      file: DATABASE,
      io: files.io,
      platform: "darwin",
      run: sqlite.run,
      find: async () => {
        throw new Error("No sqlite3.");
      },
    });
    expect(await reader.read(NOW)).toEqual({ state: "failed", rows: [] });
  });
});

describe("the poll's time for reading", () => {
  test("no run starts once it is used, and the last read stands", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite([printedRow()]);
    const reader = readerOf(files, sqlite);
    const spent = readTimeUntil(NOW, () => NOW);
    expect(await reader.read(NOW, spent)).toEqual({ state: "out-of-time", rows: [] });
    expect(sqlite.runs).toEqual([]);
    expect((await reader.read(NOW)).state).toBe("read");
  });

  test("a read cut short leaves the next read to ask again", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite([printedRow()]);
    const reader = readerOf(files, sqlite);
    expect((await reader.read(NOW)).rows).toHaveLength(1);
    files.write(DATABASE, "changed");
    const spent = readTimeUntil(NOW, () => NOW);
    expect((await reader.read(NOW, spent)).state).toBe("out-of-time");
    await reader.read(NOW);
    expect(sqlite.runs).toHaveLength(2);
  });

  test("a question that took all of it failed, rather than being cut short on every poll", async () => {
    let at = NOW;
    const sqlite = standInSqlite();
    sqlite.fail("both");
    sqlite.beforeEach(() => {
      at += 5 * SECOND;
    });
    const time = readTimeUntil(NOW + 5 * SECOND, () => at);
    expect((await readerOf(crushFiles(), sqlite).read(NOW, time)).state).toBe("failed");
    expect(sqlite.runs).toHaveLength(1);
  });

  test("a question that started late and failed is cut short, and asked first on the next poll", async () => {
    let at = NOW;
    const sqlite = standInSqlite();
    sqlite.fail("both");
    sqlite.beforeEach(() => {
      at += SECOND;
    });
    const time = readTimeUntil(NOW + SECOND, () => at);
    time.started = true;
    expect((await readerOf(crushFiles(), sqlite).read(NOW, time)).state).toBe("out-of-time");
  });

  test("a late question whose probe the time cuts short is asked again on the next poll", async () => {
    let at = NOW;
    const sqlite = standInSqlite();
    sqlite.fail("both");
    sqlite.beforeEach(() => {
      at += 2 * SECOND;
    });
    const time = readTimeUntil(NOW + 3 * SECOND, () => at);
    time.started = true;
    const reader = readerOf(crushFiles(), sqlite);
    expect((await reader.read(NOW, time)).state).toBe("out-of-time");
    expect(sqlite.runs).toHaveLength(2);

    await reader.read(NOW);
    expect(sqlite.runs.length).toBeGreaterThan(2);
  });

  test("the first run gets its whole 5 seconds, and a later one what is left", async () => {
    let at = NOW;
    const sqlite = standInSqlite();
    sqlite.fail("both");
    sqlite.beforeEach(() => {
      at += 3 * SECOND;
    });
    const time = readTimeUntil(NOW + 5 * SECOND, () => at);
    await readerOf(crushFiles(), sqlite).read(NOW, time);
    expect(sqlite.timeouts).toEqual([5 * SECOND, 2 * SECOND]);
  });
});
