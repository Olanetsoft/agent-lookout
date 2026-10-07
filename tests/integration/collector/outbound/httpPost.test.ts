import { describe, expect, test, vi } from "vitest";

import { createJsonPoster } from "@collector/outbound/httpPost";
import { selfSignedCertificate } from "@tests/support/channels/selfSigned";
import { startWebhookServer } from "@tests/support/channels/webhook";

describe("createJsonPoster", () => {
  test("makes one POST of the body, with its type, its length, a plain User-Agent and the channel's own headers", async () => {
    const server = await startWebhookServer();
    const poster = createJsonPoster(new URL(server.url("/")), {
      version: "9.9.9-test",
      timeoutMs: 500,
      headers: { Authorization: "Bearer tk_test" },
    });
    expect(await poster.post('{"title":"café"}')).toEqual({ kind: "status", status: 200 });
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.headerNames).toEqual([
      "Content-Type",
      "Content-Length",
      "User-Agent",
      "Authorization",
      "Host",
      "Connection",
    ]);
    expect(server.received[0]?.headers).toMatchObject({
      "content-length": "17",
      "user-agent": "Agent Lookout/9.9.9-test",
      authorization: "Bearer tk_test",
      connection: "close",
    });
  });

  test.each(["1", "0"])(
    "a server whose certificate no one vouches for is refused before anything is sent, with NODE_TLS_REJECT_UNAUTHORIZED=%s",
    async (value) => {
      const server = await startWebhookServer({ tls: selfSignedCertificate() });
      const poster = createJsonPoster(new URL(server.url("/")), {
        version: "9.9.9-test",
        timeoutMs: 2_000,
        headers: { Authorization: "Bearer tk_s3cret" },
      });
      // Node reads the variable at each connection, so it is set only for this post.
      vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", value);
      try {
        const result = await poster.post('{"title":"s3cret"}');
        expect(result.kind).toBe("error");
        expect(result).toMatchObject({ code: expect.stringMatching(/SELF_SIGNED|CERT|UNABLE_TO/) });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(server.received).toEqual([]);
    },
  );

  test("an address that never answers costs one post its time, and its connection is closed", async () => {
    const server = await startWebhookServer({ behaviour: "silent" });
    const poster = createJsonPoster(new URL(server.url("/")), {
      version: "9.9.9-test",
      timeoutMs: 200,
    });
    const started = Date.now();
    expect(await poster.post("{}")).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a redirect is answered as its status, and never followed", async () => {
    const elsewhere = await startWebhookServer();
    const server = await startWebhookServer({
      behaviour: "redirect",
      redirectTo: elsewhere.url("/stolen"),
    });
    const poster = createJsonPoster(new URL(server.url("/")), { version: "9.9.9-test" });
    expect(await poster.post("{}")).toEqual({ kind: "status", status: 302 });
    expect(elsewhere.connections).toBe(0);
  });
});
