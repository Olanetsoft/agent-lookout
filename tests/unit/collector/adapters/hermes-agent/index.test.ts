import path from "node:path";

import { describe, expect, test } from "vitest";

import { SQLITE_TIMEOUT_MS } from "@collector/adapters/antigravity/app/summaries";
import type { Adapter } from "@collector/adapters/adapter";
import { RETRY_MS } from "@collector/adapters/hermes-agent/database";
import {
  BASIS,
  COMMAND_SHOWN,
  createHermesAgentAdapter,
  HERMES_AGENT_CAPABILITIES,
  LATE_NOTE,
  NO_SQLITE_ADVICE,
  READ_BUDGET_MS,
  RECHECK_MS,
  UNCHECKED_NOTE,
  UNKNOWN_ROW_NOTE,
  UNSUPPORTED_ADVICE,
  VULNERABLE_SQLITE_ADVICE,
  VULNERABLE_SQLITE_ADVICE_MAC,
  WINDOWS_DETAIL,
  type HermesAgentAdapterOptions,
} from "@collector/adapters/hermes-agent/index";
import { SESSIONS_QUERY } from "@collector/adapters/hermes-agent/sessionRows";
import { HERMES_SQLITE_LOCATIONS } from "@collector/adapters/hermes-agent/sqlite";
import { POLL_DEADLINE_MS } from "@collector/poller";
import {
  answerRow,
  DEFAULT_DATABASE,
  GATEWAY_PID,
  HOME,
  HOUR,
  liveLease,
  MINUTE,
  NOW,
  PID_NAMESPACE,
  probeJson,
  PROFILE,
  PROFILE_DATABASE,
  ROOT,
  seconds,
  sessionId,
} from "@tests/fixtures/hermes-agent/hermesAgent";
import {
  handClock,
  hermesAgentAdapterFor,
  LINUX_NAMESPACE,
  memoryFiles,
  standInNamespace,
  standInProcesses,
  standInSqlite,
  writeLiveWalDatabase,
  writeRollbackDatabase,
  type MemoryFiles,
  type StandInSqlite,
} from "@tests/support/adapters/hermesAgentAdapter";

const A = sessionId("a1");
const B = sessionId("b2");
const C = sessionId("c3");
const KEG = "/opt/homebrew/opt/sqlite/bin/sqlite3";
const NOTES = `${LATE_NOTE} ${UNCHECKED_NOTE}`;
const HEALTHY = `Sessions are read from Hermes Agent's databases in ~/.hermes, with sqlite3. ${NOTES}`;

/** The rows Sources shows, in order, for the default root. */
function watching(
  read: string,
  fields: {
    profiles?: string;
    walSqlite?: string;
    commandRun?: string;
    processCheck?: string;
  } = {},
) {
  return [
    { label: "Hermes folder", value: "~/.hermes" },
    { label: "Profiles", value: fields.profiles ?? "none found" },
    { label: "Read", value: read },
    { label: "Command", value: COMMAND_SHOWN },
    { label: "Command run", value: fields.commandRun ?? "when a database changes" },
    { label: "sqlite3 for a live -wal", value: fields.walSqlite ?? "not needed yet" },
    {
      label: "Process check",
      value: fields.processCheck ?? "signal 0 to a running turn's process, every 2 seconds",
    },
  ];
}

/** A Hermes Agent root with the default profile's database, and the coder profile's, each in rollback-journal mode. */
function hermesHome(
  defaultRows: Record<string, unknown>[] = [answerRow({ id: A })],
  coderRows: Record<string, unknown>[] | null = [answerRow({ id: B, title: "Write the notes" })],
) {
  const files = memoryFiles();
  writeRollbackDatabase(files, DEFAULT_DATABASE);
  const initial: Record<string, Record<string, unknown>[]> = { [DEFAULT_DATABASE]: defaultRows };
  if (coderRows !== null) {
    writeRollbackDatabase(files, PROFILE_DATABASE);
    initial[PROFILE_DATABASE] = coderRows;
  }
  return { files, sqlite: standInSqlite(initial) };
}

/** The value of one of the facts Sources shows. */
const fact = (health: { watching?: { label: string; value: string }[] }, label: string) =>
  health.watching?.find((each) => each.label === label)?.value;

/**
 * One poll, checked to have kept its runs of sqlite3 to the 5 seconds for
 * reading: each started while some of them was left, the first with its whole
 * 5 seconds, and each later one with those or what was left, whichever is
 * less. With how long it took, and the runs it made.
 */
async function pollWithin(
  adapter: Adapter,
  sqlite: StandInSqlite,
  clock: ReturnType<typeof handClock>,
) {
  const started = clock.now();
  const from = sqlite.timed.length;
  const polled = await adapter.poll();
  const runs = sqlite.timed.slice(from);
  runs.forEach((run, index) => {
    const left = started + READ_BUDGET_MS - (run.startedAt as number);
    expect(left).toBeGreaterThan(0);
    expect(run.timeoutMs).toBe(index === 0 ? SQLITE_TIMEOUT_MS : Math.min(SQLITE_TIMEOUT_MS, left));
  });
  return { polled, took: clock.now() - started, runs };
}

/**
 * A live -wal in the default profile alone, with a sqlite3 at every fixed
 * place, each taking this long to answer. All but the last have the WAL-reset
 * bug, so each is asked its version before the last is chosen.
 */
function slowLiveWal(slow: { takesMs: number; honoursTimeout?: boolean }) {
  const files = memoryFiles();
  writeLiveWalDatabase(files, DEFAULT_DATABASE);
  const clock = handClock();
  const sqlite = standInSqlite(
    { [DEFAULT_DATABASE]: [answerRow({ id: A })] },
    { slow: { clock, ...slow } },
  );
  const last = HERMES_SQLITE_LOCATIONS.at(-1) as string;
  for (const place of HERMES_SQLITE_LOCATIONS) {
    sqlite.install(place, place === last ? "3.53.0" : "3.51.0");
  }
  const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
  return { files, sqlite, clock, adapter, last };
}

/**
 * A live -wal in the default profile alone, with /usr/bin/sqlite3, which has
 * the WAL-reset bug, and Homebrew's own, which passes, each run taking 3
 * seconds: the first place's version has the poll's whole 5 seconds, and the
 * keg's, given the 2 left, is cut short.
 */
function slowWalHome(options: HermesAgentAdapterOptions = {}) {
  const files = memoryFiles();
  writeLiveWalDatabase(files, DEFAULT_DATABASE);
  const clock = handClock();
  const sqlite = standInSqlite(
    { [DEFAULT_DATABASE]: [answerRow({ id: A })] },
    { slow: { clock, takesMs: 3_000 } },
  );
  sqlite.install("/usr/bin/sqlite3", "3.51.0");
  sqlite.install(KEG, "3.53.0");
  const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now, ...options });
  return { files, sqlite, clock, adapter };
}

describe("a Hermes Agent that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute, with nothing else looked at or run", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const sqlite = standInSqlite();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    const { health, sessions, basis } = await adapter.poll();
    expect(health).toEqual({
      id: "hermes-agent",
      label: "Hermes Agent",
      state: "unavailable",
      detail:
        "Hermes Agent was not found: there is no ~/.hermes folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(health).not.toHaveProperty("advice");
    expect(health).not.toHaveProperty("parts");
    expect(basis).toBeUndefined();
    expect(sessions).toEqual([]);
    expect(files.calls).toEqual([{ method: "stat", path: ROOT }]);

    for (let poll = 0; poll < 5; poll += 1) {
      clock.advance(RECHECK_MS / 5 - 1);
      await adapter.poll();
    }
    expect(files.calls).toHaveLength(1);
    clock.set(NOW + RECHECK_MS);
    await adapter.poll();
    expect(files.calls).toEqual([
      { method: "stat", path: ROOT },
      { method: "stat", path: ROOT },
    ]);
    expect(sqlite.runs).toEqual([]);
    expect(sqlite.versionRuns).toEqual([]);
    expect(RECHECK_MS).toBe(60_000);
  });

  test("a clock set back counts as time enough to look again", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, standInSqlite(), { now: clock.now });
    await adapter.poll();
    clock.advance(-1);
    await adapter.poll();
    expect(files.count("stat")).toBe(2);
  });

  test("is found once its folder is made, and lost again when it goes", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, standInSqlite(), { now: clock.now });
    expect((await adapter.poll()).health.state).toBe("unavailable");
    files.mkdir(ROOT);
    clock.advance(RECHECK_MS);
    const found = await adapter.poll();
    expect(found.health).toMatchObject({
      state: "ok",
      detail: `Hermes Agent has not saved a database in ~/.hermes yet. ${NOTES}`,
      watching: watching("every 2 seconds", { profiles: "default" }),
      parts: { "hermes-agent:default/": BASIS },
    });
    expect(found.basis).toBe(BASIS);
    files.remove(ROOT);
    clock.advance(2_000);
    const lost = await adapter.poll();
    expect(lost.health).toMatchObject({ state: "unavailable", watching: watching("not found") });
  });

  test("names the folder Hermes Agent's own HERMES_HOME gives", async () => {
    const files = memoryFiles();
    const env = { HERMES_HOME: "/srv/hermes/profiles/work" };
    const { health } = await hermesAgentAdapterFor(files, standInSqlite(), { env }).poll();
    expect(health.detail).toBe(
      `Hermes Agent was not found: there is no ${path.resolve("/srv/hermes")} folder. Agent Lookout looks again every minute.`,
    );
    expect(files.calls.map((call) => call.path)).toEqual(["/srv/hermes"]);
  });

  test("with Agent Lookout's setting, a folder with no database is an answer, not a missing Hermes Agent", async () => {
    const files = memoryFiles();
    const sqlite = standInSqlite();
    const env = { AGENT_LOOKOUT_HERMES_HOME: "/tmp/empty-hermes", HERMES_HOME: ROOT };
    const { health, sessions, basis } = await hermesAgentAdapterFor(files, sqlite, { env }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_HERMES_HOME is set to ${path.resolve("/tmp/empty-hermes")}, which has no state.db in it or in a profile, so no Hermes Agent sessions are listed. ${NOTES}`,
    );
    expect(health.parts).toEqual({ "hermes-agent:default/": BASIS });
    expect(basis).toBe(BASIS);
    expect(sessions).toEqual([]);
    // Its folder is never looked for, and only the default profile's database and its profiles are looked at.
    expect(files.count("stat")).toBe(0);
    expect(sqlite.runs).toEqual([]);
  });
});

describe("on Windows", () => {
  test("nothing is read, and Hermes Agent is not found, with why", async () => {
    const { files, sqlite } = hermesHome();
    files.forget();
    const adapter = hermesAgentAdapterFor(files, sqlite, { platform: "win32" });
    const { health, sessions, basis } = await adapter.poll();
    expect(health).toEqual({
      id: "hermes-agent",
      label: "Hermes Agent",
      state: "unavailable",
      detail: WINDOWS_DETAIL,
      watching: watching("not on Windows", {
        commandRun: "not run on Windows",
        processCheck: "not run on Windows",
      }),
      checkedAt: NOW,
    });
    expect(WINDOWS_DETAIL).toBe(
      "Agent Lookout does not read Hermes Agent's sessions on Windows: they are read with sqlite3, which it does not run there.",
    );
    expect(basis).toBeUndefined();
    expect(sessions).toEqual([]);
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
    expect(sqlite.versionRuns).toEqual([]);
    expect(adapter.capabilities).toBe(HERMES_AGENT_CAPABILITIES);
  });
});

describe("reading the sessions", () => {
  test("lists each conversation of every profile with its name, folder and status, each profile named apart", async () => {
    const { files, sqlite } = hermesHome(
      [
        answerRow({ id: A }),
        answerRow({
          id: C,
          title: "Clean the build",
          ...liveLease(),
          // The call that waits was written in this turn, and the label saved since.
          calls_at: seconds(NOW - MINUTE),
          open_calls: 1,
          last_activity_at: seconds(NOW - 30_000),
          approval_label: 1,
        }),
      ],
      [answerRow({ id: B, title: "Write the notes", ...liveLease() })],
    );
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    const adapter = hermesAgentAdapterFor(files, sqlite);
    const { health, sessions, basis } = await adapter.poll();
    expect(health).toEqual({
      id: "hermes-agent",
      label: "Hermes Agent",
      state: "ok",
      detail: HEALTHY,
      watching: watching("every 2 seconds", { profiles: "default, coder" }),
      checkedAt: NOW,
      parts: { "hermes-agent:default/": BASIS, "hermes-agent:coder/": BASIS },
    });
    expect(basis).toBe(BASIS);
    expect(BASIS).toBe("database");
    expect(
      sessions.map((session) => [
        session.id,
        session.name,
        session.status,
        session.waitingReason,
        session.statusSince,
      ]),
    ).toEqual([
      [`hermes-agent:default/${A}`, "Rename the helper", "idle", undefined, NOW - MINUTE],
      [`hermes-agent:default/${C}`, "Clean the build", "needs-you", "permission", NOW - MINUTE],
      [`hermes-agent:coder/${B}`, "Write the notes", "working", undefined, NOW - 2 * MINUTE],
    ]);
    expect(adapter.lookingIn).toBe("Looking for Hermes Agent sessions in ~/.hermes.");
    expect(adapter.capabilities).toBe(HERMES_AGENT_CAPABILITIES);
  });

  test("a poll where nothing changed runs no sqlite3, and the sessions stand", async () => {
    const { files, sqlite } = hermesHome();
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    await adapter.poll();
    const runs = sqlite.runs.length;
    expect(runs).toBe(4);
    for (let poll = 0; poll < 5; poll += 1) {
      clock.advance(2_000);
      expect((await adapter.poll()).sessions).toHaveLength(2);
    }
    expect(sqlite.runs).toHaveLength(runs);
  });

  test("a lease that runs out flips working to idle on the next poll, though no file changed", async () => {
    const { files, sqlite } = hermesHome([answerRow({ id: A, ...liveLease() })], null);
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "working",
      statusSince: NOW - 2 * MINUTE,
    });
    clock.advance(5 * MINUTE - 1);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    clock.advance(1);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "idle",
      statusSince: NOW - MINUTE,
    });
    expect(sqlite.queries()).toHaveLength(1);
  });

  test("a lease whose process is gone is idle at once, and the process is asked after on every poll while its lease is live", async () => {
    const { files, sqlite } = hermesHome([answerRow({ id: A, ...liveLease() })], null);
    const clock = handClock();
    const processes = standInProcesses([GATEWAY_PID]);
    const namespace = standInNamespace();
    const adapter = hermesAgentAdapterFor(files, sqlite, {
      now: clock.now,
      isAlive: processes.isAlive,
      pidNamespace: namespace,
    });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    processes.stop(GATEWAY_PID);
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
    expect(processes.asked).toEqual([GATEWAY_PID, GATEWAY_PID]);
    // Once the lease has run out, no process is asked after.
    clock.advance(5 * MINUTE);
    await adapter.poll();
    expect(processes.asked).toHaveLength(2);
    expect(sqlite.queries()).toHaveLength(1);
  });

  test("no process is asked after, and no namespace read, while no lease is live", async () => {
    const { files, sqlite } = hermesHome(
      [
        answerRow({ id: A }),
        answerRow({
          id: C,
          lease_at: seconds(NOW - 10 * MINUTE),
          lease_until: seconds(NOW - 5 * MINUTE),
          lease_pid: GATEWAY_PID,
        }),
      ],
      null,
    );
    const processes = standInProcesses();
    const namespace = standInNamespace(LINUX_NAMESPACE);
    const adapter = hermesAgentAdapterFor(files, sqlite, {
      platform: "linux",
      isAlive: processes.isAlive,
      pidNamespace: namespace,
    });
    expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual([
      "idle",
      "idle",
    ]);
    expect(processes.asked).toEqual([]);
    expect(namespace.asked()).toBe(0);
  });

  test("on Linux, a holder in Agent Lookout's own pid namespace is checked, and one in another trusts its lease", async () => {
    const { files, sqlite } = hermesHome(
      [
        answerRow({ id: A, ...liveLease({ pidns: PID_NAMESPACE }) }),
        answerRow({ id: C, ...liveLease({ pidns: PID_NAMESPACE + 1 }) }),
        answerRow({ id: B, ...liveLease({ pidns: null }) }),
      ],
      null,
    );
    const processes = standInProcesses([]);
    const namespace = standInNamespace(LINUX_NAMESPACE);
    const { sessions } = await hermesAgentAdapterFor(files, sqlite, {
      platform: "linux",
      isAlive: processes.isAlive,
      pidNamespace: namespace,
    }).poll();
    expect(sessions.map((session) => [session.id.slice(-2), session.status])).toEqual([
      ["a1", "idle"],
      ["c3", "working"],
      ["b2", "working"],
    ]);
    expect(processes.asked).toEqual([GATEWAY_PID]);
  });

  test("a session not written for a day is left out", async () => {
    const day = 24 * HOUR;
    const old = seconds(NOW - day);
    const { files, sqlite } = hermesHome(
      [
        answerRow({
          id: A,
          started_at: old,
          root_started_at: old,
          last_activity_at: old,
          last_message_at: old,
          n_at: old,
        }),
      ],
      null,
    );
    expect((await hermesAgentAdapterFor(files, sqlite).poll()).sessions).toEqual([]);
  });

  test("says so when a conversation ends with a row it does not know", async () => {
    const { files, sqlite } = hermesHome([answerRow({ id: A, n_role: "planner" })], null);
    const { health, sessions } = await hermesAgentAdapterFor(files, sqlite).poll();
    expect(health.detail).toBe(`${HEALTHY} ${UNKNOWN_ROW_NOTE}`);
    expect(sessions[0]?.status).toBe("unknown");
  });

  test("a profile that is gone takes its sessions and its part with it", async () => {
    const { files, sqlite } = hermesHome();
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(2);
    files.remove(`${ROOT}/profiles/${PROFILE}`);
    clock.advance(RECHECK_MS);
    const after = await adapter.poll();
    expect(after.sessions.map((session) => session.id)).toEqual([`hermes-agent:default/${A}`]);
    expect(after.health.parts).toEqual({ "hermes-agent:default/": BASIS });
    expect(fact(after.health, "Profiles")).toBe("default");
  });

  test("a database read with its live -wal names the sqlite3 used for it", async () => {
    const files = memoryFiles();
    writeLiveWalDatabase(files, DEFAULT_DATABASE);
    const sqlite = standInSqlite({ [DEFAULT_DATABASE]: [answerRow({ id: A })] });
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    const { health, sessions } = await hermesAgentAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("ok");
    expect(fact(health, "sqlite3 for a live -wal")).toBe(`${KEG} 3.53.0`);
    expect(sessions).toHaveLength(1);
    expect(sqlite.queries()[0]?.binary).toBe(KEG);
  });
});

describe("when a profile cannot be read", () => {
  test("with another read, the card is ok, lists what was read, names the profile not read, and its sessions are left as they were", async () => {
    const { files, sqlite } = hermesHome();
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    sqlite.fail(PROFILE_DATABASE);
    const { health, sessions, basis } = await hermesAgentAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `${HEALTHY} Not read: the coder profile, because sqlite3 could not read it.`,
    );
    expect(health).not.toHaveProperty("advice");
    expect(basis).toBe(BASIS);
    // Only the profile read is named, so the poller leaves the other's sessions alone.
    expect(health.parts).toEqual({ "hermes-agent:default/": BASIS });
    expect(sessions.map((session) => session.id)).toEqual([`hermes-agent:default/${A}`]);
  });

  test("with another read, each profile not read is named with why, and the advice of the first that has some", async () => {
    const files = memoryFiles();
    writeRollbackDatabase(files, DEFAULT_DATABASE);
    writeLiveWalDatabase(files, `${ROOT}/profiles/alpha/state.db`);
    writeRollbackDatabase(files, `${ROOT}/profiles/beta/state.db`);
    writeLiveWalDatabase(files, `${ROOT}/profiles/gamma/state.db`);
    files.remove(`${ROOT}/profiles/gamma/state.db-shm`);
    const sqlite = standInSqlite({ [DEFAULT_DATABASE]: [answerRow({ id: A })] });
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.probe(probeJson("v0.21.5"), `${ROOT}/profiles/beta/state.db`);
    const { health } = await hermesAgentAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `${HEALTHY} Not read: the alpha profile, because its -wal file holds something, and no sqlite3 found passes Hermes Agent's WAL-reset test; the beta profile, because it is laid out as a version of Hermes Agent that Agent Lookout does not read; the gamma profile, because its -wal file has no -shm file beside it, or one of them is not an ordinary file.`,
    );
    expect(health.advice).toBe(VULNERABLE_SQLITE_ADVICE_MAC);
    expect(health.parts).toEqual({ "hermes-agent:default/": BASIS });
  });

  test("with none read, the card is an error, and each is named", async () => {
    const { files, sqlite } = hermesHome();
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    sqlite.fail();
    const { health, sessions, basis } = await hermesAgentAdapterFor(files, sqlite).poll();
    expect(health).toMatchObject({
      state: "error",
      detail:
        "No Hermes Agent profile in ~/.hermes could be read. Not read: the default profile, because sqlite3 could not read it; the coder profile, because sqlite3 could not read it.",
    });
    expect(health).not.toHaveProperty("parts");
    expect(basis).toBeUndefined();
    expect(sessions).toEqual([]);
  });

  const alone: [
    string,
    (files: MemoryFiles, sqlite: StandInSqlite) => void,
    string,
    Partial<Record<NodeJS.Platform, string>>,
  ][] = [
    [
      "sqlite3 failing",
      (_files, sqlite) => sqlite.fail(),
      "sqlite3 could not read Hermes Agent's database, ~/.hermes/state.db, so no Hermes Agent sessions are listed. Agent Lookout tries again when it changes, or 10 seconds on.",
      {},
    ],
    [
      "no sqlite3",
      (_files, sqlite) => sqlite.uninstall("/usr/bin/sqlite3"),
      "No sqlite3 program was found to read Hermes Agent's database, ~/.hermes/state.db, so no Hermes Agent sessions are listed.",
      { linux: NO_SQLITE_ADVICE },
    ],
    [
      "tables of a version before v0.21.6",
      (_files, sqlite) => sqlite.probe(probeJson("v0.21.5")),
      "Hermes Agent's database, ~/.hermes/state.db, is laid out as a version of Hermes Agent that Agent Lookout does not read. It reads those of Hermes Agent v0.21.6 and later.",
      { darwin: UNSUPPORTED_ADVICE, linux: UNSUPPORTED_ADVICE },
    ],
    [
      "a -wal that holds commits without its -shm",
      (files) => {
        writeLiveWalDatabase(files, DEFAULT_DATABASE);
        files.remove(`${DEFAULT_DATABASE}-shm`);
      },
      "Hermes Agent's database, ~/.hermes/state.db, was not read: its -wal file holds something but has no -shm file beside it, or one of them is not an ordinary file, so it cannot be read without writing to it.",
      {},
    ],
    [
      "a live -wal and only a sqlite3 with the WAL-reset bug",
      (files, sqlite) => {
        writeLiveWalDatabase(files, DEFAULT_DATABASE);
        sqlite.install("/usr/bin/sqlite3", "3.51.0");
      },
      "Hermes Agent's database, ~/.hermes/state.db, was not read: its -wal file holds something, and no sqlite3 found passes Hermes Agent's test for SQLite's WAL-reset bug. /usr/bin/sqlite3 is version 3.51.0. Hermes Agent refuses such a sqlite3 on a live database, since it can lose what was saved.",
      { darwin: VULNERABLE_SQLITE_ADVICE_MAC, linux: VULNERABLE_SQLITE_ADVICE },
    ],
    [
      "a live -wal and only a sqlite3 that does not say its version",
      (files, sqlite) => {
        writeLiveWalDatabase(files, DEFAULT_DATABASE);
        sqlite.install("/usr/bin/sqlite3", null);
      },
      "Hermes Agent's database, ~/.hermes/state.db, was not read: its -wal file holds something, and no sqlite3 found passes Hermes Agent's test for SQLite's WAL-reset bug. /usr/bin/sqlite3 is a version it did not say. Hermes Agent refuses such a sqlite3 on a live database, since it can lose what was saved.",
      { darwin: VULNERABLE_SQLITE_ADVICE_MAC, linux: VULNERABLE_SQLITE_ADVICE },
    ],
  ];
  test.each(alone)(
    "with the only database and %s, it says so plainly, with the advice for this system, and lists nothing",
    async (_what, make, detail, advice) => {
      for (const platform of ["darwin", "linux"] as const) {
        const { files, sqlite } = hermesHome([answerRow({ id: A })], null);
        make(files, sqlite);
        const result = await hermesAgentAdapterFor(files, sqlite, { platform }).poll();
        expect(result.health, platform).toMatchObject({ state: "error", detail });
        if (advice[platform] === undefined) {
          expect(result.health, platform).not.toHaveProperty("advice");
        } else {
          expect(result.health.advice, platform).toBe(advice[platform]);
        }
        expect(result.sessions).toEqual([]);
        expect(result).not.toHaveProperty("basis");
        expect(result.health).not.toHaveProperty("parts");
      }
    },
  );

  test("the advice for a sqlite3 with the WAL-reset bug names a fix for each system", () => {
    expect(VULNERABLE_SQLITE_ADVICE_MAC).toBe(
      "Install SQLite 3.51.3 or newer with brew install sqlite, which Agent Lookout finds in /opt/homebrew/opt/sqlite or /usr/local/opt/sqlite.",
    );
    expect(VULNERABLE_SQLITE_ADVICE).toBe(
      "Put a sqlite3 of version 3.51.3 or newer, such as sqlite.org's precompiled tools, at /usr/local/bin/sqlite3.",
    );
    expect(NO_SQLITE_ADVICE).toBe("On Ubuntu or Debian, install it with sudo apt install sqlite3.");
    expect(UNSUPPORTED_ADVICE).toBe("If your Hermes Agent is older than v0.21.6, update it.");
  });

  test("Sources names the sqlite3 refused for a live -wal, and none at all", async () => {
    const files = memoryFiles();
    writeLiveWalDatabase(files, DEFAULT_DATABASE);
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    expect(fact((await adapter.poll()).health, "sqlite3 for a live -wal")).toBe(
      "none trusted: /usr/bin/sqlite3 3.51.0 fails Hermes Agent's WAL-reset test",
    );
    sqlite.uninstall("/usr/bin/sqlite3");
    clock.advance(10_000);
    expect(fact((await adapter.poll()).health, "sqlite3 for a live -wal")).toBe("none found");
  });

  test("poll() never throws", async () => {
    const { files, sqlite } = hermesHome([answerRow({ id: A, ...liveLease() })], null);
    const adapter = hermesAgentAdapterFor(files, sqlite, {
      pidNamespace: { read: () => Promise.reject(new Error("A reader that throws.")) },
    });
    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading Hermes Agent sessions.",
    });
    expect(sessions).toEqual([]);
  });
});

describe("the reads of a poll", () => {
  test("stop starting once about 5 seconds of it are used, and the profiles left, or cut short, are read on the next polls, keeping their last read meanwhile", async () => {
    const files = memoryFiles();
    const names = Array.from({ length: 16 }, (_, index) => `p${String(index).padStart(2, "0")}`);
    const databases = [
      DEFAULT_DATABASE,
      ...names.map((name) => `${ROOT}/profiles/${name}/state.db`),
    ];
    const clock = handClock();
    // Each run of sqlite3 takes 600 ms, 1.2 seconds a profile, and is stopped at its timeout.
    const sqlite = standInSqlite({}, { slow: { clock, takesMs: 600 } });
    databases.forEach((database, index) => {
      writeRollbackDatabase(files, database);
      sqlite.set(database, [answerRow({ id: sessionId(`d${index}`) })]);
    });
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    expect(READ_BUDGET_MS).toBe(5_000);
    expect(READ_BUDGET_MS * 2).toBeLessThan(POLL_DEADLINE_MS);

    const partsOf = async () => {
      const { polled, took } = await pollWithin(adapter, sqlite, clock);
      expect(took).toBeLessThanOrEqual(READ_BUDGET_MS);
      clock.advance(2_000);
      return Object.keys(polled.health.parts ?? {});
    };
    // Four profiles are read within the 5 seconds. The fifth starts at 4.8,
    // and its probe, given the 200 ms left, is cut short at 5.
    const first = await partsOf();
    expect(first).toEqual(["default", "p00", "p01", "p02"].map((p) => `hermes-agent:${p}/`));
    expect(sqlite.queries()).toHaveLength(4);
    expect(sqlite.probes()).toHaveLength(5);
    expect(sqlite.probes().at(-1)?.timeoutMs).toBe(200);
    // Those read cost nothing on the next poll, so the next four are read, the one cut short first.
    const second = await partsOf();
    expect(second).toHaveLength(8);
    expect(second).toContain("hermes-agent:p03/");
    expect(await partsOf()).toHaveLength(12);
    expect(await partsOf()).toHaveLength(16);
    expect(await partsOf()).toHaveLength(17);
    expect(sqlite.queries()).toHaveLength(17);

    // Every database changes: those not reached this poll, and the one cut
    // short, keep their last read, and their sessions.
    for (const database of databases) writeRollbackDatabase(files, database);
    const { polled: changed, took } = await pollWithin(adapter, sqlite, clock);
    expect(took).toBe(READ_BUDGET_MS);
    expect(Object.keys(changed.health.parts ?? {})).toHaveLength(17);
    expect(changed.sessions).toHaveLength(17);
    expect(changed.health.detail).toBe(HEALTHY);
    expect(sqlite.queries()).toHaveLength(21);
  });

  test("each run of sqlite3 gets its own 5 seconds or what is left of the poll's, and none starts once they are used, so a slow one ends the reads within them", async () => {
    // Each run, version runs among them, takes 2 seconds, and is stopped at its timeout.
    const { sqlite, clock, adapter, last } = slowLiveWal({ takesMs: 2_000 });
    const seen: [string, string | undefined, number][] = [];
    for (let poll = 0; poll < 5; poll += 1) {
      const { polled, took } = await pollWithin(adapter, sqlite, clock);
      expect(took).toBeLessThanOrEqual(READ_BUDGET_MS);
      if (polled.health.state === "searching") {
        expect(polled.health.detail).toBe(
          "Hermes Agent's databases in ~/.hermes are still being read.",
        );
        expect(polled.health).not.toHaveProperty("parts");
        expect(polled.basis).toBeUndefined();
      }
      seen.push([
        polled.health.state,
        fact(polled.health, "sqlite3 for a live -wal"),
        polled.sessions.length,
      ]);
      clock.advance(2_000);
    }
    expect(seen).toEqual([
      // Two places answer in 4 seconds, and the third is given 1 and cut
      // short, so it is asked again on the next poll, as nothing was learned.
      ["searching", "not needed yet", 0],
      ["searching", "not needed yet", 0],
      ["searching", "not needed yet", 0],
      // The last place passes, and the probe answers. The query is cut short.
      ["searching", `${last} 3.53.0`, 0],
      ["ok", `${last} 3.53.0`, 1],
    ]);
    const [l0, l1, l2, l3, l4, l5, l6] = HERMES_SQLITE_LOCATIONS;
    expect(sqlite.versionRuns).toEqual([l0, l1, l2, l2, l3, l4, l4, l5, l6, l6]);
    expect(sqlite.timed.filter((run) => run.kind !== "version").map((run) => run.kind)).toEqual([
      "probe",
      "query",
      "probe",
      "query",
    ]);
  });

  test("a sqlite3 that outlasts its timeout holds the reads past the 5 seconds by that one run at most, well within the poller's limit", async () => {
    // Each run takes 4 seconds, whatever its timeout.
    const { sqlite, clock, adapter } = slowLiveWal({ takesMs: 4_000, honoursTimeout: false });
    const states: string[] = [];
    for (let poll = 0; poll < 5; poll += 1) {
      const { polled, took } = await pollWithin(adapter, sqlite, clock);
      // The second run starts at 4 seconds, with 1 left, and ends at 8.
      expect(took).toBe(READ_BUDGET_MS + 3_000);
      states.push(polled.health.state);
      clock.advance(2_000);
    }
    expect(states).toEqual(["searching", "searching", "searching", "searching", "ok"]);
    expect(READ_BUDGET_MS + 4_000).toBeLessThan(POLL_DEADLINE_MS);
  });

  test("a profile cut short keeps its last read, says nothing of it, and is read first on the next poll", async () => {
    const { files, sqlite } = hermesHome();
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    const shown = (sessions: { id: string; name: string }[]) =>
      sessions.map((session) => [session.id, session.name]);
    const before = await adapter.poll();
    expect(shown(before.sessions)).toEqual([
      [`hermes-agent:default/${A}`, "Rename the helper"],
      [`hermes-agent:coder/${B}`, "Write the notes"],
    ]);

    // Both databases change, and each run of sqlite3 now takes 2 seconds: the
    // default profile is read in 4, and the coder profile's probe, given the 1
    // left, is cut short at 5.
    writeRollbackDatabase(files, DEFAULT_DATABASE);
    writeRollbackDatabase(files, PROFILE_DATABASE);
    sqlite.set(PROFILE_DATABASE, [answerRow({ id: C, title: "Tidy the tests" })]);
    sqlite.slowly({ clock, takesMs: 2_000 });
    clock.advance(2_000);
    const { polled: cut, took, runs } = await pollWithin(adapter, sqlite, clock);
    expect(took).toBe(READ_BUDGET_MS);
    expect(runs.map((run) => [run.kind, run.database, run.timeoutMs])).toEqual([
      ["probe", DEFAULT_DATABASE, SQLITE_TIMEOUT_MS],
      ["query", DEFAULT_DATABASE, 3_000],
      ["probe", PROFILE_DATABASE, 1_000],
    ]);
    expect(cut.health).toMatchObject({
      state: "ok",
      detail: HEALTHY,
      parts: { "hermes-agent:default/": BASIS, "hermes-agent:coder/": BASIS },
    });
    expect(cut.health).not.toHaveProperty("advice");
    expect(cut.basis).toBe(BASIS);
    expect(shown(cut.sessions)).toEqual(shown(before.sessions));

    // A fast sqlite3 again, 2 seconds on, with both changed once more: the
    // coder profile is read first, and its new rows are shown.
    writeRollbackDatabase(files, DEFAULT_DATABASE);
    writeRollbackDatabase(files, PROFILE_DATABASE);
    sqlite.slowly(undefined);
    clock.advance(2_000);
    const from = sqlite.runs.length;
    const after = await adapter.poll();
    expect(sqlite.runs.slice(from).map((run) => run.database)).toEqual([
      PROFILE_DATABASE,
      PROFILE_DATABASE,
      DEFAULT_DATABASE,
      DEFAULT_DATABASE,
    ]);
    expect(after.health).toMatchObject({ state: "ok", detail: HEALTHY });
    expect(shown(after.sessions)).toEqual([
      [`hermes-agent:default/${A}`, "Rename the helper"],
      [`hermes-agent:coder/${C}`, "Tidy the tests"],
    ]);
  });

  test("a profile cut short with no earlier read has no part and no sessions, and nothing is said of it", async () => {
    const { files, sqlite } = hermesHome();
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    const clock = handClock();
    // The default profile is read in 4 seconds, and the coder profile's probe is cut short at 5.
    sqlite.slowly({ clock, takesMs: 2_000 });
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    const { polled, took } = await pollWithin(adapter, sqlite, clock);
    expect(took).toBe(READ_BUDGET_MS);
    expect(polled.health).toMatchObject({
      state: "ok",
      detail: HEALTHY,
      parts: { "hermes-agent:default/": BASIS },
    });
    expect(polled.sessions.map((session) => session.id)).toEqual([`hermes-agent:default/${A}`]);

    clock.advance(2_000);
    const next = await adapter.poll();
    expect(next.health.parts).toEqual({
      "hermes-agent:default/": BASIS,
      "hermes-agent:coder/": BASIS,
    });
    expect(next.sessions).toHaveLength(2);
  });

  test("when the only database is cut short on the first poll, the card is still searching, not without a database, and the next poll with time reads it", async () => {
    const { files, sqlite, clock, adapter } = slowWalHome();
    const { polled, took, runs } = await pollWithin(adapter, sqlite, clock);
    expect(took).toBe(READ_BUDGET_MS);
    // The keg's version, given the 2 seconds left, is cut short.
    expect(runs.map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["version", SQLITE_TIMEOUT_MS],
      ["version", 2_000],
    ]);
    expect(polled.health).toEqual({
      id: "hermes-agent",
      label: "Hermes Agent",
      state: "searching",
      detail: "Hermes Agent's databases in ~/.hermes are still being read.",
      watching: watching("every 2 seconds", { profiles: "default" }),
      checkedAt: NOW,
    });
    expect(polled.basis).toBeUndefined();
    expect(polled.sessions).toEqual([]);
    expect(files.count("stat")).toBe(1);

    sqlite.slowly(undefined);
    clock.advance(2_000);
    const next = await adapter.poll();
    expect(next.health).toMatchObject({ state: "ok", detail: HEALTHY });
    expect(fact(next.health, "sqlite3 for a live -wal")).toBe(`${KEG} 3.53.0`);
    expect(next.sessions).toHaveLength(1);
    // The keg was asked again, as nothing was learned of it.
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", KEG, KEG]);
  });

  test("with Agent Lookout's setting, the only database cut short on the first poll is still being read, not a folder with no database", async () => {
    const env = { AGENT_LOOKOUT_HERMES_HOME: ROOT };
    const { files, sqlite, clock, adapter } = slowWalHome({ env });
    const { polled, took } = await pollWithin(adapter, sqlite, clock);
    expect(took).toBe(READ_BUDGET_MS);
    expect(polled.health).toMatchObject({
      state: "searching",
      detail: "Hermes Agent's databases in ~/.hermes are still being read.",
    });
    expect(polled.health).not.toHaveProperty("parts");
    expect(polled.basis).toBeUndefined();
    expect(polled.sessions).toEqual([]);
    expect(files.count("stat")).toBe(0);

    sqlite.slowly(undefined);
    clock.advance(2_000);
    const next = await adapter.poll();
    expect(next.health).toMatchObject({ state: "ok", detail: HEALTHY });
    expect(next.sessions.map((session) => session.id)).toEqual([`hermes-agent:default/${A}`]);
  });

  test("a profile whose last read failed, cut short when it is due again, is still named as not read, and is read on the next poll with time", async () => {
    const { files, sqlite } = hermesHome();
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    sqlite.fail(PROFILE_DATABASE);
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    const notRead = `${HEALTHY} Not read: the coder profile, because sqlite3 could not read it.`;
    expect((await adapter.poll()).health.detail).toBe(notRead);

    // 10 seconds on, the coder profile is due again. The default profile has
    // changed, and each run now takes 2 seconds, so the coder profile's probe
    // is given the 1 second left and cut short.
    sqlite.fail(PROFILE_DATABASE, false);
    writeRollbackDatabase(files, DEFAULT_DATABASE);
    sqlite.slowly({ clock, takesMs: 2_000 });
    clock.advance(RETRY_MS);
    const { polled: cut, took, runs } = await pollWithin(adapter, sqlite, clock);
    expect(took).toBe(READ_BUDGET_MS);
    expect(runs.at(-1)).toMatchObject({
      kind: "probe",
      database: PROFILE_DATABASE,
      timeoutMs: 1_000,
    });
    expect(cut.health).toMatchObject({ state: "ok", detail: notRead });
    expect(cut.health.parts).toEqual({ "hermes-agent:default/": BASIS });
    expect(cut.sessions.map((session) => session.id)).toEqual([`hermes-agent:default/${A}`]);

    sqlite.slowly(undefined);
    clock.advance(2_000);
    const after = await adapter.poll();
    expect(after.health).toMatchObject({ state: "ok", detail: HEALTHY });
    expect(after.sessions.map((session) => session.id)).toEqual([
      `hermes-agent:default/${A}`,
      `hermes-agent:coder/${B}`,
    ]);
  });

  test("the only database, whose last read failed, cut short: the card is the error it was, not searching", async () => {
    const { sqlite, clock, adapter } = slowWalHome();
    sqlite.slowly(undefined);
    sqlite.fail();
    const failed = await adapter.poll();
    expect(failed.health).toMatchObject({
      state: "error",
      detail:
        "sqlite3 could not read Hermes Agent's database, ~/.hermes/state.db, so no Hermes Agent sessions are listed. Agent Lookout tries again when it changes, or 10 seconds on.",
    });

    // 10 seconds on, Homebrew's sqlite3 has been updated, so its version is
    // asked first, and the probe after it is cut short.
    sqlite.fail(undefined, false);
    sqlite.install(KEG, "3.53.0");
    sqlite.slowly({ clock, takesMs: 3_000 });
    clock.advance(RETRY_MS);
    const { polled: cut, took, runs } = await pollWithin(adapter, sqlite, clock);
    expect(took).toBe(READ_BUDGET_MS);
    expect(runs.map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["version", SQLITE_TIMEOUT_MS],
      ["probe", 2_000],
    ]);
    expect(cut.health).toMatchObject({ state: "error", detail: failed.health.detail });
    expect(cut.sessions).toEqual([]);
  });

  test("a sqlite3 that does not answer in its whole 5 seconds, as a poll's first run, did not work: the card says so, it is asked again only 10 seconds on, and the next profile is read on the next poll", async () => {
    const { files } = hermesHome();
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    const clock = handClock();
    // sqlite3 never answers on the default profile's database, and is stopped at its timeout.
    const hung = standInSqlite(
      {
        [DEFAULT_DATABASE]: [answerRow({ id: A })],
        [PROFILE_DATABASE]: [answerRow({ id: B, title: "Write the notes" })],
      },
      {
        onRun: (database, _query, timeoutMs) => {
          if (database === DEFAULT_DATABASE) clock.advance(timeoutMs ?? SQLITE_TIMEOUT_MS);
        },
      },
    );
    hung.fail(DEFAULT_DATABASE);
    const adapter = hermesAgentAdapterFor(files, hung, { now: clock.now });
    const defaultProbes = () =>
      hung.probes().filter((run) => run.database === DEFAULT_DATABASE).length;
    const seen: [string, string[], number][] = [];
    for (let poll = 0; poll < 4; poll += 1) {
      const { polled, took } = await pollWithin(adapter, hung, clock);
      expect(took).toBeLessThanOrEqual(READ_BUDGET_MS);
      seen.push([
        polled.health.state,
        polled.sessions.map((session) => session.id),
        defaultProbes(),
      ]);
      if (poll === 0) {
        expect(polled.health.detail).toBe(
          "sqlite3 could not read Hermes Agent's database, ~/.hermes/state.db, so no Hermes Agent sessions are listed. Agent Lookout tries again when it changes, or 10 seconds on.",
        );
      } else {
        expect(polled.health.detail).toBe(
          `${HEALTHY} Not read: the default profile, because sqlite3 could not read it.`,
        );
      }
      clock.advance(2_000);
    }
    expect(seen).toEqual([
      // Its probe had the whole 5 seconds, and the coder profile is left for the next poll.
      ["error", [], 1],
      // The next poll starts with the coder profile. The default profile is not due.
      ["ok", [`hermes-agent:coder/${B}`], 1],
      ["ok", [`hermes-agent:coder/${B}`], 1],
      // Due again 10 seconds after it failed, and the coder profile keeps its read.
      ["ok", [`hermes-agent:coder/${B}`], 2],
    ]);
  });

  test("a sqlite3 that does not print its version in its whole 5 seconds is taken as printing none, and the next place is asked on the next poll, once", async () => {
    const files = memoryFiles();
    writeLiveWalDatabase(files, DEFAULT_DATABASE);
    const clock = handClock();
    const sqlite = standInSqlite({ [DEFAULT_DATABASE]: [answerRow({ id: A })] });
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install("/bin/sqlite3", null);
    sqlite.install(KEG, "3.53.0");
    // /bin/sqlite3 never answers its version, and is stopped at its timeout.
    const runVersion = async (candidate: string, timeoutMs: number) => {
      if (candidate !== "/bin/sqlite3") return sqlite.runVersion(candidate, timeoutMs);
      sqlite.versionRuns.push(candidate);
      clock.advance(timeoutMs);
      return { ok: false as const };
    };
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now, runVersion });
    const seen: [string, number, string | undefined][] = [];
    for (let poll = 0; poll < 3; poll += 1) {
      const started = clock.now();
      const polled = await adapter.poll();
      expect(clock.now() - started).toBeLessThanOrEqual(READ_BUDGET_MS);
      seen.push([
        polled.health.state,
        polled.sessions.length,
        fact(polled.health, "sqlite3 for a live -wal"),
      ]);
      clock.advance(2_000);
    }
    expect(seen).toEqual([
      ["searching", 0, "not needed yet"],
      ["ok", 1, `${KEG} 3.53.0`],
      ["ok", 1, `${KEG} 3.53.0`],
    ]);
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", "/bin/sqlite3", KEG]);
  });

  test.each<[string, number, string[]]>([
    ["never answers", 30_000, ["probe"]],
    ["takes 3 seconds a question, too long for both in one poll", 3_000, ["probe", "query"]],
  ])(
    "the only database, with a sqlite3 that %s, is said not to be read on every poll from the first, never as still being read, and is asked again only every 10 seconds",
    async (_slowness, takesMs, asked) => {
      const { files, sqlite } = hermesHome([answerRow({ id: A })], null);
      const clock = handClock();
      sqlite.slowly({ clock, takesMs });
      const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
      const seen: string[][] = [];
      for (let poll = 0; poll < 7; poll += 1) {
        const { polled, took, runs } = await pollWithin(adapter, sqlite, clock);
        expect(took).toBeLessThanOrEqual(READ_BUDGET_MS);
        expect(polled.health).toMatchObject({
          state: "error",
          detail:
            "sqlite3 could not read Hermes Agent's database, ~/.hermes/state.db, so no Hermes Agent sessions are listed. Agent Lookout tries again when it changes, or 10 seconds on.",
        });
        expect(polled.sessions).toEqual([]);
        seen.push(runs.map((run) => run.kind));
        clock.advance(2_000);
      }
      // The polls start 0, 7, 9, 11, 18, 20 and 22 seconds in: due again 10
      // seconds after each start that asked.
      expect(seen).toEqual([asked, [], [], asked, [], [], asked]);
    },
  );

  test("a /usr/bin/sqlite3 that never prints its version is asked once, as a poll's first run, and Homebrew's own is chosen on the next poll and every one after", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const sqlite = standInSqlite({ [DEFAULT_DATABASE]: [answerRow({ id: A })] });
    sqlite.install("/usr/bin/sqlite3", null);
    sqlite.install(KEG, "3.53.0");
    // /usr/bin/sqlite3 never answers --version, and is stopped at its timeout.
    const asked: [string, number][] = [];
    const runVersion = async (candidate: string, timeoutMs: number) => {
      asked.push([candidate, timeoutMs]);
      if (candidate !== "/usr/bin/sqlite3") return sqlite.runVersion(candidate, timeoutMs);
      clock.advance(timeoutMs);
      return { ok: false as const };
    };
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now, runVersion });
    const seen: [string, number, string | undefined][] = [];
    for (let poll = 0; poll < 6; poll += 1) {
      // Hermes Agent writes to its live -wal before every poll, so a sqlite3 is picked on each.
      writeLiveWalDatabase(files, DEFAULT_DATABASE);
      const started = clock.now();
      const polled = await adapter.poll();
      expect(clock.now() - started).toBeLessThanOrEqual(READ_BUDGET_MS);
      seen.push([
        polled.health.state,
        polled.sessions.length,
        fact(polled.health, "sqlite3 for a live -wal"),
      ]);
      clock.advance(2_000);
    }
    expect(seen).toEqual([
      // Its whole 5 seconds are the poll's, so Homebrew's is left for the next.
      ["searching", 0, "not needed yet"],
      ...Array.from({ length: 5 }, () => ["ok", 1, `${KEG} 3.53.0`]),
    ]);
    expect(asked).toEqual([
      ["/usr/bin/sqlite3", SQLITE_TIMEOUT_MS],
      [KEG, SQLITE_TIMEOUT_MS],
    ]);
    expect(sqlite.queries()).toHaveLength(5);
  });

  test("a read whose two questions do not fit in a poll's 5 seconds, though each fits its own, did not work: the card says so, and it is asked again 10 seconds on", async () => {
    const { files, sqlite } = hermesHome([answerRow({ id: A })], null);
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);

    // The database grows, and each question now takes 3 seconds.
    writeRollbackDatabase(files, DEFAULT_DATABASE);
    sqlite.set(DEFAULT_DATABASE, [
      answerRow({ id: A }),
      answerRow({ id: B, title: "Write the notes" }),
    ]);
    sqlite.slowly({ clock, takesMs: 3_000 });
    const states: [string, number, number][] = [];
    for (let poll = 0; poll < 6; poll += 1) {
      clock.advance(2_000);
      const { polled, took, runs } = await pollWithin(adapter, sqlite, clock);
      expect(took).toBeLessThanOrEqual(READ_BUDGET_MS);
      states.push([polled.health.state, polled.sessions.length, runs.length]);
      if (polled.health.state === "error") {
        expect(polled.health.detail).toBe(
          "sqlite3 could not read Hermes Agent's database, ~/.hermes/state.db, so no Hermes Agent sessions are listed. Agent Lookout tries again when it changes, or 10 seconds on.",
        );
      }
      // Quick again once it has failed.
      if (poll === 0) sqlite.slowly(undefined);
    }
    expect(states).toEqual([
      // The probe has the whole 5 seconds, and the query the 2 left after it.
      ["error", 0, 2],
      // The next polls start 7 and 9 seconds after that poll did: not due.
      ["error", 0, 0],
      ["error", 0, 0],
      // 11 seconds after, it is asked again, and read.
      ["ok", 2, 2],
      ["ok", 2, 0],
      ["ok", 2, 0],
    ]);
  });

  test("the next poll starts with the profile the last one ran out of time at, so one slow profile cannot keep another from ever being read", async () => {
    const { files, sqlite } = hermesHome();
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    const clock = handClock();
    // Each run takes 2 seconds, so a read takes 4, and both databases change before every poll.
    sqlite.slowly({ clock, takesMs: 2_000 });
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    const queried: (string | null)[][] = [];
    for (let poll = 0; poll < 4; poll += 1) {
      writeRollbackDatabase(files, DEFAULT_DATABASE);
      writeRollbackDatabase(files, PROFILE_DATABASE);
      const { polled, took, runs } = await pollWithin(adapter, sqlite, clock);
      expect(took).toBe(READ_BUDGET_MS);
      expect(polled.health).toMatchObject({ state: "ok", detail: HEALTHY });
      queried.push(runs.filter((run) => run.kind === "query").map((run) => run.database));
      clock.advance(2_000);
    }
    expect(queried).toEqual([
      [DEFAULT_DATABASE],
      [PROFILE_DATABASE],
      [DEFAULT_DATABASE],
      [PROFILE_DATABASE],
    ]);
  });

  test("a clock set back while the reads run gives no run of sqlite3 more than its own 5 seconds", async () => {
    const files = memoryFiles();
    writeLiveWalDatabase(files, DEFAULT_DATABASE);
    writeRollbackDatabase(files, PROFILE_DATABASE);
    files.mkdir(`${ROOT}/profiles/${PROFILE}`);
    const clock = handClock();
    // Each probe and query sets the clock back a minute, so more than 5 seconds seem left.
    const sqlite = standInSqlite(
      {
        [DEFAULT_DATABASE]: [answerRow({ id: A })],
        [PROFILE_DATABASE]: [answerRow({ id: B, title: "Write the notes" })],
      },
      { onRun: () => clock.advance(-MINUTE) },
    );
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    const { health, sessions } = await hermesAgentAdapterFor(files, sqlite, {
      now: clock.now,
    }).poll();
    expect(health).toMatchObject({ state: "ok", detail: HEALTHY });
    expect(sessions).toHaveLength(2);
    expect(clock.now()).toBe(NOW - 4 * MINUTE);
    expect(sqlite.timed.map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["version", SQLITE_TIMEOUT_MS],
      ["version", SQLITE_TIMEOUT_MS],
      ["probe", SQLITE_TIMEOUT_MS],
      ["query", SQLITE_TIMEOUT_MS],
      ["probe", SQLITE_TIMEOUT_MS],
      ["query", SQLITE_TIMEOUT_MS],
    ]);
  });

  test("a poll with time to spare gives every run of sqlite3 its whole 5 seconds", async () => {
    const files = memoryFiles();
    writeLiveWalDatabase(files, DEFAULT_DATABASE);
    writeRollbackDatabase(files, PROFILE_DATABASE);
    const sqlite = standInSqlite({
      [DEFAULT_DATABASE]: [answerRow({ id: A })],
      [PROFILE_DATABASE]: [answerRow({ id: B, title: "Write the notes" })],
    });
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    // The clock does not move.
    const { health, sessions } = await hermesAgentAdapterFor(files, sqlite).poll();
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(2);
    expect(SQLITE_TIMEOUT_MS).toBe(5_000);
    expect(sqlite.timed.map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["version", SQLITE_TIMEOUT_MS],
      ["version", SQLITE_TIMEOUT_MS],
      ["probe", SQLITE_TIMEOUT_MS],
      ["query", SQLITE_TIMEOUT_MS],
      ["probe", SQLITE_TIMEOUT_MS],
      ["query", SQLITE_TIMEOUT_MS],
    ]);
  });

  test("never opens a file of Hermes Agent's but the first 20 bytes of each database, nor looks at any but the root, its profiles and their three database files", async () => {
    const { files, sqlite } = hermesHome();
    // Hermes Agent's other files, as it lays them out in its root and a profile's folder.
    for (const other of [
      ".env",
      "auth.json",
      "config.yaml",
      "SOUL.md",
      "active_profile",
      "gateway.pid",
      "gateway_state.json",
      "kanban.db",
      "memories/MEMORY.md",
      "memories/USER.md",
      "sessions/sessions.json",
      `sessions/${A}.jsonl`,
      "runtime/active_sessions.json",
      "logs/gateway.log",
      "cron/jobs.json",
      `profiles/${PROFILE}/auth.json`,
      `profiles/${PROFILE}/.env`,
      `profiles/${PROFILE}/config.yaml`,
      `profiles/${PROFILE}/runtime/active_sessions.json`,
    ]) {
      files.write(`${ROOT}/${other}`, "placeholder");
    }
    files.mkdir(`${ROOT}/profiles/.deleted/old`);
    files.forget();
    const clock = handClock();
    const adapter = hermesAgentAdapterFor(files, sqlite, { now: clock.now });
    await adapter.poll();
    clock.advance(RECHECK_MS);
    await adapter.poll();

    expect(new Set(files.opened())).toEqual(new Set([DEFAULT_DATABASE, PROFILE_DATABASE]));
    expect(files.reads.every((read) => read.position === 0 && read.length === 20)).toBe(true);
    const looked = new Set(files.calls.map((call) => `${call.method} ${call.path}`));
    expect(looked).toEqual(
      new Set([
        `stat ${ROOT}`,
        `readdir ${ROOT}/profiles`,
        `lstat ${ROOT}/profiles/${PROFILE}`,
        ...[DEFAULT_DATABASE, PROFILE_DATABASE].flatMap((database) => [
          `lstat ${database}`,
          `lstat ${database}-wal`,
          `lstat ${database}-shm`,
          `openRegular ${database}`,
        ]),
      ]),
    );
    // sqlite3 was given only the two databases, and only the fixed questions.
    expect(new Set(sqlite.runs.map((run) => run.database))).toEqual(
      new Set([DEFAULT_DATABASE, PROFILE_DATABASE]),
    );
    expect(sqlite.queries().every((run) => run.args.at(-1) === SESSIONS_QUERY)).toBe(true);
  });
});

test("what Hermes Agent can report, in the words of the design, each reason short enough for its tooltip", () => {
  expect(HERMES_AGENT_CAPABILITIES).toEqual({
    "working-and-idle": {
      level: "partly",
      reason:
        "Read from Hermes Agent's turn leases with sqlite3 on macOS and Linux. Nothing of Hermes Agent's is read on Windows.",
    },
    "needs-you": {
      level: "partly",
      reason:
        "From an open question, and from an approval label Hermes Agent saves at most once a minute, so that wait shows late.",
    },
    finished: {
      level: "partly",
      reason:
        "When Hermes Agent ends a session. One whose process was killed, or whose gateway stopped, shows as idle.",
    },
    failed: {
      level: "partly",
      reason:
        "When a turn ends on an error Hermes Agent records. One that overflows the model's context shows as idle.",
    },
    names: { level: "yes" },
    jump: {
      level: "no",
      reason:
        "Hermes Agent's database names no terminal or tab, and its turns run in a gateway shared by other sessions.",
    },
    "quiet-for": {
      level: "no",
      reason:
        "Hermes Agent keeps every session in one database, so no file shows when one session was last written.",
    },
    tokens: { level: "no", reason: "Agent Lookout does not read Hermes Agent's token counts yet." },
    stop: {
      level: "no",
      reason:
        "A Hermes Agent turn runs in a gateway process other sessions share, so no session can be stopped alone.",
    },
    answer: {
      level: "no",
      reason:
        "Hermes Agent keeps approvals and questions in its own memory, and Agent Lookout does not talk to its gateway.",
    },
  });
  expect(UNCHECKED_NOTE).toBe(
    "This was built from Hermes Agent v0.22.5's source and not yet checked on a computer running Hermes Agent, so a status can be wrong.",
  );
  expect(LATE_NOTE).toContain("at most once a minute");
  expect(createHermesAgentAdapter({ env: {}, homeDir: HOME, platform: "win32" }).capabilities).toBe(
    HERMES_AGENT_CAPABILITIES,
  );
});
