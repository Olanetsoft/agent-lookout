import { useEffect } from "react";

import type { CollectorStore } from "@dashboard/lib/collectorStore";
import { openNotificationHandover } from "@dashboard/lib/notificationHandover";
import { notificationHost } from "@dashboard/lib/notificationHost";
import {
  getNotificationSetting,
  subscribeToNotificationSetting,
} from "@dashboard/lib/notificationSetting";
import { createWaitNotifier } from "@dashboard/lib/waitNotifier";

const notificationsAreOn = () => getNotificationSetting().on;

/**
 * Sends a notification when a session starts waiting for the person, and takes
 * it down when the session moves on, for as long as the app is on the page and
 * notifications are turned on.
 *
 * It listens to the store itself, not to what React draws, so it does its work
 * on every answer from the collector, on every view, and while the tab is in
 * the background. What the store holds when it starts is where it begins: a
 * session already waiting then is not announced. It begins again when the app
 * is stopped and started under a page left open, which the store's history
 * shows as a new start time: a session that was already waiting when the app
 * started is not announced then either.
 *
 * Every notification the page showed is taken down when notifications are
 * turned off and when the page is closed or reloaded, so none is left behind
 * with nothing to clear it. A page that is closed or reloaded also tells the
 * other pages open at this address which sessions those were, because two
 * pages share one notification for a wait, and a page that stays shows it
 * again while the session still waits.
 */
export function useWaitNotifications(store: CollectorStore): void {
  useEffect(() => {
    const notifier = createWaitNotifier({
      // Asked for at each notification, so a host installed later is the one used.
      host: { show: (content) => notificationHost().show(content) },
      isOn: notificationsAreOn,
    });

    const onAnswer = () => {
      const { snapshot, history } = store.getState();
      notifier.handle(snapshot, history?.startedAt ?? null);
    };
    onAnswer();
    const stopListening = store.subscribe(onAnswer);

    let wasOn = notificationsAreOn();
    const stopWatchingSetting = subscribeToNotificationSetting(() => {
      const on = notificationsAreOn();
      // Off is the same choice in every page at this address, so nothing is handed over.
      if (wasOn && !on) notifier.closeAll();
      wasOn = on;
    });

    const handover = openNotificationHandover((sessionIds) => notifier.showAgain(sessionIds));
    const leave = () => handover.handOver(notifier.closeAll());
    window.addEventListener("pagehide", leave);

    return () => {
      stopListening();
      stopWatchingSetting();
      window.removeEventListener("pagehide", leave);
      leave();
      handover.close();
    };
  }, [store]);
}
