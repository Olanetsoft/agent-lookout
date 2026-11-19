// How Muse Code's sessions map onto the session model. Pure, so the collector
// today and a browser or desktop host later share one mapping.
//
// A session's status comes from its log's newest turn (`museCodeFold.ts`),
// and from whether a Muse Code program that started no later than a minute
// after `decidedAt` still runs, by `ps`, as the DeepSeek Harness and Oh My Pi
// adapters judge it (`src/collector/adapters/deepseek-harness/processes.ts`).
// Nothing used ties a session to its process, and one `muse serve` holds
// many sessions, so any such program counts. Built from Meta's documentation, its
// MIT-licensed Muse Code SDK and protocol schema at 1.4.24, its cookbook, and
// open-source readers of Muse Code's files, and not yet checked on a computer
// running it. See docs/adapters/muse-code.md.

import { KEEP_AWAKE_WORKING_MS } from "../../keep-awake/keepAwakeRule.ts";
import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";
import { plausibleTime } from "../../time.ts";
import type {
  DeepseekHarnessWait,
  DeepseekHarnessWriter,
} from "../deepseek-harness/deepseekHarnessMapping.ts";
import type { MuseApproval, MuseFold } from "./museCodeFold.ts";

/**
 * How long an open turn may write nothing and still show as working: 30
 * minutes, the same as keep-awake's. A crash leaves an open turn behind while
 * another Muse Code runs.
 */
export const QUIET_MS = KEEP_AWAKE_WORKING_MS;

/**
 * How long the automated reviewer may hold an approval with no answer before
 * it shows as waiting for the person: 2 minutes, past the longest hold seen,
 * about 90 seconds.
 */
export const REVIEW_LIMIT_MS = 2 * 60_000;

/**
 * How long an approval with no word of a reviewer shows as working: 6
 * seconds, Muse Code's own delay before it tells hooks an approval prompt
 * waits. It covers the milliseconds before a reviewer's record is written.
 */
export const ASK_DELAY_MS = 6_000;

/** What a session's log shows. */
export type MuseView =
  | { state: "ok"; fold: MuseFold }
  /** Its newest turn began more than the reader looks back, or it has no turn in what it looks back over. */
  | { state: "too-far" }
  /** Its newest line that decides cannot be read, or too many questions and approvals are open. */
  | { state: "unsure" };

/** Whether a Muse Code program that could hold a session may still run. */
export type MuseCodeWriter = DeepseekHarnessWriter;

export interface MuseCodeFacts {
  view: MuseView;
  writer: MuseCodeWriter;
  /** The file's last write, in epoch milliseconds, as the poll read it. */
  writtenAt: number | null;
  /** The time `ps` and the computer's start are judged against (`decidedAtOf`). */
  decidedAt: number | null;
  now: number;
  /**
   * The approvals that waited for the person at the last poll, or at one before
   * it while no poll since could tell whether a Muse Code holds the session:
   * they wait while they are open.
   */
  waited: ReadonlySet<string>;
}

export interface MuseCodeStatus {
  status: SessionStatus;
  since: number | null;
  waitingReason?: WaitingReason;
  /** What it waits on, for telling a wait that goes on from a new one. */
  wait?: DeepseekHarnessWait;
  /** Whether the session's last write is shown: only while it works. */
  showsLastWrite: boolean;
}

const UNKNOWN: MuseCodeStatus = { status: "unknown", since: null, showsLastWrite: false };

/**
 * The time `ps` and the computer's start are judged against, and that a
 * session no Muse Code could still hold is finished since: the newest taken
 * record's `recorded_at`, never later than the file's last write. A Muse Code
 * that holds a session wrote every record taken, and started before it, so a
 * later write that decides nothing, as a rename or a setting change, neither
 * holds a finished session again nor moves its time. The file's last write
 * when that record has no time; none when its time cannot be right, so `ps`
 * cannot finish the session, or when the last write cannot be.
 */
export function decidedAtOf(
  fold: Pick<MuseFold, "lastRecordAt"> | null,
  writtenAt: number | null,
  now: number,
): number | null {
  const written = writtenAt === null ? null : plausibleTime(Math.floor(writtenAt), now);
  if (written === null || fold === null || fold.lastRecordAt === null) return written;
  const at = plausibleTime(fold.lastRecordAt, now);
  return at === null ? null : Math.min(at, written);
}

/** Whether the open run is shown as ended by Muse Code's own words, whatever `ps` says: rows 1 to 3. */
export function settledByLog(view: MuseView): boolean {
  if (view.state !== "ok") return true;
  const { fold } = view;
  if (fold.run.state === "open") return false;
  return fold.lastEnd?.end === "failed" || fold.marker?.sort === "end";
}

/**
 * When an open approval began to wait for the person, or undefined while it
 * does not: at once for `human_pending`; for one the automated reviewer
 * holds, after its word that is not a clean approval, or 2 minutes after the
 * request with no word; for one with no phase this knows, as for the
 * reviewer's when a review record was written, else 6 seconds after the
 * request. A timer needs a request time that can be right. One that waited
 * at the last poll, or at one before it while no poll since could tell
 * whether a Muse Code holds the session, waits while it is open, so a clock
 * set back never turns a wait back into work. Its time is null when none can
 * be right.
 */
function approvalWaitSince(
  approval: MuseApproval,
  waitedBefore: boolean,
  now: number,
): number | null | undefined {
  const requested = plausibleTime(approval.requestedAt, now);
  const believed = (at: number | null) => plausibleTime(at, now);
  if (approval.phase === "human_pending") return requested;
  const reviewed =
    approval.phase === "automated_reviewing" || approval.reviewed || approval.completion !== null;
  if (reviewed) {
    const { completion } = approval;
    if (completion !== null && !completion.clean) return believed(completion.at);
    const limit = requested === null ? null : requested + REVIEW_LIMIT_MS;
    if (completion === null && limit !== null && now >= limit) return believed(limit);
    if (!waitedBefore) return undefined;
    return completion === null && limit !== null ? believed(limit) : null;
  }
  if (requested !== null && now >= requested + ASK_DELAY_MS) return requested;
  return waitedBefore ? requested : undefined;
}

function earliest(times: readonly (number | null)[]): number | null {
  const known = times.filter((time): time is number => time !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * A session's status, the first row that holds:
 *
 * | Row | When                                                                        | Status    | Since              |
 * | --- | --------------------------------------------------------------------------- | --------- | ------------------ |
 * | 1   | its newest turn is too far back, or its newest line that decides cannot be read | unknown | none             |
 * | 2   | its run is not open and the newest end is `failed`                          | failed    | that end's time    |
 * | 3   | its run is not open and Muse Code wrote `session.end`                       | finished  | that record's time |
 * | 4   | `ps` cannot say, on Windows, or no time to judge it by can be right         | unknown   | none               |
 * | 5   | no Muse Code that started no later than a minute after `decidedAt` runs, or the computer started since | finished | `decidedAt` |
 * | 6   | its open run asks a question, or an approval waits for the person           | needs-you | the wait's start   |
 * | 7   | its run is open and its file was written in the last 30 minutes             | working   | the run's opening  |
 * | 8   | its run is open, quiet longer                                               | unknown   | none               |
 * | 9   | its run ended otherwise, or a host resumed it                               | idle      | that end or resume |
 *
 * Rows 2 and 3 need a time that can be right, or show as unknown: a line
 * whose time cannot be right only stops a finish. Every time is judged
 * against `now` here, on every poll.
 */
export function museCodeStatusOf(facts: MuseCodeFacts): MuseCodeStatus {
  const { view, writer, now, waited } = facts;
  if (view.state !== "ok") return UNKNOWN;
  const { fold } = view;
  const believed = (at: number | null) => plausibleTime(at, now);
  const open = fold.run.state === "open";
  if (!open && fold.lastEnd?.end === "failed") {
    const at = believed(fold.lastEnd.at);
    return at === null ? UNKNOWN : { status: "failed", since: at, showsLastWrite: false };
  }
  if (!open && fold.marker?.sort === "end") {
    const at = believed(fold.marker.at);
    return at === null ? UNKNOWN : { status: "finished", since: at, showsLastWrite: false };
  }
  if (writer === "maybe") return UNKNOWN;
  if (writer === "gone") {
    return { status: "finished", since: believed(facts.decidedAt), showsLastWrite: false };
  }

  if (open) {
    const ids: string[] = [];
    const starts: (number | null)[] = [];
    let approvals = false;
    for (const [prompt, at] of fold.prompts) {
      ids.push(`question:${prompt}`);
      starts.push(believed(at));
    }
    for (const [action, approval] of fold.approvals) {
      const since = approvalWaitSince(approval, waited.has(action), now);
      if (since === undefined) continue;
      ids.push(`approval:${action}`);
      starts.push(since);
      approvals = true;
    }
    if (ids.length > 0) {
      const since = earliest(starts);
      return {
        status: "needs-you",
        since,
        waitingReason: approvals ? "permission" : "question",
        wait: { since, ids },
        showsLastWrite: false,
      };
    }
    const written = facts.writtenAt === null ? null : believed(Math.floor(facts.writtenAt));
    if (written === null || now - written >= QUIET_MS) return UNKNOWN;
    return { status: "working", since: believed(fold.run.openedAt), showsLastWrite: true };
  }
  const since = fold.marker?.sort === "resumed" ? fold.marker.at : (fold.lastEnd?.at ?? null);
  return { status: "idle", since: believed(since), showsLastWrite: false };
}
