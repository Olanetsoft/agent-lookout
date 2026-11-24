// Reading another machine's Agent Lookout through ssh's input and output, which
// `ssh -W` joins to the port it listens on there: `GET /api/health`, then `GET
// /api/sessions`, over one connection that is kept open. Nothing else is asked
// for, and nothing is sent.
//
// The requests arrive there on that machine's own loopback, so its checks of
// the Host and Origin headers pass as they do for its own page: they name
// 127.0.0.1, and there is no Origin. They carry no
// `X-Agent-Lookout-Notifications` header, so reading changes nothing that
// machine believes about its own pages.

import { Agent, request } from "node:http";
import type { Duplex } from "node:stream";

/** How long one answer gets. A connection that has gone quiet is given up on well before ssh notices. */
export const REMOTE_ANSWER_TIMEOUT_MS = 6_000;

/**
 * How long the connection stays idle before its health is asked again. Node
 * closes one idle for 5 seconds, which ends ssh, and a poll here can wait
 * longer than that for a source of this computer's.
 */
const IDLE_MS = 3_000;

/** More than any real answer holds. A larger one is not read. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/** The routes that are read, in order. */
export const REMOTE_ROUTES = ["/api/health", "/api/sessions"] as const;

type RemoteAnswer =
  | { kind: "json"; value: unknown }
  /** The connection has ended. Why is for the tunnel to say. */
  | { kind: "closed" }
  | { kind: "timeout" }
  /** An answer, but not one of Agent Lookout's: why, in words that follow "it". */
  | { kind: "unreadable"; why: string };

export type RemoteReading =
  { kind: "read"; version: string; snapshot: unknown } | Exclude<RemoteAnswer, { kind: "json" }>;

/** Whether an answer of `/api/health` is Agent Lookout's: `{ ok: true, version }`. */
function versionIn(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, version } = value as Record<string, unknown>;
  if (ok !== true || typeof version !== "string") return null;
  return /^\d{1,4}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/.test(version) ? version : null;
}

export interface RemoteReaderOptions {
  /** Defaults to `REMOTE_ANSWER_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Defaults to `IDLE_MS`. */
  idleMs?: number;
  now?: () => number;
}

/**
 * Reads the other machine through `stream`, a connection to `port` of its
 * 127.0.0.1: its health, and once that says it is Agent Lookout, its sessions.
 * Each call is one reading, and none rejects.
 *
 * - The first answer is waited for however long it takes: until ssh has signed
 *   in nothing comes back, and the tunnel limits how long that is. Each answer
 *   after it has its time limit.
 * - One request is on the way at a time. After a timeout the answer is still to
 *   come, so the next request waits for it, and it is not read.
 * - An answer that took longer than its limit by the clock is a timeout too:
 *   this computer slept while it was on its way, so the timer did not run, and
 *   it may be hours old.
 * - One that is not HTTP, or is too long, cannot be read past, so the
 *   connection is ended with it.
 */
export function createRemoteReader(
  stream: Duplex,
  port: number,
  options: RemoteReaderOptions = {},
): () => Promise<RemoteReading> {
  const { timeoutMs = REMOTE_ANSWER_TIMEOUT_MS, idleMs = IDLE_MS, now = Date.now } = options;
  // Every request goes through the one stream. Node's own agent keeps it open
  // between them, and asks of a socket's methods only `ref`, which it has not.
  Object.assign(stream, { ref: () => stream });
  const agent = Object.assign(new Agent({ keepAlive: true, maxSockets: 1 }), {
    createConnection: () => stream,
    keepSocketAlive: () => true,
  });
  let answered = false;
  /** The request whose answer is still to come. */
  let onTheWay: Promise<RemoteAnswer> | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;

  function send(route: string): Promise<RemoteAnswer> {
    return new Promise((resolve) => {
      const closed = () => resolve({ kind: "closed" });
      if (stream.destroyed) return closed();
      stream.once("close", closed);
      const req = request({
        agent,
        host: "127.0.0.1",
        port,
        path: route,
        headers: { Accept: "application/json" },
      });
      req.on("close", () => stream.off("close", closed));
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (!error.code?.startsWith("HPE_")) return closed();
        resolve({ kind: "unreadable", why: "does not answer as a web server does" });
      });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_ANSWER_BYTES) {
            resolve({ kind: "unreadable", why: "sent too long an answer" });
            stream.destroy();
          } else chunks.push(chunk);
        });
        res.on("error", closed);
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const why = `answered ${route} with status ${res.statusCode}`;
            return resolve({ kind: "unreadable", why });
          }
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({ kind: "json", value });
          } catch {
            const why = `answered ${route} with something that is not JSON`;
            resolve({ kind: "unreadable", why });
          }
        });
      });
      req.end();
    });
  }

  /** Sends a request, and the health's again once the connection has been idle. */
  function next(route: string): Promise<RemoteAnswer> {
    clearTimeout(idle);
    onTheWay = send(route).then((answer) => {
      onTheWay = null;
      if (answer.kind === "closed") return answer;
      answered = true;
      idle = setTimeout(() => void (onTheWay ?? next("/api/health")), idleMs);
      idle.unref?.();
      return answer;
    });
    return onTheWay;
  }

  async function ask(route: string): Promise<RemoteAnswer> {
    if (!answered) return next(route);
    const asked = now();
    let over = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<RemoteAnswer>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      timer.unref?.();
    });
    const answer = await Promise.race([
      late,
      (async () => {
        while (onTheWay) await onTheWay;
        return over ? late : next(route);
      })(),
    ]);
    over = true;
    clearTimeout(timer);
    return answer.kind === "json" && now() - asked > timeoutMs ? { kind: "timeout" } : answer;
  }

  return async () => {
    const health = await ask("/api/health");
    if (health.kind !== "json") return health;
    const version = versionIn(health.value);
    if (version === null) {
      return { kind: "unreadable", why: "answered /api/health, but not as Agent Lookout does" };
    }
    const sessions = await ask("/api/sessions");
    if (sessions.kind !== "json") return sessions;
    return { kind: "read", version, snapshot: sessions.value };
  };
}
