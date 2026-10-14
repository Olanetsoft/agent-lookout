import { afterEach, expect, test, vi } from "vitest";

import { ASK_AGAIN_AFTER_MS } from "@core/notices/notificationAsk";
import {
  getNotificationAsk,
  NOTIFICATION_ASK_STORAGE_KEY,
  putOffNotificationAsk,
  resetNotificationAskForTests,
  stopNotificationAsk,
  subscribeToNotificationAsk,
} from "@dashboard/lib/notifications/ask/notificationAskStore";
import { NOTIFICATIONS_STORAGE_KEY } from "@dashboard/lib/notifications/notificationSetting";

// Runs in the component project because the record lives in local storage and
// the store listens to the page.

const t = 1_791_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetNotificationAskForTests();
});

const stored = () => localStorage.getItem(NOTIFICATION_ASK_STORAGE_KEY);

test("the record is kept under the agent-lookout-notification-ask key, and reading it writes nothing", () => {
  expect(NOTIFICATION_ASK_STORAGE_KEY).toBe("agent-lookout-notification-ask");
  const setItem = vi.spyOn(Storage.prototype, "setItem");

  expect(getNotificationAsk()).toEqual({ kind: "unasked" });
  expect(getNotificationAsk()).toEqual({ kind: "unasked" });

  expect(setItem).not.toHaveBeenCalled();
  expect(stored()).toBeNull();
});

test("it is the same object while storage is unchanged, and a new one once the key changes", () => {
  localStorage.setItem(NOTIFICATION_ASK_STORAGE_KEY, JSON.stringify({ notNow: 1, at: t }));
  const first = getNotificationAsk();
  expect(first).toEqual({ kind: "put-off", times: 1, at: t });
  expect(getNotificationAsk()).toBe(first);

  localStorage.setItem(NOTIFICATION_ASK_STORAGE_KEY, JSON.stringify({ notNow: 2, at: t }));
  const second = getNotificationAsk();
  expect(second).not.toBe(first);
  expect(second).toEqual({ kind: "put-off", times: 2, at: t });

  // Cleared, as another tab can: read again, and not hidden by what was read before.
  localStorage.clear();
  expect(getNotificationAsk()).toEqual({ kind: "unasked" });
});

test("Not now writes a count and a time, tells a subscriber once, and touches no other key", () => {
  const listener = vi.fn();
  const stop = subscribeToNotificationAsk(listener);

  putOffNotificationAsk(t);

  expect(stored()).toBe(`{"notNow":1,"at":${t}}`);
  expect(listener).toHaveBeenCalledOnce();
  expect(Object.keys(localStorage)).toEqual([NOTIFICATION_ASK_STORAGE_KEY]);
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  stop();
});

test("a second Not now while the question is not due, as from another tab just after, changes nothing and tells nobody", () => {
  putOffNotificationAsk(t);
  const listener = vi.fn();
  const stop = subscribeToNotificationAsk(listener);
  const setItem = vi.spyOn(Storage.prototype, "setItem");

  putOffNotificationAsk(t + 1000);

  expect(stored()).toBe(`{"notNow":1,"at":${t}}`);
  expect(setItem).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  stop();
});

test("four Not now, each when the question came back, stop it for good, and a fifth writes nothing", () => {
  let now = t;
  putOffNotificationAsk(now);
  for (const [index, wait] of ASK_AGAIN_AFTER_MS.entries()) {
    now += wait;
    putOffNotificationAsk(now);
    if (index < ASK_AGAIN_AFTER_MS.length - 1) {
      expect(stored()).toBe(`{"notNow":${index + 2},"at":${now}}`);
    }
  }
  expect(stored()).toBe('{"stopped":true}');
  expect(getNotificationAsk()).toEqual({ kind: "stopped" });

  const setItem = vi.spyOn(Storage.prototype, "setItem");
  putOffNotificationAsk(now + 365 * 86_400_000);
  expect(setItem).not.toHaveBeenCalled();
});

test("turning notifications off in Settings stops it, and a second time writes nothing", () => {
  const listener = vi.fn();
  const stop = subscribeToNotificationAsk(listener);

  stopNotificationAsk();
  expect(stored()).toBe('{"stopped":true}');
  expect(listener).toHaveBeenCalledOnce();

  const setItem = vi.spyOn(Storage.prototype, "setItem");
  stopNotificationAsk();
  expect(setItem).not.toHaveBeenCalled();
  expect(listener).toHaveBeenCalledOnce();
  stop();
});

test("a storage event for the key, or for all of storage, tells subscribers; one for another key does not, and none once unsubscribed", () => {
  const listener = vi.fn();
  const stop = subscribeToNotificationAsk(listener);

  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATION_ASK_STORAGE_KEY }));
  expect(listener).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(listener).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new StorageEvent("storage", { key: "agent-lookout-theme" }));
  expect(listener).toHaveBeenCalledTimes(2);

  stop();
  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATION_ASK_STORAGE_KEY }));
  expect(listener).toHaveBeenCalledTimes(2);
});

test("with storage blocked it reads as never put off, a Not now holds until the page is closed, and nothing throws", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });

  expect(getNotificationAsk()).toEqual({ kind: "unasked" });
  expect(() => putOffNotificationAsk(t)).not.toThrow();
  expect(getNotificationAsk()).toEqual({ kind: "put-off", times: 1, at: t });
  expect(() => stopNotificationAsk()).not.toThrow();
  expect(getNotificationAsk()).toEqual({ kind: "stopped" });
});
