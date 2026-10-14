import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTION_HEADER } from "@core/api";
import {
  fetchPluginInstallStatus,
  PLUGIN_INSTALL_POLL_MS,
  readPluginInstallStatus,
  requestPluginInstallTold,
} from "@dashboard/lib/answer/pluginInstall";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";

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

describe("readPluginInstallStatus", () => {
  test.each([
    [{ state: "idle" }, { state: "idle" }],
    [{ state: "running" }, { state: "running" }],
    [{ state: "installed" }, { state: "installed" }],
    [{ state: "installed", more: 1 }, { state: "installed" }],
    [{ state: "idle", step: "check" }, { state: "idle" }],
    [
      { state: "failed", step: "check" },
      { state: "failed", step: "check" },
    ],
    [
      { state: "failed", step: "unfinished", more: 1 },
      { state: "failed", step: "unfinished" },
    ],
  ])("reads %j as %j", (value, read) => {
    expect(readPluginInstallStatus(value)).toEqual(read);
  });

  test.each([
    null,
    undefined,
    [],
    "installed",
    {},
    { state: "removed" },
    { state: "failed" },
    { state: "failed", step: "uninstall" },
    { state: "failed", step: 1 },
  ])("reads %j as no answer", (value) => {
    expect(readPluginInstallStatus(value)).toBeNull();
  });
});

test("asks again every two seconds while the install is under way", () => {
  expect(PLUGIN_INSTALL_POLL_MS).toBe(2_000);
});

test("asks the app what came of the install", async () => {
  const host = answering(200, { state: "failed", step: "marketplace" });
  expect(await fetchPluginInstallStatus()).toEqual({ state: "failed", step: "marketplace" });
  expect(host).toHaveBeenCalledOnce();
  expect(host.mock.calls[0]?.[0]).toBe("/api/app/claude-plugin");
  expect(host.mock.calls[0]?.[1]?.method).toBeUndefined();
});

test("an app that does not answer, answers with an error, or answers something else gives no answer", async () => {
  answering(404, { error: "There is nothing at that address." });
  expect(await fetchPluginInstallStatus()).toBeNull();
  answering(200, { state: "done" });
  expect(await fetchPluginInstallStatus()).toBeNull();
  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await fetchPluginInstallStatus()).toBeNull();
});

test("the dismissal is sent as a POST of {} with its own action, and the app's answer comes back", async () => {
  const host = answering(200, { state: "idle" });
  expect(await requestPluginInstallTold()).toEqual({ state: "idle" });
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/app/claude-plugin/told");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get(ACTION_HEADER)).toBe("plugin-install-told");
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  expect(init?.body).toBe("{}");
});

test("a dismissal the app refused, or never heard, gives no answer", async () => {
  answering(403, {
    error: "This address only acts for the dashboard page served from this machine.",
  });
  expect(await requestPluginInstallTold()).toBeNull();
  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await requestPluginInstallTold()).toBeNull();
});
