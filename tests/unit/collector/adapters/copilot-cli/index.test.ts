import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  COPILOT_CLI_CAPABILITIES,
  ENDS_NOTE,
  FINISHED_NOTE,
  IDLE_NOTE,
  LINK_NOTE,
  LOCKS_UNREAD_NOTE,
  MAC_LOCK_NOTE,
  NEEDS_YOU_NOTE,
  OTHER_APPS_NOTE,
  PASSED_OVER_NOTE,
  READONLY_NOTE,
  SIGNAL_LOCK_NOTE,
  STATUS_NOTE,
  UNCHECKED_NOTE,
  UNCHECKED_RUN_NOTE,
  UNREAD_NOTE,
  UNWRITTEN_NOTE,
} from "@collector/adapters/copilot-cli/index";
import { lstart } from "@tests/fixtures/antigravity";
import {
  aborted,
  COPILOT_DIR,
  CWD,
  eventsPath,
  HOUR,
  lockPath,
  MINUTE,
  NOW,
  permissionCompleted,
  permissionRequested,
  PID,
  PRIVATE_WORDS,
  reply,
  request,
  SECOND,
  sessionError,
  sessionFolder,
  sessionIdOf,
  SESSION_ID,
  sessionResume,
  SESSIONS,
  sessionStart,
  shutdown,
  taskComplete,
  toolEnd,
  toolStart,
  turnEnd,
  turnStart,
  userMessage,
} from "@tests/fixtures/copilot-cli/copilotCli";
import {
  appendLog,
  copilotCliAdapterFor,
  handClock,
  healthy,
  memoryFiles,
  removeLock,
  standInProcesses,
  standInStarts,
  writeLock,
  writeLog,
} from "@tests/support/adapters/copilot-cli/copilotCliAdapter";
import {
  createAnnouncements,
  createOpenWaits,
  seeded,
  watchWaits,
} from "@tests/support/waits/openWaits";

const T = NOW - 10 * MINUTE;

/** A session that started and asked once, its whole request done. */
const finishedRequest = (id = SESSION_ID) => `${sessionStart(T, { id })}${request(T + SECOND)}`;

describe("where it looks", () => {
  test("with no ~/.copilot/session-state it is not found, and looks again a minute later", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = copilotCliAdapterFor(files, { now: clock.now });
    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({
      id: "copilot-cli",
      label: "Copilot CLI",
      state: "unavailable",
      detail:
        "Copilot CLI was not found: there is no ~/.copilot/session-state folder. Agent Lookout looks again every minute.",
    });
    expect(sessions).toEqual([]);
    files.forget();
    clock.advance(30 * SECOND);
    await adapter.poll();
    expect(files.count()).toBe(0);
    clock.advance(31 * SECOND);
    await adapter.poll();
    expect(files.count("lstat")).toBe(1);
  });

  test("COPILOT_HOME moves it, and one that is not a whole path is passed over and said to be", async () => {
    const files = memoryFiles();
    writeLog(files, finishedRequest(), { sessionsDir: "/srv/copilot/session-state" });
    writeLock(files, { id: SESSION_ID });
    const moved = copilotCliAdapterFor(files, { env: { COPILOT_HOME: "/srv/copilot" } });
    // The lock above is in ~/.copilot, so this one is not held.
    expect((await moved.poll()).sessions.map((session) => session.status)).toEqual(["finished"]);

    const passed = await copilotCliAdapterFor(memoryFiles(), {
      env: { COPILOT_HOME: "copilot" },
    }).poll();
    expect(passed.health.detail).toContain(PASSED_OVER_NOTE);
    expect(passed.health.detail).toContain("~/.copilot/session-state");

    const named = await copilotCliAdapterFor(memoryFiles(), {
      env: { COPILOT_HOME: "/srv/none" },
    }).poll();
    expect(named.health.detail).toContain(
      `COPILOT_HOME is set to ${path.resolve("/srv/none")}, and there is no`,
    );
  });

  test("AGENT_LOOKOUT_COPILOT_HOME with no session-state is an answer, looked for on every poll", async () => {
    const files = memoryFiles();
    const adapter = copilotCliAdapterFor(files, {
      env: { AGENT_LOOKOUT_COPILOT_HOME: "/tmp/empty-copilot" },
    });
    const { health } = await adapter.poll();
    expect(health.state).toBe("ok");
    const folder = path.join(path.resolve("/tmp/empty-copilot"), "session-state");
    expect(
      health.detail?.startsWith(
        `AGENT_LOOKOUT_COPILOT_HOME is set, and there is no ${folder} folder, so no Copilot CLI sessions are listed. `,
      ),
      health.detail,
    ).toBe(true);
    files.forget();
    await adapter.poll();
    expect(files.count("lstat")).toBe(1);
  });

  test("a sessions folder that is a link is not followed", async () => {
    const files = memoryFiles();
    files.special(SESSIONS);
    const { health } = await copilotCliAdapterFor(files).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain(LINK_NOTE);
  });

  test("watching names what it reads and runs, on a Mac and elsewhere", async () => {
    const files = memoryFiles();
    writeLog(files, finishedRequest());
    const mac = await copilotCliAdapterFor(files).poll();
    expect(mac.health.detail).toBe(healthy());
    expect(mac.health.watching).toEqual([
      { label: "Sessions folder", value: "~/.copilot/session-state" },
      { label: "Read", value: "every 2 seconds" },
      {
        label: "Event logs",
        value:
          "events.jsonl of each session, as bytes, only as far as it grew: at most 8 MiB, or its first 64 KiB and last 8 MiB. Only its working folder, times and IDs become text",
      },
      {
        label: "Locks",
        value: "the names of inuse.<pid>.lock in each session's folder, by lstat, never opened",
      },
      { label: "Process IDs", value: "signal 0, every 2 seconds" },
      { label: "Process check", value: "ps -o pid=,lstart= -p <pids>" },
      {
        label: "Process check run",
        value: "every 30 seconds while a session's process runs, and sooner when another appears",
      },
    ]);
    for (const platform of ["linux", "win32"] as const) {
      const other = await copilotCliAdapterFor(files, { platform }).poll();
      expect(other.health.detail, platform).toBe(healthy(undefined, SIGNAL_LOCK_NOTE));
      expect(other.health.watching?.at(-1), platform).toEqual({
        label: "Process check",
        value: "signal 0 alone",
      });
    }
  });
});

describe("a session's status", () => {
  test("working, idle, needing you, finished and failed, from its log and its lock", async () => {
    const files = memoryFiles();
    const ids = [1, 2, 3, 4, 5, 6, 7].map(sessionIdOf);
    const [working, idle, permission, question, finished, failed, gone] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const asked = (id: string) =>
      `${sessionStart(T, { id })}${userMessage(T + 1)}${turnStart("0", T + 2)}`;
    const logs: Record<string, string> = {
      [working]: asked(working),
      [idle]: finishedRequest(idle),
      [permission]: `${asked(permission)}${toolStart("c-1", "bash", T + 3)}${permissionRequested("r-1", NOW - 30 * SECOND)}`,
      [question]: `${asked(question)}${toolStart("c-1", "ask_user", NOW - 20 * SECOND)}`,
      [finished]: `${finishedRequest(finished)}${shutdown(NOW - MINUTE)}`,
      [failed]: `${sessionStart(T, { id: failed })}${userMessage(T + 1)}${shutdown(NOW - MINUTE, "error")}`,
      [gone]: asked(gone),
    };
    for (const [id, text] of Object.entries(logs)) {
      writeLog(files, text, { id, mtimeMs: NOW - SECOND });
      if (id !== gone) writeLock(files, { id });
    }
    const { health, sessions } = await copilotCliAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const of = (id: string) => byId.get(`copilot-cli:${id}`);
    expect(of(working)).toMatchObject({
      status: "working",
      statusSince: T + 1,
      name: "demo-project",
      cwd: CWD,
      startedAt: T,
      lastWriteAt: NOW - SECOND,
    });
    expect(of(idle)).toMatchObject({ status: "idle" });
    expect(of(idle)).not.toHaveProperty("lastWriteAt");
    expect(of(permission)).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: NOW - 30 * SECOND,
    });
    expect(of(question)).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - 20 * SECOND,
    });
    expect(of(finished)).toMatchObject({ status: "finished", statusSince: NOW - MINUTE });
    expect(of(failed)).toMatchObject({ status: "failed", statusSince: NOW - MINUTE });
    expect(of(gone)).toMatchObject({ status: "finished" });
    // No private word leaves a log.
    const answer = JSON.stringify({ health, sessions });
    for (const word of PRIVATE_WORDS) expect(answer, word).not.toContain(word);
    // Nothing but the logs was opened.
    expect(new Set(files.opened().map((file) => file.slice(file.lastIndexOf("/") + 1)))).toEqual(
      new Set(["events.jsonl"]),
    );
  });

  test("a session.error is unknown, and an abort after a turn is idle", async () => {
    const files = memoryFiles();
    writeLog(files, `${finishedRequest(sessionIdOf(1))}${sessionError(NOW - MINUTE)}`, {
      id: sessionIdOf(1),
    });
    writeLog(files, `${finishedRequest(sessionIdOf(2))}${aborted(NOW - MINUTE)}`, {
      id: sessionIdOf(2),
    });
    writeLock(files, { id: sessionIdOf(1) });
    writeLock(files, { id: sessionIdOf(2) });
    const { sessions } = await copilotCliAdapterFor(files).poll();
    expect(sessions.map((session) => [session.id.slice(-1), session.status]).sort()).toEqual([
      ["1", "unknown"],
      ["2", "idle"],
    ]);
  });

  test("a permission request closed within a second never shows as a wait", async () => {
    const files = memoryFiles();
    const clock = handClock();
    writeLog(
      files,
      `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}${permissionRequested("r-1", NOW - 2)}`,
    );
    writeLock(files);
    const adapter = copilotCliAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    appendLog(files, permissionCompleted("r-1", NOW));
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a wait keeps the time it began for as long as it lasts", async () => {
    const files = memoryFiles();
    const clock = handClock();
    writeLog(
      files,
      `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}${permissionRequested("r-1", NOW - 30 * SECOND)}`,
    );
    writeLock(files);
    const adapter = copilotCliAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 30 * SECOND,
    });
    // A second request while the first waits, and the first answered: the wait goes on.
    appendLog(files, permissionRequested("r-2", NOW - 10 * SECOND));
    clock.advance(2 * SECOND);
    await adapter.poll();
    appendLog(files, permissionCompleted("r-1", NOW + SECOND));
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 30 * SECOND,
    });
  });

  test.each(["a question, then a permission", "a permission, then a question"])(
    "%s, open together, are one wait, announced once, since the older",
    async (order) => {
      const files = memoryFiles();
      const clock = handClock();
      writeLog(files, `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}`);
      writeLock(files);
      const watch = watchWaits(copilotCliAdapterFor(files, { now: clock.now }), clock.now);
      const poll = async (lines: string) => {
        appendLog(files, lines, { mtimeMs: clock.now() });
        clock.advance(2 * SECOND);
        return watch();
      };
      const question = () => toolStart("q-1", "ask_user", clock.now());
      const permission = () => permissionRequested("r-1", clock.now(), { agentId: "agent-1" });
      const waits = (announced = 0) => ({
        status: "needs-you",
        since: NOW + 2 * SECOND,
        started: announced,
        stopped: 0,
      });
      const questionFirst = order.startsWith("a question");

      expect((await poll("")).status).toBe("working");
      expect(await poll(questionFirst ? question() : permission())).toEqual(waits(1));
      expect(await poll(questionFirst ? permission() : question())).toEqual(waits());
      expect(await poll("")).toEqual(waits());
      // Only the permission is answered, and the question waits on.
      expect(await poll(permissionCompleted("r-1", clock.now()))).toEqual(waits());
      expect(await poll("")).toEqual(waits());
      expect(await poll(toolEnd("q-1", clock.now()))).toEqual({
        status: "working",
        since: null,
        started: 0,
        stopped: 1,
      });
      // One asked after that is a new wait.
      const asked = clock.now();
      expect(await poll(toolStart("q-2", "ask_user", asked))).toEqual({
        ...waits(1),
        since: asked,
      });
    },
  );

  test("agrees with the model of open waits, through answers, new questions, a log that cannot be read and restarts", async () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = seeded(seed);
      const files = memoryFiles();
      const clock = handClock();
      writeLog(files, `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}`);
      writeLock(files);
      const model = createOpenWaits();
      const announcements = createAnnouncements();
      let watch = watchWaits(copilotCliAdapterFor(files, { now: clock.now }), clock.now);
      let asked = 0;
      let told: number | null = null;
      let unread = false;
      const ask = () => {
        // Each with an ID of its own, as Copilot gives them, and each open a second before a poll.
        const id = `${random() < 0.5 ? "r" : "q"}-${++asked}`;
        const at = clock.now();
        const line = id.startsWith("r")
          ? permissionRequested(id, at)
          : toolStart(id, "ask_user", at);
        appendLog(files, line, { mtimeMs: at });
        model.ask(id, at);
      };
      const answer = () => {
        const ids = [...model.open.keys()];
        const id = ids[Math.floor(random() * ids.length)];
        if (id === undefined) return;
        const at = clock.now();
        const line = id.startsWith("r") ? permissionCompleted(id, at) : toolEnd(id, at);
        appendLog(files, line, { mtimeMs: at });
        model.answer(id);
      };
      for (let polled = 0; polled < 60; polled += 1) {
        // One step between two reads, so that no wait passes to another unseen.
        const step = unread ? 1 : random();
        if (step < 0.35) ask();
        else if (step < 0.65) answer();
        else if (step < 0.75) {
          answer();
          clock.advance(100);
          ask();
        }
        unread = polled > 0 && !unread && random() < 0.15;
        if (unread) files.failOpen(eventsPath());
        clock.advance(2 * SECOND);
        if (random() < 0.05 && !unread) {
          watch = watchWaits(copilotCliAdapterFor(files, { now: clock.now }), clock.now);
          announcements.restart();
          model.forgetAnswered();
        }
        // What a log last said stands while it cannot be read.
        if (!unread) told = model.since();
        const { status, ...shown } = await watch();
        expect(shown, `seed ${seed}, poll ${polled}`).toEqual({
          since: told,
          ...announcements.poll(told),
        });
        expect(status).toBe(told === null ? "working" : "needs-you");
        files.heal(eventsPath());
      }
    }
  });

  test("a resume without pending work drops the dead turn's wait, and one with it, or that joined it, keeps it", async () => {
    const waiting = `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}${toolStart("c-1", "ask_user", T + 3)}`;
    for (const [tail, status] of [
      [sessionResume(NOW - MINUTE), "idle"],
      [sessionResume(NOW - MINUTE, { continuePending: false }), "idle"],
      [sessionResume(NOW - MINUTE, { continuePending: false, wasActive: false }), "idle"],
      [sessionResume(NOW - MINUTE, { continuePending: true }), "needs-you"],
      // Another client was still running that work, so its question still waits.
      [sessionResume(NOW - MINUTE, { wasActive: true }), "needs-you"],
    ] as const) {
      const files = memoryFiles();
      writeLog(files, `${waiting}${tail}`);
      writeLock(files);
      expect((await copilotCliAdapterFor(files).poll()).sessions[0]?.status).toBe(status);
    }
  });

  test("autopilot's last turn, which calls task_complete, is idle once Copilot accepts it", async () => {
    const lastTurn = (outcome?: string) =>
      `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}${reply(T + 3, 1)}${toolStart("call-0", "task_complete", T + 4)}${taskComplete(T + 5, outcome)}${toolEnd("call-0", T + 6)}${turnEnd("0", T + 7)}`;
    for (const [outcome, status] of [
      ["completed", "idle"],
      ["continue", "working"],
      ["blocked", "unknown"],
      [undefined, "unknown"],
    ] as const) {
      const files = memoryFiles();
      writeLog(files, lastTurn(outcome));
      writeLock(files);
      expect((await copilotCliAdapterFor(files).poll()).sessions[0]?.status, outcome).toBe(status);
    }
  });

  test("a sub-agent's question needs you, and its turns keep the session working", async () => {
    const files = memoryFiles();
    writeLog(
      files,
      `${finishedRequest()}${turnStart("0", NOW - MINUTE, { agentId: "agent-1", parent: "task-1" })}`,
    );
    writeLock(files);
    const adapter = copilotCliAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    appendLog(files, toolStart("c-9", "ask_user", NOW - 5 * SECOND, { agentId: "agent-1" }));
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
    });
    appendLog(files, toolEnd("c-9", NOW, { agentId: "agent-1" }));
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a line it cannot read makes the session unknown, and says so", async () => {
    const files = memoryFiles();
    writeLog(files, `${finishedRequest()}{"type":"abort",}\n`);
    writeLock(files);
    const { health, sessions } = await copilotCliAdapterFor(files).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(health.detail).toContain(UNREAD_NOTE);
  });

  test("a session folder whose locks cannot be listed is unknown, and says so", async () => {
    const files = memoryFiles();
    writeLog(files, finishedRequest());
    files.fail(sessionFolder());
    // Looking the folder up still works; listing it does not.
    const failing = files.io;
    const io = {
      ...failing,
      lstat: async (target: string) => {
        files.heal(sessionFolder());
        const info = await failing.lstat(target);
        files.fail(sessionFolder());
        return info;
      },
    };
    const { health, sessions } = await copilotCliAdapterFor(files, { io }).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(health.detail).toContain(LOCKS_UNREAD_NOTE);
  });
});

describe("whether a lock counts", () => {
  test("a lock whose process has gone does not count, and two locks on one session count if either does", async () => {
    const files = memoryFiles();
    writeLog(files, `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}`);
    writeLock(files, { pid: 11 });
    writeLock(files, { pid: 12 });
    const processes = standInProcesses([12]);
    const adapter = copilotCliAdapterFor(files, { isAlive: processes.isAlive });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    processes.stop(12);
    removeLock(files, { pid: 12 });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("on a Mac, a lock whose process ID was given to a program that started later does not count", async () => {
    const files = memoryFiles();
    writeLog(files, `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}`);
    // The lock was left by a crash an hour ago, and its ID now belongs to a program that started since.
    writeLock(files, { mtimeMs: NOW - HOUR });
    const starts = standInStarts({ [PID]: NOW - 10 * MINUTE });
    const later = await copilotCliAdapterFor(files, { readProcessStarts: starts.read }).poll();
    expect(later.sessions[0]?.status).toBe("finished");
    expect(starts.runs).toEqual([[PID]]);
    // A program that started before the lock, or within a minute after, is the lock's own.
    for (const started of [NOW - 2 * HOUR, NOW - HOUR + 30 * SECOND]) {
      const own = standInStarts({ [PID]: started });
      const held = await copilotCliAdapterFor(files, { readProcessStarts: own.read }).poll();
      expect(held.sessions[0]?.status, lstart(started)).toBe("working");
    }
    // A ps that says nothing leaves signal 0 to decide.
    const none = standInStarts({});
    expect(
      (await copilotCliAdapterFor(files, { readProcessStarts: none.read }).poll()).sessions[0]
        ?.status,
    ).toBe("working");
  });

  test("off a Mac, ps is never run and signal 0 alone decides", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const files = memoryFiles();
      writeLog(files, `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}`);
      writeLock(files, { mtimeMs: NOW - HOUR });
      const starts = standInStarts({ [PID]: NOW - 10 * MINUTE });
      const { sessions } = await copilotCliAdapterFor(files, {
        platform,
        readProcessStarts: starts.read,
      }).poll();
      expect(sessions[0]?.status, platform).toBe("working");
      expect(starts.runs, platform).toEqual([]);
    }
  });

  test("a session open at the last poll is looked up however old its log", async () => {
    const files = memoryFiles();
    const clock = handClock();
    writeLog(files, finishedRequest(), { mtimeMs: NOW - SECOND });
    writeLock(files);
    const adapter = copilotCliAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    // Two days later, idle all the while, its lock still held.
    clock.advance(2 * 24 * HOUR);
    expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual(["idle"]);
  });
});

test("nothing is written, and no file but the logs is opened", async () => {
  const files = memoryFiles();
  writeLog(files, finishedRequest());
  writeLock(files);
  files.write(`${sessionFolder()}/workspace.yaml`, "name: PRIVATE_TITLE\nuser_named: true\n");
  files.write(`${COPILOT_DIR}/session-store.db`, "x");
  const adapter = copilotCliAdapterFor(files);
  await adapter.poll();
  expect(files.opened()).toEqual([eventsPath()]);
  expect(files.count(undefined, (target) => target.endsWith("workspace.yaml"))).toBe(0);
  expect(files.count(undefined, (target) => target.endsWith("session-store.db"))).toBe(0);
  expect(files.count(undefined, (target) => target === lockPath(PID))).toBe(1);
  expect(adapter.capabilities).toBe(COPILOT_CLI_CAPABILITIES);
});

test("each note on the card and each reason is 130 characters or fewer", () => {
  const notes = [
    STATUS_NOTE,
    IDLE_NOTE,
    NEEDS_YOU_NOTE,
    UNWRITTEN_NOTE,
    ENDS_NOTE,
    FINISHED_NOTE,
    MAC_LOCK_NOTE,
    SIGNAL_LOCK_NOTE,
    OTHER_APPS_NOTE,
    READONLY_NOTE,
    UNCHECKED_NOTE,
    UNCHECKED_RUN_NOTE,
    UNREAD_NOTE,
    LOCKS_UNREAD_NOTE,
    PASSED_OVER_NOTE,
    LINK_NOTE,
    ...Object.values(COPILOT_CLI_CAPABILITIES).flatMap((cell) =>
      cell.level === "yes" ? [] : [cell.reason],
    ),
  ];
  for (const note of notes) expect(note.length, note).toBeLessThanOrEqual(130);
});
