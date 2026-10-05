import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { NOTIFICATIONS_HEADER } from "@core/api";
import { apiRequest, setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { setNotificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
  NOTIFICATIONS_STORAGE_KEY,
  resetNotificationSettingForTests,
  turnOffNotifications,
  turnOnNotifications,
} from "@dashboard/lib/notifications/notificationSetting";
import { fakeNotificationHost, type FakeNotificationHost } from "@tests/support/notifications";

// Runs in the component project because what the page says depends on the
// choice in localStorage and on the browser's permission. Both the API and the
// notification system are stand-ins: nothing is requested and nobody is asked.

let notifications: FakeNotificationHost;
let api: ReturnType<typeof vi.fn<ApiHost>>;

/** What a request made now says of this page's notifications. */
async function said(path = "/api/sessions"): Promise<string | null> {
  await apiRequest(path);
  return new Headers(api.mock.lastCall?.[1]?.headers).get(NOTIFICATIONS_HEADER);
}

beforeEach(() => {
  notifications = fakeNotificationHost();
  setNotificationHost(notifications);
  api = vi.fn<ApiHost>(async () => new Response("{}"));
  setApiHost(api);
});

afterEach(() => {
  localStorage.clear();
  resetNotificationSettingForTests();
  setNotificationHost();
  setApiHost();
});

test("a page whose notifications were never turned on says off", async () => {
  expect(await said()).toBe("off");

  // Allowed by the browser, but not chosen here.
  notifications.state = "granted";
  expect(await said()).toBe("off");
});

test("a page with notifications chosen and allowed says on, on every route", async () => {
  notifications.state = "granted";
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");

  for (const path of ["/api/sessions", "/api/events?since=0", "/api/history", "/api/health"]) {
    expect([path, await said(path)]).toEqual([path, "on"]);
  }
});

test.each(["default", "denied", "unsupported"] as const)(
  "a page with notifications chosen but the browser's permission %s says off",
  async (permission) => {
    notifications.state = permission;
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");

    expect(await said()).toBe("off");
  },
);

test("turning them on and off in the page changes what its next request says", async () => {
  expect(await said()).toBe("off");

  await turnOnNotifications();
  expect(await said()).toBe("on");

  turnOffNotifications();
  expect(await said()).toBe("off");
});

test("a permission taken away in the browser's settings is said at the next request, with nothing to tell the page", async () => {
  notifications.state = "granted";
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
  expect(await said()).toBe("on");

  notifications.state = "denied";
  expect(await said()).toBe("off");
});

test("a request that is refused for naming another machine says nothing to anyone", async () => {
  notifications.state = "granted";
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");

  await expect(apiRequest("//example.com/api/sessions")).rejects.toThrow(TypeError);

  expect(api).not.toHaveBeenCalled();
});
