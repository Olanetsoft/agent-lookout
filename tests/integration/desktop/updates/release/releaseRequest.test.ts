import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  downloadFile,
  fetchText,
  type AllowAddress,
} from "@desktop/updates/release/releaseRequest";
import { listen } from "@tests/support/node/http";
import { tempDir } from "@tests/support/node/tempFiles";

/** A server of the test's own on 127.0.0.1, which writes down each request it is sent. */
async function server(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: { url: string; headers: IncomingMessage["headers"] }[] = [];
  const port = await listen(
    createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      handle(req, res);
    }),
  );
  return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, requests };
}

/** Allows plain HTTP to these servers alone, standing in for GitHub's hosts. */
function allowOnly(...hosts: string[]): AllowAddress {
  return (url) => url.protocol === "http:" && hosts.includes(url.host);
}

const USER_AGENT = "Agent-Lookout/0.2.0";
const MANIFEST = "version: 0.2.1\nfiles: []\n";

describe("fetchText", () => {
  test("follows GitHub's two redirects, to the tag and then to the file's host", async () => {
    const assets = await server((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(MANIFEST);
    });
    const releases = await server((req, res) => {
      if (req.url === "/latest/download/latest-mac.yml") {
        res.writeHead(302, { Location: "/download/v0.2.1/latest-mac.yml" });
      } else {
        res.writeHead(302, { Location: `${assets.origin}/asset/1?sig=abc` });
      }
      res.end();
    });

    const answer = await fetchText(`${releases.origin}/latest/download/latest-mac.yml`, {
      userAgent: USER_AGENT,
      allow: allowOnly(releases.host, assets.host),
      maxBytes: 1024,
    });
    expect(answer).toEqual({ ok: true, value: MANIFEST });
    expect(releases.requests.map((r) => r.url)).toEqual([
      "/latest/download/latest-mac.yml",
      "/download/v0.2.1/latest-mac.yml",
    ]);
    expect(assets.requests.map((r) => r.url)).toEqual(["/asset/1?sig=abc"]);
    // It says what it is and its version, and nothing else of this machine.
    for (const { headers } of [...releases.requests, ...assets.requests]) {
      expect(headers["user-agent"]).toBe(USER_AGENT);
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(Object.keys(headers).sort()).toEqual(["accept", "connection", "host", "user-agent"]);
    }
  });

  test("refuses a redirect to a host it does not go to, and never asks it", async () => {
    const elsewhere = await server((_req, res) => res.end(MANIFEST));
    const releases = await server((_req, res) => {
      res.writeHead(302, { Location: `${elsewhere.origin}/latest-mac.yml` });
      res.end();
    });
    const answer = await fetchText(`${releases.origin}/latest-mac.yml`, {
      userAgent: USER_AGENT,
      allow: allowOnly(releases.host),
      maxBytes: 1024,
    });
    expect(answer).toEqual({ ok: false, failure: "refused", status: 302 });
    expect(elsewhere.requests).toEqual([]);
  });

  test("asks nothing of an address it does not go to, plain HTTP to GitHub's own host included", async () => {
    const releases = await server((_req, res) => res.end(MANIFEST));
    expect(
      await fetchText(`${releases.origin}/latest-mac.yml`, { userAgent: USER_AGENT, maxBytes: 1024 }),
    ).toEqual({ ok: false, failure: "refused" });
    expect(releases.requests).toEqual([]);
  });

  test("gives up after five redirects", async () => {
    const releases = await server((req, res) => {
      res.writeHead(302, { Location: `${req.url}x` });
      res.end();
    });
    const answer = await fetchText(`${releases.origin}/loop`, {
      userAgent: USER_AGENT,
      allow: allowOnly(releases.host),
      maxBytes: 1024,
    });
    expect(answer).toEqual({ ok: false, failure: "too-many-redirects" });
    expect(releases.requests).toHaveLength(6);
  });

  test("a 404 is no such file, and another status is said as it is", async () => {
    const releases = await server((req, res) => {
      res.writeHead(req.url === "/missing" ? 404 : 503);
      res.end("nothing here");
    });
    const options = { userAgent: USER_AGENT, allow: allowOnly(releases.host), maxBytes: 1024 };
    expect(await fetchText(`${releases.origin}/missing`, options)).toEqual({
      ok: false,
      failure: "not-found",
      status: 404,
    });
    expect(await fetchText(`${releases.origin}/busy`, options)).toEqual({
      ok: false,
      failure: "status",
      status: 503,
    });
  });

  test("stops at its size limit, whether the answer says its length or not", async () => {
    const releases = await server((req, res) => {
      if (req.url === "/said") res.writeHead(200, { "Content-Length": "5000" });
      else res.writeHead(200);
      res.end("x".repeat(5000));
    });
    const options = { userAgent: USER_AGENT, allow: allowOnly(releases.host), maxBytes: 1024 };
    expect(await fetchText(`${releases.origin}/said`, options)).toEqual({
      ok: false,
      failure: "too-large",
    });
    expect(await fetchText(`${releases.origin}/chunked`, options)).toEqual({
      ok: false,
      failure: "too-large",
    });
  });

  test("gives up on an answer that does not come in time", async () => {
    const releases = await server(() => {
      // Never answers.
    });
    const answer = await fetchText(`${releases.origin}/latest-mac.yml`, {
      userAgent: USER_AGENT,
      allow: allowOnly(releases.host),
      maxBytes: 1024,
      timeoutMs: 200,
    });
    expect(answer).toEqual({ ok: false, failure: "timed-out" });
  });
});

describe("downloadFile", () => {
  const BYTES = Buffer.from("the bytes of a made-up release zip, ".repeat(2000));
  const FILE = {
    name: "Agent-Lookout-0.2.1-mac-arm64.zip",
    size: BYTES.byteLength,
    sha512: createHash("sha512").update(BYTES).digest("base64"),
  };

  async function release(body: Buffer, headers: Record<string, string> = {}) {
    return server((_req, res) => {
      res.writeHead(200, headers);
      // In pieces, as a large file comes.
      res.write(body.subarray(0, 1000));
      setTimeout(() => res.end(body.subarray(1000)), 5);
    });
  }

  test("writes the file and checks its size and SHA-512 as it arrives, telling its progress", async () => {
    const releases = await release(BYTES, { "Content-Length": String(BYTES.byteLength) });
    const file = path.join(await tempDir(), FILE.name);
    const progress: number[] = [];
    const answer = await downloadFile(`${releases.origin}/zip`, file, FILE, {
      userAgent: USER_AGENT,
      allow: allowOnly(releases.host),
      onProgress: (received, total) => {
        expect(total).toBe(FILE.size);
        progress.push(received);
      },
    });
    expect(answer).toEqual({ ok: true, value: undefined });
    expect(await readFile(file)).toEqual(BYTES);
    expect(progress.at(-1)).toBe(FILE.size);
    expect(progress.length).toBeGreaterThan(1);
  });

  test("a file with a byte changed does not match", async () => {
    const changed = Buffer.from(BYTES);
    changed[100] = changed[100]! ^ 1;
    const releases = await release(changed);
    const file = path.join(await tempDir(), FILE.name);
    expect(
      await downloadFile(`${releases.origin}/zip`, file, FILE, {
        userAgent: USER_AGENT,
        allow: allowOnly(releases.host),
      }),
    ).toEqual({ ok: false, failure: "wrong-hash" });
  });

  test("a file shorter or longer than the release says is refused", async () => {
    const options = { userAgent: USER_AGENT, allow: () => true };
    const short = await release(BYTES.subarray(0, BYTES.byteLength - 10));
    expect(
      await downloadFile(`${short.origin}/zip`, path.join(await tempDir(), FILE.name), FILE, options),
    ).toEqual({ ok: false, failure: "wrong-size" });
    const long = await release(Buffer.concat([BYTES, Buffer.from("more")]));
    expect(
      await downloadFile(`${long.origin}/zip`, path.join(await tempDir(), FILE.name), FILE, options),
    ).toEqual({ ok: false, failure: "too-large" });
    const said = await release(BYTES, { "Content-Length": String(BYTES.byteLength + 1) });
    expect(
      await downloadFile(`${said.origin}/zip`, path.join(await tempDir(), FILE.name), FILE, options),
    ).toEqual({ ok: false, failure: "too-large" });
  });

  test("never writes over a file that is there already", async () => {
    const releases = await release(BYTES);
    const file = path.join(await tempDir(), FILE.name);
    await writeFile(file, "already here");
    expect(
      await downloadFile(`${releases.origin}/zip`, file, FILE, {
        userAgent: USER_AGENT,
        allow: allowOnly(releases.host),
      }),
    ).toEqual({ ok: false, failure: "not-saved" });
    expect(await readFile(file, "utf8")).toBe("already here");
  });

  test("a download that stalls is given up", async () => {
    const releases = await server((_req, res) => {
      res.writeHead(200);
      res.write(BYTES.subarray(0, 100));
      // And no more.
    });
    const file = path.join(await tempDir(), FILE.name);
    expect(
      await downloadFile(`${releases.origin}/zip`, file, FILE, {
        userAgent: USER_AGENT,
        allow: allowOnly(releases.host),
        timeoutMs: 200,
      }),
    ).toEqual({ ok: false, failure: "timed-out" });
    expect(existsSync(file)).toBe(true);
  });

  test("a download that keeps coming, too slowly to end in time, is given up as too slow", async () => {
    const releases = await server((_req, res) => {
      res.writeHead(200);
      // A few bytes at a time, never long enough apart to stall.
      let sent = 0;
      const drip = setInterval(() => {
        if (res.destroyed || sent >= BYTES.byteLength) {
          clearInterval(drip);
          return;
        }
        res.write(BYTES.subarray(sent, sent + 10));
        sent += 10;
      }, 20);
    });
    const file = path.join(await tempDir(), FILE.name);
    expect(
      await downloadFile(`${releases.origin}/zip`, file, FILE, {
        userAgent: USER_AGENT,
        allow: allowOnly(releases.host),
        timeoutMs: 1_000,
        timeLimitMs: 300,
      }),
    ).toEqual({ ok: false, failure: "too-slow" });
  });
});
