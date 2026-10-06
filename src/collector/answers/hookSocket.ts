import { chmod, lstat, mkdir, stat, unlink } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";

import { readRequestBody } from "../handler.ts";
import { readHookRequest, type HeldAsks, type HookReply } from "./heldAsks.ts";

/**
 * The Unix socket the Agent Lookout plugin's hook sends each permission
 * request to, by curl, in `~/.agent-lookout/answer.sock` unless
 * `AGENT_LOOKOUT_ANSWER_SOCKET` says otherwise.
 *
 * It is a socket and not a port, so the Mac app, which opens no port, can
 * listen too, and no web page can reach it: a browser cannot connect to a
 * Unix socket. Its folder is this user's alone, mode 0700, and the socket
 * itself is 0600, so only this user's programs can connect. One copy of
 * Agent Lookout listens at a time: a copy that finds another answering there
 * leaves it be, and a socket nobody answers on is a leftover, replaced.
 *
 * It takes one kind of request: `POST /hooks/permission-request`, with the
 * header `X-Agent-Lookout-Hook: permission-request`, a JSON body of at most 1
 * MiB, which is the input Claude Code gives the hook. Anything else, and any
 * request that cannot be read, is answered at once with an empty 200, which
 * the hook prints nothing for, so the session's own prompt decides. The rest
 * is the held requests' to answer (`heldAsks.ts`).
 */

export const HOOK_PATH = "/hooks/permission-request";
export const HOOK_HEADER = "x-agent-lookout-hook";
export const HOOK_HEADER_VALUE = "permission-request";

/** The largest request taken. A `Write` carries a whole file; a larger one is left to the session. */
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

/** How long a hook gets to send its request. */
export const HOOK_BODY_TIMEOUT_MS = 10_000;

/** The most connections open at once: one held request per session, and room to spare. */
const MAX_CONNECTIONS = 64;

export type SocketStart = { ok: true } | { ok: false; problem: string };

export interface HookSocketOptions {
  socketPath: string;
  asks: Pick<HeldAsks, "receive" | "noteRequest" | "dropAll">;
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  /** The user the socket's folder must belong to. Defaults to this process's. */
  uid?: number;
  /**
   * Whether the socket's folder is Agent Lookout's own, `~/.agent-lookout`,
   * which it makes private when it finds it open to others. A folder named by
   * `AGENT_LOOKOUT_ANSWER_SOCKET` that it did not make is never changed: when
   * others can reach it, answering is off.
   */
  ownFolder?: boolean;
}

export interface HookSocket {
  /** Makes the folder ready and listens, or says why it did not. */
  start(): Promise<SocketStart>;
  /** Lets every held request go, stops listening and removes the socket. */
  close(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** Whether something answers on the socket at this path. */
function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    const done = (result: boolean) => {
      client.destroy();
      resolve(result);
    };
    client.setTimeout(1_000, () => done(true));
    client.once("connect", () => done(true));
    client.once("error", () => done(false));
  });
}

/** An empty 200: the hook prints nothing, and the session's own prompt decides. */
function sendNothing(res: ServerResponse): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Length": 0, Connection: "close" });
  res.end();
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Whether a request is the one kind the socket takes, before its body is read. */
export function isHookRequest(req: Pick<IncomingMessage, "method" | "url" | "headers">): boolean {
  if (req.method !== "POST" || req.url !== HOOK_PATH) return false;
  // A page in a browser cannot reach a Unix socket. A request that says it came from one did not come from the hook.
  if (req.headers.origin !== undefined) return false;
  if (header(req as IncomingMessage, HOOK_HEADER) !== HOOK_HEADER_VALUE) return false;
  const type = header(req as IncomingMessage, "content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return type === "application/json";
}

/** The open response, as the held requests see it. */
function replyTo(res: ServerResponse): HookReply {
  let closed = false;
  res.once("close", () => {
    closed = true;
  });
  return {
    send(body) {
      if (closed || res.writableEnded) return;
      if (body === "") {
        sendNothing(res);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      });
      res.end(body);
    },
    isOpen: () => !closed && !res.writableEnded && !res.destroyed,
    onClose(listener) {
      res.once("close", () => {
        if (!res.writableFinished) listener();
      });
    },
  };
}

export function createHookSocket(options: HookSocketOptions): HookSocket {
  const { socketPath, asks } = options;
  const maxBody = options.maxBodyBytes ?? MAX_HOOK_BODY_BYTES;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? HOOK_BODY_TIMEOUT_MS;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const folder = path.dirname(socketPath);
  let server: http.Server | null = null;
  /** The socket file this copy made, to remove only that one. */
  let made: number | null = null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isHookRequest(req)) {
      req.resume();
      sendNothing(res);
      return;
    }
    const length = header(req, "content-length");
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBody)) {
      req.resume();
      sendNothing(res);
      return;
    }
    const timer = setTimeout(() => req.destroy(), bodyTimeoutMs);
    const body = await readRequestBody(req, maxBody);
    clearTimeout(timer);
    if (!body.ok) {
      req.resume();
      sendNothing(res);
      return;
    }
    const request = readHookRequest(body.text);
    asks.noteRequest(request?.sessionId ?? null);
    if (request === null) {
      sendNothing(res);
      return;
    }
    asks.receive(request, replyTo(res));
  }

  /** The folder, made if it is not there, this user's alone. Null when it is ready. */
  async function readyFolder(): Promise<string | null> {
    try {
      // The first folder made, or nothing when the folder was there already.
      const madeHere = await mkdir(folder, { recursive: true, mode: 0o700 });
      const info = await lstat(folder);
      if (!info.isDirectory()) return `${folder} is not a folder, so answering is off.`;
      if (uid >= 0 && info.uid !== uid) {
        return `${folder} belongs to another user, so answering is off.`;
      }
      if ((info.mode & 0o077) !== 0) {
        if (madeHere === undefined && !options.ownFolder) {
          return `Other users can open ${folder}, so answering is off. Name a socket in a folder only you can open.`;
        }
        await chmod(folder, 0o700);
      }
      return null;
    } catch {
      return `The folder ${folder} could not be made ready, so answering is off.`;
    }
  }

  /** A leftover socket replaced, or why the path cannot be taken. Null when it is free. */
  async function freePath(): Promise<string | null> {
    let info;
    try {
      info = await lstat(socketPath);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? null : `${socketPath} could not be read.`;
    }
    if (!info.isSocket())
      return `Something other than a socket is at ${socketPath}, so answering is off.`;
    if (await answers(socketPath)) {
      return "Another copy of Agent Lookout answers permission prompts on this computer.";
    }
    try {
      await unlink(socketPath);
      return null;
    } catch {
      return `The leftover socket at ${socketPath} could not be removed, so answering is off.`;
    }
  }

  return {
    async start() {
      if (server !== null) return { ok: true };
      const problem = (await readyFolder()) ?? (await freePath());
      if (problem !== null) return { ok: false, problem };
      const listening = http.createServer(
        { requestTimeout: 0, headersTimeout: bodyTimeoutMs, keepAliveTimeout: 1_000 },
        (req, res) => {
          handle(req, res).catch(() => sendNothing(res));
        },
      );
      listening.maxConnections = MAX_CONNECTIONS;
      const listened = await new Promise<string | null>((resolve) => {
        listening.once("error", (error) =>
          resolve(
            errorCode(error) === "EADDRINUSE"
              ? "Another copy of Agent Lookout answers permission prompts on this computer."
              : `Agent Lookout could not listen at ${socketPath}, so answering is off.`,
          ),
        );
        listening.listen(socketPath, () => resolve(null));
      });
      if (listened !== null) return { ok: false, problem: listened };
      listening.on("error", () => {
        // A connection that went wrong is that connection's problem alone.
      });
      try {
        await chmod(socketPath, 0o600);
        made = (await stat(socketPath)).ino;
      } catch {
        listening.close();
        return { ok: false, problem: `The socket at ${socketPath} could not be made private.` };
      }
      server = listening;
      return { ok: true };
    },

    async close() {
      asks.dropAll();
      const closing = server;
      server = null;
      if (closing === null) return;
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections();
      });
      // Node removes the socket file as it closes. Should it be there still, it goes, if it is ours.
      try {
        if (made !== null && (await stat(socketPath)).ino === made) await unlink(socketPath);
      } catch {
        // Already gone.
      }
      made = null;
    },
  };
}
