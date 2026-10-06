import { expect, test } from "vitest";

import {
  readEmailStatus,
  readEvents,
  readHistory,
  readSession,
  readSnapshot,
  readSource,
  readWebhookStatus,
} from "@dashboard/lib/api/readApi";
import { makeSession } from "@tests/fixtures/session";

const T = 1_700_000_000_000;

test("a well-formed session is read as it was sent", () => {
  const sent = makeSession({
    status: "needs-you",
    waitingReason: "permission",
    waitingDetail: "permission prompt",
    surface: "vscode",
    pid: 4242,
    alive: true,
    links: { open: "vscode://anthropic.claude-code/open?session=abc" },
    stale: false,
  });

  expect(readSession(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
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

test("events with no id or no time are left out, and unknown words become the plain ones", () => {
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
        kind: "exploded",
        to: "<img>",
        severity: "loud",
      },
      { id: "e3", sessionName: "no time" },
      { at: T, sessionName: "no id" },
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
      kind: "status-changed",
      severity: "advisory",
    },
  ]);
  expect(readEvents({ events: "none" })).toBeNull();
  expect(readEvents(null)).toBeNull();
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

test("the email status is read as it was sent, on and off", () => {
  const on = {
    on: true,
    to: "n…@example.com",
    events: ["needs-you", "finished"],
    afterMs: 60_000,
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
    problem: "AGENT_LOOKOUT_SMTP_URL is not set.",
    last: null,
    limitedUntil: null,
  };
  expect(readEmailStatus(off)).toEqual(off);
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
