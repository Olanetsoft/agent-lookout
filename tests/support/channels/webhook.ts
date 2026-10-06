// A webhook for integration tests: an HTTP server on a free port of
// 127.0.0.1 that writes down each request it is sent, headers and body, and
// answers as the test says. Nothing it receives goes any further.

import { createServer, type IncomingHttpHeaders } from "node:http";

import { listen } from "@tests/support/node/http";

/** One request as the server received it. */
export interface ReceivedPost {
  method: string;
  /** The path and query, as sent. */
  path: string;
  /** The headers, with their names in lower case. */
  headers: IncomingHttpHeaders;
  /** The header names in the order and the case they were sent. */
  headerNames: string[];
  body: string;
}

/**
 * ok        answers 200 with `ok`, as a Slack incoming webhook does
 * redirect  answers 302, with `Location` set to `redirectTo`
 * refuse    answers 403, as Slack does for a token it does not know
 * fail      answers 500
 * silent    reads the request and never answers
 */
export type WebhookBehaviour = "ok" | "redirect" | "refuse" | "fail" | "silent";

export interface TestWebhookServer {
  port: number;
  /** What it does with the next request. It can be changed between requests. */
  behaviour: WebhookBehaviour;
  /** Where a redirect points. */
  redirectTo: string;
  /** The connections opened to it so far. */
  connections: number;
  received: ReceivedPost[];
  /** An address on it, for `AGENT_LOOKOUT_WEBHOOK_URL`. */
  url(path?: string): string;
}

export async function startWebhookServer(
  options: { behaviour?: WebhookBehaviour; redirectTo?: string } = {},
): Promise<TestWebhookServer> {
  const webhook: TestWebhookServer = {
    port: 0,
    behaviour: options.behaviour ?? "ok",
    redirectTo: options.redirectTo ?? "https://example.test/elsewhere",
    connections: 0,
    received: [],
    url: (path = "/hook") => `http://127.0.0.1:${webhook.port}${path}`,
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      webhook.received.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        headerNames: req.rawHeaders.filter((_, index) => index % 2 === 0),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      switch (webhook.behaviour) {
        case "ok":
          res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
          return;
        case "redirect":
          res.writeHead(302, { Location: webhook.redirectTo }).end();
          return;
        case "refuse":
          res.writeHead(403, { "Content-Type": "text/plain" }).end("invalid_token");
          return;
        case "fail":
          res.writeHead(500, { "Content-Type": "text/plain" }).end("rollup_error");
          return;
        case "silent":
          return;
      }
    });
  });
  server.on("connection", () => {
    webhook.connections += 1;
  });
  webhook.port = await listen(server);
  return webhook;
}
