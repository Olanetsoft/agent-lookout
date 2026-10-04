import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";

import { isApiPath, isLoopbackHostHeader, type ApiHandler } from "../handler.ts";
import { createStaticHandler } from "./staticFiles.ts";

/** The port `npm start` uses when `AGENT_LOOKOUT_PORT` is not set. */
export const DEFAULT_PORT = 4777;
export const DEFAULT_HOST = "127.0.0.1";

/** The loopback addresses themselves. Names are never resolved: a name can be repointed. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);

/** Whether an address to listen on is this machine only. */
export function isLoopbackAddress(address: string): boolean {
  return LOOPBACK_ADDRESSES.has(address);
}

/**
 * The address to listen on. Agent Lookout shows private session names and
 * paths and has no login, so it listens on loopback and refuses anything else.
 *
 * `AGENT_LOOKOUT_HOST` may choose between the loopback addresses. `localhost`
 * is read as 127.0.0.1.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv): string {
  const asked = env.AGENT_LOOKOUT_HOST?.trim();
  if (!asked) return DEFAULT_HOST;
  const host = asked.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (host === "localhost") return DEFAULT_HOST;
  if (!isLoopbackAddress(host)) {
    throw new Error(
      `AGENT_LOOKOUT_HOST is set to ${asked}. Agent Lookout only listens on this machine: use 127.0.0.1, localhost or ::1, or leave it unset.`,
    );
  }
  return host;
}

/** The port to listen on, from `AGENT_LOOKOUT_PORT` or the default. */
export function resolvePort(env: NodeJS.ProcessEnv): number {
  const asked = env.AGENT_LOOKOUT_PORT?.trim();
  if (!asked) return DEFAULT_PORT;
  const port = Number(asked);
  if (!/^\d+$/.test(asked) || port > 65_535) {
    throw new Error(
      `AGENT_LOOKOUT_PORT is set to ${asked}. Use a port number from 0 to 65535, or leave it unset for ${DEFAULT_PORT}.`,
    );
  }
  return port;
}

export interface AppServerOptions {
  /** The built dashboard, normally `dist/`. */
  distDir: string;
  /** The collector's handler for `/api/*`. */
  api: ApiHandler;
}

/**
 * One HTTP server for the dashboard and its API. It is not listening yet: call
 * `listenOnLoopback`.
 */
export function createAppServer(options: AppServerOptions): Server {
  const serveStatic = createStaticHandler(options.distDir);

  return createServer((req, res) => {
    if (isApiPath(req.url)) {
      options.api(req, res);
      return;
    }
    // The dashboard's files hold no private data, but a request that reached this
    // server under another name has no business being answered at all.
    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("This address only answers requests made to localhost.");
      return;
    }
    serveStatic(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("The server ran into an unexpected problem.");
    });
  });
}

/**
 * Whether something already accepts connections on a loopback port.
 *
 * Asking the system to listen is not enough of a check. On macOS a program may
 * listen on 127.0.0.1 while another program is listening on the same port on
 * every address, and no error is raised: this server would then quietly take
 * over the loopback traffic of whatever was there first.
 */
export function portAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (answers: boolean) => {
      socket.destroy();
      resolve(answers);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Starts listening, on a loopback address only. Rejects for any other address,
 * and with the code `EADDRINUSE` when another program already has the port.
 */
export async function listenOnLoopback(
  server: Server,
  host: string,
  port: number,
): Promise<AddressInfo> {
  if (!isLoopbackAddress(host)) {
    throw new Error(`Refusing to listen on ${host}. Agent Lookout only listens on this machine.`);
  }
  if (port !== 0 && (await portAnswers(host, port))) {
    throw Object.assign(new Error(`Port ${port} is already in use.`), { code: "EADDRINUSE" });
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

/** The URL to print and open for a listening address. */
export function urlFor(address: AddressInfo): string {
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}
