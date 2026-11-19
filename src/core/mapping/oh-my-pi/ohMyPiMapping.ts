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

/**
 * How long after an exit the newest reply or result may be written, by the
 * time its own line carries, for the exit cut off to decide: 15 seconds. On a
 * quit Oh My Pi writes its exit, runs its extensions' shutdown handlers,
 * which have no time limit, aborts the turn, and goes on writing until it
 * stops forwarding: after a wait of up to 5 seconds, one of up to 3, a
 * teardown whose waits are up to 3 seconds each, and up to 5 seconds more
 * (agent-session.ts:638, :6983, :7202-7305). So 15 seconds covers a turn that
 * stops at once, not the longest case.
 */
export const CUT_OFF_MS = 15_000;

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
  /** A tool's result, with the time Oh My Pi wrote on its line, or null when that cannot be read. */
  | { sort: "result"; at: number | null }
  /** A reply, with the time Oh My Pi wrote on its line, or a provider's refusal of one, which has none where it is read: null. */
  | { sort: "reply"; at: number | null }
  /** A line of a kind that decides, in a shape this does not read. */
  | { sort: "unreadable" };

/**
 * Whether a program that could have written a session's file may still run,
 * from `ps` and the computer's start: `gone` when none could, `backed` when
 * an `omp` that started before the last write `decidedAtOf` gives runs, else
 * `maybe`.
 */
export type OhMyPiWriter = DeepseekHarnessWriter;

type ExitLine = Extract<OhMyPiLine, { sort: "exit" }>;

export interface OhMyPiFacts {
  /** The newest line that decides, or null when it is too far back to read. */
  newest: OhMyPiLine | null;
  /** An exit behind a newest reply or result, with only replies, results and lines passed over after it. */
  behind: ExitLine | null;
  /** An exit before a newest reply, result, tool or ask, with tools' and asks' starts after it too, as a quit that cuts a turn off leaves. */
  cutOff: ExitLine | null;
  /** The file's last write, as written, in epoch milliseconds. */
  writtenAt: number | null;
  /** The time its header says it began, in epoch milliseconds, or null when that is not a time. */
  startedAt: number | null;
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
 * The last write that `ps` and the computer's start are judged against, and
 * that a session no program could still write is finished since: when the
 * newest line that decides is a reply or a result, the time on its line, or
 * the header's when that is later, and never later than the file's last
 * write; else the file's last write. An `omp` that wrote such a line started
 * before the time it put on it, and one that made a copy, as a fork, a branch
 * and an import do, which keep each line's time, started before the header
 * it wrote (session-manager.ts:2546-2563, :2814, :2090-2100, :4184-4198). So
 * a later write that decides nothing, as a rename from another `omp`'s picker
 * adds, neither backs the session again nor moves the time it finished. For
 * a prompt, a tool's start, an ask, and a reply or a result with no time that
 * can be right, as a refusal's, it is the file's last write. Null when that
 * cannot be right.
 */
export function decidedAtOf(
  facts: Pick<OhMyPiFacts, "newest" | "writtenAt" | "startedAt" | "now">,
): number | null {
  const { newest, now } = facts;
  const written = facts.writtenAt === null ? null : plausibleTime(Math.floor(facts.writtenAt), now);
  if (written === null || (newest?.sort !== "reply" && newest?.sort !== "result")) return written;
  const at = plausibleTime(newest.at, now);
  if (at === null) return written;
  const header = plausibleTime(facts.startedAt, now);
  return Math.min(written, header === null ? at : Math.max(at, header));
}

/**
 * The exit that decides a session's status, or null: the newest line when it
 * is an exit, else the exit behind it, else the exit cut off before a newest
 * reply or result. The exit behind, with only replies, results and lines
 * passed over after it, decides whatever their times, so a round run later
 * with no prompt that starts no tool, as `/retry` and `--restore` can run,
 * still reads as ended at the exit. The exit cut off, with a tool's or an
 * ask's start after it, decides only while the newest line's own time, which
 * Oh My Pi takes from the same clock as the exit's as it adds each line, is
 * from the exit's time to 15 seconds after it, as Oh My Pi's own aborted
 * lines are. A reply or a result whose time cannot be read, as a refusal's,
 * or cannot be right, never takes it. So once a tool's start follows the
 * exit, a turn whose aborted lines take longer, or a round run later with no
 * prompt, reads as if no exit had been written. A later line passed over, as
 * a rename adds, changes nothing, since the file's last write is not looked
 * at. A newest tool's or ask's start never takes it, so a restored ask still
 * needs you. Judged against `now` on every poll, and never kept.
 */
export function exitOf(
  facts: Pick<OhMyPiFacts, "newest" | "behind" | "cutOff" | "now">,
): ExitLine | null {
  const { newest, behind, cutOff, now } = facts;
  if (newest?.sort === "exit") return newest;
  if (behind !== null) return behind;
  if (cutOff === null) return null;
  if (newest?.sort !== "reply" && newest?.sort !== "result") return null;
  const at = plausibleTime(newest.at, now);
  if (at === null) return null;
  return at >= cutOff.at && at <= cutOff.at + CUT_OFF_MS ? cutOff : null;
}

/**
 * A session's status, the first row that holds:
 *
 * | Row | When                                                                     | Status     | Since           |
 * | --- | ------------------------------------------------------------------------ | ---------- | --------------- |
 * | 1   | the exit that decides, as `exitOf` gives it, is of kind `fatal`          | failed     | its `recordedAt` |
 * | 2   | the same, of any other kind                                              | finished   | its `recordedAt` |
 * | 3   | no program that could have written it runs, or it was written before the computer started, by `decidedAtOf`'s time | finished | that time |
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
  const { newest, writer, now } = facts;
  const written = facts.writtenAt === null ? null : plausibleTime(Math.floor(facts.writtenAt), now);
  const exit = exitOf(facts);
  if (exit !== null) {
    const at = plausibleTime(exit.at, now);
    if (at !== null)
      return { status: exit.fatal ? "failed" : "finished", since: at, showsLastWrite: false };
  }
  if (writer === "gone")
    return { status: "finished", since: decidedAtOf(facts), showsLastWrite: false };
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
