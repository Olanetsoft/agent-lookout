import { describe, expect, test } from "vitest";

import {
  BASIS,
  CODEX_HOME_ENV,
  CODEX_OWN_HOME_ENV,
  NEEDS_YOU_NOTE,
  OLDER_CODEX_NOTE,
  RECHECK_MS,
} from "@collector/adapters/codex/index";
import type { CodexIo } from "@collector/adapters/codex/io";
import { INDEX_PROMPT_REFRESH_MS, INDEX_REFRESH_MS } from "@collector/adapters/codex/rollouts";
import { FINISHED_RETENTION_MS } from "@core/retention";
import {
  CODEX_HOME,
  DAY,
  eventLine,
  ids,
  indexLine,
  lockPath,
  messageLine,
  metaLine,
  MINUTE,
  NOW,
  revertedRolloutId,
  rollout,
  rolloutName,
  rolloutPath,
  threadId,
  turnLine,
} from "@tests/fixtures/codex";
import {
  codexAdapterFor,
  handClock,
  healthy,
  memoryFiles,
  noLockFolder,
  watching,
  type MemoryFiles,
} from "@tests/support/codexAdapter";

const SESSIONS = `${CODEX_HOME}/sessions`;
const LOCKS = `${CODEX_HOME}/thread-writer-locks`;
const INDEX = `${CODEX_HOME}/session_index.jsonl`;

const NOT_INSTALLED =
  "Codex was not found: there is no ~/.codex folder. Agent Lookout looks again every minute.";

interface SessionFile {
  thread: string;
  /** The local time in the file's name, which also gives its day folder. */
  created?: string;
  lines: string[];
  lock?: boolean;
  home?: string;
  mtimeMs?: number;
  rolloutId?: string;
}

/** Writes one session's file, and its lock when it is open. Returns the file's path. */
function addSession(files: MemoryFiles, session: SessionFile): string {
  const home = session.home ?? CODEX_HOME;
  const file = rolloutPath(
    home,
    session.created ?? "2026-10-01T09-00-00",
    session.thread,
    session.rolloutId,
  );
  files.write(file, rollout(...session.lines), { mtimeMs: session.mtimeMs });
  if (session.lock) files.write(lockPath(home, session.thread), "");
  return file;
}

/** A Codex folder with its sessions folder and its folder of locks, and nothing in them. */
function emptyCodex(home = CODEX_HOME): MemoryFiles {
  const files = memoryFiles();
  files.mkdir(`${home}/sessions`);
  files.mkdir(`${home}/thread-writer-locks`);
  return files;
}

/** A session that started an hour ago, in /Users/example/code/<folder>, with these turns. */
function linesFor(
  folder: string,
  thread: string,
  turns: [number, string][],
  source: unknown = "cli",
) {
  return [
    metaLine(NOW - 60 * MINUTE, { id: thread, cwd: `/Users/example/code/${folder}`, source }),
    ...turns.map(([time, type]) => turnLine(time, type)),
  ];
}

const statuses = (sessions: { id: string; status: string }[]) =>
  Object.fromEntries(sessions.map((session) => [session.id.replace("codex:", ""), session.status]));

describe("when Codex is not on this computer", () => {
  test("it says so calmly, with no advice, after a single look", async () => {
    const files = memoryFiles();
    const result = await codexAdapterFor(files).poll();

    expect(result).toEqual({
      health: {
        id: "codex",
        label: "Codex",
        state: "unavailable",
        detail: NOT_INSTALLED,
        watching: watching("~/.codex", "not found"),
        checkedAt: NOW,
      },
      sessions: [],
    });
    expect(result.health).not.toHaveProperty("advice");
    expect(result.health.detail).not.toMatch(/install/i);
    expect(files.calls).toEqual([{ method: "stat", path: CODEX_HOME }]);
  });

  test("the polls in between cost nothing, and it looks again once a minute with one stat", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();

    for (const after of [2_000, 30_000, RECHECK_MS - 1]) {
      clock.set(NOW + after);
      const { health } = await adapter.poll();
      expect(health).toMatchObject({
        state: "unavailable",
        detail: NOT_INSTALLED,
        checkedAt: NOW + after,
      });
    }
    expect(files.calls).toEqual([]);

    clock.set(NOW + RECHECK_MS);
    await adapter.poll();
    expect(files.calls).toEqual([{ method: "stat", path: CODEX_HOME }]);

    files.forget();
    clock.set(NOW + RECHECK_MS + 2_000);
    await adapter.poll();
    clock.set(NOW + 2 * RECHECK_MS);
    await adapter.poll();
    expect(files.calls).toEqual([{ method: "stat", path: CODEX_HOME }]);
  });

  test("how long it waits can be set, and is said in the detail", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now, recheckMs: 10_000 });
    expect((await adapter.poll()).health.detail).toBe(
      "Codex was not found: there is no ~/.codex folder. Agent Lookout looks again every 10 seconds.",
    );
    clock.set(NOW + 10_000);
    await adapter.poll();
    expect(files.count("stat")).toBe(2);
  });

  test("a clock that has been set back looks again", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });
    await adapter.poll();
    clock.set(NOW - 1_000);
    await adapter.poll();
    expect(files.count("stat")).toBe(2);
  });

  test("once Codex's folder appears, it is found at the next look", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });
    await adapter.poll();

    addSession(files, {
      thread: ids.working,
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      lock: true,
    });
    clock.set(NOW + 2_000);
    expect((await adapter.poll()).health.state).toBe("unavailable");

    clock.set(NOW + RECHECK_MS);
    const found = await adapter.poll();
    expect(found.health).toMatchObject({ state: "ok", detail: healthy() });
    expect(found.basis).toBe(BASIS);
    expect(statuses(found.sessions)).toEqual({ [ids.working]: "working" });
  });

  test("if Codex's folder goes away later, it is not found again, and the polls after cost nothing", async () => {
    const files = emptyCodex();
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).health.state).toBe("ok");

    files.remove(CODEX_HOME);
    files.forget();
    clock.set(NOW + 2_000);
    const gone = await adapter.poll();
    expect(gone.health).toMatchObject({ state: "unavailable", detail: NOT_INSTALLED });
    expect(gone).not.toHaveProperty("basis");
    expect(files.calls).toEqual([
      { method: "readdir", path: SESSIONS },
      { method: "stat", path: CODEX_HOME },
    ]);

    files.forget();
    clock.set(NOW + 4_000);
    await adapter.poll();
    expect(files.calls).toEqual([]);
  });

  test("a file where Codex's folder would be is not Codex", async () => {
    const files = memoryFiles();
    files.write(CODEX_HOME, "not a folder");
    expect((await codexAdapterFor(files).poll()).health).toMatchObject({
      state: "unavailable",
      detail: NOT_INSTALLED,
    });
  });
});

describe("where it looks", () => {
  test("Codex's own CODEX_HOME is used when it is set", async () => {
    const elsewhere = "/Volumes/work/codex";
    const files = emptyCodex(elsewhere);
    addSession(files, {
      home: elsewhere,
      thread: ids.working,
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      lock: true,
    });
    const adapter = codexAdapterFor(files, { env: { [CODEX_OWN_HOME_ENV]: elsewhere } });
    const { health, sessions } = await adapter.poll();

    expect(health.watching).toEqual(watching(elsewhere, "every 2 seconds"));
    expect(health.detail).toBe(healthy(`${elsewhere}/sessions`));
    expect(sessions.map((session) => session.id)).toEqual([`codex:${ids.working}`]);
    expect(adapter.lookingIn).toBe(`Looking for Codex sessions in ${elsewhere}/sessions.`);
    expect(files.count(undefined, (target) => target.startsWith(CODEX_HOME))).toBe(0);
  });

  test("a CODEX_HOME with no folder there is Codex not found, and says which setting named it", async () => {
    const files = memoryFiles();
    const result = await codexAdapterFor(files, {
      env: { [CODEX_OWN_HOME_ENV]: "/Volumes/work/codex" },
    }).poll();
    expect(result.health).toMatchObject({
      state: "unavailable",
      detail:
        "Codex was not found: CODEX_HOME is set to /Volumes/work/codex, and there is no folder there. Agent Lookout looks again every minute.",
    });
    expect(result.health).not.toHaveProperty("advice");
  });

  test("AGENT_LOOKOUT_CODEX_HOME wins over CODEX_HOME", async () => {
    const ours = "/Users/example/codex-copy";
    const theirs = "/Volumes/work/codex";
    const files = emptyCodex(ours);
    addSession(files, {
      home: ours,
      thread: ids.idle,
      lines: linesFor("demo-api", ids.idle, [[NOW - MINUTE, "task_complete"]]),
      lock: true,
    });
    addSession(files, {
      home: theirs,
      thread: ids.working,
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      lock: true,
    });
    const { health, sessions } = await codexAdapterFor(files, {
      env: { [CODEX_HOME_ENV]: ours, [CODEX_OWN_HOME_ENV]: theirs },
    }).poll();

    expect(health.watching).toEqual(watching("~/codex-copy", "every 2 seconds"));
    expect(statuses(sessions)).toEqual({ [ids.idle]: "idle" });
    expect(files.count(undefined, (target) => target.startsWith(theirs))).toBe(0);
  });

  test.each([
    ["is not there", (_files: MemoryFiles) => {}],
    ["has no sessions folder", (files: MemoryFiles) => files.mkdir("/Users/example/codex-empty")],
  ])(
    "AGENT_LOOKOUT_CODEX_HOME naming a folder that %s is an answer: watched, with no sessions",
    async (_what, prepare) => {
      const files = memoryFiles();
      prepare(files);
      const clock = handClock();
      const adapter = codexAdapterFor(files, {
        env: { [CODEX_HOME_ENV]: "/Users/example/codex-empty" },
        now: clock.now,
      });
      const result = await adapter.poll();

      expect(result).toEqual({
        health: {
          id: "codex",
          label: "Codex",
          state: "ok",
          detail: `AGENT_LOOKOUT_CODEX_HOME is set to ~/codex-empty, which has no sessions folder, so no Codex sessions are listed. ${NEEDS_YOU_NOTE}`,
          watching: watching("~/codex-empty", "not found"),
          checkedAt: NOW,
        },
        sessions: [],
        basis: "files",
      });
      // Not "Codex not found", so not left alone for a minute either: sessions show at once.
      addSession(files, {
        home: "/Users/example/codex-empty",
        thread: ids.working,
        lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      });
      clock.set(NOW + 2_000);
      expect((await adapter.poll()).sessions).toHaveLength(1);
    },
  );

  test("a setting made only of spaces is not a setting", async () => {
    const files = memoryFiles();
    const { health } = await codexAdapterFor(files, {
      env: { [CODEX_HOME_ENV]: "  ", [CODEX_OWN_HOME_ENV]: "" },
    }).poll();
    expect(health).toMatchObject({ state: "unavailable", detail: NOT_INSTALLED });
  });

  test("a Codex folder with no sessions folder yet is watched, and says so", async () => {
    const files = memoryFiles();
    files.mkdir(CODEX_HOME);
    const result = await codexAdapterFor(files).poll();
    expect(result).toMatchObject({
      health: {
        state: "ok",
        detail: `Codex has not saved any sessions in ~/.codex/sessions yet. ${NEEDS_YOU_NOTE}`,
        watching: watching("~/.codex", "not found"),
      },
      sessions: [],
      basis: "files",
    });
  });
});

describe("when Codex cannot be read", () => {
  test("a sessions folder that cannot be listed is an error that names the folder", async () => {
    const files = emptyCodex();
    files.fail(SESSIONS, "EACCES");
    const result = await codexAdapterFor(files).poll();
    expect(result).toEqual({
      health: {
        id: "codex",
        label: "Codex",
        state: "error",
        detail:
          "Codex sessions could not be read: the folder ~/.codex/sessions could not be listed.",
        watching: watching("~/.codex", "cannot be read"),
        checkedAt: NOW,
      },
      sessions: [],
    });
  });

  test.each(["EACCES", "EIO", "EMFILE"])(
    "every call failing with %s still gets an answer",
    async (code) => {
      const files = emptyCodex();
      files.failAll(code);
      const result = await codexAdapterFor(files).poll();
      expect(result.health.state).toBe("error");
      expect(result.sessions).toEqual([]);
    },
  );

  test("a stand-in that throws or answers nonsense still gets a sentence, never a rejection", async () => {
    const broken: CodexIo = {
      readdir: async (dir) =>
        dir.endsWith("thread-writer-locks") ? (null as unknown as string[]) : [],
      stat: async () => ({ kind: "directory", size: 0, mtimeMs: 0, ino: 1 }),
      lstat: () => {
        throw new TypeError("not a promise");
      },
      openRegular: () => {
        throw new TypeError("not a promise");
      },
    };
    const result = await codexAdapterFor(memoryFiles(), { io: broken }).poll();
    expect(result.health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading Codex sessions.",
      checkedAt: NOW,
    });
    expect(result.health.detail).not.toMatch(/TypeError|at \w/);

    const throwing: CodexIo = {
      readdir: () => {
        throw new TypeError("thrown, not rejected");
      },
      stat: () => {
        throw new TypeError("thrown, not rejected");
      },
      lstat: () => {
        throw new TypeError("thrown, not rejected");
      },
      openRegular: () => {
        throw new TypeError("thrown, not rejected");
      },
    };
    await expect(codexAdapterFor(memoryFiles(), { io: throwing }).poll()).resolves.toMatchObject({
      health: { state: "error" },
      sessions: [],
    });
  });

  test("a folder of locks that cannot be listed is said, and no session is shown as finished", async () => {
    const files = emptyCodex();
    addSession(files, {
      thread: ids.finished,
      lines: linesFor("demo-docs", ids.finished, [[NOW - MINUTE, "task_complete"]]),
    });
    files.fail(LOCKS, "EACCES");
    const { health, sessions } = await codexAdapterFor(files).poll();
    expect(health.detail).toBe(
      `${healthy()} The list of open sessions at ~/.codex/thread-writer-locks could not be read, so a session that has ended cannot be told from one that is idle, and none is shown as finished.`,
    );
    expect(statuses(sessions)).toEqual({ [ids.finished]: "idle" });
  });

  test("one session file that cannot be opened does not keep the others from being listed", async () => {
    const files = emptyCodex();
    const broken = addSession(files, {
      thread: ids.working,
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      lock: true,
    });
    addSession(files, {
      thread: ids.idle,
      created: "2026-10-01T10-00-00",
      lines: linesFor("demo-api", ids.idle, [[NOW - MINUTE, "task_complete"]]),
      lock: true,
    });
    files.fail(broken, "EACCES");
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });
    const first = await adapter.poll();
    expect(first.health.state).toBe("ok");
    expect(statuses(first.sessions)[ids.idle]).toBe("idle");

    files.heal(broken);
    clock.set(NOW + 2_000);
    expect(statuses((await adapter.poll()).sessions)).toEqual({
      [ids.working]: "working",
      [ids.idle]: "idle",
    });
  });
});

describe("when Codex is read", () => {
  test("it says what it reads and how often, and that a wait for approval shows as working", async () => {
    const adapter = codexAdapterFor(emptyCodex());
    const result = await adapter.poll();
    expect(result).toEqual({
      health: {
        id: "codex",
        label: "Codex",
        state: "ok",
        detail: healthy(),
        watching: watching("~/.codex", "every 2 seconds"),
        checkedAt: NOW,
      },
      sessions: [],
      basis: "files",
    });
    expect(adapter).toMatchObject({
      id: "codex",
      label: "Codex",
      lookingIn: "Looking for Codex sessions in ~/.codex/sessions.",
    });
    expect(NEEDS_YOU_NOTE).toBe(
      "Codex's session files do not record when it is waiting for your approval, so a Codex session that is waiting for you shows as working.",
    );
  });

  test.each([
    [1_000, "every second"],
    [5_000, "every 5 seconds"],
    [60_000, "every minute"],
  ])("polled every %i ms, it says it reads %s", async (pollIntervalMs, read) => {
    const { health } = await codexAdapterFor(emptyCodex(), { pollIntervalMs }).poll();
    expect(health.watching?.find((fact) => fact.label === "Read")?.value).toBe(read);
  });

  test("each session's status comes from its last turn line and its lock, and none needs you", async () => {
    const files = emptyCodex();
    const cases: [string, [number, string][], boolean, string][] = [
      [
        "c1",
        [
          [NOW - 5 * MINUTE, "task_complete"],
          [NOW - MINUTE, "task_started"],
        ],
        true,
        "working",
      ],
      ["d1", [[NOW - MINUTE, "turn_started"]], true, "working"],
      [
        "c2",
        [
          [NOW - 5 * MINUTE, "task_started"],
          [NOW - MINUTE, "task_complete"],
        ],
        true,
        "idle",
      ],
      ["d2", [[NOW - MINUTE, "turn_complete"]], true, "idle"],
      ["c4", [[NOW - MINUTE, "turn_aborted"]], true, "idle"],
      ["c8", [], true, "idle"],
      ["c3", [[NOW - MINUTE, "task_complete"]], false, "finished"],
      ["d3", [[NOW - MINUTE, "task_started"]], false, "finished"],
      ["d4", [], false, "finished"],
      ["d5", [[NOW - MINUTE, "turn_paused"]], true, "unknown"],
      ["d6", [[NOW - MINUTE, "turn_paused"]], false, "unknown"],
    ];
    for (const [suffix, turns, lock] of cases) {
      const thread = threadId(suffix);
      addSession(files, { thread, lines: linesFor(`demo-${suffix}`, thread, turns), lock });
    }
    // Lines that are not turn lines change nothing.
    files.append(
      rolloutPath(CODEX_HOME, "2026-10-01T09-00-00", threadId("c2")),
      rollout(messageLine(NOW - 30_000)),
    );

    const { sessions } = await codexAdapterFor(files).poll();
    expect(statuses(sessions)).toEqual(
      Object.fromEntries(cases.map(([suffix, , , status]) => [threadId(suffix), status])),
    );
    for (const session of sessions) {
      expect(session.status).not.toBe("needs-you");
      expect(session).toMatchObject({ source: "codex", links: {} });
      expect(session).not.toHaveProperty("pid");
      expect(session).not.toHaveProperty("alive");
    }
  });

  test("a session in full: its id, name, folder, app and times", async () => {
    const files = emptyCodex();
    addSession(files, {
      thread: ids.working,
      lines: [
        metaLine(NOW - 60 * MINUTE, {
          id: ids.working,
          cwd: "/Users/example/code/demo",
          source: "vscode",
        }),
        turnLine(NOW - 50 * MINUTE, "task_started"),
        turnLine(NOW - 40 * MINUTE, "task_complete"),
        messageLine(NOW - 3 * MINUTE),
        turnLine(NOW - 3 * MINUTE, "task_started"),
        messageLine(NOW - MINUTE, "A reply.", "assistant"),
      ],
      lock: true,
    });
    const { sessions } = await codexAdapterFor(files).poll();
    expect(sessions).toEqual([
      {
        id: `codex:${ids.working}`,
        source: "codex",
        surface: "vscode",
        name: "demo",
        cwd: "/Users/example/code/demo",
        project: "demo",
        status: "working",
        startedAt: NOW - 60 * MINUTE,
        statusSince: NOW - 3 * MINUTE,
        links: {},
        stale: false,
      },
    ]);
  });

  test("names come from Codex's names file, the newest for each session", async () => {
    const files = emptyCodex();
    addSession(files, {
      thread: ids.working,
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      lock: true,
    });
    addSession(files, {
      thread: ids.idle,
      created: "2026-10-01T10-00-00",
      lines: linesFor("demo-api", ids.idle, [[NOW - MINUTE, "task_complete"]]),
      lock: true,
    });
    files.write(
      INDEX,
      rollout(
        indexLine(ids.working, "first-try"),
        "not json",
        indexLine(ids.working, "demo-project"),
      ),
    );
    const { sessions } = await codexAdapterFor(files).poll();
    expect(sessions.map((session) => session.name)).toEqual(["demo-project", "demo-api"]);
  });

  test("with no folder of locks, as with Codex before 0.155, it says so and shows nothing as finished", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS);
    addSession(files, {
      thread: ids.finished,
      lines: linesFor("demo-docs", ids.finished, [[NOW - MINUTE, "task_complete"]]),
    });
    addSession(files, {
      thread: ids.working,
      created: "2026-10-01T10-00-00",
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
    });
    const { health, sessions } = await codexAdapterFor(files).poll();
    expect(health.detail).toBe(`${healthy()}${noLockFolder()}`);
    expect(statuses(sessions)).toEqual({ [ids.finished]: "idle", [ids.working]: "working" });
  });

  test("helpers and threads run for other programs are left out", async () => {
    const files = emptyCodex();
    const helper = (suffix: string, payload: Record<string, unknown>) =>
      addSession(files, {
        thread: threadId(suffix),
        lines: [
          metaLine(NOW - 10 * MINUTE, { id: threadId(suffix), ...payload }),
          turnLine(NOW - MINUTE, "task_started"),
        ],
        lock: true,
      });
    helper("e1", {
      source: { subagent: { thread_spawn: { depth: 1 } } },
      parent_thread_id: ids.working,
    });
    helper("e2", { source: "mcp" });
    helper("e3", { source: { internal: "memory_consolidation" } });
    helper("e4", { source: "cli", parent_thread_id: ids.working });
    helper("e5", { source: "cli", thread_source: "guardian_review" });
    helper("e6", { source: "exec" });
    helper("e7", { source: { custom: "chatgpt" } });

    const { sessions } = await codexAdapterFor(files).poll();
    expect(sessions.map((session) => [session.id, session.surface])).toEqual([
      [`codex:${threadId("e6")}`, "terminal"],
      [`codex:${threadId("e7")}`, "desktop"],
    ]);
  });

  test("compressed, archived and oddly named files are never opened", async () => {
    const files = emptyCodex();
    const day = `${SESSIONS}/2026/10/01`;
    const body = rollout(...linesFor("demo", ids.compressed, [[NOW - MINUTE, "task_started"]]));
    files.write(`${day}/${rolloutName("2026-10-01T06-00-00", ids.compressed)}.zst`, body);
    files.write(`${day}/rollout-latest.jsonl`, body);
    files.write(
      `${CODEX_HOME}/archived_sessions/${rolloutName("2026-10-01T06-00-00", ids.archived)}`,
      body,
    );
    files.write(`${CODEX_HOME}/history.jsonl`, body);
    files.write(lockPath(CODEX_HOME, ids.archived), "");

    const { sessions } = await codexAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
    expect(files.count(undefined, (target) => target.includes("archived_sessions"))).toBe(0);
    expect(files.count(undefined, (target) => target.endsWith("history.jsonl"))).toBe(0);
  });

  test("a link or a pipe named like a session file is never opened", async () => {
    const files = emptyCodex();
    const link = rolloutPath(CODEX_HOME, "2026-10-01T09-00-00", ids.working);
    files.special(link);
    files.write(lockPath(CODEX_HOME, ids.working), "");
    const { health, sessions } = await codexAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("lock files are listed, never opened or looked at one by one", async () => {
    const files = emptyCodex();
    addSession(files, {
      thread: ids.working,
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      lock: true,
    });
    files.write(`${LOCKS}/.coordination.lock`, "");
    await codexAdapterFor(files).poll();
    expect(files.calls.filter((call) => call.path.startsWith(LOCKS))).toEqual([
      { method: "readdir", path: LOCKS },
    ]);
  });
});

describe("sessions written by other Codex apps and versions", () => {
  test("the Codex desktop app's sessions are shown as the desktop app, though they record vscode", async () => {
    const files = emptyCodex();
    const desktop = threadId("e1");
    const extension = threadId("e2");
    addSession(files, {
      thread: desktop,
      lines: [
        metaLine(NOW - 60 * MINUTE, {
          id: desktop,
          cwd: "/Users/example/code/demo-app",
          source: "vscode",
          originator: "Codex Desktop",
        }),
        turnLine(NOW - MINUTE, "task_complete"),
      ],
      lock: true,
    });
    addSession(files, {
      thread: extension,
      created: "2026-10-01T10-00-00",
      lines: [
        metaLine(NOW - 60 * MINUTE, {
          id: extension,
          cwd: "/Users/example/code/demo-ext",
          source: "vscode",
          originator: "codex_vscode",
        }),
        turnLine(NOW - MINUTE, "task_complete"),
      ],
      lock: true,
    });
    const { sessions } = await codexAdapterFor(files).poll();
    expect(
      Object.fromEntries(sessions.map((session) => [session.project, session.surface])),
    ).toEqual({ "demo-app": "desktop", "demo-ext": "vscode" });
  });

  test("a session made by a Codex older than 0.155 is not called finished for having no lock", async () => {
    const files = emptyCodex();
    // Only the folder's own lock: no session is open.
    files.write(`${LOCKS}/.coordination.lock`, "");
    const old = threadId("e3");
    const current = threadId("e4");
    const sessionOf = (thread: string, folder: string, version: string, created: string) =>
      addSession(files, {
        thread,
        created,
        lines: [
          metaLine(NOW - 60 * MINUTE, {
            id: thread,
            cwd: `/Users/example/code/${folder}`,
            cli_version: version,
          }),
          turnLine(NOW - MINUTE, "task_started"),
        ],
      });
    sessionOf(old, "demo-old", "0.150.0", "2026-10-01T09-00-00");
    sessionOf(current, "demo-new", "0.160.0", "2026-10-01T10-00-00");

    const { health, sessions } = await codexAdapterFor(files).poll();
    // The older Codex never writes a lock, so its missing lock says nothing:
    // it is in the middle of a turn. The newer one's missing lock means it ended.
    expect(statuses(sessions)).toEqual({ [old]: "working", [current]: "finished" });
    expect(health.detail).toBe(`${healthy()} ${OLDER_CODEX_NOTE}`);
    expect(OLDER_CODEX_NOTE).toBe(
      "Some sessions were started by a Codex older than 0.155, which does not record which sessions are open, so those are never shown as finished.",
    );
  });

  test("with every session from a Codex that keeps locks, nothing more is said", async () => {
    const files = emptyCodex();
    addSession(files, {
      thread: ids.finished,
      lines: linesFor("demo-docs", ids.finished, [[NOW - MINUTE, "task_complete"]]),
    });
    const { health, sessions } = await codexAdapterFor(files).poll();
    expect(statuses(sessions)).toEqual({ [ids.finished]: "finished" });
    expect(health.detail).toBe(healthy());
  });

  test("an older Codex's open session is still open by its lock, if a newer Codex resumed it", async () => {
    const files = emptyCodex();
    const old = threadId("e5");
    addSession(files, {
      thread: old,
      lines: [
        metaLine(NOW - 60 * MINUTE, {
          id: old,
          cwd: "/Users/example/code/demo-old",
          cli_version: "0.150.0",
        }),
        turnLine(NOW - MINUTE, "task_complete"),
      ],
      lock: true,
    });
    const { health, sessions } = await codexAdapterFor(files).poll();
    expect(statuses(sessions)).toEqual({ [old]: "idle" });
    expect(health.detail).toBe(healthy());
  });

  describe("another agent's sessions, imported by the Codex desktop app", () => {
    const imported = threadId("e6");
    const importedTurn = (n: number) => ({ turn_id: `external-import-turn-${n}` });
    /** An imported session as Codex writes one: every line stamped with the time of the import. */
    const importedLines = (time: number) => [
      metaLine(time, {
        id: imported,
        cwd: "/Users/example/code/demo-imported",
        source: "vscode",
        originator: "Codex Desktop",
        creator_user_id: undefined,
        creator_account_id: undefined,
      }),
      turnLine(time, "task_started", importedTurn(1)),
      messageLine(time),
      turnLine(time, "task_complete", importedTurn(1)),
      turnLine(time, "task_started", importedTurn(2)),
      messageLine(time),
      eventLine(time, "agent_message"),
      eventLine(time, "token_count"),
      turnLine(time, "task_complete", importedTurn(2)),
    ];

    test("are not listed: they did not run in Codex", async () => {
      const files = emptyCodex();
      addSession(files, { thread: imported, lines: importedLines(NOW - 2 * MINUTE) });
      addSession(files, {
        thread: ids.idle,
        created: "2026-10-01T10-00-00",
        lines: linesFor("demo-api", ids.idle, [[NOW - MINUTE, "task_complete"]]),
        lock: true,
      });
      const { sessions } = await codexAdapterFor(files).poll();
      expect(statuses(sessions)).toEqual({ [ids.idle]: "idle" });
    });

    test("are not listed while the app has one open either", async () => {
      const files = emptyCodex();
      addSession(files, { thread: imported, lines: importedLines(NOW - 2 * MINUTE), lock: true });
      const { sessions } = await codexAdapterFor(files).poll();
      expect(sessions).toEqual([]);
    });

    test("one is listed from the moment Codex runs a turn in it", async () => {
      const files = emptyCodex();
      const clock = handClock();
      const file = addSession(files, {
        thread: imported,
        lines: importedLines(NOW - 2 * MINUTE),
        lock: true,
      });
      const adapter = codexAdapterFor(files, { now: clock.now });
      expect((await adapter.poll()).sessions).toEqual([]);

      clock.advance(2_000);
      files.append(file, rollout(turnLine(NOW + 1_000, "task_started")));
      const { sessions } = await adapter.poll();
      expect(sessions).toMatchObject([
        {
          id: `codex:${imported}`,
          surface: "desktop",
          status: "working",
          statusSince: NOW + 1_000,
        },
      ]);
    });
  });
});

describe("which sessions are listed, and for how long", () => {
  test("a session no Codex has open is listed for 24 hours after its last line", async () => {
    const listedAt = (lastLine: number) => {
      const files = emptyCodex();
      addSession(files, {
        thread: ids.finished,
        lines: [
          metaLine(lastLine - MINUTE, { id: ids.finished, cwd: "/Users/example/code/demo-docs" }),
          turnLine(lastLine, "task_complete"),
        ],
      });
      return codexAdapterFor(files).poll();
    };
    const recent = await listedAt(NOW - FINISHED_RETENTION_MS + 1);
    expect(recent.sessions).toMatchObject([
      { status: "finished", statusSince: NOW - FINISHED_RETENTION_MS + 1 },
    ]);
    expect((await listedAt(NOW - FINISHED_RETENTION_MS)).sessions).toEqual([]);
  });

  test("a session no Codex has open whose file was not written for a day is not even opened", async () => {
    const files = emptyCodex();
    addSession(files, {
      thread: ids.finished,
      lines: linesFor("demo-docs", ids.finished, [[NOW - MINUTE, "task_complete"]]),
      mtimeMs: NOW - FINISHED_RETENTION_MS - 1,
    });
    expect((await codexAdapterFor(files).poll()).sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("a session Codex has open is listed however old it is, and goes stale after a day idle", async () => {
    const files = emptyCodex();
    addSession(files, {
      thread: ids.idle,
      created: "2026-09-20T08-00-00",
      lines: [
        metaLine(NOW - 11 * DAY, {
          id: ids.idle,
          cwd: "/Users/example/code/demo-api",
          source: "vscode",
        }),
        turnLine(NOW - 11 * DAY, "task_started"),
        turnLine(NOW - 10 * DAY, "task_complete"),
      ],
      mtimeMs: NOW - 10 * DAY,
      lock: true,
    });
    const { sessions } = await codexAdapterFor(files).poll();
    expect(sessions).toMatchObject([
      { id: `codex:${ids.idle}`, status: "idle", statusSince: NOW - 10 * DAY, stale: true },
    ]);
  });

  test("a reverted session is one session, shown from the file written to last", async () => {
    for (const newer of ["original", "revert"] as const) {
      const files = emptyCodex();
      addSession(files, {
        thread: ids.reverted,
        created: "2026-10-01T07-00-00",
        lines: linesFor("demo-jobs", ids.reverted, [
          [NOW - 50 * MINUTE, "task_started"],
          [newer === "original" ? NOW - MINUTE : NOW - 40 * MINUTE, "task_complete"],
        ]),
        lock: true,
      });
      addSession(files, {
        thread: ids.reverted,
        created: "2026-10-01T10-30-00",
        rolloutId: revertedRolloutId,
        lines: linesFor("demo-jobs", ids.reverted, [
          [newer === "revert" ? NOW - MINUTE : NOW - 30 * MINUTE, "task_started"],
        ]),
      });
      const { sessions } = await codexAdapterFor(files).poll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: `codex:${ids.reverted}`,
        status: newer === "original" ? "idle" : "working",
        statusSince: NOW - MINUTE,
      });
    }
  });

  /** How many times every day folder was listed. */
  const listings = (files: MemoryFiles) =>
    files.count("readdir", (dir) => dir === `${SESSIONS}/2026`);

  test("a resumed session in an older folder is found through its lock, stays finished for a day after, then goes", async () => {
    const files = emptyCodex();
    const lastLine = NOW - 10 * MINUTE;
    addSession(files, {
      thread: ids.resumed,
      created: "2026-09-20T08-00-00",
      lines: [
        metaLine(Date.parse("2026-09-20T08:00:00.000Z"), {
          id: ids.resumed,
          cwd: "/Users/example/code/demo-cli",
        }),
        turnLine(Date.parse("2026-09-20T08:30:00.000Z"), "task_complete"),
        turnLine(lastLine, "task_started"),
      ],
      lock: true,
    });
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });

    const first = await adapter.poll();
    expect(first.sessions).toMatchObject([
      {
        id: `codex:${ids.resumed}`,
        status: "working",
        startedAt: Date.parse("2026-09-20T08:00:00.000Z"),
      },
    ]);
    expect(listings(files)).toBe(1);

    // Found once, it is kept: the folders are not all listed again.
    for (const after of [2_000, 4_000, INDEX_REFRESH_MS + 2_000]) {
      clock.set(NOW + after);
      expect(statuses((await adapter.poll()).sessions)).toEqual({ [ids.resumed]: "working" });
    }
    expect(listings(files)).toBe(1);

    files.remove(lockPath(CODEX_HOME, ids.resumed));
    clock.set(lastLine + FINISHED_RETENTION_MS - 1);
    expect((await adapter.poll()).sessions).toMatchObject([
      { id: `codex:${ids.resumed}`, status: "finished", statusSince: lastLine },
    ]);

    clock.set(lastLine + FINISHED_RETENTION_MS);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(listings(files)).toBe(1);
  });

  test("an open session with no file yet lists every folder at most every 30 seconds, sooner for a new one", async () => {
    const files = emptyCodex();
    files.write(`${SESSIONS}/2026/09/20/.keep`, "");
    // Codex makes the lock when a session opens, and the file only at its first turn.
    files.write(lockPath(CODEX_HOME, threadId("e1")), "");
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });

    await adapter.poll();
    expect(listings(files)).toBe(1);
    for (let after = 2_000; after < INDEX_REFRESH_MS; after += 2_000) {
      clock.set(NOW + after);
      await adapter.poll();
    }
    expect(listings(files)).toBe(1);
    clock.set(NOW + INDEX_REFRESH_MS);
    await adapter.poll();
    expect(listings(files)).toBe(2);

    // A second session opens two seconds later: listed again once the shorter wait has passed.
    files.write(lockPath(CODEX_HOME, threadId("e2")), "");
    clock.set(NOW + INDEX_REFRESH_MS + 2_000);
    await adapter.poll();
    expect(listings(files)).toBe(2);
    clock.set(NOW + INDEX_REFRESH_MS + INDEX_PROMPT_REFRESH_MS);
    await adapter.poll();
    expect(listings(files)).toBe(3);
  });
});

describe("what a poll costs", () => {
  test("a poll where nothing changed opens no file, and every file opened is closed", async () => {
    const files = emptyCodex();
    addSession(files, {
      thread: ids.working,
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      lock: true,
    });
    files.write(INDEX, rollout(indexLine(ids.working, "demo-project")));
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });
    await adapter.poll();
    expect(files.opened()).toHaveLength(2);
    files.forget();

    clock.set(NOW + 2_000);
    const again = await adapter.poll();
    expect(again.sessions).toMatchObject([{ name: "demo-project", status: "working" }]);
    expect(files.opened()).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("a turn that ends between polls is read from where the last read stopped", async () => {
    const files = emptyCodex();
    const file = addSession(files, {
      thread: ids.working,
      lines: linesFor("demo", ids.working, [[NOW - MINUTE, "task_started"]]),
      lock: true,
    });
    const clock = handClock();
    const adapter = codexAdapterFor(files, { now: clock.now });
    await adapter.poll();
    const size = (await files.io.lstat(file)).size;
    files.forget();

    files.append(file, rollout(turnLine(NOW + 1_000, "task_complete")));
    clock.set(NOW + 2_000);
    expect((await adapter.poll()).sessions).toMatchObject([
      { status: "idle", statusSince: NOW + 1_000 },
    ]);
    expect(files.reads.every((read) => read.position >= size - 1)).toBe(true);

    files.remove(lockPath(CODEX_HOME, ids.working));
    clock.set(NOW + 4_000);
    expect((await adapter.poll()).sessions).toMatchObject([
      { status: "finished", statusSince: NOW + 1_000 },
    ]);
  });

  test("a poll of an empty Codex folder lists four folders and looks at the names file, and nothing else", async () => {
    const files = emptyCodex();
    const adapter = codexAdapterFor(files);
    await adapter.poll();
    files.forget();
    await adapter.poll();
    expect(files.calls.map((call) => call.method).sort()).toEqual([
      "lstat",
      "readdir",
      "readdir",
      "readdir",
      "readdir",
    ]);
    // The sessions folder, the lock folder, today's and yesterday's folders, and the names file.
    expect(files.calls.map((call) => call.path)).toContain(SESSIONS);
    expect(files.calls.map((call) => call.path)).toContain(LOCKS);
    expect(files.calls.map((call) => call.path)).toContain(INDEX);
  });
});
