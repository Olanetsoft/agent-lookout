import { useEffect } from "react";

import { notificationsHeaderValue } from "@core/api";
import type { NoticeEvent } from "@core/sessions/waitChanges";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import type { CollectorStore } from "@dashboard/lib/api/collectorStore";
import { openNotificationHandover } from "@dashboard/lib/notifications/notificationHandover";
import { notificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
  notificationEventsInForce,
  subscribeToNotificationSetting,
} from "@dashboard/lib/notifications/notificationSetting";
import { createWaitNotifier } from "@dashboard/lib/notifications/waitNotifier";

const notifiesOf = (event: NoticeEvent) => notificationEventsInForce().includes(event);
/** What every request tells the collector of the setting. */
const headerNow = () => notificationsHeaderValue(notificationEventsInForce());

/**
 * Tells the collector what the setting is now, in a request of its own.
 *
 * The collector shows notifications itself when no page is open, and knows the
 * setting only from the header `apiRequest` puts on every request. The next
 * poll can be two seconds off, and a tab closed before it would leave the
 * collector with the old setting until a dashboard is opened again. So the
 * change is said at once, and `keepalive` lets the request finish when the tab
 * is closed straight after. The store's `refresh` would not do: it is skipped
 * while a poll is under way, and that poll left with the old setting.
 */
async function tellCollector(): Promise<void> {
  try {
    // Asked for the header it carries. The answer is not read.
    await apiRequest("/api/health", { keepalive: true });
  } catch {
    // Not heard. The next poll says it.
  }
}

/**
 * Sends a notification when a session starts waiting for the person, and takes
 * it down when the session moves on, and one when a session finishes, fails or
 * ends, for each of those the person chose, for as long as the app is on the
 * page and notifications are turned on.
 *
 * It listens to the store itself, not to what React draws, so it does its work
 * on every answer from the collector, on every view, and while the tab is in
 * the background. What the store holds when it starts is where it begins: a
 * session already waiting then is not announced. It begins again when the app
 * is stopped and started under a page left open, which the store's history
 * shows as a new start time: a session that was already waiting when the app
 * started is not announced then either.
 *
 * Every notification of a wait the page showed is taken down when
 * notifications, or Needs you, are turned off and when the page is closed or
 * reloaded, so none is left behind with nothing to clear it. A page that is
 * closed or reloaded also tells the other pages open at this address which
 * sessions those were, because two pages share one notification for a wait,
 * and a page that stays shows it again while the session still waits. One
 * that a session finished, failed or ended is news that stays true, and is
 * left for the person to clear.
 *
 * When notifications go on or off, or an event is switched, the collector is
 * told at once, because its own notifications follow the same setting.
 */
export function useWaitNotifications(store: CollectorStore): void {
  useEffect(() => {
    const notifier = createWaitNotifier({
      // Asked for at each notification, so a host installed later is the one used.
      host: { show: (content) => notificationHost().show(content) },
      isOn: notifiesOf,
    });

    const onAnswer = () => {
      const { snapshot, history } = store.getState();
      notifier.handle(snapshot, history?.startedAt ?? null);
    };
    onAnswer();
    const stopListening = store.subscribe(onAnswer);

    let said = headerNow();
    let showedWaits = notifiesOf("needs-you");
    const stopWatchingSetting = subscribeToNotificationSetting(() => {
      const saying = headerNow();
      if (saying !== said) void tellCollector();
      said = saying;
      // Off is the same choice in every page at this address, so nothing is handed over.
      const showsWaits = notifiesOf("needs-you");
      if (showedWaits && !showsWaits) notifier.closeAll();
      showedWaits = showsWaits;
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
