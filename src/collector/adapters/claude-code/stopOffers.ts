import path from "node:path";

import { mapClaudeCodeSurface } from "../../../core/mapping/claudeCodeMapping.ts";
import type { Session } from "../../../core/sessions/session.ts";
import { JOB_ID, type StopTarget } from "../../actions/stopTargets.ts";
import type { FeedEntry } from "./feed.ts";
import type { RegistryEntry } from "./registry.ts";
import { SOURCE_ID } from "./toSession.ts";

export interface StopOfferOptions {
  /** The registry folder, `<claude home>/sessions`, where each session's file is read again before it is stopped. */
  sessionsDir: string;
  /**
   * Whether a background job can be stopped: only while the `claude` command
   * may be run at all, since `claude stop` is the way to stop one.
   */
  background: boolean;
}

/**
 * The background job's id for a registry entry, from the command's answer: the
 * entry for the same session, or the same process. Of two jobs of one session,
 * only the one for the same process is its own.
 */
function jobIdOf(entry: RegistryEntry, answer: readonly FeedEntry[]): string | undefined {
  const jobs = answer.filter(
    (candidate) =>
      candidate.id !== undefined &&
      (candidate.sessionId === entry.sessionId ||
        (candidate.sessionId === undefined && candidate.pid === entry.pid)),
  );
  const listed =
    jobs.find((job) => job.pid === entry.pid) ??
    (jobs.every((job) => job.id === jobs[0]?.id) ? jobs[0] : undefined);
  return listed?.id !== undefined && JOB_ID.test(listed.id) ? listed.id : undefined;
}

/**
 * The target for one session, or null when it can not be stopped from here.
 *
 * Only a session with a registry file can be: the file says which kind of
 * process it is and records the start time `ps` gave it, which is checked
 * again, with the file, before anything is done. The file must name its kind
 * outright, so a session whose kind is not known is not stopped, and must
 * record a start time to check.
 *
 * - `interactive`, in a terminal or in VS Code: its process is sent SIGTERM.
 *   One in the desktop app is not stopped, since that app looks after its own
 *   process and nothing says how it takes an outside stop. One whose app is
 *   not known could be in the desktop app, so it is not stopped either.
 * - `bg`: a background job, stopped with `claude stop` and its id from the
 *   command's answer, while the command may be run.
 */
function targetFor(
  entry: RegistryEntry,
  answer: readonly FeedEntry[] | null,
  options: StopOfferOptions,
): StopTarget | null {
  if (entry.sessionId === undefined || entry.procStart === undefined) return null;
  const surface = mapClaudeCodeSurface(entry.entrypoint);
  const found = {
    sessionId: entry.sessionId,
    pid: entry.pid,
    procStart: entry.procStart,
    registryFile: path.join(options.sessionsDir, `${entry.pid}.json`),
  };
  if (entry.kind === "interactive") {
    return surface === "terminal" || surface === "vscode" ? { ...found, how: "signal" } : null;
  }
  if (entry.kind === "bg" && options.background && surface !== "desktop") {
    const jobId = answer === null ? undefined : jobIdOf(entry, answer);
    return jobId === undefined ? null : { ...found, how: "background", jobId };
  }
  return null;
}

/**
 * Says which of a poll's sessions can be stopped, and finds what each is
 * stopped by. A session that can be is given `stop`, which names the way and
 * nothing else, and its target goes into the map, by the session's id. Only a
 * live session that is still running something is offered: one that has
 * finished or failed has nothing left to stop.
 */
export function withStopOffers(
  sessions: readonly Session[],
  live: readonly RegistryEntry[],
  answer: readonly FeedEntry[] | null,
  options: StopOfferOptions,
): { sessions: Session[]; targets: Map<string, StopTarget> } {
  // Two processes can have one session open, so its own is found by its pid.
  const byPid = new Map(live.map((entry) => [entry.pid, entry]));
  const targets = new Map<string, StopTarget>();
  const offered = sessions.map((session) => {
    if (session.source !== SOURCE_ID || session.alive !== true) return session;
    if (session.status === "finished" || session.status === "failed") return session;
    const entry = session.pid === undefined ? undefined : byPid.get(session.pid);
    if (entry === undefined || session.id !== `${SOURCE_ID}:${entry.sessionId}`) return session;
    const target = targetFor(entry, answer, options);
    if (target === null) return session;
    targets.set(session.id, target);
    return { ...session, stop: { how: target.how } };
  });
  return { sessions: offered, targets };
}
