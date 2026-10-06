// Finding the Agent Lookout running on this machine and reading its sessions.
//
// Session names are private, so they are read from this machine only: an
// address that is not loopback is refused, whoever gives it, and `localhost`
// is never looked up, since a name can be repointed. The request is a plain
// GET with no `Origin`, which the handler allows, and it carries no
// `X-Agent-Lookout-Notifications` header, so asking changes nothing the server
// believes about the dashboard's pages.

import { request } from "node:http";
import type { LookupFunction } from "node:net";

import type { ReportedSession, ReportedSnapshot } from "./statusReport.ts";

/** Where `npm start` listens, then where `npm run dev` does, tried in that order. */
export const DEFAULT_ADDRESSES = ["http://127.0.0.1:4777", "http://localhost:5173"] as const;

/** The setting that names the address, when `--url` does not. */
export const URL_ENV = "AGENT_LOOKOUT_URL";

/** How long one address has to answer. A status line runs this every few seconds. */
export const ANSWER_TIMEOUT_MS = 500;

/** More than any real answer holds. A larger one is not read. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The address to ask, as `http://host:port`, when the text names Agent
 * Lookout on this machine: http, and localhost, 127.0.0.1 or [::1], the names
 * the server itself answers to. Null for anything else.
 */
export function loopbackAddress(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK_NAMES.has(url.hostname)) return null;
  return `http://${url.host}`;
}

/** The addresses to ask, and whether one was named, so a failure knows to mention `--url`. */
export interface Addresses {
  addresses: string[];
  named: boolean;
}

export type AddressesToTry = Addresses | { refusal: string };

/**
 * The addresses to ask, in order: the one `--url` gives, or else the one
 * `AGENT_LOOKOUT_URL` gives, or else where `npm start` and `npm run dev` listen.
 * A given address that is not on this machine is refused, never skipped.
 */
export function addressesToTry(url: string | null, env: NodeJS.ProcessEnv): AddressesToTry {
  const fromEnv = env[URL_ENV]?.trim() || null;
  const given = url ?? fromEnv;
  if (given === null) return { addresses: [...DEFAULT_ADDRESSES], named: false };
  const address = loopbackAddress(given);
  if (address === null) {
    const where = url !== null ? "--url" : URL_ENV;
    return {
      refusal: `${where} must be an http address on this machine, at localhost, 127.0.0.1 or [::1], such as http://127.0.0.1:4777. Session names are read from this machine only.`,
    };
  }
  return { addresses: [address], named: true };
}

export type Reading =
  | { kind: "answered"; snapshot: ReportedSnapshot }
  /** Nothing took the connection: no server is listening there. */
  | { kind: "not-running" }
  /** Something took the connection, and what came back is not Agent Lookout's answer. */
  | { kind: "unreadable"; why: string };

/**
 * Gives every name the loopback addresses themselves, so `localhost` is never
 * looked up. Both are offered: `npm run dev` may listen on either.
 */
const loopbackOnly: LookupFunction = (_hostname, options, callback) => {
  if (options.all) {
    callback(null, [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
  } else {
    callback(null, "127.0.0.1", 4);
  }
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const optionalText = (value: unknown) => value === undefined || typeof value === "string";

function isSession(value: unknown): value is ReportedSession {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    (value.project === null || optionalText(value.project)) &&
    (value.statusSince === null || typeof value.statusSince === "number") &&
    optionalText(value.agent) &&
    optionalText(value.waitingReason) &&
    typeof value.stale === "boolean"
  );
}

/** The answer of `/api/sessions`, checked as far as the report reads it, or null. */
export function asSnapshot(value: unknown): ReportedSnapshot | null {
  if (!isObject(value) || !Array.isArray(value.sessions) || !Array.isArray(value.sources)) {
    return null;
  }
  if (!value.sessions.every(isSession)) return null;
  const sourcesRead = value.sources.every(
    (source) =>
      isObject(source) &&
      typeof source.id === "string" &&
      typeof source.label === "string" &&
      typeof source.state === "string",
  );
  return sourcesRead ? (value as unknown as ReportedSnapshot) : null;
}

export type Finding =
  | { kind: "answered"; snapshot: ReportedSnapshot }
  /** No address answered: one sentence saying where it looked and how to start Agent Lookout. */
  | { kind: "failed"; message: string };

/**
 * Asks each address in turn and takes the first answer. Another program on
 * the first port does not hide Agent Lookout on the second, but when none
 * answers, the first that could not be read is the one named. Never rejects.
 */
export async function findSnapshot(
  toTry: Addresses,
  read: (address: string) => Promise<Reading>,
): Promise<Finding> {
  let unreadable: { address: string; why: string } | null = null;
  for (const address of toTry.addresses) {
    const reading = await read(address);
    if (reading.kind === "answered") return reading;
    if (reading.kind === "unreadable") unreadable ??= { address, why: reading.why };
  }

  if (unreadable) {
    return {
      kind: "failed",
      message: `Agent Lookout could not be read at ${unreadable.address}: ${unreadable.why}.`,
    };
  }
  const where = toTry.addresses.join(" or ");
  const elsewhere = toTry.named ? "" : ", or give its address with --url";
  return {
    kind: "failed",
    message: `Agent Lookout is not running at ${where}. Start it with agent-lookout, or with npm start or npm run dev in its folder${elsewhere}.`,
  };
}

/** Asks one address for `/api/sessions`. Never rejects. */
export function readSessions(address: string, timeoutMs = ANSWER_TIMEOUT_MS): Promise<Reading> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (reading: Reading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(reading);
    };

    const req = request(new URL("/api/sessions", address), {
      method: "GET",
      // A connection of its own, closed after the answer, so nothing keeps the process waiting.
      agent: false,
      headers: { Accept: "application/json" },
      lookup: loopbackOnly,
    });
    const timer = setTimeout(() => {
      finish(
        connected
          ? { kind: "unreadable", why: "it did not answer in time" }
          : { kind: "not-running" },
      );
    }, timeoutMs);

    req.on("socket", (socket) => socket.once("connect", () => (connected = true)));
    req.on("error", () => {
      finish(
        connected
          ? { kind: "unreadable", why: "it closed the connection before it had answered" }
          : { kind: "not-running" },
      );
    });
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        finish({ kind: "unreadable", why: `it answered with status ${res.statusCode}` });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_ANSWER_BYTES) finish({ kind: "unreadable", why: "its answer is too long" });
        else chunks.push(chunk);
      });
      res.on("error", () => {
        finish({ kind: "unreadable", why: "it closed the connection before it had answered" });
      });
      res.on("end", () => {
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          finish({ kind: "unreadable", why: "its answer is not JSON" });
          return;
        }
        const snapshot = asSnapshot(value);
        finish(
          snapshot
            ? { kind: "answered", snapshot }
            : { kind: "unreadable", why: "its answer is not a list of sessions" },
        );
      });
    });
    req.end();
  });
}
