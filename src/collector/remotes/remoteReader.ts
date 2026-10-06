// Reading another machine's Agent Lookout through its tunnel: `GET
// /api/health`, then `GET /api/sessions`, from the tunnel's end on this
// machine's 127.0.0.1. Nothing else is asked for, and nothing is sent.
//
// The requests arrive there on that machine's own loopback, so its checks of
// the Host and Origin headers pass as they do for its own page: they name
// 127.0.0.1, and there is no Origin. They carry no
// `X-Agent-Lookout-Notifications` header, so reading changes nothing that
// machine believes about its own pages.

import { request } from "node:http";

/** How long one answer gets. A tunnel that has gone quiet is given up on well before ssh notices. */
export const REMOTE_ANSWER_TIMEOUT_MS = 6_000;

/** More than any real answer holds. A larger one is not read. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/** The routes that are read, in order. */
export const REMOTE_ROUTES = ["/api/health", "/api/sessions"] as const;

export type RemoteAnswer =
  | { kind: "json"; value: unknown }
  /** Nothing took the connection: ssh is not listening yet, or has gone. */
  | { kind: "refused" }
  /**
   * The connection was taken and closed with no answer: ssh is connected, and
   * nothing listens on the port on the other machine.
   */
  | { kind: "closed" }
  | { kind: "timeout" }
  /** An answer, but not one of Agent Lookout's: why, in words that follow "it". */
  | { kind: "unreadable"; why: string };

/** Asks the tunnel at `port` for one route. Never rejects. */
export function askRemote(
  port: number,
  route: (typeof REMOTE_ROUTES)[number],
  timeoutMs = REMOTE_ANSWER_TIMEOUT_MS,
): Promise<RemoteAnswer> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (answer: RemoteAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };

    const req = request({
      host: "127.0.0.1",
      port,
      path: route,
      method: "GET",
      // A connection of its own, closed after the answer.
      agent: false,
      headers: { Accept: "application/json" },
    });
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    timer.unref?.();

    req.on("socket", (socket) => socket.once("connect", () => (connected = true)));
    req.on("error", () => finish(connected ? { kind: "closed" } : { kind: "refused" }));
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        finish({ kind: "unreadable", why: `answered ${route} with status ${res.statusCode}` });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_ANSWER_BYTES) finish({ kind: "unreadable", why: `sent too long an answer` });
        else chunks.push(chunk);
      });
      res.on("error", () => finish({ kind: "closed" }));
      res.on("end", () => {
        try {
          finish({ kind: "json", value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          finish({ kind: "unreadable", why: `answered ${route} with something that is not JSON` });
        }
      });
    });
    req.end();
  });
}

export type RemoteReading =
  { kind: "read"; version: string; snapshot: unknown } | Exclude<RemoteAnswer, { kind: "json" }>;

/** Whether an answer of `/api/health` is Agent Lookout's: `{ ok: true, version }`. */
function versionIn(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, version } = value as Record<string, unknown>;
  if (ok !== true || typeof version !== "string") return null;
  return /^\d{1,4}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/.test(version) ? version : null;
}

/**
 * Reads the other machine through the tunnel at `port`: its health, and once
 * that says it is Agent Lookout, its sessions. Never rejects.
 */
export async function readRemote(
  port: number,
  timeoutMs = REMOTE_ANSWER_TIMEOUT_MS,
): Promise<RemoteReading> {
  const health = await askRemote(port, "/api/health", timeoutMs);
  if (health.kind !== "json") return health;
  const version = versionIn(health.value);
  if (version === null) {
    return { kind: "unreadable", why: "answered /api/health, but not as Agent Lookout does" };
  }
  const sessions = await askRemote(port, "/api/sessions", timeoutMs);
  if (sessions.kind !== "json") return sessions;
  return { kind: "read", version, snapshot: sessions.value };
}
