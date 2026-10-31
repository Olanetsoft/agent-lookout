import { describe, expect, test } from "vitest";

import { SQLITE_TIMEOUT_MS } from "@collector/adapters/antigravity/app/summaries";
import {
  createDatabaseReader,
  HEADER_LENGTH,
  headerMode,
  RETRY_MS,
  SQLITE_MAGIC,
} from "@collector/adapters/hermes-agent/database";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/hermes-agent/sessionRows";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  answerRow,
  databaseHeader,
  DEFAULT_DATABASE,
  NOW,
  probeJson,
  SECOND,
  sessionId,
} from "@tests/fixtures/hermes-agent/hermesAgent";
import {
  handClock,
  memoryFiles,
  readTime,
  standInSqlite,
  writeLiveWalDatabase,
  writeRollbackDatabase,
  type MemoryFiles,
  type StandInSqlite,
} from "@tests/support/adapters/hermesAgentAdapter";

const A = sessionId("a1");
const DATABASE = DEFAULT_DATABASE;
const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;
const KEG = "/opt/homebrew/opt/sqlite/bin/sqlite3";

function readerFor(
  files: MemoryFiles,
  sqlite: StandInSqlite,
  options: { platform?: NodeJS.Platform; io?: ReadOnlyIo } = {},
) {
  return createDatabaseReader({
    file: DATABASE,
    io: options.io ?? files.io,
    platform: options.platform ?? "darwin",
    finder: sqlite.finder(),
    run: sqlite.run,
  });
}

/** A database in this mode, with one session in it, and the stand-in sqlite3 that answers for it. */
function databaseIn(mode: "rollback" | "live-wal") {
  const files = memoryFiles();
  if (mode === "rollback") writeRollbackDatabase(files, DATABASE);
  else writeLiveWalDatabase(files, DATABASE);
  const sqlite = standInSqlite({ [DATABASE]: [answerRow({ id: A })] });
  return { files, sqlite, reader: readerFor(files, sqlite) };
}

/** The address each run of sqlite3 opened, in order. */
const addresses = (sqlite: StandInSqlite) =>
  sqlite.runs.map((run) => run.args.find((arg) => arg.startsWith("file:")));

/** The header reads the reader made itself, as path, start and length. */
const headerReads = (files: MemoryFiles) =>
  files.reads.map((read) => [read.path, read.position, read.length]);

describe("headerMode, as Hermes Agent reads bytes 18 and 19", () => {
  test("1 and 1 is rollback-journal mode, 2 and 2 is WAL mode, and anything else is neither", () => {
    expect(SQLITE_MAGIC).toBe("SQLite format 3\u0000");
    expect(HEADER_LENGTH).toBe(20);
    expect(headerMode(databaseHeader("rollback"))).toBe("rollback");
    expect(headerMode(databaseHeader("wal"))).toBe("wal");
    for (const bytes of [
      [1, 2],
      [2, 1],
      [0, 0],
      [3, 3],
    ] as [number, number][]) {
      expect(headerMode(databaseHeader(bytes)), String(bytes)).toBe("unknown");
    }
  });

  test("a file that is not a SQLite database, or shorter than the header, is neither", () => {
    const notSqlite = databaseHeader("wal");
    notSqlite[0] = "s".charCodeAt(0);
    expect(headerMode(notSqlite)).toBe("unknown");
    const noNul = databaseHeader("wal");
    noNul[15] = 0x20;
    expect(headerMode(noNul)).toBe("unknown");
    expect(headerMode(databaseHeader("wal").slice(0, 19))).toBe("unknown");
    expect(headerMode(new Uint8Array())).toBe("unknown");
  });
});

describe("which way the database is opened", () => {
  test("in rollback-journal mode: read-only with a second's wait for a commit, by any sqlite3", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    // A sqlite3 with the WAL-reset bug is still taken: the bug is in WAL mode alone.
    sqlite.install("/usr/bin/sqlite3", "3.45.1");
    const read = await reader.read(NOW);
    expect(read).toMatchObject({ state: "read" });
    expect(read.rows.map((row) => row.id)).toEqual([A]);
    expect(
      sqlite.runs.map((run) => [run.binary, ...run.args.slice(0, 6), run.args.at(-1)]),
    ).toEqual([
      [
        "/usr/bin/sqlite3",
        "-init",
        "/dev/null",
        "-batch",
        "-json",
        "-cmd",
        ".timeout 1000",
        PROBE_QUERY,
      ],
      [
        "/usr/bin/sqlite3",
        "-init",
        "/dev/null",
        "-batch",
        "-json",
        "-cmd",
        ".timeout 1000",
        SESSIONS_QUERY,
      ],
    ]);
    expect(addresses(sqlite)).toEqual([
      `file:${DATABASE}?mode=ro&readonly_shm=1`,
      `file:${DATABASE}?mode=ro&readonly_shm=1`,
    ]);
    // Its version was never asked.
    expect(sqlite.versionRuns).toEqual([]);
  });

  test("in rollback-journal mode, a -shm alone beside it is passed over", async () => {
    const { files, sqlite, reader } = databaseIn("rollback");
    files.write(SHM, "index");
    expect((await reader.read(NOW)).state).toBe("read");
    expect(sqlite.runs[0]?.args).toContain(".timeout 1000");
  });

  test("in WAL mode with no -wal, or an empty one with or without its -shm, as a file nothing changes, by any sqlite3", async () => {
    for (const sidecars of ["none", "empty -wal", "empty -wal and -shm"] as const) {
      const files = memoryFiles();
      files.write(DATABASE, databaseHeader("wal"));
      if (sidecars !== "none") files.write(WAL, "");
      if (sidecars === "empty -wal and -shm") files.write(SHM, "index");
      const sqlite = standInSqlite({ [DATABASE]: [answerRow({ id: A })] });
      sqlite.install("/usr/bin/sqlite3", "3.45.1");
      const read = await readerFor(files, sqlite).read(NOW);
      expect(read.state, sidecars).toBe("read");
      expect(addresses(sqlite), sidecars).toEqual([
        `file:${DATABASE}?mode=ro&immutable=1`,
        `file:${DATABASE}?mode=ro&immutable=1`,
      ]);
      expect(
        sqlite.runs.every((run) => !run.args.includes("-cmd")),
        sidecars,
      ).toBe(true);
      expect(sqlite.versionRuns, sidecars).toEqual([]);
    }
  });

  test("in WAL mode with a -wal that holds commits and its -shm: read with the -wal, the -shm read-only, by the first sqlite3 that passes Hermes Agent's test", async () => {
    const { sqlite, reader } = databaseIn("live-wal");
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    const read = await reader.read(NOW);
    expect(read).toMatchObject({ state: "read" });
    expect(sqlite.runs.map((run) => run.binary)).toEqual([KEG, KEG]);
    expect(addresses(sqlite)).toEqual([
      `file:${DATABASE}?mode=ro&readonly_shm=1`,
      `file:${DATABASE}?mode=ro&readonly_shm=1`,
    ]);
    expect(sqlite.runs.every((run) => !run.args.includes("-cmd"))).toBe(true);
  });

  test("in WAL mode with a -wal that holds commits, when no sqlite3 found passes the test, it is not read, and the first found is named", async () => {
    const { sqlite, reader } = databaseIn("live-wal");
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install("/usr/local/bin/sqlite3", "3.45.1");
    expect(await reader.read(NOW)).toEqual({
      state: "vulnerable-sqlite",
      rows: [],
      vulnerable: { path: "/usr/bin/sqlite3", version: [3, 51, 0] },
    });
    expect(sqlite.runs).toEqual([]);
  });

  test("a -wal that holds commits, without its -shm, is not read, since reading it would make one", async () => {
    const { files, sqlite, reader } = databaseIn("live-wal");
    files.remove(SHM);
    expect(await reader.read(NOW)).toEqual({ state: "not-safe", rows: [] });
    expect(sqlite.runs).toEqual([]);
  });

  test("a -wal or -shm that is a link, a pipe or a device is not read, in either mode, and the header is not opened", async () => {
    for (const mode of ["rollback", "live-wal"] as const) {
      for (const odd of [WAL, SHM]) {
        const { files, sqlite, reader } = databaseIn(mode);
        files.special(odd);
        expect((await reader.read(NOW)).state, `${mode} ${odd}`).toBe("not-safe");
        expect(sqlite.runs, `${mode} ${odd}`).toEqual([]);
        expect(files.opened(), `${mode} ${odd}`).toEqual([]);
      }
    }
  });

  test("a -wal beside a database whose header says rollback-journal mode is not read, empty or not", async () => {
    for (const wal of ["", "frames"]) {
      const { files, sqlite, reader } = databaseIn("rollback");
      files.write(WAL, wal);
      files.write(SHM, "index");
      expect(await reader.read(NOW), JSON.stringify(wal)).toEqual({ state: "failed", rows: [] });
      expect(sqlite.runs).toEqual([]);
    }
  });

  test("a header that is neither mode, or a file that is not a SQLite database, is not read", async () => {
    const odd = databaseHeader("wal");
    odd[0] = 0;
    for (const bytes of [databaseHeader([1, 2]), odd, new TextEncoder().encode("not a database")]) {
      const files = memoryFiles();
      files.write(DATABASE, bytes);
      const sqlite = standInSqlite();
      expect((await readerFor(files, sqlite).read(NOW)).state).toBe("failed");
      expect(sqlite.runs).toEqual([]);
    }
  });

  test("of the files, the database, its -wal and its -shm are looked at, and the database's first 20 bytes alone are read", async () => {
    const { files, reader } = databaseIn("live-wal");
    await reader.read(NOW);
    expect(files.calls).toEqual([
      { method: "lstat", path: DATABASE },
      { method: "lstat", path: WAL },
      { method: "lstat", path: SHM },
      { method: "openRegular", path: DATABASE },
    ]);
    expect(headerReads(files)).toEqual([[DATABASE, 0, 20]]);
    expect(files.openHandles()).toBe(0);
  });

  test("an empty database is taken as none, since SQLite would delete the -wal beside it, and nothing is opened or run", async () => {
    const { files, sqlite, reader } = databaseIn("live-wal");
    files.write(DATABASE, "");
    expect(await reader.read(NOW)).toEqual({ state: "missing", rows: [] });
    expect(sqlite.runs).toEqual([]);
    expect(files.calls).toEqual([{ method: "lstat", path: DATABASE }]);
  });

  test("a database that is not there, or is not an ordinary file, is missing, and nothing beside it is looked at", async () => {
    const files = memoryFiles();
    const sqlite = standInSqlite();
    const reader = readerFor(files, sqlite);
    expect(await reader.read(NOW)).toEqual({ state: "missing", rows: [] });
    files.special(DATABASE);
    expect((await reader.read(NOW)).state).toBe("missing");
    files.remove(DATABASE);
    files.mkdir(DATABASE);
    expect((await reader.read(NOW)).state).toBe("missing");
    expect(sqlite.runs).toEqual([]);
    expect(files.calls.map((call) => call.path)).toEqual([DATABASE, DATABASE, DATABASE]);
  });

  test("nothing is looked at or run on Windows", async () => {
    const { files, sqlite } = databaseIn("rollback");
    files.forget();
    const reader = readerFor(files, sqlite, { platform: "win32" });
    expect(await reader.read(NOW)).toEqual({ state: "not-on-windows", rows: [] });
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
    expect(sqlite.versionRuns).toEqual([]);
  });
});

describe("the header", () => {
  test("is read again only when state.db changed, not when the -wal did", async () => {
    const { files, sqlite, reader } = databaseIn("live-wal");
    await reader.read(NOW);
    files.append(WAL, "more");
    await reader.read(NOW + 2 * SECOND);
    files.append(WAL, "more");
    await reader.read(NOW + 4 * SECOND);
    expect(headerReads(files)).toEqual([[DATABASE, 0, 20]]);
    expect(sqlite.queries()).toHaveLength(3);

    // A checkpoint writes the -wal's pages into the database.
    files.rewrite(DATABASE, databaseHeader("wal"), { mtimeMs: NOW + 5 * SECOND });
    await reader.read(NOW + 6 * SECOND);
    expect(headerReads(files)).toHaveLength(2);
  });

  test("a switch of journal mode is seen once the database changes", async () => {
    const { files, sqlite, reader } = databaseIn("rollback");
    await reader.read(NOW);
    expect(addresses(sqlite).at(-1)).toBe(`file:${DATABASE}?mode=ro&readonly_shm=1`);
    // Hermes Agent switches it to WAL mode and closes it: the header says so, and no -wal is left.
    files.rewrite(DATABASE, databaseHeader("wal"), { mtimeMs: NOW + SECOND });
    expect((await reader.read(NOW + 2 * SECOND)).state).toBe("read");
    expect(addresses(sqlite).at(-1)).toBe(`file:${DATABASE}?mode=ro&immutable=1`);
  });

  test("a database replaced between the look and the open is a failed read, and the new one is read on the next poll", async () => {
    const files = memoryFiles();
    writeRollbackDatabase(files, DATABASE);
    const sqlite = standInSqlite({ [DATABASE]: [answerRow({ id: A })] });
    let replace = true;
    const io: ReadOnlyIo = {
      ...files.io,
      async openRegular(target) {
        // Another file takes its name after lstat looked at it.
        if (replace) writeRollbackDatabase(files, DATABASE);
        replace = false;
        return files.io.openRegular(target);
      },
    };
    const reader = readerFor(files, sqlite, { io });
    expect(await reader.read(NOW)).toEqual({ state: "failed", rows: [] });
    expect(files.reads).toEqual([]);
    expect(files.openHandles()).toBe(0);
    expect(sqlite.runs).toEqual([]);
    // The new file is another identity, so it is read at once, not 10 seconds on.
    expect((await reader.read(NOW + 2 * SECOND)).state).toBe("read");
  });

  test("a header that cannot be opened is a failed read, tried again 10 seconds on", async () => {
    const { files, sqlite, reader } = databaseIn("rollback");
    let opens = 0;
    const io: ReadOnlyIo = {
      ...files.io,
      openRegular: () => {
        opens += 1;
        return Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      },
    };
    const refused = readerFor(files, sqlite, { io });
    expect((await refused.read(NOW)).state).toBe("failed");
    expect((await refused.read(NOW + RETRY_MS - 1)).state).toBe("failed");
    expect(opens).toBe(1);
    expect((await refused.read(NOW + RETRY_MS)).state).toBe("failed");
    expect(opens).toBe(2);
    expect(sqlite.runs).toEqual([]);
    // The ordinary reader reads it.
    expect((await reader.read(NOW)).state).toBe("read");
  });
});

describe("when the sessions are asked for again", () => {
  test("not while nothing changed, however long", async () => {
    const { sqlite, reader } = databaseIn("live-wal");
    await reader.read(NOW);
    for (const later of [2 * SECOND, RETRY_MS, 10 * RETRY_MS]) {
      expect((await reader.read(NOW + later)).rows.map((row) => row.id)).toEqual([A]);
    }
    expect(sqlite.queries()).toHaveLength(1);
    expect(sqlite.versionRuns).toHaveLength(1);
  });

  test("once the database or its -wal changes in size, modified time or identity, or the -wal comes or goes", async () => {
    const changes: [string, (files: MemoryFiles) => void, number][] = [
      ["the -wal grew", (files) => files.append(WAL, "more"), 2],
      [
        "the -wal was written again",
        (files) => files.rewrite(WAL, "frames", { mtimeMs: NOW + 1 }),
        2,
      ],
      ["the -wal is a new file", (files) => files.write(WAL, "frames"), 2],
      [
        "the database was written",
        (files) => files.rewrite(DATABASE, databaseHeader("wal"), { mtimeMs: NOW + 1 }),
        2,
      ],
      ["the database is a new file", (files) => files.write(DATABASE, databaseHeader("wal")), 2],
      ["the -wal went", (files) => (files.remove(WAL), files.remove(SHM)), 2],
      ["the -shm went", (files) => files.remove(SHM), 1],
    ];
    for (const [what, change, wanted] of changes) {
      const { files, sqlite, reader } = databaseIn("live-wal");
      await reader.read(NOW);
      change(files);
      await reader.read(NOW + 2 * SECOND);
      expect(sqlite.queries(), what).toHaveLength(wanted);
    }
  });

  test("after a read that failed, on the next change, or 10 seconds later", async () => {
    const { files, sqlite, reader } = databaseIn("live-wal");
    sqlite.fail(DATABASE);
    expect(await reader.read(NOW)).toEqual({ state: "failed", rows: [] });
    expect(sqlite.runs).toHaveLength(1);
    sqlite.fail(DATABASE, false);
    expect((await reader.read(NOW + RETRY_MS - 1)).state).toBe("failed");
    expect(sqlite.runs).toHaveLength(1);
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("read");
    // The probe is asked again first, the same way.
    expect(sqlite.runs.map((run) => run.args.at(-1))).toEqual([
      PROBE_QUERY,
      PROBE_QUERY,
      SESSIONS_QUERY,
    ]);

    sqlite.fail(DATABASE);
    files.append(WAL, "more");
    expect((await reader.read(NOW + RETRY_MS + 1)).state).toBe("failed");
    sqlite.fail(DATABASE, false);
    files.append(WAL, "more");
    expect((await reader.read(NOW + RETRY_MS + 2)).state).toBe("read");
  });

  test("after a read that failed, a clock set back counts as time enough", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    sqlite.fail(DATABASE);
    await reader.read(NOW);
    sqlite.fail(DATABASE, false);
    expect((await reader.read(NOW - 5 * SECOND)).state).toBe("read");
  });

  test("with no sqlite3 to be found, nothing is run, and it is looked for again 10 seconds on", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    sqlite.uninstall("/usr/bin/sqlite3");
    expect(await reader.read(NOW)).toEqual({ state: "no-sqlite", rows: [] });
    sqlite.install("/usr/bin/sqlite3", "3.45.1");
    expect((await reader.read(NOW + 2 * SECOND)).state).toBe("no-sqlite");
    expect((await reader.read(NOW + RETRY_MS)).state).toBe("read");
    expect(sqlite.runs).toHaveLength(2);
  });

  test("with only sqlite3 that fail the test, it is looked for again 10 seconds on, without asking a program it knows its version again", async () => {
    const { sqlite, reader } = databaseIn("live-wal");
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    expect((await reader.read(NOW)).state).toBe("vulnerable-sqlite");
    expect((await reader.read(NOW + 2 * SECOND)).state).toBe("vulnerable-sqlite");
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3"]);
    // Homebrew's own sqlite3 is installed: it is found at the next look.
    sqlite.install(KEG, "3.53.0");
    expect((await reader.read(NOW + RETRY_MS - 1)).state).toBe("vulnerable-sqlite");
    const read = await reader.read(NOW + RETRY_MS);
    expect(read.state).toBe("read");
    expect(read).not.toHaveProperty("vulnerable");
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", KEG]);
    expect(sqlite.runs.map((run) => run.binary)).toEqual([KEG, KEG]);
  });

  test("an answer that is not rows is a failed read", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    sqlite.set(DATABASE, "not json");
    expect((await reader.read(NOW)).state).toBe("failed");
  });

  test("a reader that throws inside answers a failed read, and reads afresh after", async () => {
    const { files, sqlite, reader } = databaseIn("live-wal");
    sqlite.throw();
    expect(await reader.read(NOW)).toEqual({ state: "failed", rows: [] });
    sqlite.throw(false);
    files.append(WAL, "more");
    expect((await reader.read(NOW + SECOND)).state).toBe("read");
  });
});

describe("the probe", () => {
  test("is asked first, the same way and with the same sqlite3 as the sessions", async () => {
    const { sqlite, reader } = databaseIn("live-wal");
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    await reader.read(NOW);
    const [probe, query] = sqlite.runs;
    expect(probe?.args.at(-1)).toBe(PROBE_QUERY);
    expect(query?.args.at(-1)).toBe(SESSIONS_QUERY);
    expect(probe?.binary).toBe(query?.binary);
    expect(probe?.args.slice(0, -1)).toEqual(query?.args.slice(0, -1));
  });

  test("tables of a version before v0.21.6 are not asked about, until the database changes", async () => {
    const { files, sqlite, reader } = databaseIn("live-wal");
    sqlite.probe(probeJson("v0.21.5"));
    expect(await reader.read(NOW)).toEqual({ state: "unsupported", rows: [] });
    expect((await reader.read(NOW + 10 * RETRY_MS)).state).toBe("unsupported");
    expect(sqlite.runs).toHaveLength(1);
    sqlite.probe(probeJson());
    files.append(WAL, "migrated");
    expect((await reader.read(NOW + 11 * RETRY_MS)).state).toBe("read");
    expect(sqlite.queries()).toHaveLength(1);
  });

  test("an answer that is not the probe's is a failed read, and the sessions are not asked for", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    sqlite.probe("[not json");
    expect((await reader.read(NOW)).state).toBe("failed");
    expect(sqlite.queries()).toEqual([]);
  });
});

describe("within the time left for reading", () => {
  test("the probe and the query each get their own 5 seconds or what is left, whichever is less, and with no time given, the whole 5", async () => {
    for (const [left, timeout] of [
      [2_500, 2_500],
      [9_000, SQLITE_TIMEOUT_MS],
    ] as const) {
      const { sqlite, reader } = databaseIn("rollback");
      expect(
        (
          await reader.read(
            NOW,
            readTime(() => left),
          )
        ).state,
      ).toBe("read");
      expect(sqlite.runs.map((run) => [run.args.at(-1), run.timeoutMs])).toEqual([
        [PROBE_QUERY, timeout],
        [SESSIONS_QUERY, timeout],
      ]);
    }
    const { sqlite, reader } = databaseIn("rollback");
    await reader.read(NOW);
    expect(sqlite.runs.map((run) => run.timeoutMs)).toEqual([SQLITE_TIMEOUT_MS, SQLITE_TIMEOUT_MS]);
  });

  test("as the poll's first run, the probe gets its whole 5 seconds, and the query what is left after it", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    const clock = handClock(NOW);
    sqlite.slowly({ clock, takesMs: 1_000 });
    const time = readTime(() => NOW + 2_500 - clock.now(), false);
    expect((await reader.read(NOW, time)).state).toBe("read");
    expect(sqlite.timed.map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["probe", SQLITE_TIMEOUT_MS],
      ["query", 1_500],
    ]);
  });

  test("with nothing left, nothing is run, the read is out of time, and the next read with time asks at once", async () => {
    const { sqlite, reader } = databaseIn("live-wal");
    expect(
      await reader.read(
        NOW,
        readTime(() => 0),
      ),
    ).toEqual({ state: "out-of-time", rows: [] });
    expect(sqlite.runs).toEqual([]);
    expect(sqlite.versionRuns).toEqual([]);
    const read = await reader.read(NOW + SECOND);
    expect(read.state).toBe("read");
    expect(read.rows.map((row) => row.id)).toEqual([A]);
  });

  test("a probe cut short is out of time, and the query is not run", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    const clock = handClock(NOW);
    sqlite.slowly({ clock, takesMs: 2_000 });
    expect(
      await reader.read(
        NOW,
        readTime(() => NOW + 1_000 - clock.now()),
      ),
    ).toEqual({
      state: "out-of-time",
      rows: [],
    });
    expect(sqlite.probes()).toHaveLength(1);
    expect(sqlite.probes()[0]?.timeoutMs).toBe(1_000);
    expect(sqlite.queries()).toEqual([]);
    expect(clock.now()).toBe(NOW + 1_000);
  });

  test("a query cut short after a probe that was given less than its 5 seconds is out of time", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    const clock = handClock(NOW);
    sqlite.slowly({ clock, takesMs: 2_000 });
    const time = readTime(() => NOW + 3_000 - clock.now());
    expect((await reader.read(NOW, time)).state).toBe("out-of-time");
    expect(sqlite.timed.map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["probe", 3_000],
      ["query", 1_000],
    ]);
  });

  test("a probe that does not answer in its whole 5 seconds did not work, and is asked again only 10 seconds on", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    const clock = handClock(NOW);
    // It never answers, and is stopped at its timeout.
    sqlite.slowly({ clock, takesMs: 60_000 });
    const first = clock.now();
    // A poll's time, from now, with no run of it started yet.
    const pollAt = () => {
      const end = clock.now() + SQLITE_TIMEOUT_MS;
      return readTime(() => end - clock.now(), false);
    };
    expect(await reader.read(first, pollAt())).toEqual({ state: "failed", rows: [] });
    expect(sqlite.timed.map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["probe", SQLITE_TIMEOUT_MS],
    ]);
    // Not due for 10 seconds, so nothing is run until then.
    for (const after of [2, 4, 6, 8]) {
      expect((await reader.read(first + after * SECOND, pollAt())).state).toBe("failed");
    }
    expect(sqlite.probes()).toHaveLength(1);
    expect((await reader.read(first + RETRY_MS, pollAt())).state).toBe("failed");
    expect(sqlite.probes()).toHaveLength(2);
  });

  test("when the probe had its whole 5 seconds and the query does not fit after it, every poll would cut it short, so the read did not work and waits 10 seconds", async () => {
    const { files, sqlite, reader } = databaseIn("rollback");
    expect((await reader.read(NOW)).state).toBe("read");
    // The database changes, and each question now takes 3 seconds, each well within its own 5.
    writeRollbackDatabase(files, DATABASE);
    const clock = handClock(NOW);
    sqlite.slowly({ clock, takesMs: 3_000 });
    const pollAt = () => {
      const end = clock.now() + SQLITE_TIMEOUT_MS;
      return readTime(() => end - clock.now(), false);
    };
    const at = clock.now();
    expect(await reader.read(at, pollAt())).toEqual({ state: "failed", rows: [] });
    expect(sqlite.timed.slice(2).map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["probe", SQLITE_TIMEOUT_MS],
      ["query", 2_000],
    ]);
    const runs = sqlite.runs.length;
    expect((await reader.read(at + 2 * SECOND, pollAt())).state).toBe("failed");
    expect(sqlite.runs).toHaveLength(runs);
    // With nothing else in its way, and quick again, it is read 10 seconds on.
    sqlite.slowly(undefined);
    const read = await reader.read(at + RETRY_MS, pollAt());
    expect(read.state).toBe("read");
    expect(sqlite.runs).toHaveLength(runs + 2);
  });

  test("a query cut short after a probe that was not the poll's first run is out of time, and the next read, its probe first, settles it", async () => {
    const { sqlite, reader } = databaseIn("rollback");
    const clock = handClock(NOW);
    sqlite.slowly({ clock, takesMs: 3_000 });
    // Another profile's runs used 1 second of the poll first.
    let end = clock.now() + 4_000;
    expect(
      (
        await reader.read(
          NOW,
          readTime(() => end - clock.now()),
        )
      ).state,
    ).toBe("out-of-time");
    expect(sqlite.timed.map((run) => run.timeoutMs)).toEqual([4_000, 1_000]);
    // The next poll starts with it.
    end = clock.now() + SQLITE_TIMEOUT_MS;
    expect(
      (
        await reader.read(
          NOW + 2 * SECOND,
          readTime(() => end - clock.now(), false),
        )
      ).state,
    ).toBe("failed");
    expect(sqlite.timed.slice(2).map((run) => run.timeoutMs)).toEqual([SQLITE_TIMEOUT_MS, 2_000]);
  });

  test("a read cut short leaves the last one where it was, so a failed read stays due and a changed database is asked again", async () => {
    const { files, sqlite, reader } = databaseIn("live-wal");
    sqlite.fail(DATABASE);
    expect((await reader.read(NOW)).state).toBe("failed");
    sqlite.fail(DATABASE, false);
    // Due 10 seconds on, and cut short then: it is asked again on the next read, not 10 seconds after that.
    expect(
      (
        await reader.read(
          NOW + RETRY_MS,
          readTime(() => 0),
        )
      ).state,
    ).toBe("out-of-time");
    expect((await reader.read(NOW + RETRY_MS + 2 * SECOND)).state).toBe("read");

    // The -wal grows, and that read is cut short: the next read asks again, though nothing changed since.
    files.append(WAL, "more");
    const runs = sqlite.runs.length;
    expect(
      (
        await reader.read(
          NOW + RETRY_MS + 4 * SECOND,
          readTime(() => 0),
        )
      ).state,
    ).toBe("out-of-time");
    expect(sqlite.runs).toHaveLength(runs);
    expect((await reader.read(NOW + RETRY_MS + 6 * SECOND)).state).toBe("read");
    expect(sqlite.runs).toHaveLength(runs + 2);
  });

  test("a sqlite3 that throws once the time is used is a failed read, not one cut short, and the next read starts again from the header", async () => {
    const { files, sqlite, reader } = databaseIn("rollback");
    const clock = handClock(NOW);
    sqlite.slowly({ clock, takesMs: 2_000 });
    sqlite.throw();
    expect(
      await reader.read(
        NOW,
        readTime(() => NOW + 1_000 - clock.now()),
      ),
    ).toEqual({
      state: "failed",
      rows: [],
    });
    expect(clock.now()).toBe(NOW + 1_000);
    expect(headerReads(files)).toHaveLength(1);

    // Nothing changed, and the 10 seconds a failed read waits have not passed,
    // yet it is asked again, with its header read again.
    sqlite.throw(false);
    sqlite.slowly(undefined);
    const read = await reader.read(NOW + 2 * SECOND);
    expect(read.state).toBe("read");
    expect(read.rows.map((row) => row.id)).toEqual([A]);
    expect(headerReads(files)).toHaveLength(2);
  });

  test("a read that stands, as nothing changed, answers its rows with no time left, and runs nothing", async () => {
    const { sqlite, reader } = databaseIn("live-wal");
    await reader.read(NOW);
    const runs = sqlite.runs.length;
    const read = await reader.read(
      NOW + 2 * SECOND,
      readTime(() => 0),
    );
    expect(read.state).toBe("read");
    expect(read.rows.map((row) => row.id)).toEqual([A]);
    expect(sqlite.runs).toHaveLength(runs);
  });
});
