import { useSyncExternalStore } from "react";

import {
  chooseNotificationEvent,
  getNotificationSetting,
  subscribeToNotificationSetting,
  turnOffNotifications,
  turnOnNotifications,
  type NotificationSettingState,
} from "@dashboard/lib/notifications/notificationSetting";

export interface UseNotificationSetting extends NotificationSettingState {
  /** Asks the browser for permission if it has to. Call it from a click. */
  turnOn: () => void;
  turnOff: () => void;
  /** Switches one event on or off. */
  chooseEvent: typeof chooseNotificationEvent;
}

function turnOn(): void {
  void turnOnNotifications();
}

export function useNotificationSetting(): UseNotificationSetting {
  const state = useSyncExternalStore(subscribeToNotificationSetting, getNotificationSetting);
  return {
    ...state,
    turnOn,
    turnOff: turnOffNotifications,
    chooseEvent: chooseNotificationEvent,
  };
}
