import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTION_HEADER } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { requestTestSend, testFailureWords } from "@dashboard/lib/phone/testSend";

afterEach(() => {
  setApiHost();
});

const NOW = new Date(2026, 9, 5, 14, 30).getTime();
const UNTIL_1502 = new Date(2026, 9, 5, 15, 2).getTime();

/** A host that answers every request with this status and body. */
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

describe("requestTestSend", () => {
  test("asks the app with the action header and the channel alone, and says when it went", async () => {
    const host = answering(200, { ok: true, channel: "pushover", sentAt: NOW });
    expect(await requestTestSend("pushover")).toEqual({ ok: true, at: NOW });
    const [path, init] = host.mock.calls[0] ?? [];
    expect(path).toBe("/api/phone/test");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"channel":"pushover"}');
    const headers = new Headers(init?.headers);
    expect(headers.get(ACTION_HEADER)).toBe("phone-test");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("a refusal gives the app's reason and sentence, and when the next may go", async () => {
    answering(429, {
      error: "20 ntfy pushes were tried in the last hour, the most it tries.",
      reason: "limited",
      limitedUntil: UNTIL_1502,
    });
    expect(await requestTestSend("ntfy")).toEqual({
      ok: false,
      reason: "limited",
      error: "20 ntfy pushes were tried in the last hour, the most it tries.",
      limitedUntil: UNTIL_1502,
    });
    answering(502, { error: "x".repeat(400), reason: "something-new" });
    expect(await requestTestSend("ntfy")).toEqual({
      ok: false,
      reason: "not-sent",
      error: null,
      limitedUntil: null,
    });
  });

  test("an app that does not answer is no answer, and it never rejects", async () => {
    setApiHost(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await requestTestSend("ntfy")).toEqual({
      ok: false,
      reason: "no-answer",
      error: null,
      limitedUntil: null,
    });
  });
});

describe("testFailureWords", () => {
  const failure = (
    reason: "off" | "too-soon" | "limited" | "not-sent" | "no-answer",
    error: string | null = null,
    limitedUntil: number | null = null,
  ) => ({ ok: false as const, reason, error, limitedUntil });

  test("say why no test went, or why it did not arrive", () => {
    expect(testFailureWords(failure("no-answer"), NOW)).toBe(
      "Agent Lookout did not answer. Try again in a moment.",
    );
    expect(testFailureWords(failure("too-soon"), NOW)).toBe(
      "A test is already on its way. Try again in a moment.",
    );
    expect(testFailureWords(failure("limited", null, UNTIL_1502), NOW)).toBe(
      "20 pushes were tried in the last hour, the most it tries. The next can go at 15:02.",
    );
    expect(
      testFailureWords(failure("not-sent", "The ntfy server did not answer in time."), NOW),
    ).toBe("The ntfy server did not answer in time.");
    expect(testFailureWords(failure("not-sent"), NOW)).toBe(
      "It could not be sent. Try again in a moment.",
    );
    expect(testFailureWords(failure("off", "ntfy is not set up."), NOW)).toBe(
      "ntfy is not set up.",
    );
  });
});
