import { describe, expect, test, vi } from "vitest";

import { testMessage, type PhoneMessage } from "@collector/outbound/phoneMessage";
import { createPushoverSender } from "@collector/pushover/pushoverSender";
import type { PushoverSettings } from "@collector/pushover/pushoverSettings";
import { selfSignedCertificate } from "@tests/support/channels/selfSigned";
import { startWebhookServer } from "@tests/support/channels/webhook";

const SETTINGS: PushoverSettings = {
  token: "atest0000000000000000000000000",
  user: "utest0000000000000000000000000",
  events: ["needs-you"],
  afterMs: 0,
  asking: false,
};

const OVER: PhoneMessage = {
  kind: "finished",
  title: "billing-webhooks finished",
  message: "Seen at 14:01 · billing · Terminal · Claude Code",
};

function sender(endpoint: string, timeoutMs = 500) {
  return createPushoverSender(SETTINGS, {
    version: "9.9.9-test",
    timeoutMs,
    endpoint: new URL(endpoint),
  });
}

describe("createPushoverSender", () => {
  test("posts the push as JSON, with the token and the key in the body and never in the address", async () => {
    const pushover = await startWebhookServer();
    expect(await sender(pushover.url("/1/messages.json")).send(OVER)).toEqual({ sent: true });
    const [push] = pushover.received;
    expect(push?.method).toBe("POST");
    expect(push?.path).toBe("/1/messages.json");
    expect(JSON.parse(push?.body ?? "")).toEqual({
      token: SETTINGS.token,
      user: SETTINGS.user,
      title: "billing-webhooks finished",
      message: "Seen at 14:01 · billing · Terminal · Claude Code",
      priority: -1,
    });
    expect(push?.headerNames).toEqual([
      "Content-Type",
      "Content-Length",
      "User-Agent",
      "Host",
      "Connection",
    ]);
  });

  test("a test push sounds as a wait would", async () => {
    const pushover = await startWebhookServer();
    await sender(pushover.url("/1/messages.json")).send(testMessage());
    expect(JSON.parse(pushover.received[0]?.body ?? "")).toMatchObject({
      title: "Agent Lookout test",
      priority: 0,
    });
  });

  test.each([
    [400, "Pushover refused the push: check the application's token and the user key (status 400)"],
    [429, "Pushover's monthly limit for the application was reached (status 429)"],
    [503, "Pushover had a problem (status 503)"],
  ])(
    "an answer of %i says why, holds neither key and is not tried again",
    async (status, reason) => {
      const pushover = await startWebhookServer({ behaviour: status });
      const outcome = await sender(pushover.url("/1/messages.json")).send(OVER);
      expect(outcome).toEqual({ sent: false, reason });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(pushover.received).toHaveLength(1);
      expect(JSON.stringify(outcome)).not.toContain(SETTINGS.token);
      expect(JSON.stringify(outcome)).not.toContain(SETTINGS.user);
    },
  );

  test.each(["1", "0"])(
    "a server whose certificate no one vouches for is refused before the keys go, with NODE_TLS_REJECT_UNAUTHORIZED=%s",
    async (value) => {
      const pushover = await startWebhookServer({ tls: selfSignedCertificate() });
      vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", value);
      try {
        expect(await sender(pushover.url("/1/messages.json"), 2_000).send(OVER)).toEqual({
          sent: false,
          reason: "the secure connection to Pushover failed",
        });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(pushover.received).toEqual([]);
    },
  );
});
