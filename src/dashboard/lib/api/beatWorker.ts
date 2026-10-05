/**
 * The worker behind `workerBeat`. It is told an interval in milliseconds and
 * posts a message every time that interval passes. It keeps time and does
 * nothing else: it reads nothing and makes no request.
 */

let timer: ReturnType<typeof setInterval> | undefined;

addEventListener("message", (event: MessageEvent<unknown>) => {
  const intervalMs = event.data;
  if (typeof intervalMs !== "number" || !(intervalMs > 0)) return;
  clearInterval(timer);
  timer = setInterval(() => postMessage("beat"), intervalMs);
});
