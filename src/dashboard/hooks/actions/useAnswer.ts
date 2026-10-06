import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { AnswerDecision, Session } from "@core/sessions/session";
import { requestAnswer, type AnswerOutcome } from "@dashboard/lib/answer/answerRequest";

/**
 * How long a request is drawn before Allow or Deny takes a press. A press
 * aimed at the request before it, or at another session's block that moved
 * up into the same place, lands in this time and is not sent.
 */
export const ANSWER_SETTLE_MS = 1_000;

/** Where one session's answers are. */
export type AnswerStep =
  | { kind: "idle" }
  | { kind: "busy"; decision: AnswerDecision; requestId: string }
  | { kind: "answered"; outcome: AnswerOutcome; requestId: string };

export interface AnswerPress {
  step: AnswerStep;
  /** Sends Allow or Deny for the request shown, once. */
  press: (decision: AnswerDecision) => void;
  /** Whether the request shown was drawn too lately for a press to be taken. */
  settling: boolean;
  /** The id of the line that says what the press came to, which takes focus once it is said. */
  outcomeId: string;
}

/**
 * One session's Allow and Deny. A press sends one request, naming the request
 * the page shows, and a second press while it is under way does nothing. A
 * press in the first second a request is drawn is not taken either. What the
 * last press came to stays said while the session is drawn: alone once its
 * request has gone, and above a newer request of the session's, which is
 * offered afresh. There is no confirmation: the press is the answer, and the
 * whole of what it answers is on the screen beside the buttons.
 */
export function useAnswer(
  session: Pick<Session, "id" | "ask">,
  options: {
    /** Told once an answer was handed over, so the page reads the sessions again at once. */
    onAnswered?: () => void;
    request?: typeof requestAnswer;
    /** How long a newly drawn request takes no press. */
    settleMs?: number;
  } = {},
): AnswerPress {
  const { onAnswered, request = requestAnswer, settleMs = ANSWER_SETTLE_MS } = options;
  const [step, setStep] = useState<AnswerStep>({ kind: "idle" });
  const requestId = session.ask?.requestId ?? null;
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const settling = requestId !== null && settledFor !== requestId;
  const outcomeId = `${useId()}-answer-outcome`;
  const underWay = useRef(false);
  const focusOutcome = useRef(false);
  const drawn = useRef(true);

  useEffect(() => {
    drawn.current = true;
    return () => {
      drawn.current = false;
    };
  }, []);

  useEffect(() => {
    if (requestId === null) return;
    const timer = setTimeout(() => setSettledFor(requestId), settleMs);
    return () => clearTimeout(timer);
  }, [requestId, settleMs]);

  useEffect(() => {
    if (!focusOutcome.current || step.kind !== "answered") return;
    focusOutcome.current = false;
    document.getElementById(outcomeId)?.focus();
  }, [step, outcomeId]);

  const press = useCallback(
    (decision: AnswerDecision) => {
      if (underWay.current || requestId === null || settling) return;
      underWay.current = true;
      setStep({ kind: "busy", decision, requestId });
      void request(session.id, requestId, decision).then((outcome) => {
        underWay.current = false;
        if (!drawn.current) return;
        if (outcome === "allowed" || outcome === "denied") onAnswered?.();
        focusOutcome.current = true;
        setStep({ kind: "answered", outcome, requestId });
      });
    },
    [session.id, requestId, settling, request, onAnswered],
  );

  return { step, press, settling, outcomeId };
}
