import { expect, test } from "vitest";

import { ANSWER_SETTLE_MS, settled } from "@core/answers/settle";

const SHOWN = 1_700_000_000_000;

test("a press is taken once the request has been shown a full second, and not before", () => {
  expect(ANSWER_SETTLE_MS).toBe(1_000);
  expect(settled(SHOWN, SHOWN)).toBe(false);
  expect(settled(SHOWN, SHOWN + ANSWER_SETTLE_MS - 1)).toBe(false);
  expect(settled(SHOWN, SHOWN + ANSWER_SETTLE_MS)).toBe(true);
});

test("a request not known to have been shown takes no press", () => {
  expect(settled(null, SHOWN)).toBe(false);
});

test("one shown before the clock was set back takes a press, not none until the clock catches up", () => {
  expect(settled(SHOWN, SHOWN - 60 * 60_000)).toBe(true);
  expect(settled(SHOWN, SHOWN - ANSWER_SETTLE_MS + 1)).toBe(false);
});
