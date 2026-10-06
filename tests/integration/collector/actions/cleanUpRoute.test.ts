import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createCollector } from "@collector/collector";
import type { CleanUpResponse, EventsResponse } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { listen, request } from "@tests/support/node/http";
import { startStandIn, type StandIn } from "@tests/support/node/standIns";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

const HOUR = 60 * 60 * 1000;

/** A session left running: idle for a day and an hour, in VS Code, its process this stand-in. */
function leftRunning(
  standIn: StandIn,
  sessionId: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  return registryFile({
    pid: standIn.pid,
    sessionId,
    name,
    kind: "interactive",
    entrypoint: "claude-vscode",
    procStart: standIn.procStart,
    status: "idle",
    startedAt: now - 30 * HOUR,
    statusUpdatedAt: now - 25 * HOUR,
    ...overrides,
  });
}

async function serve(files: Record<string, string>) {
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
    },
    notifier: fakeSystemNotifier(),
  });
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();

  const sessions = async () =>
    (await request(port, "/api/sessions")).json<SessionsSnapshot>().sessions;
  /** The request End sends, for these sessions as the page shows them. */
  const cleanUp = (shown: readonly Pick<Session, "id" | "statusSince">[]) =>
    request(port, "/api/sessions/clean-up", {
      method: "POST",
      body: JSON.stringify({
        sessions: shown.map((session) => ({
          sessionId: session.id,
          statusSince: session.statusSince,
        })),
      }),
      headers: {
        Origin: `http://localhost:${port}`,
        "Content-Type": "application/json",
        "X-Agent-Lookout-Action": "clean-up",
      },
    });
  const rewrite = (name: string, content: string) =>
    writeFile(path.join(claudeHome, "sessions", name), content);
  const events = async () => (await request(port, "/api/events")).json<EventsResponse>().events;
  return { port, sessions, cleanUp, rewrite, events };
}

describe("POST /api/sessions/clean-up", () => {
  test("ends the sessions left running, and never one that became active after the page listed it", async () => {
    const first = await startStandIn();
    const second = await startStandIn();
    const server = await serve({
      [`${first.pid}.json`]: leftRunning(first, ids.idle, "docs-site"),
      [`${second.pid}.json`]: leftRunning(second, ids.busy, "checkout-flow"),
    });
    const shown = await server.sessions();
    expect(shown.map((session) => [session.name, session.stale, session.stop])).toEqual(
      expect.arrayContaining([
        ["docs-site", true, { how: "signal" }],
        ["checkout-flow", true, { how: "signal" }],
      ]),
    );

    // Between the page drawing its list and the press, the second starts working again.
    await server.rewrite(
      `${second.pid}.json`,
      leftRunning(second, ids.busy, "checkout-flow", {
        status: "busy",
        statusUpdatedAt: Date.now(),
      }),
    );
    const response = await server.cleanUp(shown);

    expect(response.status).toBe(200);
    expect(response.json<CleanUpResponse>().results).toEqual(
      expect.arrayContaining([
        { sessionId: `claude-code:${ids.idle}`, outcome: "ended" },
        { sessionId: `claude-code:${ids.busy}`, outcome: "became-active" },
      ]),
    );
    expect(await first.exited).toBe("SIGTERM");
    expect(second.running()).toBe(true);

    const after = await server.sessions();
    expect(after.map((session) => session.name)).toEqual(["checkout-flow"]);
    const stopped = (await server.events()).filter((event) => event.kind === "stopped");
    expect(stopped.map((event) => event.sessionName)).toEqual(["docs-site"]);
  });

  test("a session that went idle again in between is left running too", async () => {
    const standIn = await startStandIn();
    const file = `${standIn.pid}.json`;
    const server = await serve({ [file]: leftRunning(standIn, ids.idle, "docs-site") });
    const shown = await server.sessions();

    // It did something, and is idle again, since a little after it was listed.
    await server.rewrite(
      file,
      leftRunning(standIn, ids.idle, "docs-site", {
        statusUpdatedAt: Date.now() - 25 * HOUR + 5_000,
      }),
    );
    const response = await server.cleanUp(shown);

    expect(response.json<CleanUpResponse>().results).toEqual([
      { sessionId: `claude-code:${ids.idle}`, outcome: "became-active" },
    ]);
    expect(standIn.running()).toBe(true);
  });

  test("a request from anywhere but the dashboard's own page ends nothing", async () => {
    const standIn = await startStandIn();
    const server = await serve({
      [`${standIn.pid}.json`]: leftRunning(standIn, ids.idle, "docs-site"),
    });
    const shown = await server.sessions();
    const body = JSON.stringify({
      sessions: shown.map((session) => ({
        sessionId: session.id,
        statusSince: session.statusSince,
      })),
    });

    const tries: Record<string, string>[] = [
      {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
        "X-Agent-Lookout-Action": "clean-up",
      },
      { "Content-Type": "application/json", "X-Agent-Lookout-Action": "clean-up" },
      {
        Origin: `http://localhost:${server.port}`,
        "Content-Type": "text/plain",
        "X-Agent-Lookout-Action": "clean-up",
      },
      {
        Origin: `http://localhost:${server.port}`,
        "Content-Type": "application/json",
        "X-Agent-Lookout-Action": "stop",
      },
    ];
    for (const headers of tries) {
      const response = await request(server.port, "/api/sessions/clean-up", {
        method: "POST",
        body,
        headers,
      });
      expect(response.status).toBeGreaterThanOrEqual(403);
    }
    expect(standIn.running()).toBe(true);
  });
});
