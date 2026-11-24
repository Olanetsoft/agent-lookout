import type { Session } from "../../../../core/sessions/session.ts";
import { waitingText } from "../../../../core/text.ts";
import { blocksOf, isRecord, linesOf, nonEmpty } from "./transcriptLines.ts";

/**
 * What a waiting Claude Code session is asking, worked out from the end of its
 * transcript. Pure: the bytes are read elsewhere
 * (`src/collector/files/transcriptTail.ts`).
 *
 * The transcript is undocumented. These notes are from Claude Code 2.1.28x, and
 * none of them is promised:
 *
 * - Each line is one JSON object with a `type`: `assistant`, `user`,
 *   `attachment`, `system` and others. A line with `isSidechain: true` belongs
 *   to a subagent, and is not the session's own.
 * - Each block of an assistant message is a line of its own, whose
 *   `message.content` is an array of one block: `thinking`, `text` or
 *   `tool_use`, which is `{ id, name, input }`. The lines of one message share
 *   its `message.id`.
 * - A tool's result is a later `user` line whose `message.content` holds a
 *   block `{ type: "tool_result", tool_use_id }`.
 * - While a session waits for permission, its newest `tool_use` has no result
 *   after it. While it waits on a question, that `tool_use` is named
 *   `AskUserQuestion`, with `input.questions` a list of `{ question, header,
 *   options, multiSelect }`.
 * - A tool that runs has no result yet either, and a subagent in the background
 *   asks in the session while the session's own tool runs. Its `tool_use` has a
 *   result at once, whose line's `toolUseResult` has `isAsync: true` and the
 *   `status` `async_launched`, where one that has finished has `completed`. A
 *   later line holds a `<task-notification>` that names it when it ends.
 * - A line's `timestamp` is when it was written, as ISO text.
 *
 * So a line that does not parse is skipped, a field of the wrong kind is no
 * field, and anything unexpected gives no text at all, never a guess.
 */

/** One `tool_use` block of the session's own, in the order the transcript holds them. */
interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** The `message.id` of the assistant message it is part of, when the line gives one. */
  messageId: string | null;
  /** When its line was written, in epoch milliseconds, or null when the line does not say. */
  at: number | null;
}

/** The wait a session is in: when it began, and what for. */
export type Wait = Pick<Session, "statusSince" | "waitingReason">;

/**
 * How long before a wait the session's own newest step may have been written.
 * Claude Code asks a moment after it writes the tool use it asks about, so
 * with an older one something else is asking, such as a subagent started
 * before the tail.
 */
export const ASKED_WITHIN_MS = 15_000;

/** A wait and the line it is for are written a moment apart, in either order. */
const WRITE_ORDER_SLACK_MS = 1_000;

/** How a `<task-notification>` says an agent has ended. */
const ENDED = /<status>(?:completed|failed|killed|stopped)</;

/** When a line was written, or null when it does not say. */
function writtenAt(line: Record<string, unknown>): number | null {
  const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  return Number.isNaN(at) ? null : at;
}

/**
 * Whether a result says its tool use started an agent that runs on after it, in
 * the background or as a teammate. For a tool that starts a subagent anything
 * but a finished agent or an error is taken so.
 */
function startedAgent(
  name: string | undefined,
  block: Record<string, unknown>,
  result: Record<string, unknown>,
): boolean {
  if (result.isAsync === true || result.status === "async_launched") return true;
  if (name === undefined || !SUBAGENT_TOOLS.has(name)) return false;
  return result.status !== "completed" && block.is_error !== true;
}

/** Whether a `user` line is something the person said, rather than a tool's result or a note of Claude Code's own. */
function isPrompt(line: Record<string, unknown>): boolean {
  if (line.isMeta === true) return false;
  const message = isRecord(line.message) ? line.message : null;
  if (message === null) return false;
  if (typeof message.content === "string") return message.content.trim() !== "";
  return blocksOf(line).some((block) => block.type === "text");
}

/**
 * The tool use the session waits on, or null when it waits on none: every
 * tool use of the newest message has a result after it, the conversation has
 * gone on past it, or there is none in the tail.
 *
 * One message can ask for several tools at once, and one that runs has no
 * result either, so with more than one left it is not known which is waited on.
 * Nor is it while an agent the session started runs in the background, or when
 * the session's own newest step is older than the wait, or newer. A question
 * the session put is known all the same, in a wait on a question. A line
 * that gives no `message.id` cannot be told to be part of the same message,
 * so then only the newest tool use is looked at, and any later assistant line
 * is the conversation going on.
 */
function pendingToolUse(lines: readonly Record<string, unknown>[], wait: Wait): ToolUse | null {
  const uses: ToolUse[] = [];
  const answered = new Set<string>();
  /** The agents that may still run: by the tool use that started each, the ids that name it. */
  const agents = new Map<string, string[]>();
  const latest = (wait.statusSince ?? 0) + WRITE_ORDER_SLACK_MS;
  /** When the session last took a step before the wait, as far as its lines say. */
  let steppedAt = 0;
  const step = (at: number | null) => {
    if (at !== null && at <= latest) steppedAt = Math.max(at, steppedAt);
  };
  /**
   * Whether the conversation went on after the newest tool use: a reply of
   * another message, or of a message that cannot be told apart, or a prompt.
   */
  let movedOn = false;
  for (const line of lines) {
    if (line.isSidechain === true) continue;
    const message = isRecord(line.message) ? line.message : null;
    if (line.type === "assistant") {
      const messageId = nonEmpty(message?.id);
      const newest = uses.at(-1);
      if (newest !== undefined && (messageId === null || messageId !== newest.messageId)) {
        movedOn = true;
      }
      for (const block of blocksOf(line)) {
        if (block.type !== "tool_use") continue;
        const id = nonEmpty(block.id);
        const name = nonEmpty(block.name);
        if (id === null || name === null) continue;
        const at = writtenAt(line);
        uses.push({ id, name, input: isRecord(block.input) ? block.input : {}, messageId, at });
        step(at);
        movedOn = false;
      }
      continue;
    }
    if (agents.size > 0) {
      const said = JSON.stringify(line);
      if (said.includes("<task-notification>") && ENDED.test(said)) {
        for (const [id, names] of agents) {
          if (names.some((name) => said.includes(`>${name}<`))) agents.delete(id);
        }
      }
    }
    if (line.type === "user") {
      for (const block of blocksOf(line)) {
        const id = block.type === "tool_result" ? nonEmpty(block.tool_use_id) : null;
        if (id === null) continue;
        answered.add(id);
        step(writtenAt(line));
        const result = isRecord(line.toolUseResult) ? line.toolUseResult : {};
        const name = uses.find((use) => use.id === id)?.name;
        if (!startedAgent(name, block, result)) continue;
        const names = [id, nonEmpty(result.agentId), nonEmpty(result.taskId)];
        agents.set(
          id,
          names.filter((each) => each !== null),
        );
      }
      if (uses.length > 0 && isPrompt(line)) movedOn = true;
    }
  }

  const newest = uses.at(-1);
  if (newest === undefined || movedOn) return null;
  const left = uses.filter(
    (use) =>
      !answered.has(use.id) &&
      (use === newest || (use.messageId !== null && use.messageId === newest.messageId)),
  );
  if (wait.waitingReason === "question") {
    const question = left.find((use) => use.name === "AskUserQuestion");
    if (question !== undefined) return question;
  }
  const [only] = left;
  if (only === undefined || left.length > 1 || agents.size > 0) return null;
  if (wait.statusSince === null || only.at === null) return only;
  const asked = only.at <= latest && steppedAt >= wait.statusSince - ASKED_WITHIN_MS;
  return asked ? only : null;
}

/** The first line of a command that has anything on it. */
function firstLine(command: string): string | null {
  return command.split(/\r?\n/).find((line) => line.trim() !== "") ?? null;
}

/**
 * A path as the session would say it: relative to its folder when it is inside
 * it, and whole otherwise.
 */
export function shortPath(file: string, cwd: string | null): string {
  if (cwd === null || cwd === "") return file;
  const folder = cwd.replace(/[/\\]+$/, "");
  if (folder === "") return file;
  for (const separator of ["/", "\\"]) {
    const prefix = `${folder}${separator}`;
    if (file.startsWith(prefix) && file.length > prefix.length) return file.slice(prefix.length);
  }
  return file;
}

/** The tools that change or read one file, and the word for each. */
const FILE_TOOLS: Readonly<Record<string, { word: string; field: string }>> = {
  Edit: { word: "Edit", field: "file_path" },
  MultiEdit: { word: "Edit", field: "file_path" },
  NotebookEdit: { word: "Edit", field: "notebook_path" },
  Write: { word: "Write", field: "file_path" },
  Read: { word: "Read", field: "file_path" },
};

/** The tools that start a subagent. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);

/**
 * What one tool use asks, in a few words, or null when its input is not what
 * the tool is known to take, or when the tool starts a subagent.
 *
 * - AskUserQuestion: the first question, and " (+2 more)" when there are more.
 * - Bash and PowerShell: "Run: " and the first line of the command.
 * - Edit, MultiEdit, NotebookEdit, Write and Read: "Edit: ", "Write: " or
 *   "Read: " and the file, relative to the session's folder when inside it.
 * - WebFetch: "Fetch: " and the address. WebSearch: "Search: " and the query.
 * - ExitPlanMode: "Approve the plan".
 * - Task and Agent, which start a subagent: null. The session has already
 *   started it, and when it waits, the subagent is the one asking, in lines
 *   that are not read here.
 * - Any other tool, an MCP server's included: "Use: " and its name.
 */
export function describeToolUse(
  name: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string | null,
): string | null {
  if (name === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const first: unknown = questions[0];
    const question = isRecord(first) ? nonEmpty(first.question) : null;
    if (question === null) return null;
    return questions.length > 1 ? `${question} (+${questions.length - 1} more)` : question;
  }
  if (name === "Bash" || name === "PowerShell") {
    const command = nonEmpty(input.command);
    const line = command === null ? null : firstLine(command);
    return line === null ? null : `Run: ${line.trim()}`;
  }
  const fileTool = Object.hasOwn(FILE_TOOLS, name) ? FILE_TOOLS[name] : undefined;
  if (fileTool !== undefined) {
    const file = nonEmpty(input[fileTool.field]);
    return file === null ? null : `${fileTool.word}: ${shortPath(file, cwd)}`;
  }
  if (name === "WebFetch") {
    const url = nonEmpty(input.url);
    return url === null ? null : `Fetch: ${url}`;
  }
  if (name === "WebSearch") {
    const query = nonEmpty(input.query);
    return query === null ? null : `Search: ${query}`;
  }
  if (name === "ExitPlanMode") return "Approve the plan";
  if (SUBAGENT_TOOLS.has(name)) return null;
  return `Use: ${name}`;
}

/**
 * What the session is asking, from the end of its transcript, as plain text
 * fit to show: cleaned of control characters and cut to 200 characters. Left
 * out when the tail shows no tool use still waiting, or does not say which one
 * the wait is for, or anything unexpected.
 *
 * `fromStart` says whether the tail is the whole file. When it is not, its
 * first line is a part of a longer one and is not read, so a last line too
 * long for the tail gives no text.
 */
export function askedInTail(
  tail: string,
  fromStart: boolean,
  cwd: string | null,
  wait: Wait = { statusSince: null },
): string | undefined {
  const pending = pendingToolUse(linesOf(tail, fromStart), wait);
  if (pending === null) return undefined;
  return waitingText(describeToolUse(pending.name, pending.input, cwd));
}
