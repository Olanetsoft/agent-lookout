import { describe, expect, test } from "vitest";

import { createTailLimits } from "@collector/messages/tailReader";
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
  WINDOWS_NEEDS_YOU_NOTE,
  WRITING_MS,
  writtenJustNow,
} from "@collector/adapters/antigravity/app/index";
import { sqliteArguments } from "@collector/adapters/antigravity/app/summaries";
import { NEWEST_STEP_QUERY, WAITING_STATUS } from "@collector/adapters/antigravity/app/waits";
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
  replyStep,
  SECOND,
  step,
  summariesPath,
  textStep,
  transcriptPath,
  workspaceUris,
} from "@tests/fixtures/antigravity";
import {
  antigravityAppAdapterFor,
  handClock,
  memoryFiles,
  standInHub,
  standInSqlite,
  type MemoryFiles,
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
        { label: "Waits read", value: "with sqlite3, when a chat's database changes" },
        {
          label: "Last message read",
          value: "end of a chat's transcript, while its details are open",
        },
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

  test("no step of a transcript makes a chat need you on its own: a reply that waits for approval shows as working or idle", async () => {
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
        "ps could not be run to tell whether Antigravity is open, so no chat is shown as finished, and one left waiting when the app quit still shows as needing you, for up to a day.",
        "every 10 seconds at most",
      ],
      [
        "linux",
        "On Linux Agent Lookout cannot tell yet whether Antigravity is open, so no chat is shown as finished, and one left waiting when the app quit still shows as needing you, for up to a day.",
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

  test("on Linux with no sqlite3, the card never says a chat left waiting still needs you", async () => {
    for (const list of [true, false]) {
      const { files, hub, sqlite } = setUp();
      hub.fail();
      sqlite.there(false);
      // With the list there, only its reader looks for sqlite3, since no chat
      // has a database to read. Without it, only the wait reader does.
      if (!list) {
        files.remove(summariesPath(APP_HOME));
        files.write(databasePath(APP_HOME, IDLE), "SQLite format 3\u0000", {
          mtimeMs: NOW - MINUTE,
        });
      }
      const result = await antigravityAppAdapterFor(files, hub, sqlite, {
        platform: "linux",
      }).poll();
      expect(result.health.detail, `list ${list}`).toContain(
        "On Linux Agent Lookout cannot tell yet whether Antigravity is open, so no chat is shown as finished.",
      );
      expect(result.health.detail, `list ${list}`).not.toContain("still shows as needing you");
      expect(statuses(result.sessions)[IDLE], `list ${list}`).toBe("idle");
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
      `${DETAIL} No sqlite3 program was found to read each chat's folder from ~/.gemini/antigravity/conversation_summaries.db, or whether it waits for you, so chats show without one and never as needing you.`,
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

  test("on Windows neither the list nor a chat's database is read, and the card says so", async () => {
    const { files, hub, sqlite } = setUp();
    hub.fail();
    files.write(databasePath(APP_HOME, IDLE), "SQLite format 3\u0000", { mtimeMs: NOW - MINUTE });
    sqlite.step(IDLE, { idx: 2, status: WAITING_STATUS });
    const result = await antigravityAppAdapterFor(files, hub, sqlite, {
      platform: "win32",
    }).poll();
    expect(result.health.watching).toContainEqual({
      label: "Folders read",
      value: "not on Windows",
    });
    expect(result.health.watching).toContainEqual({ label: "Waits read", value: "not on Windows" });
    // The card never says there what is not so there.
    expect(result.health.detail).toContain(WINDOWS_NEEDS_YOU_NOTE);
    expect(result.health.detail).not.toContain(NEEDS_YOU_NOTE);
    expect(result.health.detail).not.toContain("still shows as needing you");
    expect(statuses(result.sessions)[IDLE]).toBe("idle");
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

test("carries its own declaration of what it can report, with Partly for Needs you and Yes for Tokens", () => {
  const adapter = antigravityAppAdapterFor(
    memoryFiles(() => NOW),
    standInHub(),
  );
  expect(adapter.capabilities).toBe(ANTIGRAVITY_APP_CAPABILITIES);
  expect(ANTIGRAVITY_APP_CAPABILITIES["needs-you"].level).toBe("partly");
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

describe("a chat that waits for approval", () => {
  /** The idle chat's database, written when its newest step began to wait, with that step in it. */
  function waiting(running = true) {
    const context = setUp(running);
    const writtenAt = NOW - 3 * MINUTE;
    context.files.write(databasePath(APP_HOME, IDLE), "SQLite format 3\u0000", {
      mtimeMs: writtenAt,
    });
    context.sqlite.step(IDLE, { idx: 2, status: WAITING_STATUS });
    return { ...context, writtenAt };
  }

  test("needs you, for permission, since its database was written, with nothing said of what it asks", async () => {
    const { adapter, sqlite, writtenAt } = waiting();
    const { sessions } = await adapter.poll();
    const chat = sessions.find((session) => session.id.endsWith(IDLE));
    expect(chat).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: writtenAt,
    });
    expect(chat).not.toHaveProperty("waitingDetail");
    expect(chat).not.toHaveProperty("waitingText");
    // Only the chat with a database is asked about, with the one question.
    expect(sqlite.stepRuns()).toHaveLength(1);
    expect(sqlite.stepRuns()[0]?.args.at(-1)).toBe(NEWEST_STEP_QUERY);
    expect(String(sqlite.stepRuns()[0]?.args.at(-2))).toMatch(
      // Joined with the test machine's own separator, which the address escapes on Windows.
      new RegExp(`(?:/|%5C)conversations(?:/|%5C)${IDLE}\\.db\\?mode=ro&immutable=1$`),
    );
  });

  test("is idle again once the step is answered and the database written", async () => {
    const { adapter, clock, files, sqlite } = waiting();
    await adapter.poll();
    sqlite.step(IDLE, { idx: 2, status: 3 });
    files.rewrite(databasePath(APP_HOME, IDLE), "SQLite format 3\u0000 more", {
      mtimeMs: clock.now() - 30 * SECOND,
    });
    clock.advance(2 * SECOND);
    expect(statuses((await adapter.poll()).sessions)[IDLE]).toBe("idle");
  });

  test("is finished once the app is closed, and its database is not read", async () => {
    const { adapter, sqlite } = waiting(false);
    expect(statuses((await adapter.poll()).sessions)[IDLE]).toBe("finished");
    expect(sqlite.stepRuns()).toEqual([]);
  });

  test("is not read while its database's -wal file is there, and shows as it would without it", async () => {
    const { adapter, files, sqlite } = waiting();
    files.write(databasePath(APP_HOME, IDLE, true), "", { mtimeMs: NOW - 3 * MINUTE });
    expect(statuses((await adapter.poll()).sessions)[IDLE]).toBe("idle");
    expect(sqlite.stepRuns()).toEqual([]);
  });

  test("with no sqlite3, a chat that waits shows as it would without it, and the card says so once", async () => {
    const withList = waiting();
    withList.sqlite.there(false);
    const said = (await withList.adapter.poll()).health.detail;
    expect(said).toContain(
      "or whether it waits for you, so chats show without one and never as needing you.",
    );
    expect(said).not.toContain("No sqlite3 program was found to read whether a chat waits for you");

    // With no list of chats to read, the folders' note says nothing, so the waits' note does.
    const withoutList = waiting();
    withoutList.sqlite.there(false);
    withoutList.files.remove(summariesPath(APP_HOME));
    const result = await withoutList.adapter.poll();
    expect(statuses(result.sessions)[IDLE]).toBe("idle");
    expect(result.health.detail).toBe(
      `${DETAIL} No sqlite3 program was found to read whether a chat waits for you, so none shows as needing you.`,
    );
  });

  test("a read that failed and a sqlite3 that is gone are both said, when the list of chats says neither", async () => {
    const { adapter, clock, files, sqlite } = waiting();
    sqlite.fail();
    await adapter.poll();
    // Within the minute a failed read is kept, sqlite3 goes, the list goes, and another chat's database appears.
    sqlite.fail(false);
    sqlite.there(false);
    files.remove(summariesPath(APP_HOME));
    files.write(databasePath(APP_HOME, WORKING), "SQLite format 3\u0000", { mtimeMs: NOW });
    clock.advance(2 * SECOND);
    const { health } = await adapter.poll();
    expect(health.detail).toContain(
      " No sqlite3 program was found to read whether a chat waits for you, so none shows as needing you.",
    );
    expect(health.detail).toContain(
      " sqlite3 could not read whether some chats wait for you, so they show as working or idle.",
    );
  });

  test("when sqlite3 cannot read it, the chat shows as it would without it and the card says so", async () => {
    const { adapter, sqlite } = waiting();
    sqlite.fail();
    const result = await adapter.poll();
    expect(statuses(result.sessions)[IDLE]).toBe("idle");
    expect(result.health.detail).toContain(
      "sqlite3 could not read whether some chats wait for you, so they show as working or idle.",
    );
  });
});

describe("what a chat last said", () => {
  const SAID = conversationId("f6");
  const ID = `antigravity-app:${SAID}`;
  const FILE = transcriptPath(APP_HOME, SAID);

  /** A chat whose newest reply with text is followed by one that only calls a tool, and its output. */
  function saying(
    options: Parameters<typeof antigravityAppAdapterFor>[3] = {},
    hub = standInHub(),
  ) {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    files.write(
      FILE,
      [
        textStep(0, "USER_INPUT", NOW - 2 * MINUTE, "Start"),
        replyStep({ index: 1, at: NOW - MINUTE, content: "The reply." }),
        replyStep({ index: 2, at: NOW - 30 * SECOND, tools: ["run_command"] }),
        textStep(3, "GENERIC", NOW - 20 * SECOND, "Output"),
      ].join(""),
      { mtimeMs: NOW - 20 * SECOND },
    );
    files.write(summariesPath(APP_HOME), "SQLite format 3\u0000", { mtimeMs: NOW - HOUR_AGO });
    const adapter = antigravityAppAdapterFor(files, hub, standInSqlite(), {
      now: clock.now,
      ...options,
    });
    return { clock, files, adapter };
  }

  test("is the newest reply's text for a listed chat, read from its transcript only when asked", async () => {
    const { adapter, files } = saying();
    await expect(adapter.lastMessage(ID)).resolves.toBeNull();
    await adapter.poll();
    files.forget();
    await expect(adapter.lastMessage(ID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
    expect(files.opened()).toEqual([FILE]);
    files.forget();
    await expect(
      adapter.lastMessage(`antigravity-app:${conversationId("99")}`),
    ).resolves.toBeNull();
    await expect(adapter.lastMessage(`antigravity-cli:${SAID}`)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("keeps none once the chat leaves the list, or after a poll that throws", async () => {
    const { adapter, clock, files } = saying();
    await adapter.poll();
    await adapter.lastMessage(ID);
    expect(adapter.lastMessagesKept).toBe(1);
    files.remove(FILE);
    clock.advance(SECOND);
    await adapter.poll();
    expect(adapter.lastMessagesKept).toBe(0);
    await expect(adapter.lastMessage(ID)).resolves.toBeNull();

    let broken = false;
    const hub = standInHub();
    const failing = saying(
      {},
      {
        ...hub,
        reader: {
          read: async () => {
            if (broken) throw new Error("ps broke");
            return { ok: true, running: true };
          },
        },
      },
    );
    await failing.adapter.poll();
    await failing.adapter.lastMessage(ID);
    expect(failing.adapter.lastMessagesKept).toBe(1);
    broken = true;
    failing.clock.advance(PROCESS_CHECK_MS);
    expect((await failing.adapter.poll()).health.state).toBe("error");
    expect(failing.adapter.lastMessagesKept).toBe(0);
    await expect(failing.adapter.lastMessage(ID)).resolves.toBeNull();
  });

  test.each([
    [{ AGENT_LOOKOUT_LAST_MESSAGE: "off" }, "AGENT_LOOKOUT_LAST_MESSAGE"],
    [{ AGENT_LOOKOUT_WAITING_TEXT: "off" }, "AGENT_LOOKOUT_WAITING_TEXT"],
  ])(
    "with %j, is off by that setting, and no transcript is opened for it",
    async (env, setting) => {
      const { adapter, files } = saying({ env });
      const result = await adapter.poll();
      expect(result.health.watching).toContainEqual({ label: "Last message read", value: "Off" });
      files.forget();
      await expect(adapter.lastMessage(ID)).resolves.toEqual({
        message: null,
        reason: "off",
        setting,
      });
      expect(files.calls).toEqual([]);
      expect(adapter.lastMessagesKept).toBe(0);
    },
  );

  test("a poll opens and reads the transcripts as it does with the reader off", async () => {
    const on = saying();
    const off = saying({ env: { AGENT_LOOKOUT_LAST_MESSAGE: "off" } });
    await on.adapter.poll();
    await off.adapter.poll();
    expect(on.files.count("openRegular")).toBeGreaterThan(0);
    expect(on.files.count("openRegular")).toBe(off.files.count("openRegular"));
    expect(on.files.reads).toEqual(off.files.reads);
  });

  test("counts its reads against the limits the collector shares", async () => {
    const limits = createTailLimits();
    let asked = 0;
    const lastMessageLimits = {
      ...limits,
      mayRead(at: number) {
        asked += 1;
        return limits.mayRead(at);
      },
    };
    const { adapter } = saying({ lastMessageLimits });
    await adapter.poll();
    expect(asked).toBe(0);
    await adapter.lastMessage(ID);
    expect(asked).toBe(1);
  });

  test.each([
    ["the folder has gone", (files: MemoryFiles) => files.remove(APP_HOME)],
    ["its brain folder cannot be listed", (files: MemoryFiles) => files.fail(`${APP_HOME}/brain`)],
  ])("a poll that ends early, as when %s, lists no chat, so none is read", async (_, change) => {
    const { adapter, clock, files } = saying();
    await adapter.poll();
    await adapter.lastMessage(ID);
    expect(adapter.lastMessagesKept).toBe(1);

    change(files);
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions ?? []).toEqual([]);
    expect(adapter.lastMessagesKept).toBe(0);
    files.forget();
    clock.advance(SECOND);
    await expect(adapter.lastMessage(ID)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("each chat's last message is its own, read from its own transcript and no other", async () => {
    const OTHER = conversationId("e5");
    const { adapter, files } = saying();
    files.write(
      transcriptPath(APP_HOME, OTHER),
      [
        textStep(0, "USER_INPUT", NOW - 3 * MINUTE, "Start"),
        replyStep({ index: 1, at: NOW - 10 * SECOND, content: "The other reply." }),
      ].join(""),
      { mtimeMs: NOW - 10 * SECOND },
    );
    const listed = (await adapter.poll()).sessions?.map((session) => session.id);
    expect(listed).toEqual(expect.arrayContaining([ID, `antigravity-app:${OTHER}`]));

    files.forget();
    await expect(adapter.lastMessage(ID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
    expect(files.opened()).toEqual([FILE]);
    files.forget();
    await expect(adapter.lastMessage(`antigravity-app:${OTHER}`)).resolves.toEqual({
      message: { text: "The other reply.", cut: false },
    });
    expect(files.opened()).toEqual([transcriptPath(APP_HOME, OTHER)]);
  });

  test("after an ask, the next poll still opens and reads the transcript as it does with the reader off, and the next ask sees what was added", async () => {
    const on = saying();
    const off = saying({ env: { AGENT_LOOKOUT_LAST_MESSAGE: "off" } });
    for (const side of [on, off]) {
      await side.adapter.poll();
      await side.adapter.lastMessage(ID);
      side.clock.advance(2 * SECOND);
      side.files.append(
        FILE,
        replyStep({ index: 4, at: side.clock.now(), content: "A newer reply." }),
        { mtimeMs: side.clock.now() },
      );
      side.files.forget();
      await side.adapter.poll();
    }
    expect(on.files.reads.length).toBeGreaterThan(0);
    expect(on.files.calls).toEqual(off.files.calls);
    expect(on.files.reads).toEqual(off.files.reads);
    await expect(on.adapter.lastMessage(ID)).resolves.toEqual({
      message: { text: "A newer reply.", cut: false },
    });
  });
});
