import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTION_HEADER } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { requestRulesChange } from "@dashboard/lib/permission-rules/permissionRulesApi";

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

const RULE = { id: "aaaaaaaaaaaa", decision: "allow", tool: "Bash", command: "npm test:*" };

describe("requestRulesChange", () => {
  test("sends one change as the route that acts expects, and reads the rules it answers with", async () => {
    const host = answering(200, { ok: true, permissionRules: [RULE] });
    const change = { add: { decision: "allow", tool: "Bash", command: "npm test:*" } } as const;
    expect(await requestRulesChange(change)).toEqual({ ok: true, rules: [RULE] });
    const [path, init] = host.mock.calls[0] ?? [];
    expect(path).toBe("/api/settings/permission-rules");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get(ACTION_HEADER)).toBe("permission-rules");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual(change);
  });

  test("a refusal gives the app's sentence and reason", async () => {
    answering(409, { error: "The list holds that rule already.", reason: "duplicate" });
    expect(await requestRulesChange({ remove: { id: "aaaaaaaaaaaa" } })).toEqual({
      ok: false,
      error: "The list holds that rule already.",
      reason: "duplicate",
    });
  });

  test("an answer that cannot be read, or none, gives no reason and never rejects", async () => {
    answering(200, { ok: true, permissionRules: [{ ...RULE, decision: "maybe" }] });
    expect(await requestRulesChange({ remove: { id: "aaaaaaaaaaaa" } })).toEqual({
      ok: false,
      error: null,
      reason: null,
    });
    answering(500, { error: "x".repeat(500), reason: "something" });
    expect(await requestRulesChange({ remove: { id: "aaaaaaaaaaaa" } })).toEqual({
      ok: false,
      error: null,
      reason: null,
    });
    setApiHost(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await requestRulesChange({ remove: { id: "aaaaaaaaaaaa" } })).toEqual({
      ok: false,
      error: null,
      reason: null,
    });
  });
});
