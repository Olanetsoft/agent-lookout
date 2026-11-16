import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { NOTIFICATIONS_HEADER } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { useWaitNotifications } from "@dashboard/hooks/notifications/useWaitNotifications";
import { NO_ASKS_SEEN } from "@dashboard/lib/answer/seenAsks";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import type { CollectorState, CollectorStore } from "@dashboard/lib/api/collectorStore";
import { setNotificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
  NOTIFICATIONS_STORAGE_KEY,
  resetNotificationSettingForTests,
  turnOffNotifications,
} from "@dashboard/lib/notifications/notificationSetting";
import { makeSession } from "@tests/fixtures/session";
import { fakeNotificationHost, type FakeNotificationHost } from "@tests/support/notifications";

// Runs in the component project because the setting lives in local storage.
// The notification system and the transport are stand-ins, so nothing asks
// this browser for permission, shows a notification or makes a request.

const ID = "claude-code:00000000-0000-4000-8000-000000000001";

/** What each request said of the notifications: its path, the header and whether it outlives the page. */
let told: [string, string | null, boolean][];

beforeEach(() => {
  told = [];
  setApiHost(async (path, init) => {
    told.push([
      path,
      new Headers(init?.headers).get(NOTIFICATIONS_HEADER),
      init?.keepalive === true,
    ]);
    return new Response("{}");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetNotificationSettingForTests();
  setNotificationHost();
  setApiHost();
});

/** Notifications turned on, with the permission granted, as the app's window always has it. */
function notificationsOn(): FakeNotificationHost {
  const host = fakeNotificationHost({ permission: "granted" });
  setNotificationHost(host);
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "on");
  return host;
}

/** The store's state with one session in it. */
function stateWith(session: Session): CollectorState {
  const now = Date.now();
  const snapshot: SessionsSnapshot = {
    generatedAt: now,
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: now }],
    sessions: [session],
  };
  return {
    phase: "live",
    snapshot,
    events: [],
    history: null,
    lastOkAt: now,
    problem: null,
    problemKind: null,
    seenAsks: NO_ASKS_SEEN,
  };
}

const working = () => stateWith(makeSession({ id: ID, name: "checkout-flow", status: "working" }));
const waiting = () =>
  stateWith(
    makeSession({
      id: ID,
      name: "checkout-flow",
      status: "needs-you",
      waitingReason: "permission",
    }),
  );

/** A store that holds whatever state the test gives it, and makes no requests. */
function fixedStore(initial: CollectorState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const store: CollectorStore & { set: (next: CollectorState) => void } = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    refresh: vi.fn(),
    set(next) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
  return store;
}

test("in the Mac app's window, a wait that begins shows nothing on the page, and nothing is left to hand to another page", async () => {
  const host = notificationsOn();
  const store = fixedStore(working());
  const added = vi.spyOn(window, "addEventListener");
  const { unmount } = await renderHook(() => useWaitNotifications(store, true));

  store.set(waiting());
  store.set(waiting());
  expect(host.shown).toEqual([]);
  expect(added.mock.calls.filter(([type]) => type === "pagehide")).toEqual([]);
  await unmount();
  expect(host.shown).toEqual([]);
});

test("in the Mac app's window, a change of the setting is said to the collector at once, in one request that outlives the window", async () => {
  notificationsOn();
  const { unmount } = await renderHook(() => useWaitNotifications(fixedStore(working()), true));
  expect(told).toEqual([]);

  turnOffNotifications();
  await vi.waitFor(() => expect(told).toEqual([["/api/health", "off", true]]));
  await unmount();
});

test("in a browser tab, the same wait shows one notification on the page, which its end takes down", async () => {
  const host = notificationsOn();
  const store = fixedStore(working());
  const { unmount } = await renderHook(() => useWaitNotifications(store, false));

  store.set(waiting());
  store.set(waiting());
  expect(host.shown).toHaveLength(1);
  expect(host.shown[0]).toMatchObject({
    title: "checkout-flow",
    body: "Waiting for permission",
    open: true,
  });
  store.set(working());
  expect(host.shown[0]?.open).toBe(false);
  await unmount();
});
