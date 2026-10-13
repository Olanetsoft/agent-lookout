import { describe, expect, test } from "vitest";

import {
  ANTIGRAVITY_APP_CAPABILITIES,
  ANTIGRAVITY_APP_HOME_ENV,
  BASIS,
  BASIS_APP_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  NEEDS_YOU_NOTE,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
  UNCHECKED_NOTE,
  UNKNOWN_STEP_NOTE,
  WRITING_MS,
  writtenJustNow,
} from "@collector/adapters/antigravity/app/index";
import { sqliteArguments } from "@collector/adapters/antigravity/app/summaries";
import { EMPTY_CHANGE_MEMORY, sessionChanges } from "@core/notices/sessionChanges";
import {
  AGY_HOME,
  annotationPath,
  APP_HOME,
  appStep,
  appTurn,
  conversationId,
  databasePath,
  DAY,
  failedTurn,
  HOME,
  MINUTE,
  NOW,
  SECOND,
  step,
  summariesPath,
  transcriptPath,
  workspaceUris,
} from "@tests/fixtures/antigravity";
import {
  antigravityAppAdapterFor,
  handClock,
  memoryFiles,
  standInHub,
  standInSqlite,
} from "@tests/support/adapters/antigravityAdapter";

const WORKING = conversationId("a1");
const IDLE = conversationId("b2");
const FAILED = conversationId("c3");
const OLD = conversationId("d4");
const FOLDER = "/Users/example/code/demo-project";
const HOUR_AGO = 60 * MINUTE;

/**
 * Antigravity 2.0's folder with a chat at work on its reply, an idle one, a
 * failed one, and one from two days ago, as the app writes them: only the
 * steps that are done.
 */
function setUp(running = true) {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const write = (id: string, lines: string[], mtimeMs: number) =>
    files.write(transcriptPath(APP_HOME, id), lines.join(""), { mtimeMs });
  write(WORKING, [appStep({ index: 0, type: "USER_INPUT", at: NOW - MINUTE })], NOW - MINUTE);
  write(IDLE, appTurn(0, NOW - 20 * MINUTE), NOW - 19 * MINUTE);
  write(FAILED, failedTurn(0, NOW - 40 * MINUTE), NOW - 39 * MINUTE);
  write(OLD, appTurn(0, NOW - 2 * DAY), NOW - 2 * DAY);
  files.write(summariesPath(APP_HOME), "SQLite format 3\u0000", { mtimeMs: NOW - HOUR_AGO });
  const hub = standInHub(running);
  const sqlite = standInSqlite();
  const adapter = antigravityAppAdapterFor(files, hub, sqlite, { now: clock.now });
  return { clock, files, hub, sqlite, adapter, write };
}

const statuses = (sessions: { id: string; status: string }[]) =>
  Object.fromEntries(sessions.map((session) => [session.id.split(":")[1], session.status]));

const DETAIL = `Sessions are read from the transcripts Antigravity keeps in ~/.gemini/antigravity/brain. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

describe("with Antigravity 2.0's folder there", () => {
  test("lists the chats of the last day by their last step while the app is open", async () => {
    const { adapter } = setUp();
    const result = await adapter.poll();
    expect(result.basis).toBe(BASIS);
    expect(result.health).toMatchObject({
      id: "antigravity-app",
      label: "Antigravity",
      state: "ok",
      detail: DETAIL,
      watching: [
        { label: "Conversations folder", value: "~/.gemini/antigravity/brain" },
        { label: "Read", value: "every 2 seconds" },
        { label: "Command", value: "ps -A -o comm=" },
        { label: "Command run", value: "every 10 seconds at most" },
        { label: "Folders file", value: "~/.gemini/antigravity/conversation_summaries.db" },
        { label: "Folders read", value: "with sqlite3, when the file changes" },
      ],
    });
    expect(statuses(result.sessions)).toEqual({
      [WORKING]: "working",
      [IDLE]: "idle",
      [FAILED]: "failed",
    });
    expect(result.sessions.find((session) => session.id.endsWith(IDLE))).toMatchObject({
      id: `antigravity-app:${IDLE}`,
      source: "antigravity-app",
      surface: "desktop",
      name: IDLE,
      cwd: null,
      startedAt: NOW - 20 * MINUTE,
      statusSince: NOW - 20 * MINUTE + 2 * SECOND,
      lastWriteAt: NOW - 19 * MINUTE,
      links: {},
    });
  });

  test("once the app is closed, every chat is finished, and one that failed stays failed", async () => {
    const { adapter } = setUp(false);
    expect(statuses((await adapter.poll()).sessions)).toEqual({
      [WORKING]: "finished",
      [IDLE]: "finished",
      [FAILED]: "failed",
    });
  });

  test("closing the app is named apart, so it finishes no chat in the notices, however often it is closed", async () => {
    const { adapter, clock, hub } = setUp();
    let memory = EMPTY_CHANGE_MEMORY;
    const read: { basis: string | undefined; statuses: Record<string, string> }[] = [];
    const changes: string[] = [];
    for (const running of [true, false, true, false]) {
      hub.set(running);
      const result = await adapter.poll();
      read.push({ basis: result.basis, statuses: statuses(result.sessions) });
      // As the poller puts it in the snapshot.
      const health = { ...result.health, basis: result.basis };
      const next = sessionChanges(memory, {
        generatedAt: clock.now(),
        sources: [health],
        sessions: result.sessions,
      });
      memory = next.memory;
      changes.push(...next.changes.map(({ event, session }) => `${session.name} ${event}`));
      clock.advance(PROCESS_CHECK_MS);
    }

    expect(changes).toEqual([]);
    const open = { [WORKING]: "working", [IDLE]: "idle", [FAILED]: "failed" };
    const closed = { [WORKING]: "finished", [IDLE]: "finished", [FAILED]: "failed" };
    expect(read).toEqual([
      { basis: BASIS, statuses: open },
      { basis: BASIS_APP_CLOSED, statuses: closed },
      { basis: BASIS, statuses: open },
      { basis: BASIS_APP_CLOSED, statuses: closed },
    ]);
  });

  test("no chat ever needs you: a reply that waits for approval shows as working or idle", async () => {
    const { adapter, write } = setUp();
    write(
      IDLE,
      [
        appStep({ index: 0, type: "USER_INPUT", at: NOW - 2 * MINUTE }),
        step({ index: 1, type: "PLANNER_RESPONSE", at: NOW - MINUTE, tools: ["run_command"] }),
        step({ index: 2, type: "RUN_COMMAND", status: "WAITING", at: NOW - MINUTE }),
      ],
      NOW - MINUTE,
    );
    const { sessions } = await adapter.poll();
    expect(statuses(sessions)).toMatchObject({ [IDLE]: "working" });
    expect(sessions.some((session) => session.status === "needs-you")).toBe(false);
    expect(sessions.some((session) => "waitingReason" in session)).toBe(false);
  });

  test("a chat whose last step is a done reply is working while its files are written, and idle once they are quiet", async () => {
    const { adapter, clock, files } = setUp();
    // The app writes the chat's database as a step goes, before the step is in the transcript.
    files.write(databasePath(APP_HOME, IDLE, true), "", { mtimeMs: NOW - 3 * SECOND });
    const busy = await adapter.poll();
    expect(busy.sessions.find((session) => session.id.endsWith(IDLE))).toMatchObject({
      status: "working",
      statusSince: NOW - 20 * MINUTE + 2 * SECOND,
      lastWriteAt: NOW - 3 * SECOND,
    });
    clock.advance(WRITING_MS - 3 * SECOND - 1);
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({ [IDLE]: "working" });
    clock.advance(1);
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({ [IDLE]: "idle" });
  });

  test("writes change nothing for a chat that failed, or one the app has closed", async () => {
    const { adapter, files } = setUp(false);
    files.write(databasePath(APP_HOME, IDLE, true), "", { mtimeMs: NOW - SECOND });
    files.write(databasePath(APP_HOME, FAILED, true), "", { mtimeMs: NOW - SECOND });
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({
      [IDLE]: "finished",
      [FAILED]: "failed",
    });
  });

  test("a chat written after ps said the app was closed is not finished, and ps is asked again within seconds", async () => {
    const { adapter, clock, hub, write } = setUp(false);
    await adapter.poll();
    expect(hub.asked()).toBe(1);

    // The app is opened, and a chat is written, before ps may be asked again.
    hub.set(true);
    clock.advance(PROMPT_PROCESS_CHECK_MS - SECOND);
    write(
      IDLE,
      [
        ...appTurn(0, NOW - 20 * MINUTE),
        appStep({ index: 2, type: "USER_INPUT", at: clock.now() }),
      ],
      clock.now(),
    );
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({
      [IDLE]: "working",
      [WORKING]: "finished",
    });
    expect(hub.asked()).toBe(1);

    clock.advance(SECOND);
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({
      [IDLE]: "working",
      [WORKING]: "working",
    });
    expect(hub.asked()).toBe(2);
  });

  test("asks ps at most every 10 seconds while the app is open", async () => {
    const { adapter, clock, hub } = setUp();
    await adapter.poll();
    clock.advance(PROCESS_CHECK_MS - SECOND);
    await adapter.poll();
    expect(hub.asked()).toBe(1);
    clock.advance(SECOND);
    await adapter.poll();
    expect(hub.asked()).toBe(2);
  });

  test("when ps cannot say, as on Linux and Windows, none is finished, and the poll is named apart", async () => {
    for (const [platform, sentence, run] of [
      [
        "darwin",
        "ps could not be run to tell whether Antigravity is open, so no chat is shown as finished.",
        "every 10 seconds at most",
      ],
      [
        "linux",
        "On Linux Agent Lookout cannot tell yet whether Antigravity is open, so no chat is shown as finished.",
        "not run on Linux",
      ],
      [
        "win32",
        "On Windows Agent Lookout cannot tell yet whether Antigravity is open, so no chat is shown as finished.",
        "not run on Windows",
      ],
    ] as const) {
      const { files, hub, sqlite } = setUp();
      hub.fail();
      const adapter = antigravityAppAdapterFor(files, hub, sqlite, { platform });
      const result = await adapter.poll();
      expect(result.basis, platform).toBe(BASIS_WITHOUT_PROCESSES);
      expect(result.health.detail, platform).toContain(sentence);
      expect(result.health.watching, platform).toContainEqual({ label: "Command run", value: run });
      expect(statuses(result.sessions), platform).toEqual({
        [WORKING]: "working",
        [IDLE]: "idle",
        [FAILED]: "failed",
      });
    }
  });

  test("a step it does not know shows as unknown, and the note says why", async () => {
    const { adapter, write } = setUp();
    write(
      IDLE,
      [step({ index: 0, type: "A_STEP_FROM_A_LATER_APP", at: NOW - MINUTE })],
      NOW - MINUTE,
    );
    const result = await adapter.poll();
    expect(statuses(result.sessions)).toMatchObject({ [IDLE]: "unknown" });
    expect(result.health.detail).toContain(UNKNOWN_STEP_NOTE);
  });

  test("with no chat from the last day, runs neither ps nor sqlite3 and lists nothing", async () => {
    const files = memoryFiles(() => NOW);
    files.write(transcriptPath(APP_HOME, OLD), appTurn(0, NOW - 2 * DAY).join(""), {
      mtimeMs: NOW - 2 * DAY,
    });
    files.write(summariesPath(APP_HOME), "SQLite format 3\u0000");
    const hub = standInHub();
    const sqlite = standInSqlite();
    const adapter = antigravityAppAdapterFor(files, hub, sqlite);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(hub.asked()).toBe(0);
    expect(sqlite.runs).toEqual([]);
    expect(files.count("openRegular")).toBe(0);
  });

  test("opens only transcripts and titles, and touches nothing outside its own folder", async () => {
    const { adapter, files } = setUp();
    files.write(databasePath(APP_HOME, IDLE), "SQLite format 3\u0000", { mtimeMs: NOW - MINUTE });
    files.write(`${APP_HOME}/brain/${IDLE}/.system_generated/logs/transcript_full.jsonl`, "{}\n");
    files.write(annotationPath(APP_HOME, IDLE), 'title:"Count the files"\n');
    files.write(transcriptPath(AGY_HOME, IDLE), appTurn(0, NOW - MINUTE).join(""));
    files.mkdir(`${HOME}/.gemini/antigravity-ide`);
    await adapter.poll();
    expect(
      files.opened().every((file) => file.endsWith("/transcript.jsonl") || file.endsWith(".pbtxt")),
    ).toBe(true);
    // Whole folders: the CLI's folder and the IDE's both begin with the app's name.
    expect(
      files.calls.every((call) => call.path === APP_HOME || call.path.startsWith(`${APP_HOME}/`)),
    ).toBe(true);
  });
});

describe("names and folders", () => {
  test("a chat is named by its title, and its folder is the first local one its row in the app's list names", async () => {
    const { adapter, files, sqlite } = setUp();
    files.write(annotationPath(APP_HOME, IDLE), 'title:"Count the files"\n');
    sqlite.set([
      { conversation_id: IDLE, workspace_uris: workspaceUris(FOLDER) },
      { conversation_id: FAILED, workspace_uris: workspaceUris("/Users/example/code/demo") },
    ]);
    const { sessions } = await adapter.poll();
    expect(sessions.find((session) => session.id.endsWith(IDLE))).toMatchObject({
      name: "Count the files",
      cwd: FOLDER,
      project: "demo-project",
    });
    expect(sessions.find((session) => session.id.endsWith(FAILED))).toMatchObject({
      name: "demo",
      cwd: "/Users/example/code/demo",
    });
    expect(sessions.find((session) => session.id.endsWith(WORKING))).toMatchObject({
      name: WORKING,
      cwd: null,
    });
    expect(sqlite.runs).toEqual([
      { binary: "/usr/bin/sqlite3", args: sqliteArguments(summariesPath(APP_HOME)) },
    ]);
  });

  test("the list is read again only once it changes", async () => {
    const { adapter, clock, files, sqlite } = setUp();
    await adapter.poll();
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(sqlite.runs).toHaveLength(1);
    sqlite.set([{ conversation_id: IDLE, workspace_uris: workspaceUris(FOLDER) }]);
    files.rewrite(summariesPath(APP_HOME), "SQLite format 3\u0000 more", { mtimeMs: clock.now() });
    clock.advance(2 * SECOND);
    const { sessions } = await adapter.poll();
    expect(sqlite.runs).toHaveLength(2);
    expect(sessions.find((session) => session.id.endsWith(IDLE))?.cwd).toBe(FOLDER);
  });

  test("with no sqlite3, or one that fails, chats show without a folder and the card says why", async () => {
    const missing = setUp();
    missing.sqlite.there(false);
    const without = await missing.adapter.poll();
    expect(without.health.detail).toBe(
      `${DETAIL} No sqlite3 program was found to read each chat's folder from ~/.gemini/antigravity/conversation_summaries.db, so chats show without one.`,
    );
    expect(without.sessions.every((session) => session.cwd === null)).toBe(true);

    const failing = setUp();
    failing.sqlite.fail();
    expect((await failing.adapter.poll()).health.detail).toBe(
      `${DETAIL} sqlite3 could not read each chat's folder from ~/.gemini/antigravity/conversation_summaries.db, so chats show without one.`,
    );
  });

  test("with no list of chats in the folder, chats show without a folder and nothing more is said", async () => {
    const { adapter, files, sqlite } = setUp();
    files.remove(summariesPath(APP_HOME));
    const result = await adapter.poll();
    expect(result.health.detail).toBe(DETAIL);
    expect(sqlite.runs).toEqual([]);
  });

  test("on Windows the list is not read, and the card says so", async () => {
    const { files, hub, sqlite } = setUp();
    hub.fail();
    const result = await antigravityAppAdapterFor(files, hub, sqlite, {
      platform: "win32",
    }).poll();
    expect(result.health.watching).toContainEqual({
      label: "Folders read",
      value: "not on Windows",
    });
    expect(sqlite.runs).toEqual([]);
  });
});

describe("with no Antigravity folder", () => {
  const NOT_FOUND =
    "Antigravity was not found: there is no ~/.gemini/antigravity folder. Agent Lookout looks again every minute.";

  test("says Antigravity was not found, calmly, runs nothing, and looks again once a minute", async () => {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    const hub = standInHub();
    const sqlite = standInSqlite();
    const adapter = antigravityAppAdapterFor(files, hub, sqlite, { now: clock.now });
    expect((await adapter.poll()).health).toMatchObject({
      id: "antigravity-app",
      state: "unavailable",
      detail: NOT_FOUND,
      watching: expect.arrayContaining([{ label: "Read", value: "not found" }]),
    });
    expect(files.calls).toEqual([{ method: "stat", path: APP_HOME }]);
    files.forget();
    clock.advance(RECHECK_MS - SECOND);
    expect((await adapter.poll()).health.detail).toBe(NOT_FOUND);
    expect(files.calls).toEqual([]);
    clock.advance(SECOND);
    await adapter.poll();
    expect(files.calls).toEqual([{ method: "stat", path: APP_HOME }]);
    expect(hub.asked()).toBe(0);
    expect(sqlite.runs).toEqual([]);
  });

  test("with the folder there and no chats saved yet, it is watched and says so", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(APP_HOME);
    const result = await antigravityAppAdapterFor(files, standInHub()).poll();
    expect(result.health).toMatchObject({
      state: "ok",
      detail: `Antigravity has not saved any chats in ~/.gemini/antigravity/brain yet. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
    });
    expect(result.sessions).toEqual([]);
  });

  test("a folder whose brain cannot be listed is an error, said plainly", async () => {
    const { files, hub, sqlite } = setUp();
    files.fail(`${APP_HOME}/brain`);
    const result = await antigravityAppAdapterFor(files, hub, sqlite).poll();
    expect(result.health).toMatchObject({
      state: "error",
      detail:
        "Antigravity chats could not be read: the folder ~/.gemini/antigravity/brain could not be listed.",
    });
  });
});

describe(ANTIGRAVITY_APP_HOME_ENV, () => {
  test("names the folder read in place of ~/.gemini/antigravity, and one with no chats is an answer", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(APP_HOME);
    const elsewhere = `${HOME}/code/demo/antigravity`;
    const adapter = antigravityAppAdapterFor(files, standInHub(), standInSqlite(), {
      env: { [ANTIGRAVITY_APP_HOME_ENV]: elsewhere },
    });
    expect((await adapter.poll()).health).toMatchObject({
      state: "ok",
      detail: `${ANTIGRAVITY_APP_HOME_ENV} is set to ~/code/demo/antigravity, which has no brain folder, so no Antigravity sessions are listed. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
    });
    expect(files.calls.filter((call) => call.path.startsWith(`${HOME}/.gemini`))).toEqual([]);
  });

  test("lists the chats in the folder it names", async () => {
    const files = memoryFiles(() => NOW);
    const elsewhere = `${HOME}/code/demo/antigravity`;
    files.write(transcriptPath(elsewhere, IDLE), appTurn(0, NOW - MINUTE).join(""), {
      mtimeMs: NOW - MINUTE,
    });
    const adapter = antigravityAppAdapterFor(files, standInHub(), standInSqlite(), {
      env: { [ANTIGRAVITY_APP_HOME_ENV]: ` ${elsewhere} ` },
    });
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [IDLE]: "idle" });
  });
});

describe("writtenJustNow", () => {
  test("is a write within 10 seconds either way of now", () => {
    expect(writtenJustNow(NOW - WRITING_MS + 1, NOW)).toBe(true);
    expect(writtenJustNow(NOW + SECOND, NOW)).toBe(true);
    expect(writtenJustNow(NOW - WRITING_MS, NOW)).toBe(false);
    expect(writtenJustNow(null, NOW)).toBe(false);
  });
});

test("carries its own declaration of what it can report, with No for Needs you and Yes for Tokens", () => {
  const adapter = antigravityAppAdapterFor(
    memoryFiles(() => NOW),
    standInHub(),
  );
  expect(adapter.capabilities).toBe(ANTIGRAVITY_APP_CAPABILITIES);
  expect(ANTIGRAVITY_APP_CAPABILITIES["needs-you"].level).toBe("no");
  expect(ANTIGRAVITY_APP_CAPABILITIES.tokens.level).toBe("yes");
  expect(adapter.lookingIn).toBe(
    "Looking for Antigravity sessions in ~/.gemini/antigravity/brain.",
  );
});

test("never throws: anything unexpected is a sentence", async () => {
  const { files, sqlite } = setUp();
  const adapter = antigravityAppAdapterFor(
    files,
    {
      ...standInHub(),
      reader: {
        read: () => {
          throw new Error("ps broke");
        },
      },
    },
    sqlite,
  );
  expect((await adapter.poll()).health).toMatchObject({
    state: "error",
    detail: "Something unexpected went wrong while reading Antigravity sessions.",
  });
});
