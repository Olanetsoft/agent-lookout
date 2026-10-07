import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { MAX_STOP_BODY_BYTES } from "@collector/actions/stopRoute";
import { createCollector, type CollectorOptions } from "@collector/collector";
import { readProcessStartsWithPs } from "@collector/processes/processStart";
import { STOP_WAIT_MS, type EventsResponse } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { listen, request, type TestRequest } from "@tests/support/node/http";
import { startStandIn, startStandInChain, type StandIn } from "@tests/support/node/standIns";
import {
  makeClaudeHome,
  NO_SETTINGS_FILE,
  tempDir,
  writeStub,
} from "@tests/support/node/tempFiles";

const HOUR = 60 * 60 * 1000;

/**
 * Stop is for macOS and Linux: its stand-ins are started with a start time from
 * ps and stopped by POSIX signals, which Windows has neither of. What Windows
 * does instead, offer no Stop and have no route, is checked at the end, on
 * every system.
 */
const posixOnly = describe.skipIf(process.platform === "win32");

/** The registry file Claude Code would write for a stand-in, working in a terminal. */
function entryFor(
  standIn: Pick<StandIn, "pid" | "procStart">,
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  return registryFile({
    pid: standIn.pid,
    sessionId: ids.busy,
    name: "checkout-flow",
    kind: "interactive",
    entrypoint: "cli",
    procStart: standIn.procStart,
    status: "busy",
    startedAt: now - 2 * HOUR,
    statusUpdatedAt: now - HOUR,
    ...overrides,
  });
}

/**
 * The collector as every host builds it, with its real Claude Code adapter
 * reading a registry folder of the test's own, real `ps`, and no tmux, tab or
 * notification of this machine. Served over real HTTP on a free loopback port.
 */
async function serve(
  files: Record<string, string>,
  env: Record<string, string> = {},
  options: Partial<CollectorOptions> = {},
) {
  const claudeHome = await makeClaudeHome(files);
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_CLAUDE_HOME: claudeHome,
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      ...env,
    },
    notifier: fakeSystemNotifier(),
    ...options,
  });
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();

  /** The request the dashboard's page makes when Stop session is pressed, changed as a test says. */
  const stop = (sessionId: unknown = `claude-code:${ids.busy}`, change: TestRequest = {}) =>
    request(port, "/api/sessions/stop", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
      ...change,
      headers: {
        Origin: `http://localhost:${port}`,
        "Content-Type": "application/json",
        "X-Agent-Lookout-Action": "stop",
        ...change.headers,
      },
    });
  const sessions = async () =>
    (await request(port, "/api/sessions")).json<SessionsSnapshot>().sessions;
  const events = async () => (await request(port, "/api/events")).json<EventsResponse>().events;
  const rewrite = (name: string, content: string) =>
    writeFile(path.join(claudeHome, "sessions", name), content);
  return { port, collector, stop, sessions, events, rewrite };
}

const named = (sessions: Session[], name: string) =>
  sessions.find((session) => session.name === name);

posixOnly("what the dashboard is told", () => {
  test("a session in a terminal can be stopped, and nothing of its process but its id reaches the page", async () => {
    const standIn = await startStandIn();
    const server = await serve({ [`${standIn.pid}.json`]: entryFor(standIn) });
    const response = await request(server.port, "/api/sessions");
    const session = named(response.json<SessionsSnapshot>().sessions, "checkout-flow");

    expect(session).toMatchObject({ pid: standIn.pid, alive: true, stop: { how: "signal" } });
    // The start time it is checked by stays with the collector.
    expect(response.body).not.toContain(standIn.procStart.replace(/\s+/g, " ").slice(0, 10));
  });

  test("with AGENT_LOOKOUT_STOP off, no session can be stopped and there is no route", async () => {
    const standIn = await startStandIn();
    const server = await serve(
      { [`${standIn.pid}.json`]: entryFor(standIn) },
      { AGENT_LOOKOUT_STOP: "off" },
    );

    expect(named(await server.sessions(), "checkout-flow")).not.toHaveProperty("stop");
    // No route answers there: the address only reads, as any other that does not act.
    const response = await server.stop();
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET");
    expect(standIn.running()).toBe(true);
  });
});

posixOnly("POST /api/sessions/stop", () => {
  test("ends the session's process with SIGTERM, and it leaves the list with a stopped event", async () => {
    const standIn = await startStandIn();
    const server = await serve({ [`${standIn.pid}.json`]: entryFor(standIn) });
    const response = await server.stop();

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(await standIn.exited).toBe("SIGTERM");
    // The route read the sessions again before it answered.
    expect(named(await server.sessions(), "checkout-flow")).toBeUndefined();
    const kinds = (await server.events()).map((event) => [event.kind, event.sessionName]);
    expect(kinds).toContainEqual(["stopped", "checkout-flow"]);
    expect(kinds).toContainEqual(["ended", "checkout-flow"]);
    const stopped = (await server.events()).find((event) => event.kind === "stopped");
    expect(stopped).toMatchObject({ from: "working", by: "agent-lookout", severity: "advisory" });
  });

  test("answers as every route does: JSON, uncacheable and with no CORS header", async () => {
    const standIn = await startStandIn();
    const server = await serve({ [`${standIn.pid}.json`]: entryFor(standIn) });
    const response = await server.stop();

    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      Object.keys(response.headers).filter((name) => name.startsWith("access-control-")),
    ).toEqual([]);
  });

  test("a process still running 10 seconds after SIGTERM is said to be, and is not signalled again", async () => {
    const standIn = await startStandIn({ ignoreTerm: true });
    // A clock that runs ahead when the route waits, so the ten seconds pass at once.
    const clock = { now: Date.now() };
    const server = await serve(
      { [`${standIn.pid}.json`]: entryFor(standIn) },
      {},
      {
        stopping: {
          now: () => clock.now,
          sleep: async (ms) => {
            clock.now += ms;
            await new Promise((resolve) => setTimeout(resolve, 1));
          },
        },
      },
    );
    const started = clock.now;
    const response = await server.stop();

    expect(response.status).toBe(202);
    expect(response.json()).toEqual({
      ok: false,
      error: "Agent Lookout asked the session to stop, and it is still running 10 seconds later.",
      reason: "still-running",
    });
    expect(clock.now - started).toBe(STOP_WAIT_MS);
    expect(standIn.running()).toBe(true);
    expect((await server.events()).map((event) => event.kind)).not.toContain("stopped");
    expect(named(await server.sessions(), "checkout-flow")).toMatchObject({ alive: true });
  });

  test("a registry file that names another session by the time Stop is pressed is not acted on", async () => {
    const standIn = await startStandIn();
    const file = `${standIn.pid}.json`;
    const server = await serve({ [file]: entryFor(standIn) });
    await server.rewrite(file, entryFor(standIn, { sessionId: ids.idle }));
    const response = await server.stop();

    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ reason: "cannot-confirm" });
    expect(standIn.running()).toBe(true);
  });

  test("a registry file whose start time is a day off by the time Stop is pressed is not acted on", async () => {
    const standIn = await startStandIn();
    const file = `${standIn.pid}.json`;
    const server = await serve({ [file]: entryFor(standIn) });
    await server.rewrite(file, entryFor(standIn, { procStart: "Mon Oct  5 09:00:00 2026" }));
    const response = await server.stop();

    expect(response.json()).toMatchObject({ reason: "cannot-confirm" });
    expect(standIn.running()).toBe(true);
  });

  test("a process ps says started at another time than the registry says is not acted on", async () => {
    const standIn = await startStandIn();
    // The registry records a start a day before this process's. The adapter is
    // told it matches, so the session is listed with a Stop; the route asks
    // `ps` itself, and ps says otherwise.
    const recorded = "Mon Oct  5 09:00:00 2026";
    const server = await serve(
      { [`${standIn.pid}.json`]: entryFor(standIn, { procStart: recorded }) },
      {},
      {
        readProcessStarts: async (pids) => new Map(pids.map((pid) => [pid, recorded])),
        stopping: { readStarts: readProcessStartsWithPs },
      },
    );
    expect(named(await server.sessions(), "checkout-flow")).toMatchObject({
      stop: { how: "signal" },
    });
    const response = await server.stop();

    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ reason: "cannot-confirm" });
    expect(standIn.running()).toBe(true);
  });

  test("a registry file that now names a helper process is not acted on", async () => {
    const standIn = await startStandIn();
    const file = `${standIn.pid}.json`;
    const server = await serve({ [file]: entryFor(standIn) });
    await server.rewrite(file, entryFor(standIn, { kind: "daemon" }));

    expect((await server.stop()).json()).toMatchObject({ reason: "unsupported" });
    expect(standIn.running()).toBe(true);
  });

  test("Agent Lookout's own process, and the one it was started from, are never stopped", async () => {
    const own = (await readProcessStartsWithPs([process.pid])).get(process.pid) as string;
    const parent = (await readProcessStartsWithPs([process.ppid])).get(process.ppid) as string;
    const server = await serve({
      [`${process.pid}.json`]: entryFor({ pid: process.pid, procStart: own }),
      [`${process.ppid}.json`]: entryFor(
        { pid: process.ppid, procStart: parent },
        { sessionId: ids.idle, name: "docs-site" },
      ),
    });

    const self = await server.stop(`claude-code:${ids.busy}`);
    expect(self.status).toBe(403);
    expect(self.json()).toMatchObject({ reason: "not-allowed" });
    // A second apart, as every stop is.
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const starter = await server.stop(`claude-code:${ids.idle}`);
    expect(starter.json()).toMatchObject({ reason: "not-allowed" });
  });

  test("a process further up, such as the session whose terminal started Agent Lookout, is never stopped", async () => {
    // A chain of three stand-ins: the first stands for the session, the second
    // for the shell in its terminal, and the third for Agent Lookout.
    const chain = await startStandInChain();
    const server = await serve(
      { [`${chain.top.pid}.json`]: entryFor(chain.top) },
      {},
      { stopping: { ownPid: chain.leaf, parentPid: chain.middle } },
    );
    expect(named(await server.sessions(), "checkout-flow")).toMatchObject({
      stop: { how: "signal" },
    });
    const response = await server.stop();

    expect(response.status).toBe(403);
    expect(response.json()).toMatchObject({ reason: "not-allowed" });
    expect(chain.top.running()).toBe(true);
  });

  test("a session in the desktop app has no Stop, and asking for one stops nothing", async () => {
    const standIn = await startStandIn();
    const server = await serve({
      [`${standIn.pid}.json`]: entryFor(standIn, { entrypoint: "claude-desktop" }),
    });

    expect(named(await server.sessions(), "checkout-flow")).not.toHaveProperty("stop");
    expect((await server.stop()).json()).toMatchObject({ reason: "unsupported" });
    expect(standIn.running()).toBe(true);
  });

  test("a session whose registry file names no kind has no Stop", async () => {
    const standIn = await startStandIn();
    const server = await serve({ [`${standIn.pid}.json`]: entryFor(standIn, { kind: undefined }) });

    expect(named(await server.sessions(), "checkout-flow")).not.toHaveProperty("stop");
    expect((await server.stop()).status).toBe(409);
    expect(standIn.running()).toBe(true);
  });

  test("a session that is not listed has gone", async () => {
    const server = await serve({});
    const response = await server.stop("claude-code:00000000-0000-4000-8000-00000000ffff");
    expect(response.status).toBe(404);
    expect(response.json()).toEqual({
      error: "That session has already ended.",
      reason: "gone",
    });
  });
});

posixOnly("a background job", () => {
  test("is stopped with claude stop and its id, and shows as stopped at once", async () => {
    const job = await startStandIn();
    const dir = await tempDir();
    const log = path.join(dir, "asked.txt");
    const stoppedFlag = path.join(dir, "stopped");
    const started = Date.now() - HOUR;
    const listing = (state: string, status?: string) =>
      JSON.stringify([
        {
          pid: job.pid,
          cwd: "/Users/example/code/demo-jobs",
          kind: "background",
          startedAt: started,
          sessionId: ids.background,
          name: "nightly-report",
          id: "7c5dcf5d",
          state,
          ...(status !== undefined && { status }),
        },
      ]);
    // A stand-in for claude: it lists the job, and `claude stop` lists it as
    // stopped and ends the job's process, as Claude Code's supervisor does,
    // which can be a moment after the command has answered.
    const claude = await writeStub(
      [
        `echo "$*" >> '${log}'`,
        'if [ "$1" = "stop" ]; then',
        `  (sleep 1; kill -TERM ${job.pid}) </dev/null >/dev/null 2>&1 &`,
        `  touch '${stoppedFlag}'`,
        "  exit 0",
        "fi",
        `if [ -f '${stoppedFlag}' ]; then echo '${listing("stopped")}'; else echo '${listing("working", "busy")}'; fi`,
      ].join("\n"),
    );
    const server = await serve(
      {
        [`${job.pid}.json`]: entryFor(job, {
          sessionId: ids.background,
          name: "nightly-report",
          kind: "bg",
          entrypoint: "sdk-cli",
          startedAt: started,
        }),
      },
      { AGENT_LOOKOUT_CLAUDE_BIN: claude },
    );
    expect(named(await server.sessions(), "nightly-report")).toMatchObject({
      status: "working",
      stop: { how: "background" },
    });

    const response = await server.stop(`claude-code:${ids.background}`);
    expect(response.status).toBe(200);
    // Run with the job's id and nothing else, and the job's process was never signalled from here.
    const asked = (await readFile(log, "utf8")).trim().split("\n");
    expect(asked.filter((line) => line.startsWith("stop"))).toEqual(["stop 7c5dcf5d"]);
    // The route answered once the job's process had gone.
    expect(job.running()).toBe(false);
    expect(await job.exited).toBe("SIGTERM");
    // The command was run again at once, so the job shows as stopped. Nothing
    // polls in this test but the route, so this is what it left.
    expect(asked.filter((line) => line.startsWith("agents"))).toHaveLength(2);
    const after = named(await server.sessions(), "nightly-report");
    expect(after).toMatchObject({ status: "finished" });
    expect(after).not.toHaveProperty("stop");
  }, 20_000);

  test("is not offered while the claude command may not be run", async () => {
    const job = await startStandIn();
    const server = await serve({
      [`${job.pid}.json`]: entryFor(job, {
        sessionId: ids.background,
        kind: "bg",
        entrypoint: "sdk-cli",
      }),
    });
    // AGENT_LOOKOUT_CLAUDE_HOME is set and AGENT_LOOKOUT_CLAUDE_BIN is not.
    const session = (await server.sessions()).find(
      (candidate) => candidate.id === `claude-code:${ids.background}`,
    );
    expect(session).toBeDefined();
    expect(session).not.toHaveProperty("stop");
    expect((await server.stop(`claude-code:${ids.background}`)).status).toBe(409);
    expect(job.running()).toBe(true);
  });
});

posixOnly("what POST /api/sessions/stop refuses", () => {
  test.each<[string, number, Record<string, string | null>, string?]>([
    ["a GET", 405, {}, "GET"],
    ["an OPTIONS, as a preflight", 405, {}, "OPTIONS"],
    ["sent to another Host", 403, { Host: "evil.example" }],
    ["sent to a name rebound to this machine", 403, { Host: "rebind.evil.example:4777" }],
    ["from a page at another site", 403, { Origin: "https://evil.example" }],
    ["from a sandboxed frame", 403, { Origin: "null" }],
    ["with no Origin, as a program that is not a browser sends", 403, { Origin: null }],
    ["the browser marks as cross-site", 403, { "Sec-Fetch-Site": "cross-site" }],
    ["the browser marks as from another port", 403, { "Sec-Fetch-Site": "same-site" }],
    ["without the header that names the action", 403, { "X-Agent-Lookout-Action": null }],
    ["whose header names the jump", 403, { "X-Agent-Lookout-Action": "jump" }],
    ["sent as a form, which needs no preflight", 415, { "Content-Type": "text/plain" }],
    ["with no content type", 415, { "Content-Type": null }],
  ])("a request %s, and the process is left alone", async (_what, status, headers, method) => {
    const standIn = await startStandIn();
    const server = await serve({ [`${standIn.pid}.json`]: entryFor(standIn) });
    const response = await server.stop(`claude-code:${ids.busy}`, {
      headers,
      ...(method !== undefined && { method }),
    });

    expect(response.status).toBe(status);
    expect(response.body).not.toContain("checkout-flow");
    expect(
      Object.keys(response.headers).filter((name) => name.startsWith("access-control-")),
    ).toEqual([]);
    expect(standIn.running()).toBe(true);
  });

  test("a body larger than the limit, whether it says so or not, and a body that says more", async () => {
    const standIn = await startStandIn();
    const server = await serve({ [`${standIn.pid}.json`]: entryFor(standIn) });
    const id = `claude-code:${ids.busy}`;
    const large = JSON.stringify({ sessionId: id, padding: "x".repeat(MAX_STOP_BODY_BYTES) });

    expect((await server.stop(id, { body: large })).status).toBe(413);
    expect(
      (await server.stop(id, { body: large, headers: { "Transfer-Encoding": "chunked" } })).status,
    ).toBe(413);
    expect(
      (await server.stop(id, { body: JSON.stringify({ sessionId: id, pid: standIn.pid }) })).status,
    ).toBe(400);
    expect(standIn.running()).toBe(true);
  });
});

describe("on Windows", () => {
  test("no session can be stopped, there is no route, and the source says why", async () => {
    const server = await serve({}, {}, { platform: "win32" });
    const response = await server.stop();
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET");
    const cleanUp = await request(server.port, "/api/sessions/clean-up", {
      method: "POST",
      body: JSON.stringify({ sessionIds: [`claude-code:${ids.busy}`] }),
      headers: {
        Origin: `http://localhost:${server.port}`,
        "Content-Type": "application/json",
        "X-Agent-Lookout-Action": "clean-up",
      },
    });
    expect(cleanUp.status).toBe(405);

    const { sources } = (await request(server.port, "/api/sessions")).json<SessionsSnapshot>();
    const claude = sources.find((source) => source.id === "claude-code");
    expect(claude?.capabilities?.stop).toEqual({
      level: "no",
      reason:
        "Not on Windows, where there is no ps to confirm a session's process by its start time, and no POSIX signal to stop it.",
    });
  });
});
