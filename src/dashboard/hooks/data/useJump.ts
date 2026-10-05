import { useCallback, useEffect, useRef, useState } from "react";

import { JUMP_INTERVAL_MS } from "@core/api";
import { requestJump, type JumpOutcome } from "@dashboard/lib/api/jump";

/** How long the page goes on saying what a press of Jump came to. */
export const JUMP_NOTE_MS = 4_000;

export interface JumpPress {
  /**
   * Asks the collector to take the person to the session. A press while one is
   * under way, or within a second of its answer, does nothing.
   */
  press: () => void;
  /** What the last press came to, for a few seconds after its answer. Null the rest of the time. */
  outcome: JumpOutcome | null;
}

/**
 * One session's Jump, for a session the collector takes the person to itself:
 * the press, and what it came to.
 *
 * The outcome is held by whatever draws the session, so the button and the
 * words about it can sit in different parts of the same row. It is said for a
 * few seconds and then dropped, and a new press drops it at once, so the same
 * words said twice are heard twice.
 *
 * The collector makes one jump a second, so a press within a second of the
 * last answer would only be refused, and the refusal would take the place of
 * what the first press came to: the second click of a double click would turn
 * "Selected in tmux" into "Try again in a moment". Such a press is not sent.
 */
export function useJump(sessionId: string): JumpPress {
  const [outcome, setOutcome] = useState<JumpOutcome | null>(null);
  const underWay = useRef(false);
  const answeredAt = useRef(-Infinity);
  const drawn = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    drawn.current = true;
    return () => {
      drawn.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const press = useCallback(() => {
    if (underWay.current) return;
    if (performance.now() - answeredAt.current < JUMP_INTERVAL_MS) return;
    underWay.current = true;
    clearTimeout(timer.current);
    setOutcome(null);
    void requestJump(sessionId).then((result) => {
      underWay.current = false;
      answeredAt.current = performance.now();
      if (!drawn.current) return;
      setOutcome(result);
      timer.current = setTimeout(() => setOutcome(null), JUMP_NOTE_MS);
    });
  }, [sessionId]);

  return { press, outcome };
}
