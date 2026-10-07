import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { createActionLimiter } from "@collector/actions/stopSession";
import type { TestResult } from "@collector/outbound/outboundChannel";
import {
  channelIn,
  createTestSendRoute,
  MAX_TEST_BODY_BYTES,
  type PhoneTester,
} from "@collector/outbound/testSendRoute";
import { HOUR_MS } from "@collector/outbound/outboundTiming";

const T0 = 1_791_204_000_000;

/** The headers the dashboard's own page sends for Send a test. Node gives header names in lower case. */
const FROM_THE_PAGE = {
  host: "127.0.0.1:4777",
  origin: "http://127.0.0.1:4777",
  "sec-fetch-site": "same-origin",
  "x-agent-lookout-action": "phone-test",
  "content-type": "application/json",
};

/** A request with a body, as Node hands one over. A header set to undefined is not sent. */
function request(
  options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {},
): IncomingMessage {
  const text = options.body ?? '{"channel":"ntfy"}';
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

/** A channel that sends nothing, answers as the test says and counts its tests. */
function tester(result: TestResult = { tried: true, at: T0, outcome: { sent: true } }) {
  const made = { tests: 0, result };
  const channel: PhoneTester = {
    async test() {
      made.tests += 1;
      return made.result;
    },
  };
  return { made, channel };
}

function route(channels: { ntfy?: PhoneTester | null; pushover?: PhoneTester | null } = {}) {
  const clock = { now: T0 };
  return {
    clock,
    answer: createTestSendRoute({
      channels: { ntfy: channels.ntfy ?? null, pushover: channels.pushover ?? null },
      limiter: createActionLimiter(() => clock.now),
      now: () => clock.now,
    }),
  };
}

describe("channelIn", () => {
  test("only a body that names one channel, and nothing more, names it", () => {
    expect(channelIn('{"channel":"ntfy"}')).toBe("ntfy");
    expect(channelIn(' { "channel" : "pushover" } ')).toBe("pushover");
    for (const body of [
      "",
      "{}",
      "[]",
      "null",
      '{"channel":"email"}',
      '{"channel":"NTFY"}',
      '{"channel":["ntfy"]}',
      '{"channel":"ntfy","topic":"elsewhere"}',
      '{"channel":"ntfy"',
    ]) {
      expect([body, channelIn(body)]).toEqual([body, null]);
    }
  });
});

describe("POST /api/phone/test", () => {
  test("from the dashboard's own page, it sends one test through the channel named, and says when", async () => {
    const ntfy = tester();
    const pushover = tester();
    const { answer } = route({ ntfy: ntfy.channel, pushover: pushover.channel });
    expect(await answer(request())).toEqual({
      status: 200,
      body: { ok: true, channel: "ntfy", sentAt: T0 },
    });
    expect([ntfy.made.tests, pushover.made.tests]).toEqual([1, 0]);
  });

  test.each([
    ["a GET", { method: "GET" }, 405],
    ["an OPTIONS", { method: "OPTIONS" }, 405],
    ["no Origin", { headers: { origin: undefined } }, 403],
    ["another site's Origin", { headers: { origin: "https://evil.example" } }, 403],
    ["a cross-site request", { headers: { "sec-fetch-site": "cross-site" } }, 403],
    ["no action header", { headers: { "x-agent-lookout-action": undefined } }, 403],
    ["another route's action", { headers: { "x-agent-lookout-action": "clear-history" } }, 403],
    ["a body that is not JSON", { headers: { "content-type": "text/plain" } }, 415],
    [
      "a body that says it is too large",
      { headers: { "content-length": String(MAX_TEST_BODY_BYTES + 1) } },
      413,
    ],
    ["a body that is too large", { body: `{"channel":"${"n".repeat(80)}"}` }, 413],
    ["a channel that is not one", { body: '{"channel":"webhook"}' }, 400],
    ["a body with more in it", { body: '{"channel":"ntfy","to":"x"}' }, 400],
  ] as const)("%s is refused before anything is sent", async (_, options, status) => {
    const ntfy = tester();
    const { answer } = route({ ntfy: ntfy.channel });
    const made = request(options as Parameters<typeof request>[0]);
    // A body too large is found as it is read, when its length was not said truly.
    if (status === 413 && "body" in options) delete made.headers["content-length"];
    expect((await answer(made)).status).toBe(status);
    expect(ntfy.made.tests).toBe(0);
  });

  test("a channel that is not set up says what turns it on", async () => {
    const { answer } = route();
    expect(await answer(request())).toEqual({
      status: 409,
      body: {
        error: "ntfy is not set up. Set AGENT_LOOKOUT_NTFY_URL and start Agent Lookout again.",
        reason: "off",
      },
    });
    expect((await answer(request({ body: '{"channel":"pushover"}' }))).body).toEqual({
      error:
        "Pushover is not set up. Set AGENT_LOOKOUT_PUSHOVER_TOKEN and AGENT_LOOKOUT_PUSHOVER_USER and start Agent Lookout again.",
      reason: "off",
    });
  });

  test("one test is sent a second, and one at a time", async () => {
    const ntfy = tester();
    const { answer, clock } = route({ ntfy: ntfy.channel });
    expect((await answer(request())).status).toBe(200);
    expect(await answer(request())).toEqual({
      status: 429,
      body: { error: "One test is sent a second. Try again in a moment.", reason: "too-soon" },
      headers: { "Retry-After": "1" },
    });
    clock.now += 1_000;
    expect((await answer(request())).status).toBe(200);
    expect(ntfy.made.tests).toBe(2);
  });

  test("with the hourly limit full, nothing is tried, and it says when the next can go", async () => {
    const ntfy = tester({ tried: false, limitedUntil: T0 + HOUR_MS - 90_500 });
    const { answer } = route({ ntfy: ntfy.channel });
    expect(await answer(request())).toEqual({
      status: 429,
      body: {
        error: "20 ntfy pushes were tried in the last hour, the most it tries.",
        reason: "limited",
        limitedUntil: T0 + HOUR_MS - 90_500,
      },
      headers: { "Retry-After": String(Math.ceil((HOUR_MS - 90_500) / 1_000)) },
    });
  });

  test("a test the service did not take says why, in a sentence of the channel's own", async () => {
    const pushover = tester({
      tried: true,
      at: T0,
      outcome: { sent: false, reason: "Pushover refused the push (status 403)" },
    });
    const { answer } = route({ pushover: pushover.channel });
    expect(await answer(request({ body: '{"channel":"pushover"}' }))).toEqual({
      status: 502,
      body: { error: "Pushover refused the push (status 403).", reason: "not-sent" },
    });
  });
});
