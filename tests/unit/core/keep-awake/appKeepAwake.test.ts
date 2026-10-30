import { expect, test } from "vitest";

import {
  APP_MENU_BAR_ACTION,
  APP_MENU_BAR_PATH,
  APP_MENU_BAR_SETTING_PATH,
} from "@core/appMenuBar";
import { APP_UPDATE_ACTIONS, isAppApiPath } from "@core/appUpdate";
import {
  APP_KEEP_AWAKE_ACTION,
  APP_KEEP_AWAKE_PATH,
  APP_KEEP_AWAKE_SETTING_PATH,
  isKeepAwakePath,
} from "@core/keep-awake/appKeepAwake";

test("the keep-awake routes are among those only the Mac app answers", () => {
  expect(APP_KEEP_AWAKE_PATH).toBe("/api/app/keep-awake");
  expect(APP_KEEP_AWAKE_SETTING_PATH).toBe("/api/app/keep-awake/setting");
  for (const path of [APP_KEEP_AWAKE_PATH, APP_KEEP_AWAKE_SETTING_PATH]) {
    expect(isAppApiPath(path), path).toBe(true);
    expect(isKeepAwakePath(path), path).toBe(true);
  }
  expect(isKeepAwakePath("/api/app/keep-awake/other")).toBe(true);
  expect(isKeepAwakePath("/api/app/keep-awake-x")).toBe(false);
  expect(isKeepAwakePath("/api/keep-awake")).toBe(false);
  expect(isKeepAwakePath(APP_MENU_BAR_PATH)).toBe(false);
  expect(isKeepAwakePath(APP_MENU_BAR_SETTING_PATH)).toBe(false);
});

test("its POST has an action of its own", () => {
  expect(APP_KEEP_AWAKE_ACTION).toBe("keep-awake-setting");
  expect(Object.values(APP_UPDATE_ACTIONS)).not.toContain(APP_KEEP_AWAKE_ACTION);
  expect(APP_KEEP_AWAKE_ACTION).not.toBe(APP_MENU_BAR_ACTION);
  expect(APP_KEEP_AWAKE_ACTION).not.toBe("jump");
});
