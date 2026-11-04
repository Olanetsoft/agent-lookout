import { describe, expect, test } from "vitest";

import {
  kimiCodeHomeFor,
  NEEDS_YOU_NOTE,
  OPEN_NOTE,
  RECHECK_MS,
  SWEEP_MS,
  TOO_LARGE_NOTE,
  UNCHECKED_NOTE,
} from "@collector/adapters/kimi-code/index";
import { MAX_STATE_BYTES } from "@collector/adapters/kimi-code/sessionState";
import { STALE_THRESHOLD_MS } from "@core/sessions/staleness";
import {
  CREATED_AT,
  DAY,
  HOME,
  HOUR,
  indexFile,
  indexLine,
  KIMI_HOME,
  LOCKED_AT,
  lockFile,
  lockText,
  MINUTE,
  NOW,
  PID,
  PRIVATE_WORDS,
  PROJECT,
  sessionIdOf,
  stateFile,
  stateText,
  UPDATED_AT,
  wireAnswered,
  wireAsked,
  wireFile,
  wirePrompt,
  wireStart,
} from "@tests/fixtures/kimi-code/kimiCode";
import {
  handClock,
  healthy,
  kimiCodeAdapterFor,
  memoryFiles,
  standInProcesses,
  standInStarts,
  type MemoryFiles,
} from "@tests/support/adapters/kimi-code/kimiCodeAdapter";
import { asWritten } from "@tests/support/paths";

const ID = sessionIdOf(1);
const SESSION = `kimi-code:${ID}`;
const ASKED_AT = LOCKED_AT + 1000;

/** Writes a session's `state.json` and its line in the index, as Kimi Code leaves them. */
function write(
  files: MemoryFiles,
  id: string,
  changes: Record<string, unknown> = {},
  mtimeMs = UPDATED_AT,
) {
  const line = indexLine(id);
  try {
    files.append(indexFile(), line);
  } catch {
    files.write(indexFile(), line);
  }
  files.write(stateFile(id), stateText(id, changes), { mtimeMs });
}

/** One session with its `state.json` and an event file with no wait in it. */
function setUp(changes: Record<string, unknown> = {}, mtimeMs?: number) {
  const files = memoryFiles(() => NOW);
  write(files, ID, changes, mtimeMs);
  files.write(wireFile(ID), wireStart() + wirePrompt());
  return files;
}

/** One session with a lock on it. */
function setUpLocked(changes: Record<string, unknown> = {}) {
  const files = setUp();
  files.write(lockFile(ID), lockText(changes));
  return files;
}

describe("kimiCodeHomeFor", () => {
  const home = (env: NodeJS.ProcessEnv) => asWritten(kimiCodeHomeFor(env, HOME));

  test("is ~/.kimi-code when nothing names another", () => {
    expect(home({})).toBe(KIMI_HOME);
    expect(home({ KIMI_CODE_HOME: "  " })).toBe(KIMI_HOME);
  });

  test("follows Kimi Code's own variable", () => {
    expect(home({ KIMI_CODE_HOME: "/tmp/kimi" })).toBe("/tmp/kimi");
  });

  test("AGENT_LOOKOUT_KIMI_CODE_HOME names it over that", () => {
    expect(home({ AGENT_LOOKOUT_KIMI_CODE_HOME: "/tmp/mine", KIMI_CODE_HOME: "/tmp/kimi" })).toBe(
      "/tmp/mine",
    );
  });
});

describe("with no Kimi Code", () => {
  test("says it was not found, with no advice, and looks again once a minute", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });

    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({
      id: "kimi-code",
      label: "Kimi Code",
      state: "unavailable",
      detail:
        "Kimi Code was not found: there is no ~/.kimi-code folder. Agent Lookout looks again every minute.",
    });
    expect(health).not.toHaveProperty("advice");
    expect(sessions).toEqual([]);
    expect(files.count()).toBe(2);

    clock.advance(RECHECK_MS - 1);
    await adapter.poll();
    expect(files.count()).toBe(2);

    clock.advance(1);
    await adapter.poll();
    expect(files.count()).toBe(4);
  });

  test("a clock set back counts as time enough to look again", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.advance(-1);
    await adapter.poll();
    expect(files.count()).toBe(4);
  });

  test("says when KIMI_CODE_HOME named the folder that is missing", async () => {
    const adapter = kimiCodeAdapterFor(
      memoryFiles(() => NOW),
      {
        env: { KIMI_CODE_HOME: "/tmp/kimi-gone" },
      },
    );
    const { health } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toContain("KIMI_CODE_HOME is set, and there is no ");
  });

  test("a folder that AGENT_LOOKOUT_KIMI_CODE_HOME names is an answer, not a missing Kimi Code", async () => {
    const files = memoryFiles(() => NOW);
    const adapter = kimiCodeAdapterFor(files, {
      env: { AGENT_LOOKOUT_KIMI_CODE_HOME: "/tmp/kimi-gone" },
    });
    const { health } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain("AGENT_LOOKOUT_KIMI_CODE_HOME is set");
    await adapter.poll();
    expect(files.count("lstat")).toBe(2);
  });

  test("runs no process and reads no other file", async () => {
    const files = memoryFiles(() => NOW);
    const processes = standInProcesses();
    const starts = standInStarts();
    await kimiCodeAdapterFor(files, {
      isAlive: processes.isAlive,
      readProcessStarts: starts.read,
    }).poll();
    expect(processes.asked).toEqual([]);
    expect(starts.runs).toEqual([]);
    expect(files.opened()).toEqual([]);
  });
});

describe("with a Kimi Code that has saved no session", () => {
  test("is watched, and lists none", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(KIMI_HOME);
    const { health, sessions } = await kimiCodeAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `Kimi Code has not saved any sessions in ~/.kimi-code yet. ${NEEDS_YOU_NOTE} ${OPEN_NOTE} ${UNCHECKED_NOTE}`,
    );
    expect(sessions).toEqual([]);
  });

  test("a file at the folder's name is no Kimi Code", async () => {
    const files = memoryFiles(() => NOW);
    files.write(KIMI_HOME, "placeholder");
    expect((await kimiCodeAdapterFor(files).poll()).health.state).toBe("unavailable");
  });

  test("a folder that cannot be looked at is not called missing", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(KIMI_HOME);
    files.fail(KIMI_HOME);
    expect((await kimiCodeAdapterFor(files).poll()).health.state).toBe("ok");
  });
});

describe("what it says of itself", () => {
  test("a healthy poll says where it reads, and what cannot be told", async () => {
    const { health, basis } = await kimiCodeAdapterFor(setUp()).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(healthy());
    expect(basis).toBe("files");
    expect(health.watching).toEqual([
      { label: "Sessions folder", value: "~/.kimi-code/sessions" },
      { label: "Session index", value: "~/.kimi-code/session_index.jsonl" },
      { label: "Locks folder", value: "~/.kimi-code/locks/sessions" },
      { label: "Read", value: "every 2 seconds" },
      { label: "Process check", value: "ps -o pid=,lstart= -p <pids>" },
      {
        label: "Process check run",
        value: "every 30 seconds while a session's process runs, and sooner when another appears",
      },
    ]);
  });

  test("where ps is not asked, it says signal 0 is all there is", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const { health } = await kimiCodeAdapterFor(setUp(), { platform }).poll();
      expect(health.watching).toContainEqual({
        label: "Process check",
        value: "signal 0 alone, every 2 seconds",
      });
    }
  });

  test("names where it looks while the first poll runs", () => {
    const adapter = kimiCodeAdapterFor(setUp());
    expect(adapter.lookingIn).toBe("Looking for Kimi Code sessions in ~/.kimi-code.");
  });
});

describe("what cannot be read", () => {
  test("a link in place of the index is an error", async () => {
    const files = memoryFiles(() => NOW);
    files.special(indexFile());
    const { health, sessions } = await kimiCodeAdapterFor(files).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain("~/.kimi-code/session_index.jsonl could not be read");
    expect(sessions).toEqual([]);
  });

  test("a folder of locks that cannot be listed is an error, not a folder of no locks", async () => {
    const files = setUpLocked();
    files.fail(`${KIMI_HOME}/locks/sessions`);
    const { health, sessions } = await kimiCodeAdapterFor(files).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain("~/.kimi-code/locks/sessions could not be listed");
    expect(sessions).toEqual([]);
  });

  test("anything unexpected is a sentence, not a throw", async () => {
    const adapter = kimiCodeAdapterFor(setUp(), {
      isAlive: () => {
        throw new Error("placeholder");
      },
    });
    const files = setUpLocked();
    const failing = kimiCodeAdapterFor(files, {
      isAlive: () => {
        throw new Error("placeholder");
      },
    });
    await expect(adapter.poll()).resolves.toBeTruthy();
    const { health } = await failing.poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe("Something unexpected went wrong while reading Kimi Code sessions.");
  });
});

describe("each status", () => {
  test("a lock a process that runs holds is working, from when it was taken", async () => {
    const { sessions } = await kimiCodeAdapterFor(setUpLocked()).poll();
    expect(sessions).toEqual([
      {
        id: SESSION,
        source: "kimi-code",
        surface: "unknown",
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "working",
        startedAt: CREATED_AT,
        statusSince: LOCKED_AT,
        links: {},
        stale: false,
        pid: PID,
        alive: true,
        lastWriteAt: NOW,
      },
    ]);
  });

  test("a session with no lock that Agent Lookout never saw held is finished", async () => {
    const { sessions } = await kimiCodeAdapterFor(setUp()).poll();
    expect(sessions).toMatchObject([{ id: SESSION, status: "finished", statusSince: UPDATED_AT }]);
    expect(sessions[0]).not.toHaveProperty("pid");
    expect(sessions[0]).not.toHaveProperty("alive");
  });

  test("a lock let go leaves a session idle while its process runs, then finished", async () => {
    const files = setUpLocked();
    const processes = standInProcesses([PID]);
    const adapter = kimiCodeAdapterFor(files, { isAlive: processes.isAlive });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");

    files.remove(lockFile(ID));
    const idle = (await adapter.poll()).sessions[0];
    expect(idle).toMatchObject({ status: "idle", statusSince: UPDATED_AT, pid: PID, alive: true });
    expect(idle).not.toHaveProperty("lastWriteAt");

    processes.stop(PID);
    const finished = (await adapter.poll()).sessions[0];
    expect(finished).toMatchObject({ status: "finished", statusSince: UPDATED_AT });
    expect(finished).not.toHaveProperty("pid");
    expect(finished).not.toHaveProperty("alive");
  });

  test("an idle session stays idle poll after poll, for as long as its process runs", async () => {
    const files = setUpLocked();
    const processes = standInProcesses([PID]);
    const adapter = kimiCodeAdapterFor(files, { isAlive: processes.isAlive });
    await adapter.poll();
    files.remove(lockFile(ID));
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
    }
  });

  test("once a process has gone, one given its pid does not bring the session back", async () => {
    const files = setUpLocked();
    const processes = standInProcesses([PID]);
    const adapter = kimiCodeAdapterFor(files, { isAlive: processes.isAlive, platform: "linux" });
    await adapter.poll();
    files.remove(lockFile(ID));
    processes.stop(PID);
    await adapter.poll();
    processes.start(PID);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("a last turn that failed is failed, once no lock is held", async () => {
    const { sessions } = await kimiCodeAdapterFor(setUp({ lastTurnReason: "failed" })).poll();
    expect(sessions[0]).toMatchObject({ status: "failed", statusSince: UPDATED_AT });
  });

  test("a new turn over a failed one is working", async () => {
    const files = setUp({ lastTurnReason: "failed" });
    files.write(lockFile(ID), lockText());
    expect((await kimiCodeAdapterFor(files).poll()).sessions[0]?.status).toBe("working");
  });

  test("a turn that was cancelled or completed says nothing more than no lock does", async () => {
    for (const lastTurnReason of ["cancelled", "completed", undefined, "something-new"]) {
      const { sessions } = await kimiCodeAdapterFor(setUp({ lastTurnReason })).poll();
      expect(sessions[0]?.status, String(lastTurnReason)).toBe("finished");
    }
  });

  test("an idle session stays listed past a day, and is stale", async () => {
    const files = setUpLocked();
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.remove(lockFile(ID));
    clock.advance(STALE_THRESHOLD_MS + 2 * HOUR);
    const { sessions } = await adapter.poll();
    expect(sessions[0]).toMatchObject({ status: "idle", stale: true });
  });
});

describe("a wait", () => {
  /** A locked session whose event file ends with these lines. */
  function waiting(...lines: string[]) {
    const files = setUpLocked();
    files.write(wireFile(ID), wireStart() + wirePrompt() + lines.join(""));
    return files;
  }

  test("for an approval needs you, from when it was asked", async () => {
    const { sessions } = await kimiCodeAdapterFor(
      waiting(wireAsked("approval_1", "approval", ASKED_AT)),
    ).poll();
    expect(sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: ASKED_AT,
    });
    expect(sessions[0]).not.toHaveProperty("waitingText");
  });

  test("for a question needs you too", async () => {
    const { sessions } = await kimiCodeAdapterFor(
      waiting(wireAsked("question_1", "question", ASKED_AT)),
    ).poll();
    expect(sessions[0]).toMatchObject({ status: "needs-you", waitingReason: "question" });
  });

  test("once answered, the session works on", async () => {
    const files = waiting(wireAsked("approval_1", "approval", ASKED_AT));
    const adapter = kimiCodeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");

    files.append(wireFile(ID), wireAnswered("approval_1", ASKED_AT + 1000), { mtimeMs: NOW + 1 });
    const { sessions } = await adapter.poll();
    expect(sessions[0]).toMatchObject({ status: "working", statusSince: LOCKED_AT });
    expect(sessions[0]).not.toHaveProperty("waitingReason");
  });

  test("a client's own tool is not a wait for the person", async () => {
    const { sessions } = await kimiCodeAdapterFor(
      waiting(wireAsked("main:interaction-0", "user_tool", ASKED_AT)),
    ).poll();
    expect(sessions[0]?.status).toBe("working");
  });

  test("keeps the time it began while more is asked and part of it is answered", async () => {
    const files = waiting(wireAsked("approval_1", "approval", ASKED_AT));
    const adapter = kimiCodeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.statusSince).toBe(ASKED_AT);

    files.append(wireFile(ID), wireAsked("approval_2", "approval", ASKED_AT + 500), {
      mtimeMs: NOW + 1,
    });
    expect((await adapter.poll()).sessions[0]?.statusSince).toBe(ASKED_AT);

    files.append(wireFile(ID), wireAnswered("approval_1", ASKED_AT + 900), { mtimeMs: NOW + 2 });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: ASKED_AT,
    });
  });

  test("a new wait after one that was answered is a new wait", async () => {
    const files = waiting(wireAsked("approval_1", "approval", ASKED_AT));
    const adapter = kimiCodeAdapterFor(files);
    await adapter.poll();
    files.append(
      wireFile(ID),
      wireAnswered("approval_1", ASKED_AT + 900) +
        wireAsked("approval_2", "approval", ASKED_AT + 1000),
      { mtimeMs: NOW + 1 },
    );
    expect((await adapter.poll()).sessions[0]?.statusSince).toBe(ASKED_AT + 1000);
  });

  describe("a crash left behind", () => {
    const crashed = () => waiting(wireAsked("approval_1", "approval", ASKED_AT));

    test("does not stick once its process has gone", async () => {
      const files = crashed();
      const processes = standInProcesses([PID]);
      const adapter = kimiCodeAdapterFor(files, { isAlive: processes.isAlive });
      expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");

      processes.stop(PID);
      const { sessions } = await adapter.poll();
      expect(sessions[0]?.status).toBe("finished");
      expect(sessions[0]).not.toHaveProperty("waitingReason");
    });

    test("is never shown when its process was already gone", async () => {
      const { sessions } = await kimiCodeAdapterFor(crashed(), { isAlive: () => false }).poll();
      expect(sessions[0]?.status).toBe("finished");
    });

    test("is not read at all with no process that holds a lock", async () => {
      const files = crashed();
      await kimiCodeAdapterFor(files, { isAlive: () => false }).poll();
      expect(files.opened()).not.toContain(wireFile(ID));
    });

    test("does not count for the next process to take the lock", async () => {
      const files = crashed();
      files.write(lockFile(ID), lockText({ pid: PID + 1, startedAt: ASKED_AT + 5000 }));
      const { sessions } = await kimiCodeAdapterFor(files).poll();
      expect(sessions[0]).toMatchObject({
        status: "working",
        pid: PID + 1,
        statusSince: ASKED_AT + 5000,
      });
    });

    test("does not hide a wait of the process that holds the lock now", async () => {
      const files = crashed();
      files.write(lockFile(ID), lockText({ pid: PID + 1, startedAt: ASKED_AT + 5000 }));
      files.append(wireFile(ID), wireAsked("question_1", "question", ASKED_AT + 6000));
      expect((await kimiCodeAdapterFor(files).poll()).sessions[0]).toMatchObject({
        status: "needs-you",
        waitingReason: "question",
        statusSince: ASKED_AT + 6000,
      });
    });
  });

  test("with no event file, the session works on", async () => {
    const files = setUpLocked();
    files.remove(wireFile(ID));
    const { sessions } = await kimiCodeAdapterFor(files).poll();
    expect(sessions[0]?.status).toBe("working");
    expect(sessions[0]).not.toHaveProperty("lastWriteAt");
  });

  test("an answer in the same tick of the file's clock is read", async () => {
    const files = setUpLocked();
    files.write(
      wireFile(ID),
      wireStart() + wirePrompt() + wireAsked("approval_1", "approval", ASKED_AT),
      { mtimeMs: NOW },
    );
    const adapter = kimiCodeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    files.append(wireFile(ID), wireAnswered("approval_1", ASKED_AT + 1), { mtimeMs: NOW });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  describe("a look at the event file", () => {
    test("that fails keeps the wait, its time and the last write", async () => {
      const files = waiting(wireAsked("approval_1", "approval", ASKED_AT));
      const adapter = kimiCodeAdapterFor(files);
      expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
      files.fail(wireFile(ID));
      expect((await adapter.poll()).sessions[0]).toMatchObject({
        status: "needs-you",
        statusSince: ASKED_AT,
        lastWriteAt: NOW,
      });
    });

    test("that fails does not carry a wait over to the next process to take the lock", async () => {
      const files = waiting(wireAsked("approval_1", "approval", ASKED_AT));
      const adapter = kimiCodeAdapterFor(files);
      await adapter.poll();
      files.fail(wireFile(ID));
      files.write(lockFile(ID), lockText({ pid: PID + 1, startedAt: ASKED_AT + 5000 }));
      expect((await adapter.poll()).sessions[0]).toMatchObject({
        status: "working",
        pid: PID + 1,
      });
    });

    test("that fails with nothing read before shows no wait, until one works", async () => {
      const files = waiting(wireAsked("approval_1", "approval", ASKED_AT));
      files.fail(wireFile(ID));
      const adapter = kimiCodeAdapterFor(files);
      expect((await adapter.poll()).sessions[0]?.status).toBe("working");
      files.heal(wireFile(ID));
      expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    });

    test("that finds it gone takes the wait with it", async () => {
      const files = waiting(wireAsked("approval_1", "approval", ASKED_AT));
      const adapter = kimiCodeAdapterFor(files);
      await adapter.poll();
      files.remove(wireFile(ID));
      expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    });
  });
});

describe("a process that is not the lock's", () => {
  test("a dead pid leaves a lock behind, and the session is finished", async () => {
    const { sessions } = await kimiCodeAdapterFor(setUpLocked(), { isAlive: () => false }).poll();
    expect(sessions[0]?.status).toBe("finished");
    expect(sessions[0]).not.toHaveProperty("pid");
  });

  test("a lock that names no process, or no time, is no lock", async () => {
    for (const changes of [{ pid: "x" }, { pid: 0 }, { startedAt: "soon" }, { startedAt: null }]) {
      const processes = standInProcesses([PID]);
      const { sessions } = await kimiCodeAdapterFor(setUpLocked(changes), {
        isAlive: processes.isAlive,
      }).poll();
      expect(sessions[0]?.status, JSON.stringify(changes)).toBe("finished");
    }
  });

  test("a broken lock leaves the session as its last holder left it", async () => {
    const files = setUpLocked();
    const adapter = kimiCodeAdapterFor(files);
    await adapter.poll();
    files.write(lockFile(ID), "{ not json");
    expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
  });

  test("a lock from before the computer started is left behind, whatever has its pid", async () => {
    const { sessions } = await kimiCodeAdapterFor(setUpLocked(), {
      platform: "linux",
      uptimeMs: () => 30_000,
    }).poll();
    expect(sessions[0]?.status).toBe("finished");
  });

  describe("on a Mac", () => {
    test("a process that started after the lock was taken was given its pid", async () => {
      const starts = standInStarts({ [PID]: LOCKED_AT + 2 * MINUTE });
      const { sessions } = await kimiCodeAdapterFor(setUpLocked(), {
        readProcessStarts: starts.read,
      }).poll();
      expect(sessions[0]?.status).toBe("finished");
      expect(starts.runs).toEqual([[PID]]);
    });

    test("a process that started before the lock was taken holds it", async () => {
      const starts = standInStarts({ [PID]: LOCKED_AT - MINUTE });
      const { sessions } = await kimiCodeAdapterFor(setUpLocked(), {
        readProcessStarts: starts.read,
      }).poll();
      expect(sessions[0]?.status).toBe("working");
    });

    test("ps that says nothing leaves the session as signal 0 says", async () => {
      const starts = standInStarts();
      starts.fails = true;
      const { sessions } = await kimiCodeAdapterFor(setUpLocked(), {
        readProcessStarts: starts.read,
      }).poll();
      expect(sessions[0]?.status).toBe("working");
    });

    test("an answer stands: a later check that cannot answer does not bring the session back", async () => {
      const files = setUpLocked();
      const clock = handClock();
      const starts = standInStarts({ [PID]: LOCKED_AT + 2 * MINUTE });
      const adapter = kimiCodeAdapterFor(files, { now: clock.now, readProcessStarts: starts.read });
      await adapter.poll();
      starts.fails = true;
      clock.advance(10 * MINUTE);
      expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    });

    test("a process that took the pid of an idle session's last holder ends the session", async () => {
      const files = setUpLocked();
      const clock = handClock();
      const starts = standInStarts({ [PID]: LOCKED_AT - MINUTE });
      const adapter = kimiCodeAdapterFor(files, { now: clock.now, readProcessStarts: starts.read });
      await adapter.poll();
      files.remove(lockFile(ID));
      expect((await adapter.poll()).sessions[0]?.status).toBe("idle");

      starts.starts.set(PID, NOW + 5 * MINUTE);
      clock.advance(10 * MINUTE);
      expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    });

    test("a lock a crash left does not rule out a later lock by the process given its pid", async () => {
      const other = sessionIdOf(2);
      const files = setUpLocked();
      write(files, other);
      files.write(lockFile(other), lockText({ startedAt: LOCKED_AT + 3 * MINUTE }));
      const starts = standInStarts({ [PID]: LOCKED_AT + 2 * MINUTE });
      const { sessions } = await kimiCodeAdapterFor(files, {
        now: () => NOW + 10 * MINUTE,
        readProcessStarts: starts.read,
      }).poll();
      expect(sessions.map(({ status }) => status)).toEqual(["finished", "working"]);
    });

    test("no lock means no run of ps", async () => {
      const starts = standInStarts();
      await kimiCodeAdapterFor(setUp(), { readProcessStarts: starts.read }).poll();
      expect(starts.runs).toEqual([]);
    });
  });

  describe("on Linux and Windows", () => {
    test.each(["linux", "win32"] as const)("%s: ps is never asked", async (platform) => {
      const starts = standInStarts({ [PID]: NOW });
      const { sessions } = await kimiCodeAdapterFor(setUpLocked(), {
        platform,
        readProcessStarts: starts.read,
      }).poll();
      expect(starts.runs).toEqual([]);
      expect(sessions[0]?.status).toBe("working");
    });
  });
});

describe("which sessions are listed", () => {
  test("a session whose folder has gone is not listed, though the index names it", async () => {
    const files = memoryFiles(() => NOW);
    files.write(indexFile(), indexLine(ID));
    expect((await kimiCodeAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("a broken state.json, or wrong types in one, shows nothing worse than none", async () => {
    const files = setUp();
    files.write(stateFile(ID), "{ not json");
    expect((await kimiCodeAdapterFor(files).poll()).sessions).toEqual([]);

    const wrong = setUp({ cwd: 5, createdAt: "soon", updatedAt: {}, title: [], titleKind: 7 });
    const { sessions } = await kimiCodeAdapterFor(wrong).poll();
    expect(sessions[0]).toMatchObject({
      cwd: PROJECT,
      name: "demo-project",
      startedAt: null,
      status: "finished",
      statusSince: UPDATED_AT,
    });
  });

  test("a state.json over the limit leaves its session out, and the card says so", async () => {
    const files = setUp();
    files.write(stateFile(ID), "x".repeat(MAX_STATE_BYTES + 1));
    const { health, sessions } = await kimiCodeAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(health.detail).toBe(`${healthy()} ${TOO_LARGE_NOTE}`);
  });

  test("a session the person archived, and a child session, are left out", async () => {
    const archived = setUp({ archived: true });
    expect((await kimiCodeAdapterFor(archived).poll()).sessions).toEqual([]);
    const child = setUp({ custom: { child_session_kind: "child" } });
    expect((await kimiCodeAdapterFor(child).poll()).sessions).toEqual([]);
  });

  test("a line for a deleted session leaves it out, though its files stay", async () => {
    const files = setUp();
    files.append(indexFile(), `${JSON.stringify({ sessionId: ID, deleted: true })}\n`);
    expect((await kimiCodeAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("a session is listed for a day after state.json was last written", async () => {
    const recent = await kimiCodeAdapterFor(setUp({}, NOW - DAY + 1)).poll();
    expect(recent.sessions).toHaveLength(1);
    const old = await kimiCodeAdapterFor(setUp({}, NOW - DAY)).poll();
    expect(old.sessions).toEqual([]);
  });

  test("an old state.json is not opened, and is looked up only by a sweep", async () => {
    const files = setUp({}, NOW - 2 * DAY);
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    expect(files.opened()).toEqual([indexFile()]);

    files.forget();
    clock.advance(2_000);
    await adapter.poll();
    expect(files.count("lstat", (target) => target === stateFile(ID))).toBe(0);

    clock.advance(SWEEP_MS);
    await adapter.poll();
    expect(files.count("lstat", (target) => target === stateFile(ID))).toBe(1);
  });

  test("a session written again after a day is found by the next sweep", async () => {
    const files = setUp({}, NOW - 2 * DAY);
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.advance(SWEEP_MS);
    files.write(stateFile(ID), stateText(ID), { mtimeMs: clock.now() });
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("a lock on an old session lists it at once, for as long as it is held", async () => {
    const files = setUp({}, NOW - 2 * DAY);
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.advance(2_000);
    files.write(lockFile(ID), lockText());
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a lock a crash left on an old session does not list it", async () => {
    const files = setUp({}, NOW - 2 * DAY);
    files.write(lockFile(ID), lockText());
    const { sessions } = await kimiCodeAdapterFor(files, { isAlive: () => false }).poll();
    expect(sessions).toEqual([]);
  });

  test("a new session is found on the next poll", async () => {
    const files = setUp();
    const adapter = kimiCodeAdapterFor(files);
    await adapter.poll();
    const other = sessionIdOf(2);
    files.append(indexFile(), indexLine(other), { mtimeMs: NOW + 1 });
    files.write(stateFile(other), stateText(other));
    expect((await adapter.poll()).sessions.map(({ id }) => id)).toEqual([
      SESSION,
      `kimi-code:${other}`,
    ]);
  });

  test("the folder going away says it was not found", async () => {
    const files = setUpLocked();
    const adapter = kimiCodeAdapterFor(files);
    await adapter.poll();
    files.remove(KIMI_HOME);
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(sessions).toEqual([]);
  });

  test("the index going away forgets the process that held a session", async () => {
    const files = setUpLocked();
    const adapter = kimiCodeAdapterFor(files);
    await adapter.poll();
    files.remove(lockFile(ID));
    files.remove(indexFile());
    await adapter.poll();
    files.write(indexFile(), indexLine(ID), { mtimeMs: NOW + 1 });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("a clock set back counts as time enough for a sweep", async () => {
    const files = setUp({}, NOW - 2 * DAY);
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(-1000);
    await adapter.poll();
    expect(files.count("lstat", (target) => target === stateFile(ID))).toBe(1);
  });

  test("an old session stays settled over every poll between sweeps", async () => {
    const files = setUp({}, NOW - 2 * DAY);
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    for (let poll = 0; poll < 3; poll += 1) {
      clock.advance(2_000);
      await adapter.poll();
    }
    expect(files.count("lstat", (target) => target === stateFile(ID))).toBe(0);
  });

  test("a session that ages out is looked up only by a sweep", async () => {
    const files = setUp({}, NOW - DAY + 1000);
    const clock = handClock();
    const adapter = kimiCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.advance(2_000);
    expect((await adapter.poll()).sessions).toEqual([]);
    files.forget();
    clock.advance(2_000);
    await adapter.poll();
    expect(files.count("lstat", (target) => target === stateFile(ID))).toBe(0);
  });

  test("a state.json it cannot use is not opened again until it changes", async () => {
    const files = setUp({ archived: true });
    const adapter = kimiCodeAdapterFor(files);
    await adapter.poll();
    files.forget();
    await adapter.poll();
    expect(files.opened()).toEqual([]);
  });

  describe("a look at state.json", () => {
    test("that fails keeps the session and its process", async () => {
      const files = setUpLocked();
      const adapter = kimiCodeAdapterFor(files);
      await adapter.poll();
      files.remove(lockFile(ID));
      expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
      files.fail(stateFile(ID));
      expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
      files.heal(stateFile(ID));
      expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
    });

    test("that fails keeps a working session, and opens nothing", async () => {
      const files = setUpLocked();
      const adapter = kimiCodeAdapterFor(files);
      await adapter.poll();
      files.fail(stateFile(ID));
      files.forget();
      expect((await adapter.poll()).sessions[0]?.status).toBe("working");
      expect(files.opened()).toEqual([]);
    });

    test("that fails with nothing read before leaves the session out, until a sweep", async () => {
      const files = setUp();
      files.fail(stateFile(ID));
      const clock = handClock();
      const adapter = kimiCodeAdapterFor(files, { now: clock.now });
      expect((await adapter.poll()).sessions).toEqual([]);
      files.heal(stateFile(ID));
      clock.advance(SWEEP_MS);
      expect((await adapter.poll()).sessions).toHaveLength(1);
    });

    test("that finds it gone takes the session off the list", async () => {
      const files = setUp();
      const adapter = kimiCodeAdapterFor(files);
      await adapter.poll();
      files.remove(stateFile(ID));
      expect((await adapter.poll()).sessions).toEqual([]);
    });
  });
});

describe("what it costs and what it keeps", () => {
  test("nothing but the kept fields reaches a session", async () => {
    const files = setUpLocked();
    files.write(
      wireFile(ID),
      wireStart() + wirePrompt() + wireAsked("approval_1", "approval", ASKED_AT),
    );
    const { sessions, health } = await kimiCodeAdapterFor(files).poll();
    const text = JSON.stringify({ sessions, health });
    expect(sessions[0]?.status).toBe("needs-you");
    for (const word of [PRIVATE_WORDS, "demo-tool", "demo-host", "kimi_code_cli", "call_demo"]) {
      expect(text).not.toContain(word);
    }
  });

  test("the session's name is never what was typed, by default", async () => {
    const { sessions } = await kimiCodeAdapterFor(setUp()).poll();
    expect(sessions[0]?.name).toBe("demo-project");
  });

  test("the name is one a model or a person set", async () => {
    const generated = setUp({ title: "demo release", titleKind: "generated" });
    expect((await kimiCodeAdapterFor(generated).poll()).sessions[0]?.name).toBe("demo release");
    const custom = setUp({ title: "demo rename", titleKind: "custom", isCustomTitle: true });
    expect((await kimiCodeAdapterFor(custom).poll()).sessions[0]?.name).toBe("demo rename");
  });

  test("a poll with nothing changed opens nothing", async () => {
    const files = setUpLocked();
    const adapter = kimiCodeAdapterFor(files);
    await adapter.poll();
    files.forget();
    await adapter.poll();
    expect(files.opened()).toEqual([]);
    expect(files.reads).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("only the session's own files are opened", async () => {
    const files = setUpLocked();
    await kimiCodeAdapterFor(files).poll();
    expect(new Set(files.opened())).toEqual(
      new Set([indexFile(), lockFile(ID), stateFile(ID), wireFile(ID)]),
    );
  });

  test("the event file is read only while a lock is held", async () => {
    const files = setUp();
    await kimiCodeAdapterFor(files).poll();
    expect(files.count(undefined, (target) => target === wireFile(ID))).toBe(0);
  });

  test("finds Kimi Code's folder where its own variable names it", async () => {
    const home = "/tmp/kimi-own";
    const files = memoryFiles(() => NOW);
    files.write(indexFile(home), indexLine(ID));
    files.write(stateFile(ID, home), stateText(ID));
    const { sessions } = await kimiCodeAdapterFor(files, { env: { KIMI_CODE_HOME: home } }).poll();
    expect(sessions).toHaveLength(1);
  });
});
