import { createServer } from "node:http";

import { describe, expect, test } from "vitest";

import { createCollector } from "@collector/collector";
import { createNtfySender } from "@collector/ntfy/ntfySender";
import { createPushoverSender } from "@collector/pushover/pushoverSender";
import type { NtfyStatusResponse } from "@core/api";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { startWebhookServer, type TestWebhookServer } from "@tests/support/channels/webhook";
import { listen, request, type TestRequest } from "@tests/support/node/http";
import { NO_SETTINGS_FILE } from "@tests/support/node/tempFiles";

// Send a test, through the collector as every host builds it, to an ntfy
// server and a Pushover API of the test's own, both on 127.0.0.1.

const TOPIC = "s3cret-topic-3f9c2a7e";
const TOKEN = "atest0000000000000000000000000";
const USER = "utest0000000000000000000000000";

async function lookout(env: Record<string, string>, pushover?: TestWebhookServer) {
  const clock = { now: Date.now() };
  const collector = createCollector({
    version: "9.9.9-test",
    adapters: [],
    env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE, ...env },
    notifier: fakeSystemNotifier(),
    now: () => clock.now,
    warn: () => {},
    createNtfySender: (settings) =>
      createNtfySender(settings, { version: "9.9.9-test", timeoutMs: 2_000 }),
    createPushoverSender: (settings) =>
      createPushoverSender(settings, {
        version: "9.9.9-test",
        timeoutMs: 2_000,
        // Never Pushover itself: a server of the test's own, or a port with nothing on it.
        endpoint: new URL(pushover?.url("/1/messages.json") ?? "http://127.0.0.1:1/"),
      }),
  });
  const port = await listen(createServer(collector.handler));
  return {
    collector,
    clock,
    /** Presses Send a test as the dashboard's own page does, unless the test says otherwise. */
    press(channel: string, options: TestRequest = {}) {
      return request(port, "/api/phone/test", {
        method: "POST",
        ...options,
        headers: {
          Origin: `http://localhost:${port}`,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-Agent-Lookout-Action": "phone-test",
          ...options.headers,
        },
        body: options.body ?? JSON.stringify({ channel }),
      });
    },
    status: async () => (await request(port, "/api/ntfy")).json<NtfyStatusResponse>(),
  };
}

describe("POST /api/phone/test", () => {
  test("a press sends one test push through ntfy, which says only that it is a test, and is not the last push", async () => {
    const ntfy = await startWebhookServer();
    const server = await lookout({ AGENT_LOOKOUT_NTFY_URL: ntfy.url(`/${TOPIC}`) });
    const answer = await server.press("ntfy");
    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ ok: true, channel: "ntfy", sentAt: server.clock.now });
    expect(ntfy.received.map((push) => JSON.parse(push.body))).toEqual([
      {
        topic: TOPIC,
        title: "Agent Lookout test",
        message: "Pushes from Agent Lookout reach this device.",
        priority: 4,
        tags: ["hourglass"],
      },
    ]);
    expect((await server.status()).last).toBeNull();
    // Nothing of the answer holds the topic.
    expect(answer.body).not.toContain(TOPIC);
  });

  test("a press sends one through Pushover, and one Pushover refuses says why, with no key in it", async () => {
    const pushover = await startWebhookServer();
    const server = await lookout(
      { AGENT_LOOKOUT_PUSHOVER_TOKEN: TOKEN, AGENT_LOOKOUT_PUSHOVER_USER: USER },
      pushover,
    );
    expect((await server.press("pushover")).status).toBe(200);
    expect(JSON.parse(pushover.received[0]?.body ?? "")).toMatchObject({
      token: TOKEN,
      user: USER,
      title: "Agent Lookout test",
    });

    pushover.behaviour = 400;
    server.clock.now += 1_000;
    const refused = await server.press("pushover");
    expect(refused.status).toBe(502);
    expect(refused.json()).toEqual({
      error:
        "Pushover refused the push: check the application's token and the user key (status 400).",
      reason: "not-sent",
    });
    expect(refused.body).not.toContain(TOKEN);
    expect(refused.body).not.toContain(USER);
  });

  test("a channel that is not set up is not sent to, and the route says so", async () => {
    const server = await lookout({});
    for (const channel of ["ntfy", "pushover"]) {
      const answer = await server.press(channel);
      expect(answer.status).toBe(409);
      expect(answer.json()).toMatchObject({ reason: "off" });
    }
  });

  test.each<[string, TestRequest, number]>([
    ["a GET", { method: "GET", body: "" }, 405],
    ["no Origin", { headers: { Origin: null } }, 403],
    ["a page on another site", { headers: { Origin: "https://evil.example" } }, 403],
    [
      "a request the browser calls cross-site",
      { headers: { "Sec-Fetch-Site": "cross-site" } },
      403,
    ],
    ["no action header", { headers: { "X-Agent-Lookout-Action": null } }, 403],
    ["a body of another kind", { headers: { "Content-Type": "text/plain" } }, 415],
    ["a channel it does not have", { body: '{"channel":"webhook"}' }, 400],
  ])("%s is refused, and nothing is pushed", async (_, options, status) => {
    const ntfy = await startWebhookServer();
    const server = await lookout({ AGENT_LOOKOUT_NTFY_URL: ntfy.url(`/${TOPIC}`) });
    expect((await server.press("ntfy", options)).status).toBe(status);
    expect(ntfy.connections).toBe(0);
  });
});
