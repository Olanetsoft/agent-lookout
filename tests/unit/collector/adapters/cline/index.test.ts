import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  clineSessionsDirFor,
  NEEDS_YOU_NOTE,
  NEWER_FORMAT_NOTE,
  RECHECK_MS,
  SWEEP_MS,
  TOO_LARGE_NOTE,
  UNCHECKED_NOTE,
  UNKNOWN_NOTE,
} from "@collector/adapters/cline/index";
import { MAX_MANIFEST_BYTES } from "@collector/adapters/cline/manifests";
import {
  DAY,
  ended,
  HOME,
  HOUR,
  IMPORTED_AT,
  imported,
  manifestFile,
  manifestText,
  messagesFile,
  MINUTE,
  NOW,
  PID,
  PLACEHOLDER,
  PRIVATE_SYSTEM_PROMPT,
  PRIVATE_WORDS,
  PROJECT,
  resumed,
  SECOND,
  SESSIONS_DIR,
  sessionIdOf,
  STARTED_AT,
} from "@tests/fixtures/cline/cline";
import {
  clineAdapterFor,
  handClock,
  healthy,
  memoryFiles,
  standInProcesses,
  standInStarts,
  type MemoryFiles,
} from "@tests/support/adapters/cline/clineAdapter";
import { asWritten } from "@tests/support/paths";

const ID = sessionIdOf(1);

/** Writes one session's manifest and its messages file, as Cline leaves them. */
function write(
  files: MemoryFiles,
  id: string,
  changes: Record<string, unknown> = {},
  mtimeMs = NOW - MINUTE,
) {
  files.write(manifestFile(id), manifestText(id, changes), { mtimeMs });
  files.write(messagesFile(id), PLACEHOLDER, { mtimeMs });
}

function setUp(changes: Record<string, unknown> = {}, mtimeMs?: number) {
  const files = memoryFiles(() => NOW);
  write(files, ID, changes, mtimeMs);
  return files;
}

describe("clineSessionsDirFor", () => {
  const dir = (env: NodeJS.ProcessEnv) => asWritten(clineSessionsDirFor(env, HOME));

  test("is ~/.cline/data/sessions when nothing names another", () => {
    expect(dir({})).toBe(`${HOME}/.cline/data/sessions`);
    expect(dir({ CLINE_DIR: "  " })).toBe(`${HOME}/.cline/data/sessions`);
  });

  test("takes the narrowest of Cline's own variables, as Cline does", () => {
    expect(dir({ CLINE_DIR: "/tmp/one" })).toBe("/tmp/one/data/sessions");
    expect(dir({ CLINE_DIR: "/tmp/one", CLINE_DATA_DIR: "/tmp/two" })).toBe("/tmp/two/sessions");
    expect(
      dir({
        CLINE_DIR: "/tmp/one",
        CLINE_DATA_DIR: "/tmp/two",
        CLINE_SESSION_DATA_DIR: "/tmp/three",
      }),
    ).toBe("/tmp/three");
  });

  test("AGENT_LOOKOUT_CLINE_HOME names Cline's folder over all of them", () => {
    expect(
      dir({ AGENT_LOOKOUT_CLINE_HOME: "/tmp/mine", CLINE_SESSION_DATA_DIR: "/tmp/three" }),
    ).toBe("/tmp/mine/data/sessions");
  });
});

describe("with no Cline", () => {
  test("says it was not found, with no advice, and looks again once a minute", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock();
    const adapter = clineAdapterFor(files, { now: clock.now });

    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({
      id: "cline",
      label: "Cline",
      state: "unavailable",
      detail:
        "Cline was not found: there is no ~/.cline/data/sessions folder. Agent Lookout looks again every minute.",
    });
    expect(health).not.toHaveProperty("advice");
    expect(sessions).toEqual([]);
    expect(files.count()).toBe(1);

    clock.advance(RECHECK_MS - 1);
    await adapter.poll();
    expect(files.count()).toBe(1);

    clock.advance(1);
    await adapter.poll();
    expect(files.count()).toBe(2);
  });

  test("a clock set back counts as time enough to look again", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock();
    const adapter = clineAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.advance(-1);
    await adapter.poll();
    expect(files.count("readdir")).toBe(2);
  });

  test("finds Cline once it is installed", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock();
    const adapter = clineAdapterFor(files, { now: clock.now });
    await adapter.poll();

    write(files, ID);
    clock.advance(RECHECK_MS);
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(1);
  });

  test("a folder Agent Lookout was told to read is an answer, not a missing Cline", async () => {
    const files = memoryFiles(() => NOW);
    const adapter = clineAdapterFor(files, { env: { AGENT_LOOKOUT_CLINE_HOME: "/tmp/mine" } });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain("AGENT_LOOKOUT_CLINE_HOME is set");
    expect(health.detail).toContain(NEEDS_YOU_NOTE);
    expect(health.detail).toContain(UNCHECKED_NOTE);
    expect(health.watching).toContainEqual({ label: "Read", value: "not found" });
    expect(sessions).toEqual([]);
    await adapter.poll();
    expect(files.count("readdir")).toBe(2);
  });

  test("a CLINE_DIR with no folder there is Cline not found, and is looked for once a minute", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock();
    const adapter = clineAdapterFor(files, { env: { CLINE_DIR: "/tmp/one" }, now: clock.now });
    const sessionsDir = path.resolve("/tmp/one/data/sessions");

    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({
      state: "unavailable",
      detail: `Cline was not found: there is no ${sessionsDir} folder. Agent Lookout looks again every minute.`,
    });
    expect(health.watching).toContainEqual({ label: "Sessions folder", value: sessionsDir });
    expect(health).not.toHaveProperty("advice");
    expect(sessions).toEqual([]);

    clock.advance(RECHECK_MS - 1);
    await adapter.poll();
    expect(files.count("readdir")).toBe(1);

    clock.advance(1);
    await adapter.poll();
    expect(files.count("readdir")).toBe(2);
  });

  test("a blank AGENT_LOOKOUT_CLINE_HOME names no folder", async () => {
    const files = memoryFiles(() => NOW);
    const adapter = clineAdapterFor(files, { env: { AGENT_LOOKOUT_CLINE_HOME: "  " } });
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });
});

test("an empty sessions folder is watched, with what the card always says", async () => {
  const files = memoryFiles(() => NOW);
  files.mkdir(SESSIONS_DIR);
  const { health, sessions, basis } = await clineAdapterFor(files).poll();
  expect(health).toMatchObject({
    state: "ok",
    detail: healthy(),
    watching: [
      { label: "Sessions folder", value: "~/.cline/data/sessions" },
      { label: "Read", value: "every 2 seconds" },
      { label: "Process check", value: "ps -o pid=,lstart= -p <pids>" },
      {
        label: "Process check run",
        value: "every 30 seconds while a session's process runs, and sooner when another appears",
      },
    ],
  });
  expect(health.detail).toContain(NEEDS_YOU_NOTE);
  expect(health.detail).toContain(UNCHECKED_NOTE);
  expect(sessions).toEqual([]);
  expect(basis).toBe("files");
});

test("a folder that cannot be listed is an error that says where", async () => {
  const files = memoryFiles(() => NOW);
  files.mkdir(SESSIONS_DIR);
  files.fail(SESSIONS_DIR);
  const { health, sessions } = await clineAdapterFor(files).poll();
  expect(health).toMatchObject({
    state: "error",
    detail:
      "Cline sessions could not be read: the folder ~/.cline/data/sessions could not be listed.",
  });
  expect(health.watching).toContainEqual({ label: "Read", value: "cannot be read" });
  expect(sessions).toEqual([]);
});

test("a card that is not ok gives no way of reading", async () => {
  expect(await clineAdapterFor(memoryFiles(() => NOW)).poll()).not.toHaveProperty("basis");
  const files = memoryFiles(() => NOW);
  files.mkdir(SESSIONS_DIR);
  files.fail(SESSIONS_DIR);
  expect(await clineAdapterFor(files).poll()).not.toHaveProperty("basis");
});

test("never rejects, and says something went wrong in a sentence", async () => {
  const files = setUp();
  const adapter = clineAdapterFor(files, {
    isAlive: () => {
      throw new Error("not expected");
    },
  });
  const { health, sessions } = await adapter.poll();
  expect(health).toMatchObject({
    state: "error",
    detail: "Something unexpected went wrong while reading Cline sessions.",
  });
  expect(sessions).toEqual([]);
});

describe("each status", () => {
  test.each([
    ["running", "working", undefined],
    ["idle", "idle", undefined],
    ["pending", "needs-you", "permission"],
  ])("%s with its process running is %s", async (status, shown, reason) => {
    const { sessions } = await clineAdapterFor(setUp({ status })).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: `cline:${ID}`,
      status: shown,
      statusSince: NOW - MINUTE,
      pid: PID,
      alive: true,
      name: "demo-project",
      cwd: PROJECT,
      startedAt: STARTED_AT,
    });
    expect(sessions[0]?.waitingReason).toBe(reason);
  });

  test.each([
    ["completed", "finished"],
    ["cancelled", "finished"],
    ["failed", "failed"],
  ])("%s is %s, and its process is not asked about", async (status, shown) => {
    const processes = standInProcesses();
    const starts = standInStarts();
    const { sessions } = await clineAdapterFor(setUp(ended(status, NOW - 2 * MINUTE)), {
      isAlive: processes.isAlive,
      readProcessStarts: starts.read,
    }).poll();
    expect(sessions[0]).toMatchObject({ status: shown, statusSince: NOW - 2 * MINUTE });
    expect(sessions[0]).not.toHaveProperty("pid");
    expect(processes.asked).toEqual([]);
    expect(starts.runs).toEqual([]);
  });

  test("a status Cline does not write today is unknown, and the card says so", async () => {
    const { health, sessions } = await clineAdapterFor(setUp({ status: "archived" })).poll();
    expect(sessions[0]).toMatchObject({ status: "unknown", statusSince: null });
    expect(health.detail).toContain(UNKNOWN_NOTE);
  });

  test("a wrong type where the status goes is unknown, not a guess", async () => {
    const { sessions } = await clineAdapterFor(setUp({ status: 7 })).poll();
    expect(sessions[0]).toMatchObject({ status: "unknown" });
  });

  test("a session that says it is open and names no process is unknown", async () => {
    const processes = standInProcesses();
    const { sessions } = await clineAdapterFor(setUp({ pid: "41001" }), {
      isAlive: processes.isAlive,
    }).poll();
    expect(sessions[0]).toMatchObject({ status: "unknown" });
    expect(sessions[0]).not.toHaveProperty("pid");
    expect(processes.asked).toEqual([]);
  });
});

describe("a crash left behind", () => {
  test.each(["running", "pending", "idle"])(
    "a manifest that says %s and whose process has gone is finished",
    async (status) => {
      const { sessions } = await clineAdapterFor(setUp({ status }), {
        isAlive: standInProcesses().isAlive,
      }).poll();
      expect(sessions[0]).toMatchObject({
        status: "finished",
        statusSince: NOW - MINUTE,
        alive: false,
      });
      expect(sessions[0]).not.toHaveProperty("waitingReason");
    },
  );

  test("a session shows as finished the poll after its process ends", async () => {
    const processes = standInProcesses([PID]);
    const adapter = clineAdapterFor(setUp(), { isAlive: processes.isAlive });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    processes.stop(PID);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });
});

describe("a pid another program was given", () => {
  const LATER = STARTED_AT + 5 * MINUTE;

  test("on a Mac, a process that started after its session did is not the session's", async () => {
    const starts = standInStarts({ [PID]: LATER });
    const { sessions } = await clineAdapterFor(setUp(), { readProcessStarts: starts.read }).poll();
    expect(sessions[0]).toMatchObject({ status: "finished", alive: false });
    expect(starts.runs).toEqual([[PID]]);
  });

  test("on a Mac, a process that started before its session did is the session's", async () => {
    const starts = standInStarts({ [PID]: STARTED_AT - HOUR });
    const { sessions } = await clineAdapterFor(setUp(), { readProcessStarts: starts.read }).poll();
    expect(sessions[0]).toMatchObject({ status: "working", alive: true });
  });

  test("when ps cannot say, the session stands as signal 0 says", async () => {
    const starts = standInStarts();
    starts.fails = true;
    const { sessions } = await clineAdapterFor(setUp(), { readProcessStarts: starts.read }).poll();
    expect(sessions[0]).toMatchObject({ status: "working" });
  });

  test("a start not known is not compared, and ps is not asked about it", async () => {
    const starts = standInStarts({ [PID]: LATER });
    const { sessions } = await clineAdapterFor(setUp({ started_at: "yesterday" }), {
      readProcessStarts: starts.read,
    }).poll();
    expect(sessions[0]).toMatchObject({ status: "working" });
    expect(starts.runs).toEqual([]);
  });

  test("an answer stands when a later check cannot answer, until the pid stops", async () => {
    const clock = handClock();
    const processes = standInProcesses([PID]);
    const starts = standInStarts({ [PID]: LATER });
    const adapter = clineAdapterFor(setUp(), {
      now: clock.now,
      isAlive: processes.isAlive,
      readProcessStarts: starts.read,
    });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");

    starts.fails = true;
    clock.advance(31 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");

    processes.stop(PID);
    await adapter.poll();
    processes.start(PID);
    clock.advance(31 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("ps runs at most every 30 seconds, for each pid once", async () => {
    const clock = handClock();
    const starts = standInStarts({ [PID]: STARTED_AT - HOUR });
    const files = setUp();
    write(files, sessionIdOf(2));
    const adapter = clineAdapterFor(files, { now: clock.now, readProcessStarts: starts.read });
    await adapter.poll();
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(starts.runs).toEqual([[PID]]);
    clock.advance(30 * SECOND);
    await adapter.poll();
    expect(starts.runs).toEqual([[PID], [PID]]);
  });

  test.each(["linux", "win32"] as const)(
    "on %s, signal 0 is all there is and ps is never run",
    async (platform) => {
      const starts = standInStarts({ [PID]: LATER });
      const adapter = clineAdapterFor(setUp(), { platform, readProcessStarts: starts.read });
      const { health, sessions } = await adapter.poll();
      expect(sessions[0]).toMatchObject({ status: "working", alive: true });
      expect(starts.runs).toEqual([]);
      expect(health.watching).toContainEqual({
        label: "Process check",
        value: "signal 0 alone, every 2 seconds",
      });
    },
  );
});

test("on Windows, a session keeps its Windows folder", async () => {
  const files = setUp({ cwd: "C:\\code\\demo-project" });
  const { sessions } = await clineAdapterFor(files, { platform: "win32" }).poll();
  expect(sessions[0]).toMatchObject({ cwd: "C:\\code\\demo-project", project: "demo-project" });
});

test("two sessions in Cline's hub share one process, and each shows what its own manifest says", async () => {
  const files = setUp({ status: "idle" });
  write(files, sessionIdOf(2), { status: "running" });
  const processes = standInProcesses([PID]);
  const { sessions } = await clineAdapterFor(files, { isAlive: processes.isAlive }).poll();
  expect(sessions.map(({ status, pid }) => [status, pid])).toEqual([
    ["idle", PID],
    ["working", PID],
  ]);
});

describe("what is listed", () => {
  test("a session written in the last day is, and one written before that is not opened", async () => {
    const files = setUp({}, NOW - 23 * HOUR);
    const old = sessionIdOf(2);
    write(files, old, ended("completed", NOW - 2 * DAY), NOW - 2 * DAY);
    const { sessions } = await clineAdapterFor(files).poll();
    expect(sessions.map(({ id }) => id)).toEqual([`cline:${ID}`]);
    expect(files.opened()).toEqual([manifestFile(ID)]);
  });

  test("a session finished for a day leaves the list", async () => {
    const clock = handClock();
    const files = setUp(ended("completed", NOW), NOW);
    const adapter = clineAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    clock.advance(DAY);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("a crash left behind leaves the list a day after its last write", async () => {
    const { sessions } = await clineAdapterFor(setUp({}, NOW - DAY), {
      isAlive: () => false,
    }).poll();
    expect(sessions).toEqual([]);
  });

  test("an idle session left for a day leaves the list, though its process runs", async () => {
    const clock = handClock();
    const adapter = clineAdapterFor(setUp({ status: "idle" }, NOW), { now: clock.now });
    expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
    clock.advance(DAY);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test.each([
    ["running", "working"],
    ["pending", "needs-you"],
  ])("a session that says %s stays for as long as its process runs", async (status, shown) => {
    const clock = handClock();
    const processes = standInProcesses([PID]);
    const adapter = clineAdapterFor(setUp({ status }, NOW), {
      now: clock.now,
      isAlive: processes.isAlive,
    });
    await adapter.poll();
    clock.advance(3 * DAY);
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: shown, statusSince: NOW });
    processes.stop(PID);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("a session shown stays a day after its messages file was written", async () => {
    const clock = handClock();
    const processes = standInProcesses([PID]);
    const files = setUp({}, NOW);
    const adapter = clineAdapterFor(files, { now: clock.now, isAlive: processes.isAlive });
    await adapter.poll();
    clock.advance(30 * HOUR);
    files.write(messagesFile(ID), PLACEHOLDER, { mtimeMs: clock.now() - HOUR });
    processes.stop(PID);
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: "finished" });
  });

  test("a session not shown yet goes by its manifest's time alone", async () => {
    const files = setUp({}, NOW - 2 * DAY);
    files.write(messagesFile(ID), PLACEHOLDER, { mtimeMs: NOW - MINUTE });
    const { sessions } = await clineAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test.each([
    ["idle", "idle"],
    ["pending", "needs-you"],
  ])(
    "a session that says %s and comes back to the list has a new status time",
    async (status, shown) => {
      const clock = handClock();
      const processes = standInProcesses([PID]);
      const files = setUp({ status }, NOW);
      const adapter = clineAdapterFor(files, { now: clock.now, isAlive: processes.isAlive });
      await adapter.poll();
      processes.stop(PID);
      clock.advance(DAY);
      expect((await adapter.poll()).sessions).toEqual([]);
      clock.advance(SWEEP_MS);
      await adapter.poll();

      clock.advance(SWEEP_MS);
      processes.start(PID);
      files.rewrite(manifestFile(ID), manifestText(ID, { status }), { mtimeMs: clock.now() });
      expect((await adapter.poll()).sessions[0]).toMatchObject({
        status: shown,
        statusSince: clock.now(),
      });
    },
  );

  test("a new session's folder is found on the next poll", async () => {
    const clock = handClock();
    const files = setUp();
    const adapter = clineAdapterFor(files, { now: clock.now });
    await adapter.poll();
    write(files, sessionIdOf(2));
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toHaveLength(2);
  });

  test("a folder whose manifest comes after it is found as soon as it does", async () => {
    const clock = handClock();
    const files = memoryFiles(() => NOW);
    files.write(messagesFile(ID), PLACEHOLDER);
    const adapter = clineAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);
    write(files, ID);
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("an old session opened again is found within a minute", async () => {
    const clock = handClock();
    const files = setUp(ended("completed", NOW - 3 * DAY), NOW - 3 * DAY);
    const adapter = clineAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);

    clock.advance(2 * SECOND);
    files.rewrite(manifestFile(ID), manifestText(ID), { mtimeMs: clock.now() });
    expect((await adapter.poll()).sessions).toEqual([]);

    clock.advance(SWEEP_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a session whose folder went leaves the list", async () => {
    const files = setUp();
    const adapter = clineAdapterFor(files);
    expect((await adapter.poll()).sessions).toHaveLength(1);
    files.remove(`${SESSIONS_DIR}/${ID}`);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("the sessions folder going leaves nothing behind, and Cline is not found", async () => {
    const files = setUp();
    const adapter = clineAdapterFor(files);
    await adapter.poll();
    files.remove(SESSIONS_DIR);
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(sessions).toEqual([]);
  });

  test("a sessions folder that goes and comes back starts afresh", async () => {
    const clock = handClock();
    const files = setUp({ status: "pending" }, NOW);
    const adapter = clineAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.remove(SESSIONS_DIR);
    await adapter.poll();

    clock.advance(RECHECK_MS);
    write(files, ID, { status: "pending" }, clock.now());
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: clock.now(),
    });
  });
});

describe("a session Cline's desktop app imported", () => {
  test.each(["darwin", "linux", "win32"] as const)(
    "is not listed on %s, and nothing on the card is wrong",
    async (platform) => {
      const result = await clineAdapterFor(setUp(imported), { platform }).poll();
      expect(result.sessions).toEqual([]);
      expect(result.health.state).toBe("ok");
      expect(result.health.detail).toBe(healthy());
    },
  );

  test("is listed from its first turn after a resume, and stays once that ends", async () => {
    const clock = handClock();
    const files = setUp(imported);
    const adapter = clineAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);

    // A resume keeps pid 0, so there is no process to ask about.
    clock.advance(2 * SECOND);
    files.rewrite(manifestFile(ID), manifestText(ID, resumed), { mtimeMs: clock.now() });
    expect((await adapter.poll()).sessions).toEqual([
      expect.objectContaining({ id: `cline:${ID}`, status: "unknown" }),
    ]);

    clock.advance(MINUTE);
    const endedAt = clock.now();
    files.rewrite(
      manifestFile(ID),
      manifestText(ID, { ...imported, ...ended("completed", endedAt) }),
      {
        mtimeMs: endedAt,
      },
    );
    expect((await adapter.poll()).sessions).toEqual([
      expect.objectContaining({ status: "finished", statusSince: endedAt }),
    ]);
  });

  test.each([
    ["completed", "finished"],
    ["failed", "failed"],
  ])(
    "an end after the import keeps a session listed from the first poll: %s",
    async (status, shown) => {
      const files = setUp({ ...imported, ...ended(status, IMPORTED_AT + MINUTE) });
      expect((await clineAdapterFor(files).poll()).sessions[0]?.status).toBe(shown);
    },
  );

  test("a new title does not list it", async () => {
    const clock = handClock();
    const files = setUp(imported);
    const adapter = clineAdapterFor(files, { now: clock.now });
    await adapter.poll();

    clock.advance(2 * SECOND);
    const metadata = { ...imported.metadata, title: "renamed" };
    files.rewrite(manifestFile(ID), manifestText(ID, { ...imported, metadata }), {
      mtimeMs: clock.now(),
    });
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("one resumed over a day after the import is found within a minute", async () => {
    const clock = handClock();
    const files = setUp(imported, NOW - 3 * DAY);
    const adapter = clineAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(files.opened()).toEqual([]);

    clock.advance(2 * SECOND);
    files.rewrite(manifestFile(ID), manifestText(ID, resumed), { mtimeMs: clock.now() });
    clock.advance(SWEEP_MS);
    expect((await adapter.poll()).sessions[0]?.id).toBe(`cline:${ID}`);
  });

  test("a manifest with no mark is listed, as a session this adapter cannot tell", async () => {
    const files = setUp({ ...imported, metadata: { title: "demo task" } });
    expect((await clineAdapterFor(files).poll()).sessions[0]?.status).toBe("finished");
  });

  test("a mark of the wrong type is listed, as a session this adapter cannot tell", async () => {
    const files = setUp({ ...imported, metadata: { importedFrom: "codex" } });
    expect((await clineAdapterFor(files).poll()).sessions[0]?.status).toBe("finished");
  });

  test("one a poll caught before its mark leaves the list once the mark is written", async () => {
    const clock = handClock();
    const { importedFrom: _writtenLast, ...firstWrite } = imported.metadata;
    const files = setUp({ ...imported, metadata: firstWrite });
    const adapter = clineAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);

    clock.advance(2 * SECOND);
    files.rewrite(manifestFile(ID), manifestText(ID, imported), { mtimeMs: clock.now() });
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("one of a newer format is left out, and the card says so", async () => {
    const { health, sessions } = await clineAdapterFor(setUp({ ...imported, version: 2 })).poll();
    expect(sessions).toEqual([]);
    expect(health.detail).toContain(NEWER_FORMAT_NOTE);
  });
});

describe("what a poll costs", () => {
  test("with a session shown, a listing, two lookups, signal 0 and no opening", async () => {
    const processes = standInProcesses([PID]);
    const files = setUp();
    const adapter = clineAdapterFor(files, { isAlive: processes.isAlive });
    await adapter.poll();
    files.forget();
    processes.asked.length = 0;
    await adapter.poll();
    expect(files.count("readdir")).toBe(1);
    expect(files.count("lstat")).toBe(2);
    expect(files.count("openRegular")).toBe(0);
    expect(processes.asked).toEqual([PID]);
  });

  test("a session that ended is looked up alone", async () => {
    const files = setUp(ended("completed", NOW - MINUTE));
    const adapter = clineAdapterFor(files);
    await adapter.poll();
    files.forget();
    await adapter.poll();
    expect(files.count("lstat")).toBe(1);
    expect(files.count("openRegular")).toBe(0);
  });

  test("an imported session left out is looked up alone, and opened only when it changes", async () => {
    const files = setUp(imported);
    const adapter = clineAdapterFor(files);
    await adapter.poll();
    files.forget();
    await adapter.poll();
    expect(files.count("lstat")).toBe(1);
    expect(files.count("openRegular")).toBe(0);
  });

  test("a thousand old sessions are looked up once a minute, and never opened", async () => {
    const clock = handClock();
    const files = memoryFiles(() => NOW);
    for (let n = 0; n < 1000; n += 1) {
      write(files, sessionIdOf(n), ended("completed", NOW - 3 * DAY), NOW - 3 * DAY);
    }
    const adapter = clineAdapterFor(files, { now: clock.now });
    await adapter.poll();
    expect(files.count("lstat")).toBe(1000);

    files.forget();
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(files.count()).toBe(1);

    files.forget();
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(files.count()).toBe(1);

    files.forget();
    clock.advance(SWEEP_MS);
    await adapter.poll();
    expect(files.count("lstat")).toBe(1000);
    expect(files.opened()).toEqual([]);
  });

  test("a clock set back counts as time enough to look through every folder", async () => {
    const clock = handClock();
    const files = setUp(ended("completed", NOW - 3 * DAY), NOW - 3 * DAY);
    const adapter = clineAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(-1);
    await adapter.poll();
    expect(files.count("lstat")).toBe(1);
  });
});

describe("a manifest it cannot use", () => {
  test.each([
    ["broken", "{ half written"],
    ["empty", ""],
    ["an array", "[]"],
  ])("one that is %s is left out, and the others stand", async (_case, content) => {
    const files = setUp();
    const bad = sessionIdOf(2);
    write(files, bad);
    files.rewrite(manifestFile(bad), content, { mtimeMs: NOW });
    const { health, sessions } = await clineAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(sessions.map(({ id }) => id)).toEqual([`cline:${ID}`]);
  });

  test.each([
    ["broken", "{ half written"],
    ["over the limit", manifestText(ID, { prompt: "x".repeat(MAX_MANIFEST_BYTES) })],
    ["of a newer format", manifestText(ID, { version: 2 })],
  ])("one that is %s is opened once, until it changes", async (_case, content) => {
    const files = setUp();
    files.rewrite(manifestFile(ID), content, { mtimeMs: NOW });
    const adapter = clineAdapterFor(files);
    await adapter.poll();
    await adapter.poll();
    await adapter.poll();
    expect(files.opened()).toEqual([manifestFile(ID)]);

    files.rewrite(manifestFile(ID), manifestText(ID), { mtimeMs: NOW + 1_000 });
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("a manifest over the limit is left out, its bytes unread, and the card says so", async () => {
    const files = setUp({ prompt: "x".repeat(MAX_MANIFEST_BYTES) });
    const { health, sessions } = await clineAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(health.state).toBe("ok");
    expect(health.detail).toContain(TOO_LARGE_NOTE);
    expect(files.reads).toEqual([]);
  });

  test("a manifest of a newer format is left out, and the card says so", async () => {
    const { health, sessions } = await clineAdapterFor(setUp({ version: 2 })).poll();
    expect(sessions).toEqual([]);
    expect(health.detail).toContain(NEWER_FORMAT_NOTE);
  });

  test("a manifest that names another session is left out", async () => {
    const files = setUp({ session_id: sessionIdOf(9) });
    expect((await clineAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("a manifest caught half written keeps its session for that poll", async () => {
    const files = setUp();
    const adapter = clineAdapterFor(files);
    await adapter.poll();
    files.rewrite(manifestFile(ID), '{ "version": 1', { mtimeMs: NOW });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("a link in place of a manifest is not opened", async () => {
    const files = setUp();
    files.special(manifestFile(ID));
    expect((await clineAdapterFor(files).poll()).sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("a manifest behind a link in place of a session's folder is not opened", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(SESSIONS_DIR);
    files.special(`${SESSIONS_DIR}/${ID}`);
    expect((await clineAdapterFor(files).poll()).sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test.each(["..", ".hidden", "a b", "sess\nion"])(
    "a folder named %j is not read",
    async (name) => {
      const files = memoryFiles(() => NOW);
      files.mkdir(SESSIONS_DIR);
      files.write(`${SESSIONS_DIR}/${name}/${name}.json`, manifestText(name));
      expect((await clineAdapterFor(files).poll()).sessions).toEqual([]);
      expect(files.opened()).toEqual([]);
    },
  );

  test("Cline's other files in the folder are not read as sessions", async () => {
    const files = memoryFiles(() => NOW);
    files.write(`${SESSIONS_DIR}/sessions.index.json`, PLACEHOLDER);
    files.write(`${SESSIONS_DIR}/subagent-spawn-queue.json`, PLACEHOLDER);
    expect((await clineAdapterFor(files).poll()).sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });
});

describe("Quiet for", () => {
  test("is the messages file's time when it is the newest, and the file is never opened", async () => {
    const files = setUp({}, NOW - 10 * MINUTE);
    files.write(messagesFile(ID), PLACEHOLDER, { mtimeMs: NOW - MINUTE });
    const { sessions } = await clineAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({
      statusSince: NOW - 10 * MINUTE,
      lastWriteAt: NOW - MINUTE,
    });
    expect(files.opened()).toEqual([manifestFile(ID)]);
  });

  test("is the manifest's time when it is the newest, or there is no messages file", async () => {
    const files = setUp({}, NOW - MINUTE);
    files.write(messagesFile(ID), PLACEHOLDER, { mtimeMs: NOW - HOUR });
    expect((await clineAdapterFor(files).poll()).sessions[0]?.lastWriteAt).toBe(NOW - MINUTE);

    files.remove(messagesFile(ID));
    expect((await clineAdapterFor(files).poll()).sessions[0]?.lastWriteAt).toBe(NOW - MINUTE);
  });

  test("a link in place of the messages file gives no time", async () => {
    const files = setUp({}, NOW - HOUR);
    files.special(messagesFile(ID));
    expect((await clineAdapterFor(files).poll()).sessions[0]?.lastWriteAt).toBe(NOW - HOUR);
  });
});

test("a wait stays one wait while its manifest is written, and a new one has a new time", async () => {
  const clock = handClock();
  const files = setUp({ status: "pending" }, NOW);
  const adapter = clineAdapterFor(files, { now: clock.now });
  expect((await adapter.poll()).sessions[0]).toMatchObject({
    status: "needs-you",
    statusSince: NOW,
  });

  // The title moves on while the approval is asked. It is the same wait.
  clock.advance(MINUTE);
  files.rewrite(
    manifestFile(ID),
    manifestText(ID, { status: "pending", metadata: { title: "renamed" } }),
    { mtimeMs: clock.now() },
  );
  expect((await adapter.poll()).sessions[0]).toMatchObject({
    status: "needs-you",
    statusSince: NOW,
  });

  clock.advance(MINUTE);
  files.rewrite(manifestFile(ID), manifestText(ID), { mtimeMs: clock.now() });
  expect((await adapter.poll()).sessions[0]).toMatchObject({
    status: "working",
    statusSince: NOW + 2 * MINUTE,
  });

  clock.advance(MINUTE);
  files.rewrite(manifestFile(ID), manifestText(ID, { status: "pending" }), {
    mtimeMs: clock.now(),
  });
  expect((await adapter.poll()).sessions[0]).toMatchObject({
    status: "needs-you",
    statusSince: NOW + 3 * MINUTE,
  });
});

test("nothing but the kept fields reaches a session or the card", async () => {
  const files = setUp();
  const { health, sessions } = await clineAdapterFor(files).poll();
  const shown = JSON.stringify({ health, sessions });
  for (const word of [
    PRIVATE_WORDS,
    PRIVATE_SYSTEM_PROMPT,
    "demo task",
    "demo-provider",
    "demo-model",
    "team-demo",
    "totalCost",
    "inputTokens",
  ]) {
    expect(shown).not.toContain(word);
  }
  expect(Object.keys(sessions[0] ?? {}).sort()).toEqual(
    [
      "alive",
      "cwd",
      "id",
      "lastWriteAt",
      "links",
      "name",
      "pid",
      "project",
      "source",
      "stale",
      "startedAt",
      "status",
      "statusSince",
      "surface",
    ].sort(),
  );
  expect(sessions[0]).not.toHaveProperty("tokens");
  expect(sessions[0]).not.toHaveProperty("jump");
  expect(sessions[0]).not.toHaveProperty("stop");
});

test("reads nothing in Cline's folder but manifests, and asks nothing of them but their times", async () => {
  const files = setUp();
  await clineAdapterFor(files).poll();
  expect(files.opened()).toEqual([manifestFile(ID)]);
  expect(files.count("stat")).toBe(0);
});

test("says where it looks while its first poll runs", () => {
  const adapter = clineAdapterFor(memoryFiles(() => NOW));
  expect(adapter.lookingIn).toBe("Looking for Cline sessions in ~/.cline/data/sessions.");
  expect(adapter).not.toHaveProperty("lastMessage");
});
