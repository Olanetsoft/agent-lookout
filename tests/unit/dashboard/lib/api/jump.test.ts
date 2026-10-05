import { afterEach, expect, test, vi } from "vitest";

import { NOTIFICATIONS_HEADER } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { JUMP_OUTCOME_WORDS, requestJump } from "@dashboard/lib/api/jump";

afterEach(() => {
  setApiHost();
});

const SESSION = "claude-code:00000000-0000-4000-8000-000000000001";

/** A host that answers every request with this status and body. */
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

test("a press is one POST through the app's own seam, naming the session and nothing else", async () => {
  const host = answering(200, { ok: true, kind: "tmux", place: "work:2.1" });

  expect(await requestJump(SESSION)).toBe("selected");
  expect(host).toHaveBeenCalledOnce();
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/jump");
  expect(init?.method).toBe("POST");
  expect(init?.body).toBe(JSON.stringify({ sessionId: SESSION }));
  const headers = new Headers(init?.headers);
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get("X-Agent-Lookout-Action")).toBe("jump");
  // The seam still adds what every request carries.
  expect(headers.get(NOTIFICATIONS_HEADER)).toBe("off");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

test.each([
  [404, "no-pane"],
  [409, "pane-gone"],
  [409, "tmux-stopped"],
  [429, "too-soon"],
  [500, "failed"],
] as const)("a %i that gives the reason %s comes out as that reason", async (status, reason) => {
  answering(status, { error: "A sentence from the collector.", reason });
  expect(await requestJump(SESSION)).toBe(reason);
});

test.each([
  ["a refusal with no reason", 403, { error: "This address only acts for the dashboard page." }],
  ["a reason this page does not know", 409, { error: "x", reason: "pane-moved" }],
  ["a reason that is not text", 409, { error: "x", reason: ["pane-gone"] }],
  ["a 200 that does not say ok", 200, { place: "work:2.1" }],
  ["a 200 that is a list", 200, ["ok"]],
  ["a 200 that is null", 200, null],
  ["a page of HTML, as a dev server with no collector sends", 200, "<!doctype html>"],
])("%s comes out as a failure, never as selected", async (_what, status, body) => {
  answering(status, body);
  expect(await requestJump(SESSION)).toBe("failed");
});

test("no answer at all is a failure, and nothing is thrown", async () => {
  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  await expect(requestJump(SESSION)).resolves.toBe("failed");
});

test("every outcome has its own few words, in sentence case and with no exclamation mark", () => {
  expect(JUMP_OUTCOME_WORDS).toEqual({
    selected: "Selected in tmux",
    "no-pane": "No tmux pane found",
    "pane-gone": "That pane has closed",
    "tmux-stopped": "tmux has stopped",
    "too-soon": "Try again in a moment",
    failed: "Jump did not work",
  });
  const words = Object.values(JUMP_OUTCOME_WORDS);
  expect(new Set(words).size).toBe(words.length);
  for (const said of words) expect(said).not.toMatch(/[!.]/);
});
