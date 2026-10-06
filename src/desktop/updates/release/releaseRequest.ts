// The app's only requests to the internet: reading a release's
// `latest-mac.yml` from GitHub, and downloading the zip it names.
//
// They are made with Node's own HTTPS client, in the main process. The page's
// session cancels every request it would make (`navigation/sessionRules.ts`),
// and Electron's `net` would go through that same session, so neither it nor
// the page is used, and the page's rule stays as it is.
//
// Every address is checked before it is asked for, the first one and each a
// redirect leads to: by default only `https:`, only GitHub and the two hosts
// GitHub redirects a release's downloads to, on the default port, with no user
// name or password. Each request has a time limit and a size limit, sends a
// `User-Agent` that names the app and its version and nothing else of the
// machine's, keeps no cookie and opens a connection of its own.

import { createWriteStream } from "node:fs";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createDownloadCheck } from "./downloadCheck.ts";
import type { ReleaseFile } from "./manifest.ts";

/**
 * The hosts a release's files come from: GitHub itself, which answers a
 * download with a redirect, and the two it redirects to. In October 2026
 * GitHub sends downloads to `release-assets.githubusercontent.com`; it used
 * `objects.githubusercontent.com` before.
 */
export const GITHUB_RELEASE_HOSTS: readonly string[] = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

/** Says whether the app may ask for an address. */
export type AllowAddress = (url: URL) => boolean;

/** Whether an address is one of GitHub's for a release: `https:`, a host above, its default port. */
export const isGitHubReleaseAddress: AllowAddress = (url) =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.port === "" &&
  GITHUB_RELEASE_HOSTS.includes(url.hostname);

/** The most redirects followed. GitHub uses two: to the tag's download, then to the file. */
export const MAX_REDIRECTS = 5;

/** How long an answer may take to begin, and how long a download may go with no bytes. */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How long a whole download may take: an hour, which a zip of 120 MB passes on
 * a link of 0.3 Mbit/s. A download that stops is given up sooner, after
 * `REQUEST_TIMEOUT_MS` with no bytes.
 */
export const DOWNLOAD_TIME_LIMIT_MS = 60 * 60_000;

/**
 * Why a request did not give what was asked for:
 *
 * not-found           404 or 410: there is no such file
 * refused             the address, or one a redirect led to, is not one the app goes to
 * too-many-redirects  more than `MAX_REDIRECTS`
 * too-large           more bytes than the limit, or than the release says
 * timed-out           no answer, or no bytes, in time
 * too-slow            a download still going when `DOWNLOAD_TIME_LIMIT_MS` ran out
 * status              another status than 200, given as `status`
 * network             no connection, or it broke
 * wrong-size          a download that ended short of the size the release says
 * wrong-hash          a download whose SHA-512 is not the one the release says
 * not-saved           the file could not be written
 */
export type RequestFailure =
  | "not-found"
  | "refused"
  | "too-many-redirects"
  | "too-large"
  | "timed-out"
  | "too-slow"
  | "status"
  | "network"
  | "wrong-size"
  | "wrong-hash"
  | "not-saved";

export type Fetched<T> =
  | { ok: true; value: T }
  | { ok: false; failure: RequestFailure; status?: number };

export interface ReleaseRequestOptions {
  /** `Agent-Lookout/<version>`. */
  userAgent: string;
  /** Which addresses may be asked for. Defaults to GitHub's for a release. */
  allow?: AllowAddress;
  timeoutMs?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** An error this file raised itself, to say why a request was stopped. */
class Stopped extends Error {
  constructor(readonly failure: RequestFailure) {
    super(failure);
  }
}

/**
 * Where a redirect leads, resolved against the address that answered with
 * it, or the failure when there is nowhere to go or it may not be followed.
 */
export function redirectTarget(
  from: URL,
  location: string | undefined,
  allow: AllowAddress,
): URL | RequestFailure {
  if (location === undefined || location === "") return "status";
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return "status";
  }
  return allow(target) ? target : "refused";
}

/** One request, resolved with its answer once the status and headers are in. */
function ask(url: URL, options: Required<ReleaseRequestOptions>): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    let req: ClientRequest;
    try {
      req = send(url, {
        method: "GET",
        headers: { "User-Agent": options.userAgent, Accept: "*/*" },
        // A connection of its own, closed after the answer, and a certificate
        // always checked, whatever the environment says.
        agent: false,
        rejectUnauthorized: true,
      });
    } catch {
      reject(new Stopped("network"));
      return;
    }
    // Covers connecting, the answer beginning, and every wait for more bytes.
    let answer: IncomingMessage | null = null;
    req.setTimeout(options.timeoutMs, () => {
      const stop = new Stopped("timed-out");
      answer?.destroy(stop);
      req.destroy(stop);
    });
    req.on("response", (res) => {
      answer = res;
      resolve(res);
    });
    req.on("error", reject);
    req.end();
  });
}

/** The failure an error stands for. */
function failureOf(error: unknown): RequestFailure {
  if (error instanceof Stopped) return error.failure;
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  if (name === "AbortError" || code === "ABORT_ERR") return "timed-out";
  if (typeof code === "string" && /^E(EXIST|NOSPC|ACCES|PERM|ROFS|NOENT|DQUOT|IO)$/.test(code)) {
    return "not-saved";
  }
  return "network";
}

/**
 * Asks for an address, following redirects that lead where the app may go,
 * and resolves with the final answer, a 200, or why there is none.
 */
async function open(
  start: URL,
  options: Required<ReleaseRequestOptions>,
): Promise<Fetched<IncomingMessage>> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!options.allow(url)) return { ok: false, failure: "refused" };
    let res: IncomingMessage;
    try {
      res = await ask(url, options);
    } catch (error) {
      return { ok: false, failure: failureOf(error) };
    }
    const status = res.statusCode ?? 0;
    if (status === 200) return { ok: true, value: res };
    // Nothing in another answer is read.
    res.resume();
    res.destroy();
    if (REDIRECTS.has(status)) {
      const location = res.headers.location;
      const target = redirectTarget(url, typeof location === "string" ? location : undefined, options.allow);
      if (typeof target === "string") return { ok: false, failure: target, status };
      url = target;
      continue;
    }
    if (status === 404 || status === 410) return { ok: false, failure: "not-found", status };
    return { ok: false, failure: "status", status };
  }
  return { ok: false, failure: "too-many-redirects" };
}

function withDefaults(options: ReleaseRequestOptions): Required<ReleaseRequestOptions> {
  return {
    userAgent: options.userAgent,
    allow: options.allow ?? isGitHubReleaseAddress,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  };
}

/** The `Content-Length` of an answer, when it gives a plain number. */
function lengthOf(res: IncomingMessage): number | null {
  const value = res.headers["content-length"];
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * Reads a small text file, such as `latest-mac.yml`, of at most `maxBytes`.
 * It never rejects.
 */
export async function fetchText(
  url: string,
  options: ReleaseRequestOptions & { maxBytes: number },
): Promise<Fetched<string>> {
  let start: URL;
  try {
    start = new URL(url);
  } catch {
    return { ok: false, failure: "refused" };
  }
  const opened = await open(start, withDefaults(options));
  if (!opened.ok) return opened;
  const res = opened.value;
  const length = lengthOf(res);
  if (length !== null && length > options.maxBytes) {
    res.destroy();
    return { ok: false, failure: "too-large" };
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    const finish = (answer: Fetched<string>) => {
      if (done) return;
      done = true;
      resolve(answer);
    };
    res.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > options.maxBytes) {
        finish({ ok: false, failure: "too-large" });
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => finish({ ok: true, value: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", (error) => finish({ ok: false, failure: failureOf(error) }));
    res.on("close", () => finish({ ok: false, failure: "network" }));
  });
}

export interface DownloadOptions extends ReleaseRequestOptions {
  /** Told the bytes so far, and the size the release says, as they arrive. */
  onProgress?: (received: number, total: number) => void;
  /** How long the whole download may take. */
  timeLimitMs?: number;
}

/**
 * Downloads a release's file into `file`, which must not exist yet, and checks
 * it, while it is written, against the size and SHA-512 the release gives. It
 * stops as soon as there are more bytes than that. It never rejects, and a
 * file that does not match is left for the caller to remove with its folder.
 */
export async function downloadFile(
  url: string,
  file: string,
  expected: ReleaseFile,
  options: DownloadOptions,
): Promise<Fetched<void>> {
  let start: URL;
  try {
    start = new URL(url);
  } catch {
    return { ok: false, failure: "refused" };
  }
  const opened = await open(start, withDefaults(options));
  if (!opened.ok) return opened;
  const res = opened.value;
  const length = lengthOf(res);
  if (length !== null && length !== expected.size) {
    res.destroy();
    return { ok: false, failure: length > expected.size ? "too-large" : "wrong-size" };
  }

  const check = createDownloadCheck(expected);
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!check.add(chunk)) {
        done(new Stopped("too-large"));
        return;
      }
      options.onProgress?.(check.received, expected.size);
      done(null, chunk);
    },
  });
  const signal = AbortSignal.timeout(options.timeLimitMs ?? DOWNLOAD_TIME_LIMIT_MS);
  try {
    // Made here, never opened over a file that is there already, and readable by this user alone.
    await pipeline(res, meter, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
  } catch (error) {
    res.destroy();
    return { ok: false, failure: signal.aborted ? "too-slow" : failureOf(error) };
  }
  const verdict = check.verdict();
  return verdict === "ok" ? { ok: true, value: undefined } : { ok: false, failure: verdict };
}
