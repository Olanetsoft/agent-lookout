import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  createDroidAdapter,
  DROID_CAPABILITIES,
  DROID_PROGRAMS,
  droidSessionsDirFor,
  NOT_A_SESSION_NOTE,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
  STATUS_NOTE,
  UNCHECKED_NOTE,
} from "@collector/adapters/droid/index";
import { MAX_SETTINGS_BYTES } from "@collector/adapters/droid/settingsFile";
import type { ProcessAnswer } from "@collector/adapters/opencode/processes";
import { createPiProcessReader, piInTable } from "@collector/adapters/pi/processes";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import { EMPTY_CHANGE_MEMORY, sessionChanges } from "@core/notices/sessionChanges";
import {
  CWD,
  DAY,
  FACTORY_DIR,
  HOME,
  messageLine,
  NOW,
  OWNER,
  PRIVATE_PROMPT,
  PRIVATE_TAG,
  PRIVATE_TITLE,
  PROJECT_FOLDER,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  SESSIONS,
  sessionStart,
  sessionText,
  settings,
  settingsPath,
} from "@tests/fixtures/droid/droid";
import {
  droidAdapterFor,
  handClock,
  memoryFiles,
  standInProcesses,
  type MemoryFiles,
} from "@tests/support/adapters/droid/droidAdapter";
import { asWritten } from "@tests/support/paths";

const FILE = sessionPath();
const NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const READ_DETAIL = `Sessions are read from the files Droid keeps in ~/.factory/sessions. ${NOTES}`;
const NONE_RUNS: ProcessAnswer = { ok: true, running: false };
const ARCHIVED = settings({ archivedAt: "2026-11-01T00:00:00Z" });

/** The rows Sources shows, for the default folder. */
function watching(
  read: string,
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no droid",
) {
  return [
    { label: "Sessions folder", value: "~/.factory/sessions" },
    { label: "Read", value: read },
    {
      label: "Files read",
      value:
        "The first line of each <id>.jsonl, and archivedAt from the <id>.settings.json beside it",
    },
    { label: "Process check", value: "ps -A -o comm=" },
    { label: "Process check run", value: processCheckRun },
  ];
}

/** A file system with these files, each written at the time given or now. */
function filesWith(entries: Record<string, string>, mtimeMs = NOW) {
  const files = memoryFiles();
  for (const [file, text] of Object.entries(entries)) files.write(file, text, { mtimeMs });
  return files;
}

/** The IDs of the sessions one poll lists. */
async function listed(files: MemoryFiles) {
  return (await droidAdapterFor(files).poll()).sessions.map((session) => session.id);
}

describe("where it looks", () => {
  test("in ~/.factory/sessions, on every system, unless Agent Lookout's own setting names another place", () => {
    expect(asWritten(droidSessionsDirFor({}, HOME))).toBe(SESSIONS);
    expect(droidSessionsDirFor({}, "C:\\Users\\example")).toBe(
      path.resolve("C:\\Users\\example", ".factory", "sessions"),
    );
    expect(asWritten(droidSessionsDirFor({ AGENT_LOOKOUT_DROID_HOME: " /tmp/droid " }, HOME))).toBe(
      "/tmp/droid/sessions",
    );
    expect(asWritten(droidSessionsDirFor({ AGENT_LOOKOUT_DROID_HOME: "  " }, HOME))).toBe(SESSIONS);
  });

  test("never in the folder FACTORY_HOME_OVERRIDE names, which Factory does not document for sessions", async () => {
    const env = { FACTORY_HOME_OVERRIDE: "/tmp/factory" };
    expect(asWritten(droidSessionsDirFor(env, HOME))).toBe(SESSIONS);
    const files = filesWith({
      [sessionPath(SESSION_ID, "/tmp/factory/.factory/sessions")]: sessionText(),
    });
    const { health, sessions } = await droidAdapterFor(files, { env }).poll();
    expect(health.state).toBe("unavailable");
    expect(sessions).toEqual([]);
    for (const call of files.calls) expect(call.path.startsWith("/tmp/factory")).toBe(false);
  });
});

describe("a Droid that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = droidAdapterFor(files, { now: clock.now, processes });
    expect(adapter.lookingIn).toBe("Looking for Droid sessions in ~/.factory/sessions.");
    expect(adapter.capabilities).toBe(DROID_CAPABILITIES);

    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "droid",
      label: "Droid",
      state: "unavailable",
      detail:
        "Droid was not found: there is no ~/.factory/sessions folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(sessions).toEqual([]);
    expect(processes.asked.count).toBe(0);

    clock.advance(RECHECK_MS - SECOND);
    await adapter.poll();
    expect(files.count()).toBe(1);
    clock.advance(SECOND);
    await adapter.poll();
    expect(files.count()).toBe(2);
    // A clock set back counts as time enough.
    clock.advance(-10 * SECOND);
    await adapter.poll();
    expect(files.count()).toBe(3);
  });

  test("a folder named for Agent Lookout alone, with nothing there, is an answer, looked for on every poll", async () => {
    const files = memoryFiles();
    const adapter = droidAdapterFor(files, {
      env: { AGENT_LOOKOUT_DROID_HOME: "/tmp/empty-droid" },
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      // Resolved, so on Windows it starts with the drive.
      `AGENT_LOOKOUT_DROID_HOME is set, and there is no ${path.join(path.resolve("/tmp/empty-droid"), "sessions")} folder, so no Droid sessions are listed. ${NOTES}`,
    );
    expect(sessions).toEqual([]);
    expect(basis).toBe(BASIS);
    await adapter.poll();
    expect(files.count("readdir")).toBe(2);
  });

  test("a sessions folder that cannot be listed is an error", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS);
    files.fail(SESSIONS);
    const { health } = await droidAdapterFor(files).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      "Droid sessions could not be read: the folder ~/.factory/sessions could not be listed.",
    );
    expect(health.watching).toEqual(watching("cannot be read"));
  });

  test("anything that goes wrong past that is a sentence, not a stack trace", async () => {
    const files = filesWith({ [FILE]: sessionText() });
    const processes = {
      async read(): Promise<ProcessAnswer> {
        throw new Error("Not expected.");
      },
    };
    const { health, sessions } = await droidAdapterFor(files, { processes }).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe("Something unexpected went wrong while reading Droid sessions.");
    expect(sessions).toEqual([]);
  });
});

describe("a session", () => {
  test("is shown with its folder's name, and as unknown while a droid program runs", async () => {
    const result = await droidAdapterFor(filesWith({ [FILE]: sessionText() })).poll();
    expect(result.basis).toBe(BASIS);
    expect(result.health).toEqual({
      id: "droid",
      label: "Droid",
      state: "ok",
      detail: READ_DETAIL,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(result.sessions).toEqual([
      {
        id: `droid:${SESSION_ID}`,
        source: "droid",
        surface: "unknown",
        name: "demo-project",
        cwd: CWD,
        project: "demo-project",
        status: "unknown",
        startedAt: null,
        statusSince: null,
        links: {},
        stale: false,
      },
    ]);
  });

  test("keeps no title, owner or prompt anywhere in what a poll gives", async () => {
    const files = filesWith({
      [FILE]: sessionText(),
      [sessionPath(sessionIdOf(2))]: sessionText(
        { title: undefined, sessionTitle: PRIVATE_TITLE },
        messageLine(),
      ),
      [settingsPath()]: settings(),
    });
    const result = await droidAdapterFor(files).poll();
    expect(result.sessions).toHaveLength(2);
    const text = JSON.stringify(result);
    for (const secret of [PRIVATE_TITLE, OWNER, PRIVATE_PROMPT, PRIVATE_TAG, "ffffffff"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("is named by its ID when its first line names no folder, and the project folder's name is never read", async () => {
    const files = filesWith({ [FILE]: sessionText({ cwd: undefined }) });
    const [session] = (await droidAdapterFor(files).poll()).sessions;
    expect(session?.name).toBe(`droid:${SESSION_ID}`);
    expect(session?.cwd).toBeNull();
  });

  test("takes its folder from its first line alone, and never from a later one", async () => {
    const files = filesWith({
      [FILE]: sessionStart({ cwd: undefined }) + sessionStart({ cwd: "/Users/example/code/other" }),
    });
    const [session] = (await droidAdapterFor(files).poll()).sessions;
    expect(session?.name).toBe(`droid:${SESSION_ID}`);
  });

  test("is finished since its last write once no droid program runs", async () => {
    const writtenAt = NOW - 3 * SECOND + 0.25;
    const files = filesWith({ [FILE]: sessionText() }, writtenAt);
    const result = await droidAdapterFor(files, { processes: standInProcesses(NONE_RUNS) }).poll();
    expect(result.basis).toBe(BASIS_CLOSED);
    expect(result.health.detail).toBe(
      `${READ_DETAIL} No droid program runs, so each session shows as finished.`,
    );
    expect(result.sessions[0]).toMatchObject({
      status: "finished",
      statusSince: Math.floor(writtenAt),
    });
  });

  test("is unknown while ps cannot be run, with the reason", async () => {
    const files = filesWith({ [FILE]: sessionText() });
    const result = await droidAdapterFor(files, {
      processes: standInProcesses({ ok: false }),
    }).poll();
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toBe(
      `${READ_DETAIL} ps could not be run to tell whether Droid runs, so no session is shown as finished.`,
    );
    expect(result.sessions[0]?.status).toBe("unknown");
  });

  test("is unknown on Windows, where ps is never run", async () => {
    const asked: (readonly string[])[] = [];
    const run = async (args: readonly string[]) => {
      asked.push(args);
      return { ok: true as const, stdout: "droid\n" };
    };
    const files = filesWith({
      [FILE]: sessionText({ cwd: "C:\\Users\\example\\code\\demo-project" }),
    });
    const result = await droidAdapterFor(files, {
      platform: "win32",
      processes: createPiProcessReader({ platform: "win32", programs: DROID_PROGRAMS, run }),
    }).poll();
    expect(asked).toEqual([]);
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.watching?.at(-1)).toEqual({
      label: "Process check run",
      value: "not run on Windows",
    });
    expect(result.health.detail).toBe(
      `${READ_DETAIL} Agent Lookout cannot tell on this system whether Droid runs, so no session is shown as finished.`,
    );
    expect(result.sessions[0]).toMatchObject({ status: "unknown", name: "demo-project" });
  });

  test("asks ps for the name of each program alone, and finds droid and droid-dev by the last part of it", async () => {
    const asked: (readonly string[])[] = [];
    const reader = createPiProcessReader({
      platform: "darwin",
      programs: DROID_PROGRAMS,
      run: async (args) => {
        asked.push(args);
        return { ok: true, stdout: "launchd\ndroid-dev\n" };
      },
    });
    expect(await reader.read()).toEqual({ ok: true, running: true });
    expect(asked).toEqual([["-A", "-o", "comm="]]);
    expect(
      piInTable("/Applications/Factory.app/Contents/Resources/bin/droid\n", DROID_PROGRAMS),
    ).toBe(true);
    expect(piInTable("droid\n", DROID_PROGRAMS)).toBe(true);
    for (const name of ["android", "droidx", "Droid", "fdroid", "factory-desktop", "droid.exe"]) {
      expect(piInTable(`${name}\n`, DROID_PROGRAMS), name).toBe(false);
    }
  });

  test("never shows as working, idle, needing you or failed, whatever ps says", async () => {
    const seen = new Set<string>();
    for (const answer of [{ ok: true, running: true }, NONE_RUNS, { ok: false }] as const) {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        for (const writtenAt of [NOW - DAY + SECOND, NOW - SECOND, NOW, NOW + SECOND]) {
          const files = filesWith({ [FILE]: sessionText() }, writtenAt);
          const result = await droidAdapterFor(files, {
            platform,
            processes: standInProcesses(answer),
          }).poll();
          for (const session of result.sessions) seen.add(session.status);
        }
      }
    }
    expect([...seen].sort()).toEqual(["finished", "unknown"]);
  });
});

describe("when ps is asked", () => {
  test("never while no session is listed", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS);
    const processes = standInProcesses();
    const adapter = droidAdapterFor(files, { processes });
    await adapter.poll();
    files.write(FILE, sessionStart());
    await adapter.poll();
    expect(processes.asked.count).toBe(0);
  });

  test("at most every 10 seconds while a droid runs", async () => {
    const files = filesWith({ [FILE]: sessionText() }, NOW - DAY / 2);
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = droidAdapterFor(files, { now: clock.now, processes });
    await adapter.poll();
    clock.advance(PROCESS_CHECK_MS - SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test("sooner, but not within 2 seconds, when a session is written after ps said none runs, or up to 2 seconds before", async () => {
    for (const [writtenAt, sooner] of [
      [NOW + SECOND, true],
      [NOW - 2 * SECOND + 1, true],
      [NOW - 2 * SECOND, false],
    ] as const) {
      const files = filesWith({ [FILE]: sessionText() }, NOW - DAY / 2);
      const clock = handClock();
      const processes = standInProcesses(NONE_RUNS);
      const adapter = droidAdapterFor(files, { now: clock.now, processes });
      await adapter.poll();
      files.append(FILE, messageLine(), { mtimeMs: writtenAt });
      clock.advance(PROMPT_PROCESS_CHECK_MS - 1);
      await adapter.poll();
      expect(processes.asked.count, String(writtenAt - NOW)).toBe(1);
      clock.advance(1);
      await adapter.poll();
      expect(processes.asked.count, String(writtenAt - NOW)).toBe(sooner ? 2 : 1);
    }
  });

  test("not sooner while a droid runs", async () => {
    const files = filesWith({ [FILE]: sessionText() });
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = droidAdapterFor(files, { now: clock.now, processes });
    await adapter.poll();
    files.append(FILE, messageLine(), { mtimeMs: NOW + SECOND });
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
  });

  test("at once when the clock is set back", async () => {
    const files = filesWith({ [FILE]: sessionText() }, NOW - DAY / 2);
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = droidAdapterFor(files, { now: clock.now, processes });
    await adapter.poll();
    clock.advance(-SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });
});

describe("a finish by ps", () => {
  test("waits for an answer asked 2 seconds or more after the last write to any session shown", async () => {
    const files = filesWith({
      [FILE]: sessionText(),
      [sessionPath(sessionIdOf(2))]: sessionText(),
    });
    files.rewrite(FILE, sessionText(), { mtimeMs: NOW - 10 * SECOND });
    // Written a second before ps answered: a droid may have started since ps looked.
    files.rewrite(sessionPath(sessionIdOf(2)), sessionText(), { mtimeMs: NOW - SECOND });
    const clock = handClock();
    const processes = standInProcesses(NONE_RUNS);
    const adapter = droidAdapterFor(files, { now: clock.now, processes });

    const held = await adapter.poll();
    expect(held.basis).toBe(BASIS);
    expect(held.health.detail).toBe(READ_DETAIL);
    expect(new Set(held.sessions.map((session) => session.status))).toEqual(new Set(["unknown"]));
    expect(held.sessions.every((session) => session.statusSince === null)).toBe(true);

    clock.advance(PROMPT_PROCESS_CHECK_MS);
    const told = await adapter.poll();
    expect(processes.asked.count).toBe(2);
    expect(told.basis).toBe(BASIS_CLOSED);
    expect(told.sessions.map((session) => [session.status, session.statusSince])).toEqual([
      ["finished", NOW - SECOND],
      ["finished", NOW - 10 * SECOND],
    ]);
  });

  test("counts a write exactly 2 seconds before the answer as before it", async () => {
    const files = filesWith({ [FILE]: sessionText() }, NOW - 2 * SECOND);
    const result = await droidAdapterFor(files, { processes: standInProcesses(NONE_RUNS) }).poll();
    expect(result.sessions[0]?.status).toBe("finished");
  });

  test("allows nothing for a rounded time when ps was asked because the clock was set back", async () => {
    const files = filesWith({ [FILE]: sessionText() }, NOW - DAY / 2);
    const clock = handClock();
    const processes = standInProcesses(NONE_RUNS);
    const adapter = droidAdapterFor(files, { now: clock.now, processes });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");

    // Set back by a minute, with a write a second before the ask that follows.
    clock.advance(-60 * SECOND);
    files.append(FILE, messageLine(), { mtimeMs: clock.now() - SECOND });
    const back = await adapter.poll();
    expect(processes.asked.count).toBe(2);
    expect(back.sessions[0]?.status).toBe("finished");
    expect(back.basis).toBe(BASIS_CLOSED);

    // The next ask, made in time, allows for it again.
    files.append(FILE, messageLine(), { mtimeMs: clock.now() + SECOND });
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    const after = await adapter.poll();
    expect(processes.asked.count).toBe(3);
    expect(after.sessions[0]?.status).toBe("unknown");
    expect(after.basis).toBe(BASIS);
  });

  test("goes by the open file's time when it is later than the lstat's", async () => {
    const files = filesWith({ [FILE]: sessionText() }, NOW - 10 * SECOND);
    let written = false;
    const io: ReadOnlyIo = {
      ...files.io,
      async lstat(target) {
        const info = await files.io.lstat(target);
        // A write between the lstat and the open.
        if (!written && asWritten(target) === FILE) {
          written = true;
          files.append(FILE, messageLine(), { mtimeMs: NOW - SECOND });
        }
        return info;
      },
    };
    const result = await createDroidAdapter({
      env: {},
      homeDir: HOME,
      now: () => NOW,
      io,
      platform: "darwin",
      processes: standInProcesses(NONE_RUNS),
    }).poll();
    expect(result.sessions[0]?.status).toBe("unknown");
    expect(result.basis).toBe(BASIS);
  });

  test("sends no Finished when the last droid quits, even just after a write", async () => {
    const files = filesWith({
      [FILE]: sessionText(),
      [sessionPath(sessionIdOf(2))]: sessionText(),
    });
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = droidAdapterFor(files, { now: clock.now, processes });
    let memory = EMPTY_CHANGE_MEMORY;
    const changes: string[] = [];
    const bases: (string | undefined)[] = [];
    for (let poll = 0; poll < 8; poll += 1) {
      if (poll === 4) {
        // Droid writes as it quits, a moment before ps is next asked.
        files.append(FILE, messageLine(), { mtimeMs: clock.now() - SECOND });
        processes.set(NONE_RUNS);
      }
      const result = await adapter.poll();
      bases.push(result.basis);
      const next = sessionChanges(memory, {
        generatedAt: clock.now(),
        sources: [{ ...result.health, basis: result.basis }],
        sessions: result.sessions,
      });
      memory = next.memory;
      changes.push(...next.changes.map(({ event, session }) => `${session.id} ${event}`));
      clock.advance(PROCESS_CHECK_MS / 2);
    }
    expect(bases).toContain(BASIS_CLOSED);
    expect(bases.at(-1)).toBe(BASIS_CLOSED);
    expect(changes).toEqual([]);
  });
});

describe("archived sessions", () => {
  test("are left out while archivedAt is text that is not empty", async () => {
    const cases: [string | null, boolean][] = [
      [ARCHIVED, false],
      [settings({ archivedAt: "" }), true],
      [settings({ archivedAt: true }), true],
      [settings({ archivedAt: 1 }), true],
      [settings(), true],
      ["{", true],
      ["[]", true],
      [null, true],
    ];
    for (const [text, shown] of cases) {
      const files = filesWith({ [FILE]: sessionText() });
      if (text !== null) files.write(settingsPath(), text);
      expect(await listed(files), String(text)).toEqual(shown ? [`droid:${SESSION_ID}`] : []);
    }
  });

  test("come back on the next poll once unarchived, and leave again once archived", async () => {
    const files = filesWith({ [FILE]: sessionText(), [settingsPath()]: ARCHIVED });
    const adapter = droidAdapterFor(files);
    expect((await adapter.poll()).sessions).toEqual([]);
    files.rewrite(settingsPath(), settings(), { mtimeMs: NOW + SECOND });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    files.rewrite(settingsPath(), ARCHIVED, { mtimeMs: NOW + 2 * SECOND });
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("are listed when the settings file is larger than 16 KiB, which is not opened", async () => {
    const files = filesWith({
      [FILE]: sessionText(),
      [settingsPath()]: ARCHIVED + " ".repeat(MAX_SETTINGS_BYTES),
    });
    expect(await listed(files)).toEqual([`droid:${SESSION_ID}`]);
    expect(files.opened()).toEqual([FILE]);
  });

  test("stay left out while the settings file is caught half written, until it holds still", async () => {
    const files = filesWith({ [FILE]: sessionText(), [settingsPath()]: ARCHIVED });
    const adapter = droidAdapterFor(files);
    expect((await adapter.poll()).sessions).toEqual([]);
    files.rewrite(settingsPath(), "", { mtimeMs: NOW + SECOND });
    expect((await adapter.poll()).sessions).toEqual([]);
    files.rewrite(settingsPath(), ARCHIVED, { mtimeMs: NOW + 2 * SECOND });
    expect((await adapter.poll()).sessions).toEqual([]);
    files.rewrite(settingsPath(), ARCHIVED.slice(0, 10), { mtimeMs: NOW + 3 * SECOND });
    expect((await adapter.poll()).sessions).toEqual([]);
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("have their settings file looked up on every poll, and opened only once it changes", async () => {
    const files = filesWith({ [FILE]: sessionText(), [settingsPath()]: ARCHIVED });
    const adapter = droidAdapterFor(files);
    await adapter.poll();
    files.forget();
    await adapter.poll();
    expect(files.count("lstat", (target) => target === settingsPath())).toBe(1);
    expect(files.opened()).toEqual([]);
  });
});

describe("two files that hold one ID", () => {
  const LOOSE = sessionPath(SESSION_ID, SESSIONS);

  test("show the newer, and the older is never opened", async () => {
    const files = memoryFiles();
    files.write(LOOSE, sessionText({ cwd: "/Users/example/code/older" }), {
      mtimeMs: NOW - SECOND,
    });
    files.write(FILE, sessionText(), { mtimeMs: NOW });
    const adapter = droidAdapterFor(files);
    const { sessions } = await adapter.poll();
    expect(sessions.map((session) => session.cwd)).toEqual([CWD]);
    expect(files.opened()).toEqual([FILE]);
    files.forget();
    await adapter.poll();
    expect(files.opened()).toEqual([]);
    expect(files.count("lstat", (target) => target.endsWith(".settings.json"))).toBe(1);
  });

  test("show the older when the newer is archived or is not a session", async () => {
    for (const newer of ["archived", "other", "only its first line"] as const) {
      const files = memoryFiles();
      files.write(LOOSE, sessionText({ cwd: "/Users/example/code/older" }), {
        mtimeMs: NOW - SECOND,
      });
      files.write(
        FILE,
        newer === "other" ? messageLine() : newer === "archived" ? sessionText() : sessionStart(),
      );
      if (newer === "archived") files.write(settingsPath(), ARCHIVED);
      const { sessions } = await droidAdapterFor(files).poll();
      expect(
        sessions.map((session) => session.cwd),
        newer,
      ).toEqual(["/Users/example/code/older"]);
    }
  });

  test("written at the same moment, show the one whose path sorts first", async () => {
    const files = memoryFiles();
    files.write(LOOSE, sessionText({ cwd: "/Users/example/code/loose" }));
    files.write(FILE, sessionText());
    const { sessions } = await droidAdapterFor(files).poll();
    // The finder's localeCompare puts a project folder's `-` before an ID's first digit, as
    // Python's sort by path does, so the copy in the project folder is shown.
    expect(sessions.map((session) => session.cwd)).toEqual([CWD]);
  });
});

describe("which files are sessions", () => {
  test("files with nothing after their first line are left out, with no note, until Droid writes more", async () => {
    const files = filesWith({
      [FILE]: sessionStart(),
      [sessionPath(sessionIdOf(2))]: sessionStart().trimEnd(),
    });
    const adapter = droidAdapterFor(files);
    const empty = await adapter.poll();
    expect(empty.sessions).toEqual([]);
    expect(empty.health.detail).toBe(READ_DETAIL);
    files.append(FILE, messageLine(), { mtimeMs: NOW + SECOND });
    expect((await adapter.poll()).sessions.map((session) => session.id)).toEqual([
      `droid:${SESSION_ID}`,
    ]);
  });

  test("a session whose file is caught while Droid rewrites it stays listed, and sends no Ended", async () => {
    const files = filesWith({ [FILE]: sessionText() });
    const clock = handClock();
    const adapter = droidAdapterFor(files, { now: clock.now });
    let memory = EMPTY_CHANGE_MEMORY;
    const changes: string[] = [];
    const counts: number[] = [];
    const steps = [
      () => {},
      () => files.rewrite(FILE, "", { mtimeMs: clock.now() }),
      () => files.rewrite(FILE, sessionStart(), { mtimeMs: clock.now() }),
      () => files.rewrite(FILE, sessionText(), { mtimeMs: clock.now() }),
      () => {},
    ];
    for (const step of steps) {
      step();
      const result = await adapter.poll();
      counts.push(result.sessions.length);
      const next = sessionChanges(memory, {
        generatedAt: clock.now(),
        sources: [{ ...result.health, basis: result.basis }],
        sessions: result.sessions,
      });
      memory = next.memory;
      changes.push(...next.changes.map(({ event, session }) => `${session.id} ${event}`));
      clock.advance(2 * SECOND);
    }
    expect(counts).toEqual([1, 1, 1, 1, 1]);
    expect(changes).toEqual([]);
  });

  test("a file cut back to its first line for good leaves the list once it holds still", async () => {
    const files = filesWith({ [FILE]: sessionText() });
    const adapter = droidAdapterFor(files);
    expect((await adapter.poll()).sessions).toHaveLength(1);
    files.rewrite(FILE, sessionStart(), { mtimeMs: NOW + SECOND });
    expect((await adapter.poll()).sessions).toHaveLength(1);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("a file that does not begin as a session does is left out, with a note", async () => {
    for (const text of [
      messageLine() + sessionStart(),
      sessionText({ type: "message" }),
      sessionText({ title: undefined }),
      sessionText({ title: 5 }),
      sessionText({ padding: "a".repeat(70 * 1024) }),
    ]) {
      const result = await droidAdapterFor(filesWith({ [FILE]: text })).poll();
      expect(result.sessions).toEqual([]);
      expect(result.health.detail).toBe(`${READ_DETAIL} ${NOT_A_SESSION_NOTE}`);
    }
  });

  test("a name that is not one Droid gives is never opened, and leaves a note", async () => {
    const odd = `${PROJECT_FOLDER}/my plan.jsonl`;
    const files = filesWith({ [odd]: sessionText(), [FILE]: sessionText() });
    const result = await droidAdapterFor(files).poll();
    expect(result.sessions.map((session) => session.id)).toEqual([`droid:${SESSION_ID}`]);
    expect(result.health.detail).toBe(`${READ_DETAIL} ${NOT_A_SESSION_NOTE}`);
    expect(files.opened()).not.toContain(odd);
  });

  test("only folders whose names begin with - are read, - alone among them, with loose files in the sessions folder", async () => {
    const files = filesWith({
      [sessionPath(sessionIdOf(1))]: sessionText(),
      [sessionPath(sessionIdOf(2), `${SESSIONS}/-`)]: sessionText(),
      [sessionPath(sessionIdOf(3), SESSIONS)]: sessionText(),
      [sessionPath(sessionIdOf(4), `${SESSIONS}/notes`)]: sessionText(),
    });
    expect((await listed(files)).sort()).toEqual(
      [1, 2, 3].map((n) => `droid:${sessionIdOf(n)}`).sort(),
    );
    expect(files.count("readdir", (target) => target === `${SESSIONS}/notes`)).toBe(0);
  });

  test("a link, or anything that is not an ordinary file, is neither listed nor opened, nor a linked folder", async () => {
    const files = memoryFiles();
    files.special(FILE);
    files.write(sessionPath(sessionIdOf(2), `${SESSIONS}/-linked`), sessionText());
    files.special(`${SESSIONS}/-linked`);
    files.write(sessionPath(sessionIdOf(3)), sessionText());
    files.special(settingsPath(sessionIdOf(3)));
    expect(await listed(files)).toEqual([`droid:${sessionIdOf(3)}`]);
    expect(files.opened()).toEqual([sessionPath(sessionIdOf(3))]);
    expect(files.count("readdir", (target) => target === `${SESSIONS}/-linked`)).toBe(0);
  });

  test("nothing but session files and the settings beside a shown session is ever opened, and nothing outside the sessions folder is looked at", async () => {
    const files = filesWith({
      [FILE]: sessionText(),
      [settingsPath()]: settings(),
      [`${SESSIONS}/.favorites`]: JSON.stringify([SESSION_ID]),
      [`${FACTORY_DIR}/settings.json`]: "{}",
      [`${FACTORY_DIR}/mcp.json`]: "{}",
      [`${FACTORY_DIR}/hooks.json`]: "{}",
      [`${FACTORY_DIR}/logs/x.log`]: PRIVATE_PROMPT,
      [`${PROJECT_FOLDER}/notes.txt`]: PRIVATE_PROMPT,
      [settingsPath(sessionIdOf(9))]: ARCHIVED,
      [sessionPath(sessionIdOf(5), `${SESSIONS}/notes`)]: sessionText(),
    });
    const adapter = droidAdapterFor(files);
    await adapter.poll();
    await adapter.poll();
    for (const call of files.calls) expect(call.path.startsWith(SESSIONS), call.path).toBe(true);
    expect(new Set(files.opened())).toEqual(new Set([FILE, settingsPath()]));
  });

  test("files not written in the last day are left out", async () => {
    const files = filesWith({ [FILE]: sessionText() }, NOW - DAY - SECOND);
    expect(await listed(files)).toEqual([]);
    expect(files.opened()).toEqual([]);
  });
});

describe("the files it reads", () => {
  test("are never written, and nothing is opened but to read", async () => {
    const files = filesWith({ [FILE]: sessionText(), [settingsPath()]: settings() });
    const methods = new Set<string>();
    const io = new Proxy(files.io, {
      get(target, name: keyof ReadOnlyIo) {
        methods.add(String(name));
        return target[name];
      },
    });
    await createDroidAdapter({
      env: {},
      homeDir: HOME,
      now: () => NOW,
      io,
      platform: "darwin",
      processes: standInProcesses(),
    }).poll();
    expect([...methods].sort()).toEqual(["lstat", "openRegular", "readdir"]);
    expect(files.openHandles()).toBe(0);
  });
});
