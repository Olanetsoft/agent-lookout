import { describe, expect, test } from "vitest";

import { CLAUDE_CODE_CAPABILITIES } from "@collector/adapters/claude-code/index";
import { CODEX_CAPABILITIES } from "@collector/adapters/codex/index";
import { STATUS_FILE_CAPABILITIES } from "@collector/adapters/status-files/index";
import {
  MAX_REMOTE_SESSIONS,
  MAX_REMOTE_SOURCES,
  readRemoteSnapshot,
} from "@collector/remotes/remoteSessions";
import { repositoryId } from "@collector/git/repository";
import { DEFAULT_TIME_RULES } from "@core/time-rules/timeRules";
import {
  NOW,
  snapshotThere,
  sourcesThere,
  waitingThere,
  workingThere,
} from "@tests/fixtures/remote";

function read(value: unknown) {
  const snapshot = readRemoteSnapshot(value, "devbox", NOW);
  if (snapshot === null) throw new Error("expected a snapshot");
  return snapshot;
}

describe("readRemoteSnapshot", () => {
  test("each session there is one here, its id after the machine's source, with the machine's name on it", () => {
    const { sessions } = read(snapshotThere());
    expect(sessions.map((session) => [session.id, session.source, session.machine])).toEqual([
      ["remote:devbox:claude-code:00000000-0000-4000-8000-0000000000aa", "remote:devbox", "devbox"],
      ["remote:devbox:status-files:night-shift.json", "remote:devbox", "devbox"],
    ]);
  });

  test("what a session is doing, where and since when is kept as it was sent, and its agent is named", () => {
    const [waiting, working] = read(snapshotThere()).sessions;
    expect(waiting).toEqual({
      id: "remote:devbox:claude-code:00000000-0000-4000-8000-0000000000aa",
      source: "remote:devbox",
      agent: "Claude Code",
      machine: "devbox",
      surface: "terminal",
      name: "demo-api",
      cwd: "/Users/example/code/demo-api",
      project: "demo-api",
      git: {
        branch: "fix-login",
        repository: {
          id: repositoryId("devbox\n0123456789abcdef0123456789abcdef"),
          name: "demo-api",
        },
      },
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "Claude needs your permission to use Bash",
      waitingText: "Run: npm test",
      startedAt: NOW - 30 * 60_000,
      statusSince: NOW - 2 * 60_000,
      alive: true,
      links: {},
      stale: false,
    });
    expect(working).toMatchObject({
      agent: "Night Shift",
      status: "working",
      lastWriteAt: NOW - 20_000,
    });
  });

  test("a session there has no Jump, no Stop, no request to answer, no link to open and no process ID here", () => {
    const { sessions } = read(snapshotThere());
    // The one waiting there was sent with all of them.
    expect(snapshotThere().sessions[0]).toMatchObject({
      jump: expect.any(Object),
      stop: expect.any(Object),
      ask: expect.any(Object),
    });
    for (const session of sessions) {
      expect(session).not.toHaveProperty("jump");
      expect(session).not.toHaveProperty("stop");
      expect(session).not.toHaveProperty("ask");
      expect(session).not.toHaveProperty("pid");
      expect(session.links).toEqual({});
    }
    expect(JSON.stringify(sessions)).not.toContain("npm run build");
  });

  test("a session there keeps its branch, but not the pull request read there, whose link would open from here", () => {
    const [waiting] = read(snapshotThere()).sessions;
    expect(waiting?.git?.branch).toBe("fix-login");
    expect(waiting?.git).not.toHaveProperty("pullRequest");
  });

  test("a repository there is never grouped with one here of the same path", () => {
    const [waiting] = read(snapshotThere()).sessions;
    expect(waiting?.git?.repository?.id).not.toBe("0123456789abcdef0123456789abcdef");
    expect(waiting?.git?.repository?.id).toMatch(/^[0-9a-f]{16,64}$/);
  });

  test("a session the other machine read from yet another is left out, with that machine's source", () => {
    const relayed = waitingThere({
      id: "remote:gpu:claude-code:1",
      source: "remote:gpu",
      machine: "gpu",
    });
    const snapshot = snapshotThere([relayed, workingThere()]);
    snapshot.sources.push({
      id: "remote:gpu",
      label: "gpu",
      machine: "gpu",
      state: "ok",
      checkedAt: NOW,
    });
    const read_ = read(snapshot);
    expect(read_.sessions.map((session) => session.id)).toEqual([
      "remote:devbox:status-files:night-shift.json",
    ]);
    expect(read_.sources.map((source) => source.label)).toEqual([
      "Claude Code",
      "Codex",
      "Status files",
    ]);
  });

  test("the other machine's time rules and its word on quiet hours are not taken, and its stale is only what it said", () => {
    const answer = {
      ...snapshotThere([workingThere({ status: "idle", statusSince: NOW - 60_000, stale: true })]),
      timeRules: {
        ...DEFAULT_TIME_RULES,
        idle: { on: true, hours: 1 },
        quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true },
      },
      quiet: true,
    };
    const taken = read(answer);
    expect(taken).not.toHaveProperty("timeRules");
    expect(taken).not.toHaveProperty("quiet");
    // What that machine said, which the poller here works out again by this computer's rule.
    expect(taken.sessions[0]?.stale).toBe(true);
  });

  test("a wait answered there is marked answered here, only while it waits and only for true", () => {
    const answered = (value: unknown, status: "needs-you" | "working" = "needs-you") =>
      read({ ...snapshotThere([]), sessions: [{ ...waitingThere({ status }), answered: value }] })
        .sessions[0];
    expect(answered(true)).toMatchObject({ status: "needs-you", answered: true });
    for (const value of [false, "true", 1, {}, null]) {
      expect(answered(value), String(value)).not.toHaveProperty("answered");
    }
    expect(answered(true, "working")).not.toHaveProperty("answered");
    expect(read(snapshotThere([waitingThere()])).sessions[0]).not.toHaveProperty("answered");
  });

  test("what a waiting session asks is kept only while it waits", () => {
    const [idle] = read(
      snapshotThere([waitingThere({ status: "idle", waitingText: "Run: npm test" })]),
    ).sessions;
    expect(idle).not.toHaveProperty("waitingText");
    expect(idle).not.toHaveProperty("waitingReason");
  });

  test("text is cleaned again, and a time that cannot be right is not known", () => {
    const [session] = read(
      snapshotThere([
        waitingThere({
          name: "demo\u0000api‮",
          waitingText: "Run:\nnpm test",
          statusSince: NOW + 24 * 60 * 60_000,
          startedAt: 12,
        }),
      ]),
    ).sessions;
    expect(session?.name).toBe("demo api");
    expect(session?.waitingText).toBe("Run: npm test");
    expect(session?.statusSince).toBeNull();
    expect(session?.startedAt).toBeNull();
  });

  test("a session with no id or no source, or an id that is not clean, is left out", () => {
    const { sessions } = read({
      generatedAt: NOW,
      sources: sourcesThere(),
      sessions: [
        { ...waitingThere(), id: undefined },
        { ...waitingThere(), source: 3 },
        { ...waitingThere(), id: "claude-code:a\u0000b" },
        "not a session",
        workingThere(),
      ],
    });
    expect(sessions.map((session) => session.id)).toEqual([
      "remote:devbox:status-files:night-shift.json",
    ]);
  });

  test(`at most ${MAX_REMOTE_SESSIONS} sessions are taken`, () => {
    const many = Array.from({ length: MAX_REMOTE_SESSIONS + 5 }, (_, index) =>
      workingThere({ id: `status-files:${index}.json` }),
    );
    expect(read(snapshotThere(many)).sessions).toHaveLength(MAX_REMOTE_SESSIONS);
  });

  test("an agent there that the other machine has no label for is named by its source", () => {
    const [session] = read({
      generatedAt: NOW,
      sources: [],
      sessions: [waitingThere({ source: "claude-code" })],
    }).sessions;
    expect(session?.agent).toBe("claude-code");
  });

  test(`at most ${MAX_REMOTE_SOURCES} sources are taken, so at most that many agents are shown`, () => {
    const [claude] = sourcesThere();
    if (!claude) throw new Error("expected a source");
    const many = Array.from({ length: MAX_REMOTE_SOURCES + 30 }, (_, index) => ({
      ...claude,
      id: `source-${index}`,
      label: `Agent ${index}`,
    }));
    const snapshot = read({ generatedAt: NOW, sources: many, sessions: [] });
    expect(snapshot.sources).toHaveLength(MAX_REMOTE_SOURCES);
    expect(snapshot.agents).toHaveLength(MAX_REMOTE_SOURCES);
    expect(snapshot.agents.at(-1)?.label).toBe(`Agent ${MAX_REMOTE_SOURCES - 1}`);
  });

  test("a source sent twice is kept once", () => {
    const sources = [...sourcesThere(), ...sourcesThere()];
    expect(read({ generatedAt: NOW, sources, sessions: [] }).sources).toHaveLength(3);
  });

  test("with what a session asks turned off here, a waiting session there keeps its reason alone", () => {
    const snapshot = readRemoteSnapshot(snapshotThere(), "devbox", NOW, { waitingText: false });
    const [waiting] = snapshot?.sessions ?? [];
    expect(waiting).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "Claude needs your permission to use Bash",
    });
    expect(waiting).not.toHaveProperty("waitingText");
  });

  test("each source there is kept as its name and its state", () => {
    expect(read(snapshotThere()).sources).toEqual([
      { label: "Claude Code", state: "ok" },
      { label: "Codex", state: "unavailable" },
      { label: "Status files", state: "ok" },
    ]);
  });

  test("each agent there that was found can report what it says, with no Jump, no Stop and no Answer", () => {
    const { agents } = read(snapshotThere());
    // Codex is not on the other machine, so it has no row.
    expect(agents.map((agent) => agent.label)).toEqual(["Claude Code", "Status files"]);
    expect(agents[0]?.capabilities).toEqual({
      ...CLAUDE_CODE_CAPABILITIES,
      jump: { level: "no", reason: "Jump acts on this computer only, not on devbox." },
      stop: { level: "no", reason: "Stop acts on this computer only, not on devbox." },
      answer: { level: "no", reason: "Answer acts on this computer only, not on devbox." },
    });
    expect(agents[1]?.capabilities["needs-you"]).toEqual(STATUS_FILE_CAPABILITIES["needs-you"]);
  });

  test("an agent there whose Agent Lookout is older, and sends no Stop or Answer, keeps its row, with both as no", () => {
    const sources = sourcesThere();
    const [claude] = sources;
    if (!claude?.capabilities) throw new Error("expected capabilities");
    const { stop: _stop, answer: _answer, ...older } = claude.capabilities;
    claude.capabilities = older as typeof claude.capabilities;
    const [agent] = read({ generatedAt: NOW, sources, sessions: [] }).agents;
    expect(agent?.label).toBe("Claude Code");
    expect(agent?.capabilities.stop.level).toBe("no");
    expect(agent?.capabilities.answer.level).toBe("no");
    expect(agent?.capabilities.names).toEqual(CLAUDE_CODE_CAPABILITIES.names);
  });

  test("an agent there whose Agent Lookout is from before token counts keeps its row, with Tokens as no, naming the machine", () => {
    const sources = sourcesThere().map((source) => ({ ...source, state: "ok" as const }));
    for (const source of sources) {
      if (!source.capabilities) throw new Error("expected capabilities");
      const { tokens: _tokens, ...older } = source.capabilities;
      source.capabilities = older as typeof source.capabilities;
    }
    const { agents } = read({ generatedAt: NOW, sources, sessions: [] });
    expect(agents.map((agent) => agent.label)).toEqual(["Claude Code", "Codex", "Status files"]);
    for (const agent of agents) {
      expect(agent.capabilities.tokens, agent.label).toEqual({
        level: "no",
        reason: "The Agent Lookout on devbox does not send token counts.",
      });
    }
    expect(agents[1]?.capabilities.names).toEqual(CODEX_CAPABILITIES.names);
  });

  test("a Tokens cell that is sent is taken as it was sent, and one that cannot be read loses the row", () => {
    const sources = sourcesThere().map((source) => ({ ...source, state: "ok" as const }));
    const { agents } = read({ generatedAt: NOW, sources, sessions: [] });
    expect(agents.map((agent) => [agent.label, agent.capabilities.tokens])).toEqual([
      ["Claude Code", CLAUDE_CODE_CAPABILITIES.tokens],
      ["Codex", { level: "yes" }],
      ["Status files", STATUS_FILE_CAPABILITIES.tokens],
    ]);

    const [claude] = sources;
    if (!claude?.capabilities) throw new Error("expected capabilities");
    claude.capabilities = {
      ...claude.capabilities,
      tokens: { level: "partly" } as unknown as typeof claude.capabilities.tokens,
    };
    expect(read({ generatedAt: NOW, sources, sessions: [] }).agents.map((a) => a.label)).toEqual([
      "Codex",
      "Status files",
    ]);
  });

  test("a session there keeps the token counts it was sent, through the same check as this machine's", () => {
    const counted = (tokens: unknown) =>
      read(snapshotThere([workingThere({ tokens } as never)])).sessions[0];

    expect(counted({ input: 182_431, cached: 141_002, output: 9_120 })?.tokens).toEqual({
      input: 182_431,
      cached: 141_002,
      output: 9_120,
    });
    expect(counted({ input: 2_048, output: 64 })?.tokens).toEqual({ input: 2_048, output: 64 });
    // Only the three counts are copied.
    expect(
      Object.keys(
        counted({ input: 2_048, cached: 0, output: 64, costUSD: 1, plan_type: "pro" })?.tokens ??
          {},
      ),
    ).toEqual(["input", "cached", "output"]);
    for (const bad of [
      { input: 0, output: 0 },
      { input: -1, output: 10 },
      { input: 10, cached: 11, output: 1 },
      { input: 10.5, output: 1 },
      { input: "10", output: 1 },
      { input: Number.MAX_SAFE_INTEGER + 1, output: 1 },
      "182431 in",
      null,
      undefined,
    ]) {
      const session = counted(bad);
      expect(session?.status, JSON.stringify(bad)).toBe("working");
      expect(session, JSON.stringify(bad)).not.toHaveProperty("tokens");
    }
  });

  test("an agent whose cells cannot all be read has no row", () => {
    const sources = sourcesThere();
    const [claude] = sources;
    if (!claude?.capabilities) throw new Error("expected capabilities");
    const { finished: _left, ...rest } = claude.capabilities;
    claude.capabilities = rest as typeof claude.capabilities;
    expect(read({ generatedAt: NOW, sources, sessions: [] }).agents.map((a) => a.label)).toEqual([
      "Status files",
    ]);
  });

  test("an answer with no list of sessions or of sources is not one", () => {
    expect(readRemoteSnapshot({ sessions: [] }, "devbox", NOW)).toBeNull();
    expect(readRemoteSnapshot({ sources: [] }, "devbox", NOW)).toBeNull();
    expect(readRemoteSnapshot([], "devbox", NOW)).toBeNull();
    expect(readRemoteSnapshot(null, "devbox", NOW)).toBeNull();
  });
});
