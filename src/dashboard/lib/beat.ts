/**
 * A beat calls `tick` every `intervalMs` until the function it returns is
 * called. The collector store polls on one.
 */
export type Beat = (tick: () => void, intervalMs: number) => () => void;

/** A beat from the page's own timer. */
export const timerBeat: Beat = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
};

/**
 * How long a new worker is given to make itself heard before it is given up
 * on: ten seconds, or five beats where that is longer.
 */
export const WORKER_PATIENCE_MS = 10_000;
const WORKER_PATIENCE_BEATS = 5;

/**
 * A beat from a small worker that does nothing but keep time.
 *
 * A browser slows the timers of a page it has put in the background, to as
 * little as one a minute, and the page would then learn a minute late that a
 * session had started waiting. A worker's timer is not slowed that way, so the
 * page keeps polling its own server every beat while its tab is hidden.
 *
 * Where a worker cannot be made, fails, or is made and never heard from, the
 * beat falls back to the page's own timer. A page that had stopped polling
 * without saying so would go on showing old data as if it were new.
 */
export const workerBeat: Beat = (tick, intervalMs) => {
  let worker: Worker | null = null;
  let stopTimer: (() => void) | null = null;
  let stopped = false;
  let heard = false;
  let patience: ReturnType<typeof setTimeout> | undefined;

  const fallBack = () => {
    clearTimeout(patience);
    worker?.terminate();
    worker = null;
    if (stopped || stopTimer) return;
    stopTimer = timerBeat(tick, intervalMs);
  };

  try {
    worker = new Worker(new URL("./beatWorker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", () => {
      heard = true;
      tick();
    });
    worker.addEventListener("error", fallBack);
    worker.postMessage(intervalMs);
    patience = setTimeout(
      () => {
        if (!heard) fallBack();
      },
      Math.max(WORKER_PATIENCE_MS, intervalMs * WORKER_PATIENCE_BEATS),
    );
  } catch {
    fallBack();
  }

  return () => {
    stopped = true;
    clearTimeout(patience);
    worker?.terminate();
    worker = null;
    stopTimer?.();
    stopTimer = null;
  };
};
