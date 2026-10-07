import { describe, expect, test } from "vitest";

import {
  pushoverProblemLine,
  readPushoverSetup,
  type PushoverSettings,
} from "@collector/pushover/pushoverSettings";

const TOKEN = "atest0000000000000000000000000";
const USER = "utest0000000000000000000000000";

function read(env: Record<string, string>) {
  const setup = readPushoverSetup(env);
  return setup.on ? setup.settings : setup.problem;
}

describe("readPushoverSetup", () => {
  test("with neither key set, Pushover is off and there is nothing to say, whatever else is set", () => {
    expect(readPushoverSetup({})).toEqual({ on: false, problem: null });
    expect(
      readPushoverSetup({ AGENT_LOOKOUT_PUSHOVER_ASKING: "on", AGENT_LOOKOUT_PUSHOVER_AFTER: "0" }),
    ).toEqual({ on: false, problem: null });
  });

  test("with one key alone, it is off, and the missing one is named", () => {
    expect(read({ AGENT_LOOKOUT_PUSHOVER_TOKEN: TOKEN })).toBe(
      "AGENT_LOOKOUT_PUSHOVER_USER is not set.",
    );
    expect(read({ AGENT_LOOKOUT_PUSHOVER_USER: USER })).toBe(
      "AGENT_LOOKOUT_PUSHOVER_TOKEN is not set.",
    );
  });

  test("with both, it is on, with the rest as left out unless set under Pushover's own names", () => {
    expect(
      read({ AGENT_LOOKOUT_PUSHOVER_TOKEN: TOKEN, AGENT_LOOKOUT_PUSHOVER_USER: USER }),
    ).toEqual({
      token: TOKEN,
      user: USER,
      events: ["needs-you"],
      afterMs: 60_000,
      asking: false,
    } satisfies PushoverSettings);
    expect(
      read({
        AGENT_LOOKOUT_PUSHOVER_TOKEN: TOKEN,
        AGENT_LOOKOUT_PUSHOVER_USER: USER,
        AGENT_LOOKOUT_PUSHOVER_EVENTS: "needs-you,ended",
        AGENT_LOOKOUT_PUSHOVER_AFTER: "120",
        AGENT_LOOKOUT_PUSHOVER_ASKING: "on",
        AGENT_LOOKOUT_NTFY_ASKING: "off",
      }),
    ).toMatchObject({ events: ["needs-you", "ended"], afterMs: 120_000, asking: true });
  });

  test.each([
    [
      "AGENT_LOOKOUT_PUSHOVER_TOKEN",
      "too-short",
      USER,
      "the API token of your Pushover application: 30 letters and digits.",
    ],
    [
      "AGENT_LOOKOUT_PUSHOVER_TOKEN",
      `${TOKEN.slice(0, 29)}!`,
      USER,
      "the API token of your Pushover application: 30 letters and digits.",
    ],
    [
      "AGENT_LOOKOUT_PUSHOVER_USER",
      TOKEN,
      `${USER}x`,
      "your Pushover user key, or a group key: 30 letters and digits.",
    ],
  ])("%s that is not a key is refused, and never repeated", (name, token, user, said) => {
    const problem = read({
      AGENT_LOOKOUT_PUSHOVER_TOKEN: token,
      AGENT_LOOKOUT_PUSHOVER_USER: user,
    });
    expect(problem).toBe(`${name} must be ${said}`);
    for (const secret of [TOKEN, USER, "too-short"]) expect(problem).not.toContain(secret);
  });

  test("a setting of the others that cannot be read turns Pushover off, and is named", () => {
    expect(
      read({
        AGENT_LOOKOUT_PUSHOVER_TOKEN: TOKEN,
        AGENT_LOOKOUT_PUSHOVER_USER: USER,
        AGENT_LOOKOUT_PUSHOVER_ASKING: "1",
      }),
    ).toBe("AGENT_LOOKOUT_PUSHOVER_ASKING must be on or off.");
  });

  test("the line printed at start names Pushover and the problem", () => {
    expect(pushoverProblemLine("AGENT_LOOKOUT_PUSHOVER_USER is not set.")).toBe(
      "Pushover pushes are off: AGENT_LOOKOUT_PUSHOVER_USER is not set.",
    );
  });
});
