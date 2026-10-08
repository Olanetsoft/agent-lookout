import { useEffect, useRef, useState } from "react";

import type { LastMessageResponse } from "@core/api";
import { fetchLastMessage } from "@dashboard/lib/api/collectorStore";

/**
 * idle     nothing is asked and nothing is held: the details are closed, the
 *          session has gone or it is on another machine
 * loading  asked for, or about to be, with no answer yet
 * ready    `answer` is the last answer
 * failed   the asking failed, and there is no earlier answer to show
 */
export interface LastMessageReading {
  status: "idle" | "loading" | "ready" | "failed";
  answer: LastMessageResponse | null;
}

export interface LastMessageAsking {
  /**
   * Whether to ask at all: while the session's details are open, the session
   * is listed and it runs on this computer. Once this is false, what was held
   * is gone at once.
   */
  active: boolean;
  /** Whether the page is out of sight. Nothing is asked then, and what was held stays. */
  hidden: boolean;
  /** When the page last read the sessions. Each new value asks once more. */
  beat: number | null;
}

const IDLE: LastMessageReading = { status: "idle", answer: null };

/** What is held for one session: its last answer, or that asking failed before there was one. */
interface Held {
  sessionId: string;
  answer: LastMessageResponse | null;
  failed: boolean;
}

/** Answers after which asking again would say the same: the setting is off, or the agent is not read. */
function final(answer: LastMessageResponse): boolean {
  return answer.message === null && (answer.reason === "off" || answer.reason === "not-read");
}

/**
 * What one session last said, for its details, asked for only while `active`
 * and the page is in sight: once when that begins, and once for each new
 * `beat` after, so no more often than the page reads the sessions. One request
 * is never joined by a second. After an answer that says it is off, or that
 * the session's agent is not read, it is not asked again until it is next
 * active.
 *
 * A failure, or the server saying it is busy, keeps the last answer on
 * screen. The answer is held in this hook's state alone: nothing of it goes to
 * storage, another tab or the address, and it is let go the moment `active`
 * is false.
 */
export function useLastMessage(sessionId: string, asking: LastMessageAsking): LastMessageReading {
  const { active, hidden, beat } = asking;
  const [held, setHeld] = useState<Held | null>(null);
  // Let go of in the same render that stops it being active, so it is never drawn again.
  if (held !== null && (!active || held.sessionId !== sessionId)) setHeld(null);

  /** The beat last asked for, or `undefined` before the first ask. */
  const askedFor = useRef<number | null | undefined>(undefined);
  const inFlight = useRef(false);
  const settled = useRef(false);
  /** Bumped whenever what is asked starts over, so an answer to an earlier ask is dropped. */
  const round = useRef(0);
  const askingFor = useRef(sessionId);
  /**
   * False once unmounted, so an answer still to come is dropped. Nothing else
   * is reset there: StrictMode's second mount keeps the request already out
   * and asks nothing more.
   */
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || askingFor.current !== sessionId) {
      askingFor.current = sessionId;
      askedFor.current = undefined;
      inFlight.current = false;
      settled.current = false;
      round.current += 1;
    }
    if (!active || hidden || settled.current || inFlight.current || askedFor.current === beat) {
      return;
    }
    askedFor.current = beat;
    inFlight.current = true;
    const thisRound = round.current;
    fetchLastMessage(sessionId).then(
      (answer) => {
        if (thisRound !== round.current) return;
        inFlight.current = false;
        // Unmounted, it is dropped. Busy: what is shown stays, and the next beat asks again.
        if (!mounted.current || answer === "busy") return;
        if (final(answer)) settled.current = true;
        setHeld({ sessionId, answer, failed: false });
      },
      () => {
        if (thisRound !== round.current) return;
        inFlight.current = false;
        if (!mounted.current) return;
        setHeld((last) =>
          last?.sessionId === sessionId && last.answer !== null
            ? last
            : { sessionId, answer: null, failed: true },
        );
      },
    );
  }, [sessionId, active, hidden, beat]);

  if (!active) return IDLE;
  const mine = held?.sessionId === sessionId ? held : null;
  if (mine?.answer) return { status: "ready", answer: mine.answer };
  if (mine?.failed) return { status: "failed", answer: null };
  return { status: "loading", answer: null };
}
