import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { timerBeat, workerBeat } from "@dashboard/lib/api/beat";

// The beat from a real worker is tested in the component project, in a real page.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("the timer beat ticks once every interval, and not before the first has passed", () => {
  const tick = vi.fn();
  const stop = timerBeat(tick, 2_000);

  expect(tick).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_999);
  expect(tick).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(tick).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(6_000);
  expect(tick).toHaveBeenCalledTimes(4);
  stop();
});

test("the timer beat stops when asked, and stopping it twice does no harm", () => {
  const tick = vi.fn();
  const stop = timerBeat(tick, 2_000);
  vi.advanceTimersByTime(2_000);

  stop();
  stop();
  vi.advanceTimersByTime(10_000);

  expect(tick).toHaveBeenCalledTimes(1);
});

test("two timer beats keep their own time", () => {
  const fast = vi.fn();
  const slow = vi.fn();
  const stopFast = timerBeat(fast, 1_000);
  const stopSlow = timerBeat(slow, 3_000);

  vi.advanceTimersByTime(3_000);
  stopFast();
  vi.advanceTimersByTime(3_000);

  expect(fast).toHaveBeenCalledTimes(3);
  expect(slow).toHaveBeenCalledTimes(2);
  stopSlow();
});

test("where there are no workers at all, the worker beat is the timer beat", () => {
  // Node has no Worker of the browser's kind, which is the case being tested.
  vi.stubGlobal("Worker", undefined);
  const tick = vi.fn();

  const stop = workerBeat(tick, 2_000);
  vi.advanceTimersByTime(4_000);
  expect(tick).toHaveBeenCalledTimes(2);

  stop();
  vi.advanceTimersByTime(4_000);
  expect(tick).toHaveBeenCalledTimes(2);
});
