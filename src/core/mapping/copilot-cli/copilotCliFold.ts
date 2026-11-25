// What a Copilot CLI session's event log says, folded from its lines. Pure,
// so the collector today and a browser or desktop host later share one fold.
//
// Copilot CLI appends one JSON object for each event of a session to
// `events.jsonl` in the session's folder. The reader
// (`src/collector/adapters/copilot-cli/records.ts`) turns each line it takes
// into one `CopilotRecord`, from bytes. The fold here keeps only what the
// status needs: which permission requests, `ask_user` questions, tool calls
// and turns are open, by their IDs, the newest lifecycle line of the main
// agent, and where the session works. No prompt, reply, command or other text
// is kept. Built from GitHub's docs, the MIT Copilot SDK v2.0.1 and
// open-source readers, never checked on a computer running Copilot CLI. See
// docs/adapters/copilot-cli.md.

/**
 * The most permission requests, questions, tool calls and sub-agent turns
 * kept open at once: more makes the fold unsure. Also the most completions
 * kept whose request has not come, the oldest let go first.
 */
export const OPEN_MAX = 256;

/** How a `session.shutdown` says the session ended: `routine`, `error` for a crash or a fatal error, or a word this does not know. */
export type CopilotShutdown = "routine" | "error" | "other";

/**
 * One line of the log, as far as the status needs it. `at` is its
 * `timestamp` in epoch milliseconds, or null when it has none of the shape
 * read. The lifecycle lines, a user's message and a reply are the main
 * agent's only: the reader passes over a sub-agent's.
 */
export type CopilotRecord =
  /** `session.start`, whose `sessionId` is the folder's name. */
  | { sort: "start"; cwd: string | null; at: number | null }
  /** `session.resume`: `continuePending` when `continuePendingWork` is true, or `sessionWasActive` says it joined live work. */
  | { sort: "resume"; cwd: string | null; continuePending: boolean; at: number | null }
  /** `user.message`. */
  | { sort: "user"; at: number | null }
  /** `assistant.turn_start`: the main agent's, or a sub-agent's with its `parentToolCallId`. */
  | { sort: "turn-start"; turn: string; sub: string | null; at: number | null }
  /** `assistant.turn_end`, the same. */
  | { sort: "turn-end"; turn: string; sub: string | null; at: number | null }
  /** `assistant.message`: whether its `toolRequests` hold any, or null when that could not be read. */
  | { sort: "reply"; tools: boolean | null }
  /** `tool.execution_start`, from any agent: `ask` when its `toolName` is `ask_user`. */
  | { sort: "tool-start"; call: string; ask: boolean; at: number | null }
  /** `tool.execution_complete`, from any agent. */
  | { sort: "tool-end"; call: string }
  /** `permission.requested`, from any agent: `byHook` when a hook already settled it. */
  | { sort: "permission"; request: string; byHook: boolean; at: number | null }
  /** `permission.completed`, from any agent. */
  | { sort: "permission-end"; request: string }
  /** `abort` or `session.error`. */
  | { sort: "abort" | "error"; at: number | null }
  /**
   * `session.task_complete`: whether the run goes on after it, by its
   * `outcome`, false for `completed`, true for `continue`, and null for
   * `blocked`, none or another word, which do not tell.
   */
  | { sort: "task-complete"; goesOn: boolean | null; at: number | null }
  /** `session.shutdown`. */
  | { sort: "shutdown"; kind: CopilotShutdown; at: number | null }
  /** A line of a kind read whose fields could not be read. */
  | { sort: "unreadable" }
  /** Lines were not read here, as in the middle of a log too long to read whole. */
  | { sort: "gap" };

/** The kinds of the main agent's lifecycle lines, the newest of which decides much of the status. */
export type CopilotLifecycle =
  | "start"
  | "resume"
  | "user"
  | "turn-start"
  | "turn-end"
  | "abort"
  | "task-complete"
  | "error"
  | "shutdown";

/** The newest lifecycle line of the main agent. */
export interface CopilotNewest {
  sort: CopilotLifecycle;
  at: number | null;
  /** For a `session.shutdown`, how it ended. */
  shutdown?: CopilotShutdown;
  /** For a `turn-end`, whether the turn it closed asked for tools, or null when that is not known. */
  tools?: boolean | null;
  /** For a `task-complete`, whether the run goes on, or null when that is not known. */
  goesOn?: boolean | null;
}

/** The main agent's turn: open with its ID, closed, or not known, as after lines that were not read. */
export type CopilotMainTurn =
  { state: "open"; id: string; at: number | null } | { state: "closed" } | { state: "unknown" };

/** What a session's log says, from its first line or, when the middle was not read, from after it. */
export interface CopilotFold {
  /** The first `session.start`'s time, or null. */
  startedAt: number | null;
  /** The working folder of the newest `session.start`, or null. */
  startCwd: string | null;
  /** The working folder of the newest `session.resume` that named one, or null. */
  resumeCwd: string | null;
  /** Open permission requests, by `requestId`, with when each was written. */
  permissions: Map<string, number | null>;
  /** Requests completed while none of that ID was open, kept until their request comes, which then opens nothing: the newest `OPEN_MAX`. */
  settled: Set<string>;
  /** Open `ask_user` calls, by `toolCallId`, with when each began. */
  questions: Map<string, number | null>;
  /** Those of them from before the main agent's newest turn start, turn end or abort. */
  passed: Set<string>;
  /**
   * When the session began to wait for you, as Copilot wrote it: a permission
   * request, or a question not in `passed`, has been open ever since. Null
   * with none open, or when the first had no time.
   */
  waitingSince: number | null;
  /** Other open tool calls, by `toolCallId`. */
  tools: Set<string>;
  turn: CopilotMainTurn;
  /** Whether a main reply in the open turn asked for tools, or null when that is not known. */
  turnTools: boolean | null;
  /** Open sub-agent turns, by `parentToolCallId` and `turnId`. */
  subTurns: Set<string>;
  newest: CopilotNewest | null;
  /** The newest main `user.message`'s time in this lifetime, or null: when the request being worked on was made. */
  askedAt: number | null;
  /** A line that would decide could not be read, or too much was open: unsure until a lifetime begins afresh. */
  unsure: boolean;
}

/** A fold before any line. */
export function startCopilotFold(): CopilotFold {
  return {
    startedAt: null,
    startCwd: null,
    resumeCwd: null,
    permissions: new Map(),
    settled: new Set(),
    questions: new Map(),
    passed: new Set(),
    waitingSince: null,
    tools: new Set(),
    turn: { state: "closed" },
    turnTools: false,
    subTurns: new Set(),
    newest: null,
    askedAt: null,
    unsure: false,
  };
}

/** A copy that more lines can change while the original stands. */
export function copyCopilotFold(fold: CopilotFold): CopilotFold {
  return {
    ...fold,
    permissions: new Map(fold.permissions),
    settled: new Set(fold.settled),
    questions: new Map(fold.questions),
    passed: new Set(fold.passed),
    tools: new Set(fold.tools),
    turn: { ...fold.turn },
    subTurns: new Set(fold.subTurns),
    newest: fold.newest === null ? null : { ...fold.newest },
  };
}

/** Drops everything open: what a new lifetime, a resume that does not go on with it, or a gap leaves. */
function dropOpen(fold: CopilotFold): void {
  fold.permissions.clear();
  fold.settled.clear();
  fold.questions.clear();
  fold.passed.clear();
  fold.tools.clear();
  fold.subTurns.clear();
}

/** How many things are open, against `OPEN_MAX`. */
function openCount(fold: CopilotFold): number {
  return fold.permissions.size + fold.questions.size + fold.tools.size + fold.subTurns.size;
}

/** Whether one more open thing would pass `OPEN_MAX`, which makes the fold unsure and lets go of what it holds. */
function crowded(fold: CopilotFold): boolean {
  if (openCount(fold) < OPEN_MAX) return false;
  fold.unsure = true;
  dropOpen(fold);
  return true;
}

/**
 * Notes that the main agent went on, or was stopped. A turn runs its tools
 * before it ends, so a question still open then may be one whose completion
 * Copilot never wrote. It stays open, and is no part of a later wait.
 */
function passQuestions(fold: CopilotFold): void {
  for (const call of fold.questions.keys()) fold.passed.add(call);
}

/** Whether something is open that counts towards `waitingSince`. */
function waits(fold: CopilotFold): boolean {
  return fold.permissions.size > 0 || fold.questions.size > fold.passed.size;
}

const subKey = (sub: string, turn: string) => `${sub}\u0000${turn}`;

/**
 * The fold after one more line, newer than every line before it. It changes
 * `fold` in place, so a caller that keeps the one before applies it to a copy.
 *
 * - A `session.start` begins a lifetime: everything open is dropped, the
 *   fold is sure again, and its working folder is the start's.
 * - A `session.resume` begins one too, and drops what was open unless
 *   `continuePendingWork` is true or the resume joined live work
 *   (`sessionWasActive`), as Copilot then keeps that work pending.
 * - A main `turn_start` opens the main turn; its `turn_end`, with the same
 *   `turnId`, closes it, noting whether a main reply in it asked for tools.
 *   A sub-agent's are kept by `parentToolCallId` and `turnId` until closed.
 * - Permission requests, `ask_user` calls and other tool calls, from any
 *   agent, are open until the line that closes them, paired by ID, never by
 *   order: a `permission.completed` written before its request closes it
 *   too, and the newest `OPEN_MAX` such completions are kept. One a hook
 *   settled opens nothing.
 * - A main `turn_start`, the `turn_end` that closes the main turn, or an
 *   `abort` passes by every question open then.
 * - A `session.task_complete` whose `outcome` says the run ends makes the
 *   open main turn one that asks for nothing more, as an accepted
 *   completion ends the run with the turn that called it. One that does not
 *   say leaves whether that turn asked for tools not known.
 * - A line that cannot be read makes the fold unsure until a lifetime begins
 *   afresh. A gap drops everything open and leaves the main turn not known.
 */
export function applyCopilotRecord(fold: CopilotFold, record: CopilotRecord): CopilotFold {
  const waited = waits(fold);
  takeRecord(fold, record);
  // One line opens one thing at most, so with nothing open before it the wait is as old as that line.
  if (!waits(fold)) fold.waitingSince = null;
  else if (!waited) fold.waitingSince = "at" in record ? record.at : null;
  return fold;
}

function takeRecord(fold: CopilotFold, record: CopilotRecord): CopilotFold {
  switch (record.sort) {
    case "start":
      dropOpen(fold);
      fold.unsure = false;
      fold.turn = { state: "closed" };
      fold.turnTools = false;
      fold.startedAt ??= record.at;
      fold.startCwd = record.cwd;
      fold.resumeCwd = null;
      fold.askedAt = null;
      fold.newest = { sort: "start", at: record.at };
      return fold;
    case "resume":
      if (!record.continuePending) {
        dropOpen(fold);
        fold.unsure = false;
        fold.turn = { state: "closed" };
        fold.turnTools = false;
        fold.askedAt = null;
      }
      if (record.cwd !== null) fold.resumeCwd = record.cwd;
      fold.newest = { sort: "resume", at: record.at };
      return fold;
    case "user":
      fold.askedAt = record.at;
      fold.newest = { sort: "user", at: record.at };
      return fold;
    case "turn-start":
      if (record.sub !== null) {
        if (!crowded(fold)) fold.subTurns.add(subKey(record.sub, record.turn));
        return fold;
      }
      passQuestions(fold);
      fold.turn = { state: "open", id: record.turn, at: record.at };
      fold.turnTools = false;
      fold.newest = { sort: "turn-start", at: record.at };
      return fold;
    case "turn-end": {
      if (record.sub !== null) {
        fold.subTurns.delete(subKey(record.sub, record.turn));
        return fold;
      }
      // An end that names another turn than the open one closes nothing.
      if (fold.turn.state === "open" && fold.turn.id !== record.turn) return fold;
      passQuestions(fold);
      const tools = fold.turn.state === "closed" ? false : fold.turnTools;
      fold.turn = { state: "closed" };
      fold.turnTools = false;
      fold.newest = { sort: "turn-end", at: record.at, tools };
      return fold;
    }
    case "reply":
      if (fold.turnTools === true) return fold;
      if (record.tools === true) fold.turnTools = true;
      else if (record.tools === null) fold.turnTools = null;
      return fold;
    case "tool-start":
      if (fold.questions.has(record.call) || fold.tools.has(record.call)) return fold;
      if (crowded(fold)) return fold;
      if (record.ask) fold.questions.set(record.call, record.at);
      else fold.tools.add(record.call);
      return fold;
    case "tool-end":
      fold.questions.delete(record.call);
      fold.passed.delete(record.call);
      fold.tools.delete(record.call);
      return fold;
    case "permission":
      if (fold.settled.delete(record.request) || record.byHook) return fold;
      if (fold.permissions.has(record.request) || crowded(fold)) return fold;
      fold.permissions.set(record.request, record.at);
      return fold;
    case "permission-end": {
      if (fold.permissions.delete(record.request)) return fold;
      // Kept until its request comes. A request a hook settled opened nothing, so its
      // completion is kept too, and past `OPEN_MAX` the oldest goes first.
      const oldest = fold.settled.values().next();
      if (fold.settled.size >= OPEN_MAX && oldest.done !== true) fold.settled.delete(oldest.value);
      fold.settled.add(record.request);
      return fold;
    }
    case "task-complete":
      if (fold.turn.state === "open" && record.goesOn !== true) {
        fold.turnTools = record.goesOn === false ? false : null;
      }
      fold.newest = { sort: "task-complete", at: record.at, goesOn: record.goesOn };
      return fold;
    case "abort":
    case "error":
      if (record.sort === "abort") passQuestions(fold);
      fold.newest = { sort: record.sort, at: record.at };
      return fold;
    case "shutdown":
      fold.newest = { sort: "shutdown", at: record.at, shutdown: record.kind };
      return fold;
    case "unreadable":
      fold.unsure = true;
      return fold;
    case "gap":
      dropOpen(fold);
      fold.turn = { state: "unknown" };
      fold.turnTools = null;
      fold.newest = null;
      fold.askedAt = null;
      return fold;
  }
}

/** The folder a session works in: the newest `session.resume`'s that named one, else the newest `session.start`'s. */
export function copilotCwdOf(fold: CopilotFold): string | null {
  return fold.resumeCwd ?? fold.startCwd;
}
