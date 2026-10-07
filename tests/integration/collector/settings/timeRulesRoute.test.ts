import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createCollector } from "@collector/collector";
import { MAX_TIME_RULES_BODY_BYTES } from "@collector/settings/timeRulesRoute";
import type { SettingsResponse } from "@core/api";
import type { SessionsSnapshot } from "@core/sessions/session";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { statusFile } from "@tests/fixtures/statusFiles";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { listen, request, type TestRequest } from "@tests/support/node/http";
import { makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";

const HOUR = 60 * 60 * 1000;

const SET: TimeRules = {
  longWait: { on: true, minutes: 10 },
  idle: { on: true, hours: 1 },
  quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, days: ["sat", "sun"] },
};

/**
 * The collector as every host builds it, with its settings in a file of the
 * test's own, a folder of status files holding `files`, and no tmux, tab or
 * notification of this machine. Served over real HTTP on a free loopback port.
 */
async function serve(
  options: { files?: Record<string, string>; settings?: string; warned?: string[] } = {},
) {
  const dir = await tempDir();
  const settingsFile = path.join(dir, ".agent-lookout", "settings.json");
  if (options.settings !== undefined) {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, options.settings);
  }
  const statusDir = await tempDir();
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(path.join(statusDir, name), content);
  }
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: settingsFile,
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: statusDir,
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
    },
    notifier: fakeSystemNotifier(),
    warn: (line) => options.warned?.push(line),
  });
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();

  /** The request the Time rules card makes, changed as a test says. */
  const change = (rules: unknown = SET, change: TestRequest = {}) =>
    request(port, "/api/settings/time-rules", {
      method: "POST",
      body: JSON.stringify(rules),
      ...change,
      headers: {
        Origin: `http://localhost:${port}`,
        "Content-Type": "application/json",
        "X-Agent-Lookout-Action": "time-rules",
        ...change.headers,
      },
    });
  const settings = async () => (await request(port, "/api/settings")).json<SettingsResponse>();
  const snapshot = async () => {
    await collector.poller.pollOnce();
    return (await request(port, "/api/sessions")).json<SessionsSnapshot>();
  };
  return { port, collector, settingsFile, change, settings, snapshot };
}

describe("GET /api/settings", () => {
  test("with no settings file, every rule is off, and it names where they would be kept", async () => {
    const server = await serve();
    const response = await request(server.port, "/api/settings");
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      timeRules: DEFAULT_TIME_RULES,
      file: server.settingsFile,
      problem: null,
      permissionRules: [],
      permissionRulesProblem: null,
      ruleAnswers: [],
      ruleAnswersSince: expect.any(Number),
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("the rules in the file are read as the collector starts", async () => {
    const server = await serve({ settings: JSON.stringify({ timeRules: SET }) });
    expect((await server.settings()).timeRules).toEqual(SET);
  });

  test("a file that cannot be read leaves the rules off, says so at start, and in the answer", async () => {
    const warned: string[] = [];
    const server = await serve({ settings: "{ not json", warned });
    const answer = await server.settings();
    expect(answer.timeRules).toEqual(DEFAULT_TIME_RULES);
    expect(answer.problem).toMatch(
      /is not JSON that Agent Lookout can read, so the time rules and the permission rules are off/,
    );
    expect(warned).toEqual([answer.problem]);
  });

  test("it only reads: a POST to it gets 405", async () => {
    const server = await serve();
    const response = await request(server.port, "/api/settings", {
      method: "POST",
      headers: {
        Origin: `http://localhost:${server.port}`,
        "Content-Type": "application/json",
        "X-Agent-Lookout-Action": "time-rules",
      },
      body: JSON.stringify(SET),
    });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET");
  });
});

describe("POST /api/settings/time-rules", () => {
  test("puts the rules in force and saves them, in a file of mode 600 in a folder of mode 700", async () => {
    const server = await serve();
    const response = await server.change();
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, timeRules: SET });

    expect(JSON.parse(await readFile(server.settingsFile, "utf8"))).toEqual({ timeRules: SET });
    // Windows has no POSIX file modes.
    if (process.platform !== "win32") {
      expect((await stat(server.settingsFile)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(server.settingsFile))).mode & 0o777).toBe(0o700);
    }
    expect((await server.settings()).timeRules).toEqual(SET);
    // The next snapshot is made by them.
    expect((await server.snapshot()).timeRules).toEqual(SET);
  });

  test("what else the file held is kept as it was", async () => {
    const server = await serve({
      settings: JSON.stringify({ laterSetting: { on: true }, timeRules: DEFAULT_TIME_RULES }),
    });
    await server.change();
    expect(JSON.parse(await readFile(server.settingsFile, "utf8"))).toEqual({
      laterSetting: { on: true },
      timeRules: SET,
    });
  });

  test("answers as every route does: JSON, uncacheable and with no CORS header", async () => {
    const server = await serve();
    const response = await server.change();
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.headers).join()).not.toContain("access-control");
  });

  test.each<[string, TestRequest]>([
    ["from another site", { headers: { Origin: "https://evil.example" } }],
    ["without an Origin", { headers: { Origin: null } }],
    ["marked cross-site", { headers: { "Sec-Fetch-Site": "cross-site" } }],
    ["without its action", { headers: { "X-Agent-Lookout-Action": null } }],
    ["with another route's action", { headers: { "X-Agent-Lookout-Action": "stop" } }],
    ["as a form", { headers: { "Content-Type": "application/x-www-form-urlencoded" } }],
    ["to another host, as DNS rebinding sends", { headers: { Host: "evil.example" } }],
  ])("a request %s is refused, and nothing is written or changed", async (_, change) => {
    const server = await serve();
    const response = await server.change(SET, change);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await expect(stat(server.settingsFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await server.settings()).timeRules).toEqual(DEFAULT_TIME_RULES);
  });

  test("a GET to it is refused with 405, with Allow: POST", async () => {
    const server = await serve();
    const response = await request(server.port, "/api/settings/time-rules");
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("POST");
  });

  test("a body that is not the three rules is refused whole, with the sentence that says why", async () => {
    const server = await serve();
    const response = await server.change({ ...SET, file: "/etc/elsewhere" });
    expect(response.status).toBe(400);
    expect(response.json()).toEqual({
      error:
        "The body must be the three time rules, longWait, idle and quietHours, and nothing else.",
      reason: "invalid",
    });
    await expect(stat(server.settingsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a body larger than the limit is refused with 413", async () => {
    const server = await serve();
    const response = await server.change(SET, {
      body: " ".repeat(MAX_TIME_RULES_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });

  test("a change that cannot be saved is not in force, and the answer says why", async () => {
    const server = await serve();
    // A folder where the file should be, put there after Agent Lookout started.
    // The file is read again before the change, and what cannot be read is not written over.
    await mkdir(server.settingsFile, { recursive: true });
    const response = await server.change();
    expect(response.status).toBe(500);
    expect(response.json()).toEqual({
      error: `${server.settingsFile} could not be read, so it is not written over and the change was not saved. Mend or remove the file, then make the change again.`,
      reason: "not-saved",
    });
    expect((await server.settings()).timeRules).toEqual(DEFAULT_TIME_RULES);
  });
});

describe("the idle rule", () => {
  test("marks a session stale after the hours it says, in the snapshot and its history, and the built-in day again when it is off", async () => {
    const since = new Date(Date.now() - 2 * HOUR).toISOString();
    const server = await serve({
      files: { "docs.json": statusFile({ name: "docs-site", status: "idle", since }) },
    });
    const docs = (shot: SessionsSnapshot) =>
      shot.sessions.find((session) => session.name === "docs-site");

    expect(docs(await server.snapshot())?.stale).toBe(false);

    await server.change({ ...DEFAULT_TIME_RULES, idle: { on: true, hours: 1 } });
    expect(docs(await server.snapshot())?.stale).toBe(true);

    await server.change({ ...DEFAULT_TIME_RULES, idle: { on: true, hours: 3 } });
    expect(docs(await server.snapshot())?.stale).toBe(false);

    await server.change({ ...DEFAULT_TIME_RULES, idle: { on: false, hours: 1 } });
    expect(docs(await server.snapshot())?.stale).toBe(false);
  });
});
