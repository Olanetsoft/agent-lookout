import { useCallback, useEffect, useRef, useState } from "react";

import type { PhoneChannel } from "@core/api";
import {
  requestTestSend,
  testFailureWords,
  type TestSendOutcome,
} from "@dashboard/lib/phone/testSend";

/**
 * Where Send a test is between presses:
 *
 * idle     nothing pressed yet
 * sending  one is under way, and another press does nothing
 * sent     the service took it, at `at`
 * failed   none went, or it did not arrive, with what the card says
 */
export type TestStep =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; at: number }
  | { kind: "failed"; words: string };

export interface TestSend {
  step: TestStep;
  /** Asks the app for one test push. A press while one is under way does nothing. */
  send: () => void;
}

/**
 * One channel's Send a test, on its card in Settings: the press, and what it
 * came to, which stays until the next press. `request` is for tests.
 */
export function useTestSend(
  channel: PhoneChannel,
  request: (channel: PhoneChannel) => Promise<TestSendOutcome> = requestTestSend,
): TestSend {
  const [step, setStep] = useState<TestStep>({ kind: "idle" });
  const underWay = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = useCallback(() => {
    if (underWay.current) return;
    underWay.current = true;
    setStep({ kind: "sending" });
    void request(channel).then((outcome) => {
      underWay.current = false;
      if (!mounted.current) return;
      setStep(
        outcome.ok
          ? { kind: "sent", at: outcome.at }
          : { kind: "failed", words: testFailureWords(outcome, Date.now()) },
      );
    });
  }, [channel, request]);

  return { step, send };
}
