import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  MUSE_CODE_HOME_ENV,
  museCodeHome,
  museCodeSessionsDirFor,
} from "@collector/adapters/muse-code/home";
import { HOME, SESSIONS } from "@tests/fixtures/muse-code/museCode";
import { asWritten } from "@tests/support/paths";

const sessionsOf = (env: NodeJS.ProcessEnv) => asWritten(museCodeHome(env, HOME).sessionsDir);

describe("the sessions folder", () => {
  test("is ~/.local/share/muse/sessions by default, on every system", () => {
    expect(museCodeHome({}, HOME)).toEqual({
      sessionsDir: path.resolve(HOME, ".local", "share", "muse", "sessions"),
      named: false,
      set: false,
      xdgRelative: false,
    });
    expect(sessionsOf({})).toBe(SESSIONS);
  });

  test("is muse/sessions in XDG_DATA_HOME when that is an absolute folder, as given and not trimmed", () => {
    expect(museCodeHome({ XDG_DATA_HOME: "/data/xdg" }, HOME)).toMatchObject({
      named: false,
      set: true,
      xdgRelative: false,
    });
    expect(sessionsOf({ XDG_DATA_HOME: "/data/xdg" })).toBe("/data/xdg/muse/sessions");
    expect(sessionsOf({ XDG_DATA_HOME: "/data/xdg/" })).toBe("/data/xdg/muse/sessions");
  });

  test("passes over an XDG_DATA_HOME that is not absolute, and says so, and an empty one with nothing said", () => {
    for (const value of ["data", "./data", "~/data", " /data"]) {
      expect(museCodeHome({ XDG_DATA_HOME: value }, HOME), value).toMatchObject({
        set: false,
        xdgRelative: true,
      });
      expect(sessionsOf({ XDG_DATA_HOME: value }), value).toBe(SESSIONS);
    }
    expect(museCodeHome({ XDG_DATA_HOME: "" }, HOME)).toMatchObject({
      set: false,
      xdgRelative: false,
    });
  });

  test(`is sessions in the folder ${MUSE_CODE_HOME_ENV} names, trimmed, which wins over XDG_DATA_HOME`, () => {
    const env = { [MUSE_CODE_HOME_ENV]: "  /tmp/muse-home  ", XDG_DATA_HOME: "/data/xdg" };
    expect(museCodeHome(env, HOME)).toMatchObject({ named: true, set: true, xdgRelative: false });
    expect(sessionsOf(env)).toBe("/tmp/muse-home/sessions");
    expect(museCodeHome({ [MUSE_CODE_HOME_ENV]: "   " }, HOME).named).toBe(false);
  });

  test("never follows Muse Code's own settings or the variables no Meta source names", () => {
    for (const name of ["MUSE_DATA_DIR", "MUSE_HOME", "MUSE_SESSIONS_DIR", "XDG_CONFIG_HOME"]) {
      expect(sessionsOf({ [name]: "/elsewhere" }), name).toBe(SESSIONS);
    }
  });

  test("is the folder the fingerprint of what is read names", () => {
    const env = { XDG_DATA_HOME: "/data/xdg" };
    expect(museCodeSessionsDirFor(env, HOME)).toBe(museCodeHome(env, HOME).sessionsDir);
  });
});
