// How Qwen Code's chat files map onto the session model. Pure, so the collector
// today and a browser or desktop host later share one mapping.
//
// Qwen Code writes one line for each prompt, each whole reply, each batch of
// tool results and many events of its own, and nothing while it waits for an
// approval. So a Qwen Code session is working, idle or unknown here, and never
// "needs-you" or "failed". Built from Qwen Code's source at v0.25.1 and not yet
// checked on a machine running it. See docs/adapters/qwen-code.md for where
// each value comes from.

import type { SessionStatus } from "../../sessions/session.ts";

/**
 * The little the adapter keeps of one line of a chat file, and nothing else:
 * no prompt, reply, thought, tool input or output, folder or branch.
 */
export interface QwenCodeRecord {
  /** `user`, `assistant`, `tool_result` or `system`, or another word a newer Qwen Code writes. */
  type: string;
  /** The line's `subtype`, when it has one. */
  subtype?: string;
  /** The line's `timestamp`, in epoch milliseconds, or null when it has none that reads as a time. */
  at: number | null;
  /** The line was too long to read whole: only its type, subtype and time were read. */
  oversized?: true;
  /** A `notification` line stamped as the first line of a turn Qwen Code went on to send. */
  deliveredTurn?: true;
  /** An `assistant` line that holds a reply. */
  message?: true;
  /** An `assistant` line whose reply calls a tool. */
  calls?: true;
  /** A `tool_result` line for a call that was stopped or declined. */
  cancelled?: true;
  /** A `ui_telemetry` line about one request to the model. */
  lifecycle?: QwenCodeLifecycle;
  /** A `custom_title` line's title, as written. */
  title?: string;
  /** A line written by a Managed Session log, which this mapping does not read. */
  managed?: true;
}

/** What a `request_lifecycle` event says of one request to the model. */
export interface QwenCodeLifecycle {
  phase: "started" | "ended";
  /** How an ended request ended: `success`, `error`, `cancelled` or `interrupted`. */
  outcome?: string;
  /** Made by a subagent of the session, not by the session itself. */
  subagent: boolean;
}

/**
 * The lines that say what a session is doing:
 *
 * prompt             a turn began: a prompt, a scheduled prompt, a goal's turn or a sent notification
 * activity           something typed while a turn runs
 * calls              a reply that calls tools
 * results            the results of those calls, none of them stopped
 * request            a request of the session's own to the model began, and has not ended
 * cancelled-results  results of which one or more was stopped or declined
 * reply              a reply with no call
 * rewind             the conversation was taken back
 * turn-end           a turn ended, written by sessions an editor drives
 * cancelled          a request was stopped with Esc
 * unknown-type       a line of a type this mapping does not know
 * oversized-reply    a reply too long to read whole
 */
export type QwenCodeEvent =
  | "prompt"
  | "activity"
  | "calls"
  | "results"
  | "request"
  | "cancelled-results"
  | "reply"
  | "rewind"
  | "turn-end"
  | "cancelled"
  | "unknown-type"
  | "oversized-reply";

const WORKING_EVENTS: ReadonlySet<QwenCodeEvent> = new Set([
  "prompt",
  "activity",
  "calls",
  "results",
  "request",
]);

const IDLE_EVENTS: ReadonlySet<QwenCodeEvent> = new Set([
  "cancelled-results",
  "reply",
  "rewind",
  "turn-end",
  "cancelled",
]);

/** The `user` subtypes that begin a turn, beside a line with no subtype. */
const TURN_SUBTYPES: ReadonlySet<string> = new Set(["cron", "goal_runtime"]);

/** The subtypes Qwen Code's Managed Session logs write. */
const MANAGED_SUBTYPES: ReadonlySet<string> = new Set([
  "managed_session_header_v1",
  "managed_session_event_v1",
  "managed_session_commit_v1",
]);

/** What the lines of one chat file say, folded in the order they were written. */
export interface QwenCodeFold {
  /** True when the first line folded was the file's first. */
  whole: boolean;
  /** The newest line that says what the session is doing. Null before any. */
  event: QwenCodeEvent | null;
  /** Its time. */
  eventAt: number | null;
  /** The first line read of the stretch the newest event's status is in. */
  since: number | null;
  /** Whether that line began the stretch, rather than being the first one read of a file read from its middle. */
  sinceSeen: boolean;
  /** Whether a result since the newest calls was stopped or declined. */
  batchCancelled: boolean;
  /** While a request of the session's own is the newest event: the event before it, and that event's time. */
  beforeRequest: { event: QwenCodeEvent | null; eventAt: number | null } | null;
  /** The newest title. */
  title: string | null;
  /** Whether a line says this is a Managed Session log. */
  managed: boolean;
}

/** Nothing folded yet: `whole` says whether the lines start at the file's start. */
export function startQwenCodeFold(whole: boolean): QwenCodeFold {
  return {
    whole,
    event: null,
    eventAt: null,
    since: null,
    sinceSeen: false,
    batchCancelled: false,
    beforeRequest: null,
    title: null,
    managed: false,
  };
}

function statusOf(event: QwenCodeEvent): "working" | "idle" | "unknown" {
  if (WORKING_EVENTS.has(event)) return "working";
  if (IDLE_EVENTS.has(event)) return "idle";
  return "unknown";
}

function withEvent(fold: QwenCodeFold, event: QwenCodeEvent, at: number | null): QwenCodeFold {
  const status = statusOf(event);
  const before = fold.event === null ? null : statusOf(fold.event);
  if (before === status && event !== "prompt") return { ...fold, event, eventAt: at };
  // A turn always begins a stretch of work of its own. The first line read of a
  // file read from its middle may be in a stretch that began before it.
  const sinceSeen = event === "prompt" || before !== null || fold.whole;
  return { ...fold, event, eventAt: at, since: at, sinceSeen };
}

/**
 * A request of the session's own that ended well, or failed, says nothing
 * more: the event before it stands again. A request after a reply, as Qwen
 * Code's check of who speaks next makes, leaves the session idle. An idle
 * stretch that comes back begins when the request ended.
 */
function afterRequest(fold: QwenCodeFold, at: number | null): QwenCodeFold {
  const before = fold.beforeRequest;
  if (fold.event !== "request" || before === null) return fold;
  const back = { ...fold, event: before.event, eventAt: before.eventAt, beforeRequest: null };
  if (before.event === null) return { ...back, since: null, sinceSeen: false };
  return statusOf(before.event) === "working" ? back : { ...back, since: at, sinceSeen: true };
}

/** The event a `user` line is, if any. */
function userEvent(record: QwenCodeRecord): QwenCodeEvent | null {
  const { subtype } = record;
  if (subtype === undefined || TURN_SUBTYPES.has(subtype)) return "prompt";
  // A notification begins a turn only when Qwen Code stamped it as the turn's
  // first line. One saved before any turn ran asks for no reply.
  if (subtype === "notification") return record.deliveredTurn ? "prompt" : null;
  if (subtype === "mid_turn_user_message") return "activity";
  // A message between agents, a spoken line and the rest begin no turn.
  return null;
}

/**
 * Folds one line into what the lines before it said. Pure: the fold given is
 * not changed.
 *
 * | Line                                              | Event             | Status  |
 * | ------------------------------------------------- | ----------------- | ------- |
 * | `user` with no subtype, `cron`, `goal_runtime`    | prompt            | working |
 * | `user` `notification` stamped `deliveredTurn`     | prompt            | working |
 * | `user` `mid_turn_user_message`                    | activity          | working |
 * | any other `user` line                             | none              |         |
 * | `assistant` whose reply calls a tool              | calls             | working |
 * | `assistant` with a reply and no call              | reply             | idle    |
 * | `assistant` too long to read whole                | oversized-reply   | unknown |
 * | `assistant` with a subtype, or with no reply      | none              |         |
 * | `assistant` right after a request stopped with Esc | none             |         |
 * | `tool_result`, none stopped since the calls       | results           | working |
 * | `tool_result`, one or more stopped since the calls | cancelled-results | idle   |
 * | `request_lifecycle` `started`                     | request           | working |
 * | `request_lifecycle` `ended` `cancelled`           | cancelled         | idle    |
 * | `request_lifecycle` `ended` any other way         | the one before    |         |
 * | `system` `rewind`                                 | rewind            | idle    |
 * | `system` `turn_result`                            | turn-end          | idle    |
 * | any other `system` line                           | none              |         |
 * | a line of any other type                          | unknown-type      | unknown |
 *
 * Only the session's own requests count: a subagent's, and every other event
 * Qwen Code records, change nothing. A request that ended well or failed puts
 * back the event before it, when it is still the newest. A `custom_title`
 * line gives the title, and the newest one wins. A line of a Managed Session
 * log marks the session as one this mapping does not read.
 *
 * An `assistant` line right after a request stopped with Esc is the part of
 * the reply Qwen Code had when it stopped, written after the stop. It changes
 * nothing, even when that part calls a tool: no tool runs, and the turn is
 * over.
 *
 * Results that include a stopped call are idle because Esc while tools run
 * ends the turn, whichever calls finished first. When only a declined call
 * was among them, Qwen Code goes on, and its next request, written from
 * 0.25.1, or a reply that calls a tool shows the session as working again.
 */
export function foldQwenCodeRecord(fold: QwenCodeFold, record: QwenCodeRecord): QwenCodeFold {
  let next = fold;
  if (record.managed || (record.subtype !== undefined && MANAGED_SUBTYPES.has(record.subtype))) {
    next = { ...next, managed: true };
  }
  const { at } = record;
  switch (record.type) {
    case "user": {
      const event = userEvent(record);
      return event === null ? next : withEvent(next, event, at);
    }
    case "assistant": {
      if (record.subtype !== undefined) return next;
      // The part of a reply stopped with Esc, written after the stop.
      if (next.event === "cancelled") return next;
      if (record.oversized) return withEvent(next, "oversized-reply", at);
      if (record.calls) return withEvent({ ...next, batchCancelled: false }, "calls", at);
      if (record.message) return withEvent(next, "reply", at);
      return next;
    }
    case "tool_result": {
      const batchCancelled = next.batchCancelled || record.cancelled === true;
      return withEvent(
        { ...next, batchCancelled },
        batchCancelled ? "cancelled-results" : "results",
        at,
      );
    }
    case "system": {
      if (record.subtype === "rewind") return withEvent(next, "rewind", at);
      if (record.subtype === "turn_result") return withEvent(next, "turn-end", at);
      if (record.subtype === "custom_title" && record.title !== undefined) {
        return { ...next, title: record.title };
      }
      const lifecycle = record.lifecycle;
      if (record.subtype !== "ui_telemetry" || lifecycle === undefined || lifecycle.subagent) {
        return next;
      }
      if (lifecycle.phase === "started") {
        const beforeRequest =
          next.event === "request"
            ? next.beforeRequest
            : { event: next.event, eventAt: next.eventAt };
        return withEvent({ ...next, beforeRequest }, "request", at);
      }
      if (lifecycle.outcome === "cancelled") {
        return withEvent({ ...next, beforeRequest: null }, "cancelled", at);
      }
      return afterRequest(next, at);
    }
    default:
      return withEvent(next, "unknown-type", at);
  }
}

/** Lines this little before the session's process registered it are its own. */
const WRITE_ORDER_SLACK_MS = 1_000;

/** A status, and since when, as the lines say it. */
export interface QwenCodeStatus {
  status: SessionStatus;
  /** When the status began, when the lines say. */
  since: number | null;
}

/**
 * Maps what a live session's chat file says to a status. `fold` is null when
 * there is no chat file. `liveSince` is when its Qwen Code process registered
 * the session, from its record in the list of running sessions.
 *
 * The first rule that holds wins:
 *
 * 1. A Managed Session log: unknown.
 * 2. No chat file, or no line that says anything in a file read whole: idle
 *    since the session registered.
 * 3. No line that says anything in a file read from its middle: unknown.
 * 4. A newest event from before the session registered, left by an earlier
 *    Qwen Code that resumed it or stopped mid-turn: idle since it registered.
 * 5. A prompt, activity, calls, results or a request as the newest event:
 *    working. A request that fails for good writes nothing more, so its
 *    session stays working until the next prompt.
 * 6. A reply, results with a stopped call, a rewind, a turn's end or a
 *    stopped request: idle.
 * 7. Anything else: unknown.
 *
 * It never returns "needs-you", "failed" or "finished": Qwen Code writes
 * nothing while it waits for an approval, writes no line when a request has
 * failed for good, and a closed session is decided from the list of running
 * sessions. A working session's time is when its stretch of work began, or
 * null when that is not in what was read. An idle session's is never before
 * it registered.
 */
export function mapQwenCodeStatus(
  fold: QwenCodeFold | null,
  liveSince: number | null,
): QwenCodeStatus {
  if (fold?.managed) return { status: "unknown", since: null };
  const registered = (at: number | null) =>
    at === null || liveSince === null || at >= liveSince - WRITE_ORDER_SLACK_MS;
  if (fold === null || (fold.event === null && fold.whole)) {
    return { status: "idle", since: liveSince };
  }

  if (fold.event === null) return { status: "unknown", since: null };
  if (!registered(fold.eventAt)) return { status: "idle", since: liveSince };
  const status = statusOf(fold.event);
  if (status === "working") return { status, since: fold.sinceSeen ? fold.since : null };
  if (status === "idle") {
    const { since } = fold;
    return {
      status,
      since: since !== null && liveSince !== null ? Math.max(since, liveSince) : since,
    };
  }
  return { status: "unknown", since: null };
}
