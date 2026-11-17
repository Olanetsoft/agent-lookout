import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { AdapterResult } from "@collector/adapters/adapter";
import {
  BASIS,
  BASIS_WITHOUT_LEASES,
  BASIS_WITHOUT_PROCESSES,
  NEWER_FORMAT_NOTE,
  PRIME_AGENT_CAPABILITIES,
  PRIME_AGENT_PROFILE,
  primeAgentAgentDirFor,
  primeAgentSessionsDirFor,
  STATUS_NOTE,
  UNCHECKED_NOTE,
  WINDOWS_NOTE,
} from "@collector/adapters/prime-agent/index";
import {
  AGENT_DIR,
  checkpoint,
  conversationLines,
  DAY,
  HOME,
  HOUR,
  iso,
  journalOf,
  LEASE_TOKEN,
  LEASES_DIR,
  leaseOf,
  line,
  lstartOf,
  MINUTE,
  nameLine,
  NOW,
  OTHER_HASH,
  ownerOf,
  ownerText,
  PID,
  PRIVATE_FOLDER,
  PRIVATE_WORDS,
  PROC_START_ID,
  PROCESS_STARTED_AT,
  PROJECT,
  queueLine,
  recordLine,
  SECOND,
  SESSION_FILE,
  SESSION_ID,
  sessionFileOf,
  sessionIdOf,
  SESSIONS_DIR,
  sessionText,
  START_TICKS,
  STARTED_AT,
  statLine,
  supervisorConfigText,
  WORKER_ID,
  WORKER_SECRET,
  workerIdOf,
  workerRecordOf,
  workerRecordText,
  WORKERS_DIR,
  workersFolderOf,
} from "@tests/fixtures/prime-agent/primeAgent";
import {
  handClock,
  primeAgentAdapterFor,
  primeAgentFiles,
  standInAlive,
  standInProc,
  standInPs,
  type PrimeAgentFiles,
} from "@tests/support/adapters/prime-agent/primeAgentAdapter";
import { asWritten } from "@tests/support/paths";

const NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const READ_DETAIL = `Sessions are read from the files Prime Agent keeps in ~/.prime/agent/sessions. ${NOTES}`;
const JOURNAL = journalOf();

/** The stand-ins of a computer on which the lease's process runs and is `prime-agent`. */
function machine(platform: NodeJS.Platform = "darwin") {
  const clock = handClock(NOW);
  const alive = standInAlive([PID]);
  const ps = standInPs(
    new Map([
      [PID, { lstart: lstartOf(PROCESS_STARTED_AT), program: "/opt/demo/bin/prime-agent" }],
    ]),
  );
  const proc = standInProc(new Map([[`/proc/${PID}/stat`, statLine(PID, START_TICKS)]]));
  return { clock, alive, ps, proc, platform };
}

type Machine = ReturnType<typeof machine>;

function adapterOn(files: PrimeAgentFiles, at: Machine, env: NodeJS.ProcessEnv = {}) {
  return primeAgentAdapterFor(files, {
    env,
    now: at.clock.now,
    platform: at.platform,
    isAlive: at.alive.isAlive,
    runPs: at.ps.run,
    readProcFile: at.proc.readProcFile,
  });
}

/** One session, its lease, its worker's record and its journal, with whatever `journal` holds. */
function heldSession(
  journal: string,
  owner: Parameters<typeof ownerText>[1] = {},
  clock = () => NOW,
) {
  const files = primeAgentFiles(clock);
  files.write(SESSION_FILE, sessionText(SESSION_ID), { mtimeMs: NOW - MINUTE });
  files.write(ownerOf(1), ownerText(SESSION_ID, owner));
  files.write(workerRecordOf(), workerRecordText());
  files.write(`${workersFolderOf()}/supervisor-config`, supervisorConfigText());
  files.write(JOURNAL, journal);
  return files;
}

const recordAt = (seconds: number, operation: string, busy: boolean) =>
  recordLine({ busy, operation, at: STARTED_AT + seconds * SECOND });

const checkpointAt = (seconds: number, operation: string, busy: boolean, suspended = false) =>
  checkpoint({ busy, operation, at: STARTED_AT + seconds * SECOND }, suspended);

async function statusOf(files: PrimeAgentFiles, at = machine()) {
  const result = await adapterOn(files, at).poll();
  return { result, session: result.sessions[0], at };
}

describe("where it looks", () => {
  test("in ~/.prime/agent/sessions, with leases and journals in ~/.prime/agent, on every system", () => {
    expect(asWritten(primeAgentSessionsDirFor({}, HOME))).toBe(SESSIONS_DIR);
    expect(asWritten(primeAgentAgentDirFor({}, HOME))).toBe(AGENT_DIR);
  });

  test("in its own sessions variable, then the older name, then its agent folder's", () => {
    const sessions = (env: NodeJS.ProcessEnv) => asWritten(primeAgentSessionsDirFor(env, HOME));
    expect(sessions({ PRIME_AGENT_SESSION_DIR: "/data/sessions" })).toBe("/data/sessions");
    expect(sessions({ PRIME_AGENT_CODING_AGENT_SESSION_DIR: "/data/old" })).toBe("/data/old");
    expect(
      sessions({
        PRIME_AGENT_SESSION_DIR: "/data/new",
        PRIME_AGENT_CODING_AGENT_SESSION_DIR: "/data/old",
      }),
    ).toBe("/data/new");
    expect(sessions({ PRIME_AGENT_CODING_AGENT_DIR: "/data/agent" })).toBe("/data/agent/sessions");
    expect(sessions({ PRIME_AGENT_SESSION_DIR: "~/elsewhere" })).toBe(`${HOME}/elsewhere`);
    // A relative folder is each process's own, and is passed over.
    expect(
      sessions({
        PRIME_AGENT_SESSION_DIR: "relative",
        PRIME_AGENT_CODING_AGENT_SESSION_DIR: "/data/old",
      }),
    ).toBe("/data/old");
    expect(
      sessions({ AGENT_LOOKOUT_PRIME_AGENT_HOME: "/lookout", PRIME_AGENT_SESSION_DIR: "/data" }),
    ).toBe("/lookout/sessions");
  });

  test("moves the agent folder with its own variable, and never with the sessions variables", () => {
    const agent = (env: NodeJS.ProcessEnv) => asWritten(primeAgentAgentDirFor(env, HOME));
    expect(agent({ PRIME_AGENT_SESSION_DIR: "/data/sessions" })).toBe(AGENT_DIR);
    expect(agent({ PRIME_AGENT_CODING_AGENT_SESSION_DIR: "/data/old" })).toBe(AGENT_DIR);
    expect(agent({ PRIME_AGENT_CODING_AGENT_DIR: "/data/agent" })).toBe("/data/agent");
    expect(agent({ PRIME_AGENT_CODING_AGENT_DIR: "relative" })).toBe(AGENT_DIR);
    expect(
      agent({
        AGENT_LOOKOUT_PRIME_AGENT_HOME: " /lookout ",
        PRIME_AGENT_CODING_AGENT_DIR: "/data",
      }),
    ).toBe("/lookout");
  });

  test("not finding its folder, it says so, runs nothing, and looks again a minute later", async () => {
    const files = primeAgentFiles();
    const at = machine();
    const adapter = adapterOn(files, at);
    const first = await adapter.poll();
    expect(first.health).toMatchObject({
      state: "unavailable",
      detail:
        "Prime Agent was not found: there is no ~/.prime/agent/sessions folder. Agent Lookout looks again every minute.",
    });
    files.forget();
    at.clock.advance(30 * SECOND);
    await adapter.poll();
    expect(files.calls).toEqual([]);
    expect(at.ps.runs).toEqual([]);
    expect(at.alive.asked).toEqual([]);
  });

  test("with AGENT_LOOKOUT_PRIME_AGENT_HOME naming a folder with nothing in it, that is an answer, on Windows too", async () => {
    const result = await adapterOn(primeAgentFiles(), machine("win32"), {
      AGENT_LOOKOUT_PRIME_AGENT_HOME: "/tmp/empty-prime-agent",
    }).poll();
    expect(result.health.state).toBe("ok");
    expect(result.basis).toBe(BASIS);
  });
});

describe("its sessions", () => {
  test("come from each file's header and name lines, and nothing else of the file", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    files.append(SESSION_FILE, nameLine("demo name"));
    files.write(
      `${SESSIONS_DIR}/${SESSION_ID}.info-cache.json`,
      JSON.stringify({ first: PRIVATE_WORDS }),
    );
    files.write(`${SESSIONS_DIR}/${SESSION_ID}.window-cache.json`, "{}");
    const { result, session } = await statusOf(files);
    expect(session).toMatchObject({
      id: `prime-agent:${SESSION_ID}`,
      source: "prime-agent",
      surface: "unknown",
      name: "demo name",
      cwd: PROJECT,
      project: "demo-project",
      startedAt: STARTED_AT,
      links: {},
    });
    expect(session).not.toHaveProperty("pid");
    expect(JSON.stringify(result)).not.toContain(PRIVATE_WORDS);
    expect(files.opened().filter((one) => one.includes("cache"))).toEqual([]);
  });

  test("with no name line take the folder's name, and the first message stays in its sidecar, unopened", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    files.write(
      `${SESSIONS_DIR}/${SESSION_ID}.info-cache.json`,
      JSON.stringify({ first: PRIVATE_WORDS }),
    );
    const { session } = await statusOf(files);
    expect(session?.name).toBe("demo-project");
  });

  test("are listed whatever their header's parent, and a newer format is left out", async () => {
    const files = primeAgentFiles();
    files.write(
      sessionFileOf(sessionIdOf(1)),
      line({
        type: "session",
        version: 3,
        id: sessionIdOf(1),
        timestamp: iso(STARTED_AT),
        cwd: PROJECT,
        parentSession: `${SESSIONS_DIR}/x.jsonl`,
        rlmDepth: 0,
      }),
    );
    files.write(
      sessionFileOf(sessionIdOf(2)),
      line({
        type: "session",
        version: 4,
        id: sessionIdOf(2),
        timestamp: iso(STARTED_AT),
        cwd: PROJECT,
      }),
    );
    files.mkdir(LEASES_DIR);
    const { result } = await statusOf(files);
    expect(result.sessions.map(({ id }) => id)).toEqual([`prime-agent:${sessionIdOf(1)}`]);
    expect(result.health.detail).toContain(NEWER_FORMAT_NOTE);
  });
});

describe("who holds a session", () => {
  test("H1: no lease names it, so it is finished at its file's last write", async () => {
    const files = primeAgentFiles();
    files.write(SESSION_FILE, sessionText(SESSION_ID), { mtimeMs: NOW - MINUTE });
    files.write(ownerOf(2), ownerText(sessionIdOf(2)));
    const { result, session, at } = await statusOf(files);
    expect(session).toMatchObject({ status: "finished", statusSince: NOW - MINUTE });
    expect(result.basis).toBe(BASIS);
    expect(result.health.detail).toBe(READ_DETAIL);
    // The other lease's process is no listed session's, and is not asked about.
    expect(at.alive.asked).toEqual([]);
  });

  test("a session's file need not be named for its ID: its lease and its records are matched by the file's name", async () => {
    const file = `${SESSIONS_DIR}/demo-project.jsonl`;
    const files = primeAgentFiles();
    files.write(file, sessionText(SESSION_ID), { mtimeMs: NOW - MINUTE });
    files.write(ownerOf(1), ownerText(SESSION_ID, { sessionPath: file }));
    files.write(workerRecordOf(), workerRecordText());
    files.write(
      JOURNAL,
      checkpoint({
        busy: true,
        operation: "prompt_accepted",
        at: STARTED_AT + 2 * SECOND,
        sessionFile: file,
      }),
    );
    const { session } = await statusOf(files);
    expect(session).toMatchObject({
      id: `prime-agent:${SESSION_ID}`,
      status: "working",
      statusSince: STARTED_AT + 2 * SECOND,
    });
  });

  test("a lease that names a file no listed session has is passed over, whatever the file's name", async () => {
    const files = primeAgentFiles();
    files.write(SESSION_FILE, sessionText(SESSION_ID), { mtimeMs: NOW - MINUTE });
    files.write(
      ownerOf(2),
      ownerText(sessionIdOf(2), { sessionPath: "/Users/example/code/demo/scratch notes.jsonl" }),
    );
    const { result, session } = await statusOf(files);
    expect(session).toMatchObject({ status: "finished", statusSince: NOW - MINUTE });
    expect(result.basis).toBe(BASIS);
    expect(result.health.detail).toBe(READ_DETAIL);
  });

  test("H3: its lease's process has gone, so it is finished, whatever its journal says", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    const at = machine();
    at.alive.alive.clear();
    const { session } = await statusOf(files, at);
    expect(session?.status).toBe("finished");
    expect(files.opened()).not.toContain(JOURNAL);
    expect(at.ps.runs).toEqual([]);
  });

  test("H2: with no leases folder, a link there, or one that cannot be listed, it is unknown", async () => {
    for (const change of [
      (files: PrimeAgentFiles) => files.remove(LEASES_DIR),
      (files: PrimeAgentFiles) => {
        files.remove(LEASES_DIR);
        files.special(LEASES_DIR);
      },
      (files: PrimeAgentFiles) => files.fail(LEASES_DIR),
    ]) {
      const files = heldSession(checkpointAt(2, "prompt_accepted", true));
      change(files);
      const { result, session } = await statusOf(files);
      expect(session).toMatchObject({ status: "unknown", statusSince: null });
      expect(result.basis).toBe(BASIS_WITHOUT_LEASES);
      expect(result.health.detail).toBe(
        `${READ_DETAIL} ~/.prime/agent/session-leases is missing or could not be listed, so each session shows as unknown.`,
      );
    }
  });

  test("H4 and H5: on Linux, /proc tells a lease's own process, before the boot rule", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true), {
      processStartId: PROC_START_ID,
    });
    const at = machine("linux");
    const held = await adapterOn(files, at).poll();
    expect(held.sessions[0]?.status).toBe("working");
    expect(at.ps.runs).toEqual([]);
    expect(at.proc.read).toEqual([`/proc/${PID}/stat`]);
    const old = primeAgentAdapterFor(files, {
      now: at.clock.now,
      platform: "linux",
      isAlive: at.alive.isAlive,
      uptimeMs: () => SECOND,
      runPs: at.ps.run,
      readProcFile: at.proc.readProcFile,
    });
    expect((await old.poll()).sessions[0]?.status).toBe("working");
    at.proc.files.set(`/proc/${PID}/stat`, statLine(PID, "999"));
    at.clock.advance(MINUTE);
    expect((await adapterOn(files, at).poll()).sessions[0]?.status).toBe("finished");
  });

  test("H6: on a Mac, a lease with no start to compare from before the boot is gone", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true), {
      processStartId: undefined,
    });
    const at = machine();
    const adapter = primeAgentAdapterFor(files, {
      now: at.clock.now,
      isAlive: at.alive.isAlive,
      uptimeMs: () => SECOND,
      runPs: at.ps.run,
    });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    expect(at.ps.runs).toEqual([]);
  });

  test("H7, H7b and H7c: with no start to compare, ps's name for the program decides", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true), {
      processStartId: undefined,
    });
    expect((await statusOf(files)).session?.status).toBe("working");
    const other = machine();
    other.ps.processes.set(PID, { lstart: lstartOf(PROCESS_STARTED_AT), program: "/usr/bin/vim" });
    expect((await statusOf(files, other)).session?.status).toBe("unknown");
    const unlisted = machine();
    unlisted.ps.processes.clear();
    expect((await statusOf(files, unlisted)).session?.status).toBe("unknown");
  });

  test("H7c: while ps cannot be run, a held session is unknown, and the poll is named apart", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    const at = machine();
    at.ps.fail();
    const { result, session } = await statusOf(files, at);
    expect(session?.status).toBe("unknown");
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toBe(
      `${READ_DETAIL} ps could not be run to tell whether a lease's process is prime-agent, so a session it holds shows as unknown.`,
    );
  });

  test("on a Mac, a process that started at another time than its lease says is another program's", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    const at = machine();
    at.ps.processes.set(PID, {
      lstart: lstartOf(NOW - 5 * MINUTE),
      program: "/opt/demo/bin/prime-agent",
    });
    expect((await statusOf(files, at)).session?.status).toBe("finished");
  });

  test("H8: on Windows a held lease is unknown, and neither ps nor the journal is read", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true), {
      processStartId: "win:133000000000000000",
    });
    const at = machine("win32");
    const { result, session } = await statusOf(files, at);
    expect(session?.status).toBe("unknown");
    expect(result.basis).toBe(BASIS);
    expect(result.health.detail).toBe(`${READ_DETAIL} ${WINDOWS_NOTE}`);
    expect(at.ps.runs).toEqual([]);
    expect(files.count(undefined, (target) => target.includes("daemon-workers"))).toBe(0);
  });

  test("H9: a lease that cannot be read keeps a session nothing holds from finishing, unless it is older than the boot", async () => {
    const files = primeAgentFiles();
    files.write(SESSION_FILE, sessionText(SESSION_ID));
    files.write(ownerOf(1), `{"token":"${LEASE_TOKEN}`);
    const { result, session } = await statusOf(files);
    expect(session?.status).toBe("unknown");
    expect(result.basis).toBe(BASIS_WITHOUT_LEASES);
    expect(result.health.detail).toBe(
      `${READ_DETAIL} A lease in ~/.prime/agent/session-leases could not be read, so a session no running prime-agent holds shows as unknown, not finished.`,
    );
    expect(JSON.stringify(result)).not.toContain(LEASE_TOKEN);

    const before = primeAgentFiles(() => NOW - 2 * DAY);
    before.write(SESSION_FILE, sessionText(SESSION_ID), { mtimeMs: NOW - MINUTE });
    before.write(ownerOf(1), `{"token":"${LEASE_TOKEN}`);
    const at = machine();
    const adapter = primeAgentAdapterFor(before, { now: at.clock.now, uptimeMs: () => DAY });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("H10: of two leases that name it, one that runs holds it", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    files.write(ownerOf(2), ownerText(SESSION_ID, { pid: PID + 1 }));
    expect((await statusOf(files)).session?.status).toBe("working");
  });
});

describe("what its worker's journal says", () => {
  test("working from a prompt, with the time of the first line of the run, and the file's last write", async () => {
    const files = heldSession(
      recordAt(1, "create", true) +
        checkpointAt(2, "prompt_accepted", true) +
        checkpointAt(3, "steer_queued", true),
    );
    const { session } = await statusOf(files);
    expect(session).toMatchObject({
      status: "working",
      statusSince: STARTED_AT + 2 * SECOND,
      lastWriteAt: NOW - MINUTE,
    });
  });

  test("idle once a turn ends with nothing left, with that line's time and no last write", async () => {
    const files = heldSession(
      checkpointAt(2, "prompt_accepted", true) + checkpointAt(9, "turn_end", false),
    );
    const { session } = await statusOf(files);
    expect(session).toMatchObject({ status: "idle", statusSince: STARTED_AT + 9 * SECOND });
    expect(session).not.toHaveProperty("lastWriteAt");
  });

  test("idle from the first of its idle records, across Prime Agent's rewrite of its journal", async () => {
    const at = machine();
    const files = heldSession(
      recordAt(5, "turn_end", false) + queueLine({ suspended: false, at: STARTED_AT + 5 * SECOND }),
      {},
      at.clock.now,
    );
    const adapter = adapterOn(files, at);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "idle",
      statusSince: STARTED_AT + 5 * SECOND,
    });
    at.clock.advance(2 * SECOND);
    // A cancel clears the empty queue, and the journal is rewritten to that record alone.
    files.write(
      JOURNAL,
      recordAt(9, "queue_cleared", false) +
        queueLine({ suspended: false, at: STARTED_AT + 9 * SECOND }),
    );
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "idle",
      statusSince: STARTED_AT + 5 * SECOND,
    });
  });

  test("idle from a turn's end that came after a time idle, across Prime Agent's rewrite of its journal", async () => {
    const at = machine();
    const files = heldSession(
      recordAt(5, "turn_end", false) + queueLine({ suspended: false, at: STARTED_AT + 5 * SECOND }),
      {},
      at.clock.now,
    );
    const adapter = adapterOn(files, at);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "idle",
      statusSince: STARTED_AT + 5 * SECOND,
    });
    at.clock.advance(2 * SECOND);
    // A turn runs and ends between two polls, and the journal is rewritten to its end alone.
    files.write(
      JOURNAL,
      recordAt(9, "turn_end", false) + queueLine({ suspended: false, at: STARTED_AT + 9 * SECOND }),
    );
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "idle",
      statusSince: STARTED_AT + 9 * SECOND,
    });
  });

  test("working while queued work waits after a turn's end, unless the queue is parked", async () => {
    const waiting = heldSession(
      checkpointAt(2, "prompt_accepted", true) + checkpointAt(9, "turn_end", true),
    );
    expect((await statusOf(waiting)).session?.status).toBe("working");
    const parked = heldSession(
      checkpointAt(2, "prompt_accepted", true) + checkpointAt(9, "turn_end", true, true),
    );
    expect((await statusOf(parked)).session?.status).toBe("unknown");
    const steered = heldSession(checkpointAt(3, "steer_queued", true, true));
    expect((await statusOf(steered)).session?.status).toBe("unknown");
  });

  test("idle once a queued message is deleted after an abort, from the deletion", async () => {
    const files = heldSession(
      checkpointAt(2, "prompt_accepted", true) +
        checkpointAt(5, "turn_end", true, true) +
        checkpointAt(7, "queue_mutated", false),
    );
    const { session } = await statusOf(files);
    expect(session).toMatchObject({ status: "idle", statusSince: STARTED_AT + 7 * SECOND });
  });

  test("working from the resume once a parked queue is resumed with work waiting", async () => {
    const files = heldSession(
      checkpointAt(2, "prompt_accepted", true) +
        checkpointAt(5, "turn_end", true, true) +
        checkpointAt(7, "queue_resumed", true),
    );
    const { session } = await statusOf(files);
    expect(session).toMatchObject({ status: "working", statusSince: STARTED_AT + 7 * SECOND });
  });

  test("still working from the turn's start when a queued message is edited during it", async () => {
    const files = heldSession(
      checkpointAt(2, "prompt_accepted", true) +
        checkpointAt(3, "follow_up_queued", true) +
        checkpointAt(4, "queue_mutated", true),
    );
    const { session } = await statusOf(files);
    expect(session).toMatchObject({ status: "working", statusSince: STARTED_AT + 2 * SECOND });
  });

  test("unknown right after a create, whose busy flag is always true", async () => {
    const files = heldSession(recordAt(1, "create", true));
    expect((await statusOf(files)).session).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("unknown at a step that ends the worker or is not traced", async () => {
    for (const operation of ["shutdown", "killed", "replaced", "worker_gave_up"]) {
      const files = heldSession(
        checkpointAt(2, "prompt_accepted", true) + recordAt(5, operation, false),
      );
      expect((await statusOf(files)).session?.status, operation).toBe("unknown");
    }
  });

  test("the journal is the one the lease names, not another worker's that names the session", async () => {
    const files = heldSession(checkpointAt(9, "turn_end", false));
    // Another worker's journal says the session works, and is newer.
    const other = journalOf(workerIdOf(2), OTHER_HASH);
    files.write(
      other,
      checkpoint({
        activeSessionId: workerIdOf(2),
        busy: true,
        operation: "prompt_accepted",
        at: STARTED_AT + 20 * SECOND,
      }),
    );
    const { session } = await statusOf(files);
    expect(session?.status).toBe("idle");
    expect(files.opened()).not.toContain(other);
  });

  test("with no journal, or the worker's journal in two of the daemons' folders, it is unknown", async () => {
    const none = heldSession("");
    none.remove(JOURNAL);
    expect((await statusOf(none)).session?.status).toBe("unknown");
    const twice = heldSession(checkpointAt(2, "prompt_accepted", true));
    twice.write(journalOf(WORKER_ID, OTHER_HASH), checkpointAt(2, "prompt_accepted", true));
    expect((await statusOf(twice)).session?.status).toBe("unknown");
    const noWorker = heldSession(checkpointAt(2, "prompt_accepted", true), {
      activeSessionId: undefined,
    });
    expect((await statusOf(noWorker)).session?.status).toBe("unknown");
  });

  test("a line of another slot in the worker's journal is passed over", async () => {
    const files = heldSession(
      checkpointAt(2, "prompt_accepted", true) +
        checkpoint({
          activeSessionId: workerIdOf(2),
          busy: false,
          operation: "turn_end",
          at: STARTED_AT + 9 * SECOND,
        }),
    );
    expect((await statusOf(files)).session?.status).toBe("working");
  });

  test("a record from before the lease was taken does not count, as when no create is written yet", async () => {
    const files = heldSession(checkpointAt(-5, "prompt_accepted", true));
    expect((await statusOf(files)).session?.status).toBe("unknown");
  });

  test("a queue line from before the lease was taken does not count", async () => {
    const files = heldSession(
      queueLine({ suspended: false, at: STARTED_AT - 5 * SECOND }) +
        recordAt(3, "steer_queued", true),
    );
    expect((await statusOf(files)).session?.status).toBe("unknown");
  });

  test("the slot's newest record must be the session's: a worker that moved on with /new leaves it unknown", async () => {
    const files = heldSession(
      checkpointAt(9, "turn_end", false) +
        checkpoint({
          busy: true,
          operation: "prompt_accepted",
          at: STARTED_AT + 20 * SECOND,
          sessionId: sessionIdOf(2),
          sessionFile: `/x/${sessionIdOf(2)}.jsonl`,
        }),
    );
    expect((await statusOf(files)).session?.status).toBe("unknown");
  });

  test("a record that names another file is not the session's, even with its ID", async () => {
    const files = heldSession(
      checkpoint({
        busy: true,
        operation: "prompt_accepted",
        at: STARTED_AT + 2 * SECOND,
        sessionFile: `/x/${sessionIdOf(2)}.jsonl`,
      }),
    );
    expect((await statusOf(files)).session?.status).toBe("unknown");
  });

  test("is never needs-you or failed, whatever else the files hold", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    files.append(
      SESSION_FILE,
      line({
        type: "agent_status",
        id: "x",
        parentId: null,
        timestamp: iso(NOW),
        taskState: "needs_input",
      }) +
        line({ type: "message", message: { role: "assistant", content: [], stopReason: "error" } }),
    );
    const statuses = new Set<string>();
    for (const operation of [
      "create",
      "prompt_accepted",
      "steer_queued",
      "follow_up_queued",
      "turn_end",
      "queue_purged",
      "queue_cleared",
      "queue_mutated",
      "queue_resumed",
      "shutdown",
      "killed",
      "replaced",
      "worker_gave_up",
    ]) {
      for (const busy of [true, false]) {
        files.write(JOURNAL, checkpointAt(2, operation, busy));
        statuses.add((await statusOf(files)).session?.status ?? "");
      }
    }
    expect([...statuses].sort()).toEqual(["idle", "unknown", "working"]);
  });
});

describe("what it never reads", () => {
  test("no worker's record, supervisor file, orphan journal, writer lock or other worker's journal is opened", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    const folder = workersFolderOf();
    for (const name of [
      `${WORKER_ID}.identity-pending`,
      `${WORKER_ID}.orphans.jsonl`,
      `${WORKER_ID}.recovery.jsonl.writer-lock`,
      `${WORKER_ID}.recovery.jsonl.tmp-77`,
      `${WORKER_ID}.tmp-77`,
      "compaction-supervision.jsonl",
      `${workerIdOf(2)}.recovery.jsonl`,
      `${workerIdOf(2)}.json`,
    ]) {
      files.write(`${folder}/${name}`, `${WORKER_SECRET}\n`);
    }
    files.write(`${AGENT_DIR}/settings.json`, WORKER_SECRET);
    files.write(`${AGENT_DIR}/logs/worker-${WORKER_ID}.stderr.log`, WORKER_SECRET);
    files.write(
      `${AGENT_DIR}/session-artifacts/${SESSION_ID}/child/a.jsonl`,
      sessionText(sessionIdOf(9)),
    );
    files.write(
      `${AGENT_DIR}/sessions-archive/${sessionIdOf(8)}.jsonl`,
      sessionText(sessionIdOf(8)),
    );
    const { result } = await statusOf(files);
    expect(result.sessions[0]?.status).toBe("working");
    const touched = files.calls.filter(({ path: target }) => target.startsWith(WORKERS_DIR));
    expect(files.opened().filter((target) => target.startsWith(WORKERS_DIR))).toEqual([JOURNAL]);
    expect(touched.map(({ path: target }) => target)).not.toContain(
      `${folder}/${WORKER_ID}.recovery.jsonl.writer-lock`,
    );
    expect(
      files.count(undefined, (target) =>
        /settings\.json|logs|session-artifacts|sessions-archive/.test(target),
      ),
    ).toBe(0);
    for (const text of [WORKER_SECRET, LEASE_TOKEN, PRIVATE_FOLDER, PRIVATE_WORDS]) {
      expect(JSON.stringify(result)).not.toContain(text);
    }
  });

  test("lists only the sessions folder, the leases folder and the workers' folder, never a daemon's folder", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    await statusOf(files);
    expect(
      [
        ...new Set(
          files.calls
            .filter(({ method }) => method === "readdir")
            .map(({ path: target }) => target),
        ),
      ].sort(),
    ).toEqual([LEASES_DIR, SESSIONS_DIR, WORKERS_DIR].sort());
  });

  test("never opens a path a lease or a journal names", async () => {
    const elsewhere = `${HOME}/elsewhere/${SESSION_ID}.jsonl`;
    const files = heldSession(
      checkpoint({
        busy: true,
        operation: "prompt_accepted",
        at: STARTED_AT + 2 * SECOND,
        sessionFile: elsewhere,
      }),
      { sessionPath: elsewhere },
    );
    files.write(elsewhere, sessionText(SESSION_ID, line({ text: PRIVATE_WORDS })));
    const { result } = await statusOf(files);
    expect(result.sessions[0]?.status).toBe("working");
    expect(files.count(undefined, (target) => target.startsWith(`${HOME}/elsewhere`))).toBe(0);
  });

  test("follows no link at a lease's folder, its owner.json, the workers' folder, a daemon's folder or a journal", async () => {
    for (const [name, change] of [
      [
        "the workers' folder",
        (files: PrimeAgentFiles) => {
          files.remove(WORKERS_DIR);
          files.special(WORKERS_DIR);
        },
      ],
      [
        "a daemon's folder",
        (files: PrimeAgentFiles) => {
          files.remove(workersFolderOf());
          files.special(workersFolderOf());
        },
      ],
      [
        "a journal",
        (files: PrimeAgentFiles) => {
          files.remove(JOURNAL);
          files.special(JOURNAL);
        },
      ],
      [
        "owner.json",
        (files: PrimeAgentFiles) => {
          files.remove(ownerOf(1));
          files.special(ownerOf(1));
        },
      ],
      [
        "a lease's folder",
        (files: PrimeAgentFiles) => {
          files.remove(leaseOf(1));
          files.special(leaseOf(1));
        },
      ],
    ] as const) {
      const files = heldSession(checkpointAt(2, "prompt_accepted", true));
      change(files);
      files.forget();
      const { session } = await statusOf(files);
      expect(session?.status, name).toBe("unknown");
      expect(
        files.count("openRegular", (target) => target.startsWith(WORKERS_DIR)),
        name,
      ).toBe(0);
      if (name.includes("lease") || name === "owner.json") {
        expect(
          files.count("openRegular", (target) => target.startsWith(LEASES_DIR)),
          name,
        ).toBe(0);
      }
    }
  });
});

describe("how often it asks", () => {
  test("lists the sessions folder again only when its time moves, and at each sweep", async () => {
    const at = machine();
    const files = heldSession(checkpointAt(2, "prompt_accepted", true), {}, at.clock.now);
    const adapter = adapterOn(files, at);
    await adapter.poll();
    at.clock.advance(2 * SECOND);
    await adapter.poll();
    const listed = () => files.count("readdir", (target) => target === SESSIONS_DIR);
    expect(listed()).toBe(1);
    files.write(sessionFileOf(sessionIdOf(2)), sessionText(sessionIdOf(2)));
    at.clock.advance(2 * SECOND);
    const added = await adapter.poll();
    expect(listed()).toBe(2);
    expect(added.sessions).toHaveLength(2);
    at.clock.advance(MINUTE);
    await adapter.poll();
    expect(listed()).toBe(3);
  });

  test("asks ps with pid, lstart and comm alone, in UTC, every 30 seconds, and never with no lease to ask about", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    const at = machine();
    const adapter = adapterOn(files, at);
    await adapter.poll();
    at.clock.advance(2 * SECOND);
    await adapter.poll();
    expect(at.ps.runs).toEqual([
      { args: ["-o", "pid=,lstart=,comm=", "-p", String(PID)], utc: true },
    ]);
    at.clock.advance(30 * SECOND);
    await adapter.poll();
    expect(at.ps.runs).toHaveLength(2);
    expect(at.alive.asked).toEqual([PID, PID, PID]);
    files.remove(leaseOf(1));
    at.clock.advance(40 * SECOND);
    await adapter.poll();
    expect(at.ps.runs).toHaveLength(2);
  });

  test("never says every session is finished at once", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    const at = machine();
    at.alive.alive.clear();
    const results: AdapterResult[] = [];
    for (const platform of ["darwin", "linux", "win32"] as const) {
      results.push(await adapterOn(files, { ...at, platform }).poll());
    }
    expect(results.map(({ basis }) => basis)).not.toContain("files-closed");
  });
});

describe("what it says it reads and can report", () => {
  test("Sources names its folders and what is asked of a process, on each system", async () => {
    const files = heldSession(checkpointAt(2, "prompt_accepted", true));
    const facts = async (platform: NodeJS.Platform) =>
      (await adapterOn(files, machine(platform)).poll()).health.watching;
    expect(await facts("darwin")).toEqual([
      { label: "Sessions folder", value: "~/.prime/agent/sessions" },
      { label: "Read", value: "every 2 seconds" },
      { label: "Leases folder", value: "~/.prime/agent/session-leases" },
      { label: "Workers folder", value: "~/.prime/agent/daemon-workers" },
      { label: "Process check", value: "signal 0, and ps -o pid=,lstart=,comm= -p <pids>" },
      { label: "Process check run", value: "every 30 seconds at most, and when a lease appears" },
    ]);
    expect((await facts("linux"))?.[4]).toEqual({
      label: "Process check",
      value:
        "signal 0, /proc/<pid>/stat, and ps -o pid=,lstart=,comm= -p <pids> when that cannot be compared",
    });
    expect((await facts("win32"))?.slice(3)).toEqual([
      { label: "Workers folder", value: "not read on this system" },
      { label: "Process check", value: "signal 0 alone; a held lease shows as unknown" },
    ]);
  });

  test("its profile reads names, keeps every file in one folder and leaves no session out", () => {
    expect(PRIME_AGENT_PROFILE).toMatchObject({
      sourceId: "prime-agent",
      layout: "flat",
      readsNames: true,
      hiddenMarkers: [],
      legacySessionsEnv: "PRIME_AGENT_CODING_AGENT_SESSION_DIR",
      agentDirEnv: "PRIME_AGENT_CODING_AGENT_DIR",
    });
    expect(PRIME_AGENT_PROFILE.capabilities).toBe(PRIME_AGENT_CAPABILITIES);
    for (const note of [STATUS_NOTE, UNCHECKED_NOTE, NEWER_FORMAT_NOTE, WINDOWS_NOTE]) {
      expect(note).not.toMatch(/\b(Pi|Kimchi)\b/);
    }
    expect(UNCHECKED_NOTE).toContain("v0.10.3");
  });

  test("its modules reach the file system, sockets and programs only through what they are given", () => {
    const root = fileURLToPath(new URL("../../../../../src/", import.meta.url));
    const folders = ["collector/adapters/prime-agent", "core/mapping/prime-agent"];
    for (const folder of folders) {
      for (const name of readdirSync(path.join(root, folder))) {
        const text = readFileSync(path.join(root, folder, name), "utf8");
        expect(text, name).not.toMatch(/from "node:(fs|fs\/promises|net|child_process)"/);
      }
    }
  });
});

test("a poll after an hour forgets the journals it no longer needs", async () => {
  const at = machine();
  const files = heldSession(checkpointAt(2, "prompt_accepted", true), {}, at.clock.now);
  const adapter = adapterOn(files, at);
  await adapter.poll();
  files.remove(leaseOf(1));
  at.clock.advance(HOUR);
  expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  files.write(ownerOf(1), ownerText(SESSION_ID));
  at.clock.advance(2 * SECOND);
  files.forget();
  await adapter.poll();
  // Read afresh, from its end, as for a journal never seen.
  expect(
    files.reads.filter(({ path: target }) => target === JOURNAL).map(({ position }) => position),
  ).toEqual([0]);
  expect(conversationLines()).toContain(PRIVATE_WORDS);
});
