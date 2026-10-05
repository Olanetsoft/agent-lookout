import {
  DEFAULT_NOTICE_EVENTS,
  NOTICE_EVENTS,
  readNoticeEvents,
  writeNoticeEvents,
  type NoticeEvent,
} from "@core/sessions/waitChanges";
import {
  notificationHost,
  type NotificationPermissionState,
} from "@dashboard/lib/notifications/notificationHost";

/**
 * Whether notifications are sent, and for which events: a small store outside
 * React, like the theme.
 *
 * Two things decide whether they are on. The person's choice, "on" or "off",
 * is kept in local storage, so it belongs to this browser at this address. The
 * browser's permission belongs to the browser, and can change without this
 * page being told. Notifications are on only while the choice is on and the
 * permission is granted, and the permission is read again every time that is
 * asked.
 *
 * They are off until the person turns them on, and turning them on is the only
 * thing that ever asks the browser for permission.
 *
 * The events, a session starting to wait, finishing, failing or ending, are
 * chosen one by one and kept in local storage beside the choice. Until the
 * person changes them, a wait alone sends one.
 *
 * The collector's own notifications, shown when no page is open, follow this
 * setting too: `apiRequest` tells the collector which events are on with every
 * request.
 */

export type NotificationChoice = "on" | "off";

export const NOTIFICATIONS_STORAGE_KEY = "agent-lookout-notifications";

/** Where the events are kept, as names separated by commas: `needs-you,finished`. */
export const NOTIFICATION_EVENTS_STORAGE_KEY = "agent-lookout-notification-events";

export interface NotificationSettingState {
  /** What the person chose here. */
  choice: NotificationChoice;
  /** What the browser allows this address. */
  permission: NotificationPermissionState;
  /** Whether a notification is sent: the choice is on and the permission is granted. */
  on: boolean;
  /** The events the person chose, in the order of `NOTICE_EVENTS`. Kept while notifications are off. */
  events: readonly NoticeEvent[];
}

function readStoredChoice(): NotificationChoice {
  try {
    return localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === "on" ? "on" : "off";
  } catch {
    // Storage can be blocked. Keep the default.
    return "off";
  }
}

/** The events, from storage. Nothing stored, or anything that cannot be read, is the default. */
function readStoredEvents(): readonly NoticeEvent[] {
  try {
    const stored = localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY);
    return (stored === null ? null : readNoticeEvents(stored)) ?? DEFAULT_NOTICE_EVENTS;
  } catch {
    // Storage can be blocked. Keep the default.
    return DEFAULT_NOTICE_EVENTS;
  }
}

let choice: NotificationChoice | null = null;
let events: readonly NoticeEvent[] | null = null;
let state: NotificationSettingState | null = null;
/** The state listeners were last told of, or have read for themselves on subscribing. */
let announced: NotificationSettingState | null = null;
let asking: Promise<void> | null = null;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

/**
 * The setting as it stands, with the permission read from the browser now. It
 * is the same object for as long as nothing has changed.
 */
export function getNotificationSetting(): NotificationSettingState {
  choice ??= readStoredChoice();
  events ??= readStoredEvents();
  const permission = notificationHost().permission();
  if (
    !state ||
    state.choice !== choice ||
    state.permission !== permission ||
    state.events !== events
  ) {
    state = { choice, permission, on: choice === "on" && permission === "granted", events };
  }
  return state;
}

/** The events a notification is sent for now: those chosen while notifications are on, and none while they are off. */
export function notificationEventsInForce(): readonly NoticeEvent[] {
  const current = getNotificationSetting();
  return current.on ? current.events : [];
}

/**
 * Reads the setting again and tells listeners if it is not what they were last
 * told. A read in between may already have seen the permission change, so the
 * comparison is with what was announced, not with the last read.
 */
function refresh(): void {
  const current = getNotificationSetting();
  if (current === announced) return;
  announced = current;
  for (const listener of listeners) listener();
}

function store(next: NotificationChoice): void {
  choice = next;
  try {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, next);
  } catch {
    // Storage can be blocked. The choice still applies until the page is closed.
  }
}

/**
 * The two things that change without this page doing anything: the choice, in
 * another tab at the same address, and the permission, in the browser's own
 * settings. The first arrives as a storage event. The second is not announced,
 * so it is read again whenever the person comes back to the page.
 */
function watch(): void {
  if (stopWatching) return;
  const onStorage = (event: StorageEvent) => {
    // A null key means the whole of storage was cleared.
    if (event.key === null || event.key === NOTIFICATIONS_STORAGE_KEY) {
      choice = readStoredChoice();
    }
    if (event.key === null || event.key === NOTIFICATION_EVENTS_STORAGE_KEY) {
      const stored = readStoredEvents();
      // The same list read again is not a change.
      if (events === null || writeNoticeEvents(stored) !== writeNoticeEvents(events)) {
        events = stored;
      }
    }
    refresh();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  stopWatching = () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

export function subscribeToNotificationSetting(listener: () => void): () => void {
  if (listeners.size === 0) announced = getNotificationSetting();
  listeners.add(listener);
  watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatching) {
      stopWatching();
      stopWatching = null;
    }
  };
}

async function turnOn(): Promise<void> {
  const host = notificationHost();
  let permission = host.permission();
  if (permission === "default") {
    // Asked before anything is awaited, so the browser sees it come from the click.
    try {
      permission = await host.requestPermission();
    } catch {
      permission = host.permission();
    }
  }
  // Refused, or not possible here: the choice stays as it was, and the page says why.
  if (permission === "granted") store("on");
  refresh();
}

/**
 * Turns notifications on, asking the browser for permission if it has not been
 * asked before. Call it from inside a click. If the browser refuses or cannot
 * show notifications, they stay off. This is the only place permission is
 * ever asked for.
 */
export function turnOnNotifications(): Promise<void> {
  // A second press while the browser is still asking joins the first.
  asking ??= turnOn().finally(() => {
    asking = null;
  });
  return asking;
}

export function turnOffNotifications(): void {
  store("off");
  refresh();
}

/** Switches one event on or off, and keeps the choice. It asks the browser nothing. */
export function chooseNotificationEvent(event: NoticeEvent, chosen: boolean): void {
  const current = getNotificationSetting().events;
  if (current.includes(event) === chosen) return;
  const next = NOTICE_EVENTS.filter((each) => (each === event ? chosen : current.includes(each)));
  events = next;
  try {
    localStorage.setItem(NOTIFICATION_EVENTS_STORAGE_KEY, writeNoticeEvents(next));
  } catch {
    // Storage can be blocked. The choice still applies until the page is closed.
  }
  refresh();
}

/** For tests: forget the cached state so the next read comes from storage. */
export function resetNotificationSettingForTests(): void {
  choice = null;
  events = null;
  state = null;
  announced = null;
  asking = null;
}
