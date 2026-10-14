import { describe, expect, test } from "vitest";

import { createDatabaseReader, RETRY_MS } from "@collector/adapters/opencode/database";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/opencode/sessionRows";
import {
  answerRow,
  DATABASE,
  NOW,
  probeJson,
  SECOND,
  sessionId,
} from "@tests/fixtures/opencode/opencode";
import {
  memoryFiles,
  standInSqlite,
  type MemoryFiles,
  type StandInSqlite,
} from "@tests/support/adapters/opencodeAdapter";

const A = sessionId("a1");
const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;

function readerFor(
  files: MemoryFiles,
  sqlite: StandInSqlite,
  platform: NodeJS.Platform = "darwin",
) {
  return createDatabaseReader({
    file: DATABASE,
    io: files.io,
    platform,
    run: sqlite.run,
    find: sqlite.find,
  });
}

/** A database with one session in it, and the -wal and -shm a running OpenCode keeps beside it. */
function openDatabase() {
  const files = memoryFiles();
  files.write(DATABASE, "database");
  files.write(WAL, "frames");
  files.write(SHM, "index");
  const sqlite = standInSqlite([answerRow({ id: A })]);
  return { files, sqlite, reader: readerFor(files, sqlite) };
}

/** The address each run of sqlite3 opened, in order. */
const addresses = (sqlite: StandInSqlite) => sqlite.runs.map((run) => run.args.at(-2));

describe("which way the database is opened", () => {
  test("with no -wal beside it, as a file nothing changes, and OpenCode does not have it open", async () => {
    const files = memoryFiles();
    files.write(DATABASE, "database");
    const sqlite = standInSqlite([answerRow({ id: A })]);
    const read = await readerFor(files, sqlite).read(NOW);
    expect(read).toMatchObject({ state: "read", open: false, opencode2: false });
    expect(read.rows.map((row) => row.id)).toEqual([A]);
    expect(addresses(sqlite)).toEqual([
      `file:${DATABASE}?mode=ro&immutable=1`,
      `file:${DATABASE}?mode=ro&immutable=1`,
    ]);
    expect(sqlite.runs.map((run) => run.args.slice(0, 4))).toEqual([
      ["-init", "/dev/null", "-batch", "-json"],
      ["-init", "/dev/null", "-batch", "-json"],
    ]);
    expect(sqlite.runs.map((run) => run.args.at(-1))).toEqual([PROBE_QUERY, SESSIONS_QUERY]);
  });

  test("with its -wal and -shm, with the -shm read-only, and OpenCode has it open", async () => {
    const { sqlite, reader } = openDatabase();
    expect(await reader.read(NOW)).toMatchObject({ state: "read", open: true });
    expect(addresses(sqlite)).toEqual([
      `file:${DATABASE}?mode=ro&readonly_shm=1`,
      `file:${DATABASE}?mode=ro&readonly_shm=1`,
    ]);
  });

  test("an empty -wal, which the SQLite of macOS leaves when the last program closes it, is closed, and read as a file nothing changes", async () => {
    const { files, sqlite, reader } = openDatabase();
    files.write(WAL, "");
    expect(await reader.read(NOW)).toMatchObject({ state: "read", open: false });
    // An empty -wal holds nothing to read, so neither it nor the -shm is opened.
    expect(addresses(sqlite)).toEqual([
      `file:${DATABASE}?mode=ro&immutable=1`,
      `file:${DATABASE}?mode=ro&immutable=1`,
    ]);
  });

  test("an empty -wal without its -shm, as a read that met OpenCode's quit can leave, is closed and read", async () => {
    const { files, sqlite, reader } = openDatabase();
    files.write(WAL, "");
    files.remove(SHM);
    const read = await reader.read(NOW);
    expect(read).toMatchObject({ state: "read", open: false });
    expect(read.rows.map((row) => row.id)).toEqual([A]);
    expect(addresses(sqlite).at(-1)).toBe(`file:${DATABASE}?mode=ro&immutable=1`);
  });

  test("a -wal that holds something, without its -shm, is not read, since reading it would make one", async () => {
    const { files, sqlite, reader } = openDatabase();
    files.remove(SHM);
    expect(await reader.read(NOW)).toMatchObject({ state: "not-safe", open: true, rows: [] });
    expect(sqlite.runs).toEqual([]);
  });

  test("a -wal or -shm that is a link, a pipe or a device is not read", async () => {
    for (const odd of [WAL, SHM]) {
      const { files, sqlite, reader } = openDatabase();
      files.special(odd);
      expect((await reader.read(NOW)).state, odd).toBe("not-safe");
      expect(sqlite.runs, odd).toEqual([]);
    }
    // A -shm alone, with no -wal, is not opened at all.
    const files = memoryFiles();
    files.write(DATABASE, "database");
    files.special(SHM);
    const sqlite = standInSqlite();
    expect((await readerFor(files, sqlite).read(NOW)).state).toBe("not-safe");
  });

  test("an empty database is taken as none, since SQLite would delete the -wal beside it, and nothing is run", async () => {
    const { files, sqlite, reader } = openDatabase();
    files.write(DATABASE, "");
    expect(await reader.read(NOW)).toEqual({
      state: "missing",
      open: false,
      rows: [],
      opencode2: false,
    });
    expect(sqlite.runs).toEqual([]);
    expect(files.calls.map((call) => call.path)).toEqual([DATABASE]);
  });

  test("a database that is not there, or is not an ordinary file, is missing, and nothing is run", async () => {
    const files = memoryFiles();
    const sqlite = standInSqlite();
    const reader = readerFor(files, sqlite);
    expect(await reader.read(NOW)).toEqual({
      state: "missing",
      open: false,
      rows: [],
      opencode2: false,
    });
    files.special(DATABASE);
    expect((await reader.read(NOW)).state).toBe("missing");
    expect(sqlite.runs).toEqual([]);
    // Nothing beside it is looked at either.
    expect(files.calls.map((call) => call.path)).toEqual([DATABASE, DATABASE]);
  });

  test("nothing is looked at or run on Windows", async () => {
    const { files, sqlite } = openDatabase();
    files.forget();
    const read = await readerFor(files, sqlite, "win32").read(NOW);
    expect(read).toEqual({ state: "not-on-windows", open: false, rows: [], opencode2: false });
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("only the database, its -wal and its -shm are looked at, and none is opened", async () => {
    const { files, reader } = openDatabase();
    await reader.read(NOW);
    expect(files.calls).toEqual([
      { method: "lstat", path: DATABASE },
      { method: "lstat", path: WAL },
      { method: "lstat", path: SHM },
    ]);
  });
});

describe("when the sessions are asked for again", () => {
  test("not while nothing changed, however long", async () => {
    const { sqlite, reader } = openDatabase();
    await reader.read(NOW);
    for (const later of [2 * SECOND, RETRY_MS, 10 * RETRY_MS]) {
      expect((await reader.read(NOW + later)).rows.map((row) => row.id)).toEqual([A]);
    }
    expect(sqlite.queries()).toHaveLength(1);
  });

  test("once the database or its -wal changes in size, modified time or identity", async () => {
    const changes: [string, (files: MemoryFiles) => void][] = [
      ["the -wal grew", (files) => files.append(WAL, "more")],
      ["the -wal was written again", (files) => files.rewrite(WAL, "frames", { mtimeMs: NOW + 1 })],
      [
        "the database was written",
        (files) => files.rewrite(DATABASE, "database", { mtimeMs: NOW + 1 }),
      ],
      ["the database grew", (files) => files.append(DATABASE, "more")],
      ["the database is a new file", (files) => files.write(DATABASE, "database")],
      ["the -wal went", (files) => (files.remove(WAL), files.remove(SHM))],
      ["the -shm went", (files) => files.remove(SHM)],
    ];
    for (const [what, change] of changes) {
      const { files, sqlite, reader } = openDatabase();
      await reader.read(NOW);
      change(files);
      await reader.read(NOW + 2 * SECOND);
      const wanted = what === "the -shm went" ? 1 : 2;
      expect(sqlite.queries(), what).toHaveLength(wanted);
    }
  });

  test("not when only a -shm comes or goes beside a database with no -wal, which is read without it", async () => {
    const files = memoryFiles();
    files.write(DATABASE, "database");
    const sqlite = standInSqlite([answerRow({ id: A })]);
    const reader = readerFor(files, sqlite);
    await reader.read(NOW);
    files.write(SHM, "index");
    await reader.read(NOW + 2 * SECOND);
    files.remove(SHM);
    await reader.read(NOW + 4 * SECOND);
    expect(sqlite.queries()).toHaveLength(1);
  });

  test("once the -wal comes, and the newest rows are read with it", async () => {
    const files = memoryFiles();
    files.write(DATABASE, "database");
    const sqlite = standInSqlite([answerRow({ id: A })]);
    const reader = readerFor(files, sqlite);
    expect((await reader.read(NOW)).open).toBe(false);
    files.write(WAL, "frames");
    files.write(SHM, "index");
    sqlite.set([answerRow({ id: A, m_completed: null })]);
    const read = await reader.read(NOW + 2 * SECOND);
    expect(read.open).toBe(true);
    expect(read.rows[0]?.message?.completedAt).toBeNull();
    expect(sqlite.queries().map((run) => run.args.at(-2))).toEqual([
      `file:${DATABASE}?mode=ro&immutable=1`,
      `file:${DATABASE}?mode=ro&readonly_shm=1`,
    ]);
  });

  test("after a read that failed, on the next change, or 10 seconds later", async () => {
    const { files, sqlite, reader } = openDatabase();
    sqlite.fail();
    expect(await reader.read(NOW)).toMatchObject({ state: "failed", rows: [] });
    expect(sqlite.runs).toHaveLength(1);
    sqlite.fail(false);
    expect((await reader.read(NOW + RETRY_MS - 1)).state).toBe("failed");
    expect(sqlite.runs).toHaveLength(1);
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("read");
    // The probe is asked again first.
    expect(sqlite.runs.map((run) => run.args.at(-1))).toEqual([
      PROBE_QUERY,
      PROBE_QUERY,
      SESSIONS_QUERY,
    ]);

    sqlite.fail();
    files.append(WAL, "more");
    expect((await reader.read(NOW + RETRY_MS + 1)).state).toBe("failed");
    sqlite.fail(false);
    files.append(WAL, "more");
    expect((await reader.read(NOW + RETRY_MS + 2)).state).toBe("read");
  });

  test("after a read that failed, a clock set back counts as time enough", async () => {
    const { sqlite, reader } = openDatabase();
    sqlite.fail();
    await reader.read(NOW);
    sqlite.fail(false);
    expect((await reader.read(NOW - 5 * SECOND)).state).toBe("read");
  });

  test("an answer that is not rows is a failed read", async () => {
    const { sqlite, reader } = openDatabase();
    sqlite.set("not json");
    expect((await reader.read(NOW)).state).toBe("failed");
  });

  test("with no sqlite3 to be found, nothing is run, and it is looked for again 10 seconds on", async () => {
    const { sqlite, reader } = openDatabase();
    sqlite.there(false);
    expect(await reader.read(NOW)).toMatchObject({ state: "no-sqlite", rows: [] });
    sqlite.there(true);
    expect((await reader.read(NOW + 2 * SECOND)).state).toBe("no-sqlite");
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("read");
    expect(sqlite.runs).toHaveLength(2);
  });
});

describe("the probe", () => {
  test("is asked before each query of the sessions, so a table OpenCode adds to the same file is seen", async () => {
    const { files, sqlite, reader } = openDatabase();
    expect((await reader.read(NOW)).opencode2).toBe(false);
    // OpenCode 2 adds its table to the database, which stays the same file.
    sqlite.probe(probeJson("v1+v2"));
    files.append(WAL, "more");
    expect(await reader.read(NOW + 2 * SECOND)).toMatchObject({ state: "read", opencode2: true });
    // Nothing changed, so nothing is asked.
    await reader.read(NOW + 4 * SECOND);
    expect(sqlite.runs.map((run) => run.args.at(-1))).toEqual([
      PROBE_QUERY,
      SESSIONS_QUERY,
      PROBE_QUERY,
      SESSIONS_QUERY,
    ]);
  });

  test("finding OpenCode 2's table beside 1.x's reads 1.x's sessions and says so", async () => {
    const { sqlite, reader } = openDatabase();
    sqlite.probe(probeJson("v1+v2"));
    const read = await reader.read(NOW);
    expect(read).toMatchObject({ state: "read", opencode2: true });
    expect(read.rows).toHaveLength(1);
  });

  test("finding only OpenCode 2's table reads no sessions, and asks nothing more", async () => {
    const { sqlite, reader } = openDatabase();
    sqlite.probe(probeJson("v2-only"));
    expect(await reader.read(NOW)).toEqual({
      state: "read",
      open: true,
      rows: [],
      opencode2: true,
    });
    expect(sqlite.queries()).toEqual([]);
  });

  test("tables laid out another way are not asked about, until the database changes", async () => {
    const { files, sqlite, reader } = openDatabase();
    sqlite.probe(probeJson("none"));
    expect(await reader.read(NOW)).toMatchObject({ state: "unsupported", rows: [] });
    expect((await reader.read(NOW + 10 * RETRY_MS)).state).toBe("unsupported");
    expect(sqlite.runs).toHaveLength(1);
    sqlite.probe(probeJson("v1"));
    files.append(WAL, "migrated");
    expect((await reader.read(NOW + 11 * RETRY_MS)).state).toBe("read");
    expect(sqlite.queries()).toHaveLength(1);
  });

  test("an answer that is not the probe's is a failed read, and the sessions are not asked for", async () => {
    const { sqlite, reader } = openDatabase();
    sqlite.probe("[not json");
    expect((await reader.read(NOW)).state).toBe("failed");
    expect(sqlite.queries()).toEqual([]);
  });
});

test("a reader that throws inside answers a failed read, and reads afresh after", async () => {
  const { files, sqlite, reader } = openDatabase();
  sqlite.throw();
  expect(await reader.read(NOW)).toEqual({
    state: "failed",
    open: false,
    rows: [],
    opencode2: false,
  });
  sqlite.throw(false);
  files.append(WAL, "more");
  expect((await reader.read(NOW + SECOND)).state).toBe("read");
});
