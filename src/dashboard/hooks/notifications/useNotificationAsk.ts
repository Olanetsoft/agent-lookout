import { useCallback, useEffect, useState } from "react";

import { notificationAskDue } from "@core/notices/notificationAsk";
import {
  getNotificationAsk,
  putOffNotificationAsk,
  subscribeToNotificationAsk,
} from "@dashboard/lib/notifications/ask/notificationAskStore";
import {
  getNotificationSetting,
  subscribeToNotificationSetting,
} from "@dashboard/lib/notifications/notificationSetting";

export interface UseNotificationAsk {
  /**
   * Whether the Overview asks: it was due when the Overview was drawn, or when
   * the page last came back into sight, and nothing since has taken it away.
   */
  asking: boolean;
  /** Not now. */
  putOff: () => void;
}

/**
 * Whether the question may be asked now: notifications are not on, the
 * browser neither blocks them nor has no way to show them, and it is due.
 */
function dueNow(): boolean {
  const { on, permission } = getNotificationSetting();
  if (on || permission === "denied" || permission === "unsupported") return false;
  return notificationAskDue(getNotificationAsk(), Date.now());
}

/**
 * Whether the Overview asks to turn notifications on.
 *
 * It is decided when the Overview is drawn, and again when the page comes back
 * into sight, and never while the person is looking at it: time passing in
 * view does not bring the question in. A change while the page is in view,
 * such as Not now or notifications turned on here or in another tab, or the
 * browser now blocking them, can only take it away. Not now here always takes
 * it away, even when the record has stopped being due by then and is left as
 * it was.
 *
 * It never writes, never asks the browser for permission and never makes a
 * request.
 */
export function useNotificationAsk(): UseNotificationAsk {
  const [asking, setAsking] = useState(dueNow);

  useEffect(() => {
    const takeAwayIfNotDue = () => {
      if (!dueNow()) setAsking(false);
    };
    const onVisibility = () => {
      if (!document.hidden) setAsking(dueNow());
    };
    const stopAsk = subscribeToNotificationAsk(takeAwayIfNotDue);
    const stopSetting = subscribeToNotificationSetting(takeAwayIfNotDue);
    // A change between drawing and listening is heard by nobody, so read again.
    takeAwayIfNotDue();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopAsk();
      stopSetting();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const putOff = useCallback(() => {
    putOffNotificationAsk();
    setAsking(false);
  }, []);

  return { asking, putOff };
}
