import {
  afterNotNow,
  notificationAskDue,
  readNotificationAsk,
  STOPPED,
  writeNotificationAsk,
  type NotificationAsk,
  type StoredNotificationAsk,
} from "@core/notices/notificationAsk";

/**
 * Whether the Overview's question about notifications may come back, kept in
 * local storage beside the choice it asks about: in a browser it belongs to
 * that browser at that address, and in the Mac app to the app's own page.
 *
 * It is written only by Not now, which puts the question off, and by turning
 * notifications off on the Notifications card in Settings, which stops it.
 * Reading it or drawing the question writes nothing. It holds how many times
 * Not now was pressed and when it last was, or that it will not ask again,
 * and nothing about any session.
 *
 * Storage is read on every `get`, so a write from another tab, or storage
 * cleared, is never hidden by what was read before. The same object comes back
 * for as long as the stored text is the same.
 */

export const NOTIFICATION_ASK_STORAGE_KEY = "agent-lookout-notification-ask";

/** The record put off or stopped on this page while storage could not be written. */
let heldHere: NotificationAsk | null = null;
/** The text last read, undefined before the first read, and the record read from it. */
let lastRaw: string | null | undefined;
let lastAsk: NotificationAsk = readNotificationAsk(null);
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

/** The record as it stands: held in memory while storage could not be written, otherwise read from storage. Same object while unchanged. */
export function getNotificationAsk(): NotificationAsk {
  if (heldHere) return heldHere;
  let raw: string | null;
  try {
    raw = localStorage.getItem(NOTIFICATION_ASK_STORAGE_KEY);
  } catch {
    // Storage can be blocked. Read as nothing stored.
    raw = null;
  }
  if (raw === lastRaw) return lastAsk;
  lastRaw = raw;
  lastAsk = readNotificationAsk(raw);
  return lastAsk;
}

function tell(): void {
  for (const listener of listeners) listener();
}

/**
 * Another tab at this address puts the question off, turns notifications off
 * or clears storage. A tab never hears its own writes as a storage event, so
 * those tell the listeners directly.
 */
function watch(): void {
  if (stopWatching) return;
  const onStorage = (event: StorageEvent) => {
    // A null key means the whole of storage was cleared.
    if (event.key === null || event.key === NOTIFICATION_ASK_STORAGE_KEY) tell();
  };
  window.addEventListener("storage", onStorage);
  stopWatching = () => window.removeEventListener("storage", onStorage);
}

export function subscribeToNotificationAsk(listener: () => void): () => void {
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

function write(next: StoredNotificationAsk): void {
  try {
    localStorage.setItem(NOTIFICATION_ASK_STORAGE_KEY, writeNotificationAsk(next));
    heldHere = null;
  } catch {
    // Storage can be blocked. It still holds until the page is closed.
    heldHere = next;
  }
  tell();
}

/**
 * Not now. Puts the question off from the record as it stands now, and only
 * if it is due now; otherwise, as when another tab has just put it off,
 * changes nothing.
 */
export function putOffNotificationAsk(now: number = Date.now()): void {
  const current = getNotificationAsk();
  if (!notificationAskDue(current, now)) return;
  write(afterNotNow(current, now));
}

/**
 * The card's Turn off: the question never comes back on this browser at this
 * address, or in this app. Does nothing when it is already stopped.
 */
export function stopNotificationAsk(): void {
  if (getNotificationAsk().kind === "stopped") return;
  write(STOPPED);
}

/** For tests: forget what was read and held, so the next read comes from storage. */
export function resetNotificationAskForTests(): void {
  heldHere = null;
  lastRaw = undefined;
  lastAsk = readNotificationAsk(null);
}
