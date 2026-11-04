import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  COMMAND_SHOWN,
  createGooseAdapter,
  GOOSE_CAPABILITIES,
  gooseDatabaseFor,
  gooseDataDirFor,
  NO_SQLITE_ADVICE,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
  STATUS_NOTE,
  UNCHECKED_NOTE,
  UNSUPPORTED_ADVICE,
  WINDOWS_DETAIL,
} from "@collector/adapters/goose/index";
import { RETRY_MS, type DatabaseReader } from "@collector/adapters/goose/database";
import {
  DATA_DIR,
  DATABASE,
  DAY,
  HOME,
  HOUR,
  MINUTE,
  NOW,
  printedRow,
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  probeJson,
  PROJECT,
  SECOND,
  SESSIONS_DIR,
} from "@tests/fixtures/goose/goose";
import {
  gooseAdapterFor,
  gooseFiles,
  handClock,
  memoryFiles,
  standInProcesses,
  standInSqlite,
} from "@tests/support/adapters/goose/gooseAdapter";
import { asWritten } from "@tests/support/paths";

const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;
const NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const SHOWN_DATABASE = "~/.local/share/goose/sessions/sessions.db";
const READ_DETAIL = `Sessions are read from Goose's database, ${SHOWN_DATABASE}, with sqlite3. ${NOTES}`;

/** The rows Sources shows, for the default folder. */
function watching(
  read: string,
  commandRun = "when the database changes",
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no Goose",
) {
  return [
    { label: "Data folder", value: "~/.local/share/goose" },
    { label: "Database", value: SHOWN_DATABASE },
    { label: "Read", value: read },
    { label: "Command", value: COMMAND_SHOWN },
    { label: "Command run", value: commandRun },
    { label: "Process check", value: "ps -A -o comm=" },
    { label: "Process check run", value: processCheckRun },
  ];
}

const seconds = (at: number) => Math.floor(at / SECOND);

describe("where it looks", () => {
  test("in ~/.local/share/goose, on macOS as on Linux, unless a setting names another place", () => {
    expect(asWritten(gooseDataDirFor({}, HOME))).toBe(DATA_DIR);
    expect(asWritten(gooseDatabaseFor({}, HOME))).toBe(DATABASE);
    expect(asWritten(gooseDataDirFor({ XDG_DATA_HOME: "/data" }, HOME))).toBe("/data/goose");
  });

  test("in `data` under GOOSE_PATH_ROOT, which comes before XDG_DATA_HOME", () => {
    const root = path.resolve("/goose-root");
    expect(
      asWritten(gooseDataDirFor({ GOOSE_PATH_ROOT: root, XDG_DATA_HOME: "/data" }, HOME)),
    ).toBe(asWritten(path.join(root, "data")));
    expect(asWritten(gooseDatabaseFor({ GOOSE_PATH_ROOT: root }, HOME))).toBe(
      asWritten(path.join(root, "data", "sessions", "sessions.db")),
    );
  });

  test("past a relative GOOSE_PATH_ROOT or XDG_DATA_HOME, as Goose goes past them", () => {
    expect(
      asWritten(gooseDataDirFor({ GOOSE_PATH_ROOT: "goose", XDG_DATA_HOME: "data" }, HOME)),
    ).toBe(DATA_DIR);
    expect(asWritten(gooseDataDirFor({ GOOSE_PATH_ROOT: "" }, HOME))).toBe(DATA_DIR);
  });

  test("in the folder Agent Lookout's own setting names, before any other", () => {
    expect(
      asWritten(
        gooseDataDirFor(
          { AGENT_LOOKOUT_GOOSE_HOME: " /tmp/goose ", GOOSE_PATH_ROOT: path.resolve("/other") },
          HOME,
        ),
      ),
    ).toBe("/tmp/goose");
  });

  test("past a setting of spaces", async () => {
    expect(asWritten(gooseDataDirFor({ AGENT_LOOKOUT_GOOSE_HOME: "  " }, HOME))).toBe(DATA_DIR);
    const adapter = gooseAdapterFor(memoryFiles(), standInSqlite(), {
      env: { AGENT_LOOKOUT_GOOSE_HOME: "  " },
    });
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });
});

describe("a Goose that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const sqlite = standInSqlite();
    const processes = standInProcesses();
    const adapter = gooseAdapterFor(files, sqlite, { now: clock.now, processes });
    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "goose",
      label: "Goose",
      state: "unavailable",
      detail:
        "Goose was not found: there is no ~/.local/share/goose folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(sessions).toEqual([]);
    expect(health).not.toHaveProperty("advice");

    files.forget();
    clock.advance(RECHECK_MS - 1);
    expect((await adapter.poll()).health.state).toBe("unavailable");
    expect(files.calls).toEqual([]);

    clock.advance(1);
    await adapter.poll();
    expect(files.calls).toEqual([{ method: "stat", path: DATA_DIR }]);
    expect(sqlite.runs).toEqual([]);
    expect(processes.asked.count).toBe(0);
  });

  test("is found once its folder appears", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = gooseAdapterFor(files, standInSqlite([printedRow()]), { now: clock.now });
    await adapter.poll();
    files.write(DATABASE, "database");
    clock.advance(RECHECK_MS);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("a clock set back looks again", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = gooseAdapterFor(files, standInSqlite(), { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(-1);
    await adapter.poll();
    expect(files.count("stat")).toBe(1);
  });

  test("a folder named for Agent Lookout with nothing in it is an answer, not a missing Goose", async () => {
    const adapter = gooseAdapterFor(memoryFiles(), standInSqlite(), {
      env: { AGENT_LOOKOUT_GOOSE_HOME: "/tmp/empty-goose" },
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_GOOSE_HOME is set to ${path.resolve("/tmp/empty-goose")}, which has no sessions/sessions.db, so no Goose sessions are listed. ${NOTES}`,
    );
    expect(sessions).toEqual([]);
    expect(basis).toBe(BASIS);
  });

  test("a data folder with no database yet says so, and is watched", async () => {
    const files = memoryFiles();
    files.mkdir(DATA_DIR);
    const { health } = await gooseAdapterFor(files, standInSqlite()).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(`Goose has not saved a database at ${SHOWN_DATABASE} yet. ${NOTES}`);
  });

  test("a data folder that goes with its database is not found again", async () => {
    const files = gooseFiles();
    const adapter = gooseAdapterFor(files, standInSqlite([printedRow()]));
    expect((await adapter.poll()).health.state).toBe("ok");
    files.remove(DATA_DIR);
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });

  test("a file at the data folder's name is a Goose not found", async () => {
    const files = memoryFiles();
    files.write(DATA_DIR, "not a folder");
    expect((await gooseAdapterFor(files, standInSqlite()).poll()).health.state).toBe("unavailable");
  });

  test("a data folder that cannot be looked at is not taken for a missing Goose", async () => {
    const files = gooseFiles();
    files.fail(DATA_DIR);
    const { health } = await gooseAdapterFor(files, standInSqlite()).poll();
    expect(health.state).not.toBe("unavailable");
  });

  test("a data folder that went with its database is believed gone for a minute", async () => {
    const files = gooseFiles();
    const clock = handClock();
    const adapter = gooseAdapterFor(files, standInSqlite([printedRow()]), { now: clock.now });
    await adapter.poll();
    files.remove(DATA_DIR);
    await adapter.poll();
    files.forget();
    clock.advance(RECHECK_MS - 1);
    await adapter.poll();
    expect(files.calls).toEqual([]);
  });
});

describe("on Windows", () => {
  test("nothing is read, no program is run, and the card says why", async () => {
    const files = gooseFiles();
    const sqlite = standInSqlite([printedRow()]);
    const processes = standInProcesses();
    files.forget();
    const adapter = gooseAdapterFor(files, sqlite, { platform: "win32", processes });
    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({ state: "unavailable", detail: WINDOWS_DETAIL });
    expect(health.watching).toEqual(
      watching("not on Windows", "not run on Windows", "not run on Windows"),
    );
    expect(sessions).toEqual([]);
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
    expect(processes.asked.count).toBe(0);
  });

  test("a reader that says it does not read there is believed", async () => {
    const reader: DatabaseReader = { read: async () => ({ state: "not-on-windows", rows: [] }) };
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite(), { reader });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail: WINDOWS_DETAIL,
    });
  });
});

describe("a session", () => {
  test("appears with its folder's name, its folder and a status, and nothing else of its row", async () => {
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite([printedRow()]));
    const { health, sessions, basis } = await adapter.poll();
    expect(sessions).toEqual([
      {
        id: "goose:20261001_1",
        source: "goose",
        surface: "unknown",
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "unknown",
        startedAt: Math.floor((NOW - HOUR) / SECOND) * SECOND,
        statusSince: null,
        links: {},
        stale: false,
      },
    ]);
    expect(basis).toBe(BASIS);
    expect(health).toEqual({
      id: "goose",
      label: "Goose",
      state: "ok",
      detail: READ_DETAIL,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(adapter.capabilities).toBe(GOOSE_CAPABILITIES);
    expect(adapter.lookingIn).toBe(`Looking for Goose sessions in ${SHOWN_DATABASE}.`);
  });

  test("keeps the name the person gave it", async () => {
    const adapter = gooseAdapterFor(
      gooseFiles(),
      standInSqlite([printedRow({ own_name: "Release notes" })]),
    );
    expect((await adapter.poll()).sessions[0]?.name).toBe("Release notes");
  });

  test("nothing but the kept fields reaches it, whatever the answer holds", async () => {
    const adapter = gooseAdapterFor(
      gooseFiles(),
      standInSqlite([
        printedRow({
          name: PRIVATE_TITLE,
          description: PRIVATE_WORDS,
          content_json: PRIVATE_WORDS,
          provider_name: PRIVATE_WORDS,
          model_config_json: PRIVATE_WORDS,
          extension_data: PRIVATE_WORDS,
          recipe_json: PRIVATE_WORDS,
          total_tokens: 1234,
          pid: 41001,
        }),
      ]),
    );
    const { sessions } = await adapter.poll();
    const printed = JSON.stringify(sessions);
    expect(printed).not.toContain(PRIVATE_TITLE);
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain("1234");
    expect(Object.keys(sessions[0]!).sort()).toEqual(
      [
        "cwd",
        "id",
        "links",
        "name",
        "project",
        "source",
        "stale",
        "startedAt",
        "status",
        "statusSince",
        "surface",
      ].sort(),
    );
  });

  test("leaves the list 24 hours after Goose last wrote it, and is judged again with no read", async () => {
    const clock = handClock();
    const sqlite = standInSqlite([printedRow({ updated_s: seconds(NOW) })]);
    const adapter = gooseAdapterFor(gooseFiles(), sqlite, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    clock.advance(DAY - MINUTE);
    expect((await adapter.poll()).sessions).toHaveLength(1);
    clock.advance(MINUTE);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(sqlite.runs).toHaveLength(1);
  });

  test("with no time Goose wrote it is not listed", async () => {
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite([printedRow({ updated_s: null })]));
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("a row that is not one Goose makes is dropped, and the others stay", async () => {
    const adapter = gooseAdapterFor(
      gooseFiles(),
      standInSqlite([printedRow({ id: "../elsewhere" }), printedRow({ id: "20261001_2" })]),
    );
    expect((await adapter.poll()).sessions.map(({ id }) => id)).toEqual(["goose:20261001_2"]);
  });
});

describe("its status", () => {
  test("is unknown while a Goose program runs, and never working, idle or needing you", async () => {
    const adapter = gooseAdapterFor(
      gooseFiles(),
      standInSqlite([printedRow(), printedRow({ id: "20261001_2", updated_s: seconds(NOW) })]),
    );
    const { sessions } = await adapter.poll();
    expect(new Set(sessions.map(({ status }) => status))).toEqual(new Set(["unknown"]));
    for (const session of sessions) {
      expect(session).not.toHaveProperty("waitingReason");
      expect(session).not.toHaveProperty("waitingText");
    }
  });

  test("is finished once no Goose program runs, since Goose last wrote it", async () => {
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite([printedRow()]), {
      processes: standInProcesses({ ok: true, running: false }),
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(sessions[0]).toMatchObject({
      status: "finished",
      statusSince: seconds(NOW - MINUTE) * SECOND,
    });
    expect(basis).toBe(BASIS_CLOSED);
    expect(health.detail).toBe(
      `${READ_DETAIL} No Goose program runs, so each session shows as finished.`,
    );
  });

  test("is unknown, with no session shown as finished, while `ps` cannot say", async () => {
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite([printedRow()]), {
      processes: standInProcesses({ ok: false }),
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(health.detail).toBe(
      `${READ_DETAIL} ps could not be run to tell whether Goose runs, so no session is shown as finished.`,
    );
  });

  test("on a system with no `ps` to ask, it says it cannot tell", async () => {
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite([printedRow()]), {
      platform: "freebsd",
      processes: standInProcesses({ ok: false }),
    });
    const { health } = await adapter.poll();
    expect(health.detail).toContain(
      "Agent Lookout cannot tell on this system whether Goose runs, so no session is shown as finished.",
    );
    expect(health.watching).toContainEqual({
      label: "Process check run",
      value: "not run on this system",
    });
  });

  test("of a crash left behind, with the -wal and -shm full and no Goose, is finished", async () => {
    const files = gooseFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const adapter = gooseAdapterFor(files, standInSqlite([printedRow()]), {
      processes: standInProcesses({ ok: true, running: false }),
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(sessions[0]?.status).toBe("finished");
  });

  test("of a crash left behind while another Goose runs is unknown, never as if it ran", async () => {
    const files = gooseFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    const { sessions } = await gooseAdapterFor(files, standInSqlite([printedRow()])).poll();
    expect(sessions[0]?.status).toBe("unknown");
  });

  test("moves with `ps` alone, with no new read of the database", async () => {
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    const processes = standInProcesses();
    const adapter = gooseAdapterFor(gooseFiles(), sqlite, { now: clock.now, processes });
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    processes.set({ ok: true, running: false });
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    expect(sqlite.runs).toHaveLength(1);
  });
});

describe("how often `ps` is asked", () => {
  test("not at all while there is no session to show", async () => {
    const processes = standInProcesses();
    await gooseAdapterFor(gooseFiles(), standInSqlite(), { processes }).poll();
    expect(processes.asked.count).toBe(0);
  });

  test("at most every 10 seconds while there are", async () => {
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite([printedRow()]), {
      now: clock.now,
      processes,
    });
    await adapter.poll();
    clock.advance(PROCESS_CHECK_MS - 1);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(1);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test("sooner when a session is written after it said none runs, since Goose may have been started", async () => {
    const clock = handClock();
    const files = gooseFiles();
    const sqlite = standInSqlite([printedRow()]);
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = gooseAdapterFor(files, sqlite, { now: clock.now, processes });
    await adapter.poll();
    expect(processes.asked.count).toBe(1);

    // Goose started, and wrote: it is asked at the first poll 2 seconds on.
    processes.set({ ok: true, running: true });
    clock.advance(PROMPT_PROCESS_CHECK_MS - 1);
    sqlite.set([printedRow({ updated_s: seconds(NOW + SECOND) })]);
    files.rewrite(DATABASE, "database, changed", { mtimeMs: NOW + SECOND });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    expect(processes.asked.count).toBe(1);

    clock.advance(1);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    expect(processes.asked.count).toBe(2);
  });

  test("sooner for a session written later in the same second, as its time reads as that second's start", async () => {
    const clock = handClock(NOW + 400);
    const files = gooseFiles();
    const sqlite = standInSqlite([printedRow()]);
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = gooseAdapterFor(files, sqlite, { now: clock.now, processes });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");

    // Goose started and wrote 200 milliseconds after `ps` said none runs.
    processes.set({ ok: true, running: true });
    sqlite.set([printedRow({ updated_s: seconds(NOW + 600) })]);
    files.rewrite(DATABASE, "database, changed", { mtimeMs: NOW + 600 });
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    expect(processes.asked.count).toBe(2);
  });

  test("a session written in the same second costs one more ask when none runs, and no more", async () => {
    const clock = handClock(NOW + 400);
    const sqlite = standInSqlite([printedRow({ updated_s: seconds(NOW) })]);
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = gooseAdapterFor(gooseFiles(), sqlite, { now: clock.now, processes });
    await adapter.poll();
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);

    clock.advance(PROCESS_CHECK_MS - 1);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
    clock.advance(1);
    await adapter.poll();
    expect(processes.asked.count).toBe(3);
  });

  test("no sooner than every 10 seconds while none runs and nothing is written", async () => {
    const clock = handClock();
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite([printedRow()]), {
      now: clock.now,
      processes,
    });
    await adapter.poll();
    clock.advance(PROCESS_CHECK_MS - 1);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
  });

  test.each([
    ["a Goose runs", { ok: true, running: true }],
    ["ps could not say", { ok: false }],
  ] as const)("a session written while %s brings it no sooner", async (_case, answer) => {
    const clock = handClock();
    const files = gooseFiles();
    const sqlite = standInSqlite([printedRow()]);
    const processes = standInProcesses(answer);
    const adapter = gooseAdapterFor(files, sqlite, { now: clock.now, processes });
    await adapter.poll();
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    sqlite.set([printedRow({ updated_s: seconds(NOW + SECOND) })]);
    files.rewrite(DATABASE, "database, changed", { mtimeMs: NOW + SECOND });
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
  });

  test("the card promises no sooner check when the check is as often", async () => {
    const adapter = gooseAdapterFor(memoryFiles(), standInSqlite(), {
      processCheckMs: PROMPT_PROCESS_CHECK_MS,
    });
    const { health } = await adapter.poll();
    expect(health.watching).toContainEqual({
      label: "Process check run",
      value: "every 2 seconds at most",
    });
  });

  test("a clock set back counts as time enough", async () => {
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite([printedRow()]), {
      now: clock.now,
      processes,
    });
    await adapter.poll();
    clock.advance(-SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });
});

describe("a database that cannot be read", () => {
  test("with no sqlite3 on Linux says how to get one, and lists nothing", async () => {
    const sqlite = standInSqlite([printedRow()]);
    sqlite.gone();
    const { health, sessions, basis } = await gooseAdapterFor(gooseFiles(), sqlite, {
      platform: "linux",
    }).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: `No sqlite3 program was found to read Goose's database, ${SHOWN_DATABASE}, so no Goose sessions are listed.`,
      advice: NO_SQLITE_ADVICE,
    });
    expect(sessions).toEqual([]);
    expect(basis).toBeUndefined();
  });

  test("with no sqlite3 on a Mac has no such advice", async () => {
    const sqlite = standInSqlite();
    sqlite.gone();
    const { health } = await gooseAdapterFor(gooseFiles(), sqlite).poll();
    expect(health.state).toBe("error");
    expect(health).not.toHaveProperty("advice");
  });

  test("that is broken says sqlite3 could not read it", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("both");
    const { health, sessions } = await gooseAdapterFor(gooseFiles(), sqlite).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: `sqlite3 could not read Goose's database, ${SHOWN_DATABASE}, so no Goose sessions are listed. Agent Lookout tries again when it changes, or 10 seconds on.`,
    });
    expect(sessions).toEqual([]);
  });

  test("that failed is tried again 10 seconds on, and the card recovers", async () => {
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    sqlite.fail("both");
    const adapter = gooseAdapterFor(gooseFiles(), sqlite, { now: clock.now });
    expect((await adapter.poll()).health.state).toBe("error");
    sqlite.fail("no");
    clock.advance(RETRY_MS - 1);
    expect((await adapter.poll()).health.state).toBe("error");
    clock.advance(1);
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(1);
  });

  test("laid out as an older Goose says to update it", async () => {
    const sqlite = standInSqlite();
    sqlite.fail("question");
    sqlite.setProbe(probeJson(["archived_at"]));
    const { health } = await gooseAdapterFor(gooseFiles(), sqlite).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: `Goose's database, ${SHOWN_DATABASE}, is laid out as a version of Goose that Agent Lookout does not read. It reads those of Goose v1.34.0 and later.`,
      advice: UNSUPPORTED_ADVICE,
    });
  });

  test.each([
    ["the database", (files: ReturnType<typeof gooseFiles>) => files.special(DATABASE)],
    ["the -wal", (files: ReturnType<typeof gooseFiles>) => files.special(WAL)],
    [
      "the sessions folder",
      (files: ReturnType<typeof gooseFiles>) => {
        files.remove(SESSIONS_DIR);
        files.special(SESSIONS_DIR);
      },
    ],
  ])("with a link in place of %s is not read, and says why", async (_case, change) => {
    const files = gooseFiles();
    change(files);
    const sqlite = standInSqlite([printedRow()]);
    const { health, sessions } = await gooseAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain(
      "was not read: a link or something other than an ordinary file",
    );
    expect(sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("with a -wal but no -shm is not read, as that would write one", async () => {
    const files = gooseFiles();
    files.write(WAL, "frames");
    const { health } = await gooseAdapterFor(files, standInSqlite()).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain("its -wal file holds something but has no -shm file beside it");
  });

  test("a read that throws is a sentence, not a stack trace", async () => {
    const reader: DatabaseReader = {
      read: async () => {
        throw new Error("A stand-in that throws.");
      },
    };
    const adapter = gooseAdapterFor(gooseFiles(), standInSqlite(), { reader });
    expect((await adapter.poll()).health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading Goose sessions.",
    });
  });
});

describe("the adapter is read-only", () => {
  test("it only looks at the three files and the folders above them, and opens none itself", async () => {
    const files = gooseFiles();
    files.write(WAL, "frames");
    files.write(SHM, "index");
    await gooseAdapterFor(files, standInSqlite([printedRow()])).poll();
    expect(files.opened()).toEqual([]);
    expect(files.reads).toEqual([]);
    expect(new Set(files.calls.map(({ method }) => method))).toEqual(new Set(["stat", "lstat"]));
    expect(new Set(files.calls.map(({ path: target }) => target))).toEqual(
      new Set([DATA_DIR, SESSIONS_DIR, DATABASE, WAL, SHM]),
    );
  });

  test("a default adapter asks the system nothing until it is polled", () => {
    const files = memoryFiles();
    createGooseAdapter({ env: {}, homeDir: HOME, io: files.io, platform: "darwin" });
    expect(files.calls).toEqual([]);
  });
});
