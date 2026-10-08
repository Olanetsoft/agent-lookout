import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTION_HEADER } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import {
  APP_NOTIFICATIONS_TIMEOUT_MS,
  fetchAppNotificationsStatus,
  NOTIFICATION_TEST_TIMEOUT_MS,
  readAppNotificationsStatus,
  readNotificationTestOutcome,
  requestNotificationTest,
} from "@dashboard/lib/notifications/appNotifications";

afterEach(() => {
  setApiHost();
});

function answering(status: number, body: unknown) {
  const host = vi.fn<ApiHost>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  setApiHost(host);
  return host;
}

describe("readNotificationTestOutcome", () => {
  test("reads each of macOS's answers, and nothing else", () => {
    expect(readNotificationTestOutcome({ outcome: "shown" })).toEqual({ outcome: "shown" });
    expect(readNotificationTestOutcome({ outcome: "unsupported", more: 1 })).toEqual({
      outcome: "unsupported",
    });
    expect(readNotificationTestOutcome({ outcome: "no-answer" })).toEqual({
      outcome: "no-answer",
    });
    expect(readNotificationTestOutcome({ outcome: "refused", reason: "not allowed" })).toEqual({
      outcome: "refused",
      reason: "not allowed",
    });
  });

  test.each([
    null,
    undefined,
    [],
    "shown",
    {},
    { outcome: "refused" },
    { outcome: "refused", reason: 1 },
    { outcome: "allowed" },
  ])("reads %j as no answer", (value) => {
    expect(readNotificationTestOutcome(value)).toBeNull();
  });
});

describe("readAppNotificationsStatus", () => {
  test("reads the last refusal, or none", () => {
    expect(readAppNotificationsStatus({ lastRefusal: null })).toEqual({ lastRefusal: null });
    expect(readAppNotificationsStatus({ lastRefusal: "not allowed" })).toEqual({
      lastRefusal: "not allowed",
    });
  });

  test.each([null, [], {}, { lastRefusal: 1 }, "not allowed"])("reads %j as no answer", (value) => {
    expect(readAppNotificationsStatus(value)).toBeNull();
  });
});

test("a test is sent as a POST of {} with its own action, and macOS's answer comes back", async () => {
  const host = answering(200, { outcome: "refused", reason: "not allowed" });
  expect(await requestNotificationTest()).toEqual({ outcome: "refused", reason: "not allowed" });
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/app/notifications/test");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get(ACTION_HEADER)).toBe("notification-test");
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  expect(init?.body).toBe("{}");
});

test("a test the app refused, or did not answer, gives no answer", async () => {
  answering(404, { error: "There is nothing at that address." });
  expect(await requestNotificationTest()).toBeNull();
  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await requestNotificationTest()).toBeNull();
});

test("asks the app for the last refusal", async () => {
  const host = answering(200, { lastRefusal: "not allowed" });
  expect(await fetchAppNotificationsStatus()).toEqual({ lastRefusal: "not allowed" });
  expect(host.mock.calls[0]?.[0]).toBe("/api/app/notifications");
  expect(host.mock.calls[0]?.[1]?.method).toBeUndefined();

  answering(404, { error: "There is nothing at that address." });
  expect(await fetchAppNotificationsStatus()).toBeNull();
});

describe("an app that never answers", () => {
  /**
   * The page's own time limits, run at once: each request's signal is one
   * the test aborts, and the app answers only by giving up when it is.
   */
  function hanging() {
    const limits: number[] = [];
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      limits.push(ms);
      return controller.signal;
    });
    setApiHost(
      (_path, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("", "TimeoutError")),
          );
        }),
    );
    return { limits, giveUp: () => controller.abort() };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a test is given up after its own time limit, and gives no answer", async () => {
    const app = hanging();
    const answer = requestNotificationTest();
    expect(app.limits).toEqual([NOTIFICATION_TEST_TIMEOUT_MS]);
    app.giveUp();
    expect(await answer).toBeNull();
  });

  test("a read of the last refusal is given up after its own time limit, and gives no answer", async () => {
    const app = hanging();
    const status = fetchAppNotificationsStatus();
    expect(app.limits).toEqual([APP_NOTIFICATIONS_TIMEOUT_MS]);
    app.giveUp();
    expect(await status).toBeNull();
  });
});
