import { afterEach, expect, test, vi } from "vitest";

import { NOTIFICATIONS_HEADER } from "@core/api";
import { apiRequest, setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";

afterEach(() => {
  setApiHost();
});

/** The headers the installed host was handed on its latest call. */
function headersOf(host: ReturnType<typeof vi.fn<ApiHost>>): Headers {
  return new Headers(host.mock.lastCall?.[1]?.headers);
}

test("a request goes to the installed host with its path and options", async () => {
  const host = vi.fn<ApiHost>(async () => new Response("{}"));
  setApiHost(host);
  const init = { signal: AbortSignal.timeout(1_000), cache: "no-store" as const };

  const response = await apiRequest("/api/sessions", init);

  expect(response.ok).toBe(true);
  expect(host).toHaveBeenCalledOnce();
  const [path, passedOn] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/sessions");
  expect(passedOn?.signal).toBe(init.signal);
  expect(passedOn?.cache).toBe("no-store");
});

// Outside a browser there is no stored choice and nothing to show a
// notification with, so here the page always says "off". What it says in each
// state of the setting is tested in a real page, in tests/component.
test("every request says whether this page's notifications are on, beside the caller's own headers", async () => {
  const host = vi.fn<ApiHost>(async () => new Response("{}"));
  setApiHost(host);
  expect(NOTIFICATIONS_HEADER).toBe("X-Agent-Lookout-Notifications");

  await apiRequest("/api/health");
  expect([...headersOf(host)]).toEqual([["x-agent-lookout-notifications", "off"]]);

  await apiRequest("/api/sessions", { headers: { accept: "application/json" } });
  expect([...headersOf(host)]).toEqual([
    ["accept", "application/json"],
    ["x-agent-lookout-notifications", "off"],
  ]);

  await apiRequest("/api/events", { headers: new Headers({ accept: "application/json" }) });
  expect(headersOf(host).get("accept")).toBe("application/json");
  expect(headersOf(host).get(NOTIFICATIONS_HEADER)).toBe("off");
});

test("a caller cannot say otherwise for the page", async () => {
  const host = vi.fn<ApiHost>(async () => new Response("{}"));
  setApiHost(host);

  await apiRequest("/api/sessions", { headers: { [NOTIFICATIONS_HEADER]: "on" } });

  expect(headersOf(host).get(NOTIFICATIONS_HEADER)).toBe("off");
});

test("the caller's own options are left as they were", async () => {
  setApiHost(async () => new Response("{}"));
  const headers = { accept: "application/json" };
  const init = { headers };

  await apiRequest("/api/sessions", init);

  expect(init).toEqual({ headers: { accept: "application/json" } });
  expect(init.headers).toBe(headers);
});

test("a path with a query stays on this app's server and is passed on as it is", async () => {
  const host = vi.fn<ApiHost>(async () => new Response("{}"));
  setApiHost(host);

  await apiRequest("/api/events?since=1700000000000");
  await apiRequest("/api/history?windowMs=900000&next=//not-a-host");

  expect(host.mock.calls.map(([path]) => path)).toEqual([
    "/api/events?since=1700000000000",
    "/api/history?windowMs=900000&next=//not-a-host",
  ]);
});

test.each([
  "https://example.com/api/sessions",
  "//example.com/api/sessions",
  "/\\example.com/api/sessions",
  "api/sessions",
  // A browser drops tabs and newlines before it reads a URL, so each of these
  // is `//example.com/x`: another machine.
  "/\t/example.com/x",
  "/\n/example.com/x",
  "/\r/example.com/x",
  "/\t\\example.com/x",
  "",
])("%j is refused before any request is made", async (path) => {
  const host = vi.fn<ApiHost>(async () => new Response("{}"));
  setApiHost(host);

  await expect(apiRequest(path)).rejects.toThrow(TypeError);
  expect(host).not.toHaveBeenCalled();
});
