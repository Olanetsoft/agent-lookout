import path from "node:path";

import { describe, expect, test } from "vitest";

import type { AdapterResult } from "@collector/adapters/adapter";
import { createDatabaseReader, type DatabaseReader } from "@collector/adapters/opencode/database";
import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  COMMAND_SHOWN,
  createOpencodeAdapter,
  LAST_MESSAGE_READ,
  NEEDS_YOU_NOTE,
  NO_SQLITE_ADVICE,
  OPENCODE_2_SESSIONS_NOTE,
  OPENCODE_CAPABILITIES,
  opencodeDatabaseFor,
  opencodeHomeFor,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
  UNCHECKED_NOTE,
  UNKNOWN_MESSAGE_NOTE,
  WINDOWS_DETAIL,
} from "@collector/adapters/opencode/index";
import { lastTextQuery } from "@collector/adapters/opencode/lastMessages";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/opencode/sessionRows";
import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import { createTailLimits } from "@collector/messages/tailReader";
import { createPoller } from "@collector/poller";
import {
  EMPTY_CHANGE_MEMORY,
  sessionChanges,
  type ChangeMemory,
} from "@core/notices/sessionChanges";
import type { SessionsSnapshot } from "@core/sessions/session";
import {
  answerRow,
  answerV2Row,
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
  sqliteJson,
} from "@tests/fixtures/opencode/opencode";
import {
  handClock,
  memoryFiles,
  opencodeAdapterFor,
  standInProcesses,
  standInSqlite,
  type MemoryFiles,
} from "@tests/support/adapters/opencodeAdapter";
import { asWritten } from "@tests/support/paths";

const A = sessionId("a1");
const B = sessionId("b2");
const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;
const NOTES = `${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;
const NOT_LOOKED_AT_DETAIL =
  "OpenCode's database, ~/.local/share/opencode/opencode.db, was not read: a file of the database could not be looked at, so no OpenCode sessions are listed.";

/** The rows Sources shows, for the default folder. */
function watching(
  read: string,
  commandRun = "when the database changes",
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no OpenCode",
  lastMessageRead = LAST_MESSAGE_READ,
) {
  return [
    { label: "Data folder", value: "~/.local/share/opencode" },
    { label: "Database", value: "~/.local/share/opencode/opencode.db" },
    { label: "Read", value: read },
    { label: "Command", value: COMMAND_SHOWN },
    { label: "Command run", value: commandRun },
    { label: "Process check", value: "ps -A -o comm=" },
    { label: "Process check run", value: processCheckRun },
    { label: "Last message read", value: lastMessageRead },
  ];
}

/** OpenCode's folder with its database, and the -wal and -shm OpenCode keeps beside it, running or not. */
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
    expect(health.watching?.find((fact) => fact.label === "Process check run")?.value).toBe(
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

  test("with no OpenCode program running, each session is finished, unless it failed or cannot be read, though OpenCode left its -wal full", async () => {
    const { files, sqlite } = openOpencode([
      answerRow({ id: A, m_completed: null, m_finish: null }),
      answerRow({ id: B, m_error: "ContextOverflowError" }),
      answerRow({ id: sessionId("c3"), m_role: "system" }),
    ]);
    const processes = standInProcesses({ ok: true, running: false });
    const { health, sessions, basis } = await opencodeAdapterFor(files, sqlite, {
      processes,
    }).poll();
    expect(basis).toBe(BASIS_CLOSED);
    expect(health.detail).toBe(
      `Sessions are read from OpenCode's database, ~/.local/share/opencode/opencode.db, with sqlite3. ${NOTES} No OpenCode program runs, so each session shows as finished, unless it failed or cannot be read. ${UNKNOWN_MESSAGE_NOTE}`,
    );
    expect(sessions.map((session) => session.status)).toEqual(["finished", "failed", "unknown"]);
    // The -wal holds what OpenCode saved, so it was read with it.
    expect(sqlite.queries()[0]?.args.at(-2)).toContain("readonly_shm=1");
  });

  test("while ps cannot say whether OpenCode runs, no session is shown as finished, and the poll is named apart", async () => {
    const { files, sqlite } = openOpencode([answerRow({ id: A })]);
    files.remove(WAL);
    files.remove(SHM);
    for (const platform of ["darwin", "linux"] as const) {
      const processes = standInProcesses({ ok: false });
      const { health, sessions, basis } = await opencodeAdapterFor(files, sqlite, {
        platform,
        processes,
      }).poll();
      expect(basis, platform).toBe(BASIS_WITHOUT_PROCESSES);
      expect(health.detail, platform).toBe(
        `Sessions are read from OpenCode's database, ~/.local/share/opencode/opencode.db, with sqlite3. ${NOTES} ps could not be run to tell whether OpenCode runs, so no session is shown as finished.`,
      );
      expect(sessions.map((session) => session.status)).toEqual(["idle"]);
    }
  });

  test("ps is asked only while there is a session to show, at most every 10 seconds", async () => {
    const { files, sqlite } = openOpencode([]);
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now, processes });
    await adapter.poll();
    expect(processes.asked()).toBe(0);
    sqlite.set([answerRow({ id: A })]);
    files.append(WAL, "more");
    clock.advance(2_000);
    await adapter.poll();
    expect(processes.asked()).toBe(1);
    clock.advance(PROCESS_CHECK_MS - 1);
    await adapter.poll();
    expect(processes.asked()).toBe(1);
    clock.advance(1);
    await adapter.poll();
    expect(processes.asked()).toBe(2);
    // A clock set back counts as time enough.
    clock.advance(-5_000);
    await adapter.poll();
    expect(processes.asked()).toBe(3);
    expect(PROCESS_CHECK_MS).toBe(10_000);
  });

  test("a session written after ps said no OpenCode runs stays finished, and ps is asked again soon, to see an OpenCode started since", async () => {
    const { files, sqlite } = openOpencode([answerRow({ id: A }), answerRow({ id: B })]);
    const clock = handClock();
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now, processes });
    const polled = async () => {
      const { basis, sessions } = await adapter.poll();
      return [basis, ...sessions.map((session) => session.status)];
    };
    /** B's newest step begins now, as OpenCode writes it. */
    const writeB = () => {
      sqlite.set([
        answerRow({ id: A }),
        answerRow({ id: B, m_completed: null, m_finish: null, m_updated: clock.now() }),
      ]);
      files.append(WAL, "more");
    };
    expect(await polled()).toEqual([BASIS_CLOSED, "finished", "finished"]);
    expect(processes.asked()).toBe(1);

    // A program ps does not take for OpenCode, as OpenCode 1.x's desktop app, writes B
    // a second later. B is not held open for it, so it does not flip to working
    // and back, with a Finished notice each time.
    clock.advance(1_000);
    writeB();
    expect(await polled()).toEqual([BASIS_CLOSED, "finished", "finished"]);
    expect(processes.asked()).toBe(1);
    // Two seconds after the last ask, ps is asked again, and still shows none.
    clock.advance(PROMPT_PROCESS_CHECK_MS - 1_000);
    expect(await polled()).toEqual([BASIS_CLOSED, "finished", "finished"]);
    expect(processes.asked()).toBe(2);
    // With nothing written since, it is not asked again before the 10 seconds.
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    expect(await polled()).toEqual([BASIS_CLOSED, "finished", "finished"]);
    expect(processes.asked()).toBe(2);

    // OpenCode is started, and B's newest step begins: ps, asked again at once, sees it.
    processes.set({ ok: true, running: true });
    writeB();
    expect(await polled()).toEqual([BASIS, "idle", "working"]);
    expect(processes.asked()).toBe(3);
    // While OpenCode runs, a write does not ask ps sooner than every 10 seconds.
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    writeB();
    await adapter.poll();
    expect(processes.asked()).toBe(3);
    expect(PROMPT_PROCESS_CHECK_MS).toBe(2_000);
  });

  test("says which waits show as needing you, and that a wait for a tool's approval shows as working", () => {
    expect(NEEDS_YOU_NOTE).toBe(
      "An OpenCode 1.x session shows as needing you while OpenCode asks you a question or to approve a plan. OpenCode does not record a wait for a tool's approval, so a session waiting for one shows as working.",
    );
  });

  test("says so when a session ends in a way it does not know", async () => {
    const { files, sqlite } = openOpencode([answerRow({ id: A, m_role: "system" })]);
    const { health, sessions } = await opencodeAdapterFor(files, sqlite).poll();
    expect(health.detail).toBe(
      `Sessions are read from OpenCode's database, ~/.local/share/opencode/opencode.db, with sqlite3. ${NOTES} ${UNKNOWN_MESSAGE_NOTE}`,
    );
    expect(sessions[0]?.status).toBe("unknown");
  });

  test("a database of OpenCode 2's alone lists its sessions, and says what differs for them", async () => {
    const { files, sqlite } = openOpencode([
      answerV2Row({ id: A, title: null }),
      answerV2Row({ id: B, time_suspended: NOW - MINUTE }),
    ]);
    sqlite.probe(probeJson("v2-only"));
    const { health, sessions } = await opencodeAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `Sessions are read from OpenCode's database, ~/.local/share/opencode/opencode.db, with sqlite3. ${NOTES} ${OPENCODE_2_SESSIONS_NOTE}`,
    );
    expect(sessions.map((session) => [session.id, session.name, session.status])).toEqual([
      [`opencode:${A}`, "demo-slug", "idle"],
      [`opencode:${B}`, "Rename the helper", "working"],
    ]);
    expect(OPENCODE_2_SESSIONS_NOTE).toBe(
      "OpenCode 2 keeps every question and approval in memory, so a session of its that waits for you shows as working. Its background service outlives its window, so its sessions show as idle, not finished, until that service stops. Their token counts and last message are not read.",
    );
  });

  test("OpenCode 2's table with no session of its listed says nothing of it", async () => {
    const { files, sqlite } = openOpencode([answerRow({ id: A })]);
    sqlite.probe(probeJson("v1+v2"));
    const { health, sessions } = await opencodeAdapterFor(files, sqlite).poll();
    expect(health.detail).not.toContain("OpenCode 2");
    expect(sessions).toHaveLength(1);
  });

  test("a session of OpenCode 2's is finished once ps shows no OpenCode, and working again once it runs", async () => {
    const { files, sqlite } = openOpencode([answerV2Row({ id: A, time_suspended: NOW - MINUTE })]);
    sqlite.probe(probeJson("v2-only"));
    const processes = standInProcesses({ ok: true, running: false });
    const clock = handClock(NOW);
    const adapter = opencodeAdapterFor(files, sqlite, { processes, now: clock.now });
    const closed = await adapter.poll();
    expect(closed.sessions[0]?.status).toBe("finished");
    expect(closed.basis).toBe(BASIS_CLOSED);
    clock.advance(PROCESS_CHECK_MS);
    processes.set({ ok: true, running: true });
    const open = await adapter.poll();
    expect(open.sessions[0]?.status).toBe("working");
    expect(open.basis).toBe(BASIS);
  });

  test("a session of OpenCode 2's stays idle, not finished, while its service runs, and when ps cannot say", async () => {
    const { files, sqlite } = openOpencode([answerV2Row({ id: A })]);
    sqlite.probe(probeJson("v2-only"));
    const processes = standInProcesses({ ok: false });
    const adapter = opencodeAdapterFor(files, sqlite, { processes });
    const { sessions, basis } = await adapter.poll();
    expect(sessions[0]?.status).toBe("idle");
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
  });

  test("asks the last message of no session of OpenCode 2's", async () => {
    const { files, sqlite } = openOpencode([answerRow({ id: A }), answerV2Row({ id: B })]);
    sqlite.probe(probeJson("v1+v2"));
    sqlite.said(A, lastTextJson(["Done."]));
    sqlite.said(B, lastTextJson(["An older reply of 1.x's."]));
    const adapter = opencodeAdapterFor(files, sqlite);
    await adapter.poll();
    expect(await adapter.lastMessage(`opencode:${B}`)).toEqual({
      message: null,
      reason: "not-read",
    });
    expect(sqlite.questions()).toEqual([]);
    expect(await adapter.lastMessage(`opencode:${A}`)).toMatchObject({
      message: { text: "Done." },
    });
    expect(sqlite.questions()).toHaveLength(1);
  });

  test("keeps no reply of a session of 1.x once OpenCode 2 has copied it", async () => {
    const clock = handClock(NOW);
    const { files, sqlite } = openOpencode([answerRow({ id: A })]);
    sqlite.said(A, lastTextJson(["Done."]));
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now });
    await adapter.poll();
    await adapter.lastMessage(`opencode:${A}`);
    expect(adapter.lastMessagesKept).toBe(1);

    sqlite.probe(probeJson("v1+v2"));
    sqlite.set([answerV2Row({ id: A })]);
    files.append(WAL, "more");
    clock.advance(SECOND);
    await adapter.poll();
    expect(await adapter.lastMessage(`opencode:${A}`)).toMatchObject({ reason: "not-read" });
    expect(adapter.lastMessagesKept).toBe(0);
  });

  test("a session of OpenCode 2's stops being answered once a poll does not list it", async () => {
    const { files, sqlite } = openOpencode([answerV2Row({ id: B })]);
    sqlite.probe(probeJson("v2-only"));
    const adapter = opencodeAdapterFor(files, sqlite);
    await adapter.poll();
    expect(await adapter.lastMessage(`opencode:${B}`)).toMatchObject({ reason: "not-read" });
    files.remove(DATABASE);
    await adapter.poll();
    expect(await adapter.lastMessage(`opencode:${B}`)).toBeNull();
  });

  test("a session of OpenCode 2's is not answered after a poll that throws", async () => {
    const { files, sqlite } = openOpencode([answerV2Row({ id: B })]);
    sqlite.probe(probeJson("v2-only"));
    const real = createDatabaseReader({
      file: DATABASE,
      io: files.io,
      platform: "darwin",
      run: sqlite.run,
      find: sqlite.find,
    });
    let broken = false;
    const reader: DatabaseReader = {
      read: (at) => (broken ? Promise.reject(new Error("A reader that throws.")) : real.read(at)),
      askOnce: (question, known) => real.askOnce(question, known),
    };
    const clock = handClock(NOW);
    const adapter = opencodeAdapterFor(files, sqlite, { reader, now: clock.now });
    await adapter.poll();
    expect(await adapter.lastMessage(`opencode:${B}`)).toMatchObject({ reason: "not-read" });
    broken = true;
    clock.advance(SECOND);
    await adapter.poll();
    await expect(adapter.lastMessage(`opencode:${B}`)).resolves.toBeNull();
  });

  test("a session OpenCode 2 deleted stays out, though its old row of session is read again, until 1.x writes to it", async () => {
    const clock = handClock(NOW);
    const { files, sqlite } = openOpencode([answerV2Row({ id: B })]);
    sqlite.probe(probeJson("v1+v2"));
    sqlite.said(B, lastTextJson(["An older reply of 1.x's."]));
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now });
    const listed = async (from = adapter) =>
      (await from.poll()).sessions.map((session) => session.id);
    const id = `opencode:${B}`;
    expect(await listed()).toEqual([id]);

    // OpenCode 2's delete leaves the row of session, with what 1.x last wrote.
    sqlite.set([answerRow({ id: B })]);
    files.append(WAL, "more");
    clock.advance(SECOND);
    expect(await listed()).toEqual([]);
    expect(await adapter.lastMessage(id)).toBeNull();
    expect(sqlite.questions()).toEqual([]);

    // What was read is in memory alone, so a restart lists the row by 1.x's rules.
    const restarted = opencodeAdapterFor(files, sqlite, { now: clock.now });
    expect(await listed(restarted)).toEqual([id]);

    // A 1.x OpenCode that writes to it carries it on.
    sqlite.set([answerRow({ id: B, m_updated: clock.now() })]);
    files.append(WAL, "more");
    clock.advance(SECOND);
    expect(await listed()).toEqual([id]);
    expect(await adapter.lastMessage(id)).toMatchObject({
      message: { text: "An older reply of 1.x's." },
    });
  });

  test("forgets that a session was read from session_v2 a day after a poll last read it there", async () => {
    const clock = handClock(NOW);
    const { files, sqlite } = openOpencode([answerV2Row({ id: B })]);
    sqlite.probe(probeJson("v1+v2"));
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now });
    await adapter.poll();

    // A time ahead of the clock keeps a row listed but says nothing was written
    // since, so only the id being forgotten can let this row back in.
    sqlite.set([answerRow({ id: B, time_updated: NOW + 7 * DAY })]);
    files.append(WAL, "more");
    clock.advance(DAY - 1);
    expect((await adapter.poll()).sessions).toEqual([]);
    clock.advance(1);
    expect((await adapter.poll()).sessions.map((session) => session.id)).toEqual([`opencode:${B}`]);
  });

  test("the setting that stops last messages is said first, for a session of OpenCode 2's too", async () => {
    const { files, sqlite } = openOpencode([answerV2Row({ id: B })]);
    sqlite.probe(probeJson("v2-only"));
    const adapter = opencodeAdapterFor(files, sqlite, {
      env: { AGENT_LOOKOUT_LAST_MESSAGE: "off" },
    });
    await adapter.poll();
    expect(await adapter.lastMessage(`opencode:${B}`)).toEqual({
      message: null,
      reason: "off",
      setting: "AGENT_LOOKOUT_LAST_MESSAGE",
    });
  });

  test("a table of OpenCode 2's laid out in a way it does not know lists nothing, rather than 1.x's rows alone", async () => {
    const { files, sqlite } = openOpencode([answerRow({ id: A })]);
    const rows = JSON.parse(probeJson("v1+v2")) as Record<string, unknown>[];
    sqlite.probe(
      sqliteJson(rows.filter((row) => row.kind !== "session_v2" || row.name !== "time_suspended")),
    );
    const { health, sessions } = await opencodeAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain("a version of OpenCode that Agent Lookout does not read");
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

describe("a part left `running` by an OpenCode that was killed or crashed", () => {
  const asking = (askedAt: number) =>
    answerRow({ id: A, m_completed: null, m_finish: null, m_tools: 1, m_asked_at: askedAt });

  /** An adapter on a session left asking, whose `ps` and clock the test moves. */
  function leftAsking(askedAt = NOW - MINUTE) {
    const { files, sqlite } = openOpencode([asking(askedAt)]);
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now, processes });
    /** One poll with `ps` asked again and giving this answer. */
    const poll = (running: boolean) => {
      processes.set({ ok: true, running });
      clock.advance(PROCESS_CHECK_MS);
      return adapter.poll();
    };
    return { files, sqlite, clock, processes, adapter, poll };
  }

  const snapshotOf = ({ health, sessions, basis }: AdapterResult): SessionsSnapshot => ({
    generatedAt: health.checkedAt,
    sources: [{ ...health, ...(basis !== undefined && { basis }) }],
    sessions,
  });

  test("is announced once, and no more each time OpenCode is closed and started", async () => {
    const { poll } = leftAsking();
    const statuses: string[] = [];
    const announced: string[] = [];
    let memory: ChangeMemory = EMPTY_CHANGE_MEMORY;
    for (const running of [true, false, true, false, true]) {
      const answer = await poll(running);
      statuses.push(answer.sessions[0]?.status ?? "not listed");
      const seen = sessionChanges(memory, snapshotOf(answer));
      memory = seen.memory;
      announced.push(...seen.changes.map((change) => change.event));
    }
    expect(statuses).toEqual(["needs-you", "finished", "working", "finished", "working"]);
    expect(announced).not.toContain("needs-you");
  });

  test("is no wait from the first ps that shows no OpenCode, whenever the collector started", async () => {
    const { poll } = leftAsking();
    expect((await poll(false)).sessions[0]?.status).toBe("finished");
    const { sessions } = await poll(true);
    expect(sessions[0]?.status).toBe("working");
    expect(sessions[0]).not.toHaveProperty("waitingReason");
  });

  test("a question asked once OpenCode is back is a wait, and is announced", async () => {
    const { files, sqlite, clock, poll } = leftAsking();
    let memory = sessionChanges(EMPTY_CHANGE_MEMORY, snapshotOf(await poll(true))).memory;
    memory = sessionChanges(memory, snapshotOf(await poll(false))).memory;
    memory = sessionChanges(memory, snapshotOf(await poll(true))).memory;
    sqlite.set([asking(clock.now() + 1_000)]);
    files.write(WAL, "more frames");
    const answer = await poll(true);
    expect(answer.sessions[0]?.status).toBe("needs-you");
    const { changes } = sessionChanges(memory, snapshotOf(answer));
    expect(changes.map((change) => change.event)).toEqual(["needs-you"]);
  });

  test("stands while ps goes on showing an OpenCode, or cannot say", async () => {
    const { processes, poll, adapter, clock } = leftAsking();
    expect((await poll(true)).sessions[0]?.status).toBe("needs-you");
    expect((await poll(true)).sessions[0]?.status).toBe("needs-you");
    processes.set({ ok: false });
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
  });

  test("a clock set back does not make a question asked since look older than the last ps", async () => {
    const { files, sqlite, clock, poll } = leftAsking();
    await poll(false);
    clock.advance(-DAY / 2);
    sqlite.set([asking(clock.now())]);
    files.write(WAL, "more frames");
    expect((await poll(true)).sessions[0]?.status).toBe("needs-you");
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
    const processes = standInProcesses();
    const result = await opencodeAdapterFor(files, sqlite, { processes }).poll();
    expect(result.health).toMatchObject({
      state: "error",
      detail,
      watching: watching("every 2 seconds"),
    });
    expect(result.health).not.toHaveProperty("advice");
    expect(result.sessions).toEqual([]);
    expect(result).not.toHaveProperty("basis");
    expect(processes.asked()).toBe(0);
  });

  test("with no sqlite3 on Linux, it says how Ubuntu and Debian install it", async () => {
    const { files, sqlite } = openOpencode();
    sqlite.there(false);
    const { health } = await opencodeAdapterFor(files, sqlite, { platform: "linux" }).poll();
    expect(health).toMatchObject({ state: "error", advice: NO_SQLITE_ADVICE });
    expect(NO_SQLITE_ADVICE).toBe("On Ubuntu or Debian, install it with sudo apt install sqlite3.");
  });

  test("poll() never throws", async () => {
    const reader: DatabaseReader = {
      read: () => Promise.reject(new Error("A reader that throws.")),
      askOnce: () => Promise.reject(new Error("A reader that throws.")),
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

// The stand-in files, with each system's rules, so these pass on Windows too.
describe.each(["darwin", "linux"] as const)("a look that is refused on %s", (platform) => {
  function pollerOf(adapter: ReturnType<typeof opencodeAdapterFor>, now: () => number) {
    const events = createEventStore();
    const poller = createPoller({
      adapters: [adapter],
      events,
      history: createHistoryStore(),
      now,
    });
    const logged = () => events.list().map(({ kind, sessionId }) => ({ kind, sessionId }));
    return { poller, logged };
  }

  test.each([
    ["the database", DATABASE],
    ["the -wal", WAL],
    ["the -shm", SHM],
  ])("at %s is an error that says so, and not a missing database", async (_case, target) => {
    const { files, sqlite } = openOpencode();
    files.fail(target);
    const processes = standInProcesses();
    const adapter = opencodeAdapterFor(files, sqlite, { platform, processes });
    const { health, sessions, basis } = await adapter.poll();
    expect(health).toMatchObject({
      state: "error",
      detail: NOT_LOOKED_AT_DETAIL,
      watching: watching("every 2 seconds"),
    });
    expect(sessions).toEqual([]);
    expect(basis).toBeUndefined();
    expect(sqlite.runs).toEqual([]);
    expect(processes.asked()).toBe(0);
  });

  test("in a folder Agent Lookout's setting names is not a folder with no database", async () => {
    const { files, sqlite } = openOpencode();
    files.fail("/tmp/oc/opencode.db");
    const adapter = opencodeAdapterFor(files, sqlite, {
      env: { AGENT_LOOKOUT_OPENCODE_HOME: "/tmp/oc" },
      platform,
    });
    const { health } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain("could not be looked at");
    expect(health.detail).not.toContain("which has no");
  });

  test("with the data folder refused too, is not an OpenCode that is not there", async () => {
    const { files, sqlite } = openOpencode();
    files.fail(DATA_HOME);
    files.fail(DATABASE);
    const { health } = await opencodeAdapterFor(files, sqlite, { platform }).poll();
    expect(health).toMatchObject({ state: "error", detail: NOT_LOOKED_AT_DETAIL });
  });

  test.each([
    ["the database", DATABASE],
    ["the -wal", WAL],
    ["the -shm", SHM],
  ])(
    "at %s sends no ended, and a look that works again brings the sessions back with no event",
    async (_case, target) => {
      const clock = handClock();
      const { files, sqlite } = openOpencode();
      const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now, platform });
      const { poller, logged } = pollerOf(adapter, clock.now);
      expect((await poller.pollOnce()).sessions).toHaveLength(1);

      files.fail(target);
      clock.advance(2 * SECOND);
      const refused = await poller.pollOnce();
      expect(refused.sources[0]?.state).toBe("error");
      expect(refused.sessions).toEqual([]);
      expect(logged()).toEqual([]);

      files.heal(target);
      clock.advance(2 * SECOND);
      const resumed = await poller.pollOnce();
      expect(resumed.sources[0]?.state).toBe("ok");
      expect(resumed.sessions).toHaveLength(1);
      expect(logged()).toEqual([]);
    },
  );

  test("is told from a database that has gone, whose sessions do end", async () => {
    const clock = handClock();
    const { files, sqlite } = openOpencode();
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now, platform });
    const { poller, logged } = pollerOf(adapter, clock.now);
    await poller.pollOnce();
    files.remove(DATABASE);
    clock.advance(2 * SECOND);
    await poller.pollOnce();
    expect(logged()).toEqual([{ kind: "ended", sessionId: `opencode:${A}` }]);
  });

  test("between two polls leaves what a session last said unreadable, with nothing asked", async () => {
    const { files, sqlite } = openOpencode();
    sqlite.said(A, lastTextJson(["The reply."]));
    const adapter = opencodeAdapterFor(files, sqlite, { platform });
    await adapter.poll();
    files.fail(WAL);
    await expect(adapter.lastMessage(`opencode:${A}`)).resolves.toEqual({
      message: null,
      reason: "unreadable",
    });
    expect(sqlite.questions()).toEqual([]);
  });
});

describe("what a session last said", () => {
  const SAID = `opencode:${A}`;

  /** An open OpenCode with A and B listed, and sqlite3 ready to say what each last said. */
  function saying(options: Parameters<typeof opencodeAdapterFor>[2] = {}) {
    const clock = handClock(NOW);
    const { files, sqlite } = openOpencode([answerRow({ id: A }), answerRow({ id: B })]);
    sqlite.said(A, lastTextJson(["The reply."]));
    sqlite.said(B, lastTextJson(["Another reply."]));
    const adapter = opencodeAdapterFor(files, sqlite, { now: clock.now, ...options });
    return { clock, files, sqlite, adapter };
  }

  test("is the newest reply's text for a listed session, asked of the database only when asked", async () => {
    const { adapter, files, sqlite } = saying();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(sqlite.runs).toEqual([]);
    await adapter.poll();
    expect(sqlite.questions()).toEqual([]);
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
    expect(sqlite.questions().map((run) => run.args.at(-1))).toEqual([lastTextQuery(A)]);

    files.forget();
    const before = sqlite.runs.length;
    await expect(adapter.lastMessage(`opencode:${sessionId("c3")}`)).resolves.toBeNull();
    await expect(adapter.lastMessage(`codex:${A}`)).resolves.toBeNull();
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

  test("Sources says it asks for a 1.x session's newest reply while its details are open", async () => {
    const { adapter } = saying();
    expect((await adapter.poll()).health.watching).toContainEqual({
      label: "Last message read",
      value: "an OpenCode 1.x session's newest reply, with sqlite3, while its details are open",
    });
    expect(LAST_MESSAGE_READ).toBe(
      "an OpenCode 1.x session's newest reply, with sqlite3, while its details are open",
    );
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

  test("with OpenCode keeping its sessions in memory, nothing is listed, so nothing is asked", async () => {
    const { adapter, sqlite } = saying({ env: { OPENCODE_DB: ":memory:" } });
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(sqlite.runs).toEqual([]);
  });

  test("a session shown as finished, with no OpenCode program running, is still read until it leaves the list", async () => {
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

  test("keeps none, and lets none be asked, after a poll that cannot read the database, until a poll lists the session again", async () => {
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

    sqlite.fail(false);
    files.append(WAL, "and more");
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions.map((session) => session.id)).toContain(SAID);
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("is dropped, and nothing may be asked, after a poll that throws, and is read again once a poll lists the session", async () => {
    const { files, sqlite } = openOpencode([answerRow({ id: A })]);
    sqlite.said(A, lastTextJson(["The reply."]));
    const real = createDatabaseReader({
      file: DATABASE,
      io: files.io,
      platform: "darwin",
      run: sqlite.run,
      find: sqlite.find,
    });
    let broken = false;
    const reader: DatabaseReader = {
      read: (at) => (broken ? Promise.reject(new Error("A reader that throws.")) : real.read(at)),
      askOnce: (question, known) => real.askOnce(question, known),
    };
    const clock = handClock(NOW);
    const adapter = opencodeAdapterFor(files, sqlite, { reader, now: clock.now });
    await adapter.poll();
    await adapter.lastMessage(SAID);
    expect(adapter.lastMessagesKept).toBe(1);

    broken = true;
    clock.advance(SECOND);
    const failed = await adapter.poll();
    expect(failed.health.detail).toBe(
      "Something unexpected went wrong while reading OpenCode sessions.",
    );
    expect(adapter.lastMessagesKept).toBe(0);
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();

    broken = false;
    clock.advance(SECOND);
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
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
    await adapter.lastMessage(`opencode:${B}`);
    expect(asked).toBe(2);
  });

  test("of the database's three questions, a poll asks only its own two, and the details only the session's", async () => {
    const { adapter, sqlite } = saying();
    await adapter.poll();
    await adapter.lastMessage(SAID);
    await adapter.lastMessage(`opencode:${B}`);
    expect(sqlite.runs.map((run) => run.args.at(-1))).toEqual([
      PROBE_QUERY,
      SESSIONS_QUERY,
      lastTextQuery(A),
      lastTextQuery(B),
    ]);
  });
});
