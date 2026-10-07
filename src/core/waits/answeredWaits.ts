// A wait Agent Lookout answered. When the person presses Allow or Deny, or a
// permission rule answers, Claude Code takes the answer at once and rewrites
// its registry file a second or two later. A poll in that time still reads
// the session as waiting for permission, in the same wait. That wait is over
// from the moment of the answer, whatever such a poll says, and a wait a rule
// answered before any poll saw it is never told of at all.
//
// The collector remembers each answer, and marks the session `answered` in
// every snapshot that still finds it in that wait, for `ANSWER_HOLDS_MS` at
// most. Every place that announces or counts a wait goes by `needsYou`, which
// leaves such a session out: the page's notifications and the collector's
// own, email, the webhook, the long wait reminder and quiet hours, which all
// read the same snapshot, the history's points, and the Events log and the
// waits, which the poller works out at the same poll. So the page and the
// collector decide alike at the same poll. Nothing of it is written anywhere,
// and it holds nothing of what was asked.

import type { Session, SessionsSnapshot, SourceId } from "../sessions/session.ts";

/**
 * How long an answer stands for its wait while the session still reads as
 * in it. Claude Code rewrites its file within about 2 seconds of an answer.
 * A session that still reads as in the wait past this may be at a prompt the
 * answer was not for, such as one shown again with the same status time and
 * no request of its own, or one the answer never reached. So it needs the
 * person again, and is told of late rather than never.
 */
export const ANSWER_HOLDS_MS = 10_000;

/** An answer the collector remembers: the session's source, when the wait it answered began, and when it was given. */
export interface AnsweredWait {
  source: SourceId;
  /** The wait's status time, as the session's registry file gave it, or null when it gave none. */
  since: number | null;
  /** When the answer was given, on the collector's clock. */
  at: number;
}

/** Whether a session needs the person now: it waits, in a wait Agent Lookout has not answered. */
export function needsYou(session: Pick<Session, "status" | "answered">): boolean {
  return session.status === "needs-you" && session.answered !== true;
}

/**
 * Whether a session, as a poll found it, is still in the wait an answer was
 * for: waiting for permission, since the same status time. A wait since
 * another time is another wait, and a wait for anything else is not the
 * prompt that was answered. A time that either side does not know says
 * nothing about the wait, as in `waitChanges`.
 */
export function inAnsweredWait(
  session: Pick<Session, "status" | "waitingReason" | "statusSince">,
  wait: Pick<AnsweredWait, "since">,
): boolean {
  if (session.status !== "needs-you" || session.waitingReason !== "permission") return false;
  return wait.since === null || session.statusSince === null || session.statusSince === wait.since;
}

export interface AnsweredNow {
  /** The ids of the poll's sessions still in a wait that was answered. */
  ids: Set<string>;
  /** The answers to remember for the next poll. */
  kept: Map<string, AnsweredWait>;
}

/**
 * Puts the answers remembered, by session id, to one poll's sessions, made at
 * `now`: which of them are still in the wait an answer was for, and which
 * answers to keep. An answer is let go once a poll that read its session's
 * source finds the session in any other status or wait, or does not find it,
 * and in any case `ANSWER_HOLDS_MS` after it was given, or once the clock is
 * set that far back. One whose source could not be read this time is kept as
 * it is until then.
 */
export function answeredNow(
  answers: ReadonlyMap<string, AnsweredWait>,
  snapshot: Pick<SessionsSnapshot, "sources" | "sessions">,
  now: number,
): AnsweredNow {
  const read = new Set(
    snapshot.sources
      .filter((source) => source.state === "ok" || source.state === "not-set-up")
      .map((source) => source.id),
  );
  const listed = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const ids = new Set<string>();
  const kept = new Map<string, AnsweredWait>();
  for (const [id, wait] of answers) {
    if (Math.abs(now - wait.at) >= ANSWER_HOLDS_MS) continue;
    if (!read.has(wait.source)) {
      kept.set(id, wait);
      continue;
    }
    const session = listed.get(id);
    if (session === undefined || !inAnsweredWait(session, wait)) continue;
    ids.add(id);
    kept.set(id, wait);
  }
  return { ids, kept };
}
