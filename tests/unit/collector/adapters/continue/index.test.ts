import { execFile, spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  BASIS,
  CONTINUE_CAPABILITIES,
  CONTINUE_HOME_ENV,
  CONTINUE_OWN_HOME_ENV,
  continueHomeFor,
  RECHECK_MS,
  STATUS_NOTE,
  UNCHECKED_NOTE,
} from "@collector/adapters/continue/index";
import { MAX_INDEX_BYTES } from "@collector/adapters/continue/sessionIndex";
import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller } from "@collector/poller";
import {
  CONTINUE_HOME,
  CREATED_AT,
  DAY,
  entryOf,
  HOME,
  HOUR,
  INDEX,
  indexText,
  MINUTE,
  NOW,
  PRIVATE_ARGUMENTS,
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  PROJECT,
  PROJECT_URI,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  sessionText,
  SESSIONS_DIR,
} from "@tests/fixtures/continue/continue";
import {
  continueAdapterFor,
  filesWith,
  handClock,
  memoryFiles,
} from "@tests/support/adapters/continue/continueAdapter";

// No program is started here. A stand-in for each way the collector starts one
// records whether it was asked to.
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const READ_DETAIL = `Sessions are read from the list Continue keeps in ~/.continue/sessions. ${NOTES}`;

/** The rows Sources shows, for the default folder. */
const watching = (read: string) => [
  { label: "Sessions folder", value: "~/.continue/sessions" },
  { label: "Read", value: read },
];

describe("where it looks", () => {
  test("in ~/.continue, on every system", () => {
    expect(continueHomeFor({}, HOME)).toBe(path.join(HOME, ".continue"));
  });

  test("in the folder Continue's own variable names", () => {
    const folder = path.resolve("/opt/continue");
    expect(continueHomeFor({ [CONTINUE_OWN_HOME_ENV]: folder }, HOME)).toBe(folder);
  });

  test("Agent Lookout's own variable comes first", () => {
    const env = { [CONTINUE_HOME_ENV]: "/tmp/mine", [CONTINUE_OWN_HOME_ENV]: "/opt/continue" };
    expect(continueHomeFor(env, HOME)).toBe(path.resolve("/tmp/mine"));
  });

  test("a relative folder of Continue's cannot be followed, and an empty setting is none", () => {
    expect(continueHomeFor({ [CONTINUE_OWN_HOME_ENV]: "relative/dir" }, HOME)).toBe(
      path.join(HOME, ".continue"),
    );
    expect(continueHomeFor({ [CONTINUE_HOME_ENV]: " ", [CONTINUE_OWN_HOME_ENV]: " " }, HOME)).toBe(
      path.join(HOME, ".continue"),
    );
  });

  test("says so while the first poll runs", () => {
    expect(continueAdapterFor(memoryFiles()).lookingIn).toBe(
      "Looking for Continue sessions in ~/.continue/sessions.",
    );
  });
});

describe("a session", () => {
  test("is listed with its name, folder and status, by a watched source", async () => {
    const { health, sessions, basis } = await continueAdapterFor(filesWith()).poll();
    expect(health).toEqual({
      id: "continue",
      label: "Continue",
      state: "ok",
      detail: READ_DETAIL,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(basis).toBe(BASIS);
    expect(sessions).toEqual([
      {
        id: `continue:${SESSION_ID}`,
        source: "continue",
        surface: "unknown",
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "unknown",
        startedAt: CREATED_AT,
        statusSince: null,
        links: {},
        stale: false,
      },
    ]);
  });

  test("from an editor has its folder from the URI Continue writes", async () => {
    const files = filesWith();
    files.rewrite(INDEX, indexText([entryOf(SESSION_ID, { workspaceDirectory: PROJECT_URI })]));
    const { sessions } = await continueAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({ name: "demo-project", cwd: PROJECT });
  });

  test("with a bad folder and a bad time is still listed, named by its id", async () => {
    const files = filesWith();
    files.rewrite(
      INDEX,
      indexText([entryOf(SESSION_ID, { workspaceDirectory: 7, dateCreated: "soon" })]),
    );
    const { sessions } = await continueAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({
      name: `continue:${SESSION_ID}`,
      cwd: null,
      startedAt: null,
    });
  });

  test("that an entry in the list names but no file holds is not listed", async () => {
    const files = memoryFiles();
    files.write(INDEX, indexText([entryOf(SESSION_ID)]));
    const { health, sessions } = await continueAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(sessions).toEqual([]);
  });

  test("leaves the list when its file is removed", async () => {
    const files = filesWith();
    const adapter = continueAdapterFor(files);
    expect((await adapter.poll()).sessions).toHaveLength(1);
    files.remove(sessionPath(SESSION_ID));
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("leaves the list a day after it was last written", async () => {
    const clock = handClock();
    const files = filesWith();
    const adapter = continueAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    clock.advance(DAY);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("written again a day later comes back within a minute", async () => {
    const clock = handClock();
    const files = filesWith([SESSION_ID], NOW - 2 * DAY);
    const adapter = continueAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);

    files.rewrite(sessionPath(SESSION_ID), sessionText(SESSION_ID), { mtimeMs: NOW + SECOND });
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toEqual([]);
    clock.advance(MINUTE);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });
});

describe("its status", () => {
  test.each(["generated", "calling", "done", "errored", "canceled"])(
    "stays unknown with a tool call written as %s",
    async (status) => {
      const files = filesWith();
      files.rewrite(sessionPath(SESSION_ID), sessionText(SESSION_ID, status));
      const { sessions } = await continueAdapterFor(files).poll();
      expect(sessions[0]).toMatchObject({ status: "unknown", statusSince: null });
      expect(sessions[0]).not.toHaveProperty("waitingReason");
    },
  );

  test("a crash left behind reads as any other session, and never as needing you", async () => {
    // A tool call a crash cut off is `generated` in the file, however long ago that was.
    const clock = handClock();
    const files = filesWith([SESSION_ID], NOW - HOUR);
    const adapter = continueAdapterFor(files, { now: clock.now });
    for (const passed of [0, MINUTE, HOUR, 20 * HOUR]) {
      clock.set(NOW + passed);
      const { sessions } = await adapter.poll();
      expect(sessions[0]).toMatchObject({ status: "unknown", statusSince: null, stale: false });
    }
  });

  test("no session can be said to run, so none has a process or a last write", async () => {
    const { sessions } = await continueAdapterFor(filesWith()).poll();
    for (const absent of ["pid", "alive", "lastWriteAt", "waitingReason", "waitingText"]) {
      expect(sessions[0], absent).not.toHaveProperty(absent);
    }
  });

  test("the capabilities say so", () => {
    for (const row of ["working-and-idle", "needs-you", "finished", "failed"] as const) {
      expect(CONTINUE_CAPABILITIES[row].level, row).toBe("no");
    }
  });
});

describe("what reaches a session", () => {
  test("only the kept fields, and nothing from a title, a prompt, a reply or a tool", async () => {
    const result = await continueAdapterFor(filesWith()).poll();
    const said = JSON.stringify(result);
    for (const word of [PRIVATE_TITLE, PRIVATE_WORDS, PRIVATE_ARGUMENTS, "generated", "usage"]) {
      expect(said).not.toContain(word);
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

  test("the name is never the title", async () => {
    const files = filesWith();
    files.rewrite(INDEX, indexText([entryOf(SESSION_ID, { title: "fix the login page please" })]));
    const { sessions } = await continueAdapterFor(files).poll();
    expect(sessions[0].name).toBe("demo-project");
  });

  test("a session's own file is never opened, and only the list is", async () => {
    const files = filesWith([sessionIdOf(1), sessionIdOf(2)]);
    await continueAdapterFor(files).poll();
    expect(files.opened()).toEqual([INDEX]);
    expect(files.count("readdir")).toBe(0);
  });
});

describe("when Continue is not there", () => {
  test("says so calmly, and looks again only once a minute", async () => {
    const clock = handClock();
    const files = memoryFiles();
    const adapter = continueAdapterFor(files, { now: clock.now });

    const first = await adapter.poll();
    expect(first.health).toEqual({
      id: "continue",
      label: "Continue",
      state: "unavailable",
      detail:
        "Continue was not found: there is no ~/.continue/sessions folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(first.sessions).toEqual([]);
    expect(first.health).not.toHaveProperty("advice");

    files.forget();
    clock.advance(RECHECK_MS - 1);
    await adapter.poll();
    expect(files.calls).toEqual([]);

    clock.advance(1);
    await adapter.poll();
    expect(files.calls).toHaveLength(1);
  });

  test("a clock set back counts as time enough to look again", async () => {
    const clock = handClock();
    const files = memoryFiles();
    const adapter = continueAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(-HOUR);
    await adapter.poll();
    expect(files.calls).toHaveLength(1);
  });

  test("is found once its folder appears", async () => {
    const clock = handClock();
    const files = memoryFiles();
    const adapter = continueAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).health.state).toBe("unavailable");

    files.write(INDEX, indexText([entryOf(SESSION_ID)]), { mtimeMs: NOW });
    files.write(sessionPath(SESSION_ID), sessionText(SESSION_ID), { mtimeMs: NOW });
    clock.advance(RECHECK_MS);
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(1);
  });

  test("a folder that goes means Continue is gone, and it looks again once a minute", async () => {
    const clock = handClock();
    const files = filesWith();
    const adapter = continueAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    files.remove(SESSIONS_DIR);
    clock.advance(SECOND);
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });

  test("a folder named outright is an answer, not a missing Continue", async () => {
    const files = memoryFiles();
    const adapter = continueAdapterFor(files, { env: { [CONTINUE_HOME_ENV]: "/tmp/empty" } });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain(`${CONTINUE_HOME_ENV} is set`);
    expect(health.detail).toContain(STATUS_NOTE);
    expect(health.watching).toContainEqual({ label: "Read", value: "not found" });
    expect(sessions).toEqual([]);

    files.forget();
    await adapter.poll();
    expect(files.calls).toHaveLength(1);
  });

  test("a blank setting of Agent Lookout's names nothing", async () => {
    const { health } = await continueAdapterFor(memoryFiles(), {
      env: { [CONTINUE_HOME_ENV]: " " },
    }).poll();
    expect(health.state).toBe("unavailable");
  });

  test("Continue's own variable at a folder that is not there is a missing Continue", async () => {
    const adapter = continueAdapterFor(memoryFiles(), {
      env: { [CONTINUE_OWN_HOME_ENV]: path.resolve("/opt/continue") },
    });
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });

  test("a folder that goes forgets what was passed over", async () => {
    const clock = handClock();
    const files = filesWith([SESSION_ID], NOW - 2 * DAY);
    const adapter = continueAdapterFor(files, {
      now: clock.now,
      env: { [CONTINUE_HOME_ENV]: CONTINUE_HOME },
    });
    expect((await adapter.poll()).sessions).toEqual([]);
    files.remove(SESSIONS_DIR);
    clock.advance(2 * SECOND);
    await adapter.poll();
    files.write(INDEX, indexText([entryOf(SESSION_ID)]), { mtimeMs: NOW });
    files.write(sessionPath(SESSION_ID), sessionText(SESSION_ID), { mtimeMs: NOW });
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("a list that goes forgets what was passed over", async () => {
    const clock = handClock();
    const files = filesWith([SESSION_ID], NOW - 2 * DAY);
    const adapter = continueAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);
    files.remove(INDEX);
    clock.advance(2 * SECOND);
    await adapter.poll();
    files.write(INDEX, indexText([entryOf(SESSION_ID)]), { mtimeMs: NOW });
    files.rewrite(sessionPath(SESSION_ID), sessionText(SESSION_ID), { mtimeMs: NOW });
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("a folder with no list yet lists nothing, and is watched", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    const { health, sessions } = await continueAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "ok",
      detail: `There is no list of sessions in ~/.continue/sessions yet, so no Continue sessions are listed. ${NOTES}`,
      watching: watching("every 2 seconds"),
    });
    expect(sessions).toEqual([]);
  });

  test("an empty list lists nothing, and is watched", async () => {
    const files = memoryFiles();
    files.write(INDEX, "[]");
    const { health, sessions } = await continueAdapterFor(files).poll();
    expect(health).toMatchObject({ state: "ok", detail: READ_DETAIL });
    expect(sessions).toEqual([]);
  });
});

describe("when something is wrong", () => {
  test("a folder that cannot be looked at is said to be, with no sessions", async () => {
    const files = filesWith();
    files.fail(SESSIONS_DIR);
    const { health, sessions, basis } = await continueAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail:
        "Continue sessions could not be read: the folder ~/.continue/sessions could not be looked at.",
      watching: watching("cannot be read"),
    });
    expect(sessions).toEqual([]);
    expect(basis).toBeUndefined();
  });

  test("a link in place of the folder is not followed, and nothing is opened", async () => {
    const files = memoryFiles();
    files.special(SESSIONS_DIR);
    const { health, sessions } = await continueAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail:
        "Continue sessions could not be read: ~/.continue/sessions is not a folder, and a link is not followed.",
    });
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("a link in place of the list is not opened", async () => {
    const files = memoryFiles();
    files.special(INDEX);
    const { health, sessions } = await continueAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: expect.stringContaining("sessions.json is not an ordinary file"),
    });
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("a link in place of a session's file is not a session", async () => {
    const files = memoryFiles();
    files.write(INDEX, indexText([entryOf(SESSION_ID)]));
    files.special(sessionPath(SESSION_ID));
    const { health, sessions } = await continueAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(sessions).toEqual([]);
  });

  test("a broken list is said to be, with no sessions", async () => {
    const files = memoryFiles();
    files.write(INDEX, "not json");
    const { health, sessions } = await continueAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: expect.stringContaining("sessions.json is not a list Agent Lookout can read"),
    });
    expect(sessions).toEqual([]);
  });

  test("a list of the wrong type is broken too", async () => {
    const files = memoryFiles();
    files.write(INDEX, JSON.stringify({ sessions: [] }));
    expect((await continueAdapterFor(files).poll()).health.state).toBe("error");
  });

  test("a list too long to read is said to be, and is not read", async () => {
    const files = memoryFiles();
    files.write(INDEX, "x".repeat(MAX_INDEX_BYTES + 1));
    const { health, sessions } = await continueAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: expect.stringContaining("is over 8 MiB, the most Agent Lookout reads"),
    });
    expect(sessions).toEqual([]);
    expect(files.reads).toEqual([]);
  });

  test("a list caught half written leaves the sessions as they were for that poll", async () => {
    const clock = handClock();
    const files = filesWith();
    const adapter = continueAdapterFor(files, { now: clock.now });
    const first = await adapter.poll();

    files.rewrite(INDEX, '[\n  {\n    "session', { mtimeMs: NOW + SECOND });
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toEqual(first.sessions);
  });

  test("a poll never throws", async () => {
    const files = filesWith();
    files.failAll("EIO");
    const adapter = continueAdapterFor(files);
    await expect(adapter.poll()).resolves.toMatchObject({
      health: { state: "error" },
      sessions: [],
    });
  });

  test("something unexpected is a sentence, not a throw", async () => {
    let calls = 0;
    const now = () => {
      calls += 1;
      if (calls === 1) throw new Error("A stand-in that throws.");
      return NOW;
    };
    const { health, sessions } = await continueAdapterFor(filesWith(), { now }).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading Continue sessions.",
    });
    expect(sessions).toEqual([]);
  });
});

describe("the cost of a poll", () => {
  const ids = Array.from({ length: 5_000 }, (_, n) => sessionIdOf(n + 10));

  function manyFiles() {
    const files = memoryFiles();
    const entries = [...ids, SESSION_ID].map((id) => entryOf(id));
    files.write(INDEX, indexText(entries), { mtimeMs: NOW - HOUR });
    for (const id of ids) files.write(sessionPath(id), "{}", { mtimeMs: NOW - 30 * DAY });
    files.write(sessionPath(SESSION_ID), sessionText(SESSION_ID), { mtimeMs: NOW - HOUR });
    return files;
  }

  test("with thousands of old sessions, a poll is three looks and opens nothing", async () => {
    const clock = handClock();
    const files = manyFiles();
    const adapter = continueAdapterFor(files, { now: clock.now });
    const first = await adapter.poll();
    expect(first.sessions.map((session) => session.id)).toEqual([`continue:${SESSION_ID}`]);

    files.forget();
    clock.advance(2 * SECOND);
    await adapter.poll();
    // The folder, the list and the one session written lately.
    expect(files.count("lstat")).toBe(3);
    expect(files.calls).toHaveLength(3);
  });

  test("the list is opened once, however many polls read it, until it changes", async () => {
    const clock = handClock();
    const files = manyFiles();
    const adapter = continueAdapterFor(files, { now: clock.now });
    for (let poll = 0; poll < 5; poll += 1) {
      await adapter.poll();
      clock.advance(2 * SECOND);
    }
    expect(files.count("openRegular")).toBe(1);
    expect(files.openHandles()).toBe(0);
  });

  test("no program is run, and the card names none", async () => {
    const { health } = await continueAdapterFor(filesWith()).poll();
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(health.watching?.map((fact) => fact.label)).toEqual(["Sessions folder", "Read"]);
  });
});

describe("through the poller", () => {
  function pollerOf(adapter: ReturnType<typeof continueAdapterFor>, now: () => number) {
    const events = createEventStore();
    const history = createHistoryStore();
    const poller = createPoller({ adapters: [adapter], events, history, now });
    const logged = () => events.list().map(({ kind, sessionId }) => ({ kind, sessionId }));
    return { poller, logged };
  }

  test("a session is in the snapshot, with what its source can report", async () => {
    const clock = handClock();
    const { poller } = pollerOf(continueAdapterFor(filesWith(), { now: clock.now }), clock.now);
    const snapshot = await poller.pollOnce();
    expect(snapshot.sessions.map((session) => session.status)).toEqual(["unknown"]);
    expect(snapshot.sources[0]).toMatchObject({
      id: "continue",
      capabilities: CONTINUE_CAPABILITIES,
    });
  });

  test("a session that stays logs nothing, whatever is written of its tool calls", async () => {
    const clock = handClock();
    const files = filesWith();
    const { poller, logged } = pollerOf(continueAdapterFor(files, { now: clock.now }), clock.now);
    await poller.pollOnce();
    files.rewrite(sessionPath(SESSION_ID), sessionText(SESSION_ID, "calling"));
    clock.advance(2 * SECOND);
    await poller.pollOnce();
    files.rewrite(sessionPath(SESSION_ID), sessionText(SESSION_ID, "generated"));
    clock.advance(2 * SECOND);
    await poller.pollOnce();
    expect(logged()).toEqual([]);
  });

  test("a list caught half written ends no session", async () => {
    const clock = handClock();
    const files = filesWith();
    const { poller, logged } = pollerOf(continueAdapterFor(files, { now: clock.now }), clock.now);
    await poller.pollOnce();
    files.rewrite(INDEX, "", { mtimeMs: NOW + SECOND });
    clock.advance(2 * SECOND);
    const snapshot = await poller.pollOnce();
    expect(snapshot.sessions).toHaveLength(1);
    expect(logged()).toEqual([]);
  });

  test("a session whose file goes is logged as ended", async () => {
    const clock = handClock();
    const files = filesWith();
    const { poller, logged } = pollerOf(continueAdapterFor(files, { now: clock.now }), clock.now);
    await poller.pollOnce();
    files.remove(sessionPath(SESSION_ID));
    clock.advance(2 * SECOND);
    await poller.pollOnce();
    expect(logged().map((event) => event.kind)).toContain("ended");
  });
});
