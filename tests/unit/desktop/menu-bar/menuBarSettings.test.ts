import { describe, expect, test } from "vitest";

import {
  DEFAULT_MENU_BAR_SETTINGS,
  MENU_BAR_SETTINGS_FILE,
  readMenuBarSettings,
  writeMenuBarSettings,
} from "@desktop/menu-bar/menuBarSettings";

describe("the menu bar's settings file", () => {
  test("is menu-bar-state.json, and has the item shown until it is turned off", () => {
    expect(MENU_BAR_SETTINGS_FILE).toBe("menu-bar-state.json");
    expect(DEFAULT_MENU_BAR_SETTINGS).toEqual({ show: true });
  });

  test("reads back what it wrote", () => {
    expect(readMenuBarSettings(writeMenuBarSettings({ show: false }))).toEqual({ show: false });
    expect(readMenuBarSettings(writeMenuBarSettings({ show: true }))).toEqual({ show: true });
    expect(writeMenuBarSettings({ show: false })).toBe('{\n  "show": false\n}\n');
  });

  test.each([null, undefined, "", "{", "[]", "null", '"off"', "false"])(
    "gives the default for a file that is missing or cannot be read: %j",
    (text) => {
      expect(readMenuBarSettings(text)).toEqual(DEFAULT_MENU_BAR_SETTINGS);
    },
  );

  test("keeps the item hidden only when it says false, and keeps nothing else", () => {
    expect(readMenuBarSettings('{"show": false}')).toEqual({ show: false });
    expect(readMenuBarSettings('{"show": "false"}')).toEqual({ show: true });
    expect(readMenuBarSettings('{"show": 0}')).toEqual({ show: true });
    expect(readMenuBarSettings("{}")).toEqual({ show: true });
    expect(readMenuBarSettings('{"show": false, "extra": 1}')).toEqual({ show: false });
  });
});
