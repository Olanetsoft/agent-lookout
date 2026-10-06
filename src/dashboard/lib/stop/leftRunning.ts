import { MAX_CLEAN_UP_SESSIONS, type CleanUpEntry, type CleanUpOutcome } from "@core/api";
import type { Session } from "@core/sessions/session";
import { STALE_THRESHOLD_MS, staleAfterInWords } from "@core/sessions/staleness";
import { isStaleIdle } from "@dashboard/lib/sessions/sessions";
import { RESUME, type StopRun } from "@dashboard/lib/stop/stopWords";

/**
 * The sessions left running: Claude Code sessions idle for a day or more, or as
 * long as the idle rule says, whose process still runs, as when a VS Code tab was closed and its process stayed.
 * Each is one Agent Lookout can end, or one in the desktop app, which is
 * listed with the line that says to stop it there.
 */

export interface LeftRunningSession {
  session: Session & { statusSince: number };
  /** How long it has been idle. */
  idleMs: number;
  /** Whether Agent Lookout can end it: not for one in the desktop app. */
  endable: boolean;
}

/** The sessions left running, the longest idle first. */
export function leftRunning(sessions: readonly Session[], now: number): LeftRunningSession[] {
  const found: LeftRunningSession[] = [];
  for (const session of sessions) {
    if (session.source !== "claude-code" || session.alive !== true) continue;
    if (!isStaleIdle(session) || session.statusSince === null) continue;
    const endable = session.stop !== undefined;
    if (!endable && session.surface !== "desktop") continue;
    found.push({
      session: session as Session & { statusSince: number },
      idleMs: Math.max(0, now - session.statusSince),
      endable,
    });
  }
  return found.sort((a, b) => a.session.statusSince - b.session.statusSince);
}

/**
 * What a clean-up asks for: each chosen session that can be ended, with the
 * moment its idle began as the page shows it, at most twenty.
 */
export function cleanUpEntries(chosen: readonly LeftRunningSession[]): CleanUpEntry[] {
  return chosen
    .filter((one) => one.endable)
    .slice(0, MAX_CLEAN_UP_SESSIONS)
    .map((one) => ({ sessionId: one.session.id, statusSince: one.session.statusSince }));
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * What a clean-up came to, in a sentence or two: "Ended 2. Left 1 running
 * because it became active." Each kind of outcome is said once, with its count.
 * One idle for less than the idle rule says is said to be, with a day while it
 * is off.
 */
export function cleanUpSummary(
  outcomes: readonly CleanUpOutcome[],
  staleAfterMs: number = STALE_THRESHOLD_MS,
): string {
  const count = (outcome: CleanUpOutcome) => outcomes.filter((one) => one === outcome).length;
  const ended = count("ended");
  const parts = [`Ended ${ended === 0 ? "none" : ended}.`];

  const active = count("became-active");
  if (active > 0) {
    parts.push(`Left ${active} running because ${plural(active, "it", "they")} became active.`);
  }
  const young = count("not-stale");
  if (young > 0) {
    parts.push(
      `Left ${young} running because ${plural(young, "it has", "they have")} been idle less than ${staleAfterInWords(staleAfterMs)}.`,
    );
  }
  const unconfirmed = count("cannot-confirm");
  if (unconfirmed > 0) {
    parts.push(
      `Left ${unconfirmed} running because Agent Lookout could not confirm ${plural(unconfirmed, "its process", "their processes")}.`,
    );
  }
  const running = count("still-running");
  if (running > 0) {
    parts.push(`${running} asked to stop ${plural(running, "is", "are")} still running.`);
  }
  const gone = count("gone");
  if (gone > 0) parts.push(`${gone} had already ended.`);
  const failed = count("failed") + count("unsupported") + count("not-allowed");
  if (failed > 0) parts.push(`${failed} could not be stopped.`);
  return parts.join(" ");
}

/** What the person is told before the sessions are ended. */
export const END_QUESTION = "End the sessions left running?";

/** What ending them does, with the command that opens a conversation again in the mono. */
export const END_DOES: StopRun[] = [
  { text: "Each chosen session's process ends now. Its conversation is kept, and ", fact: false },
  RESUME,
  {
    text: " opens it again. A session that has done anything since this list was drawn is left running.",
    fact: false,
  },
];

/** "End 3 sessions", or "End 1 session". */
export function endLabel(count: number): string {
  return `End ${count} ${count === 1 ? "session" : "sessions"}`;
}
