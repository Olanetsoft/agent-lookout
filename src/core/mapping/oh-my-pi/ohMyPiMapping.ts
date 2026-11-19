// How Oh My Pi's sessions map onto the session model. Pure, so the collector
// today and a browser or desktop host later share one mapping.
//
// Oh My Pi writes each entry of a session as one line of its file: the
// person's prompts, the model's replies, each tool's result, a line just
// before each tool runs, and a line when it stops, which says whether it
// stopped on an error of its own. Nothing it writes says that a turn is over
// and the session waits for its next prompt, or that a tool waits for an
// approval. So the status comes from the newest line that decides, and from
// whether an `omp` that could have written the file still runs. Built from
// Oh My Pi's source at v19.0.0 and not yet checked on a computer running it.
// See docs/adapters/oh-my-pi.md.

import { KEEP_AWAKE_WORKING_MS } from "../../keep-awake/keepAwakeRule.ts";
import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";
import { plausibleTime } from "../../time.ts";
import type { DeepseekHarnessWriter } from "../deepseek-harness/deepseekHarnessMapping.ts";

/**
 * How long a session may write nothing and still show as working or as
 * needing you: 30 minutes, the same as keep-awake's. A crash leaves an open
 * turn behind, and so does a turn that ends with nothing written.
 */
export const QUIET_MS = KEEP_AWAKE_WORKING_MS;

/** A line of a session's file that decides its status. Times are as written, in epoch milliseconds. */
export type OhMyPiLine =
  /** Oh My Pi wrote that it stopped: `fatal` when on an error of its own. */
  | { sort: "exit"; fatal: boolean; at: number }
  /** Its `ask` tool began to wait for the person's answer. */
  | { sort: "ask"; at: number }
  /** Another tool began to run. */
  | { sort: "tool" }
  /** A prompt of the person's, or one Oh My Pi sent for them. */
  | { sort: "prompt" }
  /** A tool's result. */
  | { sort: "result" }
  /** A reply, or a provider's refusal of one. */
  | { sort: "reply" }
  /** A line of a kind that decides, in a shape this does not read. */
  | { sort: "unreadable" };

/**
 * Whether a program that could have written a session's file may still run,
 * from `ps` and the computer's start: `gone` when none could, `backed` when
 * an `omp` that started before the last write runs, else `maybe`.
 */
export type OhMyPiWriter = DeepseekHarnessWriter;

export interface OhMyPiFacts {
  /** The newest line that decides, or null when it is too far back to read. */
  newest: OhMyPiLine | null;
  /** An exit behind a newest reply or result, with only replies, results and lines passed over after it. */
  behind: Extract<OhMyPiLine, { sort: "exit" }> | null;
  /** The file's last write, as written, in epoch milliseconds. */
  writtenAt: number | null;
  writer: OhMyPiWriter;
  now: number;
}

export interface OhMyPiStatus {
  status: SessionStatus;
  since: number | null;
  waitingReason?: WaitingReason;
  /** Whether the session's last write is shown: only while it works. */
  showsLastWrite: boolean;
}

const UNKNOWN: OhMyPiStatus = { status: "unknown", since: null, showsLastWrite: false };

/**
 * A session's status, the first row that holds:
 *
 * | Row | When                                                                     | Status     | Since           |
 * | --- | ------------------------------------------------------------------------ | ---------- | --------------- |
 * | 1   | the newest line, or the exit behind it, is an exit of kind `fatal`       | failed     | its `recordedAt` |
 * | 2   | the same, of any other kind                                              | finished   | its `recordedAt` |
 * | 3   | no program that could have written it runs, or it was written before the computer started | finished | its last write |
 * | 4   | the newest line cannot be read, or is too far back                       | unknown    | none            |
 * | 5   | its `ask` tool waits, an `omp` backs it, and it wrote in the last 30 minutes | needs-you | the ask's start |
 * | 6   | a prompt, a result or a tool is newest, backed and written as lately     | working    | none            |
 * | 7   | anything else, a reply newest among them                                 | unknown    | none            |
 *
 * Idle never shows: a reply that ends a turn reads as one that names a tool
 * next. A wait for a tool's approval reads as the tool running. An exit whose
 * time cannot be right finishes nothing by itself. Every time is judged
 * against `now` here, on every poll: one more than a minute ahead of it is
 * none.
 */
export function ohMyPiStatusOf(facts: OhMyPiFacts): OhMyPiStatus {
  const { newest, behind, writer, now } = facts;
  const exit = newest?.sort === "exit" ? newest : behind;
  if (exit !== null) {
    const at = plausibleTime(exit.at, now);
    if (at !== null)
      return { status: exit.fatal ? "failed" : "finished", since: at, showsLastWrite: false };
  }
  const written = facts.writtenAt === null ? null : plausibleTime(Math.floor(facts.writtenAt), now);
  if (writer === "gone") return { status: "finished", since: written, showsLastWrite: false };
  if (newest === null || newest.sort === "unreadable") return UNKNOWN;
  const recent = written !== null && now - written < QUIET_MS;
  if (writer !== "backed" || !recent) return UNKNOWN;
  if (newest.sort === "ask") {
    return {
      status: "needs-you",
      since: plausibleTime(newest.at, now),
      waitingReason: "question",
      showsLastWrite: false,
    };
  }
  if (newest.sort === "prompt" || newest.sort === "result" || newest.sort === "tool") {
    return { status: "working", since: null, showsLastWrite: true };
  }
  return UNKNOWN;
}
