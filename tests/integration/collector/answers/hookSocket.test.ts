import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import net from "node:net";
import path from "node:path";

import { expect, onTestFinished, test as anyTest, vi } from "vitest";

import { createHookSocket, HOOK_PATH, MAX_HOOK_BODY_BYTES } from "@collector/answers/hookSocket";
import type { HookReply, HookRequest } from "@collector/answers/heldAsks";
import { tempDir } from "@tests/support/node/tempFiles";

// The hook's socket is a Unix socket, which Windows does not give a path in a
// folder, so these run on macOS and Linux only.
const test = anyTest.skipIf(process.platform === "win32");

const UUID = "00000000-0000-4000-8000-000000000001";

const INPUT = {
  session_id: UUID,
  transcript_path: "/Users/example/.claude/projects/demo/x.jsonl",
  cwd: "/Users/example/code/demo",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "npm test", description: "Run the tests" },
};

const HOOK_HEADERS = {
  "Content-Type": "application/json",
  "X-Agent-Lookout-Hook": "permission-request",
};

/** Held requests that keep what they are handed, for the test to answer. */
function standInAsks() {
  const received: { request: HookRequest; reply: HookReply }[] = [];
  return {
    received,
    asks: {
      receive: vi.fn((held: HookRequest, reply: HookReply) =>
        received.push({ request: held, reply }),
      ),
      noteRequest: vi.fn(),
      dropAll: vi.fn(() => {
        for (const { reply } of received) reply.send("");
      }),
    },
  };
}

async function started(folder?: string, ownFolder?: boolean) {
  const dir = folder ?? path.join(await tempDir(), "al");
  const socketPath = path.join(dir, "answer.sock");
  const stand = standInAsks();
  const socket = createHookSocket({ socketPath, asks: stand.asks, ownFolder });
  const start = await socket.start();
  onTestFinished(() => socket.close());
  return { socket, socketPath, dir, start, ...stand };
}

/** Sends a request over the socket and gives back its answer, or the error it ended with. */
function send(
  socketPath: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath,
        method: options.method ?? "POST",
        path: options.path ?? HOOK_PATH,
        headers: options.headers ?? HOOK_HEADERS,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", (error) => resolve({ error: (error as NodeJS.ErrnoException).code ?? "" }));
    req.end(options.body ?? JSON.stringify(INPUT));
  });
}

test("the socket is this user's alone: mode 0600 in a folder of mode 0700", async () => {
  const { socketPath, dir, start } = await started();
  expect(start).toEqual({ ok: true });
  expect((await lstat(socketPath)).isSocket()).toBe(true);
  expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
});

test("Agent Lookout's own folder, when others can read it, is made this user's alone", async () => {
  const dir = path.join(await tempDir(), "al");
  await mkdir(dir, { mode: 0o755 });
  await chmod(dir, 0o755);
  const { start } = await started(dir, true);
  expect(start).toEqual({ ok: true });
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
});

test("a folder it did not make, that others can read, is left as it is, and answering is off", async () => {
  const dir = path.join(await tempDir(), "shared");
  await mkdir(dir, { mode: 0o755 });
  await chmod(dir, 0o755);
  const { start, socketPath } = await started(dir);
  expect(start).toEqual({ ok: false, problem: expect.stringContaining("Other users can open") });
  expect((await stat(dir)).mode & 0o777).toBe(0o755);
  await expect(lstat(socketPath)).rejects.toThrow();
});

test("a permission request is held, with all but what is shown let go, and answered on its own connection", async () => {
  const { socketPath, received, asks } = await started();
  const answer = send(socketPath, {});
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received[0]?.request).toEqual({
    sessionId: `claude-code:${UUID}`,
    shown: { tool: "Bash", command: "npm test", description: "Run the tests", allow: true },
  });
  expect(asks.noteRequest).toHaveBeenCalledWith(`claude-code:${UUID}`);
  received[0]?.reply.send('{"answer":true}');
  expect(await answer).toEqual({ status: 200, body: '{"answer":true}' });
});

test.each([
  ["another path", { path: "/hooks/other" }],
  ["another method", { method: "PUT" }],
  ["no hook header", { headers: { "Content-Type": "application/json" } }],
  ["a body that is not JSON", { headers: { ...HOOK_HEADERS, "Content-Type": "text/plain" } }],
  ["an Origin, as a page would send", { headers: { ...HOOK_HEADERS, Origin: "http://evil" } }],
  ["a body that does not parse", { body: "{not json" }],
  ["another hook's input", { body: JSON.stringify({ ...INPUT, hook_event_name: "Stop" }) }],
  ["a session id of another shape", { body: JSON.stringify({ ...INPUT, session_id: "../x" }) }],
])("%s is answered at once with an empty 200, and nothing is held", async (_what, options) => {
  const { socketPath, received } = await started();
  expect(await send(socketPath, options)).toEqual({ status: 200, body: "" });
  expect(received).toHaveLength(0);
});

test("a body larger than 1 MiB is answered with an empty 200 and never read whole", async () => {
  const { socketPath, received } = await started();
  const big = JSON.stringify({
    ...INPUT,
    tool_input: { content: "x".repeat(MAX_HOOK_BODY_BYTES) },
  });
  const answer = await send(socketPath, { body: big });
  // The answer comes before the body is read, so the request may end in an error instead.
  if ("status" in answer) expect(answer).toEqual({ status: 200, body: "" });
  expect(received).toHaveLength(0);
});

test("a hook that disconnects is told to its held request, which hears it closed", async () => {
  const { socketPath, received } = await started();
  const client = net.connect(socketPath);
  await new Promise((resolve) => client.once("connect", resolve));
  const body = JSON.stringify(INPUT);
  client.write(
    `POST ${HOOK_PATH} HTTP/1.1\r\nHost: agent-lookout\r\nContent-Type: application/json\r\nX-Agent-Lookout-Hook: permission-request\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  await vi.waitFor(() => expect(received).toHaveLength(1));
  const closed = vi.fn();
  received[0]?.reply.onClose(closed);
  expect(received[0]?.reply.isOpen()).toBe(true);
  client.destroy();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(received[0]?.reply.isOpen()).toBe(false);
});

test("a second copy leaves the socket of one that answers be", async () => {
  const first = await started();
  const second = createHookSocket({ socketPath: first.socketPath, asks: standInAsks().asks });
  expect(await second.start()).toEqual({
    ok: false,
    problem: "Another copy of Agent Lookout answers permission prompts on this computer.",
  });
  // The first still answers.
  expect(await send(first.socketPath, { path: "/elsewhere" })).toEqual({ status: 200, body: "" });
});

test("a leftover socket nobody answers on is replaced", async () => {
  const dir = path.join(await tempDir(), "al");
  await mkdir(dir, { mode: 0o700 });
  const socketPath = path.join(dir, "answer.sock");
  // A socket file left behind: a program of the test's own listens on it and is killed.
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write("ready"))`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolve) => child.stdout?.once("data", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  expect((await lstat(socketPath)).isSocket()).toBe(true);

  const { start } = await started(dir);
  expect(start).toEqual({ ok: true });
  expect(await send(socketPath, { path: "/elsewhere" })).toEqual({ status: 200, body: "" });
});

test("something other than a socket at the path is never removed", async () => {
  const dir = path.join(await tempDir(), "al");
  await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(dir, "answer.sock"), "a file of the person's");
  const { start } = await started(dir);
  expect(start.ok).toBe(false);
  expect((await lstat(path.join(dir, "answer.sock"))).isFile()).toBe(true);
});

test("closing lets every held request go and removes the socket", async () => {
  const { socket, socketPath, received, asks } = await started();
  const answer = send(socketPath, {});
  await vi.waitFor(() => expect(received).toHaveLength(1));
  await socket.close();
  expect(asks.dropAll).toHaveBeenCalled();
  expect(await answer).toEqual({ status: 200, body: "" });
  await expect(lstat(socketPath)).rejects.toThrow();
});
