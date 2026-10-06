import { describe, expect, test } from "vitest";

import {
  PULL_REQUESTS_ENV,
  pullRequestsOffStatus,
  pullRequestsProblemLine,
  readPullRequestsSetup,
} from "@collector/github/pullRequestSettings";

describe("AGENT_LOOKOUT_PULL_REQUESTS", () => {
  test("is named as the other settings are", () => {
    expect(PULL_REQUESTS_ENV).toBe("AGENT_LOOKOUT_PULL_REQUESTS");
  });

  test("is off unless set, and off when set to off, with nothing to say", () => {
    expect(readPullRequestsSetup({})).toEqual({ on: false, problem: null });
    expect(readPullRequestsSetup({ [PULL_REQUESTS_ENV]: "" })).toEqual({
      on: false,
      problem: null,
    });
    expect(readPullRequestsSetup({ [PULL_REQUESTS_ENV]: "  " })).toEqual({
      on: false,
      problem: null,
    });
    expect(readPullRequestsSetup({ [PULL_REQUESTS_ENV]: "off" })).toEqual({
      on: false,
      problem: null,
    });
    expect(readPullRequestsSetup({ [PULL_REQUESTS_ENV]: " OFF " })).toEqual({
      on: false,
      problem: null,
    });
  });

  test("is on with on, whatever its case", () => {
    expect(readPullRequestsSetup({ [PULL_REQUESTS_ENV]: "on" })).toEqual({ on: true });
    expect(readPullRequestsSetup({ [PULL_REQUESTS_ENV]: " On\n" })).toEqual({ on: true });
  });

  test.each(["yes", "true", "1", "onn", "on,off"])(
    "any other value, %s, leaves it off with one line that names the setting",
    (value) => {
      const setup = readPullRequestsSetup({ [PULL_REQUESTS_ENV]: value });
      expect(setup).toEqual({
        on: false,
        problem: "AGENT_LOOKOUT_PULL_REQUESTS must be on or off.",
      });
      if (setup.on || setup.problem === null) throw new Error("Expected a problem.");
      expect(pullRequestsProblemLine(setup.problem)).toBe(
        "Pull requests are off: AGENT_LOOKOUT_PULL_REQUESTS must be on or off.",
      );
    },
  );

  test("while off, the status says off, with no gh and no last check", () => {
    expect(pullRequestsOffStatus(null)).toEqual({ on: false, problem: null, gh: null, last: null });
  });
});
