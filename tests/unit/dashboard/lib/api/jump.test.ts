import { afterEach, expect, test, vi } from "vitest";

import { NOTIFICATIONS_HEADER } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import {
  AUTOMATION_REFUSED_LINE,
  automationAskLine,
  JUMP_OUTCOME_WORDS,
  JUMP_TIMEOUT_MS,
  jumpOutcomeWords,
  requestJump,
  TERMINAL_JUMP_WAIT_MS,
} from "@dashboard/lib/api/jump";

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

test("a press of a terminal tab's Jump is the same request, given longer to answer", async () => {
  const host = answering(200, { ok: true, kind: "terminal", app: "Terminal", place: "Terminal" });
  vi.spyOn(AbortSignal, "timeout");

  expect(await requestJump(SESSION, TERMINAL_JUMP_WAIT_MS)).toBe("selected");
  expect(AbortSignal.timeout).toHaveBeenCalledWith(TERMINAL_JUMP_WAIT_MS);
  expect(host.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ sessionId: SESSION }));

  await requestJump(SESSION);
  expect(AbortSignal.timeout).toHaveBeenLastCalledWith(JUMP_TIMEOUT_MS);
  // Longer than the collector waits for the app, which is long enough to answer macOS.
  expect(TERMINAL_JUMP_WAIT_MS).toBeGreaterThan(60_000);
  vi.restoreAllMocks();
});

test.each([
  [404, "no-pane"],
  [409, "pane-gone"],
  [409, "tmux-stopped"],
  [409, "tab-gone"],
  [403, "not-allowed"],
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
    "tab-gone": "That tab has closed",
    "not-allowed": "macOS did not allow it",
    "too-soon": "Try again in a moment",
    failed: "Jump did not work",
  });
  const words = Object.values(JUMP_OUTCOME_WORDS);
  expect(new Set(words).size).toBe(words.length);
  for (const said of words) expect(said).not.toMatch(/[!.]/);
});

test("a terminal tab's Jump says where it went, and that it found no tab rather than no pane", () => {
  expect(jumpOutcomeWords("selected", "Terminal")).toBe("Switched to Terminal");
  expect(jumpOutcomeWords("selected", "iTerm2")).toBe("Switched to iTerm2");
  expect(jumpOutcomeWords("no-pane", "Terminal")).toBe("No tab found");
  expect(jumpOutcomeWords("tab-gone", "Terminal")).toBe("That tab has closed");
  expect(jumpOutcomeWords("not-allowed", "iTerm2")).toBe("macOS did not allow it");
  // A pane's are as they were.
  expect(jumpOutcomeWords("selected")).toBe("Selected in tmux");
  expect(jumpOutcomeWords("no-pane")).toBe("No tmux pane found");
});

test("the two lines about macOS name the app, and where to allow it, calmly", () => {
  // macOS's question names the program Agent Lookout was started from, so the line does too.
  expect(automationAskLine("Terminal")).toBe(
    "macOS will ask once whether the app you started Agent Lookout from may control Terminal. Allow it to let Jump switch tabs.",
  );
  expect(automationAskLine("iTerm2")).toContain("control iTerm2.");
  // In the Mac app the collector runs inside Agent Lookout, and macOS names it.
  expect(automationAskLine("Terminal", true)).toBe(
    "macOS will ask once whether Agent Lookout may control Terminal. Allow it to let Jump switch tabs.",
  );
  expect(AUTOMATION_REFUSED_LINE).toBe(
    "To let Jump switch tabs, allow it in System Settings, Privacy & Security, Automation.",
  );
  for (const line of [automationAskLine("Terminal"), AUTOMATION_REFUSED_LINE]) {
    expect(line).not.toContain("!");
  }
});
