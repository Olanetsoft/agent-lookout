import path from "node:path";

import { describe, expect, test } from "vitest";

import type { AdapterResult } from "@collector/adapters/adapter";
import { KILO_PROGRAMS } from "@collector/adapters/kilo-code/index";
import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  COMMAND_SHOWN,
  createMimoCodeAdapter,
  MIMO_CODE_CAPABILITIES,
  MIMO_CODE_PROFILE,
  MIMO_EXTRAS,
  MIMO_FAILED_ERRORS,
  MIMO_PROGRAMS,
  MIMO_SESSIONS_QUERY,
  MIMO_TOOLS,
  mimoCodeDatabaseFor,
  mimoCodeHomeFor,
  NEEDS_YOU_NOTE,
  NO_SQLITE_ADVICE,
  UNCHECKED_NOTE,
  UNKNOWN_MESSAGE_NOTE,
  WINDOWS_DETAIL,
} from "@collector/adapters/mimo-code/index";
import type { DatabaseReader } from "@collector/adapters/opencode/database";
import { RECHECK_MS } from "@collector/adapters/opencode/index";
import {
  createOpencodeProcessReader,
  OPENCODE_PROGRAMS,
  opencodeInTable,
} from "@collector/adapters/opencode/processes";
import { FAILED_ERRORS } from "@core/mapping/opencode/opencodeMapping";
import {
  answerRow,
  DATA_HOME,
  DATABASE,
  DAY,
  HOME,
  MINUTE,
  NOW,
  probeJson,
  sessionId,
} from "@tests/fixtures/mimo-code/mimoCode";
import {
  handClock,
  MIMO_PROBE_QUERY,
  memoryFiles,
  mimoCodeAdapterFor,
  standInMimoSqlite,
  standInProcesses,
  type MemoryFiles,
} from "@tests/support/adapters/mimo-code/mimoCodeAdapter";
import { asWritten } from "@tests/support/paths";

const A = sessionId("a1");
const B = sessionId("b2");
const C = sessionId("c3");
const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;
const NOTES = `${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

/** The rows Sources shows, for the default folder: no row of a last message, which is not read. */
function watching(
  read: string,
  commandRun = "when the database changes",
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no MiMo Code",
) {
  return [
    { label: "Data folder", value: "~/.local/share/mimocode" },
    { label: "Database", value: "~/.local/share/mimocode/mimocode.db" },
    { label: "Read", value: read },
    { label: "Command", value: COMMAND_SHOWN },
    { label: "Command run", value: commandRun },
    { label: "Process check", value: "ps -A -o comm=" },
    { label: "Process check run", value: processCheckRun },
  ];
}

/** MiMo Code's folder with its database, and the -wal and -shm it keeps beside it. */
function openMimo(rows: Record<string, unknown>[] = [answerRow({ id: A })]) {
  const files = memoryFiles();
  files.write(DATABASE, "database");
  files.write(WAL, "frames");
  files.write(SHM, "index");
  const sqlite = standInMimoSqlite(rows);
  return { files, sqlite };
}

describe("where it looks", () => {
  test("in ~/.local/share/mimocode, on macOS as on Linux, unless a setting names another place", () => {
    expect(asWritten(mimoCodeHomeFor({}, HOME))).toBe(DATA_HOME);
    expect(asWritten(mimoCodeHomeFor({ XDG_DATA_HOME: "/data" }, HOME))).toBe("/data/mimocode");
    // A relative one is not taken: MiMo Code would take it from where it was started.
    expect(asWritten(mimoCodeHomeFor({ XDG_DATA_HOME: "data" }, HOME))).toBe(DATA_HOME);
    expect(
      asWritten(
        mimoCodeHomeFor(
          { AGENT_LOOKOUT_MIMO_CODE_HOME: " /tmp/mimo ", MIMOCODE_HOME: "/x", XDG_DATA_HOME: "/d" },
          HOME,
        ),
      ),
    ).toBe("/tmp/mimo");
    // The settings of OpenCode and Kilo Code name their own folders.
    for (const env of [
      { AGENT_LOOKOUT_OPENCODE_HOME: "/tmp/oc" },
      { AGENT_LOOKOUT_KILO_HOME: "/tmp/kilo" },
    ]) {
      expect(asWritten(mimoCodeHomeFor(env, HOME)), JSON.stringify(env)).toBe(DATA_HOME);
    }
  });

  test("in data in MiMo Code's own MIMOCODE_HOME, ahead of XDG_DATA_HOME, when it is absolute", () => {
    expect(asWritten(mimoCodeHomeFor({ MIMOCODE_HOME: "/work/mimo" }, HOME))).toBe(
      "/work/mimo/data",
    );
    expect(
      asWritten(mimoCodeHomeFor({ MIMOCODE_HOME: "/work/mimo", XDG_DATA_HOME: "/data" }, HOME)),
    ).toBe("/work/mimo/data");
    // MiMo Code refuses one that is not absolute, and an empty one is none.
    for (const home of ["work/mimo", " /work/mimo", ""]) {
      expect(asWritten(mimoCodeHomeFor({ MIMOCODE_HOME: home }, HOME)), home).toBe(DATA_HOME);
    }
  });

  test("at mimocode.db, or where MiMo Code's own MIMOCODE_DB says, unless Agent Lookout's setting names a folder", () => {
    expect(asWritten(mimoCodeDatabaseFor({}, HOME) ?? "")).toBe(DATABASE);
    expect(
      asWritten(mimoCodeDatabaseFor({ MIMOCODE_DB: "/elsewhere/mimocode-local.db" }, HOME) ?? ""),
    ).toBe("/elsewhere/mimocode-local.db");
    // A channel's file, named as it is in the data folder.
    expect(asWritten(mimoCodeDatabaseFor({ MIMOCODE_DB: "mimocode-local.db" }, HOME) ?? "")).toBe(
      `${DATA_HOME}/mimocode-local.db`,
    );
    expect(
      asWritten(
        mimoCodeDatabaseFor({ MIMOCODE_DB: "other.db", MIMOCODE_HOME: "/work/mimo" }, HOME) ?? "",
      ),
    ).toBe("/work/mimo/data/other.db");
    expect(mimoCodeDatabaseFor({ MIMOCODE_DB: ":memory:" }, HOME)).toBeNull();
    expect(asWritten(mimoCodeDatabaseFor({ MIMOCODE_DB: "" }, HOME) ?? "")).toBe(DATABASE);
    expect(
      asWritten(
        mimoCodeDatabaseFor(
          { AGENT_LOOKOUT_MIMO_CODE_HOME: "/tmp/mimo", MIMOCODE_DB: ":memory:" },
          HOME,
        ) ?? "",
      ),
    ).toBe("/tmp/mimo/mimocode.db");
    // MiMo Code reads no OPENCODE_DB or KILO_DB, and neither does its adapter.
    for (const env of [{ OPENCODE_DB: "/elsewhere/oc.db" }, { KILO_DB: "/elsewhere/kilo.db" }]) {
      expect(asWritten(mimoCodeDatabaseFor(env, HOME) ?? ""), JSON.stringify(env)).toBe(DATABASE);
    }
  });
});

describe("a MiMo Code that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const sqlite = standInMimoSqlite();
    const adapter = mimoCodeAdapterFor(files, sqlite, { now: clock.now });
    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "mimo-code",
      label: "MiMo Code",
      state: "unavailable",
      detail:
        "MiMo Code was not found: there is no ~/.local/share/mimocode folder. Agent Lookout looks again every minute.",
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

  test("with its folder there and no mimocode.db, says it has not saved one yet", async () => {
    const files = memoryFiles();
    files.mkdir(DATA_HOME);
    const { health, basis } = await mimoCodeAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "ok",
      detail: `MiMo Code has not saved a database at ~/.local/share/mimocode/mimocode.db yet. ${NOTES}`,
      watching: watching("every 2 seconds"),
    });
    expect(basis).toBe(BASIS);
    expect(files.count("readdir")).toBe(0);
  });

  test("with Agent Lookout's setting, a folder with no database is an answer, not a missing MiMo Code", async () => {
    const files = memoryFiles();
    const env = { AGENT_LOOKOUT_MIMO_CODE_HOME: "/tmp/empty-mimo-code" };
    const { health, sessions } = await mimoCodeAdapterFor(files, standInMimoSqlite(), {
      env,
    }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_MIMO_CODE_HOME is set to ${path.resolve("/tmp/empty-mimo-code")}, which has no mimocode.db, so no MiMo Code sessions are listed. ${NOTES}`,
    );
    expect(sessions).toEqual([]);
    expect(files.count("stat")).toBe(0);
  });
});

describe("on Windows", () => {
  test("nothing is read, and MiMo Code is not found, with why", async () => {
    const { files, sqlite } = openMimo();
    files.forget();
    const adapter = mimoCodeAdapterFor(files, sqlite, { platform: "win32" });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toBe(WINDOWS_DETAIL);
    expect(health.watching?.find((fact) => fact.label === "Command run")?.value).toBe(
      "not run on Windows",
    );
    expect(health.watching?.find((fact) => fact.label === "Process check run")?.value).toBe(
      "not run on Windows",
    );
    expect(sessions).toEqual([]);
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });
});

describe("reading the sessions", () => {
  test("lists each root session as mimo-code's, with its name, folder, status and token counts", async () => {
    const { files, sqlite } = openMimo([
      answerRow({
        id: A,
        r_input: 200,
        r_output: 100,
        r_reasoning: 20,
        r_cache_read: 1800,
        r_cache_write: 400,
        r_total: 2520,
      }),
      answerRow({ id: B, title: "Write the notes", m_completed: null, m_finish: null }),
      // A title MiMo Code took from the prompt is never printed, so the folder names it.
      answerRow({ id: C, title: null }),
    ]);
    const adapter = mimoCodeAdapterFor(files, sqlite);
    const { health, sessions, basis } = await adapter.poll();
    expect(health).toEqual({
      id: "mimo-code",
      label: "MiMo Code",
      state: "ok",
      detail: `Sessions are read from MiMo Code's database, ~/.local/share/mimocode/mimocode.db, with sqlite3. ${NOTES}`,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(basis).toBe(BASIS);
    expect(
      sessions.map((session) => [session.id, session.source, session.name, session.status]),
    ).toEqual([
      [`mimo-code:${A}`, "mimo-code", "Rename the helper", "idle"],
      [`mimo-code:${B}`, "mimo-code", "Write the notes", "working"],
      [`mimo-code:${C}`, "mimo-code", "demo", "idle"],
    ]);
    expect(sessions[0]?.cwd).toBe("/Users/example/code/demo");
    expect(sessions[0]?.tokens).toEqual({ input: 2400, cached: 1800, output: 120 });
    expect(sessions[0]).not.toHaveProperty("tokensNotRead");
    expect(adapter.lookingIn).toBe(
      "Looking for MiMo Code sessions in ~/.local/share/mimocode/mimocode.db.",
    );
    expect(adapter.capabilities).toBe(MIMO_CODE_CAPABILITIES);
    // MiMo Code's own probe, then its own question of the sessions, read-only.
    expect(sqlite.runs.map((run) => run.args.at(-1))).toEqual([
      MIMO_PROBE_QUERY,
      MIMO_SESSIONS_QUERY,
    ]);
    expect(sqlite.queries()[0]?.args.at(-2)).toContain("readonly_shm=1");
  });

  test("a question or a plan to approve needs you, and a subagent at work keeps a session working", async () => {
    const D = sessionId("d4");
    const E = sessionId("e5");
    const { files, sqlite } = openMimo([
      // The main agent asks a question, while a subagent works.
      answerRow({
        id: A,
        m_completed: null,
        m_finish: null,
        m_tools: 1,
        m_asked_at: NOW - MINUTE,
        a_active_at: NOW - 10_000,
      }),
      // Its step ended the turn, and a subagent still works.
      answerRow({ id: B, a_active_at: NOW - 10_000 }),
      // A subagent pending, whose row has no time that could be right.
      answerRow({ id: C, a_active_at: 0 }),
      // The main agent's reply failed while a subagent worked.
      answerRow({ id: D, m_error: "StreamIncompleteError", a_active_at: NOW - 10_000 }),
      // Its step ended the turn, and no subagent is at work.
      answerRow({ id: E }),
    ]);
    const { sessions } = await mimoCodeAdapterFor(files, sqlite).poll();
    expect(sessions.map((session) => [session.id, session.status, session.waitingReason])).toEqual([
      [`mimo-code:${A}`, "needs-you", "question"],
      [`mimo-code:${B}`, "working", undefined],
      [`mimo-code:${C}`, "working", undefined],
      [`mimo-code:${D}`, "failed", undefined],
      [`mimo-code:${E}`, "idle", undefined],
    ]);
    expect(sessions[0]?.statusSince).toBe(NOW - MINUTE);
    // Working since the prompt that began the turn.
    expect(sessions[1]?.statusSince).toBe(NOW - 3 * MINUTE);
  });

  test("a subagent last written before ps showed no MiMo Code was left by a program that ended, and keeps nothing working", async () => {
    const { files, sqlite } = openMimo([answerRow({ id: A, a_active_at: NOW - 5 * MINUTE })]);
    const clock = handClock();
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = mimoCodeAdapterFor(files, sqlite, { processes, now: clock.now });
    expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual(["finished"]);

    // MiMo Code starts again, and the subagent's row has not been written since.
    processes.set({ ok: true, running: true });
    clock.advance(10_000);
    expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual(["idle"]);

    // One written since is at work.
    files.write(WAL, "more frames");
    sqlite.set([answerRow({ id: A, a_active_at: clock.now() - 1_000 })]);
    clock.advance(1_000);
    expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual(["working"]);
  });

  test("each of MiMo Code's own errors fails a reply, and the stop it records leaves the session idle", async () => {
    const own = ["InvalidOutputError", "StreamIncompleteError", "TextToolCallError", "ModelError"];
    const rows = [...MIMO_FAILED_ERRORS, "MessageAbortedError", "SomeNewError"].map((error, n) =>
      answerRow({ id: sessionId(`f${n}`), m_error: error }),
    );
    const { files, sqlite } = openMimo(rows);
    const { sessions, health } = await mimoCodeAdapterFor(files, sqlite).poll();
    expect(sessions.map((session) => session.status)).toEqual([
      ...MIMO_FAILED_ERRORS.map(() => "failed"),
      "idle",
      "unknown",
    ]);
    expect(health.detail).toContain(UNKNOWN_MESSAGE_NOTE);
    for (const error of own) {
      expect(MIMO_FAILED_ERRORS, error).toContain(error);
      expect(FAILED_ERRORS, error).not.toContain(error);
    }
    for (const error of FAILED_ERRORS) expect(MIMO_FAILED_ERRORS, error).toContain(error);
    expect(MIMO_FAILED_ERRORS).not.toContain("MessageAbortedError");
  });

  test("with no MiMo Code program running, each session is finished, unless it failed or cannot be read", async () => {
    const { files, sqlite } = openMimo([
      answerRow({ id: A, m_completed: null, m_finish: null, a_active_at: NOW }),
      answerRow({ id: B, m_error: "ContextOverflowError" }),
      answerRow({ id: C, m_role: "system" }),
    ]);
    const processes = standInProcesses({ ok: true, running: false });
    const { health, sessions, basis } = await mimoCodeAdapterFor(files, sqlite, {
      processes,
    }).poll();
    expect(basis).toBe(BASIS_CLOSED);
    expect(health.detail).toBe(
      `Sessions are read from MiMo Code's database, ~/.local/share/mimocode/mimocode.db, with sqlite3. ${NOTES} No MiMo Code program runs, so each session shows as finished, unless it failed or cannot be read. ${UNKNOWN_MESSAGE_NOTE}`,
    );
    expect(sessions.map((session) => session.status)).toEqual(["finished", "failed", "unknown"]);
  });

  test("while ps cannot say whether MiMo Code runs, no session is shown as finished, and the poll is named apart", async () => {
    const { files, sqlite } = openMimo([answerRow({ id: A })]);
    const processes = standInProcesses({ ok: false });
    const { health, sessions, basis } = await mimoCodeAdapterFor(files, sqlite, {
      processes,
    }).poll();
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(health.detail).toBe(
      `Sessions are read from MiMo Code's database, ~/.local/share/mimocode/mimocode.db, with sqlite3. ${NOTES} ps could not be run to tell whether MiMo Code runs, so no session is shown as finished.`,
    );
    expect(sessions.map((session) => session.status)).toEqual(["idle"]);
  });

  test("a database without what MiMo Code v0.1.17 writes, or with OpenCode 2's session_v2, is a version it does not read", async () => {
    for (const options of [
      { withV2: true },
      { noActors: true },
      { noAgentId: true },
      { noTitleSource: true },
    ]) {
      const { files, sqlite } = openMimo([answerRow({ id: A })]);
      sqlite.probe(probeJson(options));
      const processes = standInProcesses();
      const result = await mimoCodeAdapterFor(files, sqlite, { processes }).poll();
      expect(result.health, JSON.stringify(options)).toMatchObject({
        state: "error",
        detail:
          "MiMo Code's database, ~/.local/share/mimocode/mimocode.db, is laid out as a version of MiMo Code that Agent Lookout does not read.",
      });
      expect(result.sessions).toEqual([]);
      expect(result).not.toHaveProperty("basis");
      // The probe alone was asked.
      expect(sqlite.queries()).toEqual([]);
      expect(processes.asked()).toBe(0);
    }
  });

  test("MIMOCODE_DB=:memory: leaves nothing to read, and runs nothing", async () => {
    const { files, sqlite } = openMimo();
    const env = { MIMOCODE_DB: ":memory:" };
    const { health, sessions } = await mimoCodeAdapterFor(files, sqlite, { env }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `MIMOCODE_DB is set to :memory:, so MiMo Code keeps its sessions in memory, where Agent Lookout cannot read them. ${NOTES}`,
    );
    expect(health.watching?.find((fact) => fact.label === "Database")?.value).toBe(":memory:");
    expect(sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("MIMOCODE_DB names the database read, and MIMOCODE_HOME the folder", async () => {
    const files = memoryFiles();
    files.mkdir(DATA_HOME);
    files.write("/Users/example/mimo/mimocode-local.db", "database");
    const sqlite = standInMimoSqlite([answerRow({ id: A })]);
    const env = { MIMOCODE_DB: "/Users/example/mimo/mimocode-local.db" };
    const { sessions } = await mimoCodeAdapterFor(files, sqlite, { env }).poll();
    expect(sessions).toHaveLength(1);
    expect(sqlite.runs[0]?.args.at(-2)).toContain("/Users/example/mimo/mimocode-local.db?mode=ro");

    const home = memoryFiles();
    home.mkdir("/work/mimo/data");
    home.write("/work/mimo/data/mimocode.db", "database");
    const fromHome = standInMimoSqlite([answerRow({ id: A })]);
    const adapter = mimoCodeAdapterFor(home, fromHome, { env: { MIMOCODE_HOME: "/work/mimo" } });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    expect(fromHome.runs[0]?.args.at(-2)).toContain("/work/mimo/data/mimocode.db?mode=ro");
    expect(adapter.lookingIn).toBe(
      `Looking for MiMo Code sessions in ${path.resolve("/work/mimo/data/mimocode.db")}.`,
    );
  });

  test("a session not written for a day is left out, unless a subagent of it was", async () => {
    const old = {
      time_updated: NOW - DAY - MINUTE,
      m_updated: NOW - DAY - MINUTE,
      p_updated: NOW - DAY - MINUTE,
    };
    const { files, sqlite } = openMimo([
      answerRow({ id: A, ...old }),
      answerRow({ id: B, ...old, a_active_at: NOW - MINUTE }),
    ]);
    const { sessions } = await mimoCodeAdapterFor(files, sqlite).poll();
    expect(sessions.map((session) => [session.id, session.status])).toEqual([
      [`mimo-code:${B}`, "working"],
    ]);
  });
});

describe("what a session last said", () => {
  test("is not read: the adapter has no lastMessage, and its card says nothing of one", async () => {
    for (const env of [{}, { AGENT_LOOKOUT_LAST_MESSAGE: "off" }]) {
      const { files, sqlite } = openMimo();
      const adapter = mimoCodeAdapterFor(files, sqlite, { env });
      expect(adapter, JSON.stringify(env)).not.toHaveProperty("lastMessage");
      const { health, sessions } = await adapter.poll();
      expect(sessions).toHaveLength(1);
      expect(health.watching?.map((fact) => fact.label)).not.toContain("Last message read");
      // A poll asks its two questions, and nothing more.
      expect(sqlite.questions()).toEqual([]);
    }
    expect(MIMO_CODE_PROFILE.lastMessageRead).toBeNull();
  });
});

describe("what its question asks", () => {
  test("only the main agent's messages, the subagents' state, and a title a model wrote or the person set", () => {
    expect(MIMO_EXTRAS).toEqual({
      mainAgent: "main",
      actors: true,
      titleSources: ["generated", "user"],
    });
    expect(MIMO_TOOLS).toEqual({ asking: ["question", "plan_exit"], idle: [] });
    expect(MIMO_SESSIONS_QUERY.match(/agent_id = 'main'/g)).toHaveLength(5);
    expect(MIMO_SESSIONS_QUERY).toContain(
      "CASE WHEN s.title_source IN ('generated', 'user') THEN substr(s.title, 1, 1000) END AS title",
    );
    expect(MIMO_SESSIONS_QUERY).toContain(
      "FROM actor_registry a WHERE a.session_id = s.id AND a.status IN ('pending', 'running')) AS a_active_at,",
    );
    expect(MIMO_SESSIONS_QUERY).not.toContain("m_idle_call");
    expect(MIMO_PROBE_QUERY).toContain("pragma_table_info('actor_registry')");
    expect(MIMO_PROBE_QUERY).toContain("pragma_table_info('message')");
  });
});

describe("which programs are MiMo Code's", () => {
  const table = (lines: string[]) => `${lines.join("\n")}\n`;

  test("mimo, alone or at the end of a path", () => {
    expect([...MIMO_PROGRAMS]).toEqual(["mimo"]);
    for (const program of [
      "mimo",
      "/Users/example/.mimocode/bin/mimo",
      "/opt/homebrew/bin/mimo",
      "/Users/example/.npm-global/lib/node_modules/@mimo-ai/cli/vendor/mimo",
    ]) {
      expect(opencodeInTable(table(["/sbin/launchd", program]), MIMO_PROGRAMS), program).toBe(true);
    }
  });

  test("not npm's launcher, which runs as node, nor any of OpenCode's or Kilo Code's, nor theirs MiMo Code's", () => {
    for (const program of ["node", "mimo.js", "mimocode", "mimo-code", "mimocode.db", "/bin/mim"]) {
      expect(opencodeInTable(table([program]), MIMO_PROGRAMS), program).toBe(false);
    }
    for (const name of [...OPENCODE_PROGRAMS, ...KILO_PROGRAMS]) {
      expect(opencodeInTable(table([name]), MIMO_PROGRAMS), name).toBe(false);
    }
    for (const name of MIMO_PROGRAMS) {
      expect(opencodeInTable(table([name])), name).toBe(false);
      expect(opencodeInTable(table([name]), KILO_PROGRAMS), name).toBe(false);
    }
    expect(MIMO_CODE_PROFILE.programs).toBe(MIMO_PROGRAMS);
  });

  test("ps is asked for each program's name alone, and MiMo Code's name is looked for in it", async () => {
    const asked: (readonly string[])[] = [];
    const reader = createOpencodeProcessReader({
      platform: "linux",
      programs: MIMO_PROGRAMS,
      run: async (args) => (asked.push(args), { ok: true, stdout: table(["systemd", "mimo"]) }),
    });
    expect(await reader.read()).toEqual({ ok: true, running: true });
    expect(asked).toEqual([["-A", "-o", "comm="]]);
  });
});

describe("no sentence of its card names OpenCode", () => {
  /** Every card a poll can give, each from a database or a setting of its own. */
  async function everyCard(): Promise<AdapterResult[]> {
    const cards: AdapterResult[] = [];
    const poll = async (
      files: MemoryFiles,
      sqlite = standInMimoSqlite(),
      options: Parameters<typeof mimoCodeAdapterFor>[2] = {},
    ) => {
      cards.push(await mimoCodeAdapterFor(files, sqlite, options).poll());
    };
    // Not there, on Windows, in memory, and with no database, by either folder.
    await poll(memoryFiles());
    await poll(openMimo().files, undefined, { platform: "win32" });
    await poll(openMimo().files, undefined, { env: { MIMOCODE_DB: ":memory:" } });
    const folder = memoryFiles();
    folder.mkdir(DATA_HOME);
    await poll(folder);
    await poll(memoryFiles(), undefined, {
      env: { AGENT_LOOKOUT_MIMO_CODE_HOME: "/tmp/empty-mimo-code" },
    });
    // Each way a database is not read.
    {
      const { files, sqlite } = openMimo();
      files.remove(SHM);
      await poll(files, sqlite);
    }
    {
      const { files, sqlite } = openMimo();
      files.fail(DATABASE);
      await poll(files, sqlite);
    }
    for (const platform of ["darwin", "linux"] as const) {
      const { files, sqlite } = openMimo();
      sqlite.there(false);
      await poll(files, sqlite, { platform });
    }
    {
      const { files, sqlite } = openMimo();
      sqlite.fail();
      await poll(files, sqlite);
    }
    {
      const { files, sqlite } = openMimo();
      sqlite.probe(probeJson({ withV2: true }));
      await poll(files, sqlite);
    }
    // Read, with MiMo Code open, closed and not known, and with a session it does not know.
    for (const answer of [
      { ok: true, running: true },
      { ok: true, running: false },
      { ok: false },
    ] as const) {
      const { files, sqlite } = openMimo([
        answerRow({ id: A }),
        answerRow({ id: B, m_role: "system" }),
      ]);
      await poll(files, sqlite, { processes: standInProcesses(answer) });
      await poll(files, sqlite, { processes: standInProcesses(answer), platform: "freebsd" });
    }
    // A reader that throws.
    const throwing: DatabaseReader = {
      read: () => Promise.reject(new Error("A reader that throws.")),
      askOnce: () => Promise.reject(new Error("A reader that throws.")),
    };
    const files = memoryFiles();
    files.mkdir(DATA_HOME);
    cards.push(
      await createMimoCodeAdapter({
        env: {},
        homeDir: HOME,
        now: () => NOW,
        io: files.io,
        platform: "linux",
        reader: throwing,
      }).poll(),
    );
    return cards;
  }

  test("across every state a poll can give, its watching, its advice and its sessions", async () => {
    const cards = await everyCard();
    const states = new Set(cards.map((card) => card.health.state));
    expect(states).toEqual(new Set(["unavailable", "ok", "error"]));
    const details = new Set(cards.map((card) => card.health.detail));
    // Every sentence above is a card of its own.
    expect(details.size).toBeGreaterThanOrEqual(14);
    for (const card of cards) {
      const said = JSON.stringify(card);
      expect(said, card.health.detail).not.toContain("OpenCode");
      expect(said, card.health.detail).not.toContain("opencode");
      expect(said, card.health.detail).not.toContain("Kilo");
      expect(said, card.health.detail).not.toContain("1.x");
      expect(card.health.id).toBe("mimo-code");
      expect(card.health.label).toBe("MiMo Code");
    }
    expect(cards.some((card) => card.health.advice === NO_SQLITE_ADVICE)).toBe(true);
    expect(
      cards.some(
        (card) =>
          card.health.detail ===
          "Something unexpected went wrong while reading MiMo Code sessions.",
      ),
    ).toBe(true);
  });

  test("nor its capabilities, its notes or where it says it looks", () => {
    const adapter = mimoCodeAdapterFor(memoryFiles());
    const words = JSON.stringify([
      adapter.capabilities,
      adapter.lookingIn,
      MIMO_CODE_PROFILE.notes,
      MIMO_CODE_PROFILE.label,
    ]);
    expect(words).not.toContain("OpenCode");
    expect(words).not.toContain("Kilo");
    expect(words).not.toContain("1.x");
    expect(UNCHECKED_NOTE).toContain("v0.1.17");
    for (const [name, cell] of Object.entries(MIMO_CODE_CAPABILITIES)) {
      if (cell.level === "yes") continue;
      const { reason } = cell;
      expect(reason.length, name).toBeLessThanOrEqual(130);
      expect(reason, name).toMatch(/^[A-Z].*\.$/);
      expect(reason, name).not.toContain("!");
    }
  });
});
