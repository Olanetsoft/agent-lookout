import path from "node:path";

import { describe, expect, test } from "vitest";

import type { DatabaseReader } from "@collector/adapters/opencode/database";
import {
  BASIS,
  BASIS_CLOSED,
  COMMAND_SHOWN,
  createOpencodeAdapter,
  NEEDS_YOU_NOTE,
  OPENCODE_2_NOTE,
  OPENCODE_CAPABILITIES,
  opencodeDatabaseFor,
  opencodeHomeFor,
  RECHECK_MS,
  UNCHECKED_NOTE,
  UNKNOWN_MESSAGE_NOTE,
  WINDOWS_DETAIL,
} from "@collector/adapters/opencode/index";
import {
  answerRow,
  DATA_HOME,
  DATABASE,
  HOME,
  MINUTE,
  NOW,
  probeJson,
  sessionId,
} from "@tests/fixtures/opencode/opencode";
import {
  handClock,
  memoryFiles,
  opencodeAdapterFor,
  standInSqlite,
  type MemoryFiles,
} from "@tests/support/adapters/opencodeAdapter";
import { asWritten } from "@tests/support/paths";

const A = sessionId("a1");
const B = sessionId("b2");
const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;
const NOTES = `${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

/** The rows Sources shows, for the default folder. */
function watching(read: string, commandRun = "when the database changes") {
  return [
    { label: "Data folder", value: "~/.local/share/opencode" },
    { label: "Database", value: "~/.local/share/opencode/opencode.db" },
    { label: "Read", value: read },
    { label: "Command", value: COMMAND_SHOWN },
    { label: "Command run", value: commandRun },
  ];
}

/** OpenCode's folder with its database, open, as a running OpenCode keeps it. */
function openOpencode(rows: Record<string, unknown>[] = [answerRow({ id: A })]) {
  const files = memoryFiles();
  files.write(DATABASE, "database");
  files.write(WAL, "frames");
  files.write(SHM, "index");
  const sqlite = standInSqlite(rows);
  return { files, sqlite };
}

describe("where it looks", () => {
  test("in ~/.local/share/opencode, on macOS as on Linux, unless a setting names another place", () => {
    expect(asWritten(opencodeHomeFor({}, HOME))).toBe(DATA_HOME);
    expect(asWritten(opencodeHomeFor({ XDG_DATA_HOME: "/data" }, HOME))).toBe("/data/opencode");
    // A relative one is not taken: OpenCode would take it from where it was started.
    expect(asWritten(opencodeHomeFor({ XDG_DATA_HOME: "data" }, HOME))).toBe(DATA_HOME);
    expect(
      asWritten(
        opencodeHomeFor({ AGENT_LOOKOUT_OPENCODE_HOME: " /tmp/oc ", XDG_DATA_HOME: "/data" }, HOME),
      ),
    ).toBe("/tmp/oc");
  });

  test("at opencode.db, or where OpenCode's own OPENCODE_DB says, unless Agent Lookout's setting names a folder", () => {
    expect(asWritten(opencodeDatabaseFor({}, HOME) ?? "")).toBe(DATABASE);
    expect(asWritten(opencodeDatabaseFor({ OPENCODE_DB: "/elsewhere/oc.db" }, HOME) ?? "")).toBe(
      "/elsewhere/oc.db",
    );
    expect(asWritten(opencodeDatabaseFor({ OPENCODE_DB: "other.db" }, HOME) ?? "")).toBe(
      `${DATA_HOME}/other.db`,
    );
    expect(opencodeDatabaseFor({ OPENCODE_DB: ":memory:" }, HOME)).toBeNull();
    expect(asWritten(opencodeDatabaseFor({ OPENCODE_DB: "" }, HOME) ?? "")).toBe(DATABASE);
    expect(
      asWritten(
        opencodeDatabaseFor(
          { AGENT_LOOKOUT_OPENCODE_HOME: "/tmp/oc", OPENCODE_DB: ":memory:" },
          HOME,
        ) ?? "",
      ),
    ).toBe("/tmp/oc/opencode.db");
  });
});

describe("an OpenCode that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const sqlite = standInSqlite();
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now });
    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "opencode",
      label: "OpenCode",
      state: "unavailable",
      detail:
        "OpenCode was not found: there is no ~/.local/share/opencode folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(health).not.toHaveProperty("advice");
    expect(sessions).toEqual([]);
    expect(files.calls).toEqual([{ method: "stat", path: DATA_HOME }]);

    clock.advance(RECHECK_MS - 1);
    await adapter.poll();
    expect(files.calls).toHaveLength(1);
    clock.advance(1);
    await adapter.poll();
    expect(files.calls).toHaveLength(2);
    expect(sqlite.runs).toEqual([]);
  });

  test("is found once its folder is made, and lost again when it goes", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = opencodeAdapterFor(files, standInSqlite(), { now: clock.now });
    expect((await adapter.poll()).health.state).toBe("unavailable");
    files.mkdir(DATA_HOME);
    clock.advance(RECHECK_MS);
    const found = await adapter.poll();
    expect(found.health).toMatchObject({
      state: "ok",
      detail: `OpenCode has not saved a database at ~/.local/share/opencode/opencode.db yet. ${NOTES}`,
      watching: watching("every 2 seconds"),
    });
    expect(found.basis).toBe(BASIS);
    files.remove(DATA_HOME);
    clock.advance(2_000);
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });

  test("with Agent Lookout's setting, a folder with no database is an answer, not a missing OpenCode", async () => {
    const files = memoryFiles();
    const env = { AGENT_LOOKOUT_OPENCODE_HOME: "/tmp/empty-opencode" };
    const adapter = opencodeAdapterFor(files, standInSqlite(), { env });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_OPENCODE_HOME is set to ${path.resolve("/tmp/empty-opencode")}, which has no opencode.db, so no OpenCode sessions are listed. ${NOTES}`,
    );
    expect(sessions).toEqual([]);
    // Its folder is never looked for.
    expect(files.count("stat")).toBe(0);
  });
});

describe("on Windows", () => {
  test("nothing is read, and OpenCode is not found, with why", async () => {
    const { files, sqlite } = openOpencode();
    files.forget();
    const adapter = opencodeAdapterFor(files, sqlite, { platform: "win32" });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toBe(WINDOWS_DETAIL);
    expect(health.watching?.find((fact) => fact.label === "Read")?.value).toBe("not on Windows");
    expect(health.watching?.find((fact) => fact.label === "Command run")?.value).toBe(
      "not run on Windows",
    );
    expect(sessions).toEqual([]);
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
    expect(adapter.capabilities).toBe(OPENCODE_CAPABILITIES);
  });
});

describe("reading the sessions", () => {
  test("lists each root session with its name, folder and status, and says what it cannot see", async () => {
    const { files, sqlite } = openOpencode([
      answerRow({ id: A }),
      answerRow({ id: B, title: "Write the notes", m_completed: null, m_finish: null }),
    ]);
    const adapter = opencodeAdapterFor(files, sqlite);
    const { health, sessions, basis } = await adapter.poll();
    expect(health).toEqual({
      id: "opencode",
      label: "OpenCode",
      state: "ok",
      detail: `Sessions are read from OpenCode's database, ~/.local/share/opencode/opencode.db, with sqlite3. ${NOTES}`,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(basis).toBe(BASIS);
    expect(sessions.map((session) => [session.id, session.name, session.status])).toEqual([
      [`opencode:${A}`, "Rename the helper", "idle"],
      [`opencode:${B}`, "Write the notes", "working"],
    ]);
    expect(adapter.lookingIn).toBe(
      "Looking for OpenCode sessions in ~/.local/share/opencode/opencode.db.",
    );
  });

  test("with no OpenCode program holding the database open, each session is finished, unless it failed or cannot be read", async () => {
    const { files, sqlite } = openOpencode([
      answerRow({ id: A }),
      answerRow({ id: B, m_error: "ContextOverflowError" }),
      answerRow({ id: sessionId("c3"), m_role: "system" }),
    ]);
    files.remove(WAL);
    files.remove(SHM);
    const { health, sessions, basis } = await opencodeAdapterFor(files, sqlite).poll();
    expect(basis).toBe(BASIS_CLOSED);
    expect(health.detail).toBe(
      `Sessions are read from OpenCode's database, ~/.local/share/opencode/opencode.db, with sqlite3. ${NOTES} No OpenCode program has the database open, so each session shows as finished, unless it failed or cannot be read. ${UNKNOWN_MESSAGE_NOTE}`,
    );
    expect(sessions.map((session) => session.status)).toEqual(["finished", "failed", "unknown"]);
  });

  test("says so when OpenCode 2's table is there, and when a session ends in a way it does not know", async () => {
    const { files, sqlite } = openOpencode([answerRow({ id: A, m_role: "system" })]);
    sqlite.probe(probeJson("v1+v2"));
    const { health, sessions } = await opencodeAdapterFor(files, sqlite).poll();
    expect(health.detail).toBe(
      `Sessions are read from OpenCode's database, ~/.local/share/opencode/opencode.db, with sqlite3. ${NOTES} ${OPENCODE_2_NOTE} ${UNKNOWN_MESSAGE_NOTE}`,
    );
    expect(sessions[0]?.status).toBe("unknown");
    expect(OPENCODE_2_NOTE).toBe("OpenCode 2's sessions are not read yet.");
  });

  test("a database of OpenCode 2's alone lists no sessions, and says why", async () => {
    const { files, sqlite } = openOpencode();
    sqlite.probe(probeJson("v2-only"));
    const { health, sessions } = await opencodeAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain(OPENCODE_2_NOTE);
    expect(sessions).toEqual([]);
  });

  test("a session not written for a day is left out", async () => {
    const day = 24 * 60 * MINUTE;
    const { files, sqlite } = openOpencode([
      answerRow({ id: A, time_updated: NOW - day, m_updated: NOW - day, p_updated: NOW - day }),
    ]);
    expect((await opencodeAdapterFor(files, sqlite).poll()).sessions).toEqual([]);
  });

  test("a status moves on with the clock while nothing is read again", async () => {
    const { files, sqlite } = openOpencode([
      answerRow({ id: A, m_finish: "tool-calls", m_completed: NOW - 1_000 }),
    ]);
    const clock = handClock();
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    clock.advance(10_000);
    expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
    expect(sqlite.queries()).toHaveLength(1);
  });

  test("OPENCODE_DB=:memory: leaves nothing to read, and runs nothing", async () => {
    const { files, sqlite } = openOpencode();
    const env = { OPENCODE_DB: ":memory:" };
    const { health, sessions } = await opencodeAdapterFor(files, sqlite, { env }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `OPENCODE_DB is set to :memory:, so OpenCode keeps its sessions in memory, where Agent Lookout cannot read them. ${NOTES}`,
    );
    expect(health.watching?.find((fact) => fact.label === "Database")?.value).toBe(":memory:");
    expect(sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("OPENCODE_DB names the database read", async () => {
    const files = memoryFiles();
    files.mkdir(DATA_HOME);
    files.write("/Users/example/oc/opencode-other.db", "database");
    const sqlite = standInSqlite([answerRow({ id: A })]);
    const env = { OPENCODE_DB: "/Users/example/oc/opencode-other.db" };
    const { sessions } = await opencodeAdapterFor(files, sqlite, { env }).poll();
    expect(sessions).toHaveLength(1);
    expect(sqlite.runs[0]?.args.at(-2)).toContain("/Users/example/oc/opencode-other.db?mode=ro");
  });
});

describe("when the database cannot be read", () => {
  const cases: [
    string,
    (files: MemoryFiles, sqlite: ReturnType<typeof standInSqlite>) => void,
    string,
  ][] = [
    [
      "no sqlite3",
      (_files, sqlite) => sqlite.there(false),
      "No sqlite3 program was found to read OpenCode's database, ~/.local/share/opencode/opencode.db, so no OpenCode sessions are listed.",
    ],
    [
      "sqlite3 failing",
      (_files, sqlite) => sqlite.fail(),
      "sqlite3 could not read OpenCode's database, ~/.local/share/opencode/opencode.db, so no OpenCode sessions are listed.",
    ],
    [
      "tables it does not read",
      (_files, sqlite) => sqlite.probe(probeJson("none")),
      "OpenCode's database, ~/.local/share/opencode/opencode.db, is laid out as a version of OpenCode that Agent Lookout does not read.",
    ],
    [
      "a -wal without its -shm",
      (files) => files.remove(SHM),
      "OpenCode's database, ~/.local/share/opencode/opencode.db, was not read: its -wal file holds something but has no -shm file beside it, or one of them is not an ordinary file, so it cannot be read without writing to it.",
    ],
  ];
  test.each(cases)("with %s, it says so plainly and lists nothing", async (_what, make, detail) => {
    const { files, sqlite } = openOpencode();
    make(files, sqlite);
    const result = await opencodeAdapterFor(files, sqlite).poll();
    expect(result.health).toMatchObject({
      state: "error",
      detail,
      watching: watching("every 2 seconds"),
    });
    expect(result.sessions).toEqual([]);
    expect(result).not.toHaveProperty("basis");
  });

  test("poll() never throws", async () => {
    const reader: DatabaseReader = {
      read: () => Promise.reject(new Error("A reader that throws.")),
    };
    const files = memoryFiles();
    files.mkdir(DATA_HOME);
    const adapter = createOpencodeAdapter({
      env: {},
      homeDir: HOME,
      now: () => NOW,
      io: files.io,
      platform: "linux",
      reader,
    });
    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading OpenCode sessions.",
    });
    expect(sessions).toEqual([]);
  });
});
