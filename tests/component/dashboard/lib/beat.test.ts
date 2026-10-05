import { afterEach, expect, onTestFinished, test, vi } from "vitest";

import { WORKER_PATIENCE_MS, workerBeat } from "@dashboard/lib/beat";

// Runs in the component project because the beat comes from a real Worker,
// which only a real page can make.

/** An interval nothing else in the test page uses, so the page's own timer can be told apart. */
const INTERVAL_MS = 37;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The calls that started a timer of the beat's interval on the page itself. */
function pageTimers(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter(([, ms]) => ms === INTERVAL_MS);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the worker beat ticks from a real worker, and not from the page's own timer", async () => {
  const pageTimer = vi.spyOn(window, "setInterval");
  const made = vi.spyOn(Worker.prototype, "postMessage");
  const tick = vi.fn();

  const stop = workerBeat(tick, INTERVAL_MS);
  await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(4), {
    timeout: 5_000,
  });
  stop();

  // The worker was told the interval, and the page started no timer of its own.
  expect(made.mock.calls).toEqual([[INTERVAL_MS]]);
  expect(pageTimers(pageTimer)).toEqual([]);
});

test("the worker keeps to the interval it was told: no beat comes early", async () => {
  const tick = vi.fn();
  const startedAt = performance.now();

  const stop = workerBeat(tick, INTERVAL_MS);
  await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3), {
    timeout: 5_000,
  });
  await pause(INTERVAL_MS * 5);
  stop();
  const ticked = tick.mock.calls.length;
  const elapsed = performance.now() - startedAt;

  // A timer never fires early, so there cannot be more beats than intervals
  // since the worker was made. A worker that beat as fast as it could, or on
  // some other interval, would have many more.
  expect(ticked).toBeGreaterThanOrEqual(3);
  expect(ticked).toBeLessThanOrEqual(Math.floor(elapsed / INTERVAL_MS));
});

test("the worker beat stops when asked, and its worker is ended", async () => {
  const terminate = vi.spyOn(Worker.prototype, "terminate");
  const tick = vi.fn();

  const stop = workerBeat(tick, INTERVAL_MS);
  await vi.waitFor(() => expect(tick).toHaveBeenCalled(), { timeout: 5_000 });
  stop();
  const ticked = tick.mock.calls.length;
  await pause(INTERVAL_MS * 6);

  expect(tick).toHaveBeenCalledTimes(ticked);
  expect(terminate).toHaveBeenCalledTimes(1);
  // Stopping it again does no harm.
  expect(() => stop()).not.toThrow();
});

test("two worker beats keep their own time and stop on their own", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = workerBeat(first, INTERVAL_MS);
  const stopSecond = workerBeat(second, INTERVAL_MS);
  await vi.waitFor(
    () => {
      expect(first).toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
    },
    { timeout: 5_000 },
  );

  stopFirst();
  const firstTicked = first.mock.calls.length;
  const secondTicked = second.mock.calls.length;
  await vi.waitFor(() => expect(second.mock.calls.length).toBeGreaterThan(secondTicked + 1), {
    timeout: 5_000,
  });
  stopSecond();

  expect(first).toHaveBeenCalledTimes(firstTicked);
});

test("where a worker cannot be made, the beat comes from the page's timer instead", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("This page may not make a worker.");
      }
    },
  );
  const pageTimer = vi.spyOn(window, "setInterval");
  const tick = vi.fn();

  const stop = workerBeat(tick, INTERVAL_MS);
  await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2), {
    timeout: 5_000,
  });
  expect(pageTimers(pageTimer)).toHaveLength(1);

  stop();
  const ticked = tick.mock.calls.length;
  await pause(INTERVAL_MS * 6);
  expect(tick).toHaveBeenCalledTimes(ticked);
});

test("a worker that fails after it was made is ended, and the page's timer takes over once", async () => {
  const made: FailingWorker[] = [];
  class FailingWorker extends EventTarget {
    terminated = 0;
    constructor() {
      super();
      made.push(this);
    }
    postMessage(): void {}
    terminate(): void {
      this.terminated += 1;
    }
    /** What a browser does when the worker's file cannot be loaded or throws. */
    fail(): void {
      this.dispatchEvent(new Event("error"));
    }
  }
  vi.stubGlobal("Worker", FailingWorker);
  const pageTimer = vi.spyOn(window, "setInterval");
  const tick = vi.fn();

  const stop = workerBeat(tick, INTERVAL_MS);
  expect(pageTimers(pageTimer)).toEqual([]);
  made[0]?.fail();
  made[0]?.fail();

  await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2), {
    timeout: 5_000,
  });
  expect(made).toHaveLength(1);
  expect(made[0]?.terminated).toBeGreaterThanOrEqual(1);
  expect(pageTimers(pageTimer)).toHaveLength(1);

  stop();
  const ticked = tick.mock.calls.length;
  await pause(INTERVAL_MS * 6);
  expect(tick).toHaveBeenCalledTimes(ticked);
});

/** A worker that can be made and says nothing unless the test makes it. */
class SilentWorker extends EventTarget {
  static made: SilentWorker[] = [];
  terminated = 0;
  constructor() {
    super();
    SilentWorker.made.push(this);
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated += 1;
  }
  beat(): void {
    this.dispatchEvent(new MessageEvent("message", { data: "beat" }));
  }
}

test("a worker that is made and never heard from is given up on after ten seconds, and the page's timer takes over", () => {
  SilentWorker.made = [];
  vi.stubGlobal("Worker", SilentWorker);
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const tick = vi.fn();

  const stop = workerBeat(tick, 2_000);
  expect(WORKER_PATIENCE_MS).toBe(10_000);
  vi.advanceTimersByTime(WORKER_PATIENCE_MS - 1);
  expect(tick).not.toHaveBeenCalled();
  expect(SilentWorker.made[0]?.terminated).toBe(0);

  vi.advanceTimersByTime(1);
  expect(SilentWorker.made[0]?.terminated).toBe(1);
  vi.advanceTimersByTime(6_000);
  expect(tick).toHaveBeenCalledTimes(3);

  stop();
  vi.advanceTimersByTime(6_000);
  expect(tick).toHaveBeenCalledTimes(3);
  expect(SilentWorker.made).toHaveLength(1);
});

test("a slow beat gives its worker five beats before giving up on it", () => {
  SilentWorker.made = [];
  vi.stubGlobal("Worker", SilentWorker);
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const tick = vi.fn();

  const stop = workerBeat(tick, 30_000);
  vi.advanceTimersByTime(149_999);
  expect(SilentWorker.made[0]?.terminated).toBe(0);
  vi.advanceTimersByTime(1);
  expect(SilentWorker.made[0]?.terminated).toBe(1);
  expect(tick).not.toHaveBeenCalled();
  vi.advanceTimersByTime(30_000);
  expect(tick).toHaveBeenCalledTimes(1);
  stop();
});

test("a worker that has been heard from is kept, however long it is then quiet", () => {
  SilentWorker.made = [];
  vi.stubGlobal("Worker", SilentWorker);
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const tick = vi.fn();

  const stop = workerBeat(tick, 2_000);
  SilentWorker.made[0]?.beat();
  expect(tick).toHaveBeenCalledTimes(1);
  // Then nothing for ten minutes, as when the computer sleeps.
  vi.advanceTimersByTime(600_000);

  expect(SilentWorker.made[0]?.terminated).toBe(0);
  expect(tick).toHaveBeenCalledTimes(1);
  SilentWorker.made[0]?.beat();
  expect(tick).toHaveBeenCalledTimes(2);

  stop();
  expect(SilentWorker.made[0]?.terminated).toBe(1);
});

test("stopping a beat before its worker is heard from leaves nothing waiting", () => {
  SilentWorker.made = [];
  vi.stubGlobal("Worker", SilentWorker);
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const tick = vi.fn();

  const stop = workerBeat(tick, 2_000);
  stop();
  vi.advanceTimersByTime(60_000);

  expect(vi.getTimerCount()).toBe(0);
  expect(tick).not.toHaveBeenCalled();
  expect(SilentWorker.made[0]?.terminated).toBe(1);
});

test("a worker that fails after the beat was stopped starts no timer", async () => {
  const made: EventTarget[] = [];
  class LateWorker extends EventTarget {
    constructor() {
      super();
      made.push(this);
    }
    postMessage(): void {}
    terminate(): void {}
  }
  vi.stubGlobal("Worker", LateWorker);
  const pageTimer = vi.spyOn(window, "setInterval");
  const tick = vi.fn();

  const stop = workerBeat(tick, INTERVAL_MS);
  stop();
  made[0]?.dispatchEvent(new Event("error"));
  await pause(INTERVAL_MS * 4);

  expect(pageTimers(pageTimer)).toEqual([]);
  expect(tick).not.toHaveBeenCalled();
});
