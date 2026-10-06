import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTION_HEADER } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import {
  fetchMenuBarStatus,
  readMenuBarStatus,
  requestMenuBarShown,
} from "@dashboard/lib/menu-bar/menuBarSetting";

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

describe("readMenuBarStatus", () => {
  test("reads whether the item is shown, and nothing else", () => {
    expect(readMenuBarStatus({ show: true })).toEqual({ show: true });
    expect(readMenuBarStatus({ show: false, more: 1 })).toEqual({ show: false });
  });

  test.each([null, undefined, [], "on", {}, { show: "true" }, { show: 1 }])(
    "reads %j as no answer",
    (value) => {
      expect(readMenuBarStatus(value)).toBeNull();
    },
  );
});

test("asks the app whether its item is in the menu bar", async () => {
  const host = answering(200, { show: false });
  expect(await fetchMenuBarStatus()).toEqual({ show: false });
  expect(host).toHaveBeenCalledOnce();
  expect(host.mock.calls[0]?.[0]).toBe("/api/app/menu-bar");
});

test("an app that does not answer, or answers with an error, gives no answer", async () => {
  answering(404, { error: "There is nothing at that address." });
  expect(await fetchMenuBarStatus()).toBeNull();
  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await fetchMenuBarStatus()).toBeNull();
});

test("the switch is sent as a POST with its own action, and the app's answer comes back", async () => {
  const host = answering(200, { show: false });
  expect(await requestMenuBarShown(false)).toEqual({ show: false });
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/app/menu-bar/setting");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get(ACTION_HEADER)).toBe("menu-bar-setting");
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  expect(init?.body).toBe('{"show":false}');
});

test("a switch the app refused gives no answer", async () => {
  answering(403, {
    error: "This address only acts for the dashboard page served from this machine.",
  });
  expect(await requestMenuBarShown(true)).toBeNull();
});
