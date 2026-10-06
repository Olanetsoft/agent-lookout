import { afterEach, expect, test, vi } from "vitest";

import { CLEAN_UP_OUTCOMES, NOTIFICATIONS_HEADER } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import {
  CLEAN_UP_OUTCOME_WORDS,
  cleanUpTimeoutMs,
  requestCleanUp,
  requestStop,
  STOP_REQUEST_TIMEOUT_MS,
  stopOutcomeWords,
  type StopOutcome,
} from "@dashboard/lib/stop/stopRequest";

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

test("Stop session is one POST through the app's own seam, naming the session and nothing else", async () => {
  const host = answering(200, { ok: true });
  vi.spyOn(AbortSignal, "timeout");

  expect(await requestStop(SESSION)).toBe("stopped");
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/sessions/stop");
  expect(init?.method).toBe("POST");
  expect(init?.body).toBe(JSON.stringify({ sessionId: SESSION }));
  const headers = new Headers(init?.headers);
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get("X-Agent-Lookout-Action")).toBe("stop");
  expect(headers.get(NOTIFICATIONS_HEADER)).toBe("off");
  // Long enough for the ten seconds the collector waits, and the look after.
  expect(AbortSignal.timeout).toHaveBeenCalledWith(STOP_REQUEST_TIMEOUT_MS);
  expect(STOP_REQUEST_TIMEOUT_MS).toBeGreaterThan(10_000);
});

test.each<[number, unknown, StopOutcome]>([
  [202, { ok: false, reason: "still-running", error: "Still running." }, "still-running"],
  [404, { reason: "gone", error: "Gone." }, "gone"],
  [409, { reason: "cannot-confirm", error: "Not sure." }, "cannot-confirm"],
  [409, { reason: "unsupported", error: "No." }, "unsupported"],
  [403, { reason: "not-allowed", error: "No." }, "not-allowed"],
  [429, { reason: "too-soon", error: "Wait." }, "too-soon"],
  [500, { reason: "failed", error: "Broke." }, "failed"],
  [500, { reason: "something-new", error: "?" }, "failed"],
  [200, { ok: "yes" }, "failed"],
  [200, "not json", "no-answer"],
])("an answer of %i with %j comes to %s", async (status, body, outcome) => {
  answering(status, body);
  expect(await requestStop(SESSION)).toBe(outcome);
});

test("no answer at all is said as no answer, since the session may have stopped all the same", async () => {
  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await requestStop(SESSION)).toBe("no-answer");
});

test("End sends each session with the moment its idle began, and reads what became of each", async () => {
  const host = answering(200, {
    results: [
      { sessionId: "claude-code:1", outcome: "ended" },
      { sessionId: "claude-code:2", outcome: "became-active" },
      { sessionId: "claude-code:3", outcome: "something-new" },
      { outcome: "ended" },
    ],
  });
  const entries = [
    { sessionId: "claude-code:1", statusSince: 1_700_000_000_000 },
    { sessionId: "claude-code:2", statusSince: 1_700_000_001_000 },
    { sessionId: "claude-code:3", statusSince: 1_700_000_002_000 },
  ];
  const answer = await requestCleanUp(entries, 25_000);

  expect(answer).toEqual({
    ok: true,
    results: new Map([
      ["claude-code:1", "ended"],
      ["claude-code:2", "became-active"],
      ["claude-code:3", "failed"],
    ]),
  });
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/sessions/clean-up");
  expect(init?.body).toBe(JSON.stringify({ sessions: entries }));
  expect(new Headers(init?.headers).get("X-Agent-Lookout-Action")).toBe("clean-up");
});

test("a clean-up that was not tried says why", async () => {
  answering(429, { reason: "too-soon", error: "Wait." });
  expect(await requestCleanUp([{ sessionId: "x", statusSince: 1 }])).toEqual({
    ok: false,
    reason: "too-soon",
  });
  answering(400, { error: "Bad." });
  expect(await requestCleanUp([{ sessionId: "x", statusSince: 1 }])).toEqual({
    ok: false,
    reason: "failed",
  });
  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await requestCleanUp([{ sessionId: "x", statusSince: 1 }])).toEqual({
    ok: false,
    reason: "no-answer",
  });
});

test("a clean-up with background jobs waits longer for each", () => {
  expect(cleanUpTimeoutMs(2)).toBe(cleanUpTimeoutMs(0) + 22_000);
});

test("every outcome has its own words, in a sentence, and every clean-up outcome a short phrase", () => {
  const outcomes: StopOutcome[] = [
    "stopped",
    "gone",
    "unsupported",
    "cannot-confirm",
    "not-allowed",
    "still-running",
    "too-soon",
    "failed",
    "no-answer",
  ];
  for (const outcome of outcomes) {
    for (const how of ["signal", "background"] as const) {
      expect(stopOutcomeWords(outcome, how)).toMatch(/^[A-Za-z].*\.$/);
    }
  }
  expect(stopOutcomeWords("stopped", "signal")).toBe(
    "Stopped. Its process has ended, and its conversation is kept.",
  );
  expect(stopOutcomeWords("still-running", "signal")).toBe(
    "Asked to stop, still running. It had not ended 10 seconds later.",
  );
  for (const outcome of CLEAN_UP_OUTCOMES) {
    expect(CLEAN_UP_OUTCOME_WORDS[outcome]).toMatch(/^[A-Z][a-z ]+$/);
  }
});
