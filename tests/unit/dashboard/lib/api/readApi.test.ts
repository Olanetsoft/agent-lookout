import { describe, expect, test } from "vitest";

import {
  readEmailStatus,
  readEvents,
  readHistory,
  readPullRequestsStatus,
  readSession,
  readSettings,
  readSnapshot,
  readSource,
  readWaits,
  readWebhookStatus,
} from "@dashboard/lib/api/readApi";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { makeSession } from "@tests/fixtures/session";

const T = 1_700_000_000_000;

test("a well-formed session is read as it was sent", () => {
  const sent = makeSession({
    status: "needs-you",
    waitingReason: "permission",
    waitingDetail: "permission prompt",
    waitingText: "Run: npm test",
    surface: "vscode",
    pid: 4242,
    alive: true,
    links: { open: "vscode://anthropic.claude-code/open?session=abc" },
    stale: false,
  });

  expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
});

test("a session in a wait Agent Lookout answered is read as answered, and only on true while it waits", () => {
  const sent = makeSession({ status: "needs-you", waitingReason: "permission", answered: true });
  expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  for (const answered of ["true", 1, {}, false]) {
    expect(readSession({ ...sent, answered }), String(answered)).not.toHaveProperty("answered");
  }
  expect(readSession({ ...sent, status: "working" })).not.toHaveProperty("answered");
});

test("a session from a status file keeps its agent's name, as text and only as text", () => {
  const sent = makeSession({
    id: "status-files:night-shift.json",
    source: "status-files",
    agent: "Night Shift",
    surface: "unknown",
    name: "checkout-flow",
  });
  expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);

  for (const agent of [undefined, "", "   ", 7, { name: "Night Shift" }, ["Night Shift"]]) {
    expect(readSession({ ...sent, agent }), String(agent)).not.toHaveProperty("agent");
  }
});

test("a name that is not text falls back to the folder, then to the id", () => {
  const base = { ...makeSession(), name: { a: 1 } };

  expect(readSession(base)?.name).toBe("demo");
  expect(readSession({ ...base, project: null })?.name).toBe(base.id);
  expect(readSession({ ...base, name: "   ", project: 7 })?.name).toBe(base.id);
});

test("missing links become no links, and a link that is not text is dropped", () => {
  const { links: _links, ...withoutLinks } = makeSession();

  expect(readSession(withoutLinks)?.links).toEqual({});
  expect(readSession({ ...withoutLinks, links: null })?.links).toEqual({});
  expect(readSession({ ...withoutLinks, links: "vscode://x" })?.links).toEqual({});
  expect(readSession({ ...withoutLinks, links: { open: 42 } })?.links).toEqual({});
  expect(readSession({ ...withoutLinks, links: { open: ["a"] } })?.links).toEqual({});
});

test("a place the collector can take the person to is read when it is a tmux pane named in a short text", () => {
  const sent = makeSession({ pid: 4242, alive: true, jump: { kind: "tmux", place: "work:2.1" } });
  expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);

  // Whatever else the answer holds beside the place is not kept.
  const padded = { ...sent, jump: { kind: "tmux", place: "work:2.1", pane: "%7", run: "x" } };
  expect(readSession(padded)?.jump).toEqual({ kind: "tmux", place: "work:2.1" });
});

test("a tab of Terminal or iTerm2 is read when it names an app this page knows", () => {
  for (const app of ["Terminal", "iTerm2"] as const) {
    const sent = makeSession({
      pid: 4242,
      alive: true,
      jump: { kind: "terminal", app, place: app },
    });
    expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  }

  // A terminal device beside the app is not kept, should one ever be sent.
  const padded = {
    ...makeSession(),
    jump: { kind: "terminal", app: "Terminal", place: "Terminal", tty: "/dev/ttys004" },
  };
  expect(readSession(padded)?.jump).toEqual({
    kind: "terminal",
    app: "Terminal",
    place: "Terminal",
  });
});

test.each([
  ["nothing", undefined],
  ["null", null],
  ["a text", "tmux, work:2.1"],
  ["a tab of an app this page does not know", { kind: "terminal", app: "Warp", place: "Warp" }],
  ["a tab that names no app", { kind: "terminal", place: "Terminal" }],
  ["a tab with no place", { kind: "terminal", app: "Terminal" }],
  ["a list", [{ kind: "tmux", place: "work:2.1" }]],
  ["a kind this page does not know", { kind: "iterm", place: "work:2.1" }],
  ["no kind", { place: "work:2.1" }],
  ["no place", { kind: "tmux" }],
  ["an empty place", { kind: "tmux", place: "  " }],
  ["a place that is not text", { kind: "tmux", place: 21 }],
  ["a place too long to be one", { kind: "tmux", place: "x".repeat(201) }],
])("a jump that is %s is no jump, and the session is still read", (_what, jump) => {
  const read = readSession({ ...makeSession(), jump });

  expect(read?.id).toBe(makeSession().id);
  expect(read && "jump" in read).toBe(false);
});

test("a branch or a commit a session's folder has checked out is read as it was sent", () => {
  for (const git of [
    { branch: "checkout-flow" },
    { branch: "<b>fix/rate-limits</b>" },
    { branch: "b".repeat(200) },
    { commit: "3f9a2c1" },
  ]) {
    const sent = makeSession({ git });
    expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  }
});

test.each([
  ["nothing", undefined],
  ["null", null],
  ["a text", "checkout-flow"],
  ["an empty branch", { branch: "  " }],
  ["a branch that is not text", { branch: 7 }],
  ["a branch too long to be one", { branch: "b".repeat(201) }],
  ["a commit that is not an ID", { commit: "checkout" }],
  ["a commit too short", { commit: "3f9a2c" }],
  ["a commit in capitals", { commit: "3F9A2C1" }],
  ["both at once", { branch: "main", commit: "3f9a2c1" }],
  ["neither", { tag: "v1.0.0" }],
])("a git head that is %s is none, and the session is still read", (_what, git) => {
  const read = readSession({ ...makeSession(), git });

  expect(read?.id).toBe(makeSession().id);
  expect(read && "git" in read).toBe(false);
});

test("the repository a folder belongs to is read as it was sent, with its branch or its commit", () => {
  const repository = { id: "9aaa5f0ab35a5f84", name: "storefront" };
  for (const git of [
    { branch: "checkout-flow", repository },
    { commit: "3f9a2c1", repository },
    { branch: "main", repository: { id: "7ba69a8b81747824", name: "<b>docs</b>" } },
  ]) {
    const sent = makeSession({ git });
    expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  }
});

test.each([
  ["not a record", "storefront"],
  ["without an id", { name: "storefront" }],
  ["with an id that is a path", { id: "/Users/example/code/storefront", name: "storefront" }],
  ["with an id too short", { id: "9aaa5f0a", name: "storefront" }],
  ["with an id in capitals", { id: "9AAA5F0AB35A5F84", name: "storefront" }],
  ["without a name", { id: "9aaa5f0ab35a5f84" }],
  ["with an empty name", { id: "9aaa5f0ab35a5f84", name: " " }],
  ["with a name too long to be one", { id: "9aaa5f0ab35a5f84", name: "s".repeat(201) }],
])("a repository %s is none, and the branch is still read", (_what, repository) => {
  const read = readSession({ ...makeSession(), git: { branch: "checkout-flow", repository } });

  expect(read?.git).toEqual({ branch: "checkout-flow" });
});

const PULL_REQUEST = {
  number: 51,
  title: "Show the pull request and its checks",
  state: "open",
  checks: { state: "failing", passing: 4, failing: 2, pending: 1 },
  url: "https://github.com/example-org/storefront/pull/51",
} as const;

test("a branch's pull request is read as it was sent", () => {
  const sent = makeSession({
    git: {
      branch: "checkout-flow",
      repository: { id: "9aaa5f0ab35a5f84", name: "storefront" },
      pullRequest: PULL_REQUEST,
    },
  });
  expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  for (const state of ["draft", "merged", "closed"] as const) {
    const other = makeSession({
      git: { branch: "checkout-flow", pullRequest: { ...PULL_REQUEST, state } },
    });
    expect(readSession(JSON.parse(JSON.stringify(other)))?.git?.pullRequest?.state).toBe(state);
  }
});

test.each([
  ["not a record", "51"],
  ["without a number", { ...PULL_REQUEST, number: undefined }],
  ["with a number that is not one", { ...PULL_REQUEST, number: 5.1 }],
  ["with an empty title", { ...PULL_REQUEST, title: " " }],
  ["with a title too long to be one", { ...PULL_REQUEST, title: "t".repeat(201) }],
  ["with a state it cannot have", { ...PULL_REQUEST, state: "locked" }],
  [
    "with counts that are not counts",
    { ...PULL_REQUEST, checks: { ...PULL_REQUEST.checks, failing: -1 } },
  ],
  [
    "with checks failing that no count says failed",
    { ...PULL_REQUEST, checks: { state: "failing", passing: 3, failing: 0, pending: 0 } },
  ],
  [
    "with checks in a state it cannot have",
    { ...PULL_REQUEST, checks: { ...PULL_REQUEST.checks, state: "red" } },
  ],
  ["with a link to another site", { ...PULL_REQUEST, url: "https://example.net/pull/51" }],
  [
    "with a link to another pull request",
    { ...PULL_REQUEST, url: "https://github.com/example-org/storefront/pull/52" },
  ],
  ["with a link that runs script", { ...PULL_REQUEST, url: "javascript:alert(1)" }],
])("a pull request %s is none, and the branch is still read", (_what, pullRequest) => {
  const read = readSession({ ...makeSession(), git: { branch: "checkout-flow", pullRequest } });
  expect(read?.git).toEqual({ branch: "checkout-flow" });
});

test("a commit has no pull request", () => {
  const read = readSession({
    ...makeSession(),
    git: { commit: "3f9a2c1", pullRequest: PULL_REQUEST },
  });
  expect(read?.git).toEqual({ commit: "3f9a2c1" });
});

test("a repository with no branch or commit is no git at all", () => {
  const read = readSession({
    ...makeSession(),
    git: { repository: { id: "9aaa5f0ab35a5f84", name: "storefront" } },
  });

  expect(read && "git" in read).toBe(false);
});

test("when the agent last wrote is read as it was sent, and is none when it is not a number", () => {
  const sent = makeSession({ status: "working", lastWriteAt: T - 12 * 60_000 });
  expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);

  for (const lastWriteAt of [undefined, null, "12m", Number.NaN, {}]) {
    const read = readSession({ ...makeSession({ status: "working" }), lastWriteAt });
    expect(read?.status).toBe("working");
    expect(read && "lastWriteAt" in read).toBe(false);
  }
});

test("a surface or status the page does not know is read as unknown, not dropped", () => {
  const read = readSession({ ...makeSession(), surface: "tmux", status: "paused" });

  expect(read?.surface).toBe("unknown");
  expect(read?.status).toBe("unknown");
});

test("fields of the wrong kind become not known, never a guess", () => {
  const read = readSession({
    ...makeSession(),
    cwd: 12,
    project: {},
    startedAt: "yesterday",
    statusSince: Number.NaN,
    stale: "yes",
    pid: "4242",
    alive: 1,
  });

  expect(read).toMatchObject({
    cwd: null,
    project: null,
    startedAt: null,
    statusSince: null,
    stale: false,
  });
  expect(read).not.toHaveProperty("pid");
  expect(read).not.toHaveProperty("alive");
});

test("a waiting reason is kept only on a session that needs the person, and only if known", () => {
  const waiting = { ...makeSession(), status: "needs-you" };

  expect(readSession({ ...waiting, waitingReason: "question" })?.waitingReason).toBe("question");
  expect(readSession({ ...waiting, waitingReason: "bored" })).not.toHaveProperty("waitingReason");
  expect(readSession({ ...waiting, waitingDetail: 5 })).not.toHaveProperty("waitingDetail");
  expect(
    readSession({ ...makeSession(), status: "idle", waitingReason: "question" }),
  ).not.toHaveProperty("waitingReason");
});

test("what a waiting session is asking is kept as text, and only on a session that needs the person", () => {
  const waiting = { ...makeSession(), status: "needs-you", waitingReason: "question" };

  expect(readSession({ ...waiting, waitingText: "Which port?" })?.waitingText).toBe("Which port?");
  for (const value of [5, "", "   ", null, ["Which port?"], { text: "Which port?" }]) {
    expect(readSession({ ...waiting, waitingText: value })).not.toHaveProperty("waitingText");
  }
  expect(
    readSession({ ...makeSession(), status: "working", waitingText: "Run: npm test" }),
  ).not.toHaveProperty("waitingText");
});

test.each([
  null,
  undefined,
  "session",
  7,
  [],
  {},
  { id: "claude-code:1" },
  { source: "claude-code" },
])("%j cannot be told apart from other sessions, so it is left out", (value) => {
  expect(readSession(value)).toBeNull();
});

test("a snapshot keeps the sessions it can read and leaves out the rest", () => {
  const snapshot = readSnapshot({
    generatedAt: T,
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T }],
    sessions: [
      makeSession({ id: "claude-code:1", name: "first" }),
      "not a session",
      { ...makeSession({ id: "claude-code:2" }), name: { a: 1 }, links: undefined },
      null,
      // The same id twice would be drawn twice with one key.
      makeSession({ id: "claude-code:1", name: "again" }),
    ],
  });

  expect(snapshot?.sessions.map((session) => session.id)).toEqual([
    "claude-code:1",
    "claude-code:2",
  ]);
  expect(snapshot?.sessions.map((session) => session.name)).toEqual(["first", "demo"]);
  expect(snapshot?.sessions[1]?.links).toEqual({});
});

test.each([
  null,
  [],
  "<!doctype html>",
  { sessions: "none", sources: [], generatedAt: T },
  { sessions: [], sources: {}, generatedAt: T },
  { sessions: [], sources: [] },
  { sessions: [], sources: [], generatedAt: "now" },
])("%j is not a snapshot", (data) => {
  expect(readSnapshot(data)).toBeNull();
});

test("a source keeps its sentence, and a state the page does not know is not called healthy", () => {
  expect(
    readSource(
      { id: "claude-code", label: "Claude Code", state: "ok", detail: "Fine.", checkedAt: T },
      0,
    ),
  ).toEqual({
    id: "claude-code",
    label: "Claude Code",
    state: "ok",
    detail: "Fine.",
    checkedAt: T,
  });

  expect(
    readSource({ id: "status-files", label: "Status files", state: "not-set-up", checkedAt: T }, 0)
      ?.state,
  ).toBe("not-set-up");

  const odd = readSource({ id: "claude-code", label: 9, state: "paused", detail: {} }, T);
  expect(odd).toEqual({ id: "claude-code", label: "claude-code", state: "error", checkedAt: T });
  expect(readSource({ label: "No id" }, T)).toBeNull();
});

test("a source keeps what it is watching, as labels and values, and what to do about a problem", () => {
  const source = readSource(
    {
      id: "claude-code",
      label: "Claude Code",
      state: "unavailable",
      detail: "Claude Code sessions could not be read.",
      watching: [
        { label: "Registry folder", value: "~/.claude/sessions" },
        { label: "Command run", value: "every 30 seconds" },
      ],
      advice: "Correct AGENT_LOOKOUT_CLAUDE_BIN, or unset it.",
      checkedAt: T,
    },
    T,
  );

  expect(source?.watching).toEqual([
    { label: "Registry folder", value: "~/.claude/sessions" },
    { label: "Command run", value: "every 30 seconds" },
  ]);
  expect(source?.advice).toBe("Correct AGENT_LOOKOUT_CLAUDE_BIN, or unset it.");
});

test("a fact is kept only when its label and its value are both text", () => {
  const source = readSource(
    {
      id: "claude-code",
      watching: [
        { label: "Command", value: "claude agents --json --all" },
        { label: "No value" },
        { value: "no label" },
        { label: "Count", value: 30 },
        { label: "   ", value: "blank label" },
        { label: "Blank value", value: "" },
        "every 2 seconds",
        null,
        { label: "Registry read", value: "every 2 seconds", extra: true },
      ],
    },
    T,
  );

  expect(source?.watching).toEqual([
    { label: "Command", value: "claude agents --json --all" },
    { label: "Registry read", value: "every 2 seconds" },
  ]);
});

test("a source that sends no facts and no advice has none, and neither is made up", () => {
  const plain = readSource({ id: "claude-code", state: "ok" }, T);
  expect(plain).not.toHaveProperty("watching");
  expect(plain).not.toHaveProperty("advice");

  const odd = readSource({ id: "claude-code", watching: "everything", advice: { do: "this" } }, T);
  expect(odd).not.toHaveProperty("watching");
  expect(odd).not.toHaveProperty("advice");

  expect(readSource({ id: "claude-code", advice: "   " }, T)).not.toHaveProperty("advice");
});

test("the way a source was read is kept, so notifications compare answers read the same way", () => {
  expect(readSource({ id: "claude-code", state: "ok", basis: "registry" }, T)?.basis).toBe(
    "registry",
  );
  expect(readSource({ id: "claude-code", state: "ok" }, T)).not.toHaveProperty("basis");
  expect(readSource({ id: "claude-code", state: "ok", basis: 2 }, T)).not.toHaveProperty("basis");
});

test("what a source can report is kept whole, or not at all, so no cell is a guess", () => {
  const capabilities = {
    "working-and-idle": { level: "yes" },
    "needs-you": { level: "no", reason: "The tool does not record waits." },
    finished: { level: "partly", reason: "Only background jobs." },
    failed: { level: "yes" },
    names: { level: "yes" },
    jump: { level: "no", reason: "The tool names no place to go." },
    "quiet-for": { level: "yes" },
    stop: { level: "no", reason: "The tool names no process to stop." },
    answer: { level: "no", reason: "The tool records no waits to answer." },
  };
  const read = (value: unknown) =>
    readSource({ id: "claude-code", state: "ok", capabilities: value }, T);

  expect(read(capabilities)?.capabilities).toEqual(capabilities);
  // A field this page does not know is dropped, and a yes keeps no reason.
  expect(
    read({ ...capabilities, later: { level: "yes" }, names: { level: "yes", reason: "Extra." } })
      ?.capabilities,
  ).toEqual(capabilities);

  // A cell missing, of a level this page does not know, or a no without its
  // reason, and the source has no row at all rather than a row with a hole.
  const { jump: _jump, ...missing } = capabilities;
  for (const odd of [
    missing,
    { ...capabilities, jump: { level: "maybe", reason: "Who knows." } },
    { ...capabilities, jump: { level: "no" } },
    { ...capabilities, jump: { level: "partly", reason: "   " } },
    { ...capabilities, jump: "no" },
    "everything",
    null,
  ]) {
    expect(read(odd)).not.toHaveProperty("capabilities");
  }
});

test("a session on another machine keeps the machine's name, and only a name as the setting allows one", () => {
  const sent = makeSession({
    id: "remote:devbox:claude-code:1",
    source: "remote:devbox",
    agent: "Claude Code",
    machine: "devbox",
  });
  expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  for (const machine of ["", "dev box", "-devbox", 7, { name: "devbox" }, "a".repeat(25)]) {
    expect(readSession({ ...sent, machine }), String(machine)).not.toHaveProperty("machine");
  }
});

test("a session on another machine is given no Jump, no Stop and no request to answer, whatever is sent", () => {
  const acting = {
    status: "needs-you",
    waitingReason: "permission",
    jump: { kind: "tmux", place: "work:1.0" },
    stop: { how: "signal" },
    ask: {
      requestId: "0123456789abcdef0123456789abcdef",
      tool: "Bash",
      command: "npm test",
      allow: true,
      until: T + 60_000,
    },
  };
  const there = readSession({
    ...makeSession({
      id: "remote:devbox:claude-code:1",
      source: "remote:devbox",
      agent: "Claude Code",
      machine: "devbox",
    }),
    ...acting,
  });
  expect(there).toMatchObject({ machine: "devbox", status: "needs-you" });
  expect(there).not.toHaveProperty("jump");
  expect(there).not.toHaveProperty("stop");
  expect(there).not.toHaveProperty("ask");
  // The same sent for a session here is read whole.
  const here = readSession({ ...makeSession({ id: "claude-code:1" }), ...acting });
  expect(here).toMatchObject({
    jump: { kind: "tmux", place: "work:1.0" },
    stop: { how: "signal" },
    ask: { requestId: "0123456789abcdef0123456789abcdef", tool: "Bash", command: "npm test" },
  });
});

test("another machine's source keeps its name and a row for each agent there that is whole", () => {
  const capabilities = {
    "working-and-idle": { level: "yes" },
    "needs-you": { level: "yes" },
    finished: { level: "partly", reason: "Only background jobs." },
    failed: { level: "partly", reason: "Only background jobs." },
    names: { level: "yes" },
    jump: { level: "no", reason: "Jump acts on this computer only, not on devbox." },
    "quiet-for": { level: "no", reason: "The file read is not rewritten." },
    stop: { level: "no", reason: "Stop acts on this computer only, not on devbox." },
    answer: { level: "no", reason: "Answer acts on this computer only, not on devbox." },
  };
  const source = readSource(
    {
      id: "remote:devbox",
      label: "devbox",
      machine: "devbox",
      state: "ok",
      agents: [
        { label: "Claude Code", capabilities },
        { label: "Half", capabilities: { ...capabilities, jump: undefined } },
        { capabilities },
        "Codex",
      ],
    },
    T,
  );
  expect(source).toMatchObject({ id: "remote:devbox", machine: "devbox" });
  expect(source?.agents).toEqual([{ label: "Claude Code", capabilities }]);
  expect(readSource({ id: "remote:devbox", state: "ok", agents: [] }, T)).not.toHaveProperty(
    "agents",
  );
  expect(
    readSource({ id: "remote:devbox", state: "ok", machine: "dev box" }, T),
  ).not.toHaveProperty("machine");
});

test("events with no id, no time or a kind this page does not know are left out, and unknown words become the plain ones", () => {
  const events = readEvents({
    events: [
      {
        id: "e1",
        at: T,
        sessionId: "claude-code:1",
        sessionName: "demo",
        kind: "status-changed",
        from: "working",
        to: "needs-you",
        severity: "warning",
      },
      {
        id: "e2",
        at: T - 1,
        sessionId: "claude-code:1",
        sessionName: { a: 1 },
        kind: "ended",
        to: "<img>",
        severity: "loud",
        by: "somebody",
      },
      // A kind a later version adds is not drawn as a change of status it was not.
      { id: "e3", at: T - 2, sessionId: "claude-code:1", sessionName: "demo", kind: "exploded" },
      {
        id: "e4",
        at: T - 3,
        sessionId: "claude-code:1",
        sessionName: "demo",
        severity: "advisory",
      },
      { id: "e5", sessionName: "no time", kind: "ended" },
      { at: T, sessionName: "no id", kind: "ended" },
      "nonsense",
    ],
  });

  expect(events).toEqual([
    {
      id: "e1",
      at: T,
      sessionId: "claude-code:1",
      sessionName: "demo",
      kind: "status-changed",
      from: "working",
      to: "needs-you",
      severity: "warning",
    },
    {
      id: "e2",
      at: T - 1,
      sessionId: "claude-code:1",
      sessionName: "claude-code:1",
      kind: "ended",
      severity: "advisory",
    },
  ]);
  expect(readEvents({ events: "none" })).toBeNull();
  expect(readEvents(null)).toBeNull();
});

test("a session Agent Lookout stopped is an event of its own, with who stopped it", () => {
  const stopped = {
    id: "claude-code:1@1:stopped",
    at: T,
    sessionId: "claude-code:1",
    sessionName: "demo",
    kind: "stopped",
    from: "working",
    severity: "advisory",
    by: "agent-lookout",
  };
  expect(readEvents({ events: [stopped] })).toEqual([stopped]);
});

test("a session the collector can stop says how, and nothing else is read as Stop", () => {
  const base = { id: "claude-code:1", source: "claude-code", status: "idle" };
  expect(readSession({ ...base, stop: { how: "signal" } })?.stop).toEqual({ how: "signal" });
  expect(readSession({ ...base, stop: { how: "background", pid: 7 } })?.stop).toEqual({
    how: "background",
  });
  for (const stop of [undefined, true, "signal", { how: "kill" }, { how: null }, []]) {
    expect(readSession({ ...base, stop })).not.toHaveProperty("stop");
  }
});

test("history keeps the points that are all numbers, and needs to know when the collector began", () => {
  const good = { at: T, needsYou: 1, working: 2, idle: 3, total: 6 };
  const history = readHistory({
    startedAt: T - 60_000,
    points: [good, { ...good, at: "later" }, { at: T + 2_000, needsYou: 1 }, null],
  });

  expect(history).toEqual({ startedAt: T - 60_000, points: [good] });
  expect(readHistory({ points: [] })).toBeNull();
  expect(readHistory({ points: {}, startedAt: T })).toBeNull();
});

const KEPT = {
  where: "disk",
  folder: "~/.agent-lookout/history",
  bytes: 1_468_000,
  maxBytes: 20 * 1024 * 1024,
  maxAgeMs: 8 * 24 * 60 * 60 * 1000,
  canClear: true,
  problem: null,
};

test("where the history begins and where it is kept are read as they were sent", () => {
  const history = readHistory({
    startedAt: T,
    points: [],
    since: { at: T - 86_400_000, by: "started" },
    kept: KEPT,
  });
  expect(history).toEqual({
    startedAt: T,
    points: [],
    since: { at: T - 86_400_000, by: "started" },
    kept: KEPT,
  });

  const memory = readHistory({
    startedAt: T,
    points: [],
    since: { at: T, by: "cleared" },
    kept: { ...KEPT, where: "memory", folder: null, bytes: null, canClear: false },
  });
  expect(memory?.since).toEqual({ at: T, by: "cleared" });
  expect(memory?.kept).toEqual({
    ...KEPT,
    where: "memory",
    folder: null,
    bytes: null,
    canClear: false,
  });
});

test("a beginning or a place that cannot be read is left out, and clearing is offered only when the answer says so", () => {
  const read = (since: unknown, kept: unknown) =>
    readHistory({ startedAt: T, points: [], since, kept });

  expect(read({ at: T, by: "restarted" }, KEPT)?.since).toBeUndefined();
  expect(read({ at: "then", by: "started" }, KEPT)?.since).toBeUndefined();
  expect(read(null, null)).toEqual({ startedAt: T, points: [] });
  // On disk, it names its folder, or it is not read.
  expect(read(null, { ...KEPT, folder: null })?.kept).toBeUndefined();
  expect(read(null, { ...KEPT, where: "cloud" })?.kept).toBeUndefined();
  expect(read(null, { ...KEPT, maxBytes: -1 })?.kept).toBeUndefined();
  // Anything but true is no.
  expect(read(null, { ...KEPT, canClear: "yes" })?.kept?.canClear).toBe(false);
  // In memory, nothing can be cleared, whatever is said.
  expect(read(null, { ...KEPT, where: "memory", canClear: true })?.kept?.canClear).toBe(false);
  // A size that cannot be read is not known, and a sentence too long is not shown.
  expect(read(null, { ...KEPT, bytes: "a lot" })?.kept?.bytes).toBeNull();
  expect(read(null, { ...KEPT, problem: "x".repeat(2_000) })?.kept?.problem).toBeNull();
});

test("the email status is read as it was sent, on and off", () => {
  const on = {
    on: true,
    to: "n…@example.com",
    events: ["needs-you", "finished"],
    afterMs: 60_000,
    asking: true,
    problem: null,
    last: { at: T, sent: false, reason: "the mail server did not answer in time" },
    limitedUntil: T + 3_600_000,
  };
  expect(readEmailStatus(JSON.parse(JSON.stringify(on)))).toEqual(on);
  expect(readEmailStatus({ ...on, last: { at: T, sent: true } })?.last).toEqual({
    at: T,
    sent: true,
  });

  const off = {
    on: false,
    to: null,
    events: null,
    afterMs: null,
    asking: null,
    problem: "AGENT_LOOKOUT_SMTP_URL is not set.",
    last: null,
    limitedUntil: null,
  };
  expect(readEmailStatus(off)).toEqual(off);
});

test("whether a wait's email or post says what the session is asking is read as a plain yes, and only while it is on", () => {
  const email = { on: true, to: "n…@example.com", events: ["needs-you"], afterMs: 0 };
  const webhook = { on: true, host: "hooks.example.com", events: ["needs-you"], afterMs: 0 };
  expect(readEmailStatus({ ...email, asking: true })?.asking).toBe(true);
  expect(readWebhookStatus({ ...webhook, asking: true })?.asking).toBe(true);
  // A version of the app that does not say never sends it.
  for (const asking of [false, undefined, null, "true", "on", 1]) {
    expect(readEmailStatus({ ...email, asking })?.asking, String(asking)).toBe(false);
    expect(readWebhookStatus({ ...webhook, asking })?.asking, String(asking)).toBe(false);
  }
  // While off nothing is sent, so nothing is said of it.
  expect(readEmailStatus({ ...email, on: false, asking: true })?.asking).toBeNull();
  expect(readWebhookStatus({ ...webhook, on: false, asking: true })?.asking).toBeNull();
});

test("an email status that cannot be read never claims that emails are going out", () => {
  expect(readEmailStatus(null)).toBeNull();
  expect(readEmailStatus({})).toBeNull();
  expect(readEmailStatus({ on: "yes" })).toBeNull();
  // On, but with no address, no events or no delay to show: off.
  const events = ["needs-you"];
  expect(readEmailStatus({ on: true, events, afterMs: 60_000 })?.on).toBe(false);
  expect(readEmailStatus({ on: true, to: "n…@example.com", events })?.on).toBe(false);
  expect(readEmailStatus({ on: true, to: "n…@example.com", events, afterMs: -1 })?.on).toBe(false);
  expect(readEmailStatus({ on: true, to: "n…@example.com", afterMs: 0 })?.on).toBe(false);
  for (const unread of [[], ["sometimes"], "needs-you", [42]]) {
    expect(
      readEmailStatus({ on: true, to: "n…@example.com", events: unread, afterMs: 0 })?.on,
    ).toBe(false);
  }
  // A name the page does not know is passed over, and the rest are kept in their own order.
  expect(
    readEmailStatus({
      on: true,
      to: "n…@example.com",
      events: ["ended", "sometimes", "needs-you"],
      afterMs: 0,
    })?.events,
  ).toEqual(["needs-you", "ended"]);
  // An outcome with no time is no outcome, and a failure with no reason gets a plain one.
  const base = { on: true, to: "n…@example.com", events, afterMs: 0 };
  expect(readEmailStatus({ ...base, last: { sent: true } })?.last).toBeNull();
  expect(readEmailStatus({ ...base, last: { at: T, sent: false } })?.last).toEqual({
    at: T,
    sent: false,
    reason: "the email could not be sent",
  });
  expect(
    readEmailStatus({ ...base, last: { at: T, sent: false, reason: "x".repeat(301) } })?.last,
  ).toEqual({
    at: T,
    sent: false,
    reason: "the email could not be sent",
  });
});

test("the webhook status is read as it was sent, on and off", () => {
  const on = {
    on: true,
    host: "hooks.example.com",
    events: ["needs-you", "finished"],
    afterMs: 60_000,
    asking: false,
    problem: null,
    last: { at: T, sent: false, reason: "the address refused the post (status 403)" },
    limitedUntil: T + 3_600_000,
  };
  expect(readWebhookStatus(JSON.parse(JSON.stringify(on)))).toEqual(on);

  const off = {
    on: false,
    host: null,
    events: null,
    afterMs: null,
    asking: null,
    problem:
      "AGENT_LOOKOUT_WEBHOOK_AFTER must be a whole number of seconds from 0 to 86400, such as 60.",
    last: null,
    limitedUntil: null,
  };
  expect(readWebhookStatus(off)).toEqual(off);
});

test("a webhook status that cannot be read never claims that posts are going out, and never shows more than a host", () => {
  expect(readWebhookStatus(null)).toBeNull();
  expect(readWebhookStatus({})).toBeNull();
  const events = ["needs-you"];
  expect(readWebhookStatus({ on: true, events, afterMs: 0 })?.on).toBe(false);
  expect(readWebhookStatus({ on: true, host: "hooks.example.com", afterMs: 0 })?.on).toBe(false);
  expect(readWebhookStatus({ on: true, host: "hooks.example.com", events })?.on).toBe(false);
  // A host with a path, a scheme or a token after it is not a host.
  for (const host of [
    "hooks.example.com/services/T0000/s3cret",
    "https://hooks.example.com",
    "hooks.example.com?token=s3cret",
    "name@hooks.example.com",
  ]) {
    const read = readWebhookStatus({ on: true, host, events, afterMs: 0 });
    expect(read?.on).toBe(false);
    expect(JSON.stringify(read)).not.toContain("s3cret");
  }
  expect(readWebhookStatus({ on: true, host: "127.0.0.1", events, afterMs: 0 })?.host).toBe(
    "127.0.0.1",
  );
  // Read by the rule the collector takes an address by, so a host it posts to is shown as on.
  for (const host of ["relay_one.example.test", "hooks.example.com."]) {
    expect(readWebhookStatus({ on: true, host, events, afterMs: 0 })?.on, host).toBe(true);
  }
  for (const host of ["a*b.example.com", `${"a".repeat(250)}.com`]) {
    expect(readWebhookStatus({ on: true, host, events, afterMs: 0 })?.on, host).toBe(false);
  }
  const base = { on: true, host: "hooks.example.com", events, afterMs: 0 };
  expect(readWebhookStatus({ ...base, last: { at: T, sent: false } })?.last).toEqual({
    at: T,
    sent: false,
    reason: "the post could not be sent",
  });
});

test("the restarts a history lists are read oldest first, and one that cannot be one is left out", () => {
  const history = readHistory({
    startedAt: T,
    points: [],
    restarts: [
      { at: T, lastBefore: T - 60_000 },
      { at: T - 120_000, lastBefore: T - 180_000 },
      // The moment before a restart comes before it.
      { at: T - 5_000, lastBefore: T - 1_000 },
      { at: "then", lastBefore: T - 1_000 },
      { at: T - 9_000 },
      null,
    ],
  });
  expect(history?.restarts).toEqual([
    { at: T - 120_000, lastBefore: T - 180_000 },
    { at: T, lastBefore: T - 60_000 },
  ]);
  // None, or none the page can read, is no list at all.
  expect(readHistory({ startedAt: T, points: [], restarts: [] })).not.toHaveProperty("restarts");
  expect(readHistory({ startedAt: T, points: [], restarts: "many" })).not.toHaveProperty(
    "restarts",
  );
});

/** An answer of `/api/waits` as the collector sends it, for one day of three waits. */
function waitsAnswer() {
  const day = {
    day: "2023-11-14",
    from: T - 3_600_000,
    to: T,
    waitedMs: 120_000,
    openMs: 30_000,
    waits: 3,
    measuredMs: 3_000_000,
  };
  const period = {
    from: T - 3_600_000,
    to: T,
    waitedMs: 120_000,
    openMs: 30_000,
    waits: 3,
    measuredMs: 3_000_000,
    days: [day],
    sessions: [
      { sessionId: "claude-code:1", name: "demo-project", waitedMs: 90_000, waits: 2, open: true },
      { sessionId: "claude-code:2", name: "project-2", waitedMs: 30_000, waits: 1, open: false },
    ],
    sessionCount: 2,
  };
  return {
    at: T,
    today: period,
    sevenDays: { ...period, days: [day, { ...day, day: "2023-11-13" }] },
    since: { at: T - 3_600_000, by: "started" },
    where: "disk",
  };
}

test("an answer of the waits is read as it was sent", () => {
  const sent = waitsAnswer();
  expect(readWaits(sent)).toEqual(sent);
});

test("in an answer of the waits, a day or a session that cannot be read is left out, and a broken answer is none", () => {
  const sent = waitsAnswer();
  const read = readWaits({
    ...sent,
    today: {
      ...sent.today,
      // Open is part of what was waited, and never more.
      openMs: 999_999,
      days: [
        ...sent.today.days,
        { day: "today", from: T, to: T },
        { ...sent.today.days[0], waits: -1 },
      ],
      sessions: [
        ...sent.today.sessions,
        { sessionId: "claude-code:1", name: "again", waitedMs: 1, waits: 1 },
        { name: "no id", waitedMs: 1, waits: 1 },
        { sessionId: "claude-code:3", name: "x".repeat(500), waitedMs: 1, waits: 1, open: "yes" },
      ],
    },
  });
  expect(read?.today.openMs).toBe(120_000);
  expect(read?.today.days).toHaveLength(1);
  expect(read?.today.sessions.map((session) => [session.name, session.open])).toEqual([
    ["demo-project", true],
    ["project-2", false],
    ["claude-code:3", false],
  ]);
  expect(read?.today.sessionCount).toBe(3);

  expect(readWaits({ ...sent, where: "cloud" })).toBeNull();
  expect(readWaits({ ...sent, since: undefined })).toBeNull();
  expect(readWaits({ ...sent, today: { ...sent.today, waitedMs: "a lot" } })).toBeNull();
  expect(readWaits({ ...sent, sevenDays: null })).toBeNull();
  expect(readWaits("<!doctype html>")).toBeNull();
});

test("the answer of /api/pull-requests is read as it was sent, and counts as on only with what gh was found to be", () => {
  const on = { on: true, problem: null, gh: "ready", last: { at: T, ok: true } };
  expect(readPullRequestsStatus(on)).toEqual(on);
  expect(
    readPullRequestsStatus({ ...on, last: { at: T, ok: false, reason: "gh did not answer" } }),
  ).toEqual({ ...on, last: { at: T, ok: false, reason: "gh did not answer" } });
  expect(readPullRequestsStatus({ ...on, gh: "sleeping" })).toEqual({
    on: false,
    problem: null,
    gh: null,
    last: null,
  });
  expect(
    readPullRequestsStatus({
      on: false,
      problem: "AGENT_LOOKOUT_PULL_REQUESTS must be on or off.",
    }),
  ).toEqual({
    on: false,
    problem: "AGENT_LOOKOUT_PULL_REQUESTS must be on or off.",
    gh: null,
    last: null,
  });
  expect(readPullRequestsStatus({ on: "yes" })).toBeNull();
  expect(readPullRequestsStatus("on")).toBeNull();
});

describe("a permission request held for the dashboard", () => {
  const ask = {
    requestId: "0123456789abcdef0123456789abcdef",
    tool: "Bash",
    command: "npm test\nnpm run build",
    description: "Run the tests",
    allow: true,
    until: 1_700_000_300_000,
  };
  const waiting = { id: "claude-code:a", source: "claude-code", status: "needs-you" };

  test("is read whole, its command kept as it is, every line", () => {
    expect(readSession({ ...waiting, ask })?.ask).toEqual(ask);
    const edit = {
      requestId: ask.requestId,
      tool: "Write",
      inputs: [{ name: "file_path", value: "/Users/example/a.ts" }],
      allow: false,
      denyOnly: "edit",
      subagent: true,
      until: 1,
    };
    expect(readSession({ ...waiting, ask: edit })?.ask).toEqual(edit);
  });

  test("is not read for a session that does not need the person", () => {
    expect(readSession({ ...waiting, status: "working", ask })).not.toHaveProperty("ask");
  });

  test.each([
    ["no request id", { ...ask, requestId: undefined }],
    ["a request id of another shape", { ...ask, requestId: "1" }],
    ["no word on Allow", { ...ask, allow: "yes" }],
    ["a command that is not text", { ...ask, command: 7 }],
    ["an input that is not text", { ...ask, inputs: [{ name: "a", value: 1 }] }],
    ["no time it is held until", { ...ask, until: undefined }],
  ])("with %s, is not read at all, so no Allow is offered on half of it", (_what, value) => {
    expect(readSession({ ...waiting, ask: value })).not.toHaveProperty("ask");
  });

  test("whether answering is on is read with the snapshot", () => {
    const read = readSnapshot({
      generatedAt: 1,
      sources: [],
      sessions: [],
      answering: { state: "on", plugin: "missed", holdMs: 300_000 },
    });
    expect(read?.answering).toEqual({ state: "on", plugin: "missed", holdMs: 300_000 });
    expect(
      readSnapshot({ generatedAt: 1, sources: [], sessions: [], answering: { state: "maybe" } }),
    ).not.toHaveProperty("answering");
  });
});

test("a snapshot keeps the time rules it was made by, a rule that cannot be read being off, and one without them has none", () => {
  const rules: TimeRules = { ...DEFAULT_TIME_RULES, idle: { on: true, hours: 6 } };
  const made = (timeRules?: unknown) =>
    readSnapshot({
      generatedAt: T,
      sources: [],
      sessions: [],
      ...(timeRules !== undefined && { timeRules }),
    });
  expect(made(rules)?.timeRules).toEqual(rules);
  expect(made({ ...rules, longWait: { on: "yes" } })?.timeRules).toEqual(rules);
  expect(made()).not.toHaveProperty("timeRules");
});

test("a snapshot keeps the collector's word on quiet hours when it is true or false, and nothing else", () => {
  const made = (quiet: unknown) =>
    readSnapshot({
      generatedAt: T,
      sources: [],
      sessions: [],
      timeRules: DEFAULT_TIME_RULES,
      quiet,
    });
  expect(made(true)?.quiet).toBe(true);
  expect(made(false)?.quiet).toBe(false);
  expect(made("yes")).not.toHaveProperty("quiet");
  expect(made(undefined)).not.toHaveProperty("quiet");
});

/** What `GET /api/settings` gives of the permission rules while there are none. */
const NO_PERMISSION_RULES = {
  permissionRules: [],
  permissionRulesProblem: null,
  ruleAnswers: [],
  ruleAnswersSince: null,
};

test("the settings are read with their rules, the file and any problem", () => {
  const rules: TimeRules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 3 } };
  expect(
    readSettings({ timeRules: rules, file: "~/.agent-lookout/settings.json", problem: null }),
  ).toEqual({
    timeRules: rules,
    file: "~/.agent-lookout/settings.json",
    problem: null,
    ...NO_PERMISSION_RULES,
  });
  expect(
    readSettings({ timeRules: {}, file: "~/.agent-lookout/settings.json", problem: "Not read." }),
  ).toEqual({
    timeRules: DEFAULT_TIME_RULES,
    file: "~/.agent-lookout/settings.json",
    problem: "Not read.",
    ...NO_PERMISSION_RULES,
  });
});

describe("the permission rules and what they answered, with the settings", () => {
  const SETTINGS = { timeRules: DEFAULT_TIME_RULES, file: "~/.agent-lookout/settings.json" };
  const RULE = { id: "a1b2c3d4e5f6", decision: "allow", tool: "Bash", command: "npm test:*" };
  const ANSWER = {
    at: 1_700_000_000_000,
    sessionId: "claude-code:00000000-0000-4000-8000-000000000001",
    sessionName: "demo-project",
    tool: "Bash",
    decision: "allow",
    rule: { decision: "allow", tool: "Bash", command: "npm test:*" },
  };

  test("the rules, their problem, what they answered and since when are read", () => {
    expect(
      readSettings({
        ...SETTINGS,
        problem: null,
        permissionRules: [RULE],
        permissionRulesProblem: "Not saved.",
        ruleAnswers: [ANSWER],
        ruleAnswersSince: 1_699_999_000_000,
      }),
    ).toMatchObject({
      permissionRules: [RULE],
      permissionRulesProblem: "Not saved.",
      ruleAnswers: [ANSWER],
      ruleAnswersSince: 1_699_999_000_000,
    });
  });

  test("a list that cannot be read whole is no rule at all, and says so", () => {
    const read = readSettings({
      ...SETTINGS,
      permissionRules: [RULE, { ...RULE, id: "x", decision: "maybe" }],
    });
    expect(read?.permissionRules).toEqual([]);
    expect(read?.permissionRulesProblem).toBe(
      "The permission rules Agent Lookout sent could not be read.",
    );
  });

  test("an answer that cannot be read whole is left out, and a later field of one is dropped", () => {
    const read = readSettings({
      ...SETTINGS,
      ruleAnswers: [
        ANSWER,
        { ...ANSWER, decision: "maybe" },
        { ...ANSWER, rule: { decision: "allow", tool: "*" } },
        { ...ANSWER, at: "soon" },
        { ...ANSWER, command: "npm test" },
      ],
    });
    expect(read?.ruleAnswers).toEqual([ANSWER, ANSWER]);
    expect(JSON.stringify(read?.ruleAnswers)).not.toContain('"command":"npm test"');
  });
});

test.each([null, {}, { timeRules: DEFAULT_TIME_RULES }, { file: "~/x", timeRules: "on" }])(
  "%j is not the settings",
  (data) => {
    expect(readSettings(data)).toBeNull();
  },
);
