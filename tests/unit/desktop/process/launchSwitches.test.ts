import { expect, test } from "vitest";

import { DEBUGGING_SWITCHES, refusedSwitch } from "@desktop/process/launchSwitches";

/** A command line that has these switches. */
const startedWith =
  (...switches: string[]) =>
  (name: string) =>
    switches.includes(name);

test("the packaged app refuses each switch that opens its page to another program", () => {
  expect(DEBUGGING_SWITCHES).toEqual(["remote-debugging-port", "remote-debugging-pipe"]);
  for (const name of DEBUGGING_SWITCHES) {
    expect(refusedSwitch(startedWith(name), true), name).toBe(name);
  }
  expect(refusedSwitch(startedWith("lang", "remote-debugging-pipe"), true)).toBe(
    "remote-debugging-pipe",
  );
});

test("it starts with any other switch, or none", () => {
  expect(refusedSwitch(startedWith(), true)).toBeNull();
  expect(refusedSwitch(startedWith("lang", "disable-gpu"), true)).toBeNull();
});

test("a development run keeps them, for the developer tools", () => {
  expect(refusedSwitch(startedWith("remote-debugging-port"), false)).toBeNull();
});
