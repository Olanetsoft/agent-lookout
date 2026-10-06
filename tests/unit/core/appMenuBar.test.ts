import { expect, test } from "vitest";

import { APP_UPDATE_ACTIONS, isAppApiPath } from "@core/appUpdate";
import {
  APP_MENU_BAR_ACTION,
  APP_MENU_BAR_PATH,
  APP_MENU_BAR_SETTING_PATH,
  isMenuBarPath,
} from "@core/appMenuBar";

test("the menu bar's routes are among those only the Mac app answers", () => {
  for (const path of [APP_MENU_BAR_PATH, APP_MENU_BAR_SETTING_PATH]) {
    expect(isAppApiPath(path), path).toBe(true);
    expect(isMenuBarPath(path), path).toBe(true);
  }
  expect(isMenuBarPath("/api/app/menu-barn")).toBe(false);
  expect(isMenuBarPath("/api/app/update")).toBe(false);
  expect(isMenuBarPath("/api/menu-bar")).toBe(false);
});

test("its POST has an action of its own", () => {
  expect(APP_MENU_BAR_ACTION).toBe("menu-bar-setting");
  expect(Object.values(APP_UPDATE_ACTIONS)).not.toContain(APP_MENU_BAR_ACTION);
  expect(APP_MENU_BAR_ACTION).not.toBe("jump");
});
