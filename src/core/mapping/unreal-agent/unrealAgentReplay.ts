// What an Unreal Agent session's file says it is doing, from its lines in
// order. Pure, so the collector today and a browser or desktop host later
// share one replay.
//
// Unreal Agent keeps each session in one JSONL file, `<id>.session.jsonl`.
// After its first line come items, each with a number one more than the item
// before it, and operation lines, the newest state of a command. Unreal
// Agent's coordinator writes an input before it acts on it, a turn when it
// asks the model, the model's reply when it comes, and for each tool call two
// statuses: the first as its commands start, the second once all of them have
// ended (`harness/coordinator/loop.go`). The collector reads each line as
// bytes (`src/collector/adapters/unreal-agent/lines.ts`) and hands over only
// what is below. This replay was worked out from Unreal Agent's source at
// v0.3.1, not checked on a computer running it. See
// docs/adapters/unreal-agent.md.

/** How a reply ended, as its line's bytes say. */
export type UnrealAgentOutcome = "complete" | "failed" | "unclear";

/** The kinds of input whose words are read: a message, or a control input's mode. */
export type UnrealAgentInput = "external" | "heartbeat" | "settings" | "when_idle" | "hard";

/** The two kinds of turn. */
export type UnrealAgentTurnType = "regular" | "compaction";

/** What one item line says, as the collector reads it. */
export type UnrealAgentItem =
  | { kind: "input"; input: UnrealAgentInput }
  | { kind: "turn"; id: string; type: UnrealAgentTurnType }
  /** A reply, with the turn it answers. */
  | { kind: "reply"; turnId: string; outcome: UnrealAgentOutcome }
  /** A tool call's status with an error, or one that waits for nothing: a turn follows at once. */
  | { kind: "status-done" }
  /** A tool call's first status, with the commands it starts. */
  | { kind: "status-created"; ids: readonly string[] }
  /** A tool call's second status, once all its commands have ended. */
  | { kind: "status-completed"; ids: readonly string[] }
  | { kind: "fork" }
  /** An item of a shape this does not read. */
  | { kind: "unread" };

/** One line of a session's file after its first, as the collector reads it. */
export type UnrealAgentLine =
  | { kind: "item"; sequence: number; at: number; item: UnrealAgentItem }
  /** A command's newest state: whether it has ended. */
  | { kind: "operation"; id: string; terminal: boolean }
  /** A line of a shape this does not read. */
  | { kind: "unread" };

/** The most commands kept as running. A file past it is read as unknown, and no command is kept until a fork. */
export const MAX_OPEN_OPERATIONS = 4096;

/**
 * What the lines say the session is doing:
 *
 * - `busy`: a turn is open, an input is not yet answered, a turn is about to
 *   start, or a command runs.
 * - `waiting`: the newest regular turn is answered and nothing is left to run,
 *   from lines read from the session's start.
 * - `unsure`: the same, but from lines that do not reach its start, or after a
 *   reply whose turn was not read.
 * - `unread`: a line this does not read.
 */
export type UnrealAgentPhaseName = "busy" | "waiting" | "unsure" | "unread";

export interface UnrealAgentPhase {
  phase: UnrealAgentPhaseName;
  /** How the newest reply ended, for a session waiting or unsure. Null with none. */
  reply: UnrealAgentOutcome | null;
}

/** The newest turn or reply. */
type Newest =
  | { kind: "turn" }
  | {
      kind: "reply";
      turnType: UnrealAgentTurnType | null;
      outcome: UnrealAgentOutcome;
      at: number;
    };

/** The run the newest launch began: by its settings input, if one was read. */
export interface UnrealAgentRun {
  /** When its settings input was written. Null when none was read. */
  startAt: number | null;
  /** Whether a runner asked for it to end once idle. */
  whenIdle: boolean;
  /** What the lines said at its hard stop, or null with none. */
  hard: UnrealAgentPhase | null;
}

/** What the replay keeps of a session. Nothing in it is text from the file but IDs. */
export interface UnrealAgentReplay {
  /** The newest turn read: its ID and kind. */
  turn: { id: string; type: UnrealAgentTurnType } | null;
  newest: Newest | null;
  /** Whether an input since the newest turn is not yet answered, and when the first was written. */
  pending: boolean;
  pendingAt: number | null;
  /** Whether a turn is about to start: a tool call ended, or failed at once. */
  imminent: boolean;
  /** The commands a tool call's first status started, until its second. */
  callOps: Set<string>;
  /** The commands whose newest line is not one that ends them. */
  liveOps: Set<string>;
  run: UnrealAgentRun;
  /** When the oldest item read was written. */
  oldestItemAt: number | null;
  newestItemAt: number | null;
  newestTurnAt: number | null;
  /** Whether the lines reach the session's start: its first item, or a fork. */
  complete: boolean;
  /** Whether a line was not read. Kept until the file is read afresh, or a fork follows. While it holds, no command is added. */
  unread: boolean;
  /** Whether the newest line is a reply to the newest turn. */
  endsOnReply: boolean;
  /** The newest item's number, or null before any, in lines that do not reach the start. */
  lastSequence: number | null;
}

/**
 * A replay with nothing read yet. `fromStart` when the lines will begin with
 * the session's first item, as when the file is read from its start.
 */
export function startUnrealAgentReplay(fromStart: boolean): UnrealAgentReplay {
  return {
    turn: null,
    newest: null,
    pending: false,
    pendingAt: null,
    imminent: false,
    callOps: new Set(),
    liveOps: new Set(),
    run: { startAt: null, whenIdle: false, hard: null },
    oldestItemAt: null,
    newestItemAt: null,
    newestTurnAt: null,
    complete: fromStart,
    unread: false,
    endsOnReply: false,
    lastSequence: fromStart ? 0 : null,
  };
}

/** A copy that lines can be applied to, leaving this one as it was. */
export function copyUnrealAgentReplay(replay: UnrealAgentReplay): UnrealAgentReplay {
  return {
    ...replay,
    run: { ...replay.run },
    callOps: new Set(replay.callOps),
    liveOps: new Set(replay.liveOps),
  };
}

/**
 * What the lines say the session is doing, by these rows in order:
 *
 * | Evidence                                              | Phase   |
 * | ----------------------------------------------------- | ------- |
 * | a line not read                                       | unread  |
 * | the newest turn is not answered                       | busy    |
 * | an input is not yet answered                          | busy    |
 * | a tool call ended, or failed at once                  | busy    |
 * | a command runs                                        | busy    |
 * | the newest reply answers a compaction turn            | busy    |
 * | the newest reply answers a regular turn, or no reply, |         |
 * | from the start and with the turn read                 | waiting |
 * | the same, but not from the start or the turn unread   | unsure  |
 *
 * - The coordinator is idle only with no model call, no input pending, no
 *   tool call left and no command running (`isIdle`, loop.go:278-281). A tool
 *   call is left until its second status is written (`finishToolCall`,
 *   712-723), and a turn follows a call that ended or failed at once (215,
 *   902-909).
 * - A compaction reply is always followed by a regular turn (641-643).
 * - Lines that do not reach the start can miss a command started before them
 *   that still runs, so they cannot say the session waits.
 */
export function unrealAgentPhase(replay: UnrealAgentReplay): UnrealAgentPhase {
  if (replay.unread) return { phase: "unread", reply: null };
  const busy: UnrealAgentPhase = { phase: "busy", reply: null };
  const { newest } = replay;
  if (newest?.kind === "turn") return busy;
  if (replay.pending || replay.imminent) return busy;
  if (replay.callOps.size > 0 || replay.liveOps.size > 0) return busy;
  if (newest?.kind === "reply" && newest.turnType === "compaction") return busy;
  const reply = newest?.kind === "reply" ? newest.outcome : null;
  const turnKnown = newest === null || newest.turnType !== null;
  return { phase: replay.complete && turnKnown ? "waiting" : "unsure", reply };
}

/**
 * When the run began, for telling which program could hold the session: its
 * settings input, else the oldest item read when no settings input was, else
 * null.
 */
export function runBeganBy(replay: UnrealAgentReplay): number | null {
  return replay.run.startAt ?? replay.oldestItemAt;
}

function addAll(set: Set<string>, ids: readonly string[]) {
  for (const id of ids) set.add(id);
}

/** More commands open than are kept: a line not read, and no command kept until a fork. */
function tooManyOpen(replay: UnrealAgentReplay) {
  replay.unread = true;
  replay.callOps.clear();
  replay.liveOps.clear();
}

/**
 * Applies one line, in file order.
 *
 * - A settings input begins a new run: every launch writes one first (TUI
 *   run.go:213-224, runner run.go:369-385), and a resumed runner reapplies no
 *   old stop (loop.go:586-616). Inputs not answered and commands carry over.
 * - A runner writes `when_idle` as it starts (run.go:404-412), and the TUI
 *   writes `hard` as it quits (runcontrol/stop.go:18). After `hard`, commands
 *   are cancelled and their lines can follow (loop.go:267-276), so what the
 *   lines said at it is kept.
 * - A message and a heartbeat are answered by the next turn (loop.go:597-616).
 * - A reply to an older turn is not written (loop.go:170-172), so one is a
 *   line not read.
 * - A fork item clears what the coordinator clears at it: tool calls and
 *   commands (loop.go:581-584). The items before it are its parent's.
 */
export function applyUnrealAgentLine(replay: UnrealAgentReplay, line: UnrealAgentLine): void {
  replay.endsOnReply = false;
  if (line.kind === "unread") {
    replay.unread = true;
    return;
  }
  if (line.kind === "operation") {
    if (line.terminal) replay.liveOps.delete(line.id);
    else if (!replay.unread) replay.liveOps.add(line.id);
    if (replay.liveOps.size > MAX_OPEN_OPERATIONS) tooManyOpen(replay);
    return;
  }

  const { sequence, at, item } = line;
  // Unreal Agent numbers its items one after another (codec.go:137-145).
  if (replay.lastSequence !== null && sequence !== replay.lastSequence + 1) replay.unread = true;
  if (replay.lastSequence === null && sequence === 1) replay.complete = true;
  replay.lastSequence = sequence;
  replay.oldestItemAt ??= at;
  replay.newestItemAt = at;

  switch (item.kind) {
    case "unread":
      replay.unread = true;
      return;
    case "input":
      applyInput(replay, item.input, at);
      return;
    case "turn":
      replay.turn = { id: item.id, type: item.type };
      replay.newest = { kind: "turn" };
      replay.pending = false;
      replay.pendingAt = null;
      replay.imminent = false;
      replay.newestTurnAt = at;
      return;
    case "reply":
      if (replay.turn !== null && item.turnId !== replay.turn.id) {
        replay.unread = true;
        return;
      }
      replay.newest = {
        kind: "reply",
        turnType: replay.turn?.type ?? null,
        outcome: item.outcome,
        at,
      };
      replay.endsOnReply = true;
      return;
    case "status-done":
      replay.imminent = true;
      return;
    case "status-created":
      if (!replay.unread) addAll(replay.callOps, item.ids);
      if (replay.callOps.size > MAX_OPEN_OPERATIONS) tooManyOpen(replay);
      return;
    case "status-completed":
      for (const id of item.ids) {
        replay.callOps.delete(id);
        replay.liveOps.delete(id);
      }
      replay.imminent = true;
      return;
    case "fork":
      replay.unread = false;
      replay.callOps.clear();
      replay.liveOps.clear();
      replay.imminent = false;
      replay.complete = true;
      return;
  }
}

function applyInput(replay: UnrealAgentReplay, input: UnrealAgentInput, at: number) {
  switch (input) {
    case "settings":
      replay.run = { startAt: at, whenIdle: false, hard: null };
      return;
    case "when_idle":
      replay.run.whenIdle = true;
      return;
    case "hard":
      replay.run.hard ??= unrealAgentPhase(replay);
      return;
    case "external":
    case "heartbeat":
      replay.pending = true;
      replay.pendingAt ??= at;
      return;
  }
}
