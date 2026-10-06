// Hands a request the app's window made to a handler written for Node's HTTP
// server, and turns what the handler wrote into the answer the window gets.
//
// The app serves its page and its API from a scheme of its own, through
// Electron's `protocol.handle`, which speaks the Fetch API: a `Request` in, a
// `Response` out. The collector's handler and the static file handler speak
// Node's `(IncomingMessage, ServerResponse)`. This is the small in-memory
// adapter between the two. Nothing here listens, and nothing touches a socket.
//
// The handlers' own checks are not relaxed. A request from the app's window
// carries the app's own origin, which no loopback check would accept, so the
// adapter says what is true of it in the words those checks read: it was made
// on this machine, by the app's own page. Its `Host` is 127.0.0.1, and its
// `Origin`, when it has one, is the loopback origin. A request from any other
// origin is given an `Origin` no check accepts, so it never gets through.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** A handler written for Node's HTTP server: the collector's, or the one for the built files. */
export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/**
 * A request as Electron hands it over: a Fetch request, with the origin of the
 * page that made it when web content made it. Electron sets that itself, so
 * unlike `Referer` or `Origin` the page cannot choose it.
 */
export type AppRequest = Request & { initiatorOrigin?: string };

/** The `Host` every request from the app's window is given. */
export const LOOPBACK_HOST = "127.0.0.1";

/** The `Origin` a request from the app's own page is given. */
export const LOOPBACK_ORIGIN = "http://127.0.0.1";

/** The `Origin` a request from anywhere else is given: an opaque origin, which no check accepts. */
export const FOREIGN_ORIGIN = "null";

/** Headers that describe one connection, which this answer never had. */
const CONNECTION_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

/** Statuses an answer has no body for. */
const NO_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Who made a request: the origin Electron says issued it, or failing that the
 * one in its `Origin` header. Undefined for a request the app made itself, such
 * as opening the window's first page.
 */
export function originOf(request: AppRequest): string | undefined {
  return request.initiatorOrigin ?? request.headers.get("origin") ?? undefined;
}

/**
 * The headers a Node handler sees for a request. Node gives header names in
 * lower case, and the Fetch API already does.
 *
 * `Host` is always the loopback address: the request came from this app's own
 * window, on this machine. `Origin` is the loopback origin for a request from
 * the app's own page, an opaque origin for one from anywhere else, and left out
 * for one the app made itself.
 */
export function nodeHeaders(request: AppRequest, appOrigin: string): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers.host = LOOPBACK_HOST;
  delete headers.origin;
  const origin = originOf(request);
  if (origin !== undefined)
    headers.origin = origin === appOrigin ? LOOPBACK_ORIGIN : FOREIGN_ORIGIN;
  return headers;
}

/**
 * The request in the shape of Node's `IncomingMessage`: a readable stream of
 * its body, with its method, its path and query, and its headers. Only those
 * are read by the handlers it is given to.
 */
export function toIncomingMessage(request: AppRequest, appOrigin: string): IncomingMessage {
  const url = new URL(request.url);
  const hasBody = request.body !== null && request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody
    ? Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>)
    : Readable.from([]);
  const message = Object.assign(body, {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: nodeHeaders(request, appOrigin),
    httpVersion: "1.1",
  });
  return message as unknown as IncomingMessage;
}

/** What a handler wrote: the status, the headers in lower case and the body. */
export interface WrittenAnswer {
  status: number;
  headers: Map<string, string | string[]>;
  body: Buffer;
}

/**
 * Stands in for Node's `ServerResponse` and keeps what a handler writes to it.
 * It has the parts the collector's handler and the static file handler use:
 * the headers, `writeHead`, `write` and `end`.
 */
export class AnswerCollector {
  statusCode = 200;
  headersSent = false;
  /** Whether the handler has ended its answer. */
  writableEnded = false;
  readonly #headers = new Map<string, string | string[]>();
  readonly #chunks: Buffer[] = [];
  readonly #ended: Promise<void>;
  #end: () => void = () => {};

  constructor() {
    this.#ended = new Promise((resolve) => {
      this.#end = resolve;
    });
  }

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.#headers.set(
      name.toLowerCase(),
      typeof value === "number" ? String(value) : typeof value === "string" ? value : [...value],
    );
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.#headers.get(name.toLowerCase());
  }

  getHeaderNames(): string[] {
    return [...this.#headers.keys()];
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this.#headers.delete(name.toLowerCase());
  }

  writeHead(
    status: number,
    reasonOrHeaders?: string | Record<string, number | string | readonly string[]>,
    maybeHeaders?: Record<string, number | string | readonly string[]>,
  ): this {
    this.statusCode = status;
    const headers = typeof reasonOrHeaders === "string" ? maybeHeaders : reasonOrHeaders;
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.headersSent = true;
    this.#chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (this.writableEnded) return this;
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    this.#end();
    return this;
  }

  /** Resolves once the handler has ended its answer. */
  ended(): Promise<void> {
    return this.#ended;
  }

  /** What has been written so far. */
  written(): WrittenAnswer {
    return { status: this.statusCode, headers: this.#headers, body: Buffer.concat(this.#chunks) };
  }
}

/**
 * The Fetch `Response` for what a handler wrote. Headers that describe a
 * connection are dropped, and an answer to `HEAD`, or with a status that has
 * none, has no body.
 */
export function toResponse(answer: WrittenAnswer, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of answer.headers) {
    if (CONNECTION_HEADERS.has(name)) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const noBody = method === "HEAD" || NO_BODY_STATUSES.has(answer.status);
  return new Response(noBody ? null : new Uint8Array(answer.body), {
    status: answer.status,
    headers,
  });
}

/**
 * Answers a request from the app's window with a handler written for Node's
 * HTTP server. A handler that throws before it answers gets a plain 500.
 */
export async function answerWith(
  handler: NodeHandler,
  request: AppRequest,
  appOrigin: string,
): Promise<Response> {
  const req = toIncomingMessage(request, appOrigin);
  const res = new AnswerCollector();
  try {
    await handler(req, res as unknown as ServerResponse);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("The app ran into an unexpected problem.");
    } else {
      res.end();
    }
  }
  await res.ended();
  return toResponse(res.written(), request.method);
}
