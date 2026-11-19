import { describe, expect, test } from "vitest";

import {
  createLogReader,
  foldLine,
  judgeLine,
  MAX_LOG_BYTES,
  PIECE_BYTES,
  timeAt,
  type LogRead,
} from "@collector/adapters/grok-build/eventLog";
import { emptyGrokBuildTurn, type GrokBuildTurn } from "@core/mapping/grok-build/grokBuildMapping";
import {
  eventsPath,
  firstToken,
  loopStarted,
  mcpServerStarting,
  MINUTE,
  NOW,
  permissionRequested,
  permissionResolved,
  phaseChanged,
  SECOND,
  SECRET,
  sessionFolder,
  SESSION_ID,
  toolCompleted,
  toolStarted,
  ts,
  turnEnded,
  turnStarted,
  wholeTurn,
} from "@tests/fixtures/grok-build/grokBuild";
import {
  appendEvents,
  memoryFiles,
  OTHER_UID,
  ownedFiles,
  TEST_UID,
  writeEvents,
  type MemoryFiles,
} from "@tests/support/adapters/grok-build/grokBuildAdapter";

const T = NOW - 5 * MINUTE;

function readerOf(files: MemoryFiles) {
  const owned = ownedFiles(files);
  return { owned, reader: createLogReader({ io: owned.io, platform: "darwin", euid: TEST_UID }) };
}

/** What a first read of this text says. */
async function firstRead(text: string, mtimeMs = NOW - SECOND): Promise<LogRead> {
  const files = memoryFiles();
  writeEvents(files, text, { mtimeMs });
  return readerOf(files).reader.read(SESSION_ID, sessionFolder());
}

async function turnOf(text: string): Promise<GrokBuildTurn> {
  const read = await firstRead(text);
  if (read.state !== "ok") throw new Error(`not read: ${read.state}`);
  return read.turn;
}

/** The fold of these lines, one at a time, as `judgeLine` and `foldLine` make it. */
function folded(text: string): GrokBuildTurn {
  const data = Buffer.from(text);
  let turn = emptyGrokBuildTurn();
  let at = 0;
  for (;;) {
    const newline = data.indexOf(0x0a, at);
    if (newline < 0) break;
    turn = foldLine(turn, judgeLine(data, at, newline));
    at = newline + 1;
  }
  return turn;
}

describe("a line", () => {
  test("counts when it is one Grok Build writes", () => {
    const data = Buffer.from(turnStarted(T).trimEnd());
    expect(judgeLine(data, 0, data.byteLength)).toEqual({ sort: "started", at: T, schemaOk: true });
  });

  test("does not count without its start, its time, its kind or its closing brace", () => {
    for (const text of [
      `{"type":"turn_started","ts":"${ts(T)}"}`,
      `{"ts":"2026-11-18 11:55:00.000Z","type":"first_token"}`,
      `{"ts":"2026-02-30T11:55:00.000Z","type":"first_token"}`,
      `{"ts":"2026-11-18T25:55:00.000Z","type":"first_token"}`,
      `{"ts":"2026-11-18T11:55:00Z","type":"first_token"}`,
      `{"ts":"${ts(T)}","type":"First_Token"}`,
      `{"ts":"${ts(T)}","type":""}`,
      `{"ts":"${ts(T)}","type":"${"a".repeat(65)}"}`,
      `{"ts":"${ts(T)}","type":"first_token"`,
      `{"ts":"${ts(T)}","type":"first_token"}\r`,
      `{"ts":"${ts(T)}", "type":"first_token"}`,
      "",
    ]) {
      const data = Buffer.from(text);
      expect(judgeLine(data, 0, data.byteLength), text).toEqual({ sort: "malformed" });
    }
  });

  test("two lines run together by a crash do not count", () => {
    const joined = `{"ts":"${ts(T)}","type":"tool_sta${turnEnded(T + SECOND, "interrupted")}`;
    const data = Buffer.from(joined.trimEnd());
    expect(judgeLine(data, 0, data.byteLength)).toEqual({ sort: "malformed" });
  });

  test("a time is worked out from its digits", () => {
    expect(timeAt(Buffer.from(ts(T)), 0)).toBe(T);
    expect(timeAt(Buffer.from("2026-11-18T11:55:00.12xZ"), 0)).toBeNull();
  });

  test("each outcome, and one Grok Build 1.0.45 does not write", () => {
    for (const outcome of ["completed", "cancelled", "error", "interrupted"]) {
      const data = Buffer.from(turnEnded(T, outcome).trimEnd());
      expect(judgeLine(data, 0, data.byteLength)).toEqual({ sort: "ended", at: T, outcome });
    }
    for (const outcome of ["crashed", "complete", "Completed"]) {
      const data = Buffer.from(turnEnded(T, outcome).trimEnd());
      expect(judgeLine(data, 0, data.byteLength)).toEqual({
        sort: "ended",
        at: T,
        outcome: "other",
      });
    }
  });

  test("the outcome is the first field, so one planted in cancellation_context is not read", () => {
    const text = `{"ts":"${ts(T)}","type":"turn_ended","cancellation_context":{"outcome":"completed"},"outcome":"error"}`;
    const data = Buffer.from(text);
    expect(judgeLine(data, 0, data.byteLength)).toEqual({ sort: "ended", at: T, outcome: "other" });
  });

  test("a turn of a newer format", () => {
    const data = Buffer.from(turnStarted(T, { schema_version: "2.0" }).trimEnd());
    expect(judgeLine(data, 0, data.byteLength)).toMatchObject({ sort: "started", schemaOk: false });
  });

  test("the format planted in the model's ID or a reason does not match", () => {
    const planted = turnStarted(T, {
      model_id: ',"schema_version":"1.0',
      schema_version: "2.0",
    }).trimEnd();
    const data = Buffer.from(planted);
    expect(judgeLine(data, 0, data.byteLength)).toMatchObject({ sort: "started", schemaOk: false });
  });

  test("the format past the first 512 bytes is not looked for", () => {
    const long = turnStarted(T, { model_id: "m".repeat(600) }).trimEnd();
    const data = Buffer.from(long);
    expect(judgeLine(data, 0, data.byteLength)).toMatchObject({ sort: "started", schemaOk: false });
  });

  test("only the question tool's own name opens a question", () => {
    const opens = (tool: string) => {
      const data = Buffer.from(toolStarted(T, tool).trimEnd());
      const line = judgeLine(data, 0, data.byteLength);
      return line.sort === "turn" && line.askOpened;
    };
    expect(opens("ask_user_question")).toBe(true);
    for (const tool of [
      "ask_user_question_x",
      "AskUserQuestion",
      "AskUser",
      "x_ask_user_question",
      `ask_user_question"},"x":"`,
    ]) {
      expect(opens(tool), tool).toBe(false);
    }
  });
});

describe("the fold", () => {
  test("each turn's start and end", async () => {
    expect(await turnOf(turnStarted(T))).toMatchObject({
      boundary: "started",
      at: T,
      schemaOk: true,
    });
    expect(await turnOf(wholeTurn(T))).toMatchObject({ boundary: "ended", outcome: "completed" });
    expect(await turnOf(wholeTurn(T, "error"))).toMatchObject({
      boundary: "ended",
      outcome: "error",
    });
    expect(await turnOf(wholeTurn(T) + turnStarted(T + 2 * SECOND))).toMatchObject({
      boundary: "started",
      at: T + 2 * SECOND,
    });
  });

  test("a log of a session's own lines alone, as an MCP server's, has no turn yet", async () => {
    const turn = await turnOf(mcpServerStarting(T) + mcpServerStarting(T + SECOND, "other"));
    expect(turn).toEqual(emptyGrokBuildTurn());
  });

  test("an empty log has no turn yet", async () => {
    expect(await turnOf("")).toEqual(emptyGrokBuildTurn());
  });

  test("a question opens with its call and closes with its result", async () => {
    const open = turnStarted(T) + loopStarted(T + 1) + toolStarted(T + SECOND, "ask_user_question");
    expect(await turnOf(open)).toMatchObject({ openQuestions: 1, questionSince: T + SECOND });
    expect(await turnOf(open + toolCompleted(T + 2 * SECOND, "ask_user_question"))).toMatchObject({
      openQuestions: 0,
      questionSince: null,
    });
  });

  test("a new round or waiting for the model closes every question", async () => {
    const open =
      turnStarted(T) +
      toolStarted(T + SECOND, "ask_user_question") +
      toolStarted(T + 2 * SECOND, "ask_user_question");
    expect(await turnOf(open)).toMatchObject({ openQuestions: 2, questionSince: T + SECOND });
    expect(await turnOf(open + loopStarted(T + 3 * SECOND, 1))).toMatchObject({
      openQuestions: 0,
      questionSince: null,
    });
    expect(await turnOf(open + phaseChanged(T + 3 * SECOND, "waiting_for_model"))).toMatchObject({
      openQuestions: 0,
    });
    expect(await turnOf(open + phaseChanged(T + 3 * SECOND, "tool_execution"))).toMatchObject({
      openQuestions: 2,
    });
  });

  test("a question's time is when the first open one was asked", async () => {
    const text =
      turnStarted(T) +
      toolStarted(T + SECOND, "ask_user_question") +
      toolStarted(T + 2 * SECOND, "ask_user_question") +
      toolCompleted(T + 3 * SECOND, "ask_user_question");
    expect(await turnOf(text)).toMatchObject({ openQuestions: 1, questionSince: T + SECOND });
  });

  test("a result of another tool closes no question", async () => {
    const text =
      turnStarted(T) +
      toolStarted(T + SECOND, "ask_user_question") +
      toolCompleted(T + 2 * SECOND, "ask_user_question_x") +
      toolCompleted(T + 2 * SECOND, "bash");
    expect(await turnOf(text)).toMatchObject({ openQuestions: 1 });
  });

  test("a plan's call keeps its time", async () => {
    const text =
      turnStarted(T) +
      toolStarted(T + SECOND, "exit_plan_mode") +
      toolStarted(T + 9 * SECOND, "exit_plan_mode");
    expect(await turnOf(text)).toMatchObject({ planToolAt: T + 9 * SECOND, outputSeen: true });
    expect(await turnOf(text + turnEnded(T + 10 * SECOND))).toMatchObject({ planToolAt: null });
  });

  test("what counts as the model writing", async () => {
    const start = turnStarted(T) + loopStarted(T + 1) + phaseChanged(T + 2, "waiting_for_model");
    expect(await turnOf(start)).toMatchObject({ outputSeen: false, turnLineAt: T + 2 });
    expect(await turnOf(start + permissionResolved(T + 3))).toMatchObject({ outputSeen: false });
    for (const added of [
      firstToken(T + 3),
      toolStarted(T + 3),
      permissionRequested(T + 3),
      phaseChanged(T + 3, "streaming_text"),
      phaseChanged(T + 3, "streaming_reasoning"),
      phaseChanged(T + 3, "tool_execution"),
      phaseChanged(T + 3, "permission_prompt"),
    ]) {
      expect(await turnOf(start + added), added).toMatchObject({
        outputSeen: true,
        turnLineAt: T + 3,
      });
    }
  });

  test("a line that does not count after the newest turn's line says nothing can be told, and one before it does not", async () => {
    const bad = `{"ts":"${ts(T)}","type":"tool_sta\n`;
    expect(await turnOf(turnStarted(T) + bad + firstToken(T + 1))).toMatchObject({
      malformed: true,
    });
    expect(await turnOf(bad + turnStarted(T) + firstToken(T + 1))).toMatchObject({
      malformed: false,
    });
    expect(await turnOf(bad + mcpServerStarting(T))).toMatchObject({
      malformed: true,
      boundary: "none",
    });
  });

  test("a line still being written waits until it is whole", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeEvents(files, turnStarted(T) + '{"ts":"', { mtimeMs: T });
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({
      state: "ok",
      turn: { boundary: "started", malformed: false },
    });
    appendEvents(files, `${ts(T + SECOND)}","type":"turn_ended","outcome":"completed"}\n`, {
      mtimeMs: T + SECOND,
    });
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({
      state: "ok",
      turn: { boundary: "ended", outcome: "completed", malformed: false },
    });
  });

  test("a line cut off by a crash and joined to the next says nothing can be told", async () => {
    const torn = turnStarted(T) + `{"ts":"${ts(T + 1)}","type":"tool_sta`;
    const turn = await turnOf(torn + turnEnded(T + MINUTE, "interrupted"));
    expect(turn).toMatchObject({ boundary: "started", malformed: true });
  });
});

describe("reading", () => {
  test("only what was added is read, and a fresh read of the same file gives the same", async () => {
    const lines = [
      mcpServerStarting(T - MINUTE),
      turnStarted(T),
      loopStarted(T + 1),
      `{"ts":"${ts(T + 2)}","type":"tool_sta\n`,
      toolStarted(T + 3, "ask_user_question"),
      toolStarted(T + 4, "exit_plan_mode"),
      firstToken(T + 5),
      toolCompleted(T + 6, "ask_user_question"),
      turnEnded(T + 7, "cancelled"),
      turnStarted(T + 8),
      toolStarted(T + 9, "ask_user_question"),
      mcpServerStarting(T + 10),
    ];
    for (let split = 0; split <= lines.length; split += 1) {
      const files = memoryFiles();
      const { reader } = readerOf(files);
      writeEvents(files, lines.slice(0, split).join(""), { mtimeMs: T });
      await reader.read(SESSION_ID, sessionFolder());
      appendEvents(files, lines.slice(split).join(""), { mtimeMs: T + MINUTE });
      const onwards = await reader.read(SESSION_ID, sessionFolder());
      const fresh = await firstRead(lines.join(""), T + MINUTE);
      expect(onwards, `split at ${split}`).toEqual(fresh);
      expect(onwards).toMatchObject({ state: "ok", turn: folded(lines.join("")) });
    }
  });

  test("a log that did not change is not opened again", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeEvents(files, wholeTurn(T), { mtimeMs: T });
    await reader.read(SESSION_ID, sessionFolder());
    files.forget();
    await reader.read(SESSION_ID, sessionFolder());
    expect(files.opened()).toEqual([]);
    expect(files.count("lstat")).toBe(1);
  });

  test("a log cut short or replaced is read from its end again", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeEvents(files, wholeTurn(T) + turnStarted(T + 2 * SECOND), { mtimeMs: T });
    await reader.read(SESSION_ID, sessionFolder());
    files.rewrite(eventsPath(), wholeTurn(T), { mtimeMs: T + SECOND });
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({
      turn: { boundary: "ended" },
    });
    writeEvents(files, turnStarted(T + 3 * SECOND), { mtimeMs: T + 2 * SECOND });
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({
      turn: { boundary: "started", at: T + 3 * SECOND },
    });
  });

  test("a log rewritten in place that no longer goes on from the last line is read again", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeEvents(files, turnStarted(T), { mtimeMs: T });
    await reader.read(SESSION_ID, sessionFolder());
    // The same length and more, but not the same bytes before what was added.
    const other = turnEnded(T, "error");
    files.rewrite(eventsPath(), `${other.slice(0, -1)} ${" ".repeat(400)}\n${firstToken(T + 1)}`, {
      mtimeMs: T + SECOND,
    });
    const read = await reader.read(SESSION_ID, sessionFolder());
    expect(read).toEqual(
      await firstRead(`${other.slice(0, -1)} ${" ".repeat(400)}\n${firstToken(T + 1)}`, T + SECOND),
    );
  });

  test("a log whose newest turn's line is not in its last 8 MiB says nothing", async () => {
    const padding = mcpServerStarting(T);
    const lines = Math.ceil(MAX_LOG_BYTES / padding.length) + 1;
    const turn = await turnOf(turnStarted(T) + padding.repeat(lines));
    expect(turn).toEqual({ ...emptyGrokBuildTurn(), tooFar: true });
    // A whole log of 8 MiB or less with no turn has none yet.
    const short = await turnOf(padding.repeat(Math.floor(MAX_LOG_BYTES / padding.length) - 1));
    expect(short).toEqual(emptyGrokBuildTurn());
    const long = await turnOf(padding.repeat(lines));
    expect(long).toEqual({ ...emptyGrokBuildTurn(), tooFar: true });
  });

  test("more than 8 MiB since the newest turn's line says nothing, read onwards or afresh, until a turn's line", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    const padding = mcpServerStarting(T);
    writeEvents(files, turnStarted(T), { mtimeMs: T });
    await reader.read(SESSION_ID, sessionFolder());
    const half = padding.repeat(Math.ceil(MAX_LOG_BYTES / 2 / padding.length));
    appendEvents(files, half, { mtimeMs: T + 1 });
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({
      turn: { tooFar: false },
    });
    appendEvents(files, half, { mtimeMs: T + 2 });
    const onwards = await reader.read(SESSION_ID, sessionFolder());
    expect(onwards).toMatchObject({ turn: { tooFar: true, boundary: "none" } });
    expect(onwards).toEqual(await firstRead(turnStarted(T) + half + half, T + 2));
    appendEvents(files, turnEnded(T + 3), { mtimeMs: T + 3 });
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({
      turn: { tooFar: false, boundary: "ended" },
    });
  });

  test("more than 8 MiB added at once is read from the end again", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    const padding = mcpServerStarting(T);
    writeEvents(files, turnStarted(T), { mtimeMs: T });
    await reader.read(SESSION_ID, sessionFolder());
    const added = padding.repeat(Math.ceil(MAX_LOG_BYTES / padding.length) + 1) + turnEnded(T + 1);
    appendEvents(files, added, { mtimeMs: T + 1 });
    files.forget();
    const read = await reader.read(SESSION_ID, sessionFolder());
    expect(read).toMatchObject({ turn: { boundary: "ended", tooFar: false } });
    // Read backwards from the end: the first read is the last piece, not all that was added.
    const size = Buffer.byteLength(turnStarted(T) + added);
    expect(files.reads[0]).toMatchObject({ position: size - PIECE_BYTES, length: PIECE_BYTES });
  });

  test("its time is the open file's, and never before its lstat's", async () => {
    const files = memoryFiles();
    const owned = ownedFiles(files);
    writeEvents(files, wholeTurn(T), { mtimeMs: T + 5 * SECOND });
    const io = {
      ...owned.io,
      async openRegular(file: string) {
        const open = await owned.io.openRegular(file);
        return { ...open, info: { ...open.info, mtimeMs: T } };
      },
    };
    const reader = createLogReader({ io, platform: "darwin", euid: TEST_UID });
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({
      writtenAt: T + 5 * SECOND,
    });
    const later = {
      ...owned.io,
      async openRegular(file: string) {
        const open = await owned.io.openRegular(file);
        return { ...open, info: { ...open.info, mtimeMs: T + 9 * SECOND } };
      },
    };
    const second = createLogReader({ io: later, platform: "darwin", euid: TEST_UID });
    expect(await second.read(SESSION_ID, sessionFolder())).toMatchObject({
      writtenAt: T + 9 * SECOND,
    });
  });

  test("a link, another user's log or one with a second name is never read, even after one that was", async () => {
    const files = memoryFiles();
    const { owned, reader } = readerOf(files);
    writeEvents(files, wholeTurn(T), { mtimeMs: T });
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({ state: "ok" });
    owned.set(eventsPath(), { nlink: 2 });
    expect(await reader.read(SESSION_ID, sessionFolder())).toEqual({ state: "unreadable" });
    owned.set(eventsPath(), { nlink: 1, uid: OTHER_UID });
    expect(await reader.read(SESSION_ID, sessionFolder())).toEqual({ state: "unreadable" });
    owned.clear(eventsPath());
    files.special(eventsPath());
    expect(await reader.read(SESSION_ID, sessionFolder())).toEqual({ state: "unreadable" });
    expect(await reader.writtenAt(sessionFolder())).toBeNull();
  });

  test("a log that cannot be read is not kept, and is read again next time", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeEvents(files, wholeTurn(T), { mtimeMs: T });
    files.failOpen(eventsPath());
    expect(await reader.read(SESSION_ID, sessionFolder())).toEqual({ state: "unreadable" });
    files.heal(eventsPath());
    expect(await reader.read(SESSION_ID, sessionFolder())).toMatchObject({ state: "ok" });
    expect(await reader.read(SESSION_ID, "/elsewhere")).toEqual({ state: "missing" });
  });

  test("its time by lstat alone, for a session that has ended", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    expect(await reader.writtenAt(sessionFolder())).toBeNull();
    writeEvents(files, wholeTurn(T), { mtimeMs: T });
    files.forget();
    expect(await reader.writtenAt(sessionFolder())).toBe(T);
    expect(files.opened()).toEqual([]);
  });

  test("it forgets the sessions it is told to", async () => {
    const files = memoryFiles();
    const { reader } = readerOf(files);
    writeEvents(files, wholeTurn(T), { mtimeMs: T });
    await reader.read(SESSION_ID, sessionFolder());
    expect(reader.kept).toBe(1);
    reader.keepOnly(new Set());
    expect(reader.kept).toBe(0);
  });

  test("nothing a field holds reaches what is kept", async () => {
    const text =
      turnStarted(T, { model_id: SECRET, session_id: SECRET }) +
      mcpServerStarting(T + 1, SECRET) +
      toolStarted(T + 2, SECRET) +
      `{"ts":"${ts(T + 3)}","type":"mcp_server_failed","error_message":"${SECRET}","target":"${SECRET}","url":"${SECRET}","sample":"${SECRET}"}\n` +
      turnEnded(T + 4, "cancelled", { cancellation_context: { trigger: SECRET, reason: SECRET } });
    const read = await firstRead(text);
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(read).toMatchObject({ state: "ok", turn: { boundary: "ended", outcome: "cancelled" } });
  });

  test("the question's name planted in a reason does not open one", async () => {
    const text =
      turnStarted(T) +
      `{"ts":"${ts(T + 1)}","type":"tool_started","tool_name":"bash","x":",\\"tool_name\\":\\"ask_user_question\\"}"}\n`;
    expect(await turnOf(text)).toMatchObject({ openQuestions: 0 });
  });
});
