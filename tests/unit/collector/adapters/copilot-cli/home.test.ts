import path from "node:path";

import { expect, test } from "vitest";

import { copilotCliHome, copilotCliSessionsDirFor } from "@collector/adapters/copilot-cli/home";

const HOME = path.resolve("/Users/example");

test("with nothing set, it is .copilot in the home folder, with session-state in it", () => {
  expect(copilotCliHome({}, HOME, process.platform)).toEqual({
    home: path.join(HOME, ".copilot"),
    sessionsDir: path.join(HOME, ".copilot", "session-state"),
    named: false,
    fromCopilotHome: false,
    passedOver: false,
  });
  expect(copilotCliSessionsDirFor({}, HOME)).toBe(path.join(HOME, ".copilot", "session-state"));
});

test("AGENT_LOOKOUT_COPILOT_HOME, trimmed, wins over COPILOT_HOME", () => {
  const own = path.resolve("/tmp/copilot-here");
  expect(
    copilotCliHome(
      { AGENT_LOOKOUT_COPILOT_HOME: ` ${own} `, COPILOT_HOME: path.resolve("/tmp/other") },
      HOME,
      process.platform,
    ),
  ).toMatchObject({ home: own, sessionsDir: path.join(own, "session-state"), named: true });
  // An empty one counts as not set.
  expect(
    copilotCliHome({ AGENT_LOOKOUT_COPILOT_HOME: "  " }, HOME, process.platform),
  ).toMatchObject({ home: path.join(HOME, ".copilot"), named: false });
});

test("COPILOT_HOME counts when it is a whole path, as it is", () => {
  const set = path.resolve("/srv/copilot");
  expect(copilotCliHome({ COPILOT_HOME: set }, HOME, process.platform)).toEqual({
    home: set,
    sessionsDir: path.join(set, "session-state"),
    named: false,
    fromCopilotHome: true,
    passedOver: false,
  });
});

test("a COPILOT_HOME that is not a whole path is passed over, and said to be", () => {
  for (const value of ["copilot", "~/.copilot", " /tmp/copilot", "./here"]) {
    expect(copilotCliHome({ COPILOT_HOME: value }, HOME, "linux"), value).toEqual({
      home: path.join(HOME, ".copilot"),
      sessionsDir: path.join(HOME, ".copilot", "session-state"),
      named: false,
      fromCopilotHome: false,
      passedOver: true,
    });
  }
  // An empty one is not set.
  expect(copilotCliHome({ COPILOT_HOME: "" }, HOME, "linux").passedOver).toBe(false);
});

test("whether COPILOT_HOME is a whole path is judged on the system's rules", () => {
  expect(
    copilotCliHome({ COPILOT_HOME: "C:\\Users\\example\\.copilot" }, HOME, "win32"),
  ).toMatchObject({
    fromCopilotHome: true,
  });
  expect(
    copilotCliHome({ COPILOT_HOME: "C:\\Users\\example\\.copilot" }, HOME, "linux"),
  ).toMatchObject({
    passedOver: true,
  });
});
