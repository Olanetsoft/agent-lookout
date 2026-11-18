import path from "node:path";

import { expect, test } from "vitest";

import {
  deepseekHarnessHome,
  deepseekHarnessSessionsDirFor,
} from "@collector/adapters/deepseek-harness/home";
import { HOME } from "@tests/fixtures/deepseek-harness/deepseekHarness";
import { asWritten } from "@tests/support/paths";

const home = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") => {
  const found = deepseekHarnessHome(env, HOME, platform);
  return { ...found, sessionsDir: asWritten(found.sessionsDir) };
};

test("with nothing set, it is ~/.dsh/sessions", () => {
  expect(home({})).toEqual({
    sessionsDir: `${HOME}/.dsh/sessions`,
    named: false,
    relativeHome: false,
  });
  expect(asWritten(deepseekHarnessSessionsDirFor({}, HOME, "linux"))).toBe(`${HOME}/.dsh/sessions`);
});

test("AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME, trimmed, comes first, and names the folder for Agent Lookout alone", () => {
  expect(
    home({ AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: " /data/lookout ", DSH_HOME: "/data/dsh" }),
  ).toEqual({
    sessionsDir: "/data/lookout/sessions",
    named: true,
    relativeHome: false,
  });
  expect(home({ AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: "  " }).named).toBe(false);
});

test("DSH_HOME comes next, untrimmed, with ~ for the home folder", () => {
  expect(home({ DSH_HOME: "/data/dsh" }).sessionsDir).toBe("/data/dsh/sessions");
  expect(home({ DSH_HOME: "/data/my dsh " }).sessionsDir).toBe(
    asWritten(path.resolve("/data/my dsh ", "sessions")),
  );
  expect(home({ DSH_HOME: "~" }).sessionsDir).toBe(`${HOME}/sessions`);
  expect(home({ DSH_HOME: "~/elsewhere" }).sessionsDir).toBe(`${HOME}/elsewhere/sessions`);
  expect(home({ DSH_HOME: "~\\elsewhere" }).sessionsDir).toBe(`${HOME}/elsewhere/sessions`);
});

test.each(["darwin", "linux", "win32"] as const)(
  "with %s, a ~ in DSH_HOME is this computer's home folder, joined and judged by its rules",
  (platform) => {
    const read = (set: string) => home({ DSH_HOME: set }, platform).sessionsDir;
    expect(read("~")).toBe(`${HOME}/sessions`);
    expect(read("~/elsewhere")).toBe(`${HOME}/elsewhere/sessions`);
    expect(read("~\\elsewhere")).toBe(`${HOME}/elsewhere/sessions`);
  },
);

test("a DSH_HOME of spaces alone is not set, and one still not absolute is passed over", () => {
  expect(home({ DSH_HOME: "   " })).toEqual({
    sessionsDir: `${HOME}/.dsh/sessions`,
    named: false,
    relativeHome: false,
  });
  expect(home({ DSH_HOME: "relative/dsh" })).toEqual({
    sessionsDir: `${HOME}/.dsh/sessions`,
    named: false,
    relativeHome: true,
  });
  expect(home({ DSH_HOME: "~relative" }).relativeHome).toBe(true);
});

test("whether a DSH_HOME is absolute goes by the system's own rules", () => {
  expect(home({ DSH_HOME: "C:\\dsh" }, "win32").relativeHome).toBe(false);
  expect(home({ DSH_HOME: "C:\\dsh" }, "darwin").relativeHome).toBe(true);
});
