import { describe, expect, test } from "vitest";

import { idOf, judgeLine, LINE_MAX, passesFilter } from "@collector/adapters/copilot-cli/records";
import {
  aborted,
  CWD,
  event,
  other,
  permissionCompleted,
  permissionRequested,
  PRIVATE_WORDS,
  reply,
  sessionError,
  sessionResume,
  SESSION_ID,
  sessionStart,
  shutdown,
  taskComplete,
  toolEnd,
  toolStart,
  turnEnd,
  turnStart,
  userMessage,
} from "@tests/fixtures/copilot-cli/copilotCli";

const T = Date.UTC(2026, 10, 20, 11, 0, 0);
const FOLDER = Buffer.from(SESSION_ID);

/** A line, without its line break, as the reader hands it on. */
const bytes = (line: string) => Buffer.from(line.endsWith("\n") ? line.slice(0, -1) : line);

const judge = (line: string, platform: NodeJS.Platform = "darwin") =>
  judgeLine(bytes(line), true, FOLDER, platform);

const recordOf = (line: string, platform?: NodeJS.Platform) => {
  const judged = judge(line, platform);
  return judged.sort === "record" ? judged.record : null;
};

describe("each type read", () => {
  test("session.start gives its folder and its time, when its sessionId is the folder's", () => {
    expect(recordOf(sessionStart(T))).toEqual({ sort: "start", cwd: CWD, at: T });
    expect(recordOf(sessionStart(T, { id: "0aaa0000-0000-4000-8000-000000000099" }))).toEqual({
      sort: "unreadable",
    });
    // A folder that is not a whole path, or holds a control character, is none.
    expect(recordOf(sessionStart(T, { cwd: "code/demo" }))).toEqual({
      sort: "start",
      cwd: null,
      at: T,
    });
    expect(recordOf(sessionStart(T, { cwd: "/Users/example/a\u0007b" }))).toMatchObject({
      cwd: null,
    });
    expect(recordOf(sessionStart(T, { cwd: 7 }))).toMatchObject({ cwd: null });
    // On Windows a folder is judged on its rules.
    expect(recordOf(sessionStart(T, { cwd: "C:\\Users\\example\\code" }), "win32")).toMatchObject({
      cwd: "C:\\Users\\example\\code",
    });
  });

  test("session.resume gives its folder and whether Copilot goes on with pending work", () => {
    expect(recordOf(sessionResume(T))).toEqual({
      sort: "resume",
      cwd: CWD,
      continuePending: false,
      at: T,
    });
    expect(recordOf(sessionResume(T, { continuePending: true }))).toMatchObject({
      continuePending: true,
    });
    expect(recordOf(sessionResume(T, { continuePending: false }))).toMatchObject({
      continuePending: false,
    });
    // A resume that joined work another client runs keeps it pending too.
    expect(recordOf(sessionResume(T, { wasActive: true }))).toMatchObject({
      continuePending: true,
    });
    expect(recordOf(sessionResume(T, { continuePending: false, wasActive: false }))).toMatchObject({
      continuePending: false,
    });
  });

  test("a user's message, an abort and an error give their time alone", () => {
    expect(recordOf(userMessage(T))).toEqual({ sort: "user", at: T });
    expect(recordOf(aborted(T))).toEqual({ sort: "abort", at: T });
    expect(recordOf(sessionError(T))).toEqual({ sort: "error", at: T });
  });

  test("a task's completion gives whether the run goes on, by its outcome, and its time", () => {
    expect(recordOf(taskComplete(T, "completed"))).toEqual({
      sort: "task-complete",
      goesOn: false,
      at: T,
    });
    expect(recordOf(taskComplete(T, "continue"))).toMatchObject({ goesOn: true });
    // Blocked, no outcome, another word or not a string do not tell.
    for (const outcome of ["blocked", undefined, "done", 1]) {
      expect(recordOf(taskComplete(T, outcome)), String(outcome)).toMatchObject({ goesOn: null });
    }
  });

  test("a turn's start and end give its ID, and a sub-agent's its parent call", () => {
    expect(recordOf(turnStart("0", T))).toEqual({
      sort: "turn-start",
      turn: "0",
      sub: null,
      at: T,
    });
    expect(recordOf(turnEnd("3", T))).toEqual({ sort: "turn-end", turn: "3", sub: null, at: T });
    expect(recordOf(turnStart("0", T, { parent: "call-9", agentId: "agent-1" }))).toEqual({
      sort: "turn-start",
      turn: "0",
      sub: "call-9",
      at: T,
    });
    // A sub-agent's turn with no parent call is passed over.
    expect(judge(turnStart("0", T, { agentId: "agent-1" }))).toEqual({ sort: "passed" });
    // One with no turn ID cannot be read.
    expect(recordOf(event("assistant.turn_start", {}, T))).toEqual({ sort: "unreadable" });
  });

  test("a reply says whether it asked for tools, and a sub-agent's is passed over", () => {
    expect(recordOf(reply(T, 2))).toEqual({ sort: "reply", tools: true });
    expect(recordOf(reply(T, 0))).toEqual({ sort: "reply", tools: false });
    expect(recordOf(event("assistant.message", { content: "x" }, T))).toEqual({
      sort: "reply",
      tools: false,
    });
    expect(judge(reply(T, 1, { agentId: "agent-1" }))).toEqual({ sort: "passed" });
  });

  test("a tool call's start and end give its ID, and whether it is ask_user, from any agent", () => {
    expect(recordOf(toolStart("call-1", "bash", T))).toEqual({
      sort: "tool-start",
      call: "call-1",
      ask: false,
      at: T,
    });
    expect(recordOf(toolStart("call-2", "ask_user", T, { agentId: "agent-1" }))).toEqual({
      sort: "tool-start",
      call: "call-2",
      ask: true,
      at: T,
    });
    expect(recordOf(toolEnd("call-1", T, { agentId: "agent-1" }))).toEqual({
      sort: "tool-end",
      call: "call-1",
    });
    expect(recordOf(event("tool.execution_complete", { success: true }, T))).toEqual({
      sort: "unreadable",
    });
  });

  test("a permission request gives its ID, its time and whether a hook settled it, and its completion its ID", () => {
    expect(recordOf(permissionRequested("req-1", T))).toEqual({
      sort: "permission",
      request: "req-1",
      byHook: false,
      at: T,
    });
    expect(recordOf(permissionRequested("req-1", T, { byHook: true }))).toMatchObject({
      byHook: true,
    });
    expect(recordOf(permissionCompleted("req-1", T, { agentId: "agent-1" }))).toEqual({
      sort: "permission-end",
      request: "req-1",
    });
  });

  test("a shutdown gives its type, from a closed list", () => {
    expect(recordOf(shutdown(T))).toEqual({ sort: "shutdown", kind: "routine", at: T });
    expect(recordOf(shutdown(T, "error"))).toEqual({ sort: "shutdown", kind: "error", at: T });
    expect(recordOf(shutdown(T, "exploded"))).toEqual({ sort: "shutdown", kind: "other", at: T });
    expect(recordOf(shutdown(T, null))).toEqual({ sort: "shutdown", kind: "other", at: T });
  });

  test("a sub-agent's lifecycle lines and messages are passed over", () => {
    for (const line of [
      userMessage(T, { agentId: "agent-1" }),
      sessionStart(T, { agentId: "agent-1" }),
      event("abort", {}, T, { agentId: "agent-1" }),
      event("session.shutdown", { shutdownType: "error" }, T, { agentId: "agent-1" }),
      event("user.message", { parentToolCallId: "call-1", content: "x" }, T),
    ]) {
      expect(judge(line), line).toEqual({ sort: "passed" });
    }
  });
});

describe("what is passed over or cannot be read", () => {
  test("every other type is passed over, and so is a line without a type read", () => {
    for (const type of [
      "model.call_finished",
      "session.usage_checkpoint",
      "hook.start",
      "system.message",
      "subagent.started",
      "session.info",
      "session.compaction_complete",
      "session.title_changed",
      "something.new",
    ]) {
      expect(judge(other(type, T)), type).toEqual({ sort: "passed" });
    }
    // A type's name inside another field does not make a line one of that type.
    expect(judge(event("session.info", { note: "abort" }, T))).toEqual({ sort: "passed" });
    expect(judge(JSON.stringify({ data: { kind: "abort" } }))).toEqual({ sort: "passed" });
    expect(judge("not json")).toEqual({ sort: "passed" });
  });

  test("a broken line that may be one that decides cannot be read", () => {
    expect(judge('{"data":{"x":1,},"type":"abort"}')).toEqual({
      sort: "record",
      record: { sort: "unreadable" },
    });
    expect(judge(`${userMessage(T).trim().slice(0, -1)},}`)).toEqual({
      sort: "record",
      record: { sort: "unreadable" },
    });
  });

  test("a time not in ISO 8601 is none, and the line still counts", () => {
    expect(recordOf(event("abort", {}, T, { timestamp: 1_700_000_000_000 }))).toEqual({
      sort: "abort",
      at: null,
    });
    expect(recordOf(event("abort", {}, T, { timestamp: "yesterday" }))).toEqual({
      sort: "abort",
      at: null,
    });
    expect(recordOf(event("abort", {}, T, { timestamp: undefined }))).toEqual({
      sort: "abort",
      at: null,
    });
  });

  test("an ID is 1 to 256 printable ASCII bytes with no escape", () => {
    expect(recordOf(toolEnd("a".repeat(256), T))).toMatchObject({ call: "a".repeat(256) });
    for (const call of ["", "a".repeat(257), "caf\u00e9", "a b", 'a"b']) {
      expect(recordOf(toolEnd(call, T)), call).toEqual({ sort: "unreadable" });
    }
    expect(idOf(Buffer.from('"x"'), undefined)).toBeNull();
  });

  test("a line cut at its first MiB is read as far as it goes", () => {
    const pad = "x".repeat(LINE_MAX);
    const cut = (line: string) => {
      const whole = bytes(line);
      return judgeLine(whole.subarray(0, LINE_MAX), whole.byteLength <= LINE_MAX, FOLDER, "darwin");
    };
    // A tool call's and a permission request's ID come first, and stand.
    expect(cut(event("tool.execution_complete", { toolCallId: "c-1", result: pad }, T))).toEqual({
      sort: "record",
      record: { sort: "tool-end", call: "c-1" },
    });
    expect(
      cut(event("permission.requested", { requestId: "r-1", permissionRequest: pad }, T)),
    ).toEqual({
      sort: "record",
      record: { sort: "permission", request: "r-1", byHook: false, at: null },
    });
    // A user's message with no agentId in what was read is the main agent's.
    expect(cut(event("user.message", { content: pad }, T))).toEqual({
      sort: "record",
      record: { sort: "user", at: null },
    });
    // A reply whose tool requests lie past the cut is not known to ask for tools or not.
    expect(cut(event("assistant.message", { content: pad, toolRequests: [] }, T))).toEqual({
      sort: "record",
      record: { sort: "reply", tools: null },
    });
    // A short kind of line, cut, is not one Copilot writes.
    expect(cut(event("session.shutdown", { shutdownType: "routine", pad }, T))).toEqual({
      sort: "record",
      record: { sort: "unreadable" },
    });
  });

  test("no private word ever becomes part of a record", () => {
    const lines = [
      sessionStart(T),
      userMessage(T),
      reply(T, 1),
      toolStart("call-1", "ask_user", T),
      toolStart("call-2", "bash", T),
      toolEnd("call-2", T),
      permissionRequested("req-1", T),
      permissionCompleted("req-1", T),
      sessionError(T),
      taskComplete(T),
      taskComplete(T, "completed"),
      other("session.info", T),
    ];
    for (const line of lines) {
      const text = JSON.stringify(judge(line));
      for (const word of PRIVATE_WORDS) expect(text, line).not.toContain(word);
    }
  });

  test("the filter takes a line only when it holds a quoted type that is read", () => {
    expect(passesFilter(bytes(other("model.call_finished", T)))).toBe(false);
    expect(passesFilter(bytes(aborted(T)))).toBe(true);
    expect(passesFilter(Buffer.from("abort session.start"))).toBe(false);
  });
});
