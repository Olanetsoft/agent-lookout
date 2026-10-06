import type { IncomingMessage } from "node:http";

import {
  CLEAN_UP_ACTION,
  MAX_CLEAN_UP_SESSIONS,
  type CleanUpEntry,
  type CleanUpOutcome,
  type CleanUpResponse,
} from "../../core/api.ts";
import { mapClaudeCodeStatus } from "../../core/mapping/claudeCodeMapping.ts";
import type { Session } from "../../core/sessions/session.ts";
import { isStale, STALE_THRESHOLD_MS } from "../../core/sessions/staleness.ts";
import type { RegistryEntry } from "../adapters/claude-code/registry.ts";
import { actionRefusalFor, readRequestBody, refusal, type ApiAnswer } from "../handler.ts";
import { lookAgain, stopFailed, type StopRouteOptions } from "./stopRoute.ts";
import { stoppedEvent, type Stopper } from "./stopSession.ts";
import type { StopTarget } from "./stopTargets.ts";

/** The most a request's body may hold: twenty sessions' ids and times, with room to spare. */
export const MAX_CLEAN_UP_BODY_BYTES = 8 * 1024;

/** The longest session id that is looked up, as for Jump and Stop. */
const MAX_SESSION_ID_LENGTH = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/**
 * The sessions a body names, or null when the body is anything but
 * `{"sessions": [{"sessionId": "...", "statusSince": 1700000000000}, ...]}`:
 * one to twenty of them, each a session id and a time, none named twice, and
 * nothing else anywhere. A body that says more is not read for the part that fits.
 */
export function cleanUpEntriesIn(body: string): CleanUpEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasExactly(value, ["sessions"])) return null;
  const { sessions } = value;
  if (!Array.isArray(sessions)) return null;
  if (sessions.length === 0 || sessions.length > MAX_CLEAN_UP_SESSIONS) return null;

  const entries: CleanUpEntry[] = [];
  const seen = new Set<string>();
  for (const item of sessions) {
    if (!isRecord(item) || !hasExactly(item, ["sessionId", "statusSince"])) return null;
    const { sessionId, statusSince } = item;
    if (typeof sessionId !== "string" || sessionId === "") return null;
    if (sessionId.length > MAX_SESSION_ID_LENGTH || seen.has(sessionId)) return null;
    if (typeof statusSince !== "number" || !Number.isSafeInteger(statusSince) || statusSince < 0) {
      return null;
    }
    seen.add(sessionId);
    entries.push({ sessionId, statusSince });
  }
  return entries;
}

export interface CleanUpRouteOptions extends StopRouteOptions {
  /**
   * How long a session is idle before it is stale, asked at each clean-up:
   * the idle rule's threshold while it is on. Left out, the built-in day.
   */
  staleAfterMs?: () => number;
}

/** A session that passed every check and was sent its stop. */
interface Sent {
  index: number;
  session: Session;
  target: StopTarget;
  /** Whether it was signalled, and so is waited on, or its background job was stopped. */
  signalled: boolean;
}

/**
 * Why a session is left running, or null when it is still what the page
 * showed: idle, since the very moment the page sent, and stale by the clock
 * now: for a day or more, or as long as the idle rule says while it is on. A session that has done anything since has a new status
 * time, so it is never ended, even if it has gone idle again.
 *
 * Both the registry file, read again, and the collector's own latest list
 * must say so. The list can come from `claude agents`, which may know the
 * session is working before its registry file says so, and what the person
 * saw came from that list.
 */
export function changedSince(
  entry: CleanUpEntry,
  registry: RegistryEntry,
  listed: Pick<Session, "status" | "statusSince" | "stale">,
  stopper: Pick<Stopper, "now">,
  staleAfterMs: number = STALE_THRESHOLD_MS,
): CleanUpOutcome | null {
  if (mapClaudeCodeStatus(registry, "registry").status !== "idle") return "became-active";
  if (registry.statusUpdatedAt !== entry.statusSince) return "became-active";
  if (listed.status !== "idle" || listed.statusSince !== entry.statusSince) return "became-active";
  if (listed.stale !== true) return "not-stale";
  if (!isStale({ status: "idle", statusSince: entry.statusSince }, stopper.now(), staleAfterMs)) {
    return "not-stale";
  }
  return null;
}

/**
 * Answers `POST /api/sessions/clean-up`: ends the sessions left running that
 * the person chose, once they have confirmed it. Each is a Claude Code session
 * that has been idle for a day or more, or as long as the idle rule says, with
 * its process still running.
 *
 * The request names each session and the moment its idle began, as the page
 * showed it. For each one in turn, every check of the stop route is made again
 * (`stopSession.ts`), and then the registry file read for it must still say it
 * is idle, since that same moment, and the clock must still make that a day or
 * more ago, or as long ago as the idle rule says. A session that has done anything since is left running, whatever
 * it is doing now. Each one that passes is sent SIGTERM, or for a background
 * job `claude stop`, and the collector waits up to 10 seconds for them all to
 * end. Nothing a request holds reaches a signal or a command: it can only
 * choose among the sessions the collector found it could stop.
 *
 * The answer says what became of each. One event is kept for each session it
 * ended. It shares its turn with the stop route: one at a time, and a second
 * apart.
 */
export function createCleanUpRoute(options: CleanUpRouteOptions) {
  const { poller, events, targets, stopper, limiter } = options;

  /** What became of each session, and the sessions that were ended. */
  async function cleanUp(
    entries: readonly CleanUpEntry[],
  ): Promise<{ answer: ApiAnswer; ended: Session[] }> {
    const listed = new Map(poller.getSnapshot().sessions.map((session) => [session.id, session]));
    const outcomes: CleanUpOutcome[] = entries.map(() => "failed");
    const sent: Sent[] = [];

    for (const [index, entry] of entries.entries()) {
      const session = listed.get(entry.sessionId);
      const target = session && targets.targetOf(session.id);
      if (!session) {
        outcomes[index] = "gone";
        continue;
      }
      if (!target || !session.stop) {
        outcomes[index] = "unsupported";
        continue;
      }
      const confirmed = await stopper.confirm(target);
      if (!confirmed.ok) {
        outcomes[index] = confirmed.reason;
        continue;
      }
      const changed = changedSince(
        entry,
        confirmed.entry,
        session,
        stopper,
        options.staleAfterMs?.() ?? STALE_THRESHOLD_MS,
      );
      if (changed !== null) {
        outcomes[index] = changed;
        continue;
      }
      const acted = await stopper.act(target);
      if (acted === "signalled" || acted === "stopped") {
        sent.push({ index, session, target, signalled: acted === "signalled" });
        outcomes[index] = "ended";
      } else {
        outcomes[index] = acted;
      }
    }

    const running = await stopper.waitForEnd(
      sent.filter((one) => one.signalled).map((one) => one.target.pid),
    );
    const ended: Session[] = [];
    for (const one of sent) {
      if (one.signalled && running.has(one.target.pid)) outcomes[one.index] = "still-running";
      else ended.push(one.session);
    }
    const at = stopper.now();
    events.add(ended.map((session) => stoppedEvent(session, at)));

    const body: CleanUpResponse = {
      results: entries.map((entry, index) => ({
        sessionId: entry.sessionId,
        outcome: outcomes[index] as CleanUpOutcome,
      })),
    };
    return { answer: { status: 200, body }, ended };
  }

  return async function answerCleanUp(req: IncomingMessage): Promise<ApiAnswer> {
    const refused = actionRefusalFor(req, CLEAN_UP_ACTION, MAX_CLEAN_UP_BODY_BYTES);
    if (refused) {
      req.resume();
      return refused;
    }

    const body = await readRequestBody(req, MAX_CLEAN_UP_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refusal(413, `The body must be no more than ${MAX_CLEAN_UP_BODY_BYTES} bytes.`)
        : refusal(400, "The body could not be read.");
    }
    const entries = cleanUpEntriesIn(body.text);
    if (entries === null) {
      return refusal(
        400,
        `The body must name from 1 to ${MAX_CLEAN_UP_SESSIONS} sessions and nothing else: {"sessions": [{"sessionId": "...", "statusSince": 1700000000000}]}.`,
      );
    }

    if (!limiter.begin()) return stopFailed("too-soon");
    let done: { answer: ApiAnswer; ended: Session[] };
    try {
      done = await cleanUp(entries);
    } finally {
      limiter.end();
    }
    await lookAgain({ poller, targets }, done.ended);
    return done.answer;
  };
}
