import { createServer as createHttpServer, type RequestListener } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, onTestFinished, test } from "vitest";

import { createRemoteReader, type RemoteReaderOptions } from "@collector/remotes/remoteReader";
import { snapshotThere } from "@tests/fixtures/remote";
import { listen } from "@tests/support/node/http";
import { startStandInLookout } from "@tests/support/remotes/standIns";

/** A reader over one connection to a port of this computer, as `ssh -W` joins one there. */
function readerOf(port: number, options: RemoteReaderOptions = {}) {
  const stream = connect(port, "127.0.0.1");
  stream.on("error", () => {});
  onTestFinished(() => void stream.destroy());
  return { stream, read: createRemoteReader(stream, port, options) };
}

/** A web server, and how many connections it has had. */
async function webServer(answer: RequestListener) {
  const server = createHttpServer(answer);
  const sockets: Socket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  return { server, sockets, port: await listen(server) };
}

/** A server that does what it is told with each connection. */
async function rawServer(onSocket: (socket: Socket) => void): Promise<number> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as { port: number }).port;
}

const HEALTH = JSON.stringify({ ok: true, version: "0.2.3" });
const ok = (body: string, length = body.length) =>
  `HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\n\r\n${body}`;

describe("reading another machine over one connection", () => {
  test("reads the health, then the sessions, and nothing else", async () => {
    const lookout = await startStandInLookout(snapshotThere(), "0.2.3");
    const { read } = readerOf(lookout.port);
    expect(await read()).toEqual({
      kind: "read",
      version: "0.2.3",
      snapshot: JSON.parse(JSON.stringify(snapshotThere())),
    });
    const asked = {
      method: "GET",
      host: `127.0.0.1:${lookout.port}`,
      origin: undefined,
      notifications: undefined,
    };
    expect(lookout.requests).toEqual([
      { ...asked, path: "/api/health" },
      { ...asked, path: "/api/sessions" },
    ]);
  });

  test("every reading goes over the one connection, and leaves nothing on it behind", async () => {
    const lookout = await startStandInLookout(snapshotThere());
    const { stream, read } = readerOf(lookout.port);
    const listeners = () => stream.eventNames().map((name) => stream.listenerCount(name));
    for (const _ of [1, 2]) await read();
    const before = listeners();
    for (let count = 0; count < 20; count += 1) expect((await read()).kind).toBe("read");
    expect(lookout.connections()).toBe(1);
    expect(listeners()).toEqual(before);
  });

  test("between readings the health is asked again, so a server does not close the connection as idle", async () => {
    const { server, sockets, port } = await webServer((_, res) => res.end(HEALTH));
    server.keepAliveTimeout = 400;
    const { read } = readerOf(port, { idleMs: 100 });
    expect((await read()).kind).toBe("read");
    await delay(2_000);
    expect((await read()).kind).toBe("read");
    expect(sockets).toHaveLength(1);
  });

  test("the first answer is waited for past the time limit, as ssh signs in, and each after it is not", async () => {
    const held: (() => void)[] = [];
    let hold = true;
    const { port } = await webServer((_, res) => {
      const answer = () => void res.end(HEALTH);
      if (hold) held.push(answer);
      else answer();
    });
    const { read } = readerOf(port, { timeoutMs: 200, idleMs: 60_000 });
    const first = read();
    expect(await Promise.race([first, delay(600, "waiting")])).toBe("waiting");
    hold = false;
    for (const answer of held) answer();
    expect((await first).kind).toBe("read");
    hold = true;
    expect(await read()).toEqual({ kind: "timeout" });
  });

  test("an answer that comes after its time is not taken for the next one's", async () => {
    let held: (() => void) | null = null;
    let count = 0;
    const { sockets, port } = await webServer((req, res) => {
      count += 1;
      const body = req.url === "/api/health" ? HEALTH : JSON.stringify({ count });
      // The health of the second reading is the one that comes late.
      if (count === 3) held = () => void res.end(HEALTH);
      else res.end(body);
    });
    const { read } = readerOf(port, { timeoutMs: 200, idleMs: 60_000 });
    expect(await read()).toMatchObject({ kind: "read", snapshot: { count: 2 } });
    expect(await read()).toEqual({ kind: "timeout" });
    // Nothing more is asked while that answer is still to come.
    expect(await read()).toEqual({ kind: "timeout" });
    expect(count).toBe(3);
    (held as unknown as () => void)();
    await delay(50);
    expect(await read()).toMatchObject({ kind: "read", snapshot: { count: 5 } });
    expect(sockets).toHaveLength(1);
  });

  test("an answer that took longer than its time by the clock, as while this computer slept, is a timeout", async () => {
    const lookout = await startStandInLookout(snapshotThere(), "0.2.3");
    let clock = 0;
    let slept = 0;
    /** The clock when the answer is asked for, then 8 hours after, once `slept` says. */
    const now = () => (clock += slept);
    const { read } = readerOf(lookout.port, { now });
    expect((await read()).kind).toBe("read");
    slept = 8 * 60 * 60_000;
    expect(await read()).toEqual({ kind: "timeout" });
    slept = 0;
    expect((await read()).kind).toBe("read");
  });

  test("a connection that ends with no answer, or part of one, is closed, and so is every reading after", async () => {
    const first = await rawServer((socket) => socket.destroy());
    const half = await rawServer((socket) => {
      socket.once("data", () => {
        socket.write(ok(HEALTH));
        socket.once("data", () => socket.end(ok('{"sessions":[', 3_000)));
      });
    });
    for (const port of [first, half]) {
      const { read } = readerOf(port);
      for (const _ of [1, 2]) expect(await read()).toEqual({ kind: "closed" });
    }
  });

  test("an answer that is not Agent Lookout's is not read, and the sessions are not asked for", async () => {
    const asked: string[] = [];
    const { port } = await webServer((req, res) => {
      asked.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "fine" }));
    });
    expect(await readerOf(port).read()).toEqual({
      kind: "unreadable",
      why: "answered /api/health, but not as Agent Lookout does",
    });
    expect(asked).toEqual(["/api/health"]);
  });

  test("a status other than 200, and an answer that is not JSON, say so, and the next is read", async () => {
    let status = 404;
    let body = "not here";
    const { port } = await webServer((_, res) => {
      res.writeHead(status);
      res.end(body);
    });
    const { read } = readerOf(port);
    expect(await read()).toEqual({
      kind: "unreadable",
      why: "answered /api/health with status 404",
    });
    status = 200;
    body = "<html>";
    expect(await read()).toEqual({
      kind: "unreadable",
      why: "answered /api/health with something that is not JSON",
    });
    body = HEALTH;
    expect((await read()).kind).toBe("read");
  });

  test("an answer that is not HTTP, or is too long, ends the connection", async () => {
    const mail = await rawServer((socket) => socket.write("220 mail.example ESMTP\r\n"));
    const long = await rawServer((socket) => {
      const body = Buffer.alloc(9 * 1024 * 1024, 32);
      socket.once("data", () => {
        socket.write(ok("", body.length));
        socket.write(body);
      });
    });
    for (const [port, why] of [
      [mail, "does not answer as a web server does"],
      [long, "sent too long an answer"],
    ] as const) {
      const { stream, read } = readerOf(port);
      expect(await read()).toEqual({ kind: "unreadable", why });
      expect(stream.destroyed).toBe(true);
      expect(await read()).toEqual({ kind: "closed" });
    }
  });
});
