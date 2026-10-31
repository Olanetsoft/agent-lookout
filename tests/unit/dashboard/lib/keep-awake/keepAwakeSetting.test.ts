import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTION_HEADER } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import {
  fetchKeepAwakeStatus,
  KEEP_AWAKE_TIMEOUT_MS,
  readKeepAwakeStatus,
  requestKeepAwake,
} from "@dashboard/lib/keep-awake/keepAwakeSetting";

afterEach(() => {
  setApiHost();
  vi.restoreAllMocks();
});

function answering(status: number, body: unknown) {
  const host = vi.fn<ApiHost>(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  setApiHost(host);
  return host;
}

/** The app's answer, with nothing held and nothing failed unless said. */
const status = (on: boolean, holding = false, failed = false) => ({ on, holding, failed });

describe("readKeepAwakeStatus", () => {
  test("reads whether the switch is on, whether the Mac is kept awake now and whether it could not be, and nothing else", () => {
    expect(readKeepAwakeStatus(status(true))).toEqual(status(true));
    expect(readKeepAwakeStatus(status(false))).toEqual(status(false));
    expect(readKeepAwakeStatus(status(true, true))).toEqual(status(true, true));
    expect(readKeepAwakeStatus(status(true, false, true))).toEqual(status(true, false, true));
    expect(readKeepAwakeStatus({ ...status(false), more: 1 })).toEqual(status(false));
  });

  test.each([
    null,
    undefined,
    [],
    [true],
    "on",
    true,
    1,
    {},
    { on: "true" },
    { on: 1 },
    { on: null },
    // An answer with the switch alone, as the app gave before it said whether it holds the Mac awake.
    { on: true },
    { on: true, holding: true },
    { on: true, failed: false },
    { on: true, holding: "yes", failed: false },
    { on: true, holding: false, failed: null },
    { show: true },
    { automatic: true },
  ])("reads %j as no answer", (value) => {
    expect(readKeepAwakeStatus(value)).toBeNull();
  });
});

describe("fetchKeepAwakeStatus", () => {
  test("asks the app whether the switch is on, with a GET of its own address", async () => {
    const host = answering(200, status(false));
    expect(await fetchKeepAwakeStatus()).toEqual(status(false));
    expect(host).toHaveBeenCalledOnce();
    const [path, init] = host.mock.calls[0] ?? [];
    expect(path).toBe("/api/app/keep-awake");
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get(ACTION_HEADER)).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("passes on the app's answer that the switch is on and the Mac is kept awake", async () => {
    answering(200, status(true, true));
    expect(await fetchKeepAwakeStatus()).toEqual(status(true, true));
  });

  test.each<[string, number, unknown]>([
    [
      "the collector's 404, as a browser tab gets",
      404,
      { error: "There is nothing at that address." },
    ],
    ["a refusal", 403, { error: "No." }],
    ["a failure", 500, { error: "Broke." }],
    ["an answer of another shape", 200, { show: true }],
    ["an answer that is not JSON", 200, "not json"],
  ])("gives no answer for %s", async (_what, status, body) => {
    answering(status, body);
    expect(await fetchKeepAwakeStatus()).toBeNull();
  });

  test("gives no answer when the app cannot be reached", async () => {
    setApiHost(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchKeepAwakeStatus()).toBeNull();
  });

  test("never takes an error answer as the switch, whatever its body says", async () => {
    answering(500, status(true));
    expect(await fetchKeepAwakeStatus()).toBeNull();
  });
});

describe("requestKeepAwake", () => {
  test.each([true, false])(
    "sends the switch %s as a POST with its own action, and the app's answer comes back",
    async (on) => {
      const host = answering(200, status(on));
      expect(await requestKeepAwake(on)).toEqual(status(on));
      expect(host).toHaveBeenCalledOnce();
      const [path, init] = host.mock.calls[0] ?? [];
      expect(path).toBe("/api/app/keep-awake/setting");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get(ACTION_HEADER)).toBe("keep-awake-setting");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      expect(init?.body).toBe(JSON.stringify({ on }));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  test("gives the app's answer, not what was asked for", async () => {
    answering(200, status(false));
    expect(await requestKeepAwake(true)).toEqual(status(false));
  });

  test.each<[string, number, unknown]>([
    ["a refusal", 403, { error: "This address only acts for the dashboard page." }],
    ["a body it would not take", 400, { error: 'The body must be {"on": true} or {"on": false}.' }],
    ["the collector's 405, as a browser tab gets", 405, { error: "No." }],
    ["an answer of another shape", 200, { on: "true" }],
    ["an answer that is not JSON", 200, "not json"],
  ])("gives no answer for %s", async (_what, status, body) => {
    answering(status, body);
    expect(await requestKeepAwake(true)).toBeNull();
  });

  test("gives no answer when the app cannot be reached", async () => {
    setApiHost(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await requestKeepAwake(true)).toBeNull();
  });

  test("never takes a refused change as taken, whatever its body says", async () => {
    answering(403, status(true));
    expect(await requestKeepAwake(true)).toBeNull();
  });
});

describe("an app that never answers", () => {
  /**
   * The page's own time limit, run at once: each request's signal is one the
   * test aborts, and the app answers only by giving up when it is.
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

  test("a read is given up after four seconds, and gives no answer", async () => {
    const app = hanging();
    const status = fetchKeepAwakeStatus();
    expect(app.limits).toEqual([KEEP_AWAKE_TIMEOUT_MS]);
    expect(KEEP_AWAKE_TIMEOUT_MS).toBe(4_000);
    app.giveUp();
    expect(await status).toBeNull();
  });

  test("a press is given up after four seconds, and gives no answer", async () => {
    const app = hanging();
    const status = requestKeepAwake(true);
    expect(app.limits).toEqual([KEEP_AWAKE_TIMEOUT_MS]);
    app.giveUp();
    expect(await status).toBeNull();
  });
});
