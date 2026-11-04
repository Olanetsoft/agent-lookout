import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { LINE_LIMIT_BYTES } from "@collector/adapters/gemini-cli/chatFile";
import {
  GEMINI_CLI_CAPABILITIES,
  geminiCliFolder,
  geminiCliSeatbeltFolder,
  OLDER_FORMAT_NOTE,
  RECHECK_MS,
  UNKNOWN_NOTE,
} from "@collector/adapters/gemini-cli/index";
import { geminiCliSessionId } from "@collector/adapters/gemini-cli/toSession";
import { createEventStore } from "@collector/eventStore";
import type { FileInfo, ReadOnlyIo } from "@collector/files/readOnlyIo";
import { createHistoryStore } from "@collector/historyStore";
import { ANSWER_AGAIN_MS, createTailLimits } from "@collector/messages/tailReader";
import { createPoller } from "@collector/poller";
import {
  chatFile,
  chatName,
  chatPath,
  contextLine,
  DAY,
  ENVIRONMENT_CONTEXT_ID,
  failedRequestLine,
  GEMINI_DIR,
  geminiLine,
  headerLine,
  historyCopyLine,
  HOME,
  HOUR,
  idleSession,
  ids,
  messageIdOf,
  messagesAsOf063,
  MINUTE,
  MODEL,
  noticeLine,
  NOW,
  OTHER_PROJECT,
  OTHER_SLUG,
  patchLine,
  PRIVATE_WORDS,
  PROJECT,
  projectRootPath,
  REPLY_COUNTS,
  resumedToolRoundAsOf063,
  rewindLine,
  SEATBELT_DIR,
  SEATBELT_TMP_DIR,
  SECOND,
  sessionAsOf063,
  sessionIdOf,
  setLine,
  setMessagesLine,
  SLUG,
  titleLine,
  TMP_DIR,
  tokensOf,
  toolCall,
  toolResultLine,
  toolRoundAsOf063,
  updatedLine,
  userLine,
  workingSession,
} from "@tests/fixtures/gemini-cli/geminiCli";
import {
  folderTimes,
  geminiCliAdapterFor,
  handClock,
  healthy,
  LAST_MESSAGE_READ,
  memoryFiles,
} from "@tests/support/adapters/geminiCliAdapter";
import { asWritten } from "@tests/support/paths";

/** A session's id in Agent Lookout: its project's folder in tmp/ and its own id. */
const idOf = (sessionId: string, slug = SLUG) => geminiCliSessionId(slug, sessionId);

/** The stand-in files with one project and its two sessions: one working, one idle with a title. */
function withSessions() {
  const files = memoryFiles();
  files.write(projectRootPath(), PROJECT);
  files.write(chatPath(chatName(NOW - 10 * MINUTE, ids.working)), workingSession());
  files.write(
    chatPath(chatName(NOW - 30 * MINUTE, ids.idle)),
    idleSession(ids.idle, NOW - 30 * MINUTE, "Tidy the demo readme"),
  );
  return files;
}

describe("where it looks", () => {
  test("AGENT_LOOKOUT_GEMINI_CLI_HOME first, then .gemini in Gemini CLI's own GEMINI_CLI_HOME, then ~/.gemini", () => {
    expect(geminiCliFolder({}, HOME)).toEqual({ dir: path.resolve(GEMINI_DIR), from: "default" });
    expect(geminiCliFolder({ GEMINI_CLI_HOME: "/Volumes/work" }, HOME)).toEqual({
      dir: path.resolve("/Volumes/work/.gemini"),
      from: "gemini-cli",
    });
    expect(
      geminiCliFolder(
        { AGENT_LOOKOUT_GEMINI_CLI_HOME: " /Users/example/.cache/.gemini ", GEMINI_CLI_HOME: "/x" },
        HOME,
      ),
    ).toEqual({ dir: path.resolve("/Users/example/.cache/.gemini"), from: "agent-lookout" });
  });

  test("says where it looks before its first poll", () => {
    const adapter = geminiCliAdapterFor(memoryFiles());
    expect(adapter.lookingIn).toBe(
      "Looking for Gemini CLI sessions in ~/.gemini/tmp and ~/.cache/.gemini/tmp.",
    );
    expect(adapter.capabilities).toBe(GEMINI_CLI_CAPABILITIES);
  });
});

describe("when Gemini CLI is not there", () => {
  test("~/.gemini without tmp/, as Antigravity leaves it, is not found, and looked for again once a minute", async () => {
    const files = memoryFiles();
    files.mkdir(`${GEMINI_DIR}/antigravity`);
    const clock = handClock(NOW);
    const adapter = geminiCliAdapterFor(files, { now: clock.now });
    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({
      id: "gemini-cli",
      label: "Gemini CLI",
      state: "unavailable",
      detail:
        "Gemini CLI was not found: there is no ~/.gemini/tmp or ~/.cache/.gemini/tmp folder. Agent Lookout looks again every minute.",
    });
    expect(sessions).toEqual([]);

    files.forget();
    clock.advance(RECHECK_MS - 1);
    expect((await adapter.poll()).health.state).toBe("unavailable");
    expect(files.calls).toEqual([]);

    files.mkdir(TMP_DIR);
    clock.advance(1);
    expect((await adapter.poll()).health.state).toBe("ok");
  });

  test("a file named tmp is not Gemini CLI's folder of sessions", async () => {
    const files = memoryFiles();
    files.write(TMP_DIR, "placeholder");
    const { health, sessions } = await geminiCliAdapterFor(files).poll();
    expect(health.state).toBe("unavailable");
    expect(sessions).toEqual([]);
  });

  test("with GEMINI_CLI_HOME set, says so", async () => {
    const adapter = geminiCliAdapterFor(memoryFiles(), {
      env: { GEMINI_CLI_HOME: "/Volumes/work" },
    });
    expect((await adapter.poll()).health.detail).toBe(
      `Gemini CLI was not found: GEMINI_CLI_HOME is set, and there is no ${path.resolve("/Volumes/work/.gemini/tmp")} or ${path.resolve("/Volumes/work/.cache/.gemini/tmp")} folder. Agent Lookout looks again every minute.`,
    );
  });

  test("a folder named for Agent Lookout that holds no tmp/ is an answer: no sessions", async () => {
    const files = memoryFiles();
    const adapter = geminiCliAdapterFor(files, {
      env: { AGENT_LOOKOUT_GEMINI_CLI_HOME: "/Users/example/empty" },
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toMatch(
      /^AGENT_LOOKOUT_GEMINI_CLI_HOME is set to ~\/empty, which has no tmp folder, so no Gemini CLI sessions are listed\. /,
    );
    expect(sessions).toEqual([]);
    expect(basis).toBe("files");
    // It is looked for on every poll.
    files.forget();
    await adapter.poll();
    expect(files.count("stat")).toBe(1);
  });
});

describe("reading the sessions", () => {
  test("lists each session with its status, name, folder and times", async () => {
    const adapter = geminiCliAdapterFor(withSessions());
    const { health, sessions, basis } = await adapter.poll();
    expect(health).toMatchObject({ state: "ok", detail: healthy() });
    expect(health.watching).toEqual([
      { label: "Sessions folder", value: "~/.gemini/tmp" },
      { label: "Seatbelt sessions folder", value: "~/.cache/.gemini/tmp" },
      { label: "Read", value: "every 2 seconds" },
      { label: "Files read", value: "chats/session-*.jsonl and .project_root in each project" },
      { label: "Programs run", value: "None" },
      { label: "Last message read", value: LAST_MESSAGE_READ },
    ]);
    expect(basis).toBe("files");
    const byId = new Map(sessions.map((session) => [session.id, session]));
    expect(byId.get(idOf(ids.working))).toMatchObject({
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      status: "working",
      startedAt: NOW - 10 * MINUTE,
      statusSince: NOW - MINUTE,
      lastWriteAt: NOW,
      stale: false,
    });
    expect(byId.get(idOf(ids.idle))).toMatchObject({
      name: "Tidy the demo readme",
      status: "idle",
      statusSince: NOW - 28 * MINUTE,
    });
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
  });

  test("two projects that each hold a session of one id, as --session-id allows, list both", async () => {
    const files = memoryFiles();
    files.write(projectRootPath(), PROJECT);
    files.write(projectRootPath(OTHER_SLUG), OTHER_PROJECT);
    const shared = "review";
    files.write(
      chatPath(chatName(NOW - 30 * MINUTE, shared)),
      idleSession(shared, NOW - 30 * MINUTE),
    );
    files.write(
      chatPath(chatName(NOW - 10 * MINUTE, shared), OTHER_SLUG),
      workingSession(shared, NOW - 10 * MINUTE),
    );
    const adapter = geminiCliAdapterFor(files);
    const byId = (sessions: readonly { id: string }[]) =>
      [...sessions].sort((a, b) => (a.id < b.id ? -1 : 1));
    const first = await adapter.poll();
    expect(byId(first.sessions)).toEqual([
      expect.objectContaining({
        id: idOf(shared, OTHER_SLUG),
        cwd: OTHER_PROJECT,
        status: "working",
      }),
      expect.objectContaining({ id: idOf(shared), cwd: PROJECT, status: "idle" }),
    ]);
    // Each keeps its id from poll to poll.
    expect(byId((await adapter.poll()).sessions).map((session) => session.id)).toEqual([
      idOf(shared, OTHER_SLUG),
      idOf(shared),
    ]);
  });

  test("a session found in two files of one project is listed once, from the one active last", async () => {
    const files = withSessions();
    // A name after the working session's, so the older copy is read last.
    files.write(
      chatPath(chatName(NOW - 10 * MINUTE, ids.working, 9)),
      idleSession(ids.working, NOW - 3 * HOUR),
    );
    const { sessions } = await geminiCliAdapterFor(files).poll();
    const working = sessions.filter((session) => session.id === idOf(ids.working));
    expect(working).toHaveLength(1);
    expect(working[0]).toMatchObject({ status: "working", cwd: PROJECT });
  });

  test("a subagent's file is never listed", async () => {
    const files = memoryFiles();
    files.write(projectRootPath(), PROJECT);
    files.write(
      chatPath(chatName(NOW - MINUTE, sessionIdOf("09"))),
      chatFile([headerLine({ sessionId: sessionIdOf("09"), kind: "subagent" })]),
    );
    expect((await geminiCliAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("a session is left out a day after its last update, though a title added later moved its file's time", async () => {
    const files = memoryFiles();
    files.write(projectRootPath(), PROJECT);
    const old = chatPath(chatName(NOW - 2 * DAY, ids.idle));
    files.write(old, idleSession(ids.idle, NOW - 2 * DAY));
    // The next start in the same folder saves the title: the file's time moves, the update does not.
    files.append(old, `${titleLine("Tidy the demo readme")}\n`, { mtimeMs: NOW });
    expect((await geminiCliAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("a session in another project has that project's folder", async () => {
    const files = withSessions();
    files.write(projectRootPath(OTHER_SLUG), OTHER_PROJECT);
    files.write(
      chatPath(chatName(NOW - 5 * MINUTE, sessionIdOf("03")), OTHER_SLUG),
      workingSession(sessionIdOf("03"), NOW - 5 * MINUTE),
    );
    const { sessions } = await geminiCliAdapterFor(files).poll();
    expect(
      sessions.find((session) => session.id === idOf(sessionIdOf("03"), OTHER_SLUG)),
    ).toMatchObject({
      cwd: OTHER_PROJECT,
      project: "demo-api",
    });
  });

  test("says when a session is unknown, and when files of an older format changed", async () => {
    const files = withSessions();
    const unknown = chatPath(chatName(NOW - 5 * MINUTE, sessionIdOf("04")));
    files.write(
      unknown,
      chatFile([
        headerLine({ sessionId: sessionIdOf("04"), startTime: NOW - 5 * MINUTE }),
        userLine(messageIdOf("41"), NOW - 4 * MINUTE),
        geminiLine(messageIdOf("42"), NOW - 3 * MINUTE, {
          content: "",
          toolCalls: [toolCall("success", NOW - 2 * MINUTE)],
        }),
        updatedLine(NOW - 2 * MINUTE),
      ]),
    );
    files.write(chatPath("session-2026-10-01T08-00-00000000.json"), "{}");
    const { health, sessions } = await geminiCliAdapterFor(files).poll();
    expect(sessions.find((session) => session.id === idOf(sessionIdOf("04")))?.status).toBe(
      "unknown",
    );
    expect(health.detail).toBe(`${healthy()} ${OLDER_FORMAT_NOTE} ${UNKNOWN_NOTE}`);
  });

  test("a batch of tool calls just written is working until its results are due, then unknown", async () => {
    const files = memoryFiles();
    files.write(projectRootPath(), PROJECT);
    files.write(
      chatPath(chatName(NOW - 5 * MINUTE, sessionIdOf("05"))),
      chatFile([
        headerLine({ sessionId: sessionIdOf("05"), startTime: NOW - 5 * MINUTE }),
        userLine(messageIdOf("51"), NOW - MINUTE),
        updatedLine(NOW - MINUTE),
        geminiLine(messageIdOf("52"), NOW - 2_000, {
          content: "",
          toolCalls: [toolCall("success", NOW - 2_000)],
        }),
      ]),
    );
    const clock = handClock(NOW);
    const adapter = geminiCliAdapterFor(files, { now: clock.now });
    // Gemini CLI writes the tools' results a few moments after the batch.
    const first = await adapter.poll();
    expect(first.sessions[0]).toMatchObject({ status: "working", statusSince: NOW - MINUTE });
    expect(first.health.detail).toBe(healthy());

    // Nothing came after it, as a tool that stops the agent leaves it.
    clock.advance(30_000);
    const later = await adapter.poll();
    expect(later.sessions[0]).toMatchObject({ status: "unknown", statusSince: null });
    expect(later.health.detail).toBe(`${healthy()} ${UNKNOWN_NOTE}`);
  });

  test("a poll where nothing changed opens nothing", async () => {
    const files = withSessions();
    const clock = handClock(NOW);
    const adapter = geminiCliAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(2_000);
    await adapter.poll();
    expect(files.opened()).toEqual([]);
    expect(files.count("readdir")).toBe(0);
  });

  test("never throws: a file system that fails says so in a plain sentence", async () => {
    const files = withSessions();
    const adapter = geminiCliAdapterFor(files);
    files.failAll("EACCES");
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      "Gemini CLI sessions could not be read: the folder ~/.gemini/tmp could not be looked at, and the folder ~/.cache/.gemini/tmp could not be looked at.",
    );
    expect(sessions).toEqual([]);

    // tmp/ is there, but cannot be listed.
    files.failAll(null);
    files.fail(TMP_DIR);
    const listed = await geminiCliAdapterFor(files).poll();
    expect(listed.health.state).toBe("error");

    // A session file that cannot be read is passed over this poll.
    files.heal(TMP_DIR);
    files.fail(chatPath(chatName(NOW - 10 * MINUTE, ids.working)));
    const one = await geminiCliAdapterFor(files).poll();
    expect(one.health.state).toBe("ok");
    expect(one.sessions.map((session) => session.id)).toEqual([idOf(ids.idle)]);
  });
});

describe("a request that fails", () => {
  const sessionId = sessionIdOf("f1");
  const began = NOW - 10 * MINUTE;
  const prompt = messageIdOf("91");
  const error = messageIdOf("92");
  const failed = [
    headerLine({ sessionId, startTime: began }),
    userLine(prompt, NOW - 3 * MINUTE),
    updatedLine(NOW - 3 * MINUTE),
    rewindLine(prompt),
    updatedLine(NOW - 2 * MINUTE),
    failedRequestLine(error, NOW - 2 * MINUTE),
    updatedLine(NOW - 2 * MINUTE),
  ];

  function filesOf(lines: string[]) {
    const files = memoryFiles();
    files.write(projectRootPath(), PROJECT);
    files.write(chatPath(chatName(began, sessionId)), chatFile(lines));
    return files;
  }

  test("shows as failed from its error's time, with none of the error's text", async () => {
    const { sessions } = await geminiCliAdapterFor(filesOf(failed)).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      status: "failed",
      statusSince: NOW - 2 * MINUTE,
      stale: false,
    });
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
  });

  test("shows as working again from the prompt after it", async () => {
    const files = filesOf(failed);
    const adapter = geminiCliAdapterFor(files);
    await adapter.poll();
    files.append(
      chatPath(chatName(began, sessionId)),
      `${userLine(messageIdOf("93"), NOW - MINUTE)}\n${updatedLine(NOW - MINUTE)}\n`,
    );
    const { sessions } = await adapter.poll();
    expect(sessions[0]).toMatchObject({ status: "working", statusSince: NOW - MINUTE });
  });

  test("an error of another kind in its place stays idle", async () => {
    const lines = failed.with(5, noticeLine("error", error, NOW - 2 * MINUTE));
    const { sessions } = await geminiCliAdapterFor(filesOf(lines)).poll();
    expect(sessions[0]).toMatchObject({ status: "idle", statusSince: NOW - 2 * MINUTE });
  });
});

describe("a session taken up again with --resume or /resume", () => {
  const sessionId = sessionIdOf("06");
  const began = NOW - 3 * DAY;
  const [prompt, batch, result, last] = ["61", "62", "63", "64"].map(messageIdOf);

  /** A round of tools three days ago, then `last`. */
  function roundThen(lastLine: string, lastAt: number): string[] {
    return [
      headerLine({ sessionId, startTime: began }),
      contextLine(began + 100),
      updatedLine(began + 100),
      userLine(prompt ?? "", began + MINUTE),
      updatedLine(began + MINUTE),
      geminiLine(batch ?? "", began + 2 * MINUTE, {
        content: "",
        toolCalls: [toolCall("success", began + 3 * MINUTE)],
      }),
      updatedLine(began + 3 * MINUTE),
      toolResultLine(result ?? "", began + 3 * MINUTE),
      updatedLine(began + 3 * MINUTE),
      lastLine,
      updatedLine(lastAt),
    ];
  }

  /**
   * What Gemini CLI 0.64.0 writes as it takes the session up a minute before
   * `NOW`: the id, the batch's results written again, a patch that drops what
   * the model never sees and puts the list in its history's order, then the time.
   */
  function resumed(removeIds: string[], orderIds: string[]): string[] {
    return [
      setLine({ sessionId }),
      historyCopyLine(batch ?? "", NOW - MINUTE),
      patchLine({
        updates: [{ id: ENVIRONMENT_CONTEXT_ID, content: [{ text: "<session_context>" }] }],
        removeIds,
        orderIds,
      }),
      updatedLine(NOW - MINUTE),
    ];
  }

  const order = [ENVIRONMENT_CONTEXT_ID, prompt, batch, `${batch}_response`, result];

  async function sessionOf(lines: string[]) {
    const files = memoryFiles();
    files.write(projectRootPath(), PROJECT);
    files.write(chatPath(chatName(began, sessionId)), chatFile(lines));
    const { sessions } = await geminiCliAdapterFor(files).poll();
    return sessions[0];
  }

  test("is idle since it was taken up, and not stale, though its last reply is two days old", async () => {
    const lines = [
      ...roundThen(geminiLine(last ?? "", NOW - 2 * DAY), NOW - 2 * DAY),
      ...resumed([], [...order, last]),
    ];
    expect(await sessionOf(lines)).toMatchObject({
      status: "idle",
      statusSince: NOW - MINUTE,
      stale: false,
    });
  });

  test("is idle, not working, though its last round of tools ended in an error", async () => {
    const lines = [
      ...roundThen(noticeLine("error", last ?? "", NOW - 2 * DAY), NOW - 2 * DAY),
      ...resumed([last ?? ""], order),
    ];
    expect(await sessionOf(lines)).toMatchObject({ status: "idle", statusSince: NOW - MINUTE });
  });

  test("is working again from its next prompt", async () => {
    const lines = [
      ...roundThen(geminiLine(last ?? "", NOW - 2 * DAY), NOW - 2 * DAY),
      ...resumed([], [...order, last]),
      userLine(messageIdOf("65"), NOW - 30 * 1_000),
      updatedLine(NOW - 30 * 1_000),
    ];
    expect(await sessionOf(lines)).toMatchObject({
      status: "working",
      statusSince: NOW - 30 * 1_000,
    });
  });
});

describe("a session as Gemini CLI 0.44 to 0.63 wrote it, with $set of messages", () => {
  const sessionId = sessionIdOf("07");

  async function sessionOf(lines: string[], began: number) {
    const files = memoryFiles();
    files.write(projectRootPath(), PROJECT);
    files.write(chatPath(chatName(began, sessionId)), chatFile(lines));
    const { sessions } = await geminiCliAdapterFor(files).poll();
    return sessions[0];
  }

  test("is idle since its reply", async () => {
    const began = NOW - 30 * MINUTE;
    expect(await sessionOf(sessionAsOf063(sessionId, began), began)).toMatchObject({
      status: "idle",
      statusSince: began + 2 * MINUTE,
    });
  });

  test("a prompt whose request failed, taken back by a $set of messages, is failed since its error", async () => {
    const began = NOW - HOUR;
    const lines = [
      ...sessionAsOf063(sessionId, began),
      userLine(messageIdOf("73"), NOW - 3 * MINUTE),
      updatedLine(NOW - 3 * MINUTE),
      setMessagesLine(messagesAsOf063(began), NOW - 2 * MINUTE),
      failedRequestLine(messageIdOf("74"), NOW - 2 * MINUTE),
      updatedLine(NOW - 2 * MINUTE),
    ];
    expect(await sessionOf(lines, began)).toMatchObject({
      status: "failed",
      statusSince: NOW - 2 * MINUTE,
    });
  });

  test("taken up again, it is idle since then, and not stale, though its reply is three days old", async () => {
    const began = NOW - 3 * DAY;
    const lines = [
      ...sessionAsOf063(sessionId, began),
      setLine({ sessionId }),
      setMessagesLine(messagesAsOf063(began), NOW - MINUTE),
    ];
    expect(await sessionOf(lines, began)).toMatchObject({
      status: "idle",
      statusSince: NOW - MINUTE,
      stale: false,
    });
  });

  test("taken up again after a run that ended on its prompt, it is idle, not working", async () => {
    const began = NOW - 3 * DAY;
    const dying = userLine(messageIdOf("73"), NOW - 2 * DAY);
    const lines = [
      ...sessionAsOf063(sessionId, began),
      dying,
      updatedLine(NOW - 2 * DAY),
      setLine({ sessionId }),
      setMessagesLine([...messagesAsOf063(began), dying], NOW - MINUTE),
    ];
    expect(await sessionOf(lines, began)).toMatchObject({
      status: "idle",
      statusSince: NOW - MINUTE,
    });
  });

  describe("with a round of tools", () => {
    test("is working since its prompt while the model answers the tool's result", async () => {
      const began = NOW - 30 * MINUTE;
      expect(await sessionOf(toolRoundAsOf063(sessionId, began), began)).toMatchObject({
        status: "working",
        statusSince: began + MINUTE,
      });
    });

    test("taken up again after a run that stopped there, it is idle since then, not working", async () => {
      const began = NOW - 3 * DAY;
      const lines = [
        ...toolRoundAsOf063(sessionId, began),
        setLine({ sessionId }),
        resumedToolRoundAsOf063(began, NOW - MINUTE),
      ];
      expect(await sessionOf(lines, began)).toMatchObject({
        status: "idle",
        statusSince: NOW - MINUTE,
        stale: false,
      });
    });

    test("taken up again after its reply, it is idle since then", async () => {
      const began = NOW - 3 * DAY;
      const answer = geminiLine(messageIdOf("84"), began + 4 * MINUTE);
      const lines = [
        ...toolRoundAsOf063(sessionId, began),
        answer,
        updatedLine(began + 4 * MINUTE),
        setLine({ sessionId }),
        resumedToolRoundAsOf063(began, NOW - MINUTE, [answer]),
      ];
      expect(await sessionOf(lines, began)).toMatchObject({
        status: "idle",
        statusSince: NOW - MINUTE,
        stale: false,
      });
    });
  });

  test("first read from part way through a long file, taken up again, it is idle since then", async () => {
    const began = NOW - 3 * DAY;
    const [context = "", prompt = ""] = messagesAsOf063(began);
    // A reply long enough that the last 8 MiB of the file begin inside it.
    const longReply = geminiLine(messageIdOf("72"), began + 2 * MINUTE, {
      content: `${PRIVATE_WORDS} ${"y".repeat(Math.ceil(LINE_LIMIT_BYTES * 0.55))}`,
    });
    const resume = setMessagesLine([context, prompt, longReply], NOW - MINUTE);
    const lines = [
      headerLine({ sessionId, startTime: began }),
      setMessagesLine([context], began + 100),
      prompt,
      updatedLine(began + MINUTE),
      longReply,
      updatedLine(began + 2 * MINUTE),
      setLine({ sessionId }),
      resume,
    ];
    const after = [updatedLine(began + 2 * MINUTE), setLine({ sessionId }), resume];
    const fromReply = chatFile([longReply, ...after]).length;
    expect(fromReply).toBeGreaterThan(LINE_LIMIT_BYTES);
    expect(chatFile(after).length).toBeLessThan(LINE_LIMIT_BYTES);
    expect(await sessionOf(lines, began)).toMatchObject({
      status: "idle",
      statusSince: NOW - MINUTE,
      stale: false,
    });
  });

  test("a prompt stopped, which takes the prompt back with a $set of messages, is idle since then", async () => {
    const began = NOW - 30 * MINUTE;
    const lines = [
      ...sessionAsOf063(sessionId, began),
      userLine(messageIdOf("73"), NOW - MINUTE),
      updatedLine(NOW - MINUTE),
      setMessagesLine(messagesAsOf063(began), NOW - 30 * 1_000),
    ];
    expect(await sessionOf(lines, began)).toMatchObject({
      status: "idle",
      statusSince: NOW - 30 * 1_000,
    });
  });
});

describe("a session's token counts", () => {
  const sessionId = sessionIdOf("06");
  const COUNTED = idOf(sessionId);
  const began = NOW - 20 * MINUTE;
  const FILE = chatPath(chatName(began, sessionId));
  const OLDER = tokensOf({ input: 1_200, cached: 600, output: 80, thoughts: 40 });
  const NEWER = tokensOf({ input: 2_000, output: 50, thoughts: 0 });

  /** A session of two turns, each reply with counts of its own. */
  function counting() {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    files.write(projectRootPath(), PROJECT);
    files.write(
      FILE,
      chatFile([
        headerLine({ sessionId, startTime: began }),
        contextLine(began + 100),
        userLine(messageIdOf("61"), NOW - 10 * MINUTE),
        geminiLine(messageIdOf("62"), NOW - 9 * MINUTE, { tokens: OLDER }),
        updatedLine(NOW - 9 * MINUTE),
        userLine(messageIdOf("63"), NOW - 5 * MINUTE),
        geminiLine(messageIdOf("64"), NOW - 4 * MINUTE, { tokens: NEWER }),
        updatedLine(NOW - 4 * MINUTE),
      ]),
      { mtimeMs: NOW - 4 * MINUTE },
    );
    const adapter = geminiCliAdapterFor(files, { now: clock.now });
    /** Adds lines, then polls a poll later, and gives the session's counts. */
    const after = async (lines: string[], mtimeMs: number) => {
      files.append(FILE, chatFile(lines), { mtimeMs });
      clock.advance(2 * SECOND);
      return (await adapter.poll()).sessions.find((session) => session.id === COUNTED)?.tokens;
    };
    return { files, adapter, after };
  }

  test("are those of its newest reply, from the poll's read of its file, and nothing else of it", async () => {
    const { files, adapter } = counting();
    const { sessions } = await adapter.poll();
    expect(sessions.find((session) => session.id === COUNTED)?.tokens).toEqual({
      input: 2_000,
      output: 50,
    });
    // The poll opens the session's file and its folder's .project_root, nothing else.
    expect(files.opened().sort()).toEqual([FILE, projectRootPath()].sort());
    const kept = JSON.stringify(sessions);
    expect(kept).not.toContain(PRIVATE_WORDS);
    expect(kept).not.toContain(MODEL);
    expect(kept).not.toContain("thoughts");
  });

  test("of a session with no reply yet, are not there", async () => {
    const { sessions } = await geminiCliAdapterFor(withSessions()).poll();
    expect(sessions.find((session) => session.id === idOf(ids.working))).not.toHaveProperty(
      "tokens",
    );
    expect(sessions.find((session) => session.id === idOf(ids.idle))?.tokens).toEqual(REPLY_COUNTS);
  });

  test("stay as they were after a newer reply with none, and are none after one whose could not be right", async () => {
    const { adapter, after } = counting();
    await adapter.poll();
    // Gemini CLI writes `null` for a reply whose stream sent no usage.
    expect(
      await after(
        [
          userLine(messageIdOf("65"), NOW - 3 * MINUTE),
          geminiLine(messageIdOf("66"), NOW - 2 * MINUTE, { tokens: null }),
        ],
        NOW - 2 * MINUTE,
      ),
    ).toEqual({ input: 2_000, output: 50 });
    expect(
      await after(
        [
          userLine(messageIdOf("67"), NOW - 90 * SECOND),
          geminiLine(messageIdOf("68"), NOW - MINUTE, { tokens: tokensOf({ total: 0 }) }),
        ],
        NOW - MINUTE,
      ),
    ).toBeUndefined();
    expect(
      await after(
        [
          userLine(messageIdOf("69"), NOW - 50 * SECOND),
          geminiLine(messageIdOf("70"), NOW - 40 * SECOND, { tokens: OLDER }),
        ],
        NOW - 40 * SECOND,
      ),
    ).toEqual({ input: 1_200, cached: 600, output: 120 });
  });

  test("come from the line that writes the newest reply again with them", async () => {
    const { adapter, after } = counting();
    await adapter.poll();
    const reply = messageIdOf("66");
    expect(
      await after(
        [
          userLine(messageIdOf("65"), NOW - 3 * MINUTE),
          geminiLine(reply, NOW - 2 * MINUTE, { tokens: null }),
          // `recordMessageTokens`, when the newest message is a reply with none.
          geminiLine(reply, NOW - 2 * MINUTE, { tokens: OLDER }),
        ],
        NOW - 2 * MINUTE,
      ),
    ).toEqual({ input: 1_200, cached: 600, output: 120 });
  });

  test("are never those of a reply a $rewindTo took back, as /rewind writes", async () => {
    const { adapter, after } = counting();
    await adapter.poll();
    expect(await after([rewindLine(messageIdOf("63"))], NOW - MINUTE)).toEqual({
      input: 1_200,
      cached: 600,
      output: 120,
    });
  });

  test("are never those of a reply a $patch took back, as a declined tool can write", async () => {
    const { adapter, after } = counting();
    await adapter.poll();
    expect(await after([patchLine({ removeIds: [messageIdOf("64")] })], NOW - MINUTE)).toEqual({
      input: 1_200,
      cached: 600,
      output: 120,
    });
    expect(
      await after(
        [patchLine({ removeIds: [messageIdOf("61"), messageIdOf("62"), messageIdOf("63")] })],
        NOW - 30 * SECOND,
      ),
    ).toBeUndefined();
  });

  test("are never read from a subagent's file, though it holds a newer reply with counts", async () => {
    const { files, adapter } = counting();
    const subagentFolder = chatPath(`${sessionId}/agent-0001.jsonl`);
    const subagentFile = chatPath(chatName(NOW - MINUTE, sessionIdOf("07")));
    const theirs = tokensOf({ input: 777, output: 7, thoughts: 0 });
    for (const [file, id] of [
      [subagentFolder, "agent-0001"],
      [subagentFile, sessionIdOf("07")],
    ] as const) {
      files.write(
        file,
        chatFile([
          headerLine({ sessionId: id, startTime: NOW - MINUTE, kind: "subagent" }),
          geminiLine(messageIdOf("79"), NOW, { tokens: theirs }),
        ]),
      );
    }
    const { sessions } = await adapter.poll();
    expect(sessions.map((session) => session.tokens)).toEqual([{ input: 2_000, output: 50 }]);
    expect(JSON.stringify(sessions)).not.toContain("777");
    expect(files.opened()).not.toContain(subagentFolder);
  });

  test("are not in what a session last said", async () => {
    const { adapter } = counting();
    await adapter.poll();
    const answer = await adapter.lastMessage(COUNTED);
    expect(answer).toMatchObject({ message: { cut: false } });
    expect(answer).not.toHaveProperty("tokens");
  });
});

describe("what is kept between polls", () => {
  /**
   * The io, with every file given one identity, as a disk can give a new file
   * the number of one it deleted. Folders keep their own.
   */
  function reusingIdentities(io: ReadOnlyIo): ReadOnlyIo {
    const same = (info: FileInfo): FileInfo => (info.kind === "file" ? { ...info, ino: 1 } : info);
    return {
      ...io,
      stat: async (target) => same(await io.stat(target)),
      lstat: async (target) => same(await io.lstat(target)),
      openRegular: async (target) => {
        const open = await io.openRegular(target);
        return { ...open, info: same(open.info) };
      },
    };
  }

  /** Each text, with spaces before its last line's end until all are one length. JSON allows them. */
  function sameLength(...texts: string[]): string[] {
    const length = Math.max(...texts.map((text) => text.length));
    return texts.map((text) => `${text.slice(0, -1)}${" ".repeat(length - text.length)}\n`);
  }

  test("a session file that left the list is read afresh when it comes back, not from what was kept", async () => {
    const files = memoryFiles();
    files.write(projectRootPath(), PROJECT);
    const file = chatPath(chatName(NOW - 10 * MINUTE, ids.working));
    const [working = "", idle = ""] = sameLength(
      workingSession(),
      idleSession(ids.working, NOW - 10 * MINUTE),
    );
    files.write(file, working, { mtimeMs: NOW });
    const clock = handClock(NOW);
    const adapter = geminiCliAdapterFor(files, {
      now: clock.now,
      io: reusingIdentities(files.io),
    });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");

    // Removed, and gone once its folder is listed again.
    files.remove(file);
    clock.advance(30_000);
    expect((await adapter.poll()).sessions).toEqual([]);

    // A new file of the same name, size and time, and the identity the old one had.
    files.write(file, idle, { mtimeMs: NOW });
    clock.advance(30_000);
    expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
  });

  test("a project folder that went is listed and read afresh when it comes back", async () => {
    const files = memoryFiles();
    const timed = folderTimes(reusingIdentities(files.io));
    const clock = handClock(NOW);
    const adapter = geminiCliAdapterFor(files, { now: clock.now, io: timed.io });
    files.write(projectRootPath(), PROJECT, { mtimeMs: NOW });
    files.write(chatPath(chatName(NOW - 10 * MINUTE, ids.working)), workingSession());
    expect((await adapter.poll()).sessions.map((session) => session.cwd)).toEqual([PROJECT]);

    // The folder goes, and tmp/'s time moves.
    files.remove(`${TMP_DIR}/${SLUG}`);
    timed.touch(TMP_DIR, 1);
    clock.advance(2_000);
    expect((await adapter.poll()).sessions).toEqual([]);

    // It comes back at once, for another folder of the same length, with a second session.
    const moved = `${HOME}/code/demo-website`;
    files.write(projectRootPath(), moved, { mtimeMs: NOW });
    files.write(chatPath(chatName(NOW - 10 * MINUTE, ids.working)), workingSession());
    files.write(
      chatPath(chatName(NOW - 30 * MINUTE, ids.idle)),
      idleSession(ids.idle, NOW - 30 * MINUTE),
    );
    timed.touch(TMP_DIR, 2);
    clock.advance(2_000);
    const back = (await adapter.poll()).sessions;
    expect(back.map((session) => session.id).sort()).toEqual(
      [idOf(ids.idle), idOf(ids.working)].sort(),
    );
    expect(back.map((session) => session.cwd)).toEqual([moved, moved]);
  });
});

describe("what a session last said", () => {
  const sessionId = sessionIdOf("08");
  const SAID = idOf(sessionId);
  const began = NOW - 20 * MINUTE;
  const FILE = chatPath(chatName(began, sessionId));
  const [prompt = "", answered = "", batch = "", result = ""] = ["81", "82", "83", "84"].map(
    messageIdOf,
  );

  /** A session whose newest reply with text is followed by one that only calls a tool, and its result. */
  function saying(options: Parameters<typeof geminiCliAdapterFor>[1] = {}) {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    files.write(projectRootPath(), PROJECT);
    files.write(
      FILE,
      chatFile([
        headerLine({ sessionId, startTime: began }),
        contextLine(began + 100),
        userLine(prompt, NOW - 2 * MINUTE),
        geminiLine(answered, NOW - MINUTE, { content: "The reply." }),
        geminiLine(batch, NOW - 30 * SECOND, {
          content: "",
          toolCalls: [toolCall("success", NOW - 25 * SECOND)],
        }),
        toolResultLine(result, NOW - 20 * SECOND),
        updatedLine(NOW - 20 * SECOND),
      ]),
      { mtimeMs: NOW - 20 * SECOND },
    );
    const adapter = geminiCliAdapterFor(files, { now: clock.now, ...options });
    return { clock, files, adapter };
  }

  test("is the newest reply's text for a listed session, read from its file only when asked", async () => {
    const { adapter, files } = saying();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    await adapter.poll();
    files.forget();
    const answer = await adapter.lastMessage(SAID);
    expect(answer).toEqual({ message: { text: "The reply.", cut: false } });
    expect(JSON.stringify(answer)).not.toContain(PRIVATE_WORDS);
    expect(files.opened()).toEqual([FILE]);
    files.forget();
    await expect(adapter.lastMessage(idOf(sessionIdOf("09")))).resolves.toBeNull();
    await expect(adapter.lastMessage(`codex:${sessionId}`)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a poll reads the session files as it does with the reader off, and puts no message on a session", async () => {
    const on = saying();
    const off = saying({ env: { AGENT_LOOKOUT_LAST_MESSAGE: "off" } });
    const [onResult] = [await on.adapter.poll(), await off.adapter.poll()];
    expect(on.files.count("openRegular")).toBeGreaterThan(0);
    expect(on.files.count("openRegular")).toBe(off.files.count("openRegular"));
    expect(on.files.reads).toEqual(off.files.reads);
    expect(JSON.stringify(onResult?.sessions)).not.toContain("The reply.");
  });

  test("a poll after an ask puts nothing of the reply on a session", async () => {
    const { adapter, clock } = saying();
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
    clock.advance(2 * SECOND);
    const next = await adapter.poll();
    expect(next.sessions.map((session) => session.id)).toContain(SAID);
    expect(adapter.lastMessagesKept).toBe(1);
    expect(JSON.stringify(next)).not.toContain("The reply.");
  });

  test("Sources says it reads the end of a session's file while its details are open", async () => {
    const { adapter } = saying();
    expect((await adapter.poll()).health.watching).toContainEqual({
      label: "Last message read",
      value: "end of a session's file, while its details are open",
    });
  });

  test.each([
    [{ AGENT_LOOKOUT_LAST_MESSAGE: "off" }, "AGENT_LOOKOUT_LAST_MESSAGE"],
    [{ AGENT_LOOKOUT_WAITING_TEXT: "off" }, "AGENT_LOOKOUT_WAITING_TEXT"],
  ])("with %j, is off by that setting, and no file is opened for it", async (env, setting) => {
    const { adapter, files } = saying({ env });
    const result = await adapter.poll();
    expect(result.health.watching).toContainEqual({ label: "Last message read", value: "Off" });
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: null,
      reason: "off",
      setting,
    });
    expect(files.calls).toEqual([]);
    expect(adapter.lastMessagesKept).toBe(0);
  });

  test("a reply Gemini CLI takes back is not shown once its $rewindTo is written", async () => {
    const { adapter, clock, files } = saying();
    await adapter.poll();
    files.append(
      FILE,
      chatFile([
        userLine(messageIdOf("85"), NOW - 10 * SECOND),
        geminiLine(messageIdOf("86"), NOW - 5 * SECOND, { content: "A reply taken back." }),
      ]),
    );
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "A reply taken back.", cut: false },
    });

    files.append(FILE, chatFile([rewindLine(messageIdOf("85")), updatedLine(NOW)]));
    clock.advance(ANSWER_AGAIN_MS);
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("of two files of one session, is read from the one it was listed from, the one active last", async () => {
    const { adapter, clock, files } = saying();
    const older = chatPath(chatName(began, sessionId, 1));
    files.write(
      older,
      chatFile([
        headerLine({ sessionId, startTime: began }),
        geminiLine(messageIdOf("87"), NOW - 10 * MINUTE, { content: "An older copy." }),
        updatedLine(NOW - 10 * MINUTE),
      ]),
    );
    await adapter.poll();
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
    expect(files.opened()).toEqual([FILE]);

    // The other is written to later, and the next poll lists the session from it.
    files.append(
      older,
      chatFile([geminiLine(messageIdOf("88"), NOW, { content: "The copy goes on." })]),
    );
    clock.advance(2 * SECOND);
    await adapter.poll();
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The copy goes on.", cut: false },
    });
    expect(files.opened()).toEqual([older]);
  });

  test("never reads a subagent's file, though it holds a newer reply", async () => {
    const { adapter, files } = saying();
    const subagent = chatPath(`${sessionId}/agent-0001.jsonl`);
    files.write(
      subagent,
      chatFile([
        headerLine({ sessionId: "agent-0001", kind: "subagent" }),
        geminiLine(messageIdOf("89"), NOW, { content: PRIVATE_WORDS }),
      ]),
    );
    await adapter.poll();
    files.forget();
    const answer = await adapter.lastMessage(SAID);
    expect(answer).toEqual({ message: { text: "The reply.", cut: false } });
    expect(JSON.stringify(answer)).not.toContain(PRIVATE_WORDS);
    expect(files.opened()).toEqual([FILE]);
  });

  test("keeps none once the session leaves the list, or after a poll that cannot list the sessions", async () => {
    const { adapter, clock, files } = saying();
    await adapter.poll();
    await adapter.lastMessage(SAID);
    expect(adapter.lastMessagesKept).toBe(1);

    files.fail(TMP_DIR);
    clock.advance(SECOND);
    expect((await adapter.poll()).health.state).toBe("error");
    expect(adapter.lastMessagesKept).toBe(0);
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(files.calls).toEqual([]);

    // Listed again, it is read again.
    files.heal(TMP_DIR);
    clock.advance(SECOND);
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });

    // A day after its last update, it has left the list, and nothing of it is kept or read.
    clock.advance(DAY);
    expect((await adapter.poll()).sessions.map((session) => session.id)).not.toContain(SAID);
    expect(adapter.lastMessagesKept).toBe(0);
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a session whose file could not be read this poll is not listed, and not read until a poll lists it", async () => {
    const { adapter, clock, files } = saying();
    await adapter.poll();
    files.fail(FILE);
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions.map((session) => session.id)).not.toContain(SAID);
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(files.calls).toEqual([]);

    files.heal(FILE);
    clock.advance(SECOND);
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("is dropped, and nothing may be read, after a poll that throws, and is read again once a poll lists the session", async () => {
    const clock = handClock(NOW);
    let broken = false;
    // A clock that throws once, as nothing in a poll is expected to.
    const now = () => {
      if (broken) {
        broken = false;
        throw new Error("A stand-in that throws.");
      }
      return clock.now();
    };
    const { adapter, files } = saying({ now });
    await adapter.poll();
    await adapter.lastMessage(SAID);
    expect(adapter.lastMessagesKept).toBe(1);

    broken = true;
    clock.advance(SECOND);
    const failed = await adapter.poll();
    expect(failed.health.state).toBe("error");
    expect(failed.health.detail).toBe(
      "Something unexpected went wrong while reading Gemini CLI sessions.",
    );
    expect(adapter.lastMessagesKept).toBe(0);
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(files.calls).toEqual([]);

    clock.advance(SECOND);
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
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
    await adapter.lastMessage(SAID);
    expect(asked).toBe(1);
  });
});

describe("the folder Gemini CLI keeps under macOS Seatbelt", () => {
  const homeSession = sessionIdOf("31");
  const seatbeltSession = sessionIdOf("32");
  const seatbeltFile = chatPath(
    chatName(NOW - 30 * MINUTE, seatbeltSession),
    SLUG,
    SEATBELT_TMP_DIR,
  );

  /** A session's id when it was read from ~/.cache/.gemini. */
  const seatbeltIdOf = (sessionId: string, slug = SLUG) =>
    geminiCliSessionId(slug, sessionId, true);

  /** The id a session in ~/.gemini had before this folder was read, worked out here as it was then. */
  const idAsBefore = (sessionId: string, slug = SLUG) =>
    `gemini-cli:${sessionId}.${createHash("sha256").update(slug).digest("hex").slice(0, 8)}`;

  /** The Seatbelt folder's session: idle after a reply that says this. */
  const seatbeltLines = (says = "The reply under Seatbelt.") =>
    chatFile([
      headerLine({ sessionId: seatbeltSession, startTime: NOW - 30 * MINUTE }),
      userLine(messageIdOf("33"), NOW - 3 * MINUTE),
      geminiLine(messageIdOf("34"), NOW - 2 * MINUTE, { content: says }),
      updatedLine(NOW - 2 * MINUTE),
    ]);

  /** A working session in ~/.gemini and an idle one in ~/.cache/.gemini, in a project folder of the same name in each. */
  function inBoth(files = memoryFiles()) {
    files.write(projectRootPath(), PROJECT);
    files.write(chatPath(chatName(NOW - 10 * MINUTE, homeSession)), workingSession(homeSession));
    files.write(projectRootPath(SLUG, SEATBELT_TMP_DIR), PROJECT);
    files.write(seatbeltFile, seatbeltLines());
    return files;
  }

  const sorted = (sessions: readonly { id: string }[]) =>
    [...sessions].sort((a, b) => (a.id < b.id ? -1 : 1));

  test("is ~/.cache/.gemini, or .cache/.gemini in Gemini CLI's own GEMINI_CLI_HOME, on a Mac alone, and none with AGENT_LOOKOUT_GEMINI_CLI_HOME set", () => {
    expect(geminiCliSeatbeltFolder({}, HOME, "darwin")).toBe(path.resolve(SEATBELT_DIR));
    expect(geminiCliSeatbeltFolder({ GEMINI_CLI_HOME: "/Volumes/work" }, HOME, "darwin")).toBe(
      path.resolve("/Volumes/work/.cache/.gemini"),
    );
    expect(
      geminiCliSeatbeltFolder({ AGENT_LOOKOUT_GEMINI_CLI_HOME: GEMINI_DIR }, HOME, "darwin"),
    ).toBeNull();
    expect(geminiCliSeatbeltFolder({}, HOME, "linux")).toBeNull();
    expect(geminiCliSeatbeltFolder({}, HOME, "win32")).toBeNull();
  });

  test("on a Mac, the sessions in both folders are listed with no setting, and those in ~/.gemini keep their ids", async () => {
    const adapter = geminiCliAdapterFor(inBoth());
    const { health, sessions } = await adapter.poll();
    expect(health).toMatchObject({ state: "ok", detail: healthy() });
    expect(sorted(sessions)).toEqual([
      expect.objectContaining({
        id: idAsBefore(homeSession),
        cwd: PROJECT,
        status: "working",
      }),
      expect.objectContaining({
        id: `${idAsBefore(seatbeltSession)}.seatbelt`,
        cwd: PROJECT,
        status: "idle",
        statusSince: NOW - 2 * MINUTE,
      }),
    ]);
    expect(idOf(homeSession)).toBe(idAsBefore(homeSession));
    expect(seatbeltIdOf(seatbeltSession)).toBe(`${idAsBefore(seatbeltSession)}.seatbelt`);
  });

  test("a project folder of the same name in both, with a session of one id in each, as --session-id allows, gives two sessions whose ids differ", async () => {
    const files = memoryFiles();
    const shared = "review";
    files.write(projectRootPath(), PROJECT);
    files.write(projectRootPath(SLUG, SEATBELT_TMP_DIR), OTHER_PROJECT);
    files.write(
      chatPath(chatName(NOW - 30 * MINUTE, shared)),
      idleSession(shared, NOW - 30 * MINUTE),
    );
    files.write(
      chatPath(chatName(NOW - 10 * MINUTE, shared), SLUG, SEATBELT_TMP_DIR),
      workingSession(shared, NOW - 10 * MINUTE),
    );
    // A second file of the Seatbelt folder's session, older, which is not listed apart.
    files.write(
      chatPath(chatName(NOW - 10 * MINUTE, shared, 9), SLUG, SEATBELT_TMP_DIR),
      idleSession(shared, NOW - 3 * HOUR),
    );
    const adapter = geminiCliAdapterFor(files);
    const first = await adapter.poll();
    expect(sorted(first.sessions)).toEqual([
      expect.objectContaining({ id: idOf(shared), cwd: PROJECT, status: "idle" }),
      expect.objectContaining({ id: seatbeltIdOf(shared), cwd: OTHER_PROJECT, status: "working" }),
    ]);
    expect(idOf(shared)).not.toBe(seatbeltIdOf(shared));
    // Each keeps its id from poll to poll.
    expect(sorted((await adapter.poll()).sessions).map((session) => session.id)).toEqual([
      idOf(shared),
      seatbeltIdOf(shared),
    ]);
  });

  test("with sessions in both folders, a poll where nothing changed opens nothing and lists no folder", async () => {
    const files = inBoth();
    const clock = handClock(NOW);
    const adapter = geminiCliAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toHaveLength(2);
    expect(files.opened()).toEqual([]);
    expect(files.count("readdir")).toBe(0);
  });

  test("with only ~/.cache/.gemini/tmp there, Gemini CLI is found and its sessions listed", async () => {
    const files = memoryFiles();
    files.write(projectRootPath(SLUG, SEATBELT_TMP_DIR), PROJECT);
    files.write(seatbeltFile, seatbeltLines());
    const { health, sessions } = await geminiCliAdapterFor(files).poll();
    expect(health).toMatchObject({ state: "ok", detail: healthy() });
    expect(sessions.map((session) => session.id)).toEqual([seatbeltIdOf(seatbeltSession)]);
  });

  test("with neither there, Gemini CLI is not found, both are looked for once a minute, and one that comes is found", async () => {
    const files = memoryFiles();
    const clock = handClock(NOW);
    const adapter = geminiCliAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).health).toMatchObject({
      state: "unavailable",
      detail:
        "Gemini CLI was not found: there is no ~/.gemini/tmp or ~/.cache/.gemini/tmp folder. Agent Lookout looks again every minute.",
    });
    expect(files.calls).toEqual([
      { method: "stat", path: TMP_DIR },
      { method: "stat", path: SEATBELT_TMP_DIR },
    ]);

    files.forget();
    clock.advance(RECHECK_MS - 1);
    expect((await adapter.poll()).health.state).toBe("unavailable");
    expect(files.calls).toEqual([]);

    files.write(projectRootPath(SLUG, SEATBELT_TMP_DIR), PROJECT);
    files.write(seatbeltFile, seatbeltLines());
    clock.advance(1);
    const found = await adapter.poll();
    expect(found.health.state).toBe("ok");
    expect(found.sessions.map((session) => session.id)).toEqual([seatbeltIdOf(seatbeltSession)]);
  });

  test("while ~/.gemini/tmp is there and ~/.cache/.gemini/tmp is not, the second costs one stat a poll", async () => {
    const files = withSessions();
    const clock = handClock(NOW);
    const adapter = geminiCliAdapterFor(files, { now: clock.now });
    await adapter.poll();
    for (let poll = 0; poll < 2; poll += 1) {
      files.forget();
      clock.advance(2 * SECOND);
      expect((await adapter.poll()).sessions).toHaveLength(2);
      expect(files.calls.filter((call) => call.path.startsWith(SEATBELT_DIR))).toEqual([
        { method: "stat", path: SEATBELT_TMP_DIR },
      ]);
    }
  });

  test("with AGENT_LOOKOUT_GEMINI_CLI_HOME set, only the folder it names is read, as Gemini CLI's own", async () => {
    const files = inBoth();
    const own = geminiCliAdapterFor(files, { env: { AGENT_LOOKOUT_GEMINI_CLI_HOME: GEMINI_DIR } });
    const { health, sessions } = await own.poll();
    expect(sessions.map((session) => session.id)).toEqual([idOf(homeSession)]);
    expect(health.detail).toBe(healthy("~/.gemini/tmp"));
    expect(health.watching?.map((fact) => fact.label)).not.toContain("Seatbelt sessions folder");
    expect(own.lookingIn).toBe("Looking for Gemini CLI sessions in ~/.gemini/tmp.");
    expect(files.calls.filter((call) => call.path.startsWith(SEATBELT_DIR))).toEqual([]);

    // Named, the Seatbelt folder is read alone, and its sessions' ids are as they were with the setting before.
    files.forget();
    const named = geminiCliAdapterFor(files, {
      env: { AGENT_LOOKOUT_GEMINI_CLI_HOME: SEATBELT_DIR },
    });
    expect((await named.poll()).sessions.map((session) => session.id)).toEqual([
      idOf(seatbeltSession),
    ]);
    expect(files.calls.filter((call) => call.path.startsWith(GEMINI_DIR))).toEqual([]);
  });

  test.each(["linux", "win32"] as const)("on %s, only ~/.gemini is read", async (platform) => {
    const files = inBoth();
    const adapter = geminiCliAdapterFor(files, { platform });
    const { health, sessions } = await adapter.poll();
    expect(sessions.map((session) => session.id)).toEqual([idOf(homeSession)]);
    expect(health.detail).toBe(healthy("~/.gemini/tmp"));
    expect(adapter.lookingIn).toBe("Looking for Gemini CLI sessions in ~/.gemini/tmp.");
    expect(files.calls.filter((call) => call.path.startsWith(SEATBELT_DIR))).toEqual([]);

    // Not found names ~/.gemini alone.
    const none = await geminiCliAdapterFor(memoryFiles(), { platform }).poll();
    expect(none.health.detail).toBe(
      "Gemini CLI was not found: there is no ~/.gemini/tmp folder. Agent Lookout looks again every minute.",
    );
  });

  test("what a session in ~/.cache/.gemini last said is read from its own file there, and only when asked", async () => {
    const files = inBoth();
    const adapter = geminiCliAdapterFor(files);
    await adapter.poll();
    files.forget();
    await expect(adapter.lastMessage(seatbeltIdOf(seatbeltSession))).resolves.toEqual({
      message: { text: "The reply under Seatbelt.", cut: false },
    });
    expect(files.opened()).toEqual([seatbeltFile]);
    // The id it would have in ~/.gemini names no session listed.
    files.forget();
    await expect(adapter.lastMessage(idOf(seatbeltSession))).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a folder that is there and cannot be read makes the poll an error that says which, though the other was read", async () => {
    const files = inBoth();
    const adapter = geminiCliAdapterFor(files);
    expect((await adapter.poll()).sessions).toHaveLength(2);

    files.fail(SEATBELT_TMP_DIR);
    const looked = await adapter.poll();
    expect(looked.health).toMatchObject({
      state: "error",
      detail:
        "Gemini CLI sessions could not be read: the folder ~/.cache/.gemini/tmp could not be looked at.",
    });
    expect(looked.health.watching).toContainEqual({ label: "Read", value: "cannot be read" });
    expect(looked.sessions).toEqual([]);
    // A poll that lists no session leaves none whose last message may be read.
    files.forget();
    await expect(adapter.lastMessage(idOf(homeSession))).resolves.toBeNull();
    expect(files.calls).toEqual([]);

    // Gemini CLI's own folder that cannot be looked at is named the same way.
    files.heal(SEATBELT_TMP_DIR);
    files.fail(TMP_DIR);
    expect((await adapter.poll()).health).toMatchObject({
      state: "error",
      detail:
        "Gemini CLI sessions could not be read: the folder ~/.gemini/tmp could not be looked at.",
    });

    // There, but it cannot be listed, and with the other that cannot be looked at, both are named.
    const unlisted: ReadOnlyIo = {
      ...files.io,
      readdir: (dir) =>
        asWritten(dir) === SEATBELT_TMP_DIR
          ? Promise.reject(Object.assign(new Error("Refused."), { code: "EACCES" }))
          : files.io.readdir(dir),
    };
    expect((await geminiCliAdapterFor(files, { io: unlisted }).poll()).health).toMatchObject({
      state: "error",
      detail:
        "Gemini CLI sessions could not be read: the folder ~/.gemini/tmp could not be looked at, and the folder ~/.cache/.gemini/tmp could not be listed.",
    });
    files.heal(TMP_DIR);
    expect((await geminiCliAdapterFor(files, { io: unlisted }).poll()).health).toMatchObject({
      state: "error",
      detail:
        "Gemini CLI sessions could not be read: the folder ~/.cache/.gemini/tmp could not be listed.",
    });

    // Once both can be read, both folders' sessions are listed again.
    const again = await adapter.poll();
    expect(again.health).toMatchObject({ state: "ok", detail: healthy() });
    expect(sorted(again.sessions).map((session) => session.id)).toEqual([
      idOf(homeSession),
      seatbeltIdOf(seatbeltSession),
    ]);

    // With the other missing, a folder that cannot be read is an error, as before.
    files.remove(TMP_DIR);
    files.fail(SEATBELT_TMP_DIR);
    expect((await geminiCliAdapterFor(files).poll()).health).toMatchObject({
      state: "error",
      detail:
        "Gemini CLI sessions could not be read: the folder ~/.cache/.gemini/tmp could not be looked at.",
    });
  });

  test("a folder that cannot be read for one poll ends no session in it, and brings none back", async () => {
    const files = inBoth();
    let failNext = false;
    // Listing ~/.cache/.gemini/tmp fails once, as when too many files are open.
    const io: ReadOnlyIo = {
      ...files.io,
      readdir: (dir) => {
        if (failNext && asWritten(dir) === SEATBELT_TMP_DIR) {
          failNext = false;
          return Promise.reject(Object.assign(new Error("Too many."), { code: "EMFILE" }));
        }
        return files.io.readdir(dir);
      },
    };
    const events = createEventStore();
    const history = createHistoryStore();
    const adapter = geminiCliAdapterFor(files, { io, listRefreshMs: 0 });
    const poller = createPoller({ adapters: [adapter], events, history, now: () => NOW });
    const states: string[] = [];
    for (let poll = 0; poll < 3; poll += 1) {
      failNext = poll === 1;
      states.push((await poller.pollOnce()).sources[0]?.state ?? "none");
    }
    expect(states).toEqual(["ok", "error", "ok"]);
    expect(events.list()).toEqual([]);
    // The poll that could not read it is left out of the history, not drawn with fewer sessions.
    expect(history.list(Infinity, NOW).map((point) => point.total)).toEqual([2, 2]);
  });

  test("the two folders made one by a link are read once, as Gemini CLI's own", async () => {
    const files = withSessions();
    // ~/.cache/.gemini/tmp a link to ~/.gemini/tmp: the same folder, and the same path once links are followed.
    const followed = (target: string) => {
      const written = asWritten(target);
      return written === SEATBELT_TMP_DIR || written.startsWith(`${SEATBELT_TMP_DIR}/`)
        ? `${TMP_DIR}${written.slice(SEATBELT_TMP_DIR.length)}`
        : written;
    };
    const linked: ReadOnlyIo = {
      readdir: (target) => files.io.readdir(followed(target)),
      stat: (target) => files.io.stat(followed(target)),
      lstat: (target) => files.io.lstat(followed(target)),
      openRegular: (target) => files.io.openRegular(followed(target)),
      realpath: (target) => Promise.resolve(followed(target)),
    };
    const { sessions } = await geminiCliAdapterFor(files, { io: linked }).poll();
    expect(sorted(sessions).map((session) => session.id)).toEqual(
      [idOf(ids.working), idOf(ids.idle)].sort(),
    );
    // Through the link only its tmp/ was looked at, once.
    expect(files.count("stat", (target) => target === TMP_DIR)).toBe(2);
    expect(files.count("readdir", (target) => target === TMP_DIR)).toBe(1);
  });

  test("two folders of one identity are read once when the system cannot follow links, or fails to", async () => {
    const files = inBoth();
    const homeIno = (await files.io.stat(TMP_DIR)).ino;
    // No way to follow links: the stand-in files have none.
    const sameIno: ReadOnlyIo = {
      ...files.io,
      stat: async (target) => {
        const info = await files.io.stat(target);
        return asWritten(target) === SEATBELT_TMP_DIR ? { ...info, ino: homeIno } : info;
      },
    };
    expect(
      (await geminiCliAdapterFor(files, { io: sameIno }).poll()).sessions.map((s) => s.id),
    ).toEqual([idOf(homeSession)]);
    const failing: ReadOnlyIo = {
      ...sameIno,
      realpath: () => Promise.reject(Object.assign(new Error("Refused."), { code: "EACCES" })),
    };
    expect(
      (await geminiCliAdapterFor(files, { io: failing }).poll()).sessions.map((s) => s.id),
    ).toEqual([idOf(homeSession)]);
  });

  test("links are not followed while the two folders' identities differ", async () => {
    const files = inBoth();
    let asked = 0;
    const io: ReadOnlyIo = {
      ...files.io,
      realpath: (target) => {
        asked += 1;
        return Promise.resolve(target);
      },
    };
    expect((await geminiCliAdapterFor(files, { io }).poll()).sessions).toHaveLength(2);
    expect(asked).toBe(0);
  });

  test("the system the adapter is given says whether a project folder's case is asked", async () => {
    const files = inBoth();
    let asked = 0;
    const io: ReadOnlyIo = {
      ...files.io,
      realpath: (target) => {
        asked += 1;
        return Promise.resolve(target);
      },
    };
    await geminiCliAdapterFor(files, { io, platform: "win32" }).poll();
    expect(asked).toBeGreaterThan(0);
  });

  test("two folders of the same identity on different disks are both read", async () => {
    const files = inBoth();
    const homeIno = (await files.io.stat(TMP_DIR)).ino;
    const sameIno: ReadOnlyIo = {
      ...files.io,
      stat: async (target) => {
        const info = await files.io.stat(target);
        return asWritten(target) === SEATBELT_TMP_DIR ? { ...info, ino: homeIno } : info;
      },
      realpath: (target) => Promise.resolve(target),
    };
    const { sessions } = await geminiCliAdapterFor(files, { io: sameIno }).poll();
    expect(sorted(sessions).map((session) => session.id)).toEqual([
      idOf(homeSession),
      seatbeltIdOf(seatbeltSession),
    ]);
  });
});
