import { describe, expect, test } from "vitest";

import {
  GROK_BUILD_CAPABILITIES,
  NEEDS_YOU_NOTE,
  PASSED_OVER_NOTE,
  UNCHECKED_NOTE,
  UNKNOWN_NOTE,
} from "@collector/adapters/grok-build/index";
import { MAX_LOG_BYTES } from "@collector/adapters/grok-build/eventLog";
import { NO_OUTPUT_MS } from "@core/mapping/grok-build/grokBuildMapping";
import type { Session } from "@core/sessions/session";
import { WRITE_TIME_STEP_MS } from "@core/time";
import type { TerminalTab } from "@collector/terminal/terminalTabs";
import type { TmuxPane } from "@collector/tmux/panes";
import {
  DAY,
  entry,
  eventsPath,
  firstToken,
  HOUR,
  mcpServerStarting,
  MINUTE,
  NOW,
  OPENED_AT,
  openedAt,
  OTHER_PID,
  OTHER_SESSION_ID,
  PID,
  planText,
  PROJECT,
  REGISTRY_FILE,
  SECOND,
  SECRET,
  sessionFolder,
  SESSIONS_DIR,
  SESSION_ID,
  summaryText,
  toolCompleted,
  toolStarted,
  turnEnded,
  turnStarted,
  TYPED_TITLE,
  wholeTurn,
} from "@tests/fixtures/grok-build/grokBuild";
import {
  appendEvents,
  grokBuildAdapterFor,
  handClock,
  healthy,
  memoryFiles,
  standInProcesses,
  standInStarts,
  writeEvents,
  writePlan,
  writeRegistry,
  writeSummary,
} from "@tests/support/adapters/grok-build/grokBuildAdapter";

const ID = `grok-build:${SESSION_ID}`;
const OTHER_ID = `grok-build:${OTHER_SESSION_ID}`;
const T = NOW - 2 * MINUTE;

/** One listed session with this event log. */
function oneSession(log: string, logTime = NOW - 5 * SECOND) {
  const files = memoryFiles();
  writeRegistry(files, [entry()]);
  writeEvents(files, log, { mtimeMs: logTime });
  return files;
}

const byId = (sessions: readonly Session[], id = ID) =>
  sessions.find((session) => session.id === id);

describe("finding Grok Build", () => {
  test("not installed: said calmly, and looked for again once a minute with two lstats", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = grokBuildAdapterFor(files, { now: clock.now });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toBe(
      "Grok Build was not found: there is no ~/.grok/active_sessions.json or ~/.grok/sessions folder. Agent Lookout looks again every minute.",
    );
    expect(sessions).toEqual([]);
    expect(files.calls.map((call) => call.method)).toEqual(["lstat", "lstat"]);
    files.forget();
    clock.advance(MINUTE - 1);
    await adapter.poll();
    expect(files.calls).toEqual([]);
    clock.advance(1);
    await adapter.poll();
    expect(files.calls).toHaveLength(2);
    clock.set(NOW - HOUR);
    files.forget();
    await adapter.poll();
    expect(files.calls).toHaveLength(2);
  });

  test("a sessions folder alone is Grok Build, with no session open", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    const { health, sessions } = await grokBuildAdapterFor(files).poll();
    expect(health).toMatchObject({ state: "ok", detail: healthy() });
    expect(sessions).toEqual([]);
  });

  test("a folder named for Agent Lookout that holds neither is an answer, looked at every poll", async () => {
    const files = memoryFiles();
    const adapter = grokBuildAdapterFor(files, {
      // In the home folder, so it is written ~/grok-empty on every system.
      env: { AGENT_LOOKOUT_GROK_HOME: "/Users/example/grok-empty" },
    });
    const { health } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_GROK_HOME is set to ~/grok-empty, which holds no list of open sessions and no sessions folder, so no Grok Build sessions are listed. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
    );
    files.forget();
    await adapter.poll();
    expect(files.count("lstat")).toBe(2);
  });

  test("GROK_HOME that is not a whole path is passed over, and the card says so", async () => {
    const files = memoryFiles();
    const { health } = await grokBuildAdapterFor(files, { env: { GROK_HOME: "~/grok" } }).poll();
    expect(health.detail).toContain(PASSED_OVER_NOTE);
    expect(files.calls[0]?.path).toBe(REGISTRY_FILE);
  });

  test("GROK_HOME is read where it points, and named when Grok Build is not there", async () => {
    const files = memoryFiles();
    const adapter = grokBuildAdapterFor(files, { env: { GROK_HOME: "/Users/example/grok-home" } });
    const { health } = await adapter.poll();
    expect(health.detail).toBe(
      "Grok Build was not found: GROK_HOME is set to ~/grok-home, and there is no ~/grok-home/active_sessions.json or ~/grok-home/sessions folder. Agent Lookout looks again every minute.",
    );
  });

  test("a list that cannot be read fails the poll, and finishes nothing", async () => {
    const files = oneSession(turnStarted(T));
    const adapter = grokBuildAdapterFor(files);
    expect((await adapter.poll()).sessions).toHaveLength(1);
    files.write(REGISTRY_FILE, "[{");
    const broken = await adapter.poll();
    expect(broken.health).toMatchObject({
      state: "error",
      detail:
        "Grok Build sessions could not be read: ~/.grok/active_sessions.json was found, but it is not a list Agent Lookout reads.",
    });
    expect(broken.sessions).toEqual([]);
    writeRegistry(files, [entry()]);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("working");
  });

  test("carries its own declaration, and says where it looks", () => {
    const adapter = grokBuildAdapterFor(memoryFiles());
    expect(adapter.capabilities).toBe(GROK_BUILD_CAPABILITIES);
    expect(adapter.lookingIn).toBe("Looking for Grok Build sessions in ~/.grok/sessions.");
  });
});

describe("Sources", () => {
  const common = [
    { label: "Session list", value: "~/.grok/active_sessions.json" },
    { label: "Read", value: "every 2 seconds" },
    { label: "Sessions folder", value: "~/.grok/sessions" },
    { label: "Event logs", value: "events.jsonl in each listed session's folder, when it changes" },
    { label: "Process IDs", value: "signal 0, every 2 seconds" },
  ];

  test("on a Mac, ps says when a process started", async () => {
    const { health } = await grokBuildAdapterFor(oneSession(wholeTurn(T))).poll();
    expect(health.watching).toEqual([
      ...common,
      { label: "Process check", value: "ps -o pid=,lstart= -p <pids>" },
      {
        label: "Process check run",
        value: "every 30 seconds while a session's process runs, and sooner when another appears",
      },
    ]);
  });

  test("on Linux and Windows, signal 0 alone", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const { health } = await grokBuildAdapterFor(oneSession(wholeTurn(T)), { platform }).poll();
      expect(health.watching, platform).toEqual([
        ...common,
        { label: "Process check", value: "signal 0 alone" },
      ]);
    }
  });

  test("on Linux with tmux, the ps before Jump, not run until it is", async () => {
    const panes = {
      look: async () => {},
      paneOf: () => undefined,
      installed: () => true,
      asked: () => false,
      parentsAsked: () => false,
    };
    const { health } = await grokBuildAdapterFor(oneSession(wholeTurn(T)), {
      platform: "linux",
      panes,
    }).poll();
    expect(health.watching).toContainEqual({
      label: "Jump check",
      value: "ps -o pid=,lstart= -p <pids>",
    });
    expect(health.watching).toContainEqual({ label: "Jump check run", value: "not run" });
  });
});

describe("a listed session", () => {
  test("working, in the shared model", async () => {
    const files = oneSession(turnStarted(T) + firstToken(T + SECOND));
    const { health, sessions } = await grokBuildAdapterFor(files).poll();
    expect(health).toMatchObject({ state: "ok", detail: healthy() });
    expect(sessions).toEqual([
      {
        id: ID,
        source: "grok-build",
        surface: "terminal",
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        startedAt: OPENED_AT,
        pid: PID,
        links: {},
        status: "working",
        statusSince: T,
        alive: true,
        stale: false,
        lastWriteAt: NOW - 5 * SECOND,
      },
    ]);
  });

  test("idle, failed and needing you", async () => {
    const statusOf = async (log: string, plan?: boolean) => {
      const files = oneSession(log);
      if (plan !== undefined) writePlan(files, planText(plan), { mtimeMs: NOW - 30 * SECOND });
      const session = byId((await grokBuildAdapterFor(files).poll()).sessions);
      return [session?.status, session?.statusSince, session?.waitingReason];
    };
    expect(await statusOf(wholeTurn(T))).toEqual(["idle", T + 1_000, undefined]);
    expect(await statusOf(wholeTurn(T, "interrupted"))).toEqual(["failed", T + 1_000, undefined]);
    expect(await statusOf(turnStarted(T) + toolStarted(T + SECOND, "ask_user_question"))).toEqual([
      "needs-you",
      T + SECOND,
      "question",
    ]);
    expect(await statusOf(wholeTurn(T), true)).toEqual([
      "needs-you",
      NOW - 30 * SECOND,
      "question",
    ]);
    expect(await statusOf(wholeTurn(T), false)).toEqual(["idle", T + 1_000, undefined]);
  });

  test("unknown, with the note, when its log cannot say", async () => {
    const files = oneSession(turnEnded(T, "crashed"));
    const { health, sessions } = await grokBuildAdapterFor(files).poll();
    expect(byId(sessions)).toMatchObject({ status: "unknown", statusSince: null });
    expect(health.detail).toBe(`${healthy()} ${UNKNOWN_NOTE}`);
  });

  test("unknown, with the note, when its plan file cannot be read", async () => {
    const files = oneSession(wholeTurn(T));
    writePlan(files, "{");
    const { health, sessions } = await grokBuildAdapterFor(files).poll();
    expect(byId(sessions)).toMatchObject({ status: "unknown", statusSince: null });
    expect(health.detail).toBe(`${healthy()} ${UNKNOWN_NOTE}`);
  });

  test("unknown, with the note, when its turn began before the listing with nothing from it since", async () => {
    // The model wrote before the listing, so this is not the 2 minutes with nothing from it.
    const files = memoryFiles();
    writeRegistry(files, [entry({ opened_at: openedAt(NOW) })]);
    writeEvents(files, turnStarted(NOW - 5 * MINUTE) + firstToken(NOW - 5 * MINUTE + SECOND), {
      mtimeMs: NOW - 5 * MINUTE + SECOND,
    });
    const { health, sessions } = await grokBuildAdapterFor(files).poll();
    expect(byId(sessions)).toMatchObject({ status: "unknown", statusSince: null });
    expect(health.detail).toBe(`${healthy()} ${UNKNOWN_NOTE}`);
  });

  test("unknown, with the note, when its log is longer than 8 MiB with no turn's line in its last 8 MiB", async () => {
    const padding = mcpServerStarting(T + SECOND);
    const lines = Math.ceil(MAX_LOG_BYTES / padding.length) + 1;
    const heads = { started: turnStarted(T), ended: turnEnded(T), none: "" };
    for (const [label, head] of Object.entries(heads)) {
      const files = oneSession(head + padding.repeat(lines));
      const { health, sessions } = await grokBuildAdapterFor(files).poll();
      expect(byId(sessions), label).toMatchObject({ status: "unknown", statusSince: null });
      expect(health.detail, label).toBe(`${healthy()} ${UNKNOWN_NOTE}`);
      expect(health.detail, label).toContain(
        "longer than 8 MiB with no turn's start or end in its last 8 MiB",
      );
    }
  });

  test("the note names every cause of unknown", () => {
    for (const cause of [
      "folder cannot be found",
      "event log or plan file cannot be read",
      "ends in a way Grok Build 1.0.45 does not write",
      "longer than 8 MiB with no turn's start or end in its last 8 MiB",
      "nothing from the model for 2 minutes",
      "more than a minute before Grok Build first listed it with nothing from the turn since",
    ]) {
      expect(UNKNOWN_NOTE).toContain(cause);
    }
  });

  test("unknown when its folder is not found, or its log is missing", async () => {
    const files = memoryFiles();
    writeRegistry(files, [entry()]);
    files.mkdir(SESSIONS_DIR);
    expect(byId((await grokBuildAdapterFor(files).poll()).sessions)?.status).toBe("unknown");
    files.mkdir(sessionFolder());
    expect(byId((await grokBuildAdapterFor(files).poll()).sessions)?.status).toBe("unknown");
  });

  test("a turn with nothing from the model for 2 minutes is unknown", async () => {
    const clock = handClock();
    const files = oneSession(turnStarted(T), T);
    const adapter = grokBuildAdapterFor(files, { now: clock.now });
    clock.set(T + NO_OUTPUT_MS + WRITE_TIME_STEP_MS - 1);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("working");
    clock.set(T + NO_OUTPUT_MS + WRITE_TIME_STEP_MS);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("unknown");
    appendEvents(files, firstToken(T + NO_OUTPUT_MS + 3 * SECOND), {
      mtimeMs: T + NO_OUTPUT_MS + 3 * SECOND,
    });
    expect(byId((await adapter.poll()).sessions)?.status).toBe("working");
  });

  test("its name is a title marked as set by you, else its folder's, and the first prompt never shows", async () => {
    const files = oneSession(wholeTurn(T));
    writeSummary(files, summaryText({ title: TYPED_TITLE }));
    const adapter = grokBuildAdapterFor(files);
    const first = await adapter.poll();
    expect(byId(first.sessions)?.name).toBe("demo-project");
    expect(JSON.stringify(first)).not.toContain("quartzmandolin");
    expect(JSON.stringify(first)).not.toContain(SECRET);
    writeSummary(files, summaryText({ title: "Release checklist", manual: true }));
    expect(byId((await adapter.poll()).sessions)?.name).toBe("Release checklist");
  });

  test("a plan's wait keeps its time while plan_mode.json is written again", async () => {
    const clock = handClock();
    const files = oneSession(wholeTurn(T));
    writePlan(files, planText(true), { mtimeMs: NOW - 30 * SECOND });
    const adapter = grokBuildAdapterFor(files, { now: clock.now });
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(NOW - 30 * SECOND);
    clock.advance(10 * SECOND);
    writePlan(files, planText(true).replace('"reminder_count": 0', '"reminder_count": 1'), {
      mtimeMs: NOW + 5 * SECOND,
    });
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 30 * SECOND,
    });
    // Answered, then asked again: a new wait, with its own time.
    writePlan(files, planText(false), { mtimeMs: NOW + 6 * SECOND });
    expect(byId((await adapter.poll()).sessions)?.status).toBe("idle");
    writePlan(files, planText(true), { mtimeMs: NOW + 8 * SECOND });
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(NOW + 8 * SECOND);
  });

  test("a plan's wait takes the file's time again once a clock set back puts its kept time more than a minute ahead", async () => {
    const clock = handClock();
    const files = oneSession(wholeTurn(T));
    writePlan(files, planText(true), { mtimeMs: NOW - 30 * SECOND });
    const adapter = grokBuildAdapterFor(files, { now: clock.now });
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(NOW - 30 * SECOND);
    // Set back a minute: the kept time is a minute ahead at most, so it stays.
    clock.set(NOW - 90 * SECOND);
    writePlan(files, planText(true).replace('"reminder_count": 0', '"reminder_count": 1'), {
      mtimeMs: NOW - 95 * SECOND,
    });
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(NOW - 30 * SECOND);
    // Set back two hours: the plan is still waiting, from the file's time as now written.
    clock.set(NOW - 2 * HOUR);
    writePlan(files, planText(true).replace('"reminder_count": 0', '"reminder_count": 2'), {
      mtimeMs: NOW - 2 * HOUR - 95 * SECOND,
    });
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 2 * HOUR - 95 * SECOND,
    });
  });

  test("a plan's call starts a new wait, though the flag stayed true", async () => {
    const clock = handClock();
    const files = oneSession(turnStarted(T) + toolStarted(T + SECOND, "exit_plan_mode"));
    writePlan(files, planText(true), { mtimeMs: T + 2 * SECOND });
    const adapter = grokBuildAdapterFor(files, { now: clock.now });
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(T + SECOND);
    appendEvents(files, toolStarted(T + 9 * SECOND, "exit_plan_mode"));
    clock.advance(2 * SECOND);
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(T + 9 * SECOND);
  });
});

describe("a session that ends", () => {
  test("its process ends while listed: finished from its log's last write, with its process", async () => {
    const files = oneSession(wholeTurn(T), T + 2 * SECOND);
    const processes = standInProcesses([PID]);
    const adapter = grokBuildAdapterFor(files, { isAlive: processes.isAlive });
    await adapter.poll();
    processes.stop(PID);
    files.forget();
    const session = byId((await adapter.poll()).sessions);
    expect(session).toMatchObject({
      status: "finished",
      statusSince: T + 2 * SECOND,
      pid: PID,
      alive: false,
    });
    // Its log is looked at, not read.
    expect(files.opened()).not.toContain(eventsPath());
  });

  test("a crash left it listed: finished at the first poll, and after a restart, from the same time", async () => {
    const files = oneSession(turnStarted(T), T + 3 * SECOND);
    const dead = { isAlive: () => false };
    const first = byId((await grokBuildAdapterFor(files, dead).poll()).sessions);
    const restarted = byId(
      (await grokBuildAdapterFor(files, { ...dead, now: () => NOW + HOUR }).poll()).sessions,
    );
    expect(first).toMatchObject({ status: "finished", statusSince: T + 3 * SECOND });
    expect(restarted).toEqual({ ...first, stale: false });
  });

  test("one a crash left a day ago is not shown", async () => {
    const files = memoryFiles();
    writeRegistry(files, [entry({ opened_at: openedAt(NOW - 2 * DAY) })]);
    writeEvents(files, turnStarted(NOW - 2 * DAY), { mtimeMs: NOW - DAY - SECOND });
    const { sessions } = await grokBuildAdapterFor(files, { isAlive: () => false }).poll();
    expect(sessions).toEqual([]);
  });

  test("closed by Grok Build: finished, and kept for a day from its end", async () => {
    const clock = handClock();
    const files = oneSession(wholeTurn(T), T + 2 * SECOND);
    const processes = standInProcesses([PID]);
    const adapter = grokBuildAdapterFor(files, { now: clock.now, isAlive: processes.isAlive });
    await adapter.poll();
    writeRegistry(files, []);
    processes.stop(PID);
    clock.advance(SECOND);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: T + 2 * SECOND,
      alive: false,
    });
    clock.set(T + 2 * SECOND + DAY - 1);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("finished");
    clock.set(T + 2 * SECOND + DAY);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("left with /new mid-turn: working while its turn runs, then finished with no process, then working again", async () => {
    const files = oneSession(turnStarted(T) + firstToken(T + SECOND), NOW - SECOND);
    const adapter = grokBuildAdapterFor(files);
    await adapter.poll();
    writeRegistry(files, [entry({ session_id: OTHER_SESSION_ID, opened_at: openedAt(NOW) })]);
    const watched = byId((await adapter.poll()).sessions);
    expect(watched).toMatchObject({ status: "working", alive: true });
    expect(watched?.jump).toBeUndefined();
    appendEvents(files, turnEnded(NOW, "completed"), { mtimeMs: NOW });
    const ended = byId((await adapter.poll()).sessions);
    expect(ended).toMatchObject({ status: "finished", statusSince: NOW });
    expect(ended?.pid).toBeUndefined();
    expect(ended?.alive).toBeUndefined();
    appendEvents(files, turnStarted(NOW + SECOND) + firstToken(NOW + 2 * SECOND), {
      mtimeMs: NOW + 2 * SECOND,
    });
    expect(byId((await adapter.poll()).sessions)?.status).toBe("working");
  });

  test("left with /new while idle: finished at once", async () => {
    const files = oneSession(wholeTurn(T), T + 2 * SECOND);
    const adapter = grokBuildAdapterFor(files);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("idle");
    writeRegistry(files, []);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: T + 2 * SECOND,
    });
  });

  test("gone back to mid-question by the process that left it, which lists it again: still needs you", async () => {
    const asked = OPENED_AT + MINUTE;
    const files = oneSession(
      turnStarted(asked - 10 * SECOND) +
        firstToken(asked - 5 * SECOND) +
        toolStarted(asked, "ask_user_question"),
      asked,
    );
    const adapter = grokBuildAdapterFor(files);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("needs-you");
    writeRegistry(files, []);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("needs-you");
    writeRegistry(files, [entry({ opened_at: openedAt(NOW - 30 * SECOND) })]);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "needs-you",
      statusSince: asked,
    });
    // Left again: still waiting, watched.
    writeRegistry(files, []);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("needs-you");
  });

  test("listed in place of the listing before mid-turn, with no poll that found it off the list: unknown until its next turn line", async () => {
    const asked = OPENED_AT + MINUTE;
    const log =
      turnStarted(asked - 10 * SECOND) +
      firstToken(asked - 5 * SECOND) +
      toolStarted(asked, "ask_user_question");
    for (const pid of [PID, OTHER_PID]) {
      const files = oneSession(log, asked);
      const adapter = grokBuildAdapterFor(files);
      expect(byId((await adapter.poll()).sessions)?.status).toBe("needs-you");
      // A resume in another process, or in one given the same ID, that wrote nothing yet.
      writeRegistry(files, [entry({ pid, opened_at: openedAt(NOW - 30 * SECOND) })]);
      expect(byId((await adapter.poll()).sessions)?.status).toBe("unknown");
    }
  });

  test("resumed two days after its last turn ended: idle since the listing, not stale", async () => {
    const files = oneSession(wholeTurn(NOW - 2 * DAY), NOW - 2 * DAY + 2 * SECOND);
    writeRegistry(files, [entry({ opened_at: openedAt(NOW - 30 * SECOND) })]);
    expect(byId((await grokBuildAdapterFor(files).poll()).sessions)).toMatchObject({
      status: "idle",
      statusSince: NOW - 30 * SECOND,
      stale: false,
    });
  });

  test("left with /new while a plan waits: still needs you", async () => {
    const files = oneSession(wholeTurn(T), T + 2 * SECOND);
    writePlan(files, planText(true), { mtimeMs: T + 5 * SECOND });
    const adapter = grokBuildAdapterFor(files);
    await adapter.poll();
    writeRegistry(files, []);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("needs-you");
  });

  test("left with /new when neither of its times can be right: finished from the first poll that found it so", async () => {
    const clock = handClock();
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    // Listed ahead of the clock, and no folder, so no log's time either.
    writeRegistry(files, [entry({ opened_at: openedAt(NOW + 5 * MINUTE) })]);
    const processes = standInProcesses([PID]);
    const adapter = grokBuildAdapterFor(files, { now: clock.now, isAlive: processes.isAlive });
    expect(byId((await adapter.poll()).sessions)?.status).toBe("unknown");
    writeRegistry(files, []);
    clock.set(NOW + 2 * SECOND);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW + 2 * SECOND,
    });
    clock.advance(2 * SECOND);
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(NOW + 2 * SECOND);
    // Its process ends: the same time, now with its process.
    processes.stop(PID);
    clock.advance(2 * SECOND);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW + 2 * SECOND,
      pid: PID,
      alive: false,
    });
  });

  test("left with /new, then the clock set back past both its times: finished from that poll", async () => {
    // The clock ran 2 hours fast while Grok Build listed the session and wrote its log.
    const clock = handClock();
    const files = memoryFiles();
    writeRegistry(files, [entry({ opened_at: openedAt(NOW) })]);
    writeEvents(files, wholeTurn(NOW), { mtimeMs: NOW + MINUTE });
    const processes = standInProcesses([PID]);
    const adapter = grokBuildAdapterFor(files, { now: clock.now, isAlive: processes.isAlive });
    clock.set(NOW + 90 * SECOND);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("idle");
    writeRegistry(files, []);
    clock.set(NOW + 2 * MINUTE);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW + MINUTE,
    });
    const back = NOW - 2 * HOUR + 3 * MINUTE;
    clock.set(back);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: back,
    });
    clock.advance(2 * SECOND);
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(back);
    processes.stop(PID);
    clock.advance(2 * SECOND);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: back,
      pid: PID,
      alive: false,
    });
    clock.advance(2 * SECOND);
    expect(byId((await adapter.poll()).sessions)?.statusSince).toBe(back);
  });

  test("left with /new with a turn left over: finished, not unknown", async () => {
    const files = oneSession(turnStarted(NOW - 10 * MINUTE), NOW - 10 * MINUTE);
    const adapter = grokBuildAdapterFor(files);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("unknown");
    writeRegistry(files, []);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("finished");
  });

  test("a session watched for a day ends", async () => {
    const clock = handClock();
    const files = oneSession(turnStarted(T) + firstToken(T + 1), NOW);
    const adapter = grokBuildAdapterFor(files, { now: clock.now });
    await adapter.poll();
    writeRegistry(files, []);
    clock.advance(DAY - 1);
    appendEvents(files, firstToken(NOW + DAY - 2), { mtimeMs: NOW + DAY - 2 });
    expect(byId((await adapter.poll()).sessions)?.status).toBe("working");
    clock.advance(1);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({
      status: "finished",
      statusSince: NOW + DAY - 2,
    });
  });

  test("listed open again under its ID: open again", async () => {
    const files = oneSession(wholeTurn(T), T + 2 * SECOND);
    const processes = standInProcesses([PID]);
    const adapter = grokBuildAdapterFor(files, { isAlive: processes.isAlive });
    await adapter.poll();
    writeRegistry(files, []);
    processes.stop(PID);
    expect(byId((await adapter.poll()).sessions)?.status).toBe("finished");
    writeRegistry(files, [entry({ pid: OTHER_PID, opened_at: openedAt(NOW) })]);
    processes.start(OTHER_PID);
    expect(byId((await adapter.poll()).sessions)).toMatchObject({ status: "idle", pid: OTHER_PID });
  });

  test("what it kept of a session is let go a day after it ended", async () => {
    const clock = handClock();
    const files = oneSession(wholeTurn(T), T + 2 * SECOND);
    writeSummary(files, summaryText());
    const processes = standInProcesses([PID]);
    const adapter = grokBuildAdapterFor(files, { now: clock.now, isAlive: processes.isAlive });
    await adapter.poll();
    writeRegistry(files, []);
    processes.stop(PID);
    await adapter.poll();
    clock.set(T + 2 * SECOND + DAY);
    files.forget();
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(files.count(undefined, (target) => target.startsWith(sessionFolder()))).toBe(0);
  });
});

describe("whether its process is the one that listed it", () => {
  test("on a Mac, a process that started more than a minute after the listing has its ID since", async () => {
    const at = (start: number) => async () => {
      const ps = standInStarts({ [PID]: start });
      const files = oneSession(wholeTurn(T));
      return byId(
        (await grokBuildAdapterFor(files, { readProcessStarts: ps.read }).poll()).sessions,
      );
    };
    expect((await at(OPENED_AT + MINUTE)())?.status).toBe("idle");
    expect((await at(OPENED_AT - HOUR)())?.status).toBe("idle");
    expect(await at(OPENED_AT + MINUTE + SECOND)()).toMatchObject({
      status: "finished",
      alive: false,
    });
  });

  test("on a Mac, a listing ahead of the clock or a ps that fails leaves signal 0 to say", async () => {
    const ps = standInStarts({ [PID]: NOW });
    ps.fails = true;
    const files = oneSession(wholeTurn(T));
    expect(
      byId((await grokBuildAdapterFor(files, { readProcessStarts: ps.read }).poll()).sessions)
        ?.status,
    ).toBe("idle");
    const ahead = memoryFiles();
    writeRegistry(ahead, [entry({ opened_at: openedAt(NOW + 5 * MINUTE) })]);
    writeEvents(ahead, wholeTurn(T));
    const later = standInStarts({ [PID]: NOW + 6 * MINUTE });
    expect(
      byId((await grokBuildAdapterFor(ahead, { readProcessStarts: later.read }).poll()).sessions)
        ?.status,
    ).toBe("idle");
  });

  test("on a Mac, ps is asked once for every process in a run, and again after 30 seconds or a clock set back", async () => {
    const clock = handClock();
    const ps = standInStarts({ [PID]: OPENED_AT - MINUTE, [OTHER_PID]: OPENED_AT - MINUTE });
    const files = memoryFiles();
    writeRegistry(files, [entry(), entry({ session_id: OTHER_SESSION_ID, pid: OTHER_PID })]);
    const adapter = grokBuildAdapterFor(files, { now: clock.now, readProcessStarts: ps.read });
    await adapter.poll();
    expect(ps.runs).toEqual([[PID, OTHER_PID]]);
    clock.advance(29 * SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);
    clock.advance(SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(2);
    clock.set(NOW - MINUTE);
    await adapter.poll();
    expect(ps.runs).toHaveLength(3);
  });

  test("on a Mac, the card names the process only once ps says it is the session's own", async () => {
    const files = oneSession(wholeTurn(T));
    const unknown = byId(
      (await grokBuildAdapterFor(files, { readProcessStarts: async () => new Map() }).poll())
        .sessions,
    );
    expect(unknown?.status).toBe("idle");
    expect(unknown?.pid).toBeUndefined();
    expect(unknown?.alive).toBeUndefined();
    const same = byId((await grokBuildAdapterFor(files).poll()).sessions);
    expect(same).toMatchObject({ pid: PID, alive: true });
    const linux = byId(
      (
        await grokBuildAdapterFor(files, {
          platform: "linux",
          readProcessStarts: async () => new Map(),
        }).poll()
      ).sessions,
    );
    expect(linux).toMatchObject({ pid: PID, alive: true });
  });

  test("a dead process, and one owned by another user, as signal 0 says", async () => {
    const processes = standInProcesses([]);
    const files = oneSession(wholeTurn(T));
    expect(
      byId((await grokBuildAdapterFor(files, { isAlive: processes.isAlive }).poll()).sessions)
        ?.status,
    ).toBe("finished");
    expect(processes.asked).toEqual([PID]);
  });

  test("on Linux and Windows, ps is never asked for whether a session is open", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const ps = standInStarts({ [PID]: NOW + HOUR });
      const files = oneSession(wholeTurn(T));
      const { sessions } = await grokBuildAdapterFor(files, {
        platform,
        readProcessStarts: ps.read,
      }).poll();
      expect(byId(sessions)?.status, platform).toBe("idle");
      expect(ps.runs, platform).toEqual([]);
    }
  });
});

describe("Jump", () => {
  const pane: TmuxPane = { pid: PID, id: "%3", place: "demo-project:0.1" };
  const tab: TerminalTab = { app: "iTerm2", tty: "/dev/ttys007" };

  function knownPanes(panes: Record<number, TmuxPane>) {
    const looked: number[][] = [];
    return {
      looked,
      look: async (asked: readonly number[]) => {
        looked.push([...asked].sort());
      },
      paneOf: (pid: number) => panes[pid],
      installed: () => false,
      asked: () => false,
      parentsAsked: () => false,
    };
  }

  function knownTabs(tabs: Record<number, TerminalTab>) {
    return {
      look: async () => {},
      tabOf: (pid: number) => tabs[pid],
      editorOf: () => undefined,
      asked: () => true,
    };
  }

  const twoSessions = () => {
    const files = memoryFiles();
    writeRegistry(files, [entry(), entry({ session_id: OTHER_SESSION_ID, pid: OTHER_PID })]);
    writeEvents(files, wholeTurn(T));
    writeEvents(files, wholeTurn(T), { id: OTHER_SESSION_ID });
    return files;
  };
  const ownStarts = () =>
    standInStarts({ [PID]: OPENED_AT - SECOND, [OTHER_PID]: OPENED_AT - SECOND });

  test("on a Mac, a session in a pane or a tab is given its place, once ps says it is its own process", async () => {
    const panes = knownPanes({ [PID]: pane });
    const ps = ownStarts();
    const { sessions } = await grokBuildAdapterFor(twoSessions(), {
      panes,
      terminals: knownTabs({ [OTHER_PID]: tab }),
      readProcessStarts: ps.read,
    }).poll();
    expect(byId(sessions)?.jump).toEqual({ kind: "tmux", place: "demo-project:0.1" });
    expect(byId(sessions, OTHER_ID)?.jump).toEqual({
      kind: "terminal",
      app: "iTerm2",
      place: "iTerm2",
    });
    expect(JSON.stringify(sessions)).not.toContain("%3");
    expect(panes.looked).toEqual([[PID, OTHER_PID]]);
    expect(ps.runs).toEqual([[PID, OTHER_PID]]);
  });

  test("no Jump while ps cannot say the process is its own", async () => {
    const ps = standInStarts({});
    const { sessions } = await grokBuildAdapterFor(twoSessions(), {
      panes: knownPanes({ [PID]: pane }),
      readProcessStarts: ps.read,
    }).poll();
    expect(byId(sessions)?.jump).toBeUndefined();
  });

  test("on Linux, ps is asked only about a process found in a pane, before Jump", async () => {
    const ps = ownStarts();
    const { sessions } = await grokBuildAdapterFor(twoSessions(), {
      platform: "linux",
      panes: knownPanes({ [PID]: pane }),
      readProcessStarts: ps.read,
    }).poll();
    expect(byId(sessions)?.jump).toEqual({ kind: "tmux", place: "demo-project:0.1" });
    expect(ps.runs).toEqual([[PID]]);
  });

  test("a session left with /new is not looked for", async () => {
    const files = oneSession(turnStarted(T) + firstToken(T + 1));
    const panes = knownPanes({ [PID]: pane });
    const adapter = grokBuildAdapterFor(files, { panes, readProcessStarts: ownStarts().read });
    await adapter.poll();
    writeRegistry(files, []);
    const { sessions } = await adapter.poll();
    expect(byId(sessions)?.jump).toBeUndefined();
    expect(panes.looked.at(-1)).toEqual([]);
  });
});

describe("what is read", () => {
  test("of a session whose process has ended, its log is not opened and its plan file not looked at", async () => {
    const files = oneSession(wholeTurn(T));
    writePlan(files, planText(true));
    await grokBuildAdapterFor(files, { isAlive: () => false }).poll();
    expect(files.opened()).toEqual([REGISTRY_FILE]);
    expect(files.count("lstat", (target) => target.endsWith("plan_mode.json"))).toBe(0);
  });

  test("nothing but a few fields becomes text", async () => {
    const files = memoryFiles();
    writeRegistry(files, [entry({ extra_field: SECRET })]);
    writeEvents(
      files,
      turnStarted(T, { model_id: SECRET }) +
        toolStarted(T + 1, SECRET) +
        toolCompleted(T + 2, SECRET) +
        turnEnded(T + 3, "cancelled", { cancellation_context: { trigger: SECRET } }),
    );
    writeSummary(files, summaryText({ title: TYPED_TITLE }));
    const answer = await grokBuildAdapterFor(files).poll();
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(JSON.stringify(answer)).not.toContain("quartzmandolin");
  });
});
