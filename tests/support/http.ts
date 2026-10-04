// Real HTTP for integration tests: a server on a free loopback port and a
// client that sends a request exactly as written.

import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { onTestFinished } from "vitest";

/** Starts a server on a free loopback port and closes it when the test finishes. */
export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as AddressInfo).port;
}

export interface TestResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** The body parsed as JSON. */
  json: <T = unknown>() => T;
}

export interface TestRequest {
  method?: string;
  /**
   * Request headers. `Host` defaults to `localhost:<port>`; pass `Host: null`
   * to send no Host header at all.
   */
  headers?: Record<string, string | null>;
}

/**
 * Makes a real HTTP request to 127.0.0.1. The path is sent exactly as given,
 * without the tidying a browser or `fetch` would do, so `..` segments arrive.
 */
export function request(
  port: number,
  target: string,
  options: TestRequest = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = {};
  let sendHost = true;
  for (const [name, value] of Object.entries({ Host: `localhost:${port}`, ...options.headers })) {
    if (value === null) {
      if (name.toLowerCase() === "host") sendHost = false;
    } else {
      headers[name] = value;
    }
  }

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: target,
        method: options.method ?? "GET",
        headers,
        setHost: sendHost && !("Host" in headers),
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: <T>() => JSON.parse(body) as T,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
