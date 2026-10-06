import { useCallback, useEffect, useId, useRef, useState } from "react";

import { requestStop, type StopOutcome } from "@dashboard/lib/stop/stopRequest";

/** Where one session's Stop is, between presses. */
export type StopStep =
  | { kind: "idle" }
  | { kind: "confirming"; busy: boolean }
  | {
      kind: "answered";
      outcome: StopOutcome;
      /** When the answer came, by the page's clock, to tell a list read before it from one read after. */
      at: number;
    };

export interface StopPress {
  step: StopStep;
  /** Asks first: shows the confirmation, with focus on Cancel. */
  ask: () => void;
  /** Puts it back as it was, with focus on Stop. */
  cancel: () => void;
  /** Stop session, pressed in the confirmation: sends the request, once. */
  confirm: () => void;
  /**
   * The ids of what takes focus: Stop, which the person comes back to from
   * Cancel; Cancel, which has focus while the confirmation is open, so Enter
   * never stops a session; and the line that says what the press came to,
   * once it is said.
   */
  ids: { stop: string; cancel: string; outcome: string };
}

/**
 * One session's Stop: the button, the confirmation and what it came to, held
 * by what draws the session, so the button and its words can sit in different
 * parts of its details.
 *
 * Stop always asks first. Its confirmation takes focus to Cancel, so a key
 * held from pressing Stop, or Enter, never stops the session. Stop session
 * sends one request, and a second press while it is under way does nothing.
 * What it came to stays said until Stop is pressed again, or the details close.
 *
 * Closing the details puts it back as it was, so opening them again, a moment
 * or hours later, never finds an old question or an old answer. A request
 * under way is left to finish: it is not taken back, and what it came to is
 * not said once the details have closed.
 */
export function useStop(
  sessionId: string,
  options: {
    /** Whether the details are open. Defaults to open. */
    open?: boolean;
    /** Told once a session has stopped, so the page reads the sessions again at once. */
    onStopped?: () => void;
    /** What stops it. Defaults to asking the app. */
    request?: (sessionId: string) => Promise<StopOutcome>;
  } = {},
): StopPress {
  const { open = true, onStopped, request = requestStop } = options;
  const [step, setStep] = useState<StopStep>({ kind: "idle" });
  // The details closing puts it back, unless a request is under way.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open && !(step.kind === "confirming" && step.busy)) setStep({ kind: "idle" });
  }
  const openNow = useRef(open);
  useEffect(() => {
    openNow.current = open;
  }, [open]);
  const id = useId();
  const [ids] = useState(() => ({
    stop: `${id}-stop`,
    cancel: `${id}-cancel`,
    outcome: `${id}-outcome`,
  }));
  const focusNext = useRef<keyof StopPress["ids"] | null>(null);
  const underWay = useRef(false);
  const drawn = useRef(true);

  useEffect(() => {
    drawn.current = true;
    return () => {
      drawn.current = false;
    };
  }, []);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target !== null) document.getElementById(ids[target])?.focus();
  }, [step, ids]);

  const ask = useCallback(() => {
    if (underWay.current) return;
    focusNext.current = "cancel";
    setStep({ kind: "confirming", busy: false });
  }, []);

  const cancel = useCallback(() => {
    if (underWay.current) return;
    focusNext.current = "stop";
    setStep({ kind: "idle" });
  }, []);

  const confirm = useCallback(() => {
    if (underWay.current) return;
    underWay.current = true;
    setStep({ kind: "confirming", busy: true });
    void request(sessionId).then((result) => {
      underWay.current = false;
      if (!drawn.current) return;
      if (result === "stopped") onStopped?.();
      if (!openNow.current) {
        setStep({ kind: "idle" });
        return;
      }
      focusNext.current = "outcome";
      setStep({ kind: "answered", outcome: result, at: Date.now() });
    });
  }, [sessionId, request, onStopped]);

  return { step, ask, cancel, confirm, ids };
}
