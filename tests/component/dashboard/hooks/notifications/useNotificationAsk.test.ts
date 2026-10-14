import { StrictMode, useLayoutEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { ASK_AGAIN_AFTER_MS } from "@core/notices/notificationAsk";
import { useNotificationAsk } from "@dashboard/hooks/notifications/useNotificationAsk";
import {
  NOTIFICATION_ASK_STORAGE_KEY,
  resetNotificationAskForTests,
} from "@dashboard/lib/notifications/ask/notificationAskStore";
import {
  setNotificationHost,
  type NotificationPermissionState,
} from "@dashboard/lib/notifications/notificationHost";
import {
  NOTIFICATIONS_STORAGE_KEY,
  resetNotificationSettingForTests,
} from "@dashboard/lib/notifications/notificationSetting";
import { fakeNotificationHost, type FakeNotificationHost } from "@tests/support/notifications";

// Runs in the component project because the record and the choice live in
// local storage, and the hook listens for the page coming back into sight. The
// notification system is a stand-in, so nothing asks this browser for
// permission.

const T = 1_791_000_000_000;
const DAY = ASK_AGAIN_AFTER_MS[0] as number;

let host: FakeNotificationHost;

/** The notification system as the browser has it, with the clock at `T`. */
function at(permission: NotificationPermissionState) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
  host = fakeNotificationHost({ permission });
  setNotificationHost(host);
}

/** The page goes out of sight, as far as it can tell, or comes back. */
function pageHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Another tab at this address writes `value` under `key`, and this tab hears of it. */
function anotherTabWrites(key: string, value: string) {
  localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

const putOff = (notNow: number, when: number) => JSON.stringify({ notNow, at: when });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document as { hidden?: boolean }).hidden;
  localStorage.clear();
  resetNotificationAskForTests();
  resetNotificationSettingForTests();
  setNotificationHost();
});

test.each(["default", "granted"] as const)(
  "with nothing stored and the permission %s it asks",
  async (permission) => {
    at(permission);
    const { result, unmount } = await renderHook(() => useNotificationAsk());
    expect(result.current.asking).toBe(true);
    await unmount();
  },
);

test.each(["denied", "unsupported"] as const)(
  "where the browser %s notifications it does not ask",
  async (permission) => {
    at(permission);
    const { result, unmount } = await renderHook(() => useNotificationAsk());
    expect(result.current.asking).toBe(false);
    await unmount();
  },
);

test("with notifications on it does not ask", async () => {
  at("granted");
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
  const { result, unmount } = await renderHook(() => useNotificationAsk());
  expect(result.current.asking).toBe(false);
  await unmount();
});

test.each([false, true])(
  "a day passing while the page is in view does not bring it in; back into sight it asks (StrictMode: %s)",
  async (strict) => {
    at("default");
    localStorage.setItem(NOTIFICATION_ASK_STORAGE_KEY, putOff(1, T - DAY + 1));
    const { result, act, rerender, unmount } = await renderHook(() => useNotificationAsk(), {
      wrapper: strict ? StrictMode : undefined,
    });
    expect(result.current.asking).toBe(false);

    // A day is up, and the page is drawn again for something else.
    vi.setSystemTime(T + 60_000);
    await rerender();
    expect(result.current.asking).toBe(false);

    await act(() => pageHidden(true));
    expect(result.current.asking).toBe(false);
    await act(() => pageHidden(false));
    expect(result.current.asking).toBe(true);
    await unmount();
  },
);

test("a Not now in another tab takes it away here, however long after this tab asked", async () => {
  at("default");
  localStorage.setItem(NOTIFICATION_ASK_STORAGE_KEY, putOff(1, T - DAY));
  const { result, act, unmount } = await renderHook(() => useNotificationAsk());
  expect(result.current.asking).toBe(true);

  // Pressed there ten minutes after the question was drawn here.
  vi.setSystemTime(T + 10 * 60_000);
  await act(() => anotherTabWrites(NOTIFICATION_ASK_STORAGE_KEY, putOff(2, T + 10 * 60_000)));
  expect(result.current.asking).toBe(false);
  await unmount();
});

test("Not now here takes it away and writes the record, and nothing else", async () => {
  at("default");
  const { result, act, unmount } = await renderHook(() => useNotificationAsk());
  expect(result.current.asking).toBe(true);

  await act(() => result.current.putOff());
  expect(result.current.asking).toBe(false);
  expect(localStorage.getItem(NOTIFICATION_ASK_STORAGE_KEY)).toBe(putOff(1, T));
  expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull();
  expect(host.asked).toBe(0);
  await unmount();
});

test("Not now takes it away even when the record is no longer due by the press, as after the clock was set back, and leaves the record as it was", async () => {
  at("default");
  // The last Not now is 90 s ahead of the clock, so it cannot be waited from.
  const ahead = putOff(1, T + 90_000);
  localStorage.setItem(NOTIFICATION_ASK_STORAGE_KEY, ahead);
  const { result, act, unmount } = await renderHook(() => useNotificationAsk());
  expect(result.current.asking).toBe(true);

  // 31 s later it is within a minute of the clock, and no longer due.
  vi.setSystemTime(T + 31_000);
  await act(() => result.current.putOff());
  expect(result.current.asking).toBe(false);
  expect(localStorage.getItem(NOTIFICATION_ASK_STORAGE_KEY)).toBe(ahead);
  await unmount();
});

test.each<[string, () => void]>([
  ["a Not now in another tab", () => anotherTabWrites(NOTIFICATION_ASK_STORAGE_KEY, putOff(1, T))],
  [
    "the browser now blocking them",
    () => {
      host.state = "denied";
    },
  ],
])(
  "%s after the question was decided and before the hook listens takes it away",
  async (_what, change) => {
    at("default");
    const { result, unmount } = await renderHook(() => {
      const ask = useNotificationAsk();
      // Runs after the hook has read the record and the setting, and before its effect listens.
      useLayoutEffect(() => {
        change();
      }, []);
      return ask;
    });
    expect(result.current.asking).toBe(false);
    await unmount();
  },
);

test("storage cleared in another tab while the page is in view does not bring it in; back into sight it asks", async () => {
  at("default");
  localStorage.setItem(NOTIFICATION_ASK_STORAGE_KEY, putOff(1, T));
  const { result, act, unmount } = await renderHook(() => useNotificationAsk());
  expect(result.current.asking).toBe(false);

  await act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(result.current.asking).toBe(false);

  await act(() => pageHidden(true));
  await act(() => pageHidden(false));
  expect(result.current.asking).toBe(true);
  await unmount();
});

test("notifications turned on in another tab take it away here", async () => {
  at("granted");
  const { result, act, unmount } = await renderHook(() => useNotificationAsk());
  expect(result.current.asking).toBe(true);

  await act(() => anotherTabWrites(NOTIFICATIONS_STORAGE_KEY, "on"));
  expect(result.current.asking).toBe(false);
  await unmount();
});

test("notifications turned off in Settings in another tab take it away here", async () => {
  at("granted");
  const { result, act, unmount } = await renderHook(() => useNotificationAsk());
  expect(result.current.asking).toBe(true);

  await act(() => anotherTabWrites(NOTIFICATION_ASK_STORAGE_KEY, '{"stopped":true}'));
  expect(result.current.asking).toBe(false);
  await unmount();
});

test("the browser blocking them while the page is out of sight takes it away when it comes back", async () => {
  at("default");
  const { result, act, unmount } = await renderHook(() => useNotificationAsk());
  expect(result.current.asking).toBe(true);

  await act(() => pageHidden(true));
  host.state = "denied";
  await act(() => pageHidden(false));
  expect(result.current.asking).toBe(false);
  await unmount();
});

test("drawing it and the page coming back into sight write nothing and ask the browser nothing", async () => {
  at("default");
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const { act, unmount } = await renderHook(() => useNotificationAsk());
  await act(() => pageHidden(true));
  await act(() => pageHidden(false));

  expect(setItem).not.toHaveBeenCalled();
  expect(host.asked).toBe(0);
  await unmount();
});
