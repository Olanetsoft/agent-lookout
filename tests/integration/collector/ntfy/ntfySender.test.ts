import { describe, expect, test, vi } from "vitest";

import { createNtfySender } from "@collector/ntfy/ntfySender";
import type { NtfySettings } from "@collector/ntfy/ntfySettings";
import { testMessage, type PhoneMessage } from "@collector/outbound/phoneMessage";
import { selfSignedCertificate } from "@tests/support/channels/selfSigned";
import { startWebhookServer } from "@tests/support/channels/webhook";
import { closedPort } from "@tests/support/node/http";

const TOPIC = "s3cret-topic-3f9c2a7e";
const TOKEN = "tk_s3cretaccesstoken00000000000";

const WAIT: PhoneMessage = {
  kind: "needs-you",
  title: "checkout-flow is waiting for permission",
  message: "4m 12s · storefront · VS Code · Claude Code",
};

function sender(server: string, token: string | null = null, timeoutMs = 500) {
  const settings: NtfySettings = {
    server: new URL(server),
    topic: TOPIC,
    token,
    events: ["needs-you"],
    afterMs: 0,
    asking: false,
  };
  return createNtfySender(settings, { version: "9.9.9-test", timeoutMs });
}

describe("createNtfySender", () => {
  test("posts the push as JSON to the server's root, with the topic in it, and no token when none is set", async () => {
    const ntfy = await startWebhookServer();
    expect(await sender(ntfy.url("/")).send(WAIT)).toEqual({ sent: true });
    expect(ntfy.received).toHaveLength(1);
    const [push] = ntfy.received;
    expect(push?.method).toBe("POST");
    expect(push?.path).toBe("/");
    expect(JSON.parse(push?.body ?? "")).toEqual({
      topic: TOPIC,
      title: "checkout-flow is waiting for permission",
      message: "4m 12s · storefront · VS Code · Claude Code",
      priority: 4,
      tags: ["hourglass"],
    });
    expect(push?.headerNames).toEqual([
      "Content-Type",
      "Content-Length",
      "User-Agent",
      "Host",
      "Connection",
    ]);
  });

  test("a server behind a path is posted to there, and a token goes as a bearer, in a header alone", async () => {
    const ntfy = await startWebhookServer();
    expect(await sender(ntfy.url("/ntfy/"), TOKEN).send(testMessage())).toEqual({ sent: true });
    const [push] = ntfy.received;
    expect(push?.path).toBe("/ntfy/");
    expect(push?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(push?.body).not.toContain(TOKEN);
    expect(push?.path).not.toContain(TOPIC);
  });

  test.each([
    [403, "the ntfy server refused the access token or the topic (status 403)"],
    [413, "the ntfy server refused the push as too large (status 413)"],
    [429, "the ntfy server's rate limit was reached (status 429)"],
    [500, "the ntfy server had a problem (status 500)"],
  ])("an answer of %i says why, holds no secret and is not tried again", async (status, reason) => {
    const ntfy = await startWebhookServer({ behaviour: status });
    const outcome = await sender(ntfy.url("/"), TOKEN).send(WAIT);
    expect(outcome).toEqual({ sent: false, reason });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ntfy.received).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toMatch(/s3cret|tk_/);
  });

  test("a server that never answers, or is not there, says so", async () => {
    const silent = await startWebhookServer({ behaviour: "silent" });
    expect(await sender(silent.url("/"), TOKEN, 200).send(WAIT)).toEqual({
      sent: false,
      reason: "the ntfy server did not answer in time",
    });
    expect(await sender(`http://127.0.0.1:${await closedPort()}/`).send(WAIT)).toEqual({
      sent: false,
      reason: "nothing answered at the ntfy server",
    });
  });

  test.each(["1", "0"])(
    "a server whose certificate no one vouches for is refused before the token goes, with NODE_TLS_REJECT_UNAUTHORIZED=%s",
    async (value) => {
      const ntfy = await startWebhookServer({ tls: selfSignedCertificate() });
      vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", value);
      try {
        expect(await sender(ntfy.url("/"), TOKEN, 2_000).send(WAIT)).toEqual({
          sent: false,
          reason: "the secure connection to the ntfy server failed",
        });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(ntfy.received).toEqual([]);
    },
  );
});
