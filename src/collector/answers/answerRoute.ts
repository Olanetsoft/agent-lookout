import type { IncomingMessage } from "node:http";

import {
  ANSWER_ACTION,
  type AnswerFailure,
  type AnswerRefusal,
  type AnswerRequest,
  type AnswerResponse,
} from "../../core/api.ts";
import {
  ANSWER_DECISIONS,
  type AnswerDecision,
  type Session,
  type SessionEvent,
} from "../../core/sessions/session.ts";
import { needsYou } from "../../core/waits/answeredWaits.ts";
import type { EventStore } from "../eventStore.ts";
import { actionRefusalFor, readRequestBody, refusal, type ApiAnswer } from "../handler.ts";
import type { Poller } from "../poller.ts";
import type { AnswerOutcome, HeldAsks } from "./heldAsks.ts";

/** The most a request's body may hold. Two ids and a word are far shorter. */
export const MAX_ANSWER_BODY_BYTES = 1024;

/** What each refusal is answered with. */
const ANSWERS: Record<AnswerFailure, { status: number; error: string }> = {
  "no-ask": {
    status: 404,
    error: "Agent Lookout holds no such request of that session. It may have been answered.",
  },
  "not-allowable": {
    status: 409,
    error: "Only Deny is offered for this request. Answer it in the session to allow it.",
  },
  gone: {
    status: 409,
    error: "The session has moved on: it was answered there, or it is no longer waiting.",
  },
  "too-soon": { status: 429, error: "That request is being answered." },
  failed: { status: 500, error: "The answer could not be handed to the session." },
};

export function answerFailed(reason: AnswerFailure): ApiAnswer {
  const { status, error } = ANSWERS[reason];
  return { status, body: { error, reason } satisfies AnswerRefusal };
}

/** Agent Lookout's own id for a request: 32 lower-case hexadecimal digits. */
const REQUEST_ID = /^[0-9a-f]{32}$/;

/**
 * The body, when it is exactly `{"sessionId", "requestId", "decision"}`, each
 * of the right kind, and nothing else. Null for anything else.
 */
export function answerIn(text: string): AnswerRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join() !== "decision,requestId,sessionId") return null;
  const { sessionId, requestId, decision } = record;
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 200) return null;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  if (!ANSWER_DECISIONS.includes(decision as AnswerDecision)) return null;
  return { sessionId, requestId, decision: decision as AnswerDecision };
}

/** The event that says Agent Lookout answered a request. It holds the decision, and nothing of what was asked. */
export function answeredEvent(
  session: Pick<Session, "id" | "name" | "status">,
  decision: AnswerDecision,
  at: number,
): SessionEvent {
  return {
    id: `${session.id}@${at}:answered`,
    at,
    sessionId: session.id,
    sessionName: session.name,
    kind: "answered",
    from: session.status,
    severity: "advisory",
    by: "agent-lookout",
    decision,
  };
}

export interface AnswerRouteOptions {
  poller: Pick<Poller, "getSnapshot" | "pollOnce">;
  events: Pick<EventStore, "add">;
  asks: Pick<HeldAsks, "answer">;
  now?: () => number;
}

/** Hands the person's answer to one held request, and says what came of it. */
export type Answerer = (
  sessionId: string,
  requestId: string,
  decision: AnswerDecision,
) => Promise<AnswerOutcome>;

/**
 * Polls at once, so the page's read of the sessions straight after a press
 * no longer finds the session needing the person: it finds the wait marked
 * answered while Claude Code's file still says it waits, or the session gone
 * on. Again when the first poll was already under way and was done before the
 * answer counted for it, as the stop route's `lookAgain` does. A poll that
 * fails is left to the poller's next beat.
 */
export async function pollAfterAnswer(
  poller: Pick<Poller, "pollOnce">,
  sessionId: string,
): Promise<void> {
  try {
    const first = await poller.pollOnce();
    if (first.sessions.some((session) => session.id === sessionId && needsYou(session))) {
      await poller.pollOnce();
    }
  } catch {
    // The poller answers at its next beat all the same.
  }
}

/**
 * Why a request to the answer route is refused before its body is read, or
 * null when it may proceed: `actionRefusalFor` in `handler.ts`, with `answer`
 * as the action, as the jump and stop routes do.
 */
export function answerRefusalFor(
  req: Pick<IncomingMessage, "method" | "headers">,
): ApiAnswer | null {
  return actionRefusalFor(req, ANSWER_ACTION, MAX_ANSWER_BODY_BYTES);
}

/**
 * The one path a press of Allow or Deny takes, on the dashboard and in the
 * Mac app's notifications and menu bar alike: the session must be listed,
 * `answer` in `heldAsks.ts` makes every check of the request it holds, and
 * once the answer is handed over, the Events log keeps it as an answer by
 * Agent Lookout and the sessions are read again (`pollAfterAnswer`).
 */
export function createAnswerer(options: AnswerRouteOptions): Answerer {
  const { poller, events, asks } = options;
  const now = options.now ?? Date.now;
  return async (sessionId, requestId, decision) => {
    const session = poller.getSnapshot().sessions.find((listed) => listed.id === sessionId);
    if (!session) return "no-ask";
    const outcome = await asks.answer(sessionId, requestId, decision);
    if (outcome !== "answered") return outcome;
    events.add([answeredEvent(session, decision, now())]);
    // Whoever asked reads the sessions again as soon as this is answered, and
    // finds the wait over.
    await pollAfterAnswer(poller, sessionId);
    return "answered";
  };
}

/**
 * Answers `POST /api/permission/answer`: hands the person's Allow or Deny to
 * the hook of a Claude Code session's permission request, when they pressed
 * it on the dashboard.
 *
 * The request names the session, the request the page showed and the
 * answer. Only a request Agent Lookout holds for that session, under that id,
 * is answered, and Allow only when the whole of it was shown. The session's
 * registry file is read once more first, and must still say it is waiting:
 * otherwise it was answered in the session, and nothing is sent. What is
 * written is fixed: allow, or deny with fixed words, and never a rewritten
 * input or a saved rule. Once it is handed over, the sessions are read again
 * before the reply (`pollAfterAnswer`), so the page's next read finds the wait over.
 */
export function createAnswerRoute(options: AnswerRouteOptions) {
  const answer = createAnswerer(options);

  return async function answerPermission(req: IncomingMessage): Promise<ApiAnswer> {
    const refused = answerRefusalFor(req);
    if (refused) {
      req.resume();
      return refused;
    }
    const body = await readRequestBody(req, MAX_ANSWER_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refusal(413, `The body must be no more than ${MAX_ANSWER_BODY_BYTES} bytes.`)
        : refusal(400, "The body could not be read.");
    }
    const asked = answerIn(body.text);
    if (asked === null) {
      return refusal(
        400,
        'The body must be {"sessionId": "...", "requestId": "...", "decision": "allow" or "deny"} and nothing else.',
      );
    }
    const outcome = await answer(asked.sessionId, asked.requestId, asked.decision);
    if (outcome !== "answered") return answerFailed(outcome);
    return {
      status: 200,
      body: { ok: true, decision: asked.decision } satisfies AnswerResponse,
    };
  };
}
