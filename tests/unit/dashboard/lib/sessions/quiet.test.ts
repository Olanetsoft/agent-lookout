import { expect, test } from "vitest";

import type { SessionStatus } from "@core/sessions/session";
import { QUIET_AFTER_MS, quietFor } from "@dashboard/lib/sessions/quiet";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_600_000;
const MINUTE = 60_000;

test("the threshold is 5 minutes", () => {
  expect(QUIET_AFTER_MS).toBe(5 * MINUTE);
});

test("a working session is quiet once its agent has written nothing for the threshold, and not before", () => {
  const quiet = (sinceMs: number) =>
    quietFor(makeSession({ status: "working", lastWriteAt: NOW - sinceMs }), NOW);
  expect(quiet(0)).toBeNull();
  expect(quiet(4 * MINUTE + 59_999)).toBeNull();
  expect(quiet(5 * MINUTE)).toBe(5 * MINUTE);
  expect(quiet(12 * MINUTE + 30_000)).toBe(12 * MINUTE + 30_000);
  expect(quiet(3 * 24 * 60 * MINUTE)).toBe(3 * 24 * 60 * MINUTE);
});

test("a last write ahead of the clock is not quiet", () => {
  expect(quietFor(makeSession({ status: "working", lastWriteAt: NOW + MINUTE }), NOW)).toBeNull();
});

test.each(["idle", "needs-you", "finished", "failed", "unknown"] as SessionStatus[])(
  "a session that is %s says nothing, however long its agent has been quiet",
  (status) => {
    expect(quietFor(makeSession({ status, lastWriteAt: NOW - 60 * MINUTE }), NOW)).toBeNull();
  },
);

test("a working session whose source gives no time of its last write says nothing", () => {
  expect(quietFor(makeSession({ status: "working", statusSince: NOW - 60 * MINUTE }), NOW)).toBe(
    null,
  );
});
