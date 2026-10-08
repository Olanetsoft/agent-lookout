import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

import { setNotificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
  chooseNotificationEvent,
  getNotificationSetting,
  NOTIFICATION_EVENTS_STORAGE_KEY,
  notificationEventsInForce,
  NOTIFICATIONS_STORAGE_KEY,
  resetNotificationSettingForTests,
  subscribeToNotificationSetting,
  turnOffNotifications,
  turnOnNotifications,
} from "@dashboard/lib/notifications/notificationSetting";
import { fakeNotificationHost, type FakeNotificationHost } from "@tests/support/notifications";

// Runs in the component project because the choice lives in localStorage and
// the store listens to the page. The notification system is a stand-in, so no
// test asks this browser for permission.

let host: FakeNotificationHost;

beforeEach(() => {
  host = fakeNotificationHost();
  setNotificationHost(host);
});

afterEach(() => {
  localStorage.clear();
  resetNotificationSettingForTests();
  setNotificationHost();
});

test("notifications are off when nothing is stored", () => {
  expect(getNotificationSetting()).toEqual({
    choice: "off",
    chosen: false,
    permission: "default",
    on: false,
    events: ["needs-you"],
  });
});

test("the choice is read under the agent-lookout-notifications key", () => {
  expect(NOTIFICATIONS_STORAGE_KEY).toBe("agent-lookout-notifications");
  host.state = "granted";
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");

  expect(getNotificationSetting()).toEqual({
    choice: "on",
    chosen: true,
    permission: "granted",
    on: true,
    events: ["needs-you"],
  });
});

test.each(["yes", "true", "ON", "", "granted"])(
  "a stored value of %j is neither on nor off, so it reads as off",
  (stored) => {
    host.state = "granted";
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, stored);

    expect(getNotificationSetting()).toMatchObject({ choice: "off", chosen: true, on: false });
  },
);

describe("never chosen and off", () => {
  test.each(["on", "off"] as const)("a stored %s is a choice made", (stored) => {
    host.state = "granted";
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, stored);

    expect(getNotificationSetting()).toMatchObject({ choice: stored, chosen: true });
  });

  test("nothing stored is off and never chosen", () => {
    host.state = "granted";

    expect(getNotificationSetting()).toMatchObject({ choice: "off", chosen: false, on: false });
  });

  test("turning off when they were never chosen stores off, so it is chosen, and tells listeners", () => {
    host.state = "granted";
    const listener = vi.fn();
    const stop = subscribeToNotificationSetting(listener);

    turnOffNotifications();

    expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("off");
    expect(getNotificationSetting()).toMatchObject({ choice: "off", chosen: true, on: false });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  test("turning on stores on, so it is chosen", async () => {
    host.state = "granted";

    await turnOnNotifications();

    expect(getNotificationSetting()).toMatchObject({ choice: "on", chosen: true, on: true });
  });

  test("storage cleared in another tab is never chosen again", () => {
    host.state = "granted";
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "off");
    const listener = vi.fn();
    const stop = subscribeToNotificationSetting(listener);
    expect(getNotificationSetting().chosen).toBe(true);

    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    expect(getNotificationSetting()).toMatchObject({ choice: "off", chosen: false });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  test("with storage blocked nothing reads as chosen, and a choice made holds until the page is closed", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    try {
      expect(getNotificationSetting()).toMatchObject({ choice: "off", chosen: false });
      turnOffNotifications();
      expect(getNotificationSetting()).toMatchObject({ choice: "off", chosen: true });
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

test.each(["default", "denied", "unsupported"] as const)(
  "a stored on with the permission %s is not on",
  (permission) => {
    host.state = permission;
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");

    expect(getNotificationSetting()).toEqual({
      choice: "on",
      chosen: true,
      permission,
      on: false,
      events: ["needs-you"],
    });
  },
);

test("reading and subscribing never ask for permission", () => {
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");

  getNotificationSetting();
  const stop = subscribeToNotificationSetting(() => {});
  getNotificationSetting();
  window.dispatchEvent(new Event("focus"));
  stop();

  expect(host.asked).toBe(0);
  expect(host.shown).toEqual([]);
});

test("the state is the same object for as long as nothing has changed", () => {
  const first = getNotificationSetting();

  expect(getNotificationSetting()).toBe(first);
  host.state = "denied";
  expect(getNotificationSetting()).not.toBe(first);
});

test("turning on asks once when the browser has not been asked, and stores on when it is granted", async () => {
  const listener = vi.fn();
  const stop = subscribeToNotificationSetting(listener);

  await turnOnNotifications();

  expect(host.asked).toBe(1);
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("on");
  expect(getNotificationSetting()).toEqual({
    choice: "on",
    chosen: true,
    permission: "granted",
    on: true,
    events: ["needs-you"],
  });
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});

test("the browser is asked before turning on returns, so the question comes from the click", () => {
  void turnOnNotifications();

  expect(host.asked).toBe(1);
});

test("a second press while the browser is still asking does not ask again", async () => {
  const first = turnOnNotifications();
  const second = turnOnNotifications();
  await Promise.all([first, second]);

  expect(host.asked).toBe(1);
  expect(getNotificationSetting().on).toBe(true);
});

test("a refusal leaves notifications off, with the permission reported as denied", async () => {
  host.answer = "denied";
  const listener = vi.fn();
  const stop = subscribeToNotificationSetting(listener);

  await turnOnNotifications();

  expect(host.asked).toBe(1);
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  expect(getNotificationSetting()).toEqual({
    choice: "off",
    chosen: false,
    permission: "denied",
    on: false,
    events: ["needs-you"],
  });
  // Listeners are told, because the page now has to say that they are blocked.
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});

test("a question the person closes without answering leaves notifications off", async () => {
  host.answer = "default";

  await turnOnNotifications();

  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  expect(getNotificationSetting()).toEqual({
    choice: "off",
    chosen: false,
    permission: "default",
    on: false,
    events: ["needs-you"],
  });
});

test("with the permission already granted, turning on asks nothing", async () => {
  host.state = "granted";

  await turnOnNotifications();

  expect(host.asked).toBe(0);
  expect(getNotificationSetting()).toEqual({
    choice: "on",
    chosen: true,
    permission: "granted",
    on: true,
    events: ["needs-you"],
  });
});

test.each(["denied", "unsupported"] as const)(
  "with the permission %s, turning on asks nothing and changes nothing",
  async (permission) => {
    host.state = permission;

    await turnOnNotifications();

    expect(host.asked).toBe(0);
    expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
    expect(getNotificationSetting()).toEqual({
      choice: "off",
      chosen: false,
      permission,
      on: false,
      events: ["needs-you"],
    });
  },
);

test("turning off stores off and tells listeners", async () => {
  host.state = "granted";
  await turnOnNotifications();
  const listener = vi.fn();
  const stop = subscribeToNotificationSetting(listener);

  turnOffNotifications();

  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("off");
  expect(getNotificationSetting()).toEqual({
    choice: "off",
    chosen: true,
    permission: "granted",
    on: false,
    events: ["needs-you"],
  });
  expect(listener).toHaveBeenCalledTimes(1);

  stop();
  await turnOnNotifications();
  expect(listener).toHaveBeenCalledTimes(1);
});

test("the choice is still there when the page is opened again", async () => {
  host.state = "granted";
  await turnOnNotifications();

  resetNotificationSettingForTests();
  expect(getNotificationSetting().on).toBe(true);

  turnOffNotifications();
  resetNotificationSettingForTests();
  expect(getNotificationSetting().on).toBe(false);
});

test("a permission taken away in the browser's settings is seen at the next read, and listeners hear when the person comes back", async () => {
  host.state = "granted";
  await turnOnNotifications();
  const listener = vi.fn();
  const stop = subscribeToNotificationSetting(listener);

  host.state = "denied";
  // Read at the moment a notification would be sent.
  expect(getNotificationSetting().on).toBe(false);
  expect(listener).not.toHaveBeenCalled();

  window.dispatchEvent(new Event("focus"));
  expect(listener).toHaveBeenCalledTimes(1);
  // Nothing changed since, so coming back again says nothing.
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(listener).toHaveBeenCalledTimes(1);

  // The choice is kept: allowing them again in the browser turns them back on.
  host.state = "granted";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(listener).toHaveBeenCalledTimes(2);
  expect(getNotificationSetting()).toEqual({
    choice: "on",
    chosen: true,
    permission: "granted",
    on: true,
    events: ["needs-you"],
  });
  stop();
});

test("a choice made in another tab at this address is followed", async () => {
  host.state = "granted";
  await turnOnNotifications();
  const listener = vi.fn();
  const stop = subscribeToNotificationSetting(listener);

  // The other tab turns them off. This tab hears it as a storage event.
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "off");
  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATIONS_STORAGE_KEY }));
  expect(getNotificationSetting().on).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);

  // A change to something else in storage is not this setting's business.
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
  window.dispatchEvent(new StorageEvent("storage", { key: "agent-lookout-theme" }));
  expect(getNotificationSetting().on).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);

  // Storage cleared altogether: the choice is back to off.
  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATIONS_STORAGE_KEY }));
  expect(getNotificationSetting().on).toBe(true);
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(getNotificationSetting().on).toBe(false);
  stop();
});

test("once nothing is listening, the page is no longer listened to", async () => {
  host.state = "granted";
  await turnOnNotifications();
  const listener = vi.fn();
  const stop = subscribeToNotificationSetting(listener);
  stop();
  const read = vi.spyOn(host, "permission");

  host.state = "denied";
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "off");
  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATIONS_STORAGE_KEY }));

  expect(listener).not.toHaveBeenCalled();
  // The listener would not hear either way. What shows the page is let go of
  // is that its events no longer make the setting read the permission.
  expect(read).not.toHaveBeenCalled();

  // And it is taken up again for the next to listen.
  const again = vi.fn();
  const stopAgain = subscribeToNotificationSetting(again);
  host.state = "granted";
  window.dispatchEvent(new Event("focus"));
  expect(again).toHaveBeenCalledTimes(1);
  stopAgain();
});

test("when storage is blocked the choice still holds until the page is closed", async () => {
  host.state = "granted";
  const blocked = () => {
    throw new DOMException("Storage is blocked.", "SecurityError");
  };
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
  const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);

  try {
    expect(getNotificationSetting().on).toBe(false);
    await turnOnNotifications();
    expect(getNotificationSetting().on).toBe(true);
    turnOffNotifications();
    expect(getNotificationSetting().on).toBe(false);
  } finally {
    setItem.mockRestore();
    getItem.mockRestore();
  }
});

test("after a question the person closed without answering, the next press asks again", async () => {
  host.answer = "default";
  await turnOnNotifications();
  expect(host.asked).toBe(1);
  expect(getNotificationSetting().on).toBe(false);

  host.answer = "granted";
  await turnOnNotifications();

  expect(host.asked).toBe(2);
  expect(getNotificationSetting()).toEqual({
    choice: "on",
    chosen: true,
    permission: "granted",
    on: true,
    events: ["needs-you"],
  });
});

test("a question that fails leaves notifications off, and turning on does not fail with it", async () => {
  host.requestPermission = () => Promise.reject(new Error("The question could not be asked."));
  const listener = vi.fn();
  const stop = subscribeToNotificationSetting(listener);

  await expect(turnOnNotifications()).resolves.toBeUndefined();

  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  expect(getNotificationSetting()).toEqual({
    choice: "off",
    chosen: false,
    permission: "default",
    on: false,
    events: ["needs-you"],
  });
  // Nothing changed, so nobody is told.
  expect(listener).not.toHaveBeenCalled();
  stop();
});

test("a question that fails after the person allowed them turns them on, by the permission as it stands", async () => {
  host.requestPermission = () => {
    host.state = "granted";
    return Promise.reject(new Error("The answer was lost."));
  };

  await turnOnNotifications();

  expect(getNotificationSetting()).toEqual({
    choice: "on",
    chosen: true,
    permission: "granted",
    on: true,
    events: ["needs-you"],
  });
});

test("turning on when they are already on asks nothing and tells nobody", async () => {
  host.state = "granted";
  await turnOnNotifications();
  const listener = vi.fn();
  const stop = subscribeToNotificationSetting(listener);

  await turnOnNotifications();

  expect(host.asked).toBe(0);
  expect(listener).not.toHaveBeenCalled();
  expect(getNotificationSetting().on).toBe(true);
  stop();
});

test("with two listening, one leaving does not stop the other hearing the page", async () => {
  host.state = "granted";
  await turnOnNotifications();
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = subscribeToNotificationSetting(first);
  const stopSecond = subscribeToNotificationSetting(second);

  stopFirst();
  host.state = "denied";
  window.dispatchEvent(new Event("focus"));
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);

  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "off");
  host.state = "granted";
  window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATIONS_STORAGE_KEY }));
  expect(second).toHaveBeenCalledTimes(2);
  expect(getNotificationSetting()).toEqual({
    choice: "off",
    chosen: true,
    permission: "granted",
    on: false,
    events: ["needs-you"],
  });
  stopSecond();
});

test("nothing is written to storage until the person chooses", () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  try {
    getNotificationSetting();
    const stop = subscribeToNotificationSetting(() => {});
    window.dispatchEvent(new Event("focus"));
    stop();

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  } finally {
    setItem.mockRestore();
  }
});

test("only the choice is stored: one value, under the one key", async () => {
  host.state = "granted";
  // Every write this page makes, to local storage or to session storage.
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  try {
    await turnOnNotifications();
    turnOffNotifications();

    expect(setItem.mock.calls).toEqual([
      [NOTIFICATIONS_STORAGE_KEY, "on"],
      [NOTIFICATIONS_STORAGE_KEY, "off"],
    ]);
    expect(setItem.mock.contexts).toEqual([localStorage, localStorage]);
  } finally {
    setItem.mockRestore();
  }
});

test("a second press while the question is still open joins the first, and asks nothing more", async () => {
  // A person who takes their time: the question stays open until the test answers it.
  let answer = (): void => {};
  host.requestPermission = () => {
    host.asked += 1;
    return new Promise((resolve) => {
      answer = () => {
        host.state = "granted";
        resolve(host.state);
      };
    });
  };

  const first = turnOnNotifications();
  const second = turnOnNotifications();
  expect(host.asked).toBe(1);
  expect(getNotificationSetting().on).toBe(false);

  answer();
  await Promise.all([first, second]);

  expect(host.asked).toBe(1);
  expect(getNotificationSetting()).toEqual({
    choice: "on",
    chosen: true,
    permission: "granted",
    on: true,
    events: ["needs-you"],
  });
});

describe("the events", () => {
  test("until the person chooses, a wait alone sends a notification, and nothing is stored", () => {
    expect(NOTIFICATION_EVENTS_STORAGE_KEY).toBe("agent-lookout-notification-events");
    expect(getNotificationSetting().events).toEqual(["needs-you"]);
    expect(localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY)).toBeNull();
  });

  test("choosing one stores the list beside the choice, tells listeners, and asks the browser nothing", () => {
    const listener = vi.fn();
    const stop = subscribeToNotificationSetting(listener);

    chooseNotificationEvent("finished", true);
    expect(getNotificationSetting().events).toEqual(["needs-you", "finished"]);
    expect(localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY)).toBe("needs-you,finished");
    expect(listener).toHaveBeenCalledTimes(1);

    chooseNotificationEvent("needs-you", false);
    chooseNotificationEvent("ended", true);
    expect(getNotificationSetting().events).toEqual(["finished", "ended"]);
    expect(localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY)).toBe("finished,ended");
    expect(listener).toHaveBeenCalledTimes(3);

    // Choosing what is already chosen changes nothing and tells nobody.
    chooseNotificationEvent("ended", true);
    expect(listener).toHaveBeenCalledTimes(3);

    // Every one off is a choice too, and is kept.
    chooseNotificationEvent("finished", false);
    chooseNotificationEvent("ended", false);
    expect(getNotificationSetting().events).toEqual([]);
    expect(localStorage.getItem(NOTIFICATION_EVENTS_STORAGE_KEY)).toBe("");
    expect(host.asked).toBe(0);
    // Only the events were written. Notifications themselves are still off.
    expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
    stop();
  });

  test("the choice is still there when the page is opened again", () => {
    chooseNotificationEvent("failed", true);
    resetNotificationSettingForTests();
    expect(getNotificationSetting().events).toEqual(["needs-you", "failed"]);
  });

  test.each(["finished;failed", "sometimes", "needs-you,,ended", "on"])(
    "a stored list that cannot be read, %j, is the default",
    (stored) => {
      localStorage.setItem(NOTIFICATION_EVENTS_STORAGE_KEY, stored);
      expect(getNotificationSetting().events).toEqual(["needs-you"]);
    },
  );

  test("the events are kept while notifications are off, and are in force only while they are on", async () => {
    chooseNotificationEvent("finished", true);
    expect(getNotificationSetting()).toMatchObject({
      on: false,
      events: ["needs-you", "finished"],
    });
    expect(notificationEventsInForce()).toEqual([]);

    host.state = "granted";
    await turnOnNotifications();
    expect(notificationEventsInForce()).toEqual(["needs-you", "finished"]);

    turnOffNotifications();
    expect(notificationEventsInForce()).toEqual([]);
    expect(getNotificationSetting().events).toEqual(["needs-you", "finished"]);
  });

  test("a choice made in another tab at this address is followed, and the same list again is no change", () => {
    const listener = vi.fn();
    const stop = subscribeToNotificationSetting(listener);
    const before = getNotificationSetting();

    localStorage.setItem(NOTIFICATION_EVENTS_STORAGE_KEY, "needs-you");
    window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATION_EVENTS_STORAGE_KEY }));
    expect(getNotificationSetting()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    localStorage.setItem(NOTIFICATION_EVENTS_STORAGE_KEY, "failed,ended");
    window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATION_EVENTS_STORAGE_KEY }));
    expect(getNotificationSetting().events).toEqual(["failed", "ended"]);
    expect(listener).toHaveBeenCalledTimes(1);

    // Storage cleared altogether: back to the default.
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(getNotificationSetting().events).toEqual(["needs-you"]);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  test("when storage is blocked the choice still holds until the page is closed", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked.", "SecurityError");
    });
    onTestFinished(() => write.mockRestore());

    expect(() => chooseNotificationEvent("ended", true)).not.toThrow();
    expect(getNotificationSetting().events).toEqual(["needs-you", "ended"]);
  });
});
