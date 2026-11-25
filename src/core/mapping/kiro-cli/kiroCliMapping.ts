// How Kiro CLI's session files map onto the session model. Pure, so it can be
// tested apart from the files.
//
// Kiro CLI keeps two stores side by side, never merged: the V3 store, one
// `sess_<uuid>/` folder for each session with a `messages.jsonl` row log, and
// the V2 store, `sessions/cli/<uuid>.jsonl` for each. Both keep a `.lock` while
// a process has the session open. Kiro's documentation asks readers not to
// depend on the V3 layout, so anything this does not recognise reads as
// unknown, never as a guess. See docs/adapters/kiro-cli.md for where each fact
// comes from.

import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";

/**
 * Whether a process has the session open, from its lock: `open` when the lock
 * names a process that runs and started no later than the lock was taken,
 * give or take a minute, `closed` when there is no lock or it names a process
 * that has ended, and `unknown` when the lock cannot be read or the process's
 * start cannot be checked.
 */
export type KiroLiveness = "open" | "closed" | "unknown";

/** One V3 row, as far as a status needs it. */
export type KiroV3Row =
  | { kind: "turn-start"; at: number | null }
  | { kind: "turn-end"; at: number | null }
  /** A row whose type begins `turn_` and is neither of the two above. */
  | { kind: "turn-other" }
  | { kind: "pending"; toolCallId: string; approval: boolean; at: number | null }
  | { kind: "resolved"; toolCallId: string }
  /** A line that is not a row of the shape Kiro writes. */
  | { kind: "unreadable" }
  /** Any other row: bookkeeping, a message or a tool's call or result. */
  | { kind: "other" };

/** One wait for the person, asked since the newest `turn_start` and not yet answered. */
export interface KiroWait {
  toolCallId: string;
  reason: WaitingReason;
}

/** What a V3 row log says, read in file order. */
export interface KiroV3Scan {
  /**
   * The newest turn row: `start`, `end`, or `other` for one not recognised.
   * Null when the whole file was read and holds none. Undefined when none was
   * found within the part of the file read.
   */
  lastTurn: "start" | "end" | "other" | null | undefined;
  /** When the newest turn row was written, as it says. */
  turnAt: number | null;
  /** The waits asked since the newest `turn_start` and not answered, oldest first. */
  waits: readonly KiroWait[];
  /**
   * When the wait those are part of began, as Kiro wrote it, or null with none:
   * the session has waited on one thing or another since then. So answering
   * the older of two does not move it, and a call answered and asked again
   * with nothing else open begins a new one.
   */
  waitingSince: number | null;
  /** A line since the newest turn row could not be read. */
  unreadable: boolean;
}

/** Where a read of a V3 row log starts: from the file's start, or from somewhere in it. */
export function startV3Scan(whole: boolean): KiroV3Scan {
  return afterTurn(whole ? null : undefined, null);
}

function afterTurn(lastTurn: KiroV3Scan["lastTurn"], turnAt: number | null): KiroV3Scan {
  return { lastTurn, turnAt, waits: [], waitingSince: null, unreadable: false };
}

/** The earlier of two times, the first when either is not known. */
function earlierOf(first: number | null, next: number | null): number | null {
  return first !== null && next !== null && next < first ? next : first;
}

/** Whether a row is a turn row, which a read from the end goes back to and no further. */
export function isV3TurnRow(row: KiroV3Row): boolean {
  return row.kind === "turn-start" || row.kind === "turn-end" || row.kind === "turn-other";
}

/**
 * One row more, in file order. A turn row starts afresh. A wait counts only
 * inside a turn that has started, and its answer, by the same `toolCallId`,
 * takes it away.
 */
export function foldV3Row(scan: KiroV3Scan, row: KiroV3Row): KiroV3Scan {
  switch (row.kind) {
    case "turn-start":
      return afterTurn("start", row.at);
    case "turn-end":
      return afterTurn("end", row.at);
    case "turn-other":
      return afterTurn("other", null);
    case "pending": {
      if (scan.lastTurn !== "start") return scan;
      if (scan.waits.some((wait) => wait.toolCallId === row.toolCallId)) return scan;
      const reason: WaitingReason = row.approval ? "permission" : "other";
      return {
        ...scan,
        waits: [...scan.waits, { toolCallId: row.toolCallId, reason }],
        // Earlier only when the clock was set back since the first was asked.
        waitingSince: scan.waits.length === 0 ? row.at : earlierOf(scan.waitingSince, row.at),
      };
    }
    case "resolved": {
      const waits = scan.waits.filter((wait) => wait.toolCallId !== row.toolCallId);
      return { ...scan, waits, waitingSince: waits.length === 0 ? null : scan.waitingSince };
    }
    case "unreadable":
      return scan.unreadable ? scan : { ...scan, unreadable: true };
    case "other":
      return scan;
  }
}

/** A status, with why it needs the person when it does. */
export interface KiroStatus {
  status: SessionStatus;
  waitingReason?: WaitingReason;
}

/**
 * Maps what a V3 session's lock and row log say to a status.
 *
 * | Newest turn row                     | Open, or not known | Not open |
 * | ----------------------------------- | ------------------ | -------- |
 * | `turn_start`, with a wait unanswered | needs-you         | finished |
 * | `turn_start`                         | working           | finished |
 * | `turn_end`                           | idle              | finished |
 * | none, the whole file read, or no log | idle              | finished |
 * | not recognised, or not found         | unknown           | finished |
 *
 * A line since the newest turn row that cannot be read makes it unknown too,
 * while the session is open or not known to be closed. It never returns
 * "failed": Kiro's turn rows are not read for errors.
 */
export function mapKiroV3Status(live: KiroLiveness, scan: KiroV3Scan | null): KiroStatus {
  if (live === "closed") return { status: "finished" };
  if (scan === null) return { status: "idle" };
  if (scan.unreadable) return { status: "unknown" };
  switch (scan.lastTurn) {
    case "start": {
      const first = scan.waits[0];
      return first ? { status: "needs-you", waitingReason: first.reason } : { status: "working" };
    }
    case "end":
    case null:
      return { status: "idle" };
    default:
      return { status: "unknown" };
  }
}

/** One V2 record, as far as a status needs it. */
export type KiroV2Record =
  | { kind: "prompt"; at: number | null }
  /** An `AssistantMessage`, and whether it carries a `toolUse` block. */
  | { kind: "reply"; toolUse: boolean }
  | { kind: "tool-results" }
  | { kind: "clear" }
  /** A record of a kind not recognised, or a line that is not a record of the shape Kiro writes. */
  | { kind: "unknown" };

/** What a V2 transcript says, read in file order. */
export interface KiroV2Scan {
  /**
   * The newest record that is not a `Clear`. Null when the whole file was read
   * and holds none. Undefined when none was found within the part read.
   */
  last: "prompt" | "tool-use" | "reply" | "tool-results" | "unknown" | null | undefined;
  /** When the newest `Prompt` was written, when one was read and had a time. */
  promptAt: number | null;
}

/** Where a read of a V2 transcript starts: from the file's start, or from somewhere in it. */
export function startV2Scan(whole: boolean): KiroV2Scan {
  return { last: whole ? null : undefined, promptAt: null };
}

/** Whether a record starts a turn, which a read from the end goes back to and no further. */
export function isV2TurnStart(record: KiroV2Record): boolean {
  return record.kind === "prompt";
}

/** One record more, in file order. A `Clear` is passed over. */
export function foldV2Record(scan: KiroV2Scan, record: KiroV2Record): KiroV2Scan {
  switch (record.kind) {
    case "prompt":
      return { last: "prompt", promptAt: record.at };
    case "reply":
      return { ...scan, last: record.toolUse ? "tool-use" : "reply" };
    case "tool-results":
      return { ...scan, last: "tool-results" };
    case "clear":
      return scan;
    case "unknown":
      return { ...scan, last: "unknown" };
  }
}

/**
 * Maps what a V2 session's lock and transcript say to a status.
 *
 * | Newest record, a `Clear` passed over | Open, or not known | Not open |
 * | ------------------------------------ | ------------------ | -------- |
 * | `AssistantMessage` with a `toolUse`  | working            | finished |
 * | `ToolResults`, `Prompt`              | working            | finished |
 * | `AssistantMessage` with no `toolUse` | idle               | finished |
 * | none, the whole file read, or no file | idle              | finished |
 * | any other kind, or not found         | unknown            | finished |
 *
 * It never returns "needs-you": V2 writes the tool call that waits for
 * approval before it asks, and nothing that says it waits, so the wait reads
 * as working. Nor "failed": the records are not read for errors.
 */
export function mapKiroV2Status(live: KiroLiveness, scan: KiroV2Scan | null): KiroStatus {
  if (live === "closed") return { status: "finished" };
  if (scan === null) return { status: "idle" };
  switch (scan.last) {
    case "tool-use":
    case "tool-results":
    case "prompt":
      return { status: "working" };
    case "reply":
    case null:
      return { status: "idle" };
    default:
      return { status: "unknown" };
  }
}
