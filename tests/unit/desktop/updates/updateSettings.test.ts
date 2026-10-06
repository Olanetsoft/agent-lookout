import { describe, expect, test } from "vitest";

import {
  DEFAULT_UPDATE_SETTINGS,
  readUpdateSettings,
  UPDATE_SETTINGS_FILE,
  writeUpdateSettings,
} from "@desktop/updates/updateSettings";

describe("the update settings file", () => {
  test("is update-state.json, and has the automatic check on until it is turned off", () => {
    expect(UPDATE_SETTINGS_FILE).toBe("update-state.json");
    expect(DEFAULT_UPDATE_SETTINGS).toEqual({
      automatic: true,
      lastCheckedAt: null,
      notifiedVersion: null,
      installingVersion: null,
    });
  });

  test("reads back what it wrote", () => {
    const settings = {
      automatic: false,
      lastCheckedAt: 1_790_000_000_000,
      notifiedVersion: "0.2.1",
      installingVersion: "0.2.2",
    };
    expect(readUpdateSettings(writeUpdateSettings(settings))).toEqual(settings);
  });

  test.each([null, undefined, "", "{", "[]", "null", '"on"'])(
    "gives the defaults for a file that is missing or cannot be read: %j",
    (text) => {
      expect(readUpdateSettings(text)).toEqual(DEFAULT_UPDATE_SETTINGS);
    },
  );

  test("keeps the switch off only when it says false", () => {
    expect(readUpdateSettings('{"automatic": false}').automatic).toBe(false);
    expect(readUpdateSettings('{"automatic": "false"}').automatic).toBe(true);
    expect(readUpdateSettings('{"automatic": 0}').automatic).toBe(true);
    expect(readUpdateSettings("{}").automatic).toBe(true);
  });

  test("drops a time or a version that cannot be one", () => {
    expect(readUpdateSettings('{"lastCheckedAt": -5}').lastCheckedAt).toBeNull();
    expect(readUpdateSettings('{"lastCheckedAt": 1.5}').lastCheckedAt).toBeNull();
    expect(readUpdateSettings('{"lastCheckedAt": "yesterday"}').lastCheckedAt).toBeNull();
    expect(readUpdateSettings('{"notifiedVersion": "v0.2.1"}').notifiedVersion).toBeNull();
    expect(readUpdateSettings('{"notifiedVersion": 3}').notifiedVersion).toBeNull();
    expect(readUpdateSettings('{"installingVersion": "next"}').installingVersion).toBeNull();
  });
});
