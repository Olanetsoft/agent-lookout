import path from "node:path";

import { describe, expect, test } from "vitest";

import type { AdapterResult } from "@collector/adapters/adapter";
import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  COMMAND_SHOWN,
  createKiloCodeAdapter,
  KILO_CODE_CAPABILITIES,
  KILO_CODE_PROFILE,
  KILO_PROGRAMS,
  KILO_SESSIONS_QUERY,
  kiloDatabaseFor,
  kiloHomeFor,
  LAST_MESSAGE_READ,
  NEEDS_YOU_NOTE,
  NO_DATABASE_NOTE,
  NO_SQLITE_ADVICE,
  UNCHECKED_NOTE,
  UNKNOWN_MESSAGE_NOTE,
  WINDOWS_DETAIL,
} from "@collector/adapters/kilo-code/index";
import {
  createDatabaseReader,
  QUESTION_OUTPUT_BYTES,
  type DatabaseReader,
} from "@collector/adapters/opencode/database";
import {
  createOpencodeProcessReader,
  OPENCODE_PROGRAMS,
  opencodeInTable,
} from "@collector/adapters/opencode/processes";
import { RECHECK_MS } from "@collector/adapters/opencode/index";
import { lastTextQuery } from "@collector/adapters/opencode/lastMessages";
import { PROBE_QUERY, sqliteArguments } from "@collector/adapters/opencode/sessionRows";
import { createTailLimits } from "@collector/messages/tailReader";
import {
  answerRow,
  DATA_HOME,
  DATABASE,
  DAY,
  HOME,
  lastTextJson,
  MINUTE,
  NOW,
  probeJson,
  SECOND,
  sessionId,
} from "@tests/fixtures/kilo-code/kiloCode";
import {
  handClock,
  kiloCodeAdapterFor,
  memoryFiles,
  standInKiloSqlite,
  standInProcesses,
  type MemoryFiles,
} from "@tests/support/adapters/kilo-code/kiloCodeAdapter";
import { asWritten } from "@tests/support/paths";

const A = sessionId("a1");
const B = sessionId("b2");
const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;
const NOTES = `${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

/** The rows Sources shows, for the default folder. */
function watching(
  read: string,
  commandRun = "when the database changes",
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no Kilo Code",
  lastMessageRead = LAST_MESSAGE_READ,
) {
  return [
    { label: "Data folder", value: "~/.local/share/kilo" },
    { label: "Database", value: "~/.local/share/kilo/kilo.db" },
    { label: "Read", value: read },
    { label: "Command", value: COMMAND_SHOWN },
    { label: "Command run", value: commandRun },
    { label: "Process check", value: "ps -A -o comm=" },
    { label: "Process check run", value: processCheckRun },
    { label: "Last message read", value: lastMessageRead },
  ];
}

/** Kilo Code's folder with its database, and the -wal and -shm it keeps beside it. */
function openKilo(rows: Record<string, unknown>[] = [answerRow({ id: A })]) {
  const files = memoryFiles();
  files.write(DATABASE, "database");
  files.write(WAL, "frames");
  files.write(SHM, "index");
  const sqlite = standInKiloSqlite(rows);
  return { files, sqlite };
}

describe("where it looks", () => {
  test("in ~/.local/share/kilo, on macOS as on Linux, unless a setting names another place", () => {
    expect(asWritten(kiloHomeFor({}, HOME))).toBe(DATA_HOME);
    expect(asWritten(kiloHomeFor({ XDG_DATA_HOME: "/data" }, HOME))).toBe("/data/kilo");
    // A relative one is not taken: Kilo Code would take it from where it was started.
    expect(asWritten(kiloHomeFor({ XDG_DATA_HOME: "data" }, HOME))).toBe(DATA_HOME);
    expect(
      asWritten(
        kiloHomeFor({ AGENT_LOOKOUT_KILO_HOME: " /tmp/kilo ", XDG_DATA_HOME: "/data" }, HOME),
      ),
    ).toBe("/tmp/kilo");
    // OpenCode's settings name OpenCode's folder, not Kilo Code's.
    expect(asWritten(kiloHomeFor({ AGENT_LOOKOUT_OPENCODE_HOME: "/tmp/oc" }, HOME))).toBe(
      DATA_HOME,
    );
  });

  test("at kilo.db, or where Kilo Code's own KILO_DB says, unless Agent Lookout's setting names a folder", () => {
    expect(asWritten(kiloDatabaseFor({}, HOME) ?? "")).toBe(DATABASE);
    expect(asWritten(kiloDatabaseFor({ KILO_DB: "/elsewhere/kilo-rc.db" }, HOME) ?? "")).toBe(
      "/elsewhere/kilo-rc.db",
    );
    // A pre-release's or a build from source's file, named as it is in the data folder.
    expect(asWritten(kiloDatabaseFor({ KILO_DB: "kilo-rc.db" }, HOME) ?? "")).toBe(
      `${DATA_HOME}/kilo-rc.db`,
    );
    expect(kiloDatabaseFor({ KILO_DB: ":memory:" }, HOME)).toBeNull();
    expect(asWritten(kiloDatabaseFor({ KILO_DB: "" }, HOME) ?? "")).toBe(DATABASE);
    expect(
      asWritten(
        kiloDatabaseFor({ AGENT_LOOKOUT_KILO_HOME: "/tmp/kilo", KILO_DB: ":memory:" }, HOME) ?? "",
      ),
    ).toBe("/tmp/kilo/kilo.db");
    // Kilo Code reads no OPENCODE_DB, and neither does its adapter.
    expect(asWritten(kiloDatabaseFor({ OPENCODE_DB: "/elsewhere/oc.db" }, HOME) ?? "")).toBe(
      DATABASE,
    );
  });
});

describe("a Kilo Code that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const sqlite = standInKiloSqlite();
    const adapter = kiloCodeAdapterFor(files, sqlite, { now: clock.now });
    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "kilo-code",
      label: "Kilo Code",
      state: "unavailable",
      detail:
        "Kilo Code was not found: there is no ~/.local/share/kilo folder. Agent Lookout looks again every minute.",
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

  test("with its folder there and no kilo.db, says a pre-release or a build from source keeps another file", async () => {
    const files = memoryFiles();
    files.mkdir(DATA_HOME);
    const { health, basis } = await kiloCodeAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "ok",
      detail: `Kilo Code has not saved a database at ~/.local/share/kilo/kilo.db yet. ${NO_DATABASE_NOTE} ${NOTES}`,
      watching: watching("every 2 seconds"),
    });
    expect(basis).toBe(BASIS);
    expect(NO_DATABASE_NOTE).toBe(
      "A pre-release or a build from source keeps its sessions in another file, such as kilo-rc.db or kilo-local.db, which is read only when KILO_DB names it.",
    );
    // Nothing in the folder is listed for one.
    expect(files.count("readdir")).toBe(0);
  });

  test("with Agent Lookout's setting, a folder with no database is an answer, not a missing Kilo Code", async () => {
    const files = memoryFiles();
    const env = { AGENT_LOOKOUT_KILO_HOME: "/tmp/empty-kilo" };
    const { health, sessions } = await kiloCodeAdapterFor(files, standInKiloSqlite(), {
      env,
    }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_KILO_HOME is set to ${path.resolve("/tmp/empty-kilo")}, which has no kilo.db, so no Kilo Code sessions are listed. ${NOTES}`,
    );
    expect(sessions).toEqual([]);
    expect(files.count("stat")).toBe(0);
  });
});

describe("on Windows", () => {
  test("nothing is read, and Kilo Code is not found, with why", async () => {
    const { files, sqlite } = openKilo();
    files.forget();
    const adapter = kiloCodeAdapterFor(files, sqlite, { platform: "win32" });
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
  test("lists each root session as kilo-code's, with its name, folder, status and token counts", async () => {
    const { files, sqlite } = openKilo([
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
    ]);
    const adapter = kiloCodeAdapterFor(files, sqlite);
    const { health, sessions, basis } = await adapter.poll();
    expect(health).toEqual({
      id: "kilo-code",
      label: "Kilo Code",
      state: "ok",
      detail: `Sessions are read from Kilo Code's database, ~/.local/share/kilo/kilo.db, with sqlite3. ${NOTES}`,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(basis).toBe(BASIS);
    expect(
      sessions.map((session) => [session.id, session.source, session.name, session.status]),
    ).toEqual([
      [`kilo-code:${A}`, "kilo-code", "Rename the helper", "idle"],
      [`kilo-code:${B}`, "kilo-code", "Write the notes", "working"],
    ]);
    expect(sessions[0]?.cwd).toBe("/Users/example/code/demo");
    expect(sessions[0]?.tokens).toEqual({ input: 2400, cached: 1800, output: 120 });
    expect(sessions[0]).not.toHaveProperty("tokensNotRead");
    expect(adapter.lookingIn).toBe(
      "Looking for Kilo Code sessions in ~/.local/share/kilo/kilo.db.",
    );
    expect(adapter.capabilities).toBe(KILO_CODE_CAPABILITIES);
    // The probe, then Kilo Code's own question of the sessions, read-only.
    expect(sqlite.runs.map((run) => run.args.at(-1))).toEqual([PROBE_QUERY, KILO_SESSIONS_QUERY]);
    expect(sqlite.queries()[0]?.args.at(-2)).toContain("readonly_shm=1");
  });

  test("a step whose one call not over is a suggestion shows idle, as Kilo Code shows it, and a question needs you", async () => {
    const C = sessionId("c3");
    const { files, sqlite } = openKilo([
      // Kilo Code's `suggest` waits for you while Kilo Code shows the session idle.
      answerRow({ id: A, m_completed: null, m_finish: null, m_tools: 1, m_idle_call: 1 }),
      // A step with another call running goes on working.
      answerRow({ id: B, m_completed: null, m_finish: null, m_tools: 2, m_idle_call: 0 }),
      answerRow({
        id: C,
        m_completed: null,
        m_finish: null,
        m_tools: 1,
        m_asked_at: NOW - MINUTE,
      }),
    ]);
    const { sessions } = await kiloCodeAdapterFor(files, sqlite).poll();
    expect(sessions.map((session) => [session.id, session.status, session.waitingReason])).toEqual([
      [`kilo-code:${A}`, "idle", undefined],
      [`kilo-code:${B}`, "working", undefined],
      [`kilo-code:${C}`, "needs-you", "question"],
    ]);
    expect(sessions[2]?.statusSince).toBe(NOW - MINUTE);
  });

  test("with no Kilo Code program running, each session is finished, unless it failed or cannot be read", async () => {
    const { files, sqlite } = openKilo([
      answerRow({ id: A, m_completed: null, m_finish: null, m_idle_call: 1 }),
      answerRow({ id: B, m_error: "ContextOverflowError" }),
      answerRow({ id: sessionId("c3"), m_role: "system" }),
    ]);
    const processes = standInProcesses({ ok: true, running: false });
    const { health, sessions, basis } = await kiloCodeAdapterFor(files, sqlite, {
      processes,
    }).poll();
    expect(basis).toBe(BASIS_CLOSED);
    expect(health.detail).toBe(
      `Sessions are read from Kilo Code's database, ~/.local/share/kilo/kilo.db, with sqlite3. ${NOTES} No Kilo Code program runs, so each session shows as finished, unless it failed or cannot be read. ${UNKNOWN_MESSAGE_NOTE}`,
    );
    expect(sessions.map((session) => session.status)).toEqual(["finished", "failed", "unknown"]);
  });

  test("while ps cannot say whether Kilo Code runs, no session is shown as finished, and the poll is named apart", async () => {
    const { files, sqlite } = openKilo([answerRow({ id: A })]);
    const processes = standInProcesses({ ok: false });
    const { health, sessions, basis } = await kiloCodeAdapterFor(files, sqlite, {
      processes,
    }).poll();
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(health.detail).toBe(
      `Sessions are read from Kilo Code's database, ~/.local/share/kilo/kilo.db, with sqlite3. ${NOTES} ps could not be run to tell whether Kilo Code runs, so no session is shown as finished.`,
    );
    expect(sessions.map((session) => session.status)).toEqual(["idle"]);
  });

  test("a database with OpenCode 2's session_v2 is a version it does not read, and lists nothing", async () => {
    const { files, sqlite } = openKilo([answerRow({ id: A })]);
    sqlite.probe(probeJson(true));
    const processes = standInProcesses();
    const result = await kiloCodeAdapterFor(files, sqlite, { processes }).poll();
    expect(result.health).toMatchObject({
      state: "error",
      detail:
        "Kilo Code's database, ~/.local/share/kilo/kilo.db, is laid out as a version of Kilo Code that Agent Lookout does not read.",
    });
    expect(result.sessions).toEqual([]);
    expect(result).not.toHaveProperty("basis");
    // The probe alone was asked.
    expect(sqlite.queries()).toEqual([]);
    expect(processes.asked()).toBe(0);
  });

  test("KILO_DB=:memory: leaves nothing to read, and runs nothing", async () => {
    const { files, sqlite } = openKilo();
    const env = { KILO_DB: ":memory:" };
    const { health, sessions } = await kiloCodeAdapterFor(files, sqlite, { env }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `KILO_DB is set to :memory:, so Kilo Code keeps its sessions in memory, where Agent Lookout cannot read them. ${NOTES}`,
    );
    expect(health.watching?.find((fact) => fact.label === "Database")?.value).toBe(":memory:");
    expect(sessions).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("KILO_DB names the database read", async () => {
    const files = memoryFiles();
    files.mkdir(DATA_HOME);
    files.write("/Users/example/kilo/kilo-rc.db", "database");
    const sqlite = standInKiloSqlite([answerRow({ id: A })]);
    const env = { KILO_DB: "/Users/example/kilo/kilo-rc.db" };
    const { sessions } = await kiloCodeAdapterFor(files, sqlite, { env }).poll();
    expect(sessions).toHaveLength(1);
    expect(sqlite.runs[0]?.args.at(-2)).toContain("/Users/example/kilo/kilo-rc.db?mode=ro");
  });

  test("a session not written for a day is left out", async () => {
    const { files, sqlite } = openKilo([
      answerRow({
        id: A,
        time_updated: NOW - DAY - MINUTE,
        m_updated: NOW - DAY - MINUTE,
        p_updated: NOW - DAY - MINUTE,
      }),
    ]);
    expect((await kiloCodeAdapterFor(files, sqlite).poll()).sessions).toEqual([]);
  });
});

describe("what a session last said", () => {
  const SAID = `kilo-code:${A}`;

  /** An open Kilo Code with A and B listed, and sqlite3 ready to say what each last said. */
  function saying(options: Parameters<typeof kiloCodeAdapterFor>[2] = {}) {
    const clock = handClock(NOW);
    const { files, sqlite } = openKilo([answerRow({ id: A }), answerRow({ id: B })]);
    sqlite.said(A, lastTextJson(["The reply."]));
    sqlite.said(B, lastTextJson(["Another reply."]));
    const adapter = kiloCodeAdapterFor(files, sqlite, { now: clock.now, ...options });
    return { clock, files, sqlite, adapter };
  }

  test("is the newest reply's text for a listed session, asked with OpenCode's question only when asked", async () => {
    const { adapter, files, sqlite } = saying();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(sqlite.runs).toEqual([]);
    await adapter.poll();
    expect(sqlite.questions()).toEqual([]);
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
    expect(sqlite.questions()).toEqual([
      {
        binary: "/usr/bin/sqlite3",
        args: sqliteArguments(path.resolve(DATABASE), "with-wal", lastTextQuery(A) ?? ""),
        // The poll's own timeout, and at most 256 KB of what is printed.
        timeoutMs: undefined,
        maxOutputBytes: QUESTION_OUTPUT_BYTES,
      },
    ]);
    expect(QUESTION_OUTPUT_BYTES).toBe(256 * 1024);

    // Another session's, or another agent's of the same id, is never asked.
    files.forget();
    const before = sqlite.runs.length;
    await expect(adapter.lastMessage(`kilo-code:${sessionId("c3")}`)).resolves.toBeNull();
    await expect(adapter.lastMessage(`opencode:${A}`)).resolves.toBeNull();
    await expect(adapter.lastMessage(`mimo-code:${A}`)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toHaveLength(before);
  });

  test("a poll asks the database what it asks with the reader off, and puts no message on a session", async () => {
    const on = saying();
    const off = saying({ env: { AGENT_LOOKOUT_LAST_MESSAGE: "off" } });
    const onResult = await on.adapter.poll();
    await off.adapter.poll();
    expect(on.sqlite.runs.length).toBeGreaterThan(0);
    expect(on.sqlite.runs).toEqual(off.sqlite.runs);
    expect(on.files.calls).toEqual(off.files.calls);
    expect(JSON.stringify(onResult.sessions)).not.toContain("The reply.");
    await on.adapter.lastMessage(SAID);
    // A poll after an ask asks no question either.
    on.clock.advance(SECOND);
    await on.adapter.poll();
    expect(on.sqlite.questions()).toHaveLength(1);
  });

  test("Sources says it asks for a session's newest reply while its details are open", async () => {
    const { adapter } = saying();
    expect((await adapter.poll()).health.watching).toContainEqual({
      label: "Last message read",
      value: "a Kilo Code session's newest reply, with sqlite3, while its details are open",
    });
    expect(LAST_MESSAGE_READ).toBe(
      "a Kilo Code session's newest reply, with sqlite3, while its details are open",
    );
    expect(KILO_CODE_PROFILE.lastMessageRead).toBe(LAST_MESSAGE_READ);
  });

  test.each([
    [{ AGENT_LOOKOUT_LAST_MESSAGE: "off" }, "AGENT_LOOKOUT_LAST_MESSAGE"],
    [{ AGENT_LOOKOUT_WAITING_TEXT: "off" }, "AGENT_LOOKOUT_WAITING_TEXT"],
  ])("with %j, is off by that setting, and nothing is asked for it", async (env, setting) => {
    const { adapter, files, sqlite } = saying({ env });
    const result = await adapter.poll();
    expect(result.health.watching).toContainEqual({ label: "Last message read", value: "Off" });
    files.forget();
    const before = sqlite.runs.length;
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: null,
      reason: "off",
      setting,
    });
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toHaveLength(before);
    expect(adapter.lastMessagesKept).toBe(0);
  });

  test("on Windows, Sources says it is not read there, and no session is listed to be read", async () => {
    const { adapter, sqlite } = saying({ platform: "win32" });
    const result = await adapter.poll();
    expect(result.health.watching).toContainEqual({
      label: "Last message read",
      value: "not read on Windows",
    });
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(sqlite.runs).toEqual([]);
  });

  test("with Kilo Code keeping its sessions in memory, nothing is listed, so nothing is asked", async () => {
    const { adapter, sqlite } = saying({ env: { KILO_DB: ":memory:" } });
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(sqlite.runs).toEqual([]);
  });

  test("a session shown as finished, with no Kilo Code program running, is still read until it leaves the list", async () => {
    const processes = standInProcesses({ ok: true, running: false });
    const { adapter, clock, sqlite } = saying({ processes });
    const closed = await adapter.poll();
    expect(closed.sessions.find((session) => session.id === SAID)?.status).toBe("finished");
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });

    // A day on, it has left the list, and nothing of it is kept or asked.
    clock.advance(DAY);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(adapter.lastMessagesKept).toBe(0);
    const before = sqlite.runs.length;
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(sqlite.runs).toHaveLength(before);
  });

  test("keeps none, and lets none be asked, after a poll that cannot read the database", async () => {
    const { adapter, clock, files, sqlite } = saying();
    await adapter.poll();
    await adapter.lastMessage(SAID);
    expect(adapter.lastMessagesKept).toBe(1);

    sqlite.fail();
    files.append(WAL, "more frames");
    clock.advance(SECOND);
    const failed = await adapter.poll();
    expect(failed.health.state).toBe("error");
    expect(failed.sessions).toEqual([]);
    expect(adapter.lastMessagesKept).toBe(0);
    const before = sqlite.runs.length;
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(sqlite.runs).toHaveLength(before);
  });

  test("is dropped, and nothing may be asked, after a poll that throws", async () => {
    const { files, sqlite } = openKilo([answerRow({ id: A })]);
    sqlite.said(A, lastTextJson(["The reply."]));
    const real = createDatabaseReader({
      file: DATABASE,
      io: files.io,
      platform: "darwin",
      run: sqlite.run,
      find: sqlite.find,
      v1Query: KILO_SESSIONS_QUERY,
      readsV2: false,
    });
    let broken = false;
    const reader: DatabaseReader = {
      read: (at) => (broken ? Promise.reject(new Error("A reader that throws.")) : real.read(at)),
      askOnce: (question, known) => real.askOnce(question, known),
    };
    const clock = handClock(NOW);
    const adapter = kiloCodeAdapterFor(files, sqlite, { reader, now: clock.now });
    await adapter.poll();
    await adapter.lastMessage(SAID);
    expect(adapter.lastMessagesKept).toBe(1);

    broken = true;
    clock.advance(SECOND);
    expect((await adapter.poll()).health.detail).toBe(
      "Something unexpected went wrong while reading Kilo Code sessions.",
    );
    expect(adapter.lastMessagesKept).toBe(0);
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
  });

  test("counts its asks against the limits the collector shares, and a poll counts none", async () => {
    const limits = createTailLimits();
    let asked = 0;
    const lastMessageLimits = {
      ...limits,
      mayRead(at: number) {
        asked += 1;
        return limits.mayRead(at);
      },
    };
    const { adapter } = saying({ lastMessageLimits });
    await adapter.poll();
    expect(asked).toBe(0);
    await adapter.lastMessage(SAID);
    expect(asked).toBe(1);
    await adapter.lastMessage(`kilo-code:${B}`);
    expect(asked).toBe(2);
  });

  test("of the database's three questions, a poll asks only its own two, and the details only the session's", async () => {
    const { adapter, sqlite } = saying();
    await adapter.poll();
    await adapter.lastMessage(SAID);
    await adapter.lastMessage(`kilo-code:${B}`);
    expect(sqlite.runs.map((run) => run.args.at(-1))).toEqual([
      PROBE_QUERY,
      KILO_SESSIONS_QUERY,
      lastTextQuery(A),
      lastTextQuery(B),
    ]);
  });
});

describe("which programs are Kilo Code's", () => {
  const table = (lines: string[]) => `${lines.join("\n")}\n`;

  test("kilo, npm's copy .kilo and Nix's .kilo-wrapped, alone or at the end of a path", () => {
    expect([...KILO_PROGRAMS]).toEqual(["kilo", ".kilo", ".kilo-wrapped"]);
    for (const program of [
      "kilo",
      ".kilo",
      ".kilo-wrapped",
      "/Users/example/.kilo/bin/kilo",
      "/opt/homebrew/Cellar/kilo/7.8.27/libexec/kilo",
      "/Users/example/.npm-global/lib/node_modules/@kilocode/cli/bin/.kilo",
    ]) {
      expect(opencodeInTable(table(["/sbin/launchd", program]), KILO_PROGRAMS), program).toBe(true);
    }
    for (const name of KILO_PROGRAMS) expect(name.length, name).toBeLessThanOrEqual(15);
  });

  test("not npm's kilocode, which runs as node, nor any of OpenCode's, nor theirs Kilo Code's", () => {
    for (const program of [
      "kilocode",
      "node",
      "kilo-code",
      "kilo.db",
      "opencode",
      "/usr/bin/kilos",
    ]) {
      expect(opencodeInTable(table([program]), KILO_PROGRAMS), program).toBe(false);
    }
    for (const name of OPENCODE_PROGRAMS) {
      expect(opencodeInTable(table([name]), KILO_PROGRAMS), name).toBe(false);
    }
    for (const name of KILO_PROGRAMS) {
      expect(opencodeInTable(table([name])), name).toBe(false);
    }
    expect(KILO_CODE_PROFILE.programs).toBe(KILO_PROGRAMS);
  });

  test("ps is asked for each program's name alone, and Kilo Code's names are looked for in it", async () => {
    const asked: (readonly string[])[] = [];
    const reader = createOpencodeProcessReader({
      platform: "linux",
      programs: KILO_PROGRAMS,
      run: async (args) => (asked.push(args), { ok: true, stdout: table(["systemd", ".kilo"]) }),
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
      sqlite = standInKiloSqlite(),
      options: Parameters<typeof kiloCodeAdapterFor>[2] = {},
    ) => {
      cards.push(await kiloCodeAdapterFor(files, sqlite, options).poll());
    };
    // Not there, on Windows, in memory, and with no database, by either folder.
    await poll(memoryFiles());
    await poll(openKilo().files, undefined, { platform: "win32" });
    await poll(openKilo().files, undefined, { env: { KILO_DB: ":memory:" } });
    const folder = memoryFiles();
    folder.mkdir(DATA_HOME);
    await poll(folder);
    await poll(memoryFiles(), undefined, { env: { AGENT_LOOKOUT_KILO_HOME: "/tmp/empty-kilo" } });
    // Each way a database is not read.
    {
      const { files, sqlite } = openKilo();
      files.remove(SHM);
      await poll(files, sqlite);
    }
    {
      const { files, sqlite } = openKilo();
      files.fail(DATABASE);
      await poll(files, sqlite);
    }
    for (const platform of ["darwin", "linux"] as const) {
      const { files, sqlite } = openKilo();
      sqlite.there(false);
      await poll(files, sqlite, { platform });
    }
    {
      const { files, sqlite } = openKilo();
      sqlite.fail();
      await poll(files, sqlite);
    }
    {
      const { files, sqlite } = openKilo();
      sqlite.probe(probeJson(true));
      await poll(files, sqlite);
    }
    // Read, with Kilo Code open, closed and not known, and with a session it does not know.
    for (const answer of [
      { ok: true, running: true },
      { ok: true, running: false },
      { ok: false },
    ] as const) {
      const { files, sqlite } = openKilo([
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
      await createKiloCodeAdapter({
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
      expect(said, card.health.detail).not.toContain("1.x");
      expect(card.health.id).toBe("kilo-code");
      expect(card.health.label).toBe("Kilo Code");
    }
    expect(cards.some((card) => card.health.advice === NO_SQLITE_ADVICE)).toBe(true);
    expect(
      cards.some(
        (card) =>
          card.health.detail ===
          "Something unexpected went wrong while reading Kilo Code sessions.",
      ),
    ).toBe(true);
  });

  test("nor its capabilities, its notes or where it says it looks", () => {
    const adapter = kiloCodeAdapterFor(memoryFiles());
    const words = JSON.stringify([
      adapter.capabilities,
      adapter.lookingIn,
      KILO_CODE_PROFILE.notes,
      KILO_CODE_PROFILE.label,
    ]);
    expect(words).not.toContain("OpenCode");
    expect(words).not.toContain("1.x");
    expect(UNCHECKED_NOTE).toContain("v7.8.27");
    for (const [name, cell] of Object.entries(KILO_CODE_CAPABILITIES)) {
      if (cell.level === "yes") continue;
      const { reason } = cell;
      expect(reason.length, name).toBeLessThanOrEqual(130);
      expect(reason, name).toMatch(/^[A-Z].*\.$/);
      expect(reason, name).not.toContain("!");
    }
  });
});
