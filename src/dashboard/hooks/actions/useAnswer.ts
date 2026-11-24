import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ANSWER_SETTLE_MS } from "@core/answers/settle";
import type { AnswerDecision, Session } from "@core/sessions/session";
import { useSettling } from "@dashboard/hooks/dom/useSettling";
import { requestAnswer, type AnswerOutcome } from "@dashboard/lib/answer/answerRequest";

/** Where one session's answers are. */
export type AnswerStep =
  | { kind: "idle" }
  | { kind: "busy"; decision: AnswerDecision; requestId: string }
  | {
      kind: "answered";
      outcome: AnswerOutcome;
      requestId: string;
      /** The `statusSince` of the wait the press was made in, so a later wait can be told apart. */
      since: number | null;
    };

export interface AnswerPress {
  step: AnswerStep;
  /** Sends Allow or Deny for the request shown, once. */
  press: (decision: AnswerDecision) => void;
  /** Whether the request shown was drawn, or moved, too lately for a press to be taken. */
  settling: boolean;
  /** The id of what holds Deny and Allow, whose place is watched. */
  buttonsId: string;
  /** The id of the line that says what the press came to, which takes focus once it is said. */
  outcomeId: string;
}

/**
 * One session's Allow and Deny. A press sends one request, naming the request
 * the page shows, and a second press while it is under way does nothing. A
 * press in the first second a request is drawn, or within a second of its
 * buttons moving or the page coming back into sight, is not taken either. What
 * the last press came to stays said while the session is drawn: alone once its
 * request has gone, and above a newer request of the session's, which is
 * offered afresh. There is no confirmation: the press is the answer, and the
 * whole of what it answers is on the screen beside the buttons.
 */
export function useAnswer(
  session: Pick<Session, "id" | "ask" | "statusSince">,
  options: {
    /** Told once an answer was handed over, so the page reads the sessions again at once. */
    onAnswered?: () => void;
    request?: typeof requestAnswer;
    /** How long a newly drawn request, or one that moved, takes no press. */
    settleMs?: number;
  } = {},
): AnswerPress {
  const { onAnswered, request = requestAnswer, settleMs = ANSWER_SETTLE_MS } = options;
  const [step, setStep] = useState<AnswerStep>({ kind: "idle" });
  const requestId = session.ask?.requestId ?? null;
  const since = session.statusSince;
  const id = useId();
  const outcomeId = `${id}-answer-outcome`;
  const buttonsId = `${id}-answer-buttons`;
  const { settling, tooSoon } = useSettling(buttonsId, requestId, settleMs);
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
    if (!focusOutcome.current || step.kind !== "answered") return;
    focusOutcome.current = false;
    document.getElementById(outcomeId)?.focus();
  }, [step, outcomeId]);

  const press = useCallback(
    (decision: AnswerDecision) => {
      if (underWay.current || requestId === null || tooSoon()) return;
      underWay.current = true;
      setStep({ kind: "busy", decision, requestId });
      void request(session.id, requestId, decision).then((outcome) => {
        underWay.current = false;
        if (!drawn.current) return;
        if (outcome === "allowed" || outcome === "denied") onAnswered?.();
        focusOutcome.current = true;
        setStep({ kind: "answered", outcome, requestId, since });
      });
    },
    [session.id, requestId, since, tooSoon, request, onAnswered],
  );

  return { step, press, settling, buttonsId, outcomeId };
}
