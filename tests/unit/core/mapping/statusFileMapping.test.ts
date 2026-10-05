import { expect, test } from "vitest";

import { mapStatusFileStatus } from "@core/mapping/statusFileMapping";

test("each status in the format maps to the session status of the same meaning", () => {
  expect(mapStatusFileStatus({ status: "working" })).toEqual({ status: "working" });
  expect(mapStatusFileStatus({ status: "idle" })).toEqual({ status: "idle" });
  expect(mapStatusFileStatus({ status: "finished" })).toEqual({ status: "finished" });
  expect(mapStatusFileStatus({ status: "failed" })).toEqual({ status: "failed" });
  expect(mapStatusFileStatus({ status: "waiting" })).toEqual({
    status: "needs-you",
    waitingReason: "other",
  });
});

test("a waiting session says why when the file does, and is waiting for you otherwise", () => {
  expect(mapStatusFileStatus({ status: "waiting", reason: "permission" })).toEqual({
    status: "needs-you",
    waitingReason: "permission",
  });
  expect(mapStatusFileStatus({ status: "waiting", reason: "question" })).toEqual({
    status: "needs-you",
    waitingReason: "question",
  });
  for (const reason of ["approval", "", 3, null, undefined]) {
    expect(mapStatusFileStatus({ status: "waiting", reason })).toEqual({
      status: "needs-you",
      waitingReason: "other",
    });
  }
});

test("a reason is kept only while waiting", () => {
  expect(mapStatusFileStatus({ status: "working", reason: "permission" })).toEqual({
    status: "working",
  });
  expect(mapStatusFileStatus({ status: "idle", reason: "question" })).toEqual({ status: "idle" });
});

test("a status the format does not have is unknown, not a guess", () => {
  for (const status of ["busy", "paused", "Working", "needs-you", "", 1, null, undefined]) {
    expect(mapStatusFileStatus({ status })).toEqual({ status: "unknown" });
  }
});
