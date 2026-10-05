import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  notificationHost,
  setNotificationHost,
} from "@dashboard/lib/notifications/notificationHost";
import {
  fakeNotificationHost,
  installStubNotification,
  StubNotification,
} from "@tests/support/notifications";

// Runs in the component project because the default host wraps the page's own
// `window.Notification`. That is replaced here with `StubNotification`, so no
// test asks this browser for permission or shows anything on this machine.

let restoreNotification: () => void;

beforeEach(() => {
  restoreNotification = installStubNotification();
});

afterEach(() => {
  setNotificationHost();
  vi.restoreAllMocks();
  restoreNotification();
});

test.each([
  ["granted", "granted"],
  ["denied", "denied"],
  ["default", "default"],
  // Anything a browser might say that is not a yes or a no has not been decided.
  ["prompt", "default"],
] as const)("the browser's permission %s is reported as %s", (permission, reported) => {
  StubNotification.permission = permission;

  expect(notificationHost().permission()).toBe(reported);
  // Reading it asks nobody.
  expect(StubNotification.asked).toBe(0);
});

test("a browser with no Notifications API is unsupported: it is never asked and shows nothing", async () => {
  Reflect.deleteProperty(window, "Notification");
  expect("Notification" in window).toBe(false);
  const host = notificationHost();

  expect(host.permission()).toBe("unsupported");
  await expect(host.requestPermission()).resolves.toBe("unsupported");
  expect(host.show({ title: "demo-project", body: "Waiting for you", tag: "demo" })).toBeNull();
});

test("asking for permission asks the browser once and answers with what the person chose", async () => {
  StubNotification.answer = "denied";

  await expect(notificationHost().requestPermission()).resolves.toBe("denied");

  expect(StubNotification.asked).toBe(1);
  expect(notificationHost().permission()).toBe("denied");
});

test("an older browser that answers through a callback and returns nothing is understood", async () => {
  const callbackOnly = ((answered?: (permission: string) => void) => {
    setTimeout(() => {
      StubNotification.permission = "granted";
      answered?.("granted");
    }, 0);
    return undefined;
  }) as unknown as typeof StubNotification.requestPermission;
  const old = vi.spyOn(StubNotification, "requestPermission").mockImplementation(callbackOnly);

  await expect(notificationHost().requestPermission()).resolves.toBe("granted");

  expect(old).toHaveBeenCalledTimes(1);
});

test("a browser that throws when asked answers with the permission as it stands", async () => {
  vi.spyOn(StubNotification, "requestPermission").mockImplementation(() => {
    throw new Error("Not from a click.");
  });

  await expect(notificationHost().requestPermission()).resolves.toBe("default");
});

test("a browser whose question fails still answers, with the permission as it stands", async () => {
  vi.spyOn(StubNotification, "requestPermission").mockImplementation(() => {
    // It failed, and the person had blocked the address meanwhile.
    StubNotification.permission = "denied";
    return Promise.reject(new Error("The question could not be asked."));
  });

  await expect(notificationHost().requestPermission()).resolves.toBe("denied");
});

test("the answer is the browser's permission afterwards, not the word the question came back with", async () => {
  // A browser that says yes to the question and still does not allow the address.
  vi.spyOn(StubNotification, "requestPermission").mockImplementation(() =>
    Promise.resolve("granted"),
  );

  await expect(notificationHost().requestPermission()).resolves.toBe("default");
  expect(notificationHost().permission()).toBe("default");
});

test("showing one passes the title, the body and the tag through, and sets no icon", () => {
  StubNotification.permission = "granted";

  const shown = notificationHost().show({
    title: "demo-project",
    body: "Waiting for permission",
    tag: "agent-lookout:claude-code:00000000-0000-4000-8000-000000000001",
  });

  expect(shown).not.toBeNull();
  expect(StubNotification.made).toHaveLength(1);
  expect(StubNotification.made[0]?.title).toBe("demo-project");
  // Nothing else is set: no icon, no image, no sound, no request to stay on screen.
  expect(StubNotification.made[0]?.options).toEqual({
    body: "Waiting for permission",
    tag: "agent-lookout:claude-code:00000000-0000-4000-8000-000000000001",
  });
});

test("a browser that refuses to make one gives null and does not throw", () => {
  StubNotification.permission = "granted";
  StubNotification.refuses = true;

  expect(
    notificationHost().show({ title: "demo-project", body: "Waiting for you", tag: "demo" }),
  ).toBeNull();
});

test("a click on a notification brings the dashboard's window forward", () => {
  const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
  notificationHost().show({ title: "demo-project", body: "Waiting for you", tag: "demo" });

  StubNotification.made[0]?.dispatchEvent(new Event("click"));

  expect(focus).toHaveBeenCalledTimes(1);
});

test("closing one closes it in the browser, and its going is heard, whoever closed it", () => {
  const host = notificationHost();
  const first = host.show({ title: "demo-project", body: "Waiting for you", tag: "demo-1" });
  const second = host.show({ title: "demo-project", body: "Waiting for you", tag: "demo-2" });
  const firstGone = vi.fn();
  const secondGone = vi.fn();
  first?.onClosed(firstGone);
  second?.onClosed(secondGone);

  // The page takes the first down.
  first?.close();
  expect(StubNotification.made[0]?.closes).toBe(1);
  expect(firstGone).toHaveBeenCalledTimes(1);
  expect(secondGone).not.toHaveBeenCalled();

  // The person dismisses the second.
  StubNotification.made[1]?.dispatchEvent(new Event("close"));
  expect(StubNotification.made[1]?.closes).toBe(0);
  expect(secondGone).toHaveBeenCalledTimes(1);
});

test("a close that throws in the browser is swallowed", () => {
  const shown = notificationHost().show({
    title: "demo-project",
    body: "Waiting for you",
    tag: "demo",
  });
  vi.spyOn(StubNotification.made[0] as StubNotification, "close").mockImplementation(() => {
    throw new Error("Already gone.");
  });

  expect(() => shown?.close()).not.toThrow();
});

test("another host takes the browser's place, and calling with nothing puts the browser's back", () => {
  const browser = notificationHost();
  const fake = fakeNotificationHost({ permission: "granted" });

  setNotificationHost(fake);
  expect(notificationHost()).toBe(fake);
  notificationHost().show({ title: "demo-project", body: "Waiting for you", tag: "demo" });
  expect(fake.shown).toHaveLength(1);
  expect(StubNotification.made).toEqual([]);

  setNotificationHost();
  expect(notificationHost()).toBe(browser);
  expect(notificationHost().permission()).toBe("default");
});
