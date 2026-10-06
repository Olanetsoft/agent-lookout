import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { createCollector } from "@collector/collector";
import type { ClearHistoryResponse, EventsResponse, HistoryResponse } from "@core/api";
import type { Session } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { listen, request, type TestRequest } from "@tests/support/node/http";
import { tempDir } from "@tests/support/node/tempFiles";

const T0 = 1_791_204_000_000;

/** A collector over a source of the test's own, keeping its history in `dir`, served over real HTTP. */
async function lookout(dir: string, env: Record<string, string> = {}) {
  const state = { sessions: [] as Session[], now: T0 };
  const adapter: Adapter = {
    id: "status-files",
    label: "Status files",
    lookingIn: "Looking for sessions in a test.",
    poll: async () => ({
      health: { id: "status-files", label: "Status files", state: "ok", checkedAt: state.now },
      sessions: state.sessions,
    }),
  };
  const collector = createCollector({
    version: "9.9.9-test",
    adapters: [adapter],
    env: { AGENT_LOOKOUT_HISTORY_DIR: dir, AGENT_LOOKOUT_TMUX: "off", ...env },
    notifier: fakeSystemNotifier(),
    now: () => state.now,
    intervalMs: 1_000_000_000,
  });
  const port = await listen(createServer(collector.handler));
  collector.start();
  onTestFinished(() => collector.stop());
  await collector.whenStarted();
  await collector.poller.pollOnce();
  return {
    collector,
    port,
    async poll(atOffsetMs: number, sessions: Session[]) {
      state.now = T0 + atOffsetMs;
      state.sessions = sessions;
      await collector.poller.pollOnce();
    },
  };
}

const working = makeSession({
  id: "status-files:demo.json",
  name: "demo-project",
  status: "working",
});
const idle = makeSession({ id: "status-files:demo.json", name: "demo-project", status: "idle" });

/** What the dashboard's own page sends to clear the history. */
function fromThePage(port: number): TestRequest {
  return {
    method: "POST",
    headers: {
      Origin: `http://localhost:${port}`,
      "Sec-Fetch-Site": "same-origin",
      "X-Agent-Lookout-Action": "clear-history",
      "Content-Type": "application/json",
    },
    body: "{}",
  };
}

/** The records in every history file in the folder, by kind. */
async function recordKinds(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  const texts = await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")));
  return texts
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => Object.keys(JSON.parse(line) as object)[0] as string);
}

describe("POST /api/history/clear", () => {
  test("from the dashboard's own page it deletes the files and empties the log and the history, which begin again from then", async () => {
    const dir = await tempDir();
    const server = await lookout(dir);
    await server.poll(2_000, [working]);
    await server.poll(4_000, [idle]);
    await server.collector.history?.flush();
    expect(await recordKinds(dir)).toContain("event");

    const cleared = await request(server.port, "/api/history/clear", fromThePage(server.port));
    expect(cleared.status).toBe(200);
    expect(cleared.json<ClearHistoryResponse>()).toEqual({ ok: true, clearedAt: T0 + 4_000 });

    expect((await request(server.port, "/api/events")).json<EventsResponse>().events).toEqual([]);
    const history = (await request(server.port, "/api/history")).json<HistoryResponse>();
    expect(history.points).toEqual([]);
    expect(history.since).toEqual({ at: T0 + 4_000, by: "cleared" });
    expect(await recordKinds(dir)).toEqual(["cleared"]);

    // What happens next is kept from there, and still begins there after a restart.
    await server.poll(6_000, [working]);
    server.collector.stop();
    expect(await recordKinds(dir)).toEqual(["cleared", "event", "point"]);
    const again = await lookout(dir);
    const kept = (await request(again.port, "/api/history")).json<HistoryResponse>();
    expect(kept.since).toEqual({ at: T0 + 4_000, by: "cleared" });
  });

  test.each([
    ["a GET", { method: "GET", body: undefined }, 405],
    ["no Origin", { headers: { Origin: null } }, 403],
    ["another site's Origin", { headers: { Origin: "https://example.com" } }, 403],
    ["another site's Host", { headers: { Host: "example.com" } }, 403],
    [
      "a request the browser calls cross-site",
      { headers: { "Sec-Fetch-Site": "cross-site" } },
      403,
    ],
    ["no action header", { headers: { "X-Agent-Lookout-Action": null } }, 403],
    ["the jump's action", { headers: { "X-Agent-Lookout-Action": "jump" } }, 403],
    [
      "a form's content type",
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      415,
    ],
    ["a body too long", { body: `{${" ".repeat(100)}}` }, 413],
    ["a body that asks for more", { body: '{"before":0}' }, 400],
  ] as const)("%s is refused, and nothing is cleared", async (_case, change, status) => {
    const dir = await tempDir();
    const server = await lookout(dir);
    await server.poll(2_000, [working]);
    await server.collector.history?.flush();
    const before = await recordKinds(dir);

    const asked = fromThePage(server.port);
    const headers: Record<string, string | null> = { ...asked.headers };
    for (const [name, value] of Object.entries("headers" in change ? change.headers : {})) {
      headers[name] = value;
    }
    const response = await request(server.port, "/api/history/clear", {
      method: "method" in change ? change.method : asked.method,
      headers,
      body: "body" in change ? change.body : asked.body,
    });
    expect(response.status).toBe(status);
    expect(Object.keys(response.headers).join()).not.toContain("access-control");
    expect(await recordKinds(dir)).toEqual(before);
    expect((await request(server.port, "/api/events")).json<EventsResponse>().events).toHaveLength(
      1,
    );
  });

  test("with AGENT_LOOKOUT_HISTORY=off there is nothing on disk to clear, and it says so", async () => {
    const dir = path.join(await tempDir(), "history");
    const server = await lookout(dir, { AGENT_LOOKOUT_HISTORY: "off" });
    const response = await request(server.port, "/api/history/clear", fromThePage(server.port));
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ reason: "memory-only" });
    await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
