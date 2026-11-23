import type {
  CopilotRecord,
  CopilotShutdown,
} from "../../../core/mapping/copilot-cli/copilotCliFold.ts";
import { literalOf, timeAt } from "../autohand-code/jsonBytes.ts";
import { walkLine, type Token, type WantedKey } from "../muse-code/jsonWalker.ts";
import { folder } from "../pi/sessionFile.ts";

/**
 * What one line of a Copilot CLI session's `events.jsonl` says, as far as a
 * session's status needs it, from its bytes. Built from GitHub's docs, the
 * MIT Copilot SDK v2.0.1 and open-source readers, never checked on a computer
 * running Copilot CLI. See docs/adapters/copilot-cli.md.
 *
 * Each line is one event, `{type, data, id, timestamp, parentId}`, with
 * `agentId` beside them on a sub-agent's events and `timestamp` in ISO 8601
 * (`SessionEvent` in `nodejs/src/generated/session-events.ts` of the SDK at
 * v2.0.1). A line is walked, as bytes, with Muse Code's walker
 * (`../muse-code/jsonWalker.ts`), only when its first `LINE_MAX` bytes hold
 * one of the quoted types `BYTE_FILTER` names, and only these are read:
 *
 * | `type`                    | Read                                                                 |
 * | ------------------------- | -------------------------------------------------------------------- |
 * | `session.start`           | `data.sessionId`, which must be the folder's name, `data.context.cwd` |
 * | `session.resume`          | `data.context.cwd`, `data.continuePendingWork`, `data.sessionWasActive` |
 * | `user.message`            | nothing more                                                         |
 * | `assistant.turn_start`, `assistant.turn_end` | `data.turnId`, `data.parentToolCallId`            |
 * | `assistant.message`       | whether `data.toolRequests` is an array that holds anything          |
 * | `tool.execution_start`    | `data.toolCallId`, and `data.toolName` compared with `ask_user`      |
 * | `tool.execution_complete` | `data.toolCallId`                                                    |
 * | `permission.requested`    | `data.requestId`, `data.resolvedByHook`                              |
 * | `permission.completed`    | `data.requestId`                                                     |
 * | `abort`, `session.error`  | nothing more                                                         |
 * | `session.task_complete`   | `data.outcome`, compared with `completed` and `continue`             |
 * | `session.shutdown`        | `data.shutdownType`                                                  |
 *
 * Every line read gives `type`, `timestamp`, whether it has `agentId`, and
 * whether its `data` has `parentToolCallId`. A line with either is a
 * sub-agent's: its lifecycle lines, its messages and its replies are passed
 * over, its turns are kept apart, and its tool calls and permission requests
 * count as any agent's. Every other type, `model.*`, `session.usage_*`,
 * `hook.*`, `system.*`, `subagent.*`, `session.info`, the compaction events
 * and any type not known, is passed over.
 *
 * Only three kinds of bytes become text, each found as bytes first: the
 * working folder, one JSON string of at most 16 KiB, by `literalOf`, kept
 * only when it is a whole path of at most 4,096 characters with no control
 * character; `timestamp`, from its digits and signs alone; and the IDs, 1 to
 * 256 printable ASCII bytes each, as `latin1`. A user's message, a reply's
 * content and reasoning, a tool's arguments and result, `permissionRequest`,
 * `promptRequest`, an error's message and every other field are stepped over
 * as bytes and never turned into text.
 */

/** The most of one line held and walked. */
export const LINE_MAX = 1024 * 1024;

/** The longest ID kept. */
export const MAX_ID_BYTES = 256;

/** The longest working folder decoded, between its quotes. */
export const MAX_FOLDER_BYTES = 16 * 1024;

/** The types read, as Copilot writes them in `type`. */
const TYPES = [
  "session.start",
  "session.resume",
  "user.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "permission.requested",
  "permission.completed",
  "abort",
  "session.task_complete",
  "session.error",
  "session.shutdown",
] as const;
type EventType = (typeof TYPES)[number];

/** The byte strings one of which a line must hold to be walked: a type the table reads, quotes included. */
export const BYTE_FILTER: readonly Buffer[] = TYPES.map((type) => Buffer.from(`"${type}"`));

const TYPE_BYTES = TYPES.map((type) => Buffer.from(type));
const ASK_USER = Buffer.from("ask_user");
const SHUTDOWNS = ["routine", "error"] as const;
/** `outcome`s that tell whether the run goes on: `completed` ends it, `continue` goes on. */
const COMPLETED = Buffer.from("completed");
const CONTINUE_RUN = Buffer.from("continue");

const TYPE = 0;
const TIMESTAMP = 1;
const AGENT = 2;
const SESSION_ID = 3;
const CWD = 4;
const CONTINUE = 5;
const TURN_ID = 6;
const PARENT = 7;
const TOOL_REQUESTS = 8;
const CALL_ID = 9;
const TOOL_NAME = 10;
const REQUEST_ID = 11;
const BY_HOOK = 12;
const SHUTDOWN = 13;
const ACTIVE = 14;
const OUTCOME = 15;
const LEAVES = 16;

const key = (name: string, leaf?: number, children?: readonly WantedKey[]): WantedKey => ({
  key: Buffer.from(name),
  ...(leaf === undefined ? {} : { leaf }),
  ...(children === undefined ? {} : { children }),
});

const WANTED: readonly WantedKey[] = [
  key("type", TYPE),
  key("timestamp", TIMESTAMP),
  key("agentId", AGENT),
  key("data", undefined, [
    key("sessionId", SESSION_ID),
    key("context", undefined, [key("cwd", CWD)]),
    key("continuePendingWork", CONTINUE),
    key("sessionWasActive", ACTIVE),
    key("turnId", TURN_ID),
    key("parentToolCallId", PARENT),
    key("toolRequests", TOOL_REQUESTS),
    key("toolCallId", CALL_ID),
    key("toolName", TOOL_NAME),
    key("requestId", REQUEST_ID),
    key("resolvedByHook", BY_HOOK),
    key("shutdownType", SHUTDOWN),
    key("outcome", OUTCOME),
  ]),
];

/**
 * The leaves each type reads past `type`, for the types whose lines are the
 * same for any agent and can be stopped at once these are read. The others
 * are walked to their end, for whether they hold `agentId`.
 */
const ANY_AGENT: Partial<Record<EventType, readonly number[]>> = {
  "tool.execution_start": [CALL_ID, TOOL_NAME, TIMESTAMP],
  "tool.execution_complete": [CALL_ID],
  "permission.requested": [REQUEST_ID, BY_HOOK, TIMESTAMP],
  "permission.completed": [REQUEST_ID],
};

/** What one line is, as far as the status needs it. */
export type JudgedLine = { sort: "passed" } | { sort: "record"; record: CopilotRecord };

const PASSED: JudgedLine = { sort: "passed" };
const UNREADABLE: JudgedLine = { sort: "record", record: { sort: "unreadable" } };

/** Whether a line's first bytes hold one of these byte strings. */
export function passesFilter(line: Buffer, filter: readonly Buffer[] = BYTE_FILTER): boolean {
  return filter.some((word) => line.indexOf(word) >= 0);
}

function stringBytes(line: Buffer, token: Token | undefined): Buffer | null {
  if (token?.type !== "string" || token.escaped) return null;
  return line.subarray(token.start, token.end);
}

/** Which type a token is, by its bytes, or -1 for any other. */
function typeOf(line: Buffer, token: Token | undefined): number {
  const bytes = stringBytes(line, token);
  if (bytes === null) return -1;
  return TYPE_BYTES.findIndex((type) => type.equals(bytes));
}

/** An ID as text, when it is a string of 1 to 256 bytes, each printable ASCII, else null. */
export function idOf(line: Buffer, token: Token | undefined): string | null {
  const bytes = stringBytes(line, token);
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_ID_BYTES) return null;
  for (const byte of bytes) if (byte < 0x21 || byte > 0x7e) return null;
  // Checked to be ASCII, so no byte becomes anything else.
  return bytes.toString("latin1");
}

/** `timestamp` in epoch milliseconds, when it is a time as ISO 8601 writes one, else null. */
export function timeOf(line: Buffer, token: Token | undefined): number | null {
  if (token?.type !== "string" || token.escaped) return null;
  return timeAt(line, token.start);
}

/** A working folder, decoded alone by JSON's own rules, when `folder` takes it on this system's rules, else null. */
function cwdOf(line: Buffer, token: Token | undefined, platform: NodeJS.Platform): string | null {
  if (token?.type !== "string" || token.end - token.start > MAX_FOLDER_BYTES) return null;
  const value = literalOf(line, token.start - 1, MAX_FOLDER_BYTES);
  return value === null ? null : folder(value, platform);
}

/** The leaves of a line, walked until its type's are read, or to its end. */
function walked(line: Buffer, whole: boolean) {
  const got: (Token | undefined)[] = new Array<Token | undefined>(LEAVES);
  const end = walkLine(line, whole, WANTED, (leaf, token) => {
    got[leaf] = token;
    const type = got[TYPE];
    if (type === undefined) return false;
    const which = typeOf(line, type);
    // A type not read is passed over, and nothing after its `type` is looked at.
    if (which < 0) return true;
    const leaves = ANY_AGENT[TYPES[which] as EventType];
    return leaves !== undefined && leaves.every((wanted) => got[wanted] !== undefined);
  });
  return { end, got };
}

/**
 * What a line of the log says, from `line`, its first `LINE_MAX` bytes at
 * most, without its line break. `whole` says whether those are all of it.
 * `folderName` is the session folder's name, as bytes, which the
 * session's own `session.start` names as its `sessionId`.
 *
 * A line cut at `LINE_MAX` is read as far as it goes: a tool call's or a
 * permission request's ID comes first in its `data`, and a user's message
 * or a reply with no `agentId` in what was read is taken as the main
 * agent's. Any other line of a type read that is cut short, broken, or
 * missing a field it needs is unreadable.
 */
export function judgeLine(
  line: Buffer,
  whole: boolean,
  folderName: Buffer,
  platform: NodeJS.Platform,
): JudgedLine {
  if (!passesFilter(line)) return PASSED;
  const { end, got } = walked(line, whole);
  const which = typeOf(line, got[TYPE]);
  // A broken line whose type was not read may be one that decides.
  if (which < 0) return end === "error" ? UNREADABLE : PASSED;
  const type = TYPES[which] as EventType;
  if (end === "error") return UNREADABLE;
  const cut = end === "cut";
  const at = timeOf(line, got[TIMESTAMP]);
  const sub = got[AGENT] !== undefined || got[PARENT] !== undefined;
  const record = (made: CopilotRecord | null): JudgedLine =>
    made === null ? UNREADABLE : { sort: "record", record: made };

  switch (type) {
    case "tool.execution_start": {
      const call = idOf(line, got[CALL_ID]);
      const name = stringBytes(line, got[TOOL_NAME]);
      return record(
        call === null
          ? null
          : { sort: "tool-start", call, ask: name?.equals(ASK_USER) === true, at },
      );
    }
    case "tool.execution_complete": {
      const call = idOf(line, got[CALL_ID]);
      return record(call === null ? null : { sort: "tool-end", call });
    }
    case "permission.requested": {
      const request = idOf(line, got[REQUEST_ID]);
      const byHook = got[BY_HOOK]?.type === "true";
      return record(request === null ? null : { sort: "permission", request, byHook, at });
    }
    case "permission.completed": {
      const request = idOf(line, got[REQUEST_ID]);
      return record(request === null ? null : { sort: "permission-end", request });
    }
    case "user.message":
      return sub ? PASSED : record({ sort: "user", at });
    case "assistant.message": {
      if (sub) return PASSED;
      const requests = got[TOOL_REQUESTS];
      const tools =
        requests?.type === "array" ? !requests.empty : requests === undefined && cut ? null : false;
      return record({ sort: "reply", tools });
    }
    default:
      break;
  }

  // The rest are short lines: one cut short is not one Copilot writes.
  if (cut) return UNREADABLE;
  if (type === "assistant.turn_start" || type === "assistant.turn_end") {
    const turn = idOf(line, got[TURN_ID]);
    if (turn === null) return UNREADABLE;
    const parent = got[PARENT];
    let subOf: string | null = null;
    if (parent !== undefined) {
      subOf = idOf(line, parent);
      if (subOf === null) return UNREADABLE;
    } else if (got[AGENT] !== undefined) {
      // A sub-agent's turn with no parent call to keep it by.
      return PASSED;
    }
    return record({
      sort: type === "assistant.turn_start" ? "turn-start" : "turn-end",
      turn,
      sub: subOf,
      at,
    });
  }
  if (sub) return PASSED;
  switch (type) {
    case "session.start": {
      const id = stringBytes(line, got[SESSION_ID]);
      if (id === null || !id.equals(folderName)) return UNREADABLE;
      return record({ sort: "start", cwd: cwdOf(line, got[CWD], platform), at });
    }
    case "session.resume":
      // Copilot keeps open work pending when the resume goes on with it, or joined
      // work another client is running, and otherwise marks it interrupted.
      return record({
        sort: "resume",
        cwd: cwdOf(line, got[CWD], platform),
        continuePending: got[CONTINUE]?.type === "true" || got[ACTIVE]?.type === "true",
        at,
      });
    case "abort":
      return record({ sort: "abort", at });
    case "session.task_complete": {
      const outcome = stringBytes(line, got[OUTCOME]);
      const goesOn = outcome?.equals(COMPLETED)
        ? false
        : outcome?.equals(CONTINUE_RUN)
          ? true
          : null;
      return record({ sort: "task-complete", goesOn, at });
    }
    case "session.error":
      return record({ sort: "error", at });
    case "session.shutdown": {
      const bytes = stringBytes(line, got[SHUTDOWN]);
      const kind: CopilotShutdown =
        SHUTDOWNS.find((word) => bytes?.equals(Buffer.from(word)) === true) ?? "other";
      return record({ sort: "shutdown", kind, at });
    }
    default:
      return PASSED;
  }
}
