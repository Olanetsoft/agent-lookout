import { describe, expect, test, vi } from "vitest";

import { createStopTargets, JOB_ID, stopOff } from "@collector/actions/stopTargets";

describe("stopOff", () => {
  test("AGENT_LOOKOUT_STOP=off, in any case and with spaces, takes Stop away", () => {
    expect(stopOff({ AGENT_LOOKOUT_STOP: "off" })).toBe(true);
    expect(stopOff({ AGENT_LOOKOUT_STOP: " OFF " })).toBe(true);
  });

  test("anything else leaves it", () => {
    for (const value of [undefined, "", "on", "no", "0", "false"]) {
      expect([value, stopOff({ AGENT_LOOKOUT_STOP: value })]).toEqual([value, false]);
    }
  });
});

describe("JOB_ID", () => {
  test("a job id as claude agents prints it is taken, and nothing that could read as an option", () => {
    for (const id of ["7c5dcf5d", "job-0001", "A1_b2-c3"])
      expect([id, JOB_ID.test(id)]).toEqual([id, true]);
    for (const id of [
      "",
      "abc",
      "-abcd",
      "--all",
      "7c5d cf5d",
      "7c5d;ls",
      "../x",
      "x".repeat(65),
    ]) {
      expect([id, JOB_ID.test(id)]).toEqual([id, false]);
    }
  });
});

describe("createStopTargets", () => {
  test("holds the last poll's targets, and passes on a request for the command to every listener", () => {
    const stops = createStopTargets();
    expect(stops.targetOf("claude-code:1")).toBeUndefined();

    const target = {
      how: "signal" as const,
      sessionId: "1",
      pid: 4241,
      procStart: "Tue Nov 14 22:13:20 2023",
      registryFile: "/Users/example/.claude/sessions/4241.json",
    };
    stops.set(new Map([["claude-code:1", target]]));
    expect(stops.targetOf("claude-code:1")).toBe(target);

    const heard = vi.fn();
    stops.onAskFeedSoon(heard);
    stops.askFeedSoon();
    expect(heard).toHaveBeenCalledOnce();
  });
});
