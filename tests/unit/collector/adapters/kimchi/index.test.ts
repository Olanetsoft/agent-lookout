import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  INTERNAL_SESSION_ENTRY,
  KIMCHI_CAPABILITIES,
  KIMCHI_PROFILE,
  KIMCHI_PROGRAMS,
  kimchiSessionsDirFor,
  NEWER_FORMAT_NOTE,
  RECHECK_MS,
  STATUS_NOTE,
  SUBAGENT_SESSION_ENTRY,
  UNCHECKED_NOTE,
} from "@collector/adapters/kimchi/index";
import { piInTable } from "@collector/adapters/pi/processes";
import { MAX_HEAD_BYTES, markedBy } from "@collector/adapters/pi/sessionFile";
import {
  agentEndLine,
  childHeader,
  conversationLines,
  DAY,
  headerFields,
  HOME,
  internalMarkerLine,
  line,
  nameLine,
  NOW,
  otherCustomLine,
  PRIVATE_ARGUMENTS,
  PRIVATE_SYSTEM_PROMPT,
  PRIVATE_WORDS,
  PROJECT,
  PROJECT_FOLDER,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  SESSIONS_DIR,
  sideChatPath,
  STARTED_AT,
  subagentMarkerLine,
} from "@tests/fixtures/kimchi/kimchi";
import {
  handClock,
  kimchiAdapterFor,
  memoryFiles,
  standInProcesses,
} from "@tests/support/adapters/kimchi/kimchiAdapter";
import { asWritten } from "@tests/support/paths";

const FILE = sessionPath(SESSION_ID);
const NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const READ_DETAIL = `Sessions are read from the files Kimchi keeps in ~/.config/kimchi/harness/sessions. ${NOTES}`;

/** The rows Sources shows, for the default folder. */
function watching(
  read: string,
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no kimchi",
) {
  return [
    { label: "Sessions folder", value: "~/.config/kimchi/harness/sessions" },
    { label: "Read", value: read },
    { label: "Process check", value: "ps -A -o comm=" },
    { label: "Process check run", value: processCheckRun },
  ];
}

/** A whole main session's file: its header, then a conversation. */
const mainSession = (id = SESSION_ID, rest = conversationLines()) => line(headerFields(id)) + rest;

/** A file system with these files, each written now. */
function filesWith(entries: Record<string, string>) {
  const files = memoryFiles();
  for (const [file, text] of Object.entries(entries)) files.write(file, text);
  return files;
}

/** The ids of the sessions one poll lists. */
async function listed(files: ReturnType<typeof memoryFiles>) {
  return (await kimchiAdapterFor(files).poll()).sessions.map((session) => session.id);
}

describe("where it looks", () => {
  test("in ~/.config/kimchi/harness/sessions, on every system, unless a setting names another place", () => {
    expect(asWritten(kimchiSessionsDirFor({}, HOME))).toBe(SESSIONS_DIR);
    expect(kimchiSessionsDirFor({}, "C:\\Users\\example")).toBe(
      path.resolve("C:\\Users\\example", ".config", "kimchi", "harness", "sessions"),
    );
  });

  test("in KIMCHI_CODING_AGENT_SESSION_DIR itself, with ~ as the home folder, as Pi takes it", () => {
    const sessions = path.resolve("/kimchi-sessions");
    expect(
      asWritten(kimchiSessionsDirFor({ KIMCHI_CODING_AGENT_SESSION_DIR: sessions }, HOME)),
    ).toBe(asWritten(sessions));
    expect(
      asWritten(kimchiSessionsDirFor({ KIMCHI_CODING_AGENT_SESSION_DIR: "~/kimchi" }, HOME)),
    ).toBe(`${HOME}/kimchi`);
  });

  test("past a relative or empty KIMCHI_CODING_AGENT_SESSION_DIR", () => {
    for (const value of ["sessions", "", "  "]) {
      expect(
        asWritten(kimchiSessionsDirFor({ KIMCHI_CODING_AGENT_SESSION_DIR: value }, HOME)),
      ).toBe(SESSIONS_DIR);
    }
  });

  test("past the agent folder's variables, which Kimchi sets itself as it starts", () => {
    const env = {
      KIMCHI_CODING_AGENT_DIR: path.resolve("/kimchi-agent"),
      PI_CODING_AGENT_DIR: path.resolve("/pi-agent"),
      PI_CODING_AGENT_SESSION_DIR: path.resolve("/pi-sessions"),
    };
    expect(asWritten(kimchiSessionsDirFor(env, HOME))).toBe(SESSIONS_DIR);
  });

  test("in the folder Agent Lookout's own setting names, before any other", () => {
    const env = {
      AGENT_LOOKOUT_KIMCHI_HOME: " /tmp/kimchi ",
      KIMCHI_CODING_AGENT_SESSION_DIR: path.resolve("/other"),
    };
    expect(asWritten(kimchiSessionsDirFor(env, HOME))).toBe("/tmp/kimchi/sessions");
  });
});

describe("a Kimchi that is not there", () => {
  test("is not found, calmly, and its folder is looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const processes = standInProcesses();
    const adapter = kimchiAdapterFor(files, { now: clock.now, processes });
    expect(adapter.lookingIn).toBe(
      "Looking for Kimchi sessions in ~/.config/kimchi/harness/sessions.",
    );
    expect(adapter.capabilities).toBe(KIMCHI_CAPABILITIES);

    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "kimchi",
      label: "Kimchi",
      state: "unavailable",
      detail:
        "Kimchi was not found: there is no ~/.config/kimchi/harness/sessions folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(sessions).toEqual([]);
    expect(processes.asked.count).toBe(0);

    clock.advance(RECHECK_MS - SECOND);
    await adapter.poll();
    expect(files.count()).toBe(1);
  });

  test("a folder named for Agent Lookout alone, with nothing there, is an answer", async () => {
    const adapter = kimchiAdapterFor(memoryFiles(), {
      env: { AGENT_LOOKOUT_KIMCHI_HOME: "/tmp/empty-kimchi" },
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_KIMCHI_HOME is set, and there is no /tmp/empty-kimchi/sessions folder, so no Kimchi sessions are listed. ${NOTES}`,
    );
    expect(sessions).toEqual([]);
  });
});

describe("a session", () => {
  test("is shown with its folder's name, and as unknown while a kimchi program runs", async () => {
    const result = await kimchiAdapterFor(filesWith({ [FILE]: mainSession() })).poll();
    expect(result.basis).toBe(BASIS);
    expect(result.health).toEqual({
      id: "kimchi",
      label: "Kimchi",
      state: "ok",
      detail: READ_DETAIL,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(result.sessions).toEqual([
      {
        id: `kimchi:${SESSION_ID}`,
        source: "kimchi",
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

  test("never takes the name Kimchi gave it, which is made from the person's words", async () => {
    const files = filesWith({
      [FILE]: line(headerFields(SESSION_ID)) + nameLine() + conversationLines() + nameLine(),
    });
    const result = await kimchiAdapterFor(files).poll();
    expect(result.sessions[0].name).toBe("demo-project");
    const said = JSON.stringify(result);
    for (const words of [PRIVATE_WORDS, PRIVATE_ARGUMENTS, PRIVATE_SYSTEM_PROMPT]) {
      expect(said).not.toContain(words);
      expect(said).not.toContain(words.slice(0, 30));
    }
  });

  test("is read once, from its first 64 KiB, and not opened again while it only grows", async () => {
    const files = filesWith({ [FILE]: mainSession(SESSION_ID, conversationLines().repeat(200)) });
    const clock = handClock();
    const adapter = kimchiAdapterFor(files, { now: clock.now });
    await adapter.poll();
    expect(
      files.reads.every(({ position, length }) => position === 0 && length <= MAX_HEAD_BYTES),
    ).toBe(true);
    files.append(FILE, conversationLines() + nameLine(), { mtimeMs: clock.now() + SECOND });
    clock.advance(2 * SECOND);
    const next = await adapter.poll();
    expect(next.sessions.map((session) => session.id)).toEqual([`kimchi:${SESSION_ID}`]);
    expect(files.count("openRegular")).toBe(1);
  });

  test("over 64 KiB and rewritten shorter in place is read from its first 64 KiB again", async () => {
    const padding = line({
      type: "custom",
      customType: "work_identity",
      data: "x".repeat(MAX_HEAD_BYTES),
    });
    const shorter = mainSession(SESSION_ID, conversationLines() + padding + nameLine());
    const files = filesWith({ [FILE]: shorter + conversationLines() });
    const clock = handClock();
    const adapter = kimchiAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.rewrite(FILE, shorter, { mtimeMs: clock.now() + SECOND });
    clock.advance(2 * SECOND);
    const result = await adapter.poll();
    expect(result.sessions[0].name).toBe("demo-project");
    expect(JSON.stringify(result)).not.toContain(PRIVATE_WORDS.slice(0, 30));
    expect(files.count("openRegular")).toBe(2);
    expect(
      files.reads.every(({ position, length }) => position === 0 && length <= MAX_HEAD_BYTES),
    ).toBe(true);
  });

  test("written again as a new file is read again", async () => {
    const files = filesWith({ [FILE]: mainSession() });
    const clock = handClock();
    const adapter = kimchiAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.write(FILE, mainSession(), { mtimeMs: clock.now() + SECOND });
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(files.count("openRegular")).toBe(2);
  });

  test("rewritten shorter in place, as a migration is while it writes, is read from its start again, and its name stays unread", async () => {
    const files = filesWith({ [FILE]: mainSession() });
    const clock = handClock();
    const adapter = kimchiAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.append(FILE, nameLine() + conversationLines().repeat(20), {
      mtimeMs: clock.now() + SECOND,
    });
    clock.advance(2 * SECOND);
    await adapter.poll();
    files.rewrite(
      FILE,
      mainSession(SESSION_ID, conversationLines() + nameLine() + conversationLines().repeat(10)),
      { mtimeMs: clock.now() + SECOND },
    );
    clock.advance(2 * SECOND);
    const result = await adapter.poll();
    expect(result.sessions[0].name).toBe("demo-project");
    const said = JSON.stringify(result);
    expect(said).not.toContain(PRIVATE_WORDS);
    expect(said).not.toContain(PRIVATE_WORDS.slice(0, 30));
    expect(files.count("openRegular")).toBe(2);
    expect(
      files.reads.every(({ position, length }) => position === 0 && length <= MAX_HEAD_BYTES),
    ).toBe(true);
  });

  test("is finished, at its last write, once no kimchi program runs", async () => {
    const processes = standInProcesses({ ok: true, running: false });
    const files = memoryFiles();
    files.write(FILE, mainSession(), { mtimeMs: NOW - 5 * SECOND });
    const result = await kimchiAdapterFor(files, { processes }).poll();
    expect(result.basis).toBe(BASIS_CLOSED);
    expect(result.health.detail).toBe(
      `${READ_DETAIL} No kimchi program runs, so each session shows as finished.`,
    );
    expect(result.sessions[0]).toMatchObject({ status: "finished", statusSince: NOW - 5 * SECOND });
  });

  test("stays unknown when ps cannot say whether Kimchi runs", async () => {
    const processes = standInProcesses({ ok: false });
    const result = await kimchiAdapterFor(filesWith({ [FILE]: mainSession() }), {
      processes,
    }).poll();
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toBe(
      `${READ_DETAIL} ps could not be run to tell whether Kimchi runs, so no session is shown as finished.`,
    );
    expect(result.sessions[0].status).toBe("unknown");
  });

  test("on Windows is read from the home folder, and stays unknown, since ps is not run there", async () => {
    const result = await kimchiAdapterFor(filesWith({ [FILE]: mainSession() }), {
      platform: "win32",
      processes: undefined,
    }).poll();
    expect(result.health.detail).toContain(
      "Agent Lookout cannot tell on this system whether Kimchi runs, so no session is shown as finished.",
    );
    expect(result.health.watching).toContainEqual({
      label: "Process check run",
      value: "not run on Windows",
    });
    expect(result.sessions[0]?.status).toBe("unknown");
  });

  test("of a newer format is not shown, and the card says so", async () => {
    const files = filesWith({ [FILE]: line(headerFields(SESSION_ID, { version: 4 })) });
    const { health, sessions } = await kimchiAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(health.detail).toContain(NEWER_FORMAT_NOTE);
  });

  test("not written for a day is not listed", async () => {
    const files = memoryFiles();
    files.write(FILE, mainSession(), { mtimeMs: NOW - 2 * DAY });
    expect(await listed(files)).toEqual([]);
  });
});

describe("the sessions Kimchi makes for itself", () => {
  const child = sessionIdOf(2);
  const childFile = sessionPath(child);

  test("a subagent's, marked on its second line, is left out, and its parent is listed", async () => {
    const files = filesWith({
      [FILE]: mainSession(),
      [childFile]: childHeader(child) + subagentMarkerLine() + conversationLines(),
    });
    expect(await listed(files)).toEqual([`kimchi:${SESSION_ID}`]);
  });

  test("Ferment's evaluator's, marked as internal, is left out", async () => {
    const files = filesWith({
      [FILE]: mainSession(),
      [childFile]:
        childHeader(child) +
        internalMarkerLine() +
        nameLine("Ferment V2 evaluator") +
        conversationLines(),
    });
    expect(await listed(files)).toEqual([`kimchi:${SESSION_ID}`]);
  });

  test("a branch the person made names its parent too, and is listed", async () => {
    const files = filesWith({
      [FILE]: mainSession(),
      [childFile]: childHeader(child) + conversationLines(),
    });
    expect((await listed(files)).sort()).toEqual(
      [`kimchi:${SESSION_ID}`, `kimchi:${child}`].sort(),
    );
  });

  test("a side chat, in a folder of its session's own, is not looked at", async () => {
    const side = sideChatPath(SESSION_ID, sessionIdOf(3));
    const files = filesWith({
      [FILE]: mainSession(),
      [side]: childHeader(sessionIdOf(3)) + conversationLines(),
    });
    expect(await listed(files)).toEqual([`kimchi:${SESSION_ID}`]);
    expect(files.opened().map(asWritten)).toEqual([FILE]);
  });

  test("a marker anywhere but the second line leaves a session in", async () => {
    const files = filesWith({
      [FILE]: line(headerFields(SESSION_ID)) + agentEndLine() + subagentMarkerLine(),
    });
    expect(await listed(files)).toEqual([`kimchi:${SESSION_ID}`]);
  });

  test("a second line of another kind leaves a session in", async () => {
    for (const second of [
      otherCustomLine(),
      otherCustomLine("kimchi:subagent-sessions"),
      agentEndLine(),
    ]) {
      const files = filesWith({ [FILE]: line(headerFields(SESSION_ID)) + second });
      expect(await listed(files), second).toEqual([`kimchi:${SESSION_ID}`]);
    }
  });

  test("a prompt that holds a marker's words leaves a session in", async () => {
    const said = line({
      type: "message",
      id: "a6b7c8d9",
      parentId: null,
      timestamp: new Date(STARTED_AT).toISOString(),
      message: { role: "user", content: `"customType":"${SUBAGENT_SESSION_ENTRY}"` },
    });
    const files = filesWith({ [FILE]: line(headerFields(SESSION_ID)) + said });
    expect(await listed(files)).toEqual([`kimchi:${SESSION_ID}`]);
  });

  test("a file with only its first line is listed once its second is written, and not before", async () => {
    const files = memoryFiles();
    const clock = handClock();
    files.write(FILE, line(headerFields(SESSION_ID)));
    const marked = sessionPath(child);
    files.write(marked, childHeader(child));
    const adapter = kimchiAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);

    files.append(FILE, conversationLines(), { mtimeMs: clock.now() + SECOND });
    files.append(marked, subagentMarkerLine(), { mtimeMs: clock.now() + SECOND });
    clock.advance(2 * SECOND);
    const next = await adapter.poll();
    expect(next.sessions.map((session) => session.id)).toEqual([`kimchi:${SESSION_ID}`]);
  });

  test("a file found to be a subagent's is not opened again while it grows", async () => {
    const files = filesWith({ [childFile]: childHeader(child) + subagentMarkerLine() });
    const clock = handClock();
    const adapter = kimchiAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.append(childFile, conversationLines(), { mtimeMs: clock.now() + SECOND });
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(files.count("openRegular")).toBe(1);
  });

  test("a subagent's file holds no session id the parent's could be mistaken for", async () => {
    // Of two files that hold one id, the newest is kept: a left-out one holds none.
    const files = memoryFiles();
    files.write(FILE, mainSession(), { mtimeMs: NOW - 10 * SECOND });
    files.write(
      sessionPath(SESSION_ID, `${PROJECT_FOLDER}`, STARTED_AT + 1_000),
      childHeader(SESSION_ID) + subagentMarkerLine(),
    );
    expect(await listed(files)).toEqual([`kimchi:${SESSION_ID}`]);
  });
});

describe("the markers, as bytes", () => {
  const markers = KIMCHI_PROFILE.hiddenMarkers;
  const bytes = (text: string) => Buffer.from(text.replace(/\n$/, ""));

  test("are Kimchi's two, and each of its lines is one", () => {
    expect(markers).toEqual([SUBAGENT_SESSION_ENTRY, INTERNAL_SESSION_ENTRY]);
    expect(markedBy(bytes(subagentMarkerLine()), markers)).toBe(true);
    expect(markedBy(bytes(internalMarkerLine()), markers)).toBe(true);
  });
});

describe("the process check", () => {
  test("looks for kimchi alone, by name or by a path that ends in it", () => {
    expect([...KIMCHI_PROGRAMS]).toEqual(["kimchi"]);
    expect(piInTable("/sbin/launchd\nkimchi\n", KIMCHI_PROGRAMS)).toBe(true);
    expect(piInTable("/opt/homebrew/bin/kimchi\n", KIMCHI_PROGRAMS)).toBe(true);
    expect(piInTable("pi\npi-rpc\nnode\nkimchi-helper\n", KIMCHI_PROGRAMS)).toBe(false);
  });
});

describe("what it says it can report", () => {
  test("is what its profile carries, and names no other agent", () => {
    expect(KIMCHI_PROFILE.capabilities).toBe(KIMCHI_CAPABILITIES);
    expect(KIMCHI_PROFILE.readsNames).toBe(false);
    for (const cell of Object.values(KIMCHI_CAPABILITIES)) {
      if (cell.level !== "yes") expect(cell.reason).not.toMatch(/\bPi\b/);
    }
    for (const note of [STATUS_NOTE, UNCHECKED_NOTE, NEWER_FORMAT_NOTE]) {
      expect(note).not.toMatch(/\bPi\b/);
    }
    expect(UNCHECKED_NOTE).toContain("v1.35.0");
  });
});
