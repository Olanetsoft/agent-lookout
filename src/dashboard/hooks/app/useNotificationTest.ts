import { useCallback, useEffect, useRef, useState } from "react";

import type { NotificationTestOutcome } from "@core/notices/appNotifications";
import {
  fetchAppNotificationsStatus,
  requestNotificationTest,
} from "@dashboard/lib/notifications/appNotifications";

/**
 * Where Send a test, on the Notifications card in the Mac app, is between
 * presses:
 *
 * idle      nothing pressed yet
 * sending   one is under way, and another press does nothing
 * answered  the app said what macOS made of it, at `at`
 * failed    the app did not answer
 */
export type NotificationTestStep =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "answered"; answer: NotificationTestOutcome; at: number }
  | { kind: "failed" };

export interface NotificationTest {
  step: NotificationTestStep;
  /**
   * The reason macOS gave the last time it would not show one of the app's
   * notifications, or null: as the app said when the card was drawn, then as
   * each test macOS showed or refused since says. A test macOS did not answer,
   * or that could not be shown, leaves it as it was.
   */
  lastRefusal: string | null;
  /** Asks the app for one test notification. A press while one is under way does nothing. */
  send: () => void;
}

/**
 * The Mac app's test of its own notifications: the press, and what macOS made
 * of it, which stays until the next press, with the reason macOS gave the last
 * time it refused one. That is read when the card is drawn, and set again by
 * each test macOS answers: to its reason when it refuses one, and to null when
 * it shows one, as the app keeps it. A read that answers after a test has
 * already said is older than the test, so it is left out.
 *
 * Only the app answers these, so with `inApp` false, as in a browser, it asks
 * nothing.
 */
export function useNotificationTest(inApp: boolean): NotificationTest {
  const [step, setStep] = useState<NotificationTestStep>({ kind: "idle" });
  const [lastRefusal, setLastRefusal] = useState<string | null>(null);
  const underWay = useRef(false);
  const mounted = useRef(true);
  /** Whether a test macOS showed or refused has set the refusal since the card was drawn. */
  const heard = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (inApp) {
      void fetchAppNotificationsStatus().then((status) => {
        if (mounted.current && !heard.current && status !== null) {
          setLastRefusal(status.lastRefusal);
        }
      });
    }
    return () => {
      mounted.current = false;
    };
  }, [inApp]);

  const send = useCallback(() => {
    if (!inApp || underWay.current) return;
    underWay.current = true;
    setStep({ kind: "sending" });
    void requestNotificationTest().then((answer) => {
      underWay.current = false;
      if (!mounted.current) return;
      if (answer?.outcome === "refused" || answer?.outcome === "shown") {
        heard.current = true;
        setLastRefusal(answer.outcome === "refused" ? answer.reason : null);
      }
      setStep(answer === null ? { kind: "failed" } : { kind: "answered", answer, at: Date.now() });
    });
  }, [inApp]);

  return { step, lastRefusal, send };
}
