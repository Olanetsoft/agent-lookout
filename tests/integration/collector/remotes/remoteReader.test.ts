import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";

import { describe, expect, onTestFinished, test } from "vitest";

import { askRemote, readRemote } from "@collector/remotes/remoteReader";
import { snapshotThere } from "@tests/fixtures/remote";
import { closedPort, listen } from "@tests/support/node/http";
import { startStandInLookout } from "@tests/support/remotes/standIns";

/** A server that takes each connection and closes it, as ssh does when nothing listens at the far end. */
async function closesEveryConnection(): Promise<number> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

describe("readRemote", () => {
  test("reads the health, then the sessions, and nothing else", async () => {
    const lookout = await startStandInLookout(snapshotThere(), "0.2.3");
    const reading = await readRemote(lookout.port);
    expect(reading).toEqual({
      kind: "read",
      version: "0.2.3",
      snapshot: JSON.parse(JSON.stringify(snapshotThere())),
    });
    expect(lookout.requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/api/health"],
      ["GET", "/api/sessions"],
    ]);
  });

  test("nothing listening is a refusal: ssh has not signed in yet", async () => {
    expect(await readRemote(await closedPort())).toEqual({ kind: "refused" });
  });

  test("a connection closed with no answer: nothing listens on the other machine", async () => {
    expect(await readRemote(await closesEveryConnection())).toEqual({ kind: "closed" });
  });

  test("no answer in time is a timeout", async () => {
    const port = await listen(createHttpServer(() => {}));
    expect(await readRemote(port, 200)).toEqual({ kind: "timeout" });
  });

  test("an answer that is not Agent Lookout's is not read, and the sessions are not asked for", async () => {
    const asked: string[] = [];
    const port = await listen(
      createHttpServer((req, res) => {
        asked.push(req.url ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "fine" }));
      }),
    );
    expect(await readRemote(port)).toEqual({
      kind: "unreadable",
      why: "answered /api/health, but not as Agent Lookout does",
    });
    expect(asked).toEqual(["/api/health"]);
  });

  test("a status other than 200, and an answer that is not JSON, say so", async () => {
    const port = await listen(
      createHttpServer((req, res) => {
        if (req.url === "/api/health") {
          res.writeHead(404);
          res.end("not here");
        } else {
          res.writeHead(200);
          res.end("<html>");
        }
      }),
    );
    expect(await askRemote(port, "/api/health")).toEqual({
      kind: "unreadable",
      why: "answered /api/health with status 404",
    });
    expect(await askRemote(port, "/api/sessions")).toEqual({
      kind: "unreadable",
      why: "answered /api/sessions with something that is not JSON",
    });
  });
});
