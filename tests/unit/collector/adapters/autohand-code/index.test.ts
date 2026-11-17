import { execFile, spawn } from "node:child_process";

import { describe, expect, test, vi } from "vitest";

import {
  AUTOHAND_CODE_CAPABILITIES,
  BASIS,
  BASIS_WITHOUT_HEARTBEATS,
  NEWER_FORMAT_NOTE,
  noHeartbeatsNote,
  TOO_LARGE_NOTE,
  UNKNOWN_NOTE,
} from "@collector/adapters/autohand-code/index";
import type { Session } from "@core/sessions/session";
import {
  AUTOHAND_HOME,
  CANARY_MARK,
  CREATED_AT,
  DAY,
  HEARTBEATS_DIR,
  HOUR,
  INSTANCE_ID,
  MINUTE,
  NOW,
  OTHER_PID,
  OTHER_SESSION_ID,
  PID,
  PROJECT,
  SECOND,
  SESSIONS_DIR,
  SESSION_ID,
  heartbeat,
  importedMetadata,
  iso,
  metadata,
  metadataPath,
  presenceHeartbeat,
  sessionDir,
  transferredMetadata,
  written,
  writtenEscaped,
  heartbeatRecord,
  metadataRecord,
} from "@tests/fixtures/autohand-code/autohandCode";
import {
  autohandAdapterFor,
  handClock,
  healthy,
  memoryFiles,
  OTHER_UID,
  ownedFiles,
  removeHeartbeat,
  standInProcesses,
  writeHeartbeat,
  writeMetadata,
} from "@tests/support/adapters/autohand-code/autohandCodeAdapter";
import { watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";
import { asWritten } from "@tests/support/paths";
import { runPs } from "@collector/processes/ps";

// No program is started here, ps among them. A stand-in for each way one is
// started records whether it was asked to.
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("@collector/processes/ps", () => ({ runPs: vi.fn() }));

/** A pretend computer with Autohand Code's folders, a clock, the processes that run and an adapter over them. */
function computer(running: number[] = [PID]) {
  const clock = handClock();
  const files = memoryFiles(clock.now);
  const owned = ownedFiles(files);
  const processes = standInProcesses(running);
  files.mkdir(SESSIONS_DIR);
  files.mkdir(HEARTBEATS_DIR);
  const adapter = (options: Parameters<typeof autohandAdapterFor>[1] = {}) =>
    autohandAdapterFor(files, { now: clock.now, owned, isAlive: processes.isAlive, ...options });
  return { clock, files, owned, processes, adapter };
}

type Computer = ReturnType<typeof computer>;

/** A session's folder with its metadata.json, written now unless said otherwise. */
function session(pc: Computer, text = metadata(), options: { id?: string; mtimeMs?: number } = {}) {
  writeMetadata(pc.files, text, options);
}

const only = (sessions: Session[]) => {
  expect(sessions).toHaveLength(1);
  return sessions[0]!;
};

describe("a fresh heartbeat", () => {
  test("waiting for input needs you, whatever its status or the metadata.json say", async () => {
    const pc = computer();
    session(pc, metadata({ status: "completed", closedAt: NOW - MINUTE }));
    writeHeartbeat(pc.files, heartbeat({ phase: "waiting_input", status: "idle" }));
    const { health, sessions, basis } = await pc.adapter().poll();
    expect(basis).toBe(BASIS);
    expect(health.detail).toBe(healthy());
    expect(only(sessions)).toMatchObject({
      id: `autohand-code:${SESSION_ID}`,
      source: "autohand-code",
      status: "needs-you",
      waitingReason: "other",
      name: "demo-project",
      cwd: PROJECT,
      surface: "terminal",
      pid: PID,
      alive: true,
      startedAt: CREATED_AT,
      lastWriteAt: NOW,
    });
  });

  test("works while it thinks, edits or runs a command, and is idle while idle, whatever its status says", async () => {
    for (const [phase, status, shown] of [
      ["thinking", "idle", "working"],
      ["editing", "idle", "working"],
      ["running_command", "idle", "working"],
      ["idle", "working", "idle"],
    ] as const) {
      const pc = computer();
      session(pc, metadata({ status: "crashed" }));
      writeHeartbeat(pc.files, heartbeat({ phase, status }));
      expect(only((await pc.adapter().poll()).sessions).status, phase).toBe(shown);
    }
  });

  test("is fresh for 15 seconds and up to a minute ahead, and its process running past that is unknown", async () => {
    for (const [age, shown] of [
      [15_000, "working"],
      [15_001, "unknown"],
      [-60_000, "working"],
      [-60_001, "unknown"],
    ] as const) {
      const pc = computer();
      session(pc);
      writeHeartbeat(pc.files, heartbeat({ updatedAt: NOW - age }));
      const { sessions, health } = await pc.adapter().poll();
      expect(only(sessions).status, String(age)).toBe(shown);
      expect(health.detail?.includes(UNKNOWN_NOTE), String(age)).toBe(shown === "unknown");
    }
  });

  test("with a stage it does not know, or none, is unknown", async () => {
    for (const phase of ["dreaming", null]) {
      const pc = computer();
      session(pc);
      writeHeartbeat(pc.files, heartbeat({ phase }));
      expect(only((await pc.adapter().poll()).sessions).status).toBe("unknown");
    }
  });

  test("of a newer format is not read, and the card says so", async () => {
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, heartbeat({ version: 2 }));
    const { sessions, health } = await pc.adapter().poll();
    expect(only(sessions).status).toBe("unknown");
    expect(health.detail).toContain(NEWER_FORMAT_NOTE);
  });
});

describe("a heartbeat whose process has gone", () => {
  test("is unknown for 15 seconds, then finished, or failed when metadata.json says it crashed", async () => {
    const pc = computer([]);
    session(pc, metadata({ lastActiveAt: NOW - 30 * SECOND }));
    writeHeartbeat(pc.files, heartbeat({ updatedAt: NOW - 5 * SECOND }));
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
    pc.clock.set(NOW + 10 * SECOND + 1);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW - 5 * SECOND,
      pid: PID,
      alive: false,
    });

    const crashed = computer([]);
    session(crashed, metadata({ status: "crashed", lastActiveAt: NOW - 30 * SECOND }), {
      mtimeMs: NOW - 20 * SECOND,
    });
    writeHeartbeat(crashed.files, heartbeat({ updatedAt: NOW - 16 * SECOND }));
    expect(only((await crashed.adapter().poll()).sessions)).toMatchObject({
      status: "failed",
      statusSince: NOW - 16 * SECOND,
    });

    const none = computer([]);
    none.files.mkdir(sessionDir());
    writeHeartbeat(none.files, heartbeat({ updatedAt: NOW - 16 * SECOND }));
    expect(only((await none.adapter().poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW - 16 * SECOND,
    });
    expect(only((await none.adapter().poll()).sessions)).not.toHaveProperty("lastWriteAt");
  });

  test("stays finished while its file is unchanged, even when its process's ID is given to another", async () => {
    const pc = computer([]);
    session(pc);
    writeHeartbeat(pc.files, heartbeat({ updatedAt: NOW - 20 * SECOND }));
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions).status).toBe("finished");
    pc.processes.start(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("finished");
    // Once Autohand Code writes it again, its process is asked about again.
    writeHeartbeat(pc.files, heartbeat({ updatedAt: pc.clock.now() }));
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("working");
  });

  test("counts for nothing once the session was saved over 15 seconds after it, unlike one whose process runs", async () => {
    for (const [savedAgo, shown] of [
      [4 * SECOND, "unknown"],
      [5 * SECOND, "finished"],
      // A time that cannot be right is not believed.
      [-61 * SECOND, "finished"],
    ] as const) {
      const pc = computer([]);
      session(pc, metadata({ lastActiveAt: NOW - savedAgo }));
      writeHeartbeat(pc.files, heartbeat({ updatedAt: NOW - 20 * SECOND }));
      expect(only((await pc.adapter().poll()).sessions).status, String(savedAgo)).toBe(shown);
    }
    // One whose process runs still counts, as for a second process on the session.
    const running = computer();
    const closedAt = NOW - 4 * SECOND;
    session(running, metadata({ status: "completed", closedAt, lastActiveAt: closedAt }));
    writeHeartbeat(running.files, heartbeat({ updatedAt: NOW - 20 * SECOND }));
    expect(only((await running.adapter().poll()).sessions).status).toBe("unknown");
  });

  test("with a status this does not know is finished, and with no heartbeat unknown", async () => {
    const pc = computer([]);
    session(pc, metadata({ status: "paused" }));
    writeHeartbeat(pc.files, heartbeat({ updatedAt: NOW - 20 * SECOND }));
    expect(only((await pc.adapter().poll()).sessions).status).toBe("finished");
    const alone = computer();
    session(alone, metadata({ status: "paused" }));
    expect(only((await alone.adapter().poll()).sessions).status).toBe("unknown");
  });
});

describe("a session with no heartbeat", () => {
  test("closed is finished at its close, and marked completed with no close at its file's write", async () => {
    const pc = computer();
    session(
      pc,
      metadata({ status: "completed", closedAt: NOW - MINUTE, lastActiveAt: NOW - MINUTE }),
    );
    expect(only((await pc.adapter().poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW - MINUTE,
    });
    const unclosed = computer();
    session(unclosed, metadata({ status: "completed", lastActiveAt: NOW - 5 * MINUTE }), {
      mtimeMs: NOW - MINUTE + 0.7,
    });
    expect(only((await unclosed.adapter().poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW - MINUTE,
    });
  });

  test("crashed with nothing saved after is failed at its file's write", async () => {
    const pc = computer();
    session(pc, metadata({ status: "crashed", lastActiveAt: NOW - 2 * MINUTE }), {
      mtimeMs: NOW - MINUTE,
    });
    expect(only((await pc.adapter().poll()).sessions)).toMatchObject({
      status: "failed",
      statusSince: NOW - MINUTE,
    });
  });

  test("crashed and saved after, as a session that went on, is unknown, and finished once its heartbeat's process is gone", async () => {
    const pc = computer();
    session(pc, metadata({ status: "crashed", lastActiveAt: NOW - MINUTE - SECOND }), {
      mtimeMs: NOW - MINUTE,
    });
    expect(only((await pc.adapter().poll()).sessions).status).toBe("unknown");
    const gone = computer([]);
    session(gone, metadata({ status: "crashed", lastActiveAt: NOW - MINUTE - SECOND }), {
      mtimeMs: NOW - MINUTE,
    });
    writeHeartbeat(gone.files, heartbeat({ updatedAt: NOW - MINUTE }));
    expect(only((await gone.adapter().poll()).sessions).status).toBe("finished");
  });

  test("closed and written to after its close, as one resumed, is unknown", async () => {
    const closedAt = NOW - 2 * MINUTE;
    const pc = computer();
    session(pc, metadata({ status: "completed", closedAt, lastActiveAt: closedAt + SECOND + 1 }));
    expect(only((await pc.adapter().poll()).sessions).status).toBe("unknown");
    const closed = computer();
    session(closed, metadata({ status: "completed", closedAt, lastActiveAt: closedAt + SECOND }));
    expect(only((await closed.adapter().poll()).sessions).status).toBe("finished");
  });

  test("still open, with nothing remembered of it, is unknown", async () => {
    const pc = computer();
    session(pc);
    const { sessions, health } = await pc.adapter().poll();
    expect(only(sessions)).toMatchObject({ status: "unknown", statusSince: null });
    expect(health.detail).toContain(UNKNOWN_NOTE);
  });
});

describe("what is remembered once a heartbeat goes", () => {
  test("a session whose heartbeat went while its process runs is unknown, finished once the process ends, and stays so", async () => {
    // As when an editor's session over ACP closes: its heartbeat goes and metadata.json stays active.
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, heartbeat({ mode: "rpc" }));
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions).status).toBe("working");
    removeHeartbeat(pc.files);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
    pc.processes.stop(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW,
    });
    expect(only((await adapter.poll()).sessions)).not.toHaveProperty("pid");
    pc.processes.start(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("finished");
    // Written to after, it is running again somewhere.
    session(pc, metadata({ lastActiveAt: pc.clock.now() }));
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
  });

  test("a heartbeat another Autohand Code deleted once its process ended is finished at once", async () => {
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, heartbeat());
    const adapter = pc.adapter();
    await adapter.poll();
    pc.processes.stop(PID);
    removeHeartbeat(pc.files);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW,
    });
  });

  test("a heartbeat found with its process gone and then deleted is finished, even when its process's ID is given to another", async () => {
    const pc = computer([]);
    session(pc, metadata({ lastActiveAt: NOW - 30 * SECOND }));
    writeHeartbeat(pc.files, heartbeat({ updatedAt: NOW - 5 * SECOND }));
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
    removeHeartbeat(pc.files);
    pc.processes.start(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW - 5 * SECOND,
    });
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("finished");
  });

  test("a session found ended stays so when the clock is set back, until a run saves it on the new time", async () => {
    async function ended() {
      const pc = computer();
      session(pc);
      writeHeartbeat(pc.files, heartbeat());
      const adapter = pc.adapter();
      await adapter.poll();
      pc.processes.stop(PID);
      removeHeartbeat(pc.files);
      pc.clock.advance(2 * SECOND);
      expect(only((await adapter.poll()).sessions).status).toBe("finished");
      pc.clock.advance(-HOUR);
      expect(only((await adapter.poll()).sessions).status).toBe("finished");
      return { pc, adapter };
    }
    // Its last save, from before it ended, never counts as one after, even once the clock nears it.
    const before = await ended();
    before.pc.clock.set(NOW - 20 * SECOND);
    expect(only((await before.adapter.poll()).sessions).status).toBe("finished");
    // Saved by a run with --no-daemon after that poll, it runs again on the first save.
    before.pc.clock.advance(2 * SECOND);
    session(before.pc, metadata({ lastActiveAt: before.pc.clock.now() }));
    expect(only((await before.adapter.poll()).sessions).status).toBe("unknown");
    // Saved on the new time by a run with --no-daemon, it runs again.
    const { pc, adapter } = await ended();
    pc.clock.advance(2 * SECOND);
    session(pc, metadata({ lastActiveAt: pc.clock.now() }));
    await adapter.poll();
    pc.clock.advance(2 * SECOND);
    session(pc, metadata({ lastActiveAt: pc.clock.now() }));
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
  });

  test("takes the folder and the start of the heartbeat chosen now, never of an earlier one", async () => {
    const pc = computer([PID, OTHER_PID]);
    // Over 1 MiB, so the session shows from its heartbeat alone.
    session(pc, written({ ...metadataRecord(), pad: "p".repeat(1_048_576) }));
    writeHeartbeat(pc.files, heartbeat());
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      cwd: PROJECT,
      startedAt: CREATED_AT,
    });
    // Another process takes the session up, with a folder that is no whole path and a time that cannot be read.
    pc.processes.stop(PID);
    pc.clock.advance(2 * SECOND);
    writeHeartbeat(
      pc.files,
      heartbeat({
        pid: OTHER_PID,
        workspaceRoot: "relative/dir",
        updatedAt: pc.clock.now(),
      }).replace(`"startedAt": "${iso(CREATED_AT)}"`, '"startedAt": "not a time"'),
    );
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "working",
      cwd: null,
      startedAt: null,
    });
  });

  test("a session whose process went on to another, in a terminal or for one prompt, is finished; one serving a client is not", async () => {
    for (const [mode, shown] of [
      ["command", "finished"],
      ["interactive", "finished"],
      ["rpc", "unknown"],
    ] as const) {
      const pc = computer();
      session(pc);
      session(pc, metadata({ sessionId: OTHER_SESSION_ID }), { id: OTHER_SESSION_ID });
      writeHeartbeat(pc.files, heartbeat({ mode }));
      const adapter = pc.adapter();
      await adapter.poll();
      removeHeartbeat(pc.files);
      writeHeartbeat(
        pc.files,
        heartbeat({ mode, sessionId: OTHER_SESSION_ID, updatedAt: NOW + SECOND }),
        {
          name: `${OTHER_SESSION_ID}.json`,
        },
      );
      pc.clock.advance(2 * SECOND);
      const { sessions } = await adapter.poll();
      const first = sessions.find((one) => one.id === `autohand-code:${SESSION_ID}`);
      expect(first?.status, mode).toBe(shown);
    }
  });

  test("a session found ended and written to after, with its process still gone, is unknown", async () => {
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, heartbeat({ mode: "rpc" }));
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions).status).toBe("working");
    removeHeartbeat(pc.files);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
    pc.processes.stop(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("finished");
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("finished");
    // A time that cannot be right is not believed.
    pc.clock.advance(2 * SECOND);
    session(pc, metadata({ lastActiveAt: pc.clock.now() + 61 * SECOND }));
    expect(only((await adapter.poll()).sessions).status).toBe("finished");
    // Written to after, it runs again in a process no heartbeat here names.
    session(pc, metadata({ lastActiveAt: pc.clock.now() }));
    for (let poll = 0; poll < 2; poll += 1) {
      pc.clock.advance(2 * SECOND);
      expect(only((await adapter.poll()).sessions).status, String(poll)).toBe("unknown");
    }
  });

  test("a session saved over 15 seconds after its last heartbeat, before it was found ended, is unknown", async () => {
    const shown = async (saved: boolean) => {
      const pc = computer();
      session(pc);
      writeHeartbeat(pc.files, heartbeat());
      const adapter = pc.adapter();
      expect(only((await adapter.poll()).sessions).status).toBe("working");
      removeHeartbeat(pc.files);
      pc.processes.stop(PID);
      if (saved) {
        session(pc, metadata({ lastActiveAt: NOW + 16 * SECOND }), { mtimeMs: NOW + 16 * SECOND });
      }
      pc.clock.advance(20 * SECOND);
      return only((await adapter.poll()).sessions).status;
    };
    expect(await shown(false)).toBe("finished");
    expect(await shown(true)).toBe("unknown");
  });

  describe("a closed session resumed, with nothing saved yet,", () => {
    const closedAt = NOW - 3 * DAY;
    async function resumed() {
      const pc = computer();
      session(pc, metadata({ status: "completed", closedAt, lastActiveAt: closedAt }), {
        mtimeMs: closedAt,
      });
      writeHeartbeat(pc.files, heartbeat({ phase: "idle" }));
      const adapter = pc.adapter();
      expect(only((await adapter.poll()).sessions).status).toBe("idle");
      return { pc, adapter };
    }

    test("ends at its heartbeat's time, not its old close, when its process ends and leaves its heartbeat", async () => {
      const { pc, adapter } = await resumed();
      pc.processes.stop(PID);
      pc.clock.advance(16 * SECOND);
      expect(only((await adapter.poll()).sessions)).toMatchObject({
        status: "finished",
        statusSince: NOW,
      });
    });

    test("ends at its heartbeat's time when its heartbeat goes with its process", async () => {
      const { pc, adapter } = await resumed();
      removeHeartbeat(pc.files);
      pc.processes.stop(PID);
      pc.clock.advance(2 * SECOND);
      expect(only((await adapter.poll()).sessions)).toMatchObject({
        status: "finished",
        statusSince: NOW,
      });
    });

    test("is unknown, not finished, when its heartbeat goes while its process runs", async () => {
      const { pc, adapter } = await resumed();
      removeHeartbeat(pc.files);
      pc.clock.advance(2 * SECOND);
      expect(only((await adapter.poll()).sessions).status).toBe("unknown");
    });

    test("ends at its heartbeat's time when first seen after its process ended", async () => {
      const pc = computer([]);
      session(pc, metadata({ status: "completed", closedAt, lastActiveAt: closedAt }), {
        mtimeMs: closedAt,
      });
      writeHeartbeat(pc.files, heartbeat({ updatedAt: NOW - 20 * SECOND }));
      expect(only((await pc.adapter().poll()).sessions)).toMatchObject({
        status: "finished",
        statusSince: NOW - 20 * SECOND,
      });
    });
  });

  test("a session the idle timeout closed, with a heartbeat after its close, is finished at its close", async () => {
    // The idle timeout closes the session first and stops its heartbeat after,
    // and the close can wait up to 10 seconds on the session index's lock.
    const pc = computer();
    const closedAt = NOW - 9 * SECOND;
    session(pc, metadata({ status: "completed", closedAt, lastActiveAt: closedAt }), {
      mtimeMs: closedAt,
    });
    writeHeartbeat(pc.files, heartbeat({ phase: "idle" }));
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions).status).toBe("idle");
    removeHeartbeat(pc.files);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: closedAt,
    });
    pc.processes.stop(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: closedAt,
    });
  });

  test("is lost when Agent Lookout starts again, so a session whose heartbeat went is unknown", async () => {
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, heartbeat());
    await pc.adapter().poll();
    removeHeartbeat(pc.files);
    pc.processes.stop(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await pc.adapter().poll()).sessions).status).toBe("unknown");
  });
});

describe("the heartbeat a session's status is taken from", () => {
  test("is one that waits for you before an idle one, whichever is newer, and stays so as they take turns", async () => {
    const pc = computer([PID, OTHER_PID]);
    session(pc);
    const adapter = pc.adapter();
    writeHeartbeat(pc.files, heartbeat({ phase: "idle", pid: OTHER_PID }));
    await adapter.poll();
    const iid = `${SESSION_ID}.${INSTANCE_ID}.json`;
    const since = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      pc.clock.advance(2 * SECOND);
      const at = pc.clock.now();
      if (turn % 2 === 1)
        writeHeartbeat(
          pc.files,
          heartbeat({ phase: "waiting_input", updatedAt: at, communication: true }),
          { name: iid },
        );
      else writeHeartbeat(pc.files, heartbeat({ phase: "idle", pid: OTHER_PID, updatedAt: at }));
      const shown = only((await adapter.poll()).sessions);
      expect(shown.status, String(turn)).toBe("needs-you");
      since.push(shown.statusSince);
    }
    expect(new Set(since)).toEqual(new Set([NOW + 2 * SECOND]));
  });

  test("of two processes taking turns on one file, keeps the one that waits, with no new wait", async () => {
    const pc = computer([PID, OTHER_PID]);
    session(pc);
    const adapter = pc.adapter();
    writeHeartbeat(pc.files, heartbeat({ phase: "idle" }));
    await adapter.poll();
    const since = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      pc.clock.advance(2 * SECOND);
      const at = pc.clock.now();
      writeHeartbeat(
        pc.files,
        turn % 2 === 1
          ? heartbeat({ phase: "waiting_input", updatedAt: at })
          : heartbeat({ phase: "idle", pid: OTHER_PID, updatedAt: at }),
      );
      const shown = only((await adapter.poll()).sessions);
      expect(shown.status, String(turn)).toBe("needs-you");
      since.push(shown.statusSince);
    }
    expect(new Set(since)).toEqual(new Set([NOW + 2 * SECOND]));
    // Once the file is gone, nothing it held is kept.
    removeHeartbeat(pc.files);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
  });

  test("of two processes on one file, drops what one wrote once its process is found gone, even when its ID is given to another", async () => {
    const pc = computer([PID, OTHER_PID]);
    session(pc);
    const adapter = pc.adapter();
    writeHeartbeat(pc.files, heartbeat({ phase: "waiting_input" }));
    await adapter.poll();
    pc.clock.advance(2 * SECOND);
    writeHeartbeat(
      pc.files,
      heartbeat({ phase: "idle", pid: OTHER_PID, updatedAt: pc.clock.now() }),
    );
    expect(only((await adapter.poll()).sessions).status).toBe("needs-you");
    pc.processes.stop(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "idle",
      statusSince: NOW + 2 * SECOND,
    });
    pc.processes.start(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "idle",
      statusSince: NOW + 2 * SECOND,
    });

    // The same when its heartbeat was the file's as its process was found gone.
    const last = computer([PID, OTHER_PID]);
    session(last);
    const again = last.adapter();
    writeHeartbeat(last.files, heartbeat({ phase: "idle", pid: OTHER_PID }));
    await again.poll();
    last.clock.advance(2 * SECOND);
    writeHeartbeat(last.files, heartbeat({ phase: "waiting_input", updatedAt: last.clock.now() }));
    expect(only((await again.poll()).sessions).status).toBe("needs-you");
    last.processes.stop(PID);
    last.clock.advance(2 * SECOND);
    expect(only((await again.poll()).sessions)).toMatchObject({
      status: "idle",
      statusSince: NOW,
    });
    last.clock.advance(SECOND);
    writeHeartbeat(
      last.files,
      heartbeat({ phase: "idle", pid: OTHER_PID, updatedAt: last.clock.now() }),
    );
    last.processes.start(PID);
    last.clock.advance(SECOND);
    expect(only((await again.poll()).sessions)).toMatchObject({
      status: "idle",
      statusSince: NOW,
    });
  });
});

describe("a status's time", () => {
  test("is none on the first poll, the heartbeat's for a change seen later, and fixed while the status lasts", async () => {
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, heartbeat({ phase: "thinking" }));
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions).statusSince).toBeNull();
    for (let poll = 1; poll <= 3; poll += 1) {
      pc.clock.advance(2 * SECOND);
      writeHeartbeat(pc.files, heartbeat({ phase: "editing", updatedAt: pc.clock.now() }));
      expect(only((await adapter.poll()).sessions).statusSince).toBeNull();
    }
    pc.clock.advance(2 * SECOND);
    const waitAt = pc.clock.now() - SECOND;
    writeHeartbeat(pc.files, heartbeat({ phase: "waiting_input", updatedAt: waitAt }));
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "needs-you",
      statusSince: waitAt,
    });
    pc.clock.advance(2 * SECOND);
    writeHeartbeat(pc.files, heartbeat({ phase: "waiting_input", updatedAt: pc.clock.now() }));
    expect(only((await adapter.poll()).sessions).statusSince).toBe(waitAt);
  });
});

describe("a late poll, as after the computer slept", () => {
  async function waiting(pc: Computer) {
    session(pc);
    writeHeartbeat(pc.files, heartbeat({ phase: "idle" }));
    const adapter = pc.adapter();
    await adapter.poll();
    pc.clock.advance(2 * SECOND);
    writeHeartbeat(pc.files, heartbeat({ phase: "waiting_input", updatedAt: pc.clock.now() }));
    expect(only((await adapter.poll()).sessions).statusSince).toBe(NOW + 2 * SECOND);
    return adapter;
  }

  test("holds a wait over a quiet heartbeat for 7 seconds, with no new wait", async () => {
    const pc = computer();
    const adapter = await waiting(pc);
    pc.clock.advance(30 * SECOND);
    for (const step of [0, 4 * SECOND, 3 * SECOND]) {
      pc.clock.advance(step);
      expect(only((await adapter.poll()).sessions), String(step)).toMatchObject({
        status: "needs-you",
        waitingReason: "other",
        statusSince: NOW + 2 * SECOND,
      });
    }
    pc.clock.advance(1);
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
  });

  test("holds it with the heartbeat gone, and ends it when a fresh one comes", async () => {
    const pc = computer();
    const adapter = await waiting(pc);
    removeHeartbeat(pc.files);
    pc.clock.advance(30 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("needs-you");
    pc.clock.advance(2 * SECOND);
    writeHeartbeat(pc.files, heartbeat({ phase: "thinking", updatedAt: pc.clock.now() }));
    expect(only((await adapter.poll()).sessions).status).toBe("working");
  });

  test("holds nothing for a process that has gone, nor for a clock set back past it", async () => {
    const pc = computer();
    const adapter = await waiting(pc);
    pc.processes.stop(PID);
    pc.clock.advance(30 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("finished");

    const gone = computer();
    const after = await waiting(gone);
    removeHeartbeat(gone.files);
    gone.processes.stop(PID);
    gone.clock.advance(30 * SECOND);
    expect(only((await after.poll()).sessions).status).toBe("finished");

    const back = computer();
    const again = await waiting(back);
    back.clock.advance(30 * SECOND);
    expect(only((await again.poll()).sessions).status).toBe("needs-you");
    back.clock.advance(-SECOND);
    expect(only((await again.poll()).sessions).status).toBe("unknown");
  });

  test("holds nothing once the session was closed since, or while the heartbeats cannot be read", async () => {
    const pc = computer();
    const adapter = await waiting(pc);
    removeHeartbeat(pc.files);
    session(
      pc,
      metadata({ status: "completed", closedAt: NOW + 3 * SECOND, lastActiveAt: NOW + 3 * SECOND }),
    );
    pc.clock.advance(30 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("finished");

    const unread = computer();
    const again = await waiting(unread);
    unread.owned.set(HEARTBEATS_DIR, { uid: OTHER_UID });
    unread.clock.advance(30 * SECOND);
    const result = await again.poll();
    expect(result.basis).toBe(BASIS_WITHOUT_HEARTBEATS);
    expect(only(result.sessions).status).toBe("unknown");
  });

  test("a clock set back counts as a late poll", async () => {
    const pc = computer();
    const adapter = await waiting(pc);
    removeHeartbeat(pc.files);
    pc.clock.advance(-10 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("needs-you");
  });
});

describe("which sessions are listed", () => {
  test("a heartbeat with no session folder, as of a run with --ephemeral, is not listed, and is once its folder is there", async () => {
    const pc = computer();
    writeHeartbeat(pc.files, heartbeat());
    const adapter = pc.adapter();
    expect((await adapter.poll()).sessions).toEqual([]);
    pc.files.mkdir(sessionDir());
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("working");
  });

  test("a heartbeat whose session ID is no folder's name is never looked up in the sessions folder", async () => {
    const pc = computer();
    pc.files.mkdir(`${SESSIONS_DIR}/index.json.lock`);
    pc.files.write(`${SESSIONS_DIR}/index.json`, "{}");
    writeHeartbeat(pc.files, heartbeat({ sessionId: "index.json.lock" }), {
      name: "index.json.lock.json",
    });
    const { sessions } = await pc.adapter().poll();
    expect(sessions).toEqual([]);
    expect(
      pc.files.calls.filter((call) => call.path.startsWith(asWritten(`${SESSIONS_DIR}/index`))),
    ).toEqual([]);
  });

  test("a session written in the last day is listed, and one written before it is not, unless a heartbeat names it", async () => {
    const pc = computer();
    session(pc, metadata({ status: "completed", closedAt: NOW - DAY + 10 * SECOND }), {
      mtimeMs: NOW - DAY + 10 * SECOND,
    });
    session(
      pc,
      metadata({ sessionId: OTHER_SESSION_ID, status: "completed", closedAt: NOW - DAY }),
      {
        id: OTHER_SESSION_ID,
        mtimeMs: NOW - DAY,
      },
    );
    const { sessions } = await pc.adapter().poll();
    expect(sessions.map((one) => one.id)).toEqual([`autohand-code:${SESSION_ID}`]);
    expect(pc.files.opened()).toEqual([asWritten(metadataPath())]);

    writeHeartbeat(pc.files, heartbeat({ sessionId: OTHER_SESSION_ID }), {
      name: `${OTHER_SESSION_ID}.json`,
    });
    pc.clock.advance(2 * SECOND);
    const named = await pc.adapter().poll();
    expect(named.sessions.map((one) => one.id).sort()).toEqual(
      [`autohand-code:${SESSION_ID}`, `autohand-code:${OTHER_SESSION_ID}`].sort(),
    );
  });

  test("an old metadata.json named only by a heartbeat over a day old is not opened", async () => {
    const pc = computer([]);
    session(pc, metadata(), { mtimeMs: NOW - 2 * DAY });
    writeHeartbeat(pc.files, heartbeat({ updatedAt: NOW - DAY - SECOND }));
    expect((await pc.adapter().poll()).sessions).toEqual([]);
    expect(pc.files.opened()).toEqual([asWritten(`${HEARTBEATS_DIR}/${SESSION_ID}.json`)]);
  });

  test("a copy from another tool or the web that you never resumed is not listed, each condition counting", async () => {
    const shown = async (text: string, withHeartbeat = false) => {
      const pc = computer();
      session(pc, text);
      if (withHeartbeat) writeHeartbeat(pc.files, heartbeat());
      return (await pc.adapter().poll()).sessions.map((one) => one.status);
    };
    const listed = async (text: string, withHeartbeat = false) =>
      (await shown(text, withHeartbeat)).length;
    const importedAt = NOW - MINUTE;
    expect(await listed(importedMetadata({ importedAt }))).toBe(0);
    expect(await listed(importedMetadata({ importedAt, closedAt: importedAt }))).toBe(0);
    expect(await listed(transferredMetadata({ importedAt }))).toBe(0);
    expect(await listed(importedMetadata({ importedAt, lastActiveAt: importedAt + SECOND }))).toBe(
      0,
    );
    // Resumed and closed since, it is listed.
    expect(await listed(importedMetadata({ importedAt, closedAt: importedAt + 1 }))).toBe(1);
    expect(await listed(importedMetadata({ importedAt, status: "active" }))).toBe(1);
    expect(await listed(metadata({ status: "completed" }))).toBe(1);
    // Resumed and written to since, it is listed, as one that may run.
    const later = importedAt + SECOND + 1;
    expect(await shown(importedMetadata({ importedAt, lastActiveAt: later }))).toEqual(["unknown"]);
    expect(await shown(transferredMetadata({ importedAt, lastActiveAt: later }))).toEqual([
      "unknown",
    ]);
    // A fresh heartbeat lists any.
    expect(await listed(importedMetadata({ importedAt }), true)).toBe(1);
  });

  test("a copy seen with a heartbeat stays listed once the heartbeat goes, and is finished once its process ends", async () => {
    const pc = computer();
    session(pc, importedMetadata({ importedAt: NOW - MINUTE }));
    writeHeartbeat(pc.files, heartbeat());
    const adapter = pc.adapter();
    expect(only((await adapter.poll()).sessions).status).toBe("working");
    removeHeartbeat(pc.files);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions).status).toBe("unknown");
    pc.processes.stop(PID);
    pc.clock.advance(2 * SECOND);
    expect(only((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW,
    });
  });

  test("a copy you never resumed is opened once while it is unchanged, not again on each sweep", async () => {
    const pc = computer();
    session(pc, importedMetadata({ importedAt: NOW - MINUTE }));
    const adapter = pc.adapter();
    for (let sweep = 0; sweep < 3; sweep += 1) {
      expect((await adapter.poll()).sessions).toEqual([]);
      // A poll between two sweeps does not look its folder up.
      pc.clock.advance(2 * SECOND);
      expect((await adapter.poll()).sessions).toEqual([]);
      pc.clock.advance(59 * SECOND);
    }
    expect(pc.files.opened()).toEqual([asWritten(metadataPath())]);
    // Written again, it is opened on the next sweep.
    session(pc, importedMetadata({ importedAt: NOW - MINUTE }));
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(pc.files.opened()).toHaveLength(2);
  });
});

describe("names", () => {
  test("a session is named by the name you gave it, never by Autohand Code's own title", async () => {
    const named = async (text: string) => {
      const pc = computer();
      session(pc, text);
      return only((await pc.adapter().poll()).sessions).name;
    };
    expect(await named(metadata({ titleSource: "auto" }))).toBe("demo-project");
    expect(await named(metadata({ titleSource: "user", title: "Billing fixes" }))).toBe(
      "Billing fixes",
    );
    expect(await named(metadata({ fork: true, titleSource: "user", title: "Billing fixes" }))).toBe(
      "Billing fixes",
    );
    // The words in an escaped summary are not the key.
    expect(await named(metadata())).toBe("demo-project");
  });
});

describe("the folders", () => {
  test("Autohand Code not there is not found, and looked for again once a minute", async () => {
    const clock = handClock();
    const files = memoryFiles(clock.now);
    const adapter = autohandAdapterFor(files, { now: clock.now });
    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({
      state: "unavailable",
      detail:
        "Autohand Code was not found: there is no ~/.autohand/sessions or ~/.autohand/active-agents folder. Agent Lookout looks again every minute.",
    });
    expect(sessions).toEqual([]);
    files.forget();
    clock.advance(59 * SECOND);
    await adapter.poll();
    expect(files.calls).toEqual([]);
    clock.advance(SECOND);
    await adapter.poll();
    expect(files.calls.length).toBeGreaterThan(0);
    // A clock set back looks again.
    files.forget();
    clock.advance(-2 * MINUTE);
    await adapter.poll();
    expect(files.calls.length).toBeGreaterThan(0);
  });

  test("with AUTOHAND_HOME set, says so", async () => {
    const files = memoryFiles();
    const adapter = autohandAdapterFor(files, { env: { AUTOHAND_HOME: "/Users/example/ah" } });
    expect((await adapter.poll()).health.detail).toBe(
      "Autohand Code was not found: AUTOHAND_HOME is set to ~/ah, and there is no ~/ah/sessions or ~/ah/active-agents folder. Agent Lookout looks again every minute.",
    );
  });

  test("named by AGENT_LOOKOUT_AUTOHAND_HOME with neither folder there, that is an answer, looked at on every poll", async () => {
    const files = memoryFiles();
    const adapter = autohandAdapterFor(files, {
      env: { AGENT_LOOKOUT_AUTOHAND_HOME: "/Users/example/empty" },
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain(
      "AGENT_LOOKOUT_AUTOHAND_HOME is set to ~/empty, which has no sessions or active-agents folder, so no Autohand Code sessions are listed.",
    );
    expect(sessions).toEqual([]);
    files.forget();
    await adapter.poll();
    expect(files.calls.length).toBeGreaterThan(0);
  });

  test("with no heartbeats folder, or one of another user's, reads the sessions alone and says so", async () => {
    for (const how of ["missing", "foreign", "link"] as const) {
      const pc = computer();
      if (how === "missing") pc.files.remove(HEARTBEATS_DIR);
      if (how === "foreign") pc.owned.set(HEARTBEATS_DIR, { uid: OTHER_UID });
      if (how === "link") {
        pc.files.remove(HEARTBEATS_DIR);
        pc.files.special(HEARTBEATS_DIR);
      }
      session(pc);
      const { basis, health, sessions } = await pc.adapter().poll();
      expect(basis, how).toBe(BASIS_WITHOUT_HEARTBEATS);
      expect(health.detail, how).toContain(noHeartbeatsNote("~/.autohand/active-agents"));
      expect(only(sessions).status, how).toBe("unknown");
    }
  });

  test("a sessions folder that cannot be listed is an error, with no sessions", async () => {
    const pc = computer();
    session(pc);
    pc.files.fail(SESSIONS_DIR, "EACCES");
    const { health, sessions } = await pc.adapter().poll();
    expect(health).toMatchObject({
      state: "error",
      detail:
        "Autohand Code sessions could not be read: the folder ~/.autohand/sessions could not be listed.",
    });
    expect(sessions).toEqual([]);
  });

  test("on macOS and Linux reads no session folder or metadata.json of another user's, and on Windows does", async () => {
    for (const target of [sessionDir(), metadataPath()]) {
      const pc = computer();
      session(pc, metadata({ status: "completed", closedAt: NOW - MINUTE }));
      writeHeartbeat(pc.files, heartbeat());
      pc.owned.set(target, { uid: OTHER_UID });
      const { sessions } = await pc.adapter().poll();
      if (target === sessionDir()) expect(sessions, target).toEqual([]);
      else expect(only(sessions).lastWriteAt, target).toBeUndefined();
      expect(pc.files.opened(), target).not.toContain(asWritten(metadataPath()));

      const windows = computer();
      session(windows, metadata());
      windows.owned.set(target, { uid: 0, mode: 0o100666 });
      const read = await windows.adapter({ platform: "win32", euid: null }).poll();
      expect(only(read.sessions).lastWriteAt, target).toBe(NOW);
    }
  });

  test("reads Autohand Code's two folders, and opens nothing but heartbeats and metadata.json", async () => {
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, heartbeat());
    for (const name of [
      "config.json",
      "config.toml",
      "config.yaml",
      "config.yml",
      "device-id",
      "error.log",
    ]) {
      pc.files.write(`${AUTOHAND_HOME}/${name}`, `{"key": "${CANARY_MARK}"}`);
    }
    pc.files.write("/Users/example/elsewhere/config.toml", "key = 1");
    pc.files.write(`${sessionDir()}/conversation.jsonl`, "{}\n");
    pc.files.write(`${sessionDir()}/state.json`, "{}");
    pc.files.write(`${sessionDir()}/command-output/x.log`, "log");
    pc.files.write(`${SESSIONS_DIR}/index.json`, "{}");
    pc.files.write(`${SESSIONS_DIR}/index.json.lock/0b5d.owner`, "{}");
    pc.files.write(`${AUTOHAND_HOME}/peer-messages/x/identity.json`, "{}");
    const adapter = pc.adapter({
      env: { AUTOHAND_CONFIG: "/Users/example/elsewhere/config.toml" },
    });
    for (let poll = 0; poll < 3; poll += 1) {
      await adapter.poll();
      pc.clock.advance(61 * SECOND);
    }
    expect(new Set(pc.files.opened())).toEqual(
      new Set([asWritten(`${HEARTBEATS_DIR}/${SESSION_ID}.json`), asWritten(metadataPath())]),
    );
    const touched = new Set(pc.files.calls.map((call) => call.path));
    for (const never of [
      `${sessionDir()}/conversation.jsonl`,
      `${sessionDir()}/state.json`,
      `${SESSIONS_DIR}/index.json`,
      `${AUTOHAND_HOME}/config.json`,
    ]) {
      expect(touched.has(asWritten(never)), never).toBe(false);
    }
  });

  test("looks up a session folder settled over a day ago only on a sweep, and on a clock set back", async () => {
    const pc = computer();
    session(pc, metadata({ status: "completed", closedAt: NOW - 2 * DAY }), {
      mtimeMs: NOW - 2 * DAY,
    });
    const adapter = pc.adapter();
    await adapter.poll();
    const looks = () => pc.files.count("lstat", (target) => target === asWritten(sessionDir()));
    expect(looks()).toBe(1);
    pc.clock.advance(2 * SECOND);
    await adapter.poll();
    expect(looks()).toBe(1);
    pc.clock.advance(58 * SECOND);
    await adapter.poll();
    expect(looks()).toBe(2);
    pc.clock.advance(-5 * MINUTE);
    await adapter.poll();
    expect(looks()).toBe(3);
  });

  test("looks up a session folder that is a link or another user's only on a sweep", async () => {
    for (const how of ["link", "foreign"] as const) {
      const pc = computer();
      if (how === "link") {
        pc.files.special(sessionDir());
      } else {
        session(pc);
        pc.owned.set(sessionDir(), { uid: OTHER_UID });
      }
      const adapter = pc.adapter();
      const looks = () => pc.files.count("lstat", (target) => target === asWritten(sessionDir()));
      await adapter.poll();
      expect(looks(), how).toBe(1);
      pc.clock.advance(2 * SECOND);
      await adapter.poll();
      expect(looks(), how).toBe(1);
      pc.clock.advance(58 * SECOND);
      await adapter.poll();
      expect(looks(), how).toBe(2);
    }
  });
});

describe("sizes", () => {
  test("a metadata.json over 1 MiB is not opened, the card says so and the session still shows from its heartbeat", async () => {
    const pc = computer();
    session(pc, written({ ...metadataRecord(), pad: "p".repeat(1_048_576) }));
    writeHeartbeat(pc.files, heartbeat({ phase: "idle" }));
    const adapter = pc.adapter();
    for (let poll = 0; poll < 2; poll += 1) {
      const { sessions, health } = await adapter.poll();
      expect(only(sessions).status).toBe("idle");
      expect(health.detail).toContain(TOO_LARGE_NOTE);
      pc.clock.advance(2 * SECOND);
      writeHeartbeat(pc.files, heartbeat({ phase: "idle", updatedAt: pc.clock.now() }));
    }
    expect(pc.files.opened()).not.toContain(asWritten(metadataPath()));
  });

  test("a heartbeat over 128 KiB is not read and the card says so", async () => {
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, written({ ...heartbeatRecord(), pad: "p".repeat(140 * 1024) }));
    const { sessions, health } = await pc.adapter().poll();
    expect(only(sessions).status).toBe("unknown");
    expect(health.detail).toContain(TOO_LARGE_NOTE);
  });
});

describe("privacy", () => {
  test("turns into text nothing but the fields it keeps, and shows none of the rest", async () => {
    const pc = computer([PID, OTHER_PID]);
    session(
      pc,
      metadata({ titleSource: "auto", automode: true, fork: true, importedAt: NOW - DAY * 2 }),
    );
    session(
      pc,
      writtenEscaped(metadataRecord({ sessionId: OTHER_SESSION_ID, status: "crashed" })),
      {
        id: OTHER_SESSION_ID,
      },
    );
    writeHeartbeat(pc.files, heartbeat({ phase: "waiting_input", communication: true }), {
      name: `${SESSION_ID}.${INSTANCE_ID}.json`,
    });
    writeHeartbeat(pc.files, presenceHeartbeat({ sessionId: OTHER_SESSION_ID, pid: OTHER_PID }), {
      name: `${OTHER_SESSION_ID}.json`,
    });
    writeHeartbeat(pc.files, heartbeat({ pid: OTHER_PID }));
    const adapter = pc.adapter();
    const results: unknown[] = [];
    const seen = await watchDecodingWhile(async () => {
      for (let poll = 0; poll < 3; poll += 1) {
        results.push(await adapter.poll());
        pc.clock.advance(2 * SECOND);
        writeHeartbeat(pc.files, writtenEscaped(heartbeatRecord({ updatedAt: pc.clock.now() })));
      }
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) expect(text.toLowerCase()).not.toContain(CANARY_MARK);
    expect(JSON.stringify(results).toLowerCase()).not.toContain(CANARY_MARK);
    expect(JSON.stringify(results)).toContain("needs-you");
  });

  test("a folder that is no JSON string leaves none of its bytes in what is shown", async () => {
    const pc = computer();
    session(
      pc,
      metadata().replace(`"projectPath": "${PROJECT}"`, '"projectPath": "\\q-marker-bytes"'),
    );
    writeHeartbeat(
      pc.files,
      heartbeat().replace(`"workspaceRoot": "${PROJECT}"`, '"workspaceRoot": "\\q-marker-bytes"'),
    );
    const result = await pc.adapter().poll();
    expect(only(result.sessions).cwd).toBeNull();
    expect(JSON.stringify(result)).not.toContain("marker");
  });

  test("asks signal 0 only about the processes its heartbeats name, and runs no program", async () => {
    const pc = computer();
    session(pc);
    writeHeartbeat(pc.files, heartbeat());
    const adapter = pc.adapter();
    await adapter.poll();
    removeHeartbeat(pc.files);
    pc.clock.advance(2 * SECOND);
    await adapter.poll();
    expect(new Set(pc.processes.asked)).toEqual(new Set([PID]));
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(runPs).not.toHaveBeenCalled();
  });
});

test("says what it can report in the words the guide uses", async () => {
  const pc = computer();
  const adapter = pc.adapter();
  expect(adapter.capabilities).toBe(AUTOHAND_CODE_CAPABILITIES);
  expect(adapter.lookingIn).toBe("Looking for Autohand Code sessions in ~/.autohand.");
  const { health } = await adapter.poll();
  expect(health.watching).toEqual([
    { label: "Heartbeats folder", value: "~/.autohand/active-agents" },
    { label: "Sessions folder", value: "~/.autohand/sessions" },
    { label: "Read", value: "every 2 seconds" },
    { label: "Process check", value: "signal 0 alone, every 2 seconds" },
  ]);
});
