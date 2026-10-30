import { describe, expect, test } from "vitest";

import {
  DEFAULT_KEEP_AWAKE_SETTINGS,
  KEEP_AWAKE_SETTINGS_FILE,
  readKeepAwakeSettings,
  writeKeepAwakeSettings,
} from "@desktop/keep-awake/keepAwakeSettings";

describe("the keep-awake settings file", () => {
  test("is keep-awake-state.json, and has the switch off until it is turned on", () => {
    expect(KEEP_AWAKE_SETTINGS_FILE).toBe("keep-awake-state.json");
    expect(DEFAULT_KEEP_AWAKE_SETTINGS).toEqual({ on: false });
  });

  test("reads back what it wrote", () => {
    expect(readKeepAwakeSettings(writeKeepAwakeSettings({ on: true }))).toEqual({ on: true });
    expect(readKeepAwakeSettings(writeKeepAwakeSettings({ on: false }))).toEqual({ on: false });
    expect(writeKeepAwakeSettings({ on: true })).toBe('{\n  "on": true\n}\n');
  });

  test.each([null, undefined, "", "{", "[]", "null", '"on"', "true"])(
    "gives the default for a file that is missing or cannot be read: %j",
    (text) => {
      expect(readKeepAwakeSettings(text)).toEqual(DEFAULT_KEEP_AWAKE_SETTINGS);
    },
  );

  test("keeps the switch on only when it says true, and keeps nothing else", () => {
    expect(readKeepAwakeSettings('{"on": true}')).toEqual({ on: true });
    expect(readKeepAwakeSettings('{"on": "true"}')).toEqual({ on: false });
    expect(readKeepAwakeSettings('{"on": 1}')).toEqual({ on: false });
    expect(readKeepAwakeSettings("{}")).toEqual({ on: false });
    expect(readKeepAwakeSettings('{"on": true, "extra": 1}')).toEqual({ on: true });
  });
});
