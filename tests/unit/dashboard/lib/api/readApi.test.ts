import { expect, test } from "vitest";

import {
  readEmailStatus,
  readEvents,
  readHistory,
  readSession,
  readSnapshot,
  readSource,
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

test.each([
  ["nothing", undefined],
  ["null", null],
  ["a text", "tmux, work:2.1"],
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
  // On, but with no address or no delay to show: off.
  expect(readEmailStatus({ on: true, afterMs: 60_000 })?.on).toBe(false);
  expect(readEmailStatus({ on: true, to: "n…@example.com" })?.on).toBe(false);
  expect(readEmailStatus({ on: true, to: "n…@example.com", afterMs: -1 })?.on).toBe(false);
  // An outcome with no time is no outcome, and a failure with no reason gets a plain one.
  const base = { on: true, to: "n…@example.com", afterMs: 0 };
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
