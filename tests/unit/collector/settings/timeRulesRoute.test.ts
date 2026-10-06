import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import { actionRefusalFor } from "@collector/handler";
import {
  createTimeRulesRoute,
  MAX_TIME_RULES_BODY_BYTES,
  timeRulesRefusalFor,
} from "@collector/settings/timeRulesRoute";
import type { SettingsWrite } from "@collector/settings/settingsFile";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";

/** The headers the dashboard's own page sends. Node gives header names in lower case. */
const FROM_THE_PAGE = {
  host: "127.0.0.1:4777",
  origin: "http://127.0.0.1:4777",
  "sec-fetch-site": "same-origin",
  "x-agent-lookout-action": "time-rules",
  "content-type": "application/json",
  "content-length": "300",
};

/** Headers only, for the checks made before a body is read. */
function head(
  headers: Record<string, string | string[] | undefined> = {},
  method = "POST",
): Pick<IncomingMessage, "method" | "headers"> {
  return { method, headers: { ...FROM_THE_PAGE, ...headers } };
}

const status = (req: Pick<IncomingMessage, "method" | "headers">) =>
  timeRulesRefusalFor(req)?.status;

const SET: TimeRules = {
  longWait: { on: true, minutes: 10 },
  idle: { on: true, hours: 48 },
  quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true },
};

/** A request with a body, as Node hands one over. A header set to undefined is not sent. */
function request(
  options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {},
): IncomingMessage {
  const text = options.body ?? JSON.stringify(SET);
  const body = Readable.from(text === "" ? [] : [Buffer.from(text)]);
  const headers = Object.fromEntries(
    Object.entries({
      ...FROM_THE_PAGE,
      "content-length": String(Buffer.byteLength(text)),
      ...options.headers,
    }).filter(([, value]) => value !== undefined),
  );
  return Object.assign(body, {
    method: options.method ?? "POST",
    headers,
  }) as unknown as IncomingMessage;
}

/** The route over settings that save, or not, as the test says. */
function routeOver(saved: SettingsWrite = { ok: true }) {
  const settings = { changeTimeRules: vi.fn((_rules: TimeRules) => saved) };
  return { route: createTimeRulesRoute({ settings }), settings };
}

describe("timeRulesRefusalFor, as the stop route's checks with its own action", () => {
  test("a POST from the dashboard's own page may proceed", () => {
    expect(timeRulesRefusalFor(head())).toBeNull();
    expect(timeRulesRefusalFor(head({ origin: "http://localhost:5173" }))).toBeNull();
    expect(timeRulesRefusalFor(head({ origin: "http://[::1]:4777" }))).toBeNull();
    expect(timeRulesRefusalFor(head({ "sec-fetch-site": undefined }))).toBeNull();
    expect(timeRulesRefusalFor(head({ "content-length": undefined }))).toBeNull();
    expect(
      timeRulesRefusalFor(head({ "content-type": "application/json; charset=utf-8" })),
    ).toBeNull();
  });

  test("its action opens no other route, and no other route's opens it", () => {
    expect(actionRefusalFor(head(), "stop", MAX_TIME_RULES_BODY_BYTES)?.status).toBe(403);
    expect(status(head({ "x-agent-lookout-action": "stop" }))).toBe(403);
    expect(status(head({ "x-agent-lookout-action": "clear-history" }))).toBe(403);
  });

  test.each(["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "a %s is refused with 405 and no CORS header",
    (method) => {
      const refusal = timeRulesRefusalFor(head({}, method));
      expect(refusal?.status).toBe(405);
      expect(refusal?.headers?.Allow).toBe("POST");
      expect(
        Object.keys(refusal?.headers ?? {})
          .join()
          .toLowerCase(),
      ).not.toContain("access-control");
    },
  );

  test.each([
    undefined,
    "https://evil.example",
    "http://evil.example:4777",
    "http://localhost.evil.example",
    "null",
    "",
    "file://",
  ])("an Origin of %j is refused", (origin) => {
    expect(status(head({ origin }))).toBe(403);
  });

  test("an Origin sent twice is refused", () => {
    expect(status(head({ origin: ["http://127.0.0.1:4777", "https://evil.example"] }))).toBe(403);
  });

  test.each(["cross-site", "same-site", "none"])(
    "a request the browser marks %s is refused",
    (site) => {
      expect(status(head({ "sec-fetch-site": site }))).toBe(403);
    },
  );

  test.each([undefined, "", "Time-Rules", "time-rules ", "settings", "time-rules, time-rules"])(
    "without the header that names the action, as with %j, it is refused",
    (value) => {
      const refusal = timeRulesRefusalFor(head({ "x-agent-lookout-action": value }));
      expect(refusal?.status).toBe(403);
      expect((refusal?.body as { error: string }).error).toContain(
        "X-Agent-Lookout-Action: time-rules",
      );
    },
  );

  test.each([undefined, "text/plain", "application/x-www-form-urlencoded", "text/json"])(
    "a body sent as %j is refused with 415",
    (type) => {
      expect(status(head({ "content-type": type }))).toBe(415);
    },
  );

  test("a body said to be larger than the limit is refused with 413 before it is read", () => {
    expect(status(head({ "content-length": String(MAX_TIME_RULES_BODY_BYTES) }))).toBeUndefined();
    expect(status(head({ "content-length": String(MAX_TIME_RULES_BODY_BYTES + 1) }))).toBe(413);
    expect(status(head({ "content-length": "-1" }))).toBe(413);
  });
});

describe("POST /api/settings/time-rules", () => {
  test("puts the rules in force once they are saved, and answers with them", async () => {
    const { route, settings } = routeOver();
    expect(await route(request())).toEqual({ status: 200, body: { ok: true, timeRules: SET } });
    expect(settings.changeTimeRules).toHaveBeenCalledWith(SET);
  });

  test("a refused request changes nothing and its body is never read", async () => {
    const { route, settings } = routeOver();
    const req = request({ headers: { origin: "https://evil.example" } });
    const read = vi.spyOn(req, "on");
    const answer = await route(req);
    expect(answer.status).toBe(403);
    expect(answer.headers?.Connection).toBe("close");
    expect(read.mock.calls.map(([event]) => event)).not.toContain("data");
    expect(settings.changeTimeRules).not.toHaveBeenCalled();
  });

  test("a body that is not JSON is refused, and changes nothing", async () => {
    const { route, settings } = routeOver();
    expect(await route(request({ body: "longWait=on" }))).toEqual({
      status: 400,
      body: { error: "The body must be JSON: the three time rules.", reason: "invalid" },
    });
    expect(settings.changeTimeRules).not.toHaveBeenCalled();
  });

  test.each<[string, unknown]>([
    ["one rule alone", { longWait: SET.longWait }],
    ["a rule with a field of another kind", { ...SET, idle: { ...SET.idle, path: "/etc" } }],
    ["a key of another kind beside the rules", { ...SET, file: "/tmp/elsewhere.json" }],
    ["minutes out of range", { ...SET, longWait: { on: true, minutes: 0 } }],
    ["the same time at both ends", { ...SET, quietHours: { ...SET.quietHours, to: "22:00" } }],
  ])("%s is refused whole, with the sentence that says what is wanted", async (_, body) => {
    const { route, settings } = routeOver();
    const answer = await route(request({ body: JSON.stringify(body) }));
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ reason: "invalid", error: expect.any(String) });
    expect(settings.changeTimeRules).not.toHaveBeenCalled();
  });

  test("a body larger than it said is cut off at the limit and refused", async () => {
    const { route, settings } = routeOver();
    const big = JSON.stringify({ ...SET, padding: "x".repeat(MAX_TIME_RULES_BODY_BYTES) });
    const answer = await route(request({ body: big, headers: { "content-length": undefined } }));
    expect(answer.status).toBe(413);
    expect(settings.changeTimeRules).not.toHaveBeenCalled();
  });

  test("rules that cannot be saved are not in force, and the answer says why", async () => {
    const problem =
      "~/.agent-lookout/settings.json could not be written, so the change was not saved.";
    const { route } = routeOver({ ok: false, problem });
    expect(await route(request())).toEqual({
      status: 500,
      body: { error: problem, reason: "not-saved" },
    });
  });
});
