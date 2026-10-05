import { afterEach, expect, test, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useNow } from "@dashboard/hooks/data/useNow";

// Runs in the component project because the clock listens for the page coming
// back into sight.

/** The page goes out of sight, as far as it can tell, or comes back. */
function pageHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  delete (document as { hidden?: boolean }).hidden;
});

test("back in sight, the clock reads the time at once, though its timer was held back while the page was hidden", async () => {
  // Only the clock's timer and the time are faked, so the timer runs only when the test says.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const { result, act, unmount } = await renderHook(() => useNow());
  const shown = result.current as number;

  // Hidden for a minute, and the browser never ran the timer.
  await act(() => pageHidden(true));
  vi.setSystemTime(shown + 60_000);
  expect(result.current).toBe(shown);

  await act(() => pageHidden(false));
  expect(result.current).toBe(shown + 60_000);
  await unmount();
});
