import { describe, expect, test } from "vitest";

import { isOpenClineStatus, mapClineStatus } from "@core/mapping/cline/clineMapping";

describe("mapClineStatus", () => {
  test.each([
    ["running", true, { status: "working" }],
    ["idle", true, { status: "idle" }],
    ["pending", true, { status: "needs-you", waitingReason: "permission" }],
  ])("%s with its process running", (status, processRuns, expected) => {
    expect(mapClineStatus({ status, processRuns })).toEqual(expected);
  });

  test.each(["running", "idle", "pending"])("%s whose process has gone is finished", (status) => {
    expect(mapClineStatus({ status, processRuns: false })).toEqual({ status: "finished" });
  });

  test.each(["running", "idle", "pending"])(
    "%s with no process to ask about is not guessed at",
    (status) => {
      expect(mapClineStatus({ status, processRuns: null })).toEqual({ status: "unknown" });
    },
  );

  test.each([
    ["completed", "finished"],
    ["cancelled", "finished"],
    ["failed", "failed"],
  ])("%s holds whatever its process does", (status, expected) => {
    for (const processRuns of [true, false, null]) {
      expect(mapClineStatus({ status, processRuns })).toEqual({ status: expected });
    }
  });

  test.each([["archived"], ["RUNNING"], [""], [null]])("%s is unknown", (status) => {
    for (const processRuns of [true, false, null]) {
      expect(mapClineStatus({ status, processRuns })).toEqual({ status: "unknown" });
    }
  });
});

test("only the statuses of a session that is open ask after its process", () => {
  for (const status of ["running", "idle", "pending"]) {
    expect(isOpenClineStatus(status)).toBe(true);
  }
  for (const status of ["completed", "cancelled", "failed", "archived", "", null]) {
    expect(isOpenClineStatus(status)).toBe(false);
  }
});
