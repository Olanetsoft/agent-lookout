import path from "node:path";

import { expect, test } from "vitest";

import { grokBuildHome, grokBuildHomeFor } from "@collector/adapters/grok-build/home";
import { GROK_HOME, HOME } from "@tests/fixtures/grok-build/grokBuild";
import { asWritten } from "@tests/support/paths";

/** The home as the tests write it, whatever system resolved it. */
const homeOf = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") => {
  const home = grokBuildHome(env, HOME, platform);
  return { ...home, home: asWritten(home.home) };
};

test("Agent Lookout's own setting comes first, trimmed", () => {
  expect(
    homeOf({ AGENT_LOOKOUT_GROK_HOME: " /tmp/grok-elsewhere ", GROK_HOME: "/Users/example/g" }),
  ).toEqual({ home: "/tmp/grok-elsewhere", named: true, fromGrokHome: false, passedOver: false });
});

test("then Grok Build's own GROK_HOME, when it is a whole path", () => {
  expect(homeOf({ GROK_HOME: "/Users/example/grok-home" })).toEqual({
    home: "/Users/example/grok-home",
    named: false,
    fromGrokHome: true,
    passedOver: false,
  });
});

test("then ~/.grok", () => {
  expect(homeOf({})).toEqual({
    home: GROK_HOME,
    named: false,
    fromGrokHome: false,
    passedOver: false,
  });
  expect(asWritten(grokBuildHomeFor({}, HOME, "darwin"))).toBe(GROK_HOME);
});

test("an empty GROK_HOME is not set, as Grok Build takes it", () => {
  expect(homeOf({ GROK_HOME: "" })).toMatchObject({ home: GROK_HOME, passedOver: false });
  expect(homeOf({ AGENT_LOOKOUT_GROK_HOME: "  " })).toMatchObject({
    home: GROK_HOME,
    named: false,
  });
});

test("a GROK_HOME that is not a whole path, ~ among them, is passed over, and said", () => {
  for (const value of ["grok", "./grok", "~", "~/grok", " /Users/example/grok"]) {
    expect(homeOf({ GROK_HOME: value }), value).toEqual({
      home: GROK_HOME,
      named: false,
      fromGrokHome: false,
      passedOver: true,
    });
  }
});

test("GROK_HOME is judged by the system's own rules, as it is written", () => {
  const windows = grokBuildHome({ GROK_HOME: "D:\\grok" }, HOME, "win32");
  expect(windows).toMatchObject({ fromGrokHome: true, passedOver: false });
  expect(grokBuildHome({ GROK_HOME: "D:\\grok" }, HOME, "darwin")).toMatchObject({
    passedOver: true,
  });
  expect(grokBuildHome({ GROK_HOME: "/Users/example/g" }, HOME, "win32").home).toBe(
    path.resolve("/Users/example/g"),
  );
});
