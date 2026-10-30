// Which sessions keep the Mac awake while the Mac app's switch Keep the Mac
// awake is on. The app holds off idle sleep while at least one session in the
// latest snapshot counts, and lets go once none does.
//
// - A session that needs you counts for as long as it is listed, however long
//   it has waited. It goes by `needsYou`, as the Dock badge does, so a wait
//   Agent Lookout has answered is not counted as one.
// - A working session counts until 30 minutes after its newest update: the
//   newer of when its status last changed and when its agent last wrote to
//   its file, of whichever of the two it has. A session that still reads as
//   waiting, in a wait Agent Lookout has answered, is working, as the page
//   lists it, so the Mac is not let go for the second or two before its agent
//   writes that it works again.
// - A working session with neither time does not count: nothing says it was
//   updated in the last 30 minutes.
// - A working Claude Code session, on this Mac or another, counts for as long
//   as it is listed. Its status is Claude Code's own word, read again at every
//   poll from a Claude Code that runs, and Claude Code drops the session when
//   its process ends. It rewrites no time as it works: a session busy on one
//   task for an hour keeps the status time it began with, and would stop
//   counting half an hour into its task. It goes by the source, never by
//   whether a write time is there, so a session of another agent whose write
//   time was left out, as one that could not be right is, is still held to
//   its status time.
// - Idle, finished, failed and unknown sessions never count.
//
// Sessions on another machine Agent Lookout watches count by the same rule.
// This Mac sends their notifications, emails, posts and pushes too, and sends
// nothing while it sleeps.
//
// The 30 minutes are what let the Mac sleep after a session that only seems
// to work: a Gemini CLI session whose terminal was closed while it worked
// keeps that status until it leaves the list, a day after its last update.
// A Codex session waiting for approval, which shows as working, stops
// counting after 30 quiet minutes too. So does an OpenCode session 30 minutes
// after the prompt that began its turn, the only time it has, however busy it
// is: OpenCode shows a session as working from its database alone, for as
// long as any OpenCode program runs, so a step that never ended would
// otherwise keep the Mac awake for the day it stays listed.
//
// It reads nothing and runs nothing, so the page and the app could share it.

import { isRemoteSource, type Session, type SourceId } from "../sessions/session.ts";
import { needsYou } from "../waits/answeredWaits.ts";

/** How long after its newest update a working session stops counting, in milliseconds. */
export const KEEP_AWAKE_WORKING_MS = 30 * 60 * 1000;

/** The agent whose working sessions count for as long as they are listed. */
export const LISTED_WORKING_SOURCE = "claude-code" satisfies SourceId;

/** What the rule reads of a session. */
export type KeepAwakeSession = Pick<
  Session,
  "id" | "source" | "status" | "answered" | "statusSince" | "lastWriteAt"
>;

/**
 * The agent a session belongs to: its source, or for a session on another
 * machine the source that machine read it from, which its id names after the
 * machine's own: `claude-code` for `remote:devbox:claude-code:…`.
 */
function agentSource(session: Pick<Session, "id" | "source">): string {
  if (!isRemoteSource(session.source)) return session.source;
  const machine = `${session.source}:`;
  if (!session.id.startsWith(machine)) return session.source;
  const rest = session.id.slice(machine.length);
  const colon = rest.indexOf(":");
  return colon < 0 ? session.source : rest.slice(0, colon);
}

/** Whether one session, as the snapshot made at `now` found it, keeps the Mac awake. */
export function keepsAwake(session: KeepAwakeSession, now: number): boolean {
  if (needsYou(session)) return true;
  const working =
    session.status === "working" || (session.status === "needs-you" && session.answered === true);
  if (!working) return false;
  if (agentSource(session) === LISTED_WORKING_SOURCE) return true;
  const times = [session.lastWriteAt, session.statusSince].filter(
    (time): time is number => typeof time === "number",
  );
  if (times.length === 0) return false;
  // A newest time ahead of `now`, from a clock set back, is under the limit and counts.
  return now - Math.max(...times) < KEEP_AWAKE_WORKING_MS;
}

/** Whether any of a snapshot's sessions keeps the Mac awake. */
export function anyKeepsAwake(sessions: readonly KeepAwakeSession[], now: number): boolean {
  return sessions.some((session) => keepsAwake(session, now));
}
