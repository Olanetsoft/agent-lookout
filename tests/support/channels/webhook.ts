// A webhook for integration tests: an HTTP server on a free port of
// 127.0.0.1 that writes down each request it is sent, headers and body, and
// answers as the test says. Nothing it receives goes any further. It stands
// in for an ntfy server and for Pushover's API as well, and can speak HTTPS
// with a certificate a test made, which no client that checks certificates
// takes.

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createSecureServer } from "node:https";

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
 * a number  answers with that status, and a JSON body that says nothing
 */
export type WebhookBehaviour = "ok" | "redirect" | "refuse" | "fail" | "silent" | number;

export interface TestWebhookServer {
  port: number;
  /** What it does with the next request. It can be changed between requests. */
  behaviour: WebhookBehaviour;
  /** Where a redirect points. */
  redirectTo: string;
  /** The connections opened to it so far. */
  connections: number;
  received: ReceivedPost[];
  /** An address on it, for `AGENT_LOOKOUT_WEBHOOK_URL`, beginning `https://` when it speaks TLS. */
  url(path?: string): string;
}

export async function startWebhookServer(
  options: {
    behaviour?: WebhookBehaviour;
    redirectTo?: string;
    /** A key and a certificate, from `selfSigned.ts`, to speak HTTPS with. */
    tls?: { key: string; cert: string };
  } = {},
): Promise<TestWebhookServer> {
  const scheme = options.tls ? "https" : "http";
  const webhook: TestWebhookServer = {
    port: 0,
    behaviour: options.behaviour ?? "ok",
    redirectTo: options.redirectTo ?? "https://example.test/elsewhere",
    connections: 0,
    received: [],
    url: (path = "/hook") => `${scheme}://127.0.0.1:${webhook.port}${path}`,
  };

  const answer = (req: IncomingMessage, res: ServerResponse) => {
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
      if (typeof webhook.behaviour === "number") {
        res.writeHead(webhook.behaviour, { "Content-Type": "application/json" }).end("{}");
        return;
      }
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
  };
  const server = options.tls ? createSecureServer(options.tls, answer) : createServer(answer);
  // A connection is counted as it is opened, before any TLS is spoken over it.
  server.on("connection", () => {
    webhook.connections += 1;
  });
  // A client that refuses the certificate ends the connection, which is not the test's failure.
  server.on("tlsClientError", () => {});
  webhook.port = await listen(server);
  return webhook;
}
