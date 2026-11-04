import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  NEWER_FORMAT_NOTE,
  PI_CAPABILITIES,
  piSessionsDirFor,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
  STATUS_NOTE,
  UNCHECKED_NOTE,
} from "@collector/adapters/pi/index";
import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller } from "@collector/poller";
import {
  conversationLines,
  DAY,
  headerFields,
  HOME,
  HOUR,
  line,
  MINUTE,
  nameLine,
  NOW,
  PRIVATE_ARGUMENTS,
  PRIVATE_SYSTEM_PROMPT,
  PRIVATE_WORDS,
  PROJECT,
  PROJECT_FOLDER,
  projectFolderOf,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  sessionText,
  SESSIONS_DIR,
  STARTED_AT,
} from "@tests/fixtures/pi/pi";
import {
  handClock,
  memoryFiles,
  piAdapterFor,
  standInProcesses,
} from "@tests/support/adapters/pi/piAdapter";
import { asWritten } from "@tests/support/paths";

const FILE = sessionPath(SESSION_ID);
const NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const READ_DETAIL = `Sessions are read from the files Pi keeps in ~/.pi/agent/sessions. ${NOTES}`;

/** The rows Sources shows, for the default folder. */
function watching(
  read: string,
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no pi",
) {
  return [
    { label: "Sessions folder", value: "~/.pi/agent/sessions" },
    { label: "Read", value: read },
    { label: "Process check", value: "ps -A -o comm=" },
    { label: "Process check run", value: processCheckRun },
  ];
}

/** A file system with one session in a project folder. */
function oneSession(rest?: string) {
  const files = memoryFiles();
  files.write(FILE, sessionText(SESSION_ID, rest));
  return files;
}

describe("where it looks", () => {
  test("in ~/.pi/agent/sessions, on every system, unless a setting names another place", () => {
    expect(asWritten(piSessionsDirFor({}, HOME))).toBe(SESSIONS_DIR);
    expect(piSessionsDirFor({}, "C:\\Users\\example")).toBe(
      path.resolve("C:\\Users\\example", ".pi", "agent", "sessions"),
    );
  });

  test("in `sessions` under PI_CODING_AGENT_DIR", () => {
    const agent = path.resolve("/pi-agent");
    expect(asWritten(piSessionsDirFor({ PI_CODING_AGENT_DIR: agent }, HOME))).toBe(
      asWritten(path.join(agent, "sessions")),
    );
  });

  test("in PI_CODING_AGENT_SESSION_DIR itself, which comes before PI_CODING_AGENT_DIR", () => {
    const sessions = path.resolve("/pi-sessions");
    const env = {
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_CODING_AGENT_DIR: path.resolve("/pi-agent"),
    };
    expect(asWritten(piSessionsDirFor(env, HOME))).toBe(asWritten(sessions));
  });

  test("from the home folder for a setting that starts with ~, as Pi does", () => {
    expect(asWritten(piSessionsDirFor({ PI_CODING_AGENT_SESSION_DIR: "~/pi" }, HOME))).toBe(
      `${HOME}/pi`,
    );
    expect(asWritten(piSessionsDirFor({ PI_CODING_AGENT_DIR: "~" }, HOME))).toBe(
      `${HOME}/sessions`,
    );
  });

  test("from the home folder for a setting that starts with ~\\, as Pi does on Windows", () => {
    expect(asWritten(piSessionsDirFor({ PI_CODING_AGENT_SESSION_DIR: "~\\pi" }, HOME))).toBe(
      `${HOME}/pi`,
    );
  });

  test("past a relative setting, which only Pi's own folder could make sense of", () => {
    const env = { PI_CODING_AGENT_DIR: "pi", PI_CODING_AGENT_SESSION_DIR: "sessions" };
    expect(asWritten(piSessionsDirFor(env, HOME))).toBe(SESSIONS_DIR);
  });

  test("past an empty setting", () => {
    const env = { PI_CODING_AGENT_DIR: "", PI_CODING_AGENT_SESSION_DIR: "  " };
    expect(asWritten(piSessionsDirFor(env, HOME))).toBe(SESSIONS_DIR);
  });

  test("in the folder Agent Lookout's own setting names, before any other", () => {
    const env = {
      AGENT_LOOKOUT_PI_HOME: " /tmp/pi ",
      PI_CODING_AGENT_SESSION_DIR: path.resolve("/other"),
    };
    expect(asWritten(piSessionsDirFor(env, HOME))).toBe("/tmp/pi/sessions");
  });

  test("past a setting of spaces", async () => {
    expect(asWritten(piSessionsDirFor({ AGENT_LOOKOUT_PI_HOME: "  " }, HOME))).toBe(SESSIONS_DIR);
    const adapter = piAdapterFor(memoryFiles(), { env: { AGENT_LOOKOUT_PI_HOME: "  " } });
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });
});

describe("a Pi that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = piAdapterFor(files, { now: clock.now, processes });
    expect(adapter.lookingIn).toBe("Looking for Pi sessions in ~/.pi/agent/sessions.");

    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "pi",
      label: "Pi",
      state: "unavailable",
      detail:
        "Pi was not found: there is no ~/.pi/agent/sessions folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(sessions).toEqual([]);
    expect(processes.asked.count).toBe(0);
    expect(files.count()).toBe(1);

    clock.advance(RECHECK_MS - SECOND);
    await adapter.poll();
    expect(files.count()).toBe(1);

    clock.advance(SECOND);
    await adapter.poll();
    expect(files.count()).toBe(2);
    expect(processes.asked.count).toBe(0);
  });

  test("a clock set back looks again", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.advance(-MINUTE);
    await adapter.poll();
    expect(files.count("readdir")).toBe(2);
  });

  test("is found once its folder comes", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.write(FILE, sessionText(SESSION_ID));
    clock.advance(RECHECK_MS);
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(1);
  });

  test("a folder that goes is Pi not found", async () => {
    const files = oneSession();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);

    files.remove(SESSIONS_DIR);
    clock.advance(SECOND);
    expect((await adapter.poll()).health.state).toBe("unavailable");

    files.write(FILE, sessionText(SESSION_ID));
    clock.advance(RECHECK_MS);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("a folder that goes forgets what was read, and reads the file again", async () => {
    const files = oneSession();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.fail(SESSIONS_DIR, "ENOENT");
    clock.advance(SECOND);
    expect((await adapter.poll()).health.state).toBe("unavailable");
    files.heal(SESSIONS_DIR);
    clock.advance(RECHECK_MS);
    expect((await adapter.poll()).sessions).toHaveLength(1);
    expect(files.count("openRegular")).toBe(2);
  });

  test("a named folder that goes and comes back is looked through at once", async () => {
    const env = { AGENT_LOOKOUT_PI_HOME: "/tmp/pi" };
    const sessions = "/tmp/pi/sessions";
    const file = sessionPath(SESSION_ID, `${sessions}/--demo--`);
    const files = memoryFiles();
    files.write(file, sessionText(SESSION_ID), { mtimeMs: NOW - 2 * DAY });
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now, env });
    expect((await adapter.poll()).sessions).toEqual([]);
    files.remove(sessions);
    clock.advance(2 * SECOND);
    const gone = await adapter.poll();
    expect(gone.health.state).toBe("ok");
    expect(gone.health.watching).toContainEqual({ label: "Read", value: "not found" });
    files.write(file, sessionText(SESSION_ID), { mtimeMs: clock.now() });
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("a named folder that is missing is looked for on every poll", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const env = { AGENT_LOOKOUT_PI_HOME: "/tmp/pi" };
    const adapter = piAdapterFor(files, { now: clock.now, env });
    await adapter.poll();
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(files.count("readdir")).toBe(2);
  });

  test("a folder named for Agent Lookout alone, with nothing there, is an answer", async () => {
    const adapter = piAdapterFor(memoryFiles(), {
      env: { AGENT_LOOKOUT_PI_HOME: "/tmp/empty-pi" },
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain("AGENT_LOOKOUT_PI_HOME is set");
    expect(health.detail).toContain(NOTES);
    expect(sessions).toEqual([]);
  });

  test("a folder that cannot be listed is an error, with no session", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    files.fail(SESSIONS_DIR);
    const { health, sessions } = await piAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: "Pi sessions could not be read: the folder ~/.pi/agent/sessions could not be listed.",
    });
    expect(sessions).toEqual([]);
  });

  test("something unexpected is a sentence, not a throw", async () => {
    const processes = {
      read: async () => {
        throw new Error("A stand-in that throws.");
      },
    };
    const { health, sessions } = await piAdapterFor(oneSession(), { processes }).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading Pi sessions.",
    });
    expect(sessions).toEqual([]);
  });
});

describe("a session", () => {
  test("is shown with its folder's name, and as unknown while a pi program runs", async () => {
    const result = await piAdapterFor(oneSession()).poll();
    expect(result.basis).toBe(BASIS);
    expect(result.health).toEqual({
      id: "pi",
      label: "Pi",
      state: "ok",
      detail: READ_DETAIL,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(result.sessions).toEqual([
      {
        id: `pi:${SESSION_ID}`,
        source: "pi",
        surface: "unknown",
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "unknown",
        startedAt: STARTED_AT,
        statusSince: null,
        links: {},
        stale: false,
      },
    ]);
  });

  test("has the name a person or an extension gave it, and the newest", async () => {
    const files = oneSession(`${nameLine("First")}${conversationLines()}${nameLine("Second")}`);
    expect((await piAdapterFor(files).poll()).sessions[0].name).toBe("Second");
  });

  test("whose name is cleared goes back to its folder's", async () => {
    const files = oneSession(`${nameLine("First")}${nameLine("")}`);
    expect((await piAdapterFor(files).poll()).sessions[0].name).toBe("demo-project");
  });

  test("never takes its name from what was typed", async () => {
    const { sessions } = await piAdapterFor(oneSession()).poll();
    expect(sessions[0].name).toBe("demo-project");
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
  });

  test("carries the kept fields and nothing else of its file", async () => {
    const result = await piAdapterFor(oneSession()).poll();
    const said = JSON.stringify(result);
    for (const word of [PRIVATE_WORDS, PRIVATE_ARGUMENTS, PRIVATE_SYSTEM_PROMPT]) {
      expect(said).not.toContain(word);
    }
    for (const field of ["demo-model", "demo-provider", "earlier-session", "tokens", "pid"]) {
      expect(said).not.toContain(field);
    }
    expect(Object.keys(result.sessions[0]).sort()).toEqual(
      [
        "cwd",
        "id",
        "links",
        "name",
        "project",
        "source",
        "stale",
        "startedAt",
        "status",
        "statusSince",
        "surface",
      ].sort(),
    );
  });

  test("with a bad folder or time has none, and is still shown", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      line(headerFields(SESSION_ID, { cwd: 12, timestamp: "yesterday" })) + conversationLines(),
    );
    const { sessions } = await piAdapterFor(files).poll();
    expect(sessions).toEqual([
      expect.objectContaining({
        name: `pi:${SESSION_ID}`,
        cwd: null,
        project: null,
        startedAt: null,
      }),
    ]);
  });

  test("in a broken file is left out, and the others stand", async () => {
    const files = oneSession();
    files.write(sessionPath(sessionIdOf(2)), "not json\n");
    files.write(sessionPath(sessionIdOf(3)), "");
    files.write(sessionPath(sessionIdOf(4)), `${"x".repeat(100_000)}\n`);
    const { health, sessions } = await piAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(sessions.map((session) => session.id)).toEqual([`pi:${SESSION_ID}`]);
  });

  test("of a newer format is left out, and the card says so", async () => {
    const files = oneSession();
    files.write(sessionPath(sessionIdOf(2)), line(headerFields(sessionIdOf(2), { version: 4 })));
    const { health, sessions } = await piAdapterFor(files).poll();
    expect(health.detail).toBe(`${READ_DETAIL} ${NEWER_FORMAT_NOTE}`);
    expect(sessions).toHaveLength(1);
  });

  test("in a link, or in a folder that is a link, is not read", async () => {
    const files = memoryFiles();
    files.special(FILE);
    files.special(projectFolderOf("/Users/example/code/linked"));
    const { health, sessions } = await piAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("written over a day ago is not listed, and its file is not opened", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - DAY - SECOND });
    const processes = standInProcesses();
    const { sessions } = await piAdapterFor(files, { processes }).poll();
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
    expect(processes.asked.count).toBe(0);
  });

  test("leaves the list a day after its file was last written", async () => {
    const files = oneSession();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    clock.advance(DAY - SECOND);
    expect((await adapter.poll()).sessions).toHaveLength(1);
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("resumed in a file already listed keeps its id, and takes a name added to it", async () => {
    const files = oneSession();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    const [before] = (await adapter.poll()).sessions;

    clock.advance(MINUTE);
    files.append(FILE, nameLine("Picked up again"), { mtimeMs: clock.now() });
    const [after] = (await adapter.poll()).sessions;
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Picked up again");
  });

  test("two files that hold one id show once, from the newest", async () => {
    const files = memoryFiles();
    const older = sessionPath(SESSION_ID, projectFolderOf("/Users/example/code/older"));
    files.write(older, sessionText(SESSION_ID, nameLine("Older")), { mtimeMs: NOW - HOUR });
    files.write(FILE, sessionText(SESSION_ID, nameLine("Newer")), { mtimeMs: NOW - MINUTE });
    const { sessions } = await piAdapterFor(files).poll();
    expect(sessions.map((session) => session.name)).toEqual(["Newer"]);
  });

  test("written in the flat folder Pi's own setting names is found", async () => {
    const dir = path.resolve("/pi-sessions");
    const files = memoryFiles();
    files.write(sessionPath(SESSION_ID, dir), sessionText(SESSION_ID));
    const { sessions } = await piAdapterFor(files, {
      env: { PI_CODING_AGENT_SESSION_DIR: dir },
    }).poll();
    expect(sessions).toHaveLength(1);
  });

  test("written on Windows is read by Windows' rules", async () => {
    const files = memoryFiles();
    const cwd = "C:\\Users\\example\\code\\demo-project";
    files.write(
      `${projectFolderOf(cwd)}/${path.basename(FILE)}`,
      line(headerFields(SESSION_ID, { cwd })) + conversationLines(),
    );
    const { sessions } = await piAdapterFor(files, {
      platform: "win32",
      processes: undefined,
    }).poll();
    expect(sessions).toEqual([expect.objectContaining({ cwd, name: "demo-project" })]);
  });
});

describe("its status", () => {
  test("is finished at its last write once no pi program runs, and the poll is named apart", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - MINUTE });
    const processes = standInProcesses({ ok: true, running: false });
    const { health, sessions, basis } = await piAdapterFor(files, { processes }).poll();
    expect(basis).toBe(BASIS_CLOSED);
    expect(health.detail).toBe(
      `${READ_DETAIL} No pi program runs, so each session shows as finished.`,
    );
    expect(sessions).toEqual([
      expect.objectContaining({ status: "finished", statusSince: NOW - MINUTE }),
    ]);
  });

  test("is unknown while ps cannot say, and the poll is named apart", async () => {
    const processes = standInProcesses({ ok: false });
    const { health, sessions, basis } = await piAdapterFor(oneSession(), { processes }).poll();
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(health.detail).toBe(
      `${READ_DETAIL} ps could not be run to tell whether Pi runs, so no session is shown as finished.`,
    );
    expect(sessions[0]).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("is unknown on Windows, where ps is not run, and the card says so", async () => {
    const processes = standInProcesses({ ok: false });
    const { health, sessions, basis } = await piAdapterFor(oneSession(), {
      platform: "win32",
      processes,
    }).poll();
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(health.detail).toContain(
      "Agent Lookout cannot tell on this system whether Pi runs, so no session is shown as finished.",
    );
    expect(health.watching).toEqual(watching("every 2 seconds", "not run on Windows"));
    expect(sessions[0].status).toBe("unknown");
  });

  test("with no session to show, a poll is still read without ps where ps is not run", async () => {
    const files = memoryFiles();
    files.mkdir(PROJECT_FOLDER);
    const windows = await piAdapterFor(files, { platform: "win32", processes: undefined }).poll();
    expect(windows.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(windows.health.detail).toBe(READ_DETAIL);
    expect((await piAdapterFor(files).poll()).basis).toBe(BASIS);
  });

  test("a named folder with nothing there on Windows is read that way too", async () => {
    const { basis, health } = await piAdapterFor(memoryFiles(), {
      env: { AGENT_LOOKOUT_PI_HOME: "/tmp/empty-pi" },
      platform: "win32",
      processes: undefined,
    }).poll();
    expect(health.state).toBe("ok");
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
  });

  test("a crash left behind reads as a quit does: unknown while another pi runs, finished once none does", async () => {
    // The turn was cut off: the newest line is a person's prompt, with no reply.
    const crashed = sessionText(
      SESSION_ID,
      line({ type: "message", message: { role: "user", content: PRIVATE_WORDS } }),
    );
    const files = memoryFiles();
    files.write(FILE, crashed, { mtimeMs: NOW - HOUR });
    const clock = handClock();
    const processes = standInProcesses({ ok: true, running: true });
    const adapter = piAdapterFor(files, { now: clock.now, processes });

    expect((await adapter.poll()).sessions[0].status).toBe("unknown");
    processes.set({ ok: true, running: false });
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: NOW - HOUR,
    });
  });

  test("is never anything that says the session runs or needs you", async () => {
    const files = oneSession();
    for (const answer of [
      { ok: true, running: true } as const,
      { ok: true, running: false } as const,
      { ok: false } as const,
    ]) {
      const { sessions } = await piAdapterFor(files, {
        processes: standInProcesses(answer),
      }).poll();
      expect(["unknown", "finished"]).toContain(sessions[0].status);
      expect(sessions[0]).not.toHaveProperty("waitingReason");
      expect(sessions[0]).not.toHaveProperty("alive");
    }
    expect(PI_CAPABILITIES["needs-you"].level).toBe("no");
  });
});

describe("asking ps", () => {
  test("not with no session to show", async () => {
    const files = memoryFiles();
    files.mkdir(PROJECT_FOLDER);
    const processes = standInProcesses();
    await piAdapterFor(files, { processes }).poll();
    expect(processes.asked.count).toBe(0);
  });

  test("at most every 10 seconds", async () => {
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = piAdapterFor(oneSession(), { now: clock.now, processes });
    await adapter.poll();
    clock.advance(PROCESS_CHECK_MS - SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test("sooner when a session is written after it said none runs, though not within 2 seconds", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - MINUTE });
    const clock = handClock();
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = piAdapterFor(files, { now: clock.now, processes });

    expect((await adapter.poll()).sessions[0].status).toBe("finished");
    expect(processes.asked.count).toBe(1);

    processes.set({ ok: true, running: true });
    clock.advance(SECOND);
    files.append(FILE, "\n", { mtimeMs: clock.now() });
    expect((await adapter.poll()).sessions[0].status).toBe("finished");
    expect(processes.asked.count).toBe(1);

    clock.advance(PROMPT_PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0].status).toBe("unknown");
    expect(processes.asked.count).toBe(2);
  });

  test.each([
    ["while a pi runs", { ok: true, running: true } as const],
    ["while ps cannot say", { ok: false } as const],
  ])("no sooner %s, whatever is written", async (_case, answer) => {
    const files = oneSession();
    const clock = handClock();
    const processes = standInProcesses(answer);
    const adapter = piAdapterFor(files, { now: clock.now, processes });
    await adapter.poll();
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    files.append(FILE, "\n", { mtimeMs: clock.now() });
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
  });

  test("no sooner when nothing was written since it said none runs", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - MINUTE });
    const clock = handClock();
    const processes = standInProcesses({ ok: true, running: false });
    const adapter = piAdapterFor(files, { now: clock.now, processes });
    await adapter.poll();
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
  });

  test("a clock set back asks again", async () => {
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = piAdapterFor(oneSession(), { now: clock.now, processes });
    await adapter.poll();
    clock.advance(-SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test("on another system says it is not run there", async () => {
    const { health } = await piAdapterFor(memoryFiles(), { platform: "freebsd" }).poll();
    expect(health.watching).toEqual(watching("not found", "not run on this system"));
  });

  test("a check every 2 seconds has no sooner to speak of", async () => {
    const { health } = await piAdapterFor(memoryFiles(), {
      processCheckMs: PROMPT_PROCESS_CHECK_MS,
    }).poll();
    expect(health.watching).toEqual(watching("not found", "every 2 seconds at most"));
  });
});

describe("through the poller", () => {
  function pollerOf(adapter: ReturnType<typeof piAdapterFor>, now: () => number) {
    const events = createEventStore();
    const history = createHistoryStore();
    const poller = createPoller({ adapters: [adapter], events, history, now });
    /** What the Events log holds, oldest first, as each event's kind, session and time. */
    const logged = () =>
      events
        .list()
        .map(({ kind, sessionId, at }) => ({ kind, sessionId, at }))
        .sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
    return { poller, logged };
  }

  test("on Windows a session that leaves the list ends then, not when the next one starts", async () => {
    const files = memoryFiles();
    files.mkdir(PROJECT_FOLDER);
    const clock = handClock();
    const adapter = piAdapterFor(files, {
      now: clock.now,
      platform: "win32",
      processes: undefined,
    });
    const { poller, logged } = pollerOf(adapter, clock.now);
    const first = `pi:${SESSION_ID}`;
    const second = `pi:${sessionIdOf(2)}`;

    await poller.pollOnce();
    clock.advance(SECOND);
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: clock.now() });
    files.touch(PROJECT_FOLDER, clock.now());
    await poller.pollOnce();
    const written = clock.now();

    clock.advance(DAY);
    await poller.pollOnce();
    const left = clock.now();
    expect(logged()).toEqual([
      { kind: "appeared", sessionId: first, at: written },
      { kind: "ended", sessionId: first, at: left },
    ]);

    clock.advance(3 * DAY);
    files.write(sessionPath(sessionIdOf(2)), sessionText(sessionIdOf(2)), {
      mtimeMs: clock.now(),
    });
    await poller.pollOnce();
    expect(logged()).toEqual([
      { kind: "appeared", sessionId: first, at: written },
      { kind: "ended", sessionId: first, at: left },
      { kind: "appeared", sessionId: second, at: clock.now() },
    ]);
  });

  test("on a Mac a session that leaves the list ends then too", async () => {
    const files = oneSession();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    const { poller, logged } = pollerOf(adapter, clock.now);
    await poller.pollOnce();
    clock.advance(DAY);
    await poller.pollOnce();
    expect(logged()).toEqual([{ kind: "ended", sessionId: `pi:${SESSION_ID}`, at: clock.now() }]);
  });

  test("a project folder that cannot be listed once ends none of its sessions", async () => {
    const files = oneSession();
    const clock = handClock();
    let refused = false;
    const io = {
      ...files.io,
      readdir: async (dir: string) => {
        if (refused && dir.endsWith(path.basename(PROJECT_FOLDER))) {
          throw Object.assign(new Error("Refused."), { code: "EMFILE" });
        }
        return files.io.readdir(dir);
      },
    };
    const adapter = piAdapterFor(files, { now: clock.now, io });
    const { poller, logged } = pollerOf(adapter, clock.now);
    await poller.pollOnce();

    refused = true;
    clock.advance(RECHECK_MS);
    const { sessions, sources } = await poller.pollOnce();
    expect(sessions).toHaveLength(1);
    expect(sources[0]?.state).toBe("ok");

    refused = false;
    clock.advance(RECHECK_MS);
    await poller.pollOnce();
    expect(logged()).toEqual([]);
  });
});

describe("what a poll costs", () => {
  test("thousands of old files stay unopened, and a poll looks at few of them", async () => {
    const files = memoryFiles();
    for (let folder = 0; folder < 25; folder += 1) {
      const dir = projectFolderOf(`/Users/example/code/demo-${folder}`);
      for (let n = 0; n < 200; n += 1) {
        const id = sessionIdOf(folder * 1000 + n);
        files.write(sessionPath(id, dir), sessionText(id), { mtimeMs: NOW - 90 * DAY });
      }
    }
    files.write(FILE, sessionText(SESSION_ID));
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });

    expect((await adapter.poll()).sessions).toHaveLength(1);
    expect(files.opened()).toEqual([expect.stringContaining(SESSION_ID)]);

    files.forget();
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toHaveLength(1);
    // The 26 folders and the one file, and nothing opened.
    expect(files.count("lstat")).toBe(27);
    expect(files.count("openRegular")).toBe(0);
    expect(files.reads).toEqual([]);
  });

  test("a file that has not changed is not opened again", async () => {
    const files = oneSession();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.advance(2 * SECOND);
    await adapter.poll();
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(files.count("openRegular")).toBe(1);
  });

  test("a file that left the list is forgotten, and read whole if it comes back", async () => {
    const files = oneSession();
    const clock = handClock();
    const adapter = piAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.advance(DAY + SECOND);
    await adapter.poll();

    files.append(FILE, nameLine("Back"), { mtimeMs: clock.now() });
    clock.advance(MINUTE);
    const { sessions } = await adapter.poll();
    expect(sessions[0].name).toBe("Back");
    expect(files.reads.filter((one) => one.position === 0)).toHaveLength(2);
  });

  test("writes nothing, and holds no file open", async () => {
    const files = oneSession();
    await piAdapterFor(files).poll();
    expect(files.openHandles()).toBe(0);
    expect([...new Set(files.calls.map((call) => call.method))].sort()).toEqual([
      "lstat",
      "openRegular",
      "readdir",
    ]);
  });
});
