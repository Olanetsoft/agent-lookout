import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { NEEDS_YOU_NOTE } from "@collector/adapters/codex/index";
import { createCollector } from "@collector/collector";
import type { SessionsSnapshot } from "@core/session";
import { fixtureSessions, NOW } from "@tests/fixtures/codex";
import { listen, request } from "@tests/support/http";
import { CODEX_FIXTURE_HOME, makeClaudeHome, tempDir } from "@tests/support/tempFiles";

/**
 * A collector built the way every host builds it, with its default adapters,
 * and settings that name nothing on this machine: an empty Claude Code folder,
 * which on its own keeps the claude command from being run, and a Codex folder
 * of the test's choosing. Served over real HTTP on a free loopback port.
 */
async function serve(codex: Record<string, string>) {
  const collector = createCollector({
    version: "9.9.9-test",
    env: { AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(), ...codex },
    now: () => NOW,
  });
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();
  return (await request(port, "/api/sessions")).json<SessionsSnapshot>();
}

describe("createCollector", () => {
  test("watches Claude Code and Codex, and lists Codex sessions beside Claude Code's", async () => {
    const snapshot = await serve({ AGENT_LOOKOUT_CODEX_HOME: CODEX_FIXTURE_HOME });

    expect(snapshot.sources.map((source) => [source.id, source.label, source.state])).toEqual([
      ["claude-code", "Claude Code", "ok"],
      ["codex", "Codex", "ok"],
    ]);
    // The folder is written from ~ when the repository sits in the home folder.
    expect(snapshot.sources[1]?.detail).toMatch(
      /^Sessions are read from the files Codex saves in \S+\/fixtures\/codex-home\/sessions\. /,
    );
    expect(snapshot.sources[1]?.detail).toContain(NEEDS_YOU_NOTE);
    expect(
      snapshot.sessions
        .map((session) => [session.id, session.source, session.name, session.status])
        .sort(),
    ).toEqual(
      fixtureSessions.map((session) => [session.id, "codex", session.name, session.status]).sort(),
    );
    expect(snapshot.sessions.some((session) => session.status === "needs-you")).toBe(false);
  });

  test("with no Codex there, Codex is not found and Claude Code is read as before", async () => {
    const missing = path.join(await tempDir(), "no-codex-here");
    const snapshot = await serve({ CODEX_HOME: missing });

    expect(snapshot.sources).toMatchObject([
      { id: "claude-code", state: "ok" },
      {
        id: "codex",
        label: "Codex",
        state: "unavailable",
        detail: `Codex was not found: CODEX_HOME is set to ${missing}, and there is no folder there. Agent Lookout looks again every minute.`,
      },
    ]);
    expect(snapshot.sources[1]).not.toHaveProperty("advice");
    expect(snapshot.sessions).toEqual([]);
  });
});
