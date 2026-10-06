import { useCallback, useEffect, useRef, useState } from "react";

import { JUMP_INTERVAL_MS } from "@core/api";
import type { Session, TerminalApp } from "@core/sessions/session";
import { automationNoteDue, automationNoteSaid } from "@dashboard/lib/api/automationNote";
import {
  JUMP_TIMEOUT_MS,
  requestJump,
  TERMINAL_JUMP_WAIT_MS,
  type JumpOutcome,
} from "@dashboard/lib/api/jump";
import { jumpWay } from "@dashboard/lib/sessions/status";

/** How long the page goes on saying what a press of Jump came to. */
export const JUMP_NOTE_MS = 4_000;

/** How long it goes on saying that macOS did not allow it, which comes with a line to read. */
export const JUMP_REFUSED_NOTE_MS = 12_000;

/**
 * How long the first press of a terminal tab's Jump waits before it says that
 * macOS will ask. A press macOS does not hold is answered in well under this.
 */
export const ASK_AFTER_MS = 1_000;

export interface JumpPress {
  /**
   * Asks the collector to take the person to the session. A press while one is
   * under way, or within a second of its answer, does nothing.
   */
  press: () => void;
  /** What the last press came to, for a few seconds after its answer. Null the rest of the time. */
  outcome: JumpOutcome | null;
  /**
   * The app macOS is asking about, while the first press of a Jump to one of
   * its tabs on this browser has waited a second for its answer. Null the rest
   * of the time.
   */
  asking: TerminalApp | null;
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
 *
 * The first press of a Jump to a Terminal or iTerm2 tab on this browser says
 * that macOS will ask once, since macOS holds the press until the person has
 * answered. It says so only once the press has waited a second, and only then
 * counts it as said: a press that is refused, or answered at once because
 * macOS did not need to ask, never reached macOS's question, so it neither
 * flashes the line nor uses it up. It waits as long as the collector does.
 */
export function useJump(
  session: Pick<Session, "id" | "source" | "surface" | "links" | "jump">,
): JumpPress {
  const sessionId = session.id;
  const way = jumpWay(session);
  const app = way?.by === "terminal" ? way.app : null;
  const [outcome, setOutcome] = useState<JumpOutcome | null>(null);
  const [asking, setAsking] = useState<TerminalApp | null>(null);
  const underWay = useRef(false);
  const answeredAt = useRef(-Infinity);
  const drawn = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const askTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    drawn.current = true;
    return () => {
      drawn.current = false;
      clearTimeout(timer.current);
      clearTimeout(askTimer.current);
    };
  }, []);

  const press = useCallback(() => {
    if (underWay.current) return;
    if (performance.now() - answeredAt.current < JUMP_INTERVAL_MS) return;
    underWay.current = true;
    clearTimeout(timer.current);
    setOutcome(null);
    if (app !== null && automationNoteDue(app)) {
      askTimer.current = setTimeout(() => {
        automationNoteSaid(app);
        setAsking(app);
      }, ASK_AFTER_MS);
    }
    void requestJump(sessionId, app !== null ? TERMINAL_JUMP_WAIT_MS : JUMP_TIMEOUT_MS).then(
      (result) => {
        underWay.current = false;
        answeredAt.current = performance.now();
        clearTimeout(askTimer.current);
        if (!drawn.current) return;
        setAsking(null);
        setOutcome(result);
        timer.current = setTimeout(
          () => setOutcome(null),
          result === "not-allowed" ? JUMP_REFUSED_NOTE_MS : JUMP_NOTE_MS,
        );
      },
    );
  }, [sessionId, app]);

  return { press, outcome, asking };
}
