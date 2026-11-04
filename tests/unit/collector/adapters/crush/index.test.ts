import path from "node:path";

import { describe, expect, test } from "vitest";

import { sourceList } from "@cli/mcp/toolAnswers";
import { RETRY_MS } from "@collector/adapters/crush/database";
import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  COMMAND_SHOWN,
  CRUSH_CAPABILITIES,
  crushDataDirFor,
  NO_SQLITE_ADVICE,
  OLD_CRUSH_ADVICE,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  READ_BUDGET_MS,
  RECHECK_MS,
  STATUS_NOTE,
  UNCHECKED_NOTE,
  WINDOWS_DETAIL,
} from "@collector/adapters/crush/index";
import { MAX_LIST_BYTES, MAX_PROJECTS } from "@collector/adapters/crush/projects";
import { projectPrefix } from "@collector/adapters/crush/toSession";
import {
  DATA_DIR,
  DATA_FOLDER,
  DATABASE,
  DAY,
  HOME,
  HOUR,
  MINUTE,
  NOW,
  OTHER_DATABASE,
  OTHER_PROJECT,
  OTHER_SESSION_ID,
  printedRow,
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  probeJson,
  PROJECT,
  PROJECT_LIST,
  projectListJson,
  seconds,
  SECOND,
  SESSION_ID,
} from "@tests/fixtures/crush/crush";
import {
  crushAdapterFor,
  crushFiles,
  databaseIn,
  handClock,
  memoryFiles,
  standInProcesses,
  standInSqlite,
} from "@tests/support/adapters/crush/crushAdapter";
import { asWritten } from "@tests/support/paths";

const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;
const NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const SHOWN_LIST = "~/.local/share/crush/projects.json";
const READ_DETAIL = `Sessions are read from the database in each project in Crush's list, ${SHOWN_LIST}, with sqlite3. ${NOTES}`;

/** The rows Sources shows, for the default folder. */
function watching(
  read: string,
  projects = "1",
  commandRun = "when a database changes",
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no Crush",
) {
  return [
    { label: "Data folder", value: "~/.local/share/crush" },
    { label: "Project list", value: SHOWN_LIST },
    { label: "Projects", value: projects },
    { label: "Database", value: "<project>/.crush/crush.db" },
    { label: "Read", value: read },
    { label: "Command", value: COMMAND_SHOWN },
    { label: "Command run", value: commandRun },
    { label: "Process check", value: "ps -A -o comm=" },
    { label: "Process check run", value: processCheckRun },
  ];
}

const idOf = (folder: string, session = SESSION_ID) => `${projectPrefix(folder)}${session}`;

describe("where it looks", () => {
  test("in ~/.local/share/crush, on macOS as on Linux, unless a setting names another place", () => {
    expect(asWritten(crushDataDirFor({}, HOME))).toBe(DATA_DIR);
    expect(asWritten(crushDataDirFor({ XDG_DATA_HOME: path.resolve("/data") }, HOME))).toBe(
      asWritten(path.resolve("/data/crush")),
    );
  });

  test("in the folder CRUSH_GLOBAL_DATA names, which comes before XDG_DATA_HOME", () => {
    const own = path.resolve("/crush-data");
    expect(
      asWritten(crushDataDirFor({ CRUSH_GLOBAL_DATA: own, XDG_DATA_HOME: "/data" }, HOME)),
    ).toBe(asWritten(own));
  });

  test("past a relative CRUSH_GLOBAL_DATA or XDG_DATA_HOME, which say nothing without Crush's own folder", () => {
    expect(
      asWritten(crushDataDirFor({ CRUSH_GLOBAL_DATA: "crush", XDG_DATA_HOME: "data" }, HOME)),
    ).toBe(DATA_DIR);
    expect(asWritten(crushDataDirFor({ CRUSH_GLOBAL_DATA: "" }, HOME))).toBe(DATA_DIR);
  });

  test("in the folder Agent Lookout's own setting names, before any other", () => {
    expect(
      asWritten(
        crushDataDirFor(
          { AGENT_LOOKOUT_CRUSH_HOME: " /tmp/crush ", CRUSH_GLOBAL_DATA: path.resolve("/other") },
          HOME,
        ),
      ),
    ).toBe("/tmp/crush");
  });

  test("past a setting of spaces", async () => {
    expect(asWritten(crushDataDirFor({ AGENT_LOOKOUT_CRUSH_HOME: "  " }, HOME))).toBe(DATA_DIR);
    const adapter = crushAdapterFor(memoryFiles(), standInSqlite(), {
      env: { AGENT_LOOKOUT_CRUSH_HOME: "  " },
    });
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });
});

describe("a Crush that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const sqlite = standInSqlite();
    const processes = standInProcesses();
    const adapter = crushAdapterFor(files, sqlite, { now: clock.now, processes });
    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "crush",
      label: "Crush",
      state: "unavailable",
      detail:
        "Crush was not found: there is no ~/.local/share/crush folder. Agent Lookout looks again every minute.",
      watching: watching("not found", "none found"),
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
    const adapter = crushAdapterFor(files, standInSqlite([printedRow()]), { now: clock.now });
    await adapter.poll();
    files.write(PROJECT_LIST, projectListJson());
    files.write(DATABASE, "database");
    clock.advance(RECHECK_MS);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("a clock set back looks again", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = crushAdapterFor(files, standInSqlite(), { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(-1);
    await adapter.poll();
    expect(files.count("stat")).toBe(1);
  });

  test("a folder named for Agent Lookout with nothing in it is an answer, not a missing Crush", async () => {
    const adapter = crushAdapterFor(memoryFiles(), standInSqlite(), {
      env: { AGENT_LOOKOUT_CRUSH_HOME: "/tmp/empty-crush" },
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_CRUSH_HOME is set to ${path.resolve("/tmp/empty-crush")}, which has no projects.json, so no Crush sessions are listed. ${NOTES}`,
    );
    expect(sessions).toEqual([]);
    expect(basis).toBe(BASIS);
  });

  test("a data folder with no list yet says so, is watched, and says a Crush may be too old", async () => {
    const files = memoryFiles();
    files.mkdir(DATA_DIR);
    const { health } = await crushAdapterFor(files, standInSqlite()).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `Crush has not saved a list of projects at ${SHOWN_LIST} yet. ${NOTES}`,
    );
    expect(health.advice).toBe(OLD_CRUSH_ADVICE);
  });

  test("a data folder that goes with its list is not found again", async () => {
    const files = crushFiles();
    const adapter = crushAdapterFor(files, standInSqlite([printedRow()]));
    expect((await adapter.poll()).health.state).toBe("ok");
    files.remove(DATA_DIR);
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });

  test("a data folder that went with its list is believed gone for a minute", async () => {
    const files = crushFiles();
    const clock = handClock();
    const adapter = crushAdapterFor(files, standInSqlite([printedRow()]), { now: clock.now });
    await adapter.poll();
    files.remove(DATA_DIR);
    await adapter.poll();
    files.forget();
    clock.advance(RECHECK_MS - 1);
    await adapter.poll();
    expect(files.calls).toEqual([]);
  });

  test("a file at the data folder's name is a Crush not found", async () => {
    const files = memoryFiles();
    files.write(DATA_DIR, "not a folder");
    expect((await crushAdapterFor(files, standInSqlite()).poll()).health.state).toBe("unavailable");
  });

  test("a data folder that cannot be looked at is not taken for a missing Crush", async () => {
    const files = crushFiles();
    files.fail(DATA_DIR);
    const { health } = await crushAdapterFor(files, standInSqlite()).poll();
    expect(health.state).not.toBe("unavailable");
  });
});

describe("on Windows", () => {
  test("nothing is read, no program is run, and the card says why", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite([printedRow()]);
    const processes = standInProcesses();
    files.forget();
    const adapter = crushAdapterFor(files, sqlite, { platform: "win32", processes });
    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({ state: "unavailable", detail: WINDOWS_DETAIL });
    expect(health.watching).toEqual(
      watching("not on Windows", "none found", "not run on Windows", "not run on Windows"),
    );
    expect(sessions).toEqual([]);
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
    expect(processes.asked.count).toBe(0);
  });
});

describe("a session", () => {
  test("appears with its folder's name, its folder and a status, and nothing else of its row", async () => {
    const adapter = crushAdapterFor(crushFiles(), standInSqlite([printedRow()]));
    const { health, sessions, basis } = await adapter.poll();
    expect(sessions).toEqual([
      {
        id: idOf(PROJECT),
        source: "crush",
        surface: "unknown",
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "unknown",
        startedAt: seconds(NOW - HOUR) * SECOND,
        statusSince: null,
        links: {},
        stale: false,
      },
    ]);
    expect(basis).toBe(BASIS);
    expect(health).toEqual({
      id: "crush",
      label: "Crush",
      state: "ok",
      detail: READ_DETAIL,
      watching: watching("every 2 seconds"),
      parts: { [projectPrefix(PROJECT)]: BASIS },
      checkedAt: NOW,
    });
    expect(adapter.capabilities).toBe(CRUSH_CAPABILITIES);
    expect(adapter.lookingIn).toBe(
      `Looking for Crush sessions in the projects ${SHOWN_LIST} names.`,
    );
  });

  test("nothing but the kept fields reaches it, whatever the answer holds", async () => {
    const adapter = crushAdapterFor(
      crushFiles(),
      standInSqlite([
        printedRow({
          title: PRIVATE_TITLE,
          todos: PRIVATE_WORDS,
          channel: PRIVATE_WORDS,
          parts: PRIVATE_WORDS,
          summary_message_id: PRIVATE_WORDS,
          prompt_tokens: 1234,
          completion_tokens: 1234,
          cost: 12.34,
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

  test("leaves the list a day after Crush last wrote it", async () => {
    const adapter = crushAdapterFor(
      crushFiles(),
      standInSqlite([printedRow({ updated_at: seconds(NOW - DAY) })]),
    );
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("with no time of its last write is not listed", async () => {
    const adapter = crushAdapterFor(
      crushFiles(),
      standInSqlite([printedRow({ updated_at: "not a time" })]),
    );
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("keeps its id from one poll to the next", async () => {
    const files = crushFiles();
    const adapter = crushAdapterFor(files, standInSqlite([printedRow()]));
    const first = (await adapter.poll()).sessions[0]?.id;
    files.write(DATABASE, "changed");
    expect((await adapter.poll()).sessions[0]?.id).toBe(first);
  });

  test("of each project takes that project's folder", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const sqlite = standInSqlite();
    sqlite.setFor(DATABASE, [printedRow()]);
    sqlite.setFor(OTHER_DATABASE, [printedRow({ id: OTHER_SESSION_ID })]);
    const { sessions, health } = await crushAdapterFor(files, sqlite).poll();
    expect(sessions.map(({ id, cwd, name }) => [id, cwd, name])).toEqual([
      [idOf(PROJECT), PROJECT, "demo-project"],
      [idOf(OTHER_PROJECT, OTHER_SESSION_ID), OTHER_PROJECT, "other-project"],
    ]);
    expect(health.parts).toEqual({
      [projectPrefix(PROJECT)]: BASIS,
      [projectPrefix(OTHER_PROJECT)]: BASIS,
    });
  });

  test("a copied folder's database, with the same ids, shows both", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const { sessions } = await crushAdapterFor(files, standInSqlite([printedRow()])).poll();
    expect(new Set(sessions.map(({ id }) => id)).size).toBe(2);
  });
});

describe("its status", () => {
  test("is unknown while a Crush program runs, even one in another project", async () => {
    const adapter = crushAdapterFor(crushFiles(), standInSqlite([printedRow()]));
    const { sessions } = await adapter.poll();
    expect(sessions[0]).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("is finished once none runs, since Crush last wrote it", async () => {
    const adapter = crushAdapterFor(crushFiles(), standInSqlite([printedRow()]), {
      processes: standInProcesses({ ok: true, running: false }),
    });
    const { sessions, basis, health } = await adapter.poll();
    expect(sessions[0]).toMatchObject({
      status: "finished",
      statusSince: seconds(NOW - MINUTE) * SECOND,
    });
    expect(basis).toBe(BASIS_CLOSED);
    expect(health.detail).toBe(
      `${READ_DETAIL} No Crush program runs, so each session shows as finished.`,
    );
    expect(health.parts).toEqual({ [projectPrefix(PROJECT)]: BASIS_CLOSED });
  });

  test("is unknown, never finished, while ps cannot say, and the card says so", async () => {
    const adapter = crushAdapterFor(crushFiles(), standInSqlite([printedRow()]), {
      processes: standInProcesses({ ok: false }),
    });
    const { sessions, basis, health } = await adapter.poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(health.detail).toBe(
      `${READ_DETAIL} ps could not be run to tell whether Crush runs, so no session is shown as finished.`,
    );
    expect(health.parts).toEqual({ [projectPrefix(PROJECT)]: BASIS_WITHOUT_PROCESSES });
  });

  test("on a system where ps is not run, the card says it cannot tell", async () => {
    const adapter = crushAdapterFor(crushFiles(), standInSqlite([printedRow()]), {
      platform: "freebsd",
      processes: standInProcesses({ ok: false }),
    });
    const { health } = await adapter.poll();
    expect(health.detail).toContain(
      "Agent Lookout cannot tell on this system whether Crush runs, so no session is shown as finished.",
    );
    expect(health.watching).toContainEqual({
      label: "Process check run",
      value: "not run on this system",
    });
  });

  test("a crash leaves a session as a quit does: unknown while another Crush runs, finished once none does", async () => {
    const files = crushFiles();
    files.write(WAL, "frames a crash left");
    files.write(SHM, "index a crash left");
    const processes = standInProcesses({ ok: true, running: true });
    const clock = handClock();
    const adapter = crushAdapterFor(files, standInSqlite([printedRow()]), {
      processes,
      now: clock.now,
    });
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    processes.set({ ok: true, running: false });
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("is never working, idle or needing you, whatever a row holds", async () => {
    const adapter = crushAdapterFor(
      crushFiles(),
      standInSqlite([printedRow({ status: "working", finished_at: null, waiting: true })]),
    );
    const { sessions } = await adapter.poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(sessions[0]).not.toHaveProperty("waitingReason");
  });
});

describe("asking ps", () => {
  test("not at all while there is no session to show", async () => {
    const processes = standInProcesses();
    const adapter = crushAdapterFor(crushFiles(), standInSqlite(), { processes });
    await adapter.poll();
    expect(processes.asked.count).toBe(0);
  });

  test("at most every 10 seconds while a Crush runs", async () => {
    const processes = standInProcesses();
    const clock = handClock();
    const adapter = crushAdapterFor(crushFiles(), standInSqlite([printedRow()]), {
      processes,
      now: clock.now,
    });
    await adapter.poll();
    clock.advance(PROCESS_CHECK_MS - 1);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(1);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test("sooner when a session is written after it said none runs, though not within 2 seconds", async () => {
    const files = crushFiles();
    const processes = standInProcesses({ ok: true, running: false });
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    const adapter = crushAdapterFor(files, sqlite, { processes, now: clock.now });
    await adapter.poll();
    expect(processes.asked.count).toBe(1);

    clock.advance(PROMPT_PROCESS_CHECK_MS - 1);
    sqlite.set([printedRow({ updated_at: seconds(clock.now()) })]);
    files.write(DATABASE, "changed");
    await adapter.poll();
    expect(processes.asked.count).toBe(1);

    clock.advance(1);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test("a clock set back asks again", async () => {
    const processes = standInProcesses();
    const clock = handClock();
    const adapter = crushAdapterFor(crushFiles(), standInSqlite([printedRow()]), {
      processes,
      now: clock.now,
    });
    await adapter.poll();
    clock.advance(-1);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test.each([
    ["a Crush runs", { ok: true, running: true }],
    ["it could not say", { ok: false }],
  ] as const)("no sooner when a session is written after it said %s", async (_name, said) => {
    const files = crushFiles();
    const processes = standInProcesses(said);
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    const adapter = crushAdapterFor(files, sqlite, { processes, now: clock.now });
    await adapter.poll();
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    sqlite.set([printedRow({ updated_at: seconds(clock.now()) })]);
    files.write(DATABASE, "changed");
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
  });

  test("no sooner while nothing is written after it said none runs", async () => {
    const processes = standInProcesses({ ok: true, running: false });
    const clock = handClock();
    const adapter = crushAdapterFor(crushFiles(), standInSqlite([printedRow()]), {
      processes,
      now: clock.now,
    });
    await adapter.poll();
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
  });

  test("sooner for a session written in the same second as the ask, which counts as after it", async () => {
    const processes = standInProcesses({ ok: true, running: false });
    const clock = handClock();
    const adapter = crushAdapterFor(
      crushFiles(),
      standInSqlite([printedRow({ updated_at: seconds(NOW) })]),
      { processes, now: clock.now },
    );
    await adapter.poll();
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });
});

describe("the list of projects", () => {
  test("a link at its name is not followed, and the card says so", async () => {
    const files = memoryFiles();
    files.special(PROJECT_LIST);
    const sqlite = standInSqlite();
    const { health, sessions } = await crushAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      `Crush's list of projects, ${SHOWN_LIST}, was not read: a link or something other than an ordinary file is in its place, or in place of its folder.`,
    );
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("over 1 MiB is not read, and the card says so", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, "x".repeat(MAX_LIST_BYTES + 1));
    const { health, sessions } = await crushAdapterFor(files, standInSqlite()).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      `Crush's list of projects, ${SHOWN_LIST}, is over 1 MiB, so it was not read and no Crush sessions are listed.`,
    );
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("laid out some other way is not taken for a list, and the card says so", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, '{"projects":"not a list"}');
    const { health } = await crushAdapterFor(files, standInSqlite()).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      `Crush's list of projects, ${SHOWN_LIST}, could not be read, or is not laid out as Crush lays it out, so no Crush sessions are listed.`,
    );
  });

  test("with no projects in it is an answer", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson([]));
    const { health, sessions } = await crushAdapterFor(files, standInSqlite()).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `No project in Crush's list, ${SHOWN_LIST}, holds a database yet. ${NOTES}`,
    );
    expect(health.watching).toContainEqual({ label: "Projects", value: "none found" });
    expect(sessions).toEqual([]);
  });

  test("an entry that names a relative path opens no folder", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson(["../demo-project", "code/demo-project"]));
    files.write("/code/demo-project/.crush/crush.db", "database");
    const sqlite = standInSqlite([printedRow()]);
    files.forget();
    const { sessions } = await crushAdapterFor(files, sqlite).poll();
    expect(sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
    expect(files.calls.map(({ path: target }) => target)).not.toContain(
      "/code/demo-project/.crush/crush.db",
    );
  });

  test("an entry that names a way out of a folder opens no folder", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson([`${PROJECT}/../../secret`]));
    const sqlite = standInSqlite([printedRow()]);
    expect((await crushAdapterFor(files, sqlite).poll()).sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("data_dir is never followed: only .crush in the listed folder is read", async () => {
    const files = memoryFiles();
    files.write(
      PROJECT_LIST,
      JSON.stringify({ projects: [{ path: PROJECT, data_dir: "/somewhere/else" }] }),
    );
    files.write("/somewhere/else/crush.db", "database");
    const sqlite = standInSqlite([printedRow()]);
    files.forget();
    expect((await crushAdapterFor(files, sqlite).poll()).sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
    expect(files.calls.filter(({ path: target }) => target.startsWith("/somewhere"))).toEqual([]);
  });

  test("no more than the newest 20 projects are looked at", async () => {
    const folders = Array.from({ length: MAX_PROJECTS + 5 }, (_, n) => `${HOME}/code/project-${n}`);
    const files = crushFiles(folders);
    const sqlite = standInSqlite();
    const { health } = await crushAdapterFor(files, sqlite).poll();
    expect(health.watching).toContainEqual({ label: "Projects", value: String(MAX_PROJECTS) });
    expect(sqlite.runs).toHaveLength(MAX_PROJECTS);
    expect(new Set(sqlite.runs.map(databaseIn))).not.toContain(`${folders.at(-1)}/.crush/crush.db`);
    expect(Object.keys(health.parts ?? {})).toHaveLength(MAX_PROJECTS);
  });

  test("a project dropped from it drops its reader, and comes back read afresh", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const sqlite = standInSqlite([printedRow()]);
    const adapter = crushAdapterFor(files, sqlite);
    expect((await adapter.poll()).sessions).toHaveLength(2);
    files.write(PROJECT_LIST, projectListJson([PROJECT]));
    expect((await adapter.poll()).sessions).toHaveLength(1);
    const runs = sqlite.runs.length;
    files.write(PROJECT_LIST, projectListJson([PROJECT, OTHER_PROJECT]));
    expect((await adapter.poll()).sessions).toHaveLength(2);
    expect(sqlite.runs).toHaveLength(runs + 1);
  });

  test("a list that goes and comes back is read afresh", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite([printedRow()]);
    const adapter = crushAdapterFor(files, sqlite);
    await adapter.poll();
    const runs = sqlite.runs.length;
    files.remove(PROJECT_LIST);
    await adapter.poll();
    files.write(PROJECT_LIST, projectListJson());
    await adapter.poll();
    expect(sqlite.runs).toHaveLength(runs + 1);
  });

  test("a list that goes keeps no last read, so a poll that reaches nothing after it is still looking", async () => {
    const files = crushFiles();
    let at = NOW;
    let step = 0;
    const now = () => {
      at += step;
      return at;
    };
    const adapter = crushAdapterFor(files, standInSqlite([printedRow()]), { now });
    await adapter.poll();
    files.remove(PROJECT_LIST);
    await adapter.poll();
    files.write(PROJECT_LIST, projectListJson());
    step = READ_BUDGET_MS;
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("searching");
    expect(sessions).toEqual([]);
  });

  test("a list that goes keeps no place to start from", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    sqlite.beforeEach(() => clock.advance(READ_BUDGET_MS));
    const adapter = crushAdapterFor(files, sqlite, { now: clock.now });
    await adapter.poll();
    expect(databaseIn(sqlite.runs[0] ?? [])).toBe(DATABASE);
    files.remove(PROJECT_LIST);
    await adapter.poll();
    files.write(PROJECT_LIST, projectListJson([PROJECT, OTHER_PROJECT]));
    const before = sqlite.runs.length;
    await adapter.poll();
    expect(databaseIn(sqlite.runs[before] ?? [])).toBe(DATABASE);
  });

  test("opens no file but itself", async () => {
    const files = crushFiles();
    files.write(`${DATA_DIR}/crush.json`, PRIVATE_WORDS);
    files.write(`${DATA_FOLDER}/crush.json`, PRIVATE_WORDS);
    files.write(`${DATA_FOLDER}/logs/crush.log`, PRIVATE_WORDS);
    files.write(`${DATA_FOLDER}/crush.lock`, '{"pid":41001}');
    await crushAdapterFor(files, standInSqlite([printedRow()])).poll();
    expect(files.opened()).toEqual([PROJECT_LIST]);
    expect(files.count("readdir")).toBe(0);
  });
});

describe("a project", () => {
  test("that has gone is nothing to read: no error, no sqlite3 and no session", async () => {
    const files = crushFiles();
    files.remove(PROJECT);
    const sqlite = standInSqlite([printedRow()]);
    const { health, sessions } = await crushAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `No project in Crush's list, ${SHOWN_LIST}, holds a database yet. ${NOTES}`,
    );
    expect(health.parts).toEqual({ [projectPrefix(PROJECT)]: BASIS });
    expect(sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("gone beside one that is there leaves that one read", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    files.remove(OTHER_PROJECT);
    const { health, sessions } = await crushAdapterFor(files, standInSqlite([printedRow()])).poll();
    expect(health.detail).toBe(READ_DETAIL);
    expect(sessions.map(({ cwd }) => cwd)).toEqual([PROJECT]);
  });

  test("reached by a link is not read, and the card says so", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    files.special(PROJECT);
    const sqlite = standInSqlite([printedRow()]);
    const { health, sessions } = await crushAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      "No Crush project could be read. Not read: demo-project, because a link or something other than an ordinary file is in place of the folder, its .crush or a file of its database, or its -wal file holds something but has no -shm file beside it.",
    );
    expect(sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("with a link beside one that is read leaves that one, and is named on the card", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    files.remove(OTHER_DATABASE);
    files.special(OTHER_DATABASE);
    const { health, sessions } = await crushAdapterFor(files, standInSqlite([printedRow()])).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain("Not read: other-project, because a link");
    expect(health.parts).toEqual({ [projectPrefix(PROJECT)]: BASIS });
    expect(sessions).toHaveLength(1);
  });

  test("whose database cannot be read on one poll leaves its sessions as they were, for the poller", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const sqlite = standInSqlite([printedRow()]);
    const clock = handClock();
    const adapter = crushAdapterFor(files, sqlite, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(2);

    sqlite.failFor(OTHER_DATABASE);
    files.write(OTHER_DATABASE, "changed");
    const { health, sessions } = await adapter.poll();
    expect(sessions.map(({ cwd }) => cwd)).toEqual([PROJECT]);
    // A part not named keeps its last answer, so these are not taken to have ended.
    expect(health.parts).toEqual({ [projectPrefix(PROJECT)]: BASIS });
    expect(health.detail).toContain(
      `Not read: other-project, because sqlite3 could not read its database, which is tried again when it changes, or ${RETRY_MS / 1000} seconds on.`,
    );
  });

  test("that cannot be looked at leaves its sessions as they were, and is named on the card", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const adapter = crushAdapterFor(files, standInSqlite([printedRow()]));
    expect((await adapter.poll()).sessions).toHaveLength(2);

    files.fail(`${OTHER_PROJECT}/.crush`);
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(sessions.map(({ cwd }) => cwd)).toEqual([PROJECT]);
    // A part not named keeps its last answer, so these are not taken to have ended.
    expect(health.parts).toEqual({ [projectPrefix(PROJECT)]: BASIS });
    expect(health.detail).toBe(
      `${READ_DETAIL} Not read: other-project, because its folder, its .crush or a file of its database could not be looked at.`,
    );
  });

  test("that cannot be looked at, as the only one, is an error and not a list with no database", async () => {
    const files = crushFiles();
    files.fail(DATA_FOLDER);
    const { health, sessions } = await crushAdapterFor(files, standInSqlite()).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      "No Crush project could be read. Not read: demo-project, because its folder, its .crush or a file of its database could not be looked at.",
    );
    expect(sessions).toEqual([]);
  });

  test("not read reaches an MCP answer by its folder's name, never its whole path", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const sqlite = standInSqlite();
    sqlite.fail("both");
    const { health } = await crushAdapterFor(files, sqlite).poll();
    const { sources } = sourceList({ sources: [health], sessions: [] }, NOW);
    expect(sources[0]?.detail).toContain("Not read: demo-project, other-project, because");
    expect(sources[0]?.detail).not.toContain("code/");
    expect(sources[0]?.detail).not.toContain(HOME);
  });

  test("laid out another way is named on the card", async () => {
    const files = crushFiles();
    const sqlite = standInSqlite();
    sqlite.fail("question");
    sqlite.setProbe(probeJson(["updated_at"]));
    const { health } = await crushAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      "No Crush project could be read. Not read: demo-project, because its database is laid out in a way Agent Lookout does not read.",
    );
    expect(health).not.toHaveProperty("advice");
  });

  test("broken, with others broken the same way, is one sentence", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const sqlite = standInSqlite();
    sqlite.fail("both");
    const { health } = await crushAdapterFor(files, sqlite).poll();
    expect(health.detail).toBe(
      `No Crush project could be read. Not read: demo-project, other-project, because sqlite3 could not read its database, which is tried again when it changes, or ${RETRY_MS / 1000} seconds on.`,
    );
  });
});

describe("no sqlite3", () => {
  test("on Linux is a card that says so, with what to install", async () => {
    const sqlite = standInSqlite();
    sqlite.gone();
    const { health, sessions } = await crushAdapterFor(crushFiles(), sqlite, {
      platform: "linux",
    }).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      "No Crush project could be read. Not read: demo-project, because no sqlite3 program was found.",
    );
    expect(health.advice).toBe(NO_SQLITE_ADVICE);
    expect(sessions).toEqual([]);
  });

  test("on a Mac is the same card, with no advice", async () => {
    const sqlite = standInSqlite();
    sqlite.gone();
    const { health } = await crushAdapterFor(crushFiles(), sqlite).poll();
    expect(health.state).toBe("error");
    expect(health).not.toHaveProperty("advice");
  });

  test("on Linux, beside a database too old to ask, still says what to install", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    files.write(OTHER_DATABASE, "database", { mtimeMs: NOW - 2 * DAY });
    const sqlite = standInSqlite();
    sqlite.gone();
    const { health } = await crushAdapterFor(files, sqlite, { platform: "linux" }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain("no sqlite3 program was found");
    expect(health.advice).toBe(NO_SQLITE_ADVICE);
  });

  test("costs nothing while no database was written in two days", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    files.write(DATABASE, "database", { mtimeMs: NOW - 2 * DAY });
    const sqlite = standInSqlite();
    sqlite.gone();
    const { health } = await crushAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("ok");
    expect(sqlite.runs).toEqual([]);
  });
});

describe("the time for reading", () => {
  /** An adapter whose clock moves on by this much with each run of `sqlite3`. */
  function slow(eachRunMs: number, folders: readonly string[]) {
    const files = crushFiles(folders);
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    sqlite.beforeEach(() => clock.advance(eachRunMs));
    const adapter = crushAdapterFor(files, sqlite, { now: clock.now });
    return { adapter, sqlite, files };
  }

  test("no run starts once it is used, and what is left is read on the next poll", async () => {
    const folders = Array.from({ length: 4 }, (_, n) => `${HOME}/code/project-${n}`);
    const { adapter, sqlite } = slow(READ_BUDGET_MS, folders);
    const first = await adapter.poll();
    expect(sqlite.runs).toHaveLength(1);
    expect(first.health.state).toBe("ok");
    expect(first.sessions).toHaveLength(1);
    expect(Object.keys(first.health.parts ?? {})).toHaveLength(1);

    const second = await adapter.poll();
    expect(sqlite.runs).toHaveLength(2);
    expect(second.sessions).toHaveLength(2);
  });

  test("a read the time cuts short keeps its sessions, and the next poll starts with it", async () => {
    const files = crushFiles([PROJECT, OTHER_PROJECT]);
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    const adapter = crushAdapterFor(files, sqlite, { now: clock.now });
    await adapter.poll();
    files.write(DATABASE, "changed");
    files.write(OTHER_DATABASE, "changed");
    sqlite.failFor(OTHER_DATABASE);
    sqlite.beforeEach(() => clock.advance(READ_BUDGET_MS - SECOND));
    const { sessions, health } = await adapter.poll();
    expect(sessions.map(({ cwd }) => cwd)).toEqual([PROJECT, OTHER_PROJECT]);
    expect(Object.keys(health.parts ?? {})).toHaveLength(2);
    sqlite.failFor(OTHER_DATABASE, false);
    files.write(DATABASE, "changed again");
    const before = sqlite.runs.length;
    await adapter.poll();
    expect(databaseIn(sqlite.runs[before] ?? [])).toBe(OTHER_DATABASE);
  });

  test("a poll that reached nothing says it is still looking, not that there is nothing", async () => {
    const adapter = crushAdapterFor(crushFiles(), standInSqlite(), { readBudgetMs: 0 });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("searching");
    expect(health.detail).toBe(
      `The databases of the projects in ${SHOWN_LIST} are still being read.`,
    );
    expect(sessions).toEqual([]);
  });

  test("a database that takes the whole time does not keep the others from ever being read", async () => {
    const folders = [PROJECT, OTHER_PROJECT];
    const files = crushFiles(folders);
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    sqlite.failFor(DATABASE);
    sqlite.beforeEach(() => clock.advance(READ_BUDGET_MS));
    const adapter = crushAdapterFor(files, sqlite, { now: clock.now });
    await adapter.poll();
    await adapter.poll();
    await adapter.poll();
    expect(sqlite.runs.map(databaseIn)).toContain(OTHER_DATABASE);
  });

  test("a database written on every poll that takes all the time leaves the next project first", async () => {
    const folders = [0, 1, 2].map((n) => `${HOME}/code/project-${n}`);
    const databases = folders.map((folder) => `${folder}/.crush/crush.db`);
    const files = crushFiles(folders);
    const clock = handClock();
    const sqlite = standInSqlite([printedRow()]);
    sqlite.beforeEach(() => clock.advance(READ_BUDGET_MS));
    const adapter = crushAdapterFor(files, sqlite, { now: clock.now });
    for (let poll = 0; poll < 3; poll += 1) {
      for (const database of databases) files.write(database, `written ${poll}`);
      await adapter.poll();
    }
    expect(sqlite.runs.map(databaseIn)).toEqual(databases);
  });
});

test("poll never rejects: something unexpected is a sentence on the card", async () => {
  const files = crushFiles();
  const adapter = crushAdapterFor(files, standInSqlite(), {
    processes: standInProcesses(),
    now: (() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) throw new Error("No clock.");
        return NOW;
      };
    })(),
  });
  const { health, sessions } = await adapter.poll();
  expect(health.state).toBe("error");
  expect(health.detail).toBe("Something unexpected went wrong while reading Crush sessions.");
  expect(sessions).toEqual([]);
});
