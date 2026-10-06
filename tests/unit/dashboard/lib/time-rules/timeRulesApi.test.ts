import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTION_HEADER } from "@core/api";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { fetchSettings, requestTimeRules } from "@dashboard/lib/time-rules/timeRulesApi";

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

const SET: TimeRules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 15 } };

describe("fetchSettings", () => {
  test("asks the app for its settings and reads them", async () => {
    const host = answering(200, {
      timeRules: SET,
      file: "~/.agent-lookout/settings.json",
      problem: null,
    });
    expect(await fetchSettings()).toEqual({
      timeRules: SET,
      file: "~/.agent-lookout/settings.json",
      problem: null,
    });
    expect(host.mock.calls[0]?.[0]).toBe("/api/settings");
  });

  test("an app that does not answer, answers with an error or with something else, gives no answer", async () => {
    answering(404, { error: "There is nothing at that address." });
    expect(await fetchSettings()).toBeNull();
    answering(200, { ok: true });
    expect(await fetchSettings()).toBeNull();
    setApiHost(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await fetchSettings()).toBeNull();
  });
});

describe("requestTimeRules", () => {
  test("sends the three rules as the route that acts takes them, and reads the rules in force", async () => {
    const host = answering(200, { ok: true, timeRules: SET });
    expect(await requestTimeRules(SET)).toEqual({ ok: true, rules: SET });
    const [path, init] = host.mock.calls[0] ?? [];
    expect(path).toBe("/api/settings/time-rules");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get(ACTION_HEADER)).toBe("time-rules");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual(SET);
  });

  test("a refusal gives the app's own sentence", async () => {
    answering(500, {
      error: "~/.agent-lookout/settings.json could not be written, so the change was not saved.",
      reason: "not-saved",
    });
    expect(await requestTimeRules(SET)).toEqual({
      ok: false,
      error: "~/.agent-lookout/settings.json could not be written, so the change was not saved.",
    });
  });

  test("no answer, or one that is not JSON, gives no sentence, and never rejects", async () => {
    setApiHost(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await requestTimeRules(SET)).toEqual({ ok: false, error: null });
    setApiHost(async () => new Response("<html>", { status: 502 }));
    expect(await requestTimeRules(SET)).toEqual({ ok: false, error: null });
  });
});
