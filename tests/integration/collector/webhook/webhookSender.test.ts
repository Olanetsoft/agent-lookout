import { createServer } from "node:http";

import { describe, expect, test } from "vitest";

import type { WebhookPost } from "@collector/webhook/webhookMessage";
import { createHttpSender } from "@collector/webhook/webhookSender";
import type { WebhookSettings } from "@collector/webhook/webhookSettings";
import { listen } from "@tests/support/node/http";
import { startWebhookServer } from "@tests/support/channels/webhook";

const POST: WebhookPost = {
  text: "checkout-flow is waiting for permission (4m 12s, storefront, VS Code, Claude Code)",
  event: "needs-you",
  reason: "permission",
  session: { name: "checkout-flow", agent: "Claude Code", folder: "storefront", app: "VS Code" },
  at: "2026-10-05T14:01:05.000Z",
  waitedSeconds: 252,
};

function sender(url: string, timeoutMs = 500) {
  const settings: WebhookSettings = {
    url: new URL(url),
    events: ["needs-you"],
    afterMs: 0,
    asking: false,
  };
  return createHttpSender(settings, { version: "9.9.9-test", timeoutMs });
}

describe("createHttpSender", () => {
  test("makes one POST of the JSON, with its type, its length and a plain User-Agent, and nothing more", async () => {
    const hook = await startWebhookServer();
    expect(await sender(hook.url("/services/T0000/B0000/token?channel=ops")).send(POST)).toEqual({
      sent: true,
    });

    expect(hook.received).toHaveLength(1);
    const [post] = hook.received;
    expect(post?.method).toBe("POST");
    expect(post?.path).toBe("/services/T0000/B0000/token?channel=ops");
    expect(JSON.parse(post?.body ?? "")).toEqual(POST);
    expect(post?.headerNames).toEqual([
      "Content-Type",
      "Content-Length",
      "User-Agent",
      "Host",
      "Connection",
    ]);
    expect(post?.headers).toEqual({
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(post?.body ?? "")),
      "user-agent": "Agent Lookout/9.9.9-test",
      host: `127.0.0.1:${hook.port}`,
      connection: "close",
    });
    expect(hook.connections).toBe(1);
  });

  test("does not follow a redirect, and says so", async () => {
    const elsewhere = await startWebhookServer();
    const hook = await startWebhookServer({
      behaviour: "redirect",
      redirectTo: elsewhere.url("/stolen"),
    });
    expect(await sender(hook.url()).send(POST)).toEqual({
      sent: false,
      reason: "the address answered with a redirect, which is not followed",
    });
    expect(hook.received).toHaveLength(1);
    expect(elsewhere.connections).toBe(0);
  });

  test.each([
    ["refuse", "the address refused the post (status 403)"],
    ["fail", "the receiving service had a problem (status 500)"],
  ] as const)(
    "an address that does %s says so, and is not tried again",
    async (behaviour, reason) => {
      const hook = await startWebhookServer({ behaviour });
      expect(await sender(hook.url()).send(POST)).toEqual({ sent: false, reason });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(hook.received).toHaveLength(1);
    },
  );

  test("an address that never answers costs one post its time, and its connection is closed", async () => {
    const hook = await startWebhookServer({ behaviour: "silent" });
    const started = Date.now();
    expect(await sender(hook.url(), 200).send(POST)).toEqual({
      sent: false,
      reason: "the address did not answer in time",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hook.received).toHaveLength(1);
  });

  test("nothing answering, or no secure connection where https:// was asked for, says so", async () => {
    // A port that was free a moment ago, with nothing on it now.
    const gone = createServer();
    const port = await listen(gone);
    await new Promise((resolve) => gone.close(resolve));
    expect(await sender(`http://127.0.0.1:${port}/hook`).send(POST)).toEqual({
      sent: false,
      reason: "nothing answered at the address",
    });

    // A server that speaks plain HTTP, asked for https://.
    const plain = await startWebhookServer();
    expect(await sender(`https://127.0.0.1:${plain.port}/hook`).send(POST)).toEqual({
      sent: false,
      reason: "the secure connection to the address failed",
    });
    expect(plain.received).toHaveLength(0);
  });
});
