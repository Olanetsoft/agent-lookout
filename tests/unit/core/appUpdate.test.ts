import { describe, expect, test } from "vitest";

import {
  APP_UPDATE_ACTIONS,
  APP_UPDATE_CHECK_PATH,
  APP_UPDATE_INSTALL_PATH,
  APP_UPDATE_PATH,
  APP_UPDATE_SETTING_PATH,
  INSTALL_REFUSAL_WORDS,
  isAppApiPath,
  UPDATES_HASH,
} from "@core/appUpdate";

describe("the routes only the Mac app answers", () => {
  test("are under /api/app, so a host that does not answer them hands them to the collector", () => {
    for (const path of [
      APP_UPDATE_PATH,
      APP_UPDATE_CHECK_PATH,
      APP_UPDATE_INSTALL_PATH,
      APP_UPDATE_SETTING_PATH,
    ]) {
      expect(isAppApiPath(path), path).toBe(true);
      expect(path.startsWith("/api/"), path).toBe(true);
    }
    expect(isAppApiPath("/api/application")).toBe(false);
    expect(isAppApiPath("/api/sessions")).toBe(false);
    expect(isAppApiPath("/app/update")).toBe(false);
  });

  test("each POST has an action of its own, and none is the jump's", () => {
    const actions = Object.values(APP_UPDATE_ACTIONS);
    expect(new Set(actions).size).toBe(3);
    expect(actions).not.toContain("jump");
  });

  test("Settings' Updates card has an address of its own", () => {
    expect(UPDATES_HASH).toBe("#settings/updates");
  });

  test("every place the app cannot update itself from says what to do", () => {
    for (const [refusal, words] of Object.entries(INSTALL_REFUSAL_WORDS)) {
      expect(words, refusal).toMatch(/\.$/);
    }
    for (const refusal of ["translocated", "disk-image", "read-only"] as const) {
      expect(INSTALL_REFUSAL_WORDS[refusal]).toContain("Applications folder");
    }
  });
});
