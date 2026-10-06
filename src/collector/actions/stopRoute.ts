import type { IncomingMessage } from "node:http";

import {
  STOP_ACTION,
  type StopFailure,
  type StopRefusal,
  type StopResponse,
} from "../../core/api.ts";
import type { Session, SessionsSnapshot } from "../../core/sessions/session.ts";
import type { EventStore } from "../eventStore.ts";
import { actionRefusalFor, readRequestBody, refusal, type ApiAnswer } from "../handler.ts";
import { sessionIdIn } from "../jumpRoute.ts";
import type { Poller } from "../poller.ts";
import {
  stoppedEvent,
  type ActionLimiter,
  type NotConfirmed,
  type Stopper,
} from "./stopSession.ts";
import type { StopTargets } from "./stopTargets.ts";

/** The most a request's body may hold. A session id is far shorter. */
export const MAX_STOP_BODY_BYTES = 1024;

/** What each refusal is answered with, and the sentence beside its reason. */
const ANSWERS: Record<StopFailure, { status: number; error: string }> = {
  gone: { status: 404, error: "That session has already ended." },
  unsupported: { status: 409, error: "Agent Lookout does not stop this session." },
  "cannot-confirm": {
    status: 409,
    error: "Agent Lookout cannot confirm this process is that session, so it did not stop it.",
  },
  "not-allowed": { status: 403, error: "Agent Lookout is not allowed to stop this process." },
  "still-running": {
    status: 202,
    error: "Agent Lookout asked the session to stop, and it is still running 10 seconds later.",
  },
  "too-soon": { status: 429, error: "One session is stopped a second. Try again in a moment." },
  failed: { status: 500, error: "The session could not be stopped." },
};

/** The answer for a reason, with `ok: false` beside it when the request was taken. */
export function stopFailed(reason: StopFailure): ApiAnswer {
  const { status, error } = ANSWERS[reason];
  return {
    status,
    body: {
      ...(reason === "still-running" && { ok: false }),
      error,
      reason,
    } satisfies StopRefusal & { ok?: false },
    ...(reason === "too-soon" && { headers: { "Retry-After": "1" } }),
  };
}

export interface StopRouteOptions {
  /** The collector's own latest list of sessions, and a poll at once once one has stopped. */
  poller: Pick<Poller, "getSnapshot" | "pollOnce">;
  /** Where the event that says it was stopped goes. */
  events: Pick<EventStore, "add">;
  /** What the Claude Code adapter found to stop each session by. */
  targets: Pick<StopTargets, "targetOf" | "askFeedSoon">;
  stopper: Stopper;
  /** The one turn the stop and the clean-up share. */
  limiter: ActionLimiter;
}

/**
 * Why a request to the stop route is refused before its body is read, or null
 * when it may proceed: `actionRefusalFor` in `handler.ts`, with `stop` as the
 * action. This route ends a session's process, so it must be one only the
 * dashboard's own page can send.
 */
export function stopRefusalFor(req: Pick<IncomingMessage, "method" | "headers">): ApiAnswer | null {
  return actionRefusalFor(req, STOP_ACTION, MAX_STOP_BODY_BYTES);
}

/** Whether a snapshot still offers Stop for the session, so it has not been seen to go yet. */
function stillOffered(snapshot: SessionsSnapshot, sessionId: string): boolean {
  return snapshot.sessions.some((session) => session.id === sessionId && session.stop);
}

/**
 * Polls at once, so the page's next request no longer lists the sessions that
 * were stopped: again when the first poll was already under way and read the
 * sessions before they stopped. A background job that was stopped is shown as
 * stopped once the command has been run again, which this asks for.
 */
export async function lookAgain(
  options: Pick<StopRouteOptions, "poller" | "targets">,
  stopped: readonly Pick<Session, "id" | "stop">[],
): Promise<void> {
  if (stopped.length === 0) return;
  if (stopped.some((session) => session.stop?.how === "background")) {
    options.targets.askFeedSoon();
  }
  try {
    const first = await options.poller.pollOnce();
    if (stopped.some((session) => stillOffered(first, session.id))) {
      await options.poller.pollOnce();
    }
  } catch {
    // The poller answers at its next beat all the same.
  }
}

/**
 * Answers `POST /api/sessions/stop`: ends one Claude Code session's process,
 * when the person has pressed Stop and confirmed it.
 *
 * The request names a session and nothing else. It is looked up in the
 * collector's own list, and stopped by what the Claude Code adapter found for
 * it: its process, or its background job. Then, at this moment and with
 * nothing remembered, its registry file is read again and must still be that
 * session's and of a kind that is stopped, `ps` must give the same start time
 * for its process, and the process must not be Agent Lookout's own, the one it
 * was started from, or the first process (`stopSession.ts`). Only then is it
 * sent SIGTERM, never SIGKILL, and the collector waits up to 10 seconds for it
 * to end, or runs `claude stop` with the job's id. Nothing a request holds
 * reaches a signal or a command.
 *
 * One stop is made a second, and one at a time, with the clean-up's.
 */
export function createStopRoute(options: StopRouteOptions) {
  const { poller, events, targets, stopper, limiter } = options;

  async function stop(session: Session): Promise<ApiAnswer> {
    const target = targets.targetOf(session.id);
    if (!target || !session.stop) return stopFailed("unsupported");
    if (!limiter.begin()) return stopFailed("too-soon");
    try {
      const confirmed = await stopper.confirm(target);
      if (!confirmed.ok) return stopFailed(confirmed.reason satisfies NotConfirmed);
      const acted = await stopper.act(target);
      if (acted === "signalled") {
        const running = await stopper.waitForEnd([target.pid]);
        if (running.size > 0) return stopFailed("still-running");
      } else if (acted !== "stopped") {
        return stopFailed(acted);
      }
      events.add([stoppedEvent(session, stopper.now())]);
    } finally {
      limiter.end();
    }
    await lookAgain({ poller, targets }, [session]);
    return { status: 200, body: { ok: true } satisfies StopResponse };
  }

  return async function answerStop(req: IncomingMessage): Promise<ApiAnswer> {
    const refused = stopRefusalFor(req);
    if (refused) {
      req.resume();
      return refused;
    }

    const body = await readRequestBody(req, MAX_STOP_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refusal(413, `The body must be no more than ${MAX_STOP_BODY_BYTES} bytes.`)
        : refusal(400, "The body could not be read.");
    }
    const sessionId = sessionIdIn(body.text);
    if (sessionId === null) {
      return refusal(400, 'The body must name one session and nothing else: {"sessionId": "..."}.');
    }

    const session = poller.getSnapshot().sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return stopFailed("gone");
    return stop(session);
  };
}
