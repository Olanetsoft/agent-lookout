import path from "node:path";

import { describe, expect, test } from "vitest";

import { LINE_LIMIT_BYTES } from "@collector/adapters/gemini-cli/chatFile";
import {
  GEMINI_CLI_CAPABILITIES,
  geminiCliFolder,
  OLDER_FORMAT_NOTE,
  RECHECK_MS,
  UNKNOWN_NOTE,
} from "@collector/adapters/gemini-cli/index";
import { geminiCliSessionId } from "@collector/adapters/gemini-cli/toSession";
import type { FileInfo, ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  chatFile,
  chatName,
  chatPath,
  contextLine,
  DAY,
  ENVIRONMENT_CONTEXT_ID,
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
  noticeLine,
  NOW,
  OTHER_PROJECT,
  OTHER_SLUG,
  patchLine,
  PRIVATE_WORDS,
  PROJECT,
  projectRootPath,
  resumedToolRoundAsOf063,
  sessionAsOf063,
  sessionIdOf,
  setLine,
  setMessagesLine,
  SLUG,
  titleLine,
  TMP_DIR,
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
  memoryFiles,
} from "@tests/support/adapters/geminiCliAdapter";

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
    expect(adapter.lookingIn).toBe("Looking for Gemini CLI sessions in ~/.gemini/tmp.");
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
        "Gemini CLI was not found: there is no ~/.gemini/tmp folder. Agent Lookout looks again every minute.",
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
      `Gemini CLI was not found: GEMINI_CLI_HOME is set, and there is no ${path.resolve("/Volumes/work/.gemini/tmp")} folder. Agent Lookout looks again every minute.`,
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
      { label: "Read", value: "every 2 seconds" },
      { label: "Files read", value: "chats/session-*.jsonl and .project_root in each project" },
      { label: "Programs run", value: "None" },
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
      "Gemini CLI sessions could not be read: the folder ~/.gemini/tmp could not be looked at.",
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
