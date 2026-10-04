import { afterEach, expect, test, vi } from "vitest";

import { apiRequest, setApiHost, type ApiHost } from "@dashboard/lib/apiHost";

afterEach(() => {
  setApiHost();
});

test("a request goes to the installed host with its path and options", async () => {
  const host = vi.fn<ApiHost>(async () => new Response("{}"));
  setApiHost(host);
  const init = { signal: AbortSignal.timeout(1_000) };

  const response = await apiRequest("/api/sessions", init);

  expect(response.ok).toBe(true);
  expect(host).toHaveBeenCalledExactlyOnceWith("/api/sessions", init);
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
