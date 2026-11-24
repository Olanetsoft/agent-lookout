// How Oh My Pi's sessions map onto the session model. Pure, so the collector
// today and a browser or desktop host later share one mapping.
//
// Oh My Pi writes each entry of a session as one line of its file: the
// person's prompts, the model's replies, each tool's result, a line just
// before each tool runs, from 19.1.0 a line when a tool begins to wait for the
// person's approval and one when that wait ends, and a line when it stops,
// which says whether it stopped on an error of its own. Nothing it writes says
// that a turn is over and the session waits for its next prompt. So the status
// comes from the newest line that decides, the approvals asked for since the
// newest exit that nothing has ended, and whether an `omp` that could have
// written each still runs. Built from Oh My Pi's source at v19.0.0, with its
// approval lines read at v19.1.1, and not yet checked on a computer running
// it. See docs/adapters/oh-my-pi.md.

import { KEEP_AWAKE_WORKING_MS } from "../../keep-awake/keepAwakeRule.ts";
import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";
import { plausibleTime } from "../../time.ts";
import type {
  DeepseekHarnessWait,
  DeepseekHarnessWriter,
} from "../deepseek-harness/deepseekHarnessMapping.ts";

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

/** An approval Oh My Pi asked the person for, with no line after its own that ends the wait. */
export interface OhMyPiApproval {
  /** Where its line begins in the file, which tells it from any other. */
  start: number;
  /** When it was asked, as written, in epoch milliseconds, or null when that is not known. */
  at: number | null;
  /**
   * Whether a prompt or a reply follows it, as one does when a command a
   * `bash` call runs asks: Oh My Pi ends the call with a result, and the
   * command waits on in the background (docs/approval-mode.md:18 and
   * tools/bash.ts:2109-2183 at v19.1.1). So one with such a line after it
   * still waits, and one a crash left looks the same.
   */
  replied: boolean;
}

/** What the lines since the newest exit say of approvals. */
export interface OhMyPiApprovals {
  /** Those nothing has ended, in the order they were asked. */
  open: readonly OhMyPiApproval[];
  /**
   * Why another, asked since the newest prompt, reply or exit, could wait
   * that is not among them: `unread` when a line since could not be read,
   * `too-far` when those lines begin too far back to read, `too-many` when
   * more waited at once than are kept, and null when none could. One asked
   * before then holds up no turn, so it is not counted here.
   */
  unsure: "unread" | "too-far" | "too-many" | null;
}

/** Such an approval, with what `ps` says of the `omp` that asked. */
export interface OhMyPiJudgedApproval extends OhMyPiApproval {
  /** Whether a program that could have asked may still run, judged by the time `askedAtOf` gives. Not looked at when that gives none. */
  writer: OhMyPiWriter;
}

export interface OhMyPiJudgedApprovals extends OhMyPiApprovals {
  open: readonly OhMyPiJudgedApproval[];
}

/** What a file with no approval in it says, as one from before Oh My Pi 19.1.0 does. */
export const NO_APPROVALS: OhMyPiJudgedApprovals = { open: [], unsure: null };

/**
 * Whether a program that could have written a session's file may still run,
 * from `ps` and the computer's start: `gone` when none could, `backed` when
 * an `omp` that started before the last write `decidedAtOf` gives, or before
 * the time `askedAtOf` gives for an approval, runs, else `maybe`.
 */
export type OhMyPiWriter = DeepseekHarnessWriter;

type ExitLine = Extract<OhMyPiLine, { sort: "exit" }>;

/** What is read of a session, before `ps` is asked. */
export interface OhMyPiRead {
  /** The newest line that decides, or null when it is too far back to read. */
  newest: OhMyPiLine | null;
  /** An exit behind a newest reply or result, with only replies, results and lines passed over after it. */
  behind: ExitLine | null;
  /** An exit before a newest reply, result, tool or ask, with tools' and asks' starts after it too, as a quit that cuts a turn off leaves. */
  cutOff: ExitLine | null;
  /** The approvals asked for since the newest exit. */
  approvals: OhMyPiApprovals;
  /** The file's last write, as written, in epoch milliseconds. */
  writtenAt: number | null;
  /** The time its header says it began, in epoch milliseconds, or null when that is not a time. */
  startedAt: number | null;
  /** False when the file was written since what these facts hold was read and could not be read again. */
  current?: boolean;
  now: number;
}

export interface OhMyPiFacts extends OhMyPiRead {
  approvals: OhMyPiJudgedApprovals;
  writer: OhMyPiWriter;
}

export interface OhMyPiStatus {
  status: SessionStatus;
  since: number | null;
  waitingReason?: WaitingReason;
  /** What it waits on, for telling a wait that goes on from a new one. Present only while it needs the person. */
  wait?: DeepseekHarnessWait;
  /** Why an approval could wait unseen, present only when that alone leaves it unknown. */
  unseen?: Exclude<OhMyPiApprovals["unsure"], null>;
  /** Whether the session's last write is shown: only while it works. */
  showsLastWrite: boolean;
}

const UNKNOWN: OhMyPiStatus = { status: "unknown", since: null, showsLastWrite: false };

/** The earliest of the times that are known, or null with none. */
function earliest(times: readonly (number | null)[]): number | null {
  const known = times.filter((time): time is number => time !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/** A wait that began at the earliest of these times that is known, on these. */
function needsYou(
  waitingReason: WaitingReason,
  times: readonly (number | null)[],
  ids: readonly string[],
): OhMyPiStatus {
  const since = earliest(times);
  return {
    status: "needs-you",
    since,
    waitingReason,
    wait: { since, ids: [...ids] },
    showsLastWrite: false,
  };
}

/**
 * The approvals of this session's own that nothing has ended: each but one
 * asked before the header's time, when that can be right. A copy keeps each
 * line with the time it had under a header stamped as it is made, as `exitOf`
 * says of an exit, and a prompt another session opened waits there. Oh My Pi
 * ends the open calls of a fork made with `--fork` with results, but a session
 * it moves to a file of its own, as when another `omp` holds it, keeps its
 * lines as they are (session-manager.ts:1415-1452, :4498-4519 at v19.1.1).
 * After `/fork`, which keeps the `omp`, it waits in the copy, and that cannot
 * be told. A clock set back past the header before an approval is asked does
 * the same to a session's own. One with no time that is known counts as its
 * own.
 */
function approvalsOf<Approval extends OhMyPiApproval>(facts: {
  approvals: { open: readonly Approval[] };
  startedAt: number | null;
  now: number;
}): readonly Approval[] {
  const header = plausibleTime(facts.startedAt, facts.now);
  if (header === null) return facts.approvals.open;
  return facts.approvals.open.filter(({ at }) => at === null || at >= header);
}

/**
 * The time the `omp` that asked for an approval started before, which `ps` is
 * judged against for it: when it was asked, and never later than the file's
 * last write, or null when that is not known or cannot be right. A prompt or
 * a reply written since has another time, and can be another `omp`'s, which
 * opened the file after a crash and holds no prompt of the first's open.
 */
export function askedAtOf(
  approval: Pick<OhMyPiApproval, "at">,
  facts: Pick<OhMyPiRead, "writtenAt" | "now">,
): number | null {
  const at = plausibleTime(approval.at, facts.now);
  if (at === null || facts.writtenAt === null) return at;
  return Math.min(at, Math.floor(facts.writtenAt));
}

/**
 * Whether a program that could have asked for an approval may still run. With
 * no time known it is whether one that could have written the session may,
 * while no prompt or reply follows it, and after one, which another `omp` may
 * have written, only that none could is known.
 */
function approvalWriterOf(approval: OhMyPiJudgedApproval, facts: OhMyPiFacts): OhMyPiWriter {
  if (askedAtOf(approval, facts) !== null) return approval.writer;
  if (!approval.replied || facts.writer === "gone") return facts.writer;
  return "maybe";
}

/**
 * The last write that `ps` and the computer's start are judged against, and
 * that a session no program could still write is finished since: when the
 * newest line that decides is a reply or a result, the time on its line, and
 * while an approval nothing has ended is open with no prompt or reply after
 * it, the time it was asked, the later of the two, or the header's when that
 * is later, and never later than the file's last write; else the file's last
 * write. An `omp` that wrote such a line started before the time it put on it,
 * and one that made a copy, as a fork, a branch and an import do, which keep
 * each line's time, started before the header it wrote
 * (session-manager.ts:2546-2563, :2814, :2090-2100, :4184-4198). So a later
 * write that decides nothing, as a rename from another `omp`'s picker adds,
 * neither backs the session again nor moves the time it finished. For a
 * prompt, a tool's start or an ask with no such approval, and for a reply, a
 * result or such an approval with no time that can be right, as a refusal's,
 * it is the file's last write. So it is for a file written since it was read
 * and not read again, whose write may be an `omp`'s that started since. Null
 * when that cannot be right.
 */
export function decidedAtOf(
  facts: Pick<OhMyPiRead, "newest" | "approvals" | "writtenAt" | "startedAt" | "current" | "now">,
): number | null {
  const { newest, now } = facts;
  const written = facts.writtenAt === null ? null : plausibleTime(Math.floor(facts.writtenAt), now);
  if (written === null || facts.current === false) return written;
  const times = approvalsOf(facts)
    .filter(({ replied }) => !replied)
    .map(({ at }) => plausibleTime(at, now));
  if (newest?.sort === "reply" || newest?.sort === "result") {
    times.push(plausibleTime(newest.at, now));
  }
  const known = times.filter((time): time is number => time !== null);
  if (known.length === 0 || known.length < times.length) return written;
  const at = Math.max(...known);
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
 * needs you.
 *
 * An exit whose time is before the header's, when that can be right, decides
 * nothing, newest, behind or cut off alike. A fork and a branch copy each
 * line with the time it had under a header they stamp as they copy
 * (session-manager.ts:2546-2576, :4165-4198, :4331-4351, :2090-2100), so such
 * an exit is taken as the session copied's, not the copy's. An import holds no
 * exit. A clock set back past the header before the exit is written does the
 * same to a session's own exit.
 *
 * Nor does an exit decide while an approval of the session's own asked after
 * it has no end: a quit ends those it aborts, so an `omp` ran again, as when
 * `--restore` goes on with the turn, or code the person runs in a resumed
 * session calls a tool, which writes no other line until it ends
 * (eval-runner.ts:55-92 at v19.1.1). Judged against `now` on every poll, and
 * never kept.
 */
export function exitOf(
  facts: Pick<OhMyPiRead, "newest" | "behind" | "cutOff" | "approvals" | "startedAt" | "now">,
): ExitLine | null {
  const { newest, behind, cutOff, now } = facts;
  // Those kept are all asked since the newest exit.
  if (approvalsOf(facts).length > 0) return null;
  const header = plausibleTime(facts.startedAt, now);
  /** Whether the exit is this session's own, not one copied from another. */
  const own = (exit: ExitLine) => header === null || exit.at >= header;
  if (newest?.sort === "exit") return own(newest) ? newest : null;
  if (behind !== null) return own(behind) ? behind : null;
  if (cutOff === null || !own(cutOff)) return null;
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
 * | 1   | an approval of its own with no end waits: an `omp` that started before it was asked runs, and the file was written in the last 30 minutes | needs-you | when the first of those that wait was asked |
 * | 2   | the exit that decides, as `exitOf` gives it, is of kind `fatal`          | failed     | its `recordedAt` |
 * | 3   | the same, of any other kind                                              | finished   | its `recordedAt` |
 * | 4   | no program that could have written it runs, or it was written before the computer started, by `decidedAtOf`'s time | finished | that time |
 * | 5   | no `omp` backs it, or it wrote nothing in the last 30 minutes            | unknown    | none            |
 * | 6   | the newest line cannot be read, or is too far back                       | unknown    | none            |
 * | 7   | its `ask` tool waits                                                     | needs-you  | the ask's start |
 * | 8   | a prompt, a result or a tool is newest, no approval could wait unseen, and none with no end has an `omp` that may still run | working | none |
 * | 9   | anything else, a reply newest among them                                 | unknown    | none            |
 *
 * Idle never shows: a reply that ends a turn reads as one that names a tool
 * next. An approval waits whatever the session goes on to write, as one does
 * while its command runs in the background, and the reply or the prompt after
 * it is judged by its own time, so a later `omp` that opened the file backs
 * the session and not the approval. An approval that waits while an `ask`
 * does is the reason shown, and the wait began at the earlier of the two.
 * Before Oh My Pi 19.1.0 a wait for an approval is not written, so it reads
 * as the tool running. An exit whose time cannot be right, or is before the
 * header's, finishes nothing by itself. Every time is judged against `now`
 * here, on every poll: one more than a minute ahead of it is none.
 */
export function ohMyPiStatusOf(facts: OhMyPiFacts): OhMyPiStatus {
  const { newest, writer, now } = facts;
  const written = facts.writtenAt === null ? null : plausibleTime(Math.floor(facts.writtenAt), now);
  const recent = written !== null && now - written < QUIET_MS;
  const approvals = approvalsOf(facts);
  const waiting = approvals.filter((one) => approvalWriterOf(one, facts) === "backed");
  if (recent && waiting.length > 0) {
    const times = waiting.map(({ at }) => plausibleTime(at, now));
    const ids = waiting.map(({ start }) => `approval:${start}`);
    if (newest?.sort === "ask" && writer === "backed") {
      times.push(plausibleTime(newest.at, now));
      ids.push(`ask:${newest.at}`);
    }
    return needsYou("permission", times, ids);
  }
  const exit = exitOf(facts);
  if (exit !== null) {
    const at = plausibleTime(exit.at, now);
    if (at !== null)
      return { status: exit.fatal ? "failed" : "finished", since: at, showsLastWrite: false };
  }
  if (writer === "gone")
    return { status: "finished", since: decidedAtOf(facts), showsLastWrite: false };
  if (writer !== "backed" || !recent) return UNKNOWN;
  const { unsure } = facts.approvals;
  const unseen: OhMyPiStatus = unsure === null ? UNKNOWN : { ...UNKNOWN, unseen: unsure };
  // With no line that decides in reach, what could wait further back is why.
  if (newest === null) return unseen;
  switch (newest.sort) {
    case "ask":
      return needsYou("question", [plausibleTime(newest.at, now)], [`ask:${newest.at}`]);
    case "prompt":
    case "result":
    case "tool":
      // An approval could wait where this does not see it, or where its `omp` cannot be told, so it is not said to work.
      if (approvals.some((one) => approvalWriterOf(one, facts) === "maybe")) return UNKNOWN;
      if (unsure !== null) return unseen;
      return { status: "working", since: null, showsLastWrite: true };
    default:
      return UNKNOWN;
  }
}
