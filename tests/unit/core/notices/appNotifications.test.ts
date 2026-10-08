import { expect, test } from "vitest";

import { PHONE_TEST_ACTION } from "@core/api";
import { APP_MENU_BAR_ACTION, isMenuBarPath } from "@core/appMenuBar";
import { APP_UPDATE_ACTIONS, isAppApiPath } from "@core/appUpdate";
import {
  APP_NOTIFICATIONS_PATH,
  APP_NOTIFICATIONS_TEST_ACTION,
  APP_NOTIFICATIONS_TEST_PATH,
  isNotificationsPath,
} from "@core/notices/appNotifications";

test("the notifications' routes are among those only the Mac app answers", () => {
  for (const path of [APP_NOTIFICATIONS_PATH, APP_NOTIFICATIONS_TEST_PATH]) {
    expect(isAppApiPath(path), path).toBe(true);
    expect(isNotificationsPath(path), path).toBe(true);
    expect(isMenuBarPath(path), path).toBe(false);
  }
  expect(isNotificationsPath("/api/app/notificationsx")).toBe(false);
  expect(isNotificationsPath("/api/app/update")).toBe(false);
  expect(isNotificationsPath("/api/notifications")).toBe(false);
});

test("the test has an action of its own", () => {
  expect(APP_NOTIFICATIONS_TEST_ACTION).toBe("notification-test");
  expect(Object.values(APP_UPDATE_ACTIONS)).not.toContain(APP_NOTIFICATIONS_TEST_ACTION);
  expect(APP_NOTIFICATIONS_TEST_ACTION).not.toBe(APP_MENU_BAR_ACTION);
  expect(APP_NOTIFICATIONS_TEST_ACTION).not.toBe(PHONE_TEST_ACTION);
});
