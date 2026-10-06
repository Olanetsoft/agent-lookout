import { expect, test } from "vitest";

import {
  surfaceLabel,
  type HistoryPoint,
  type SessionEvent,
  type SessionsSnapshot,
} from "@core/sessions/session";

// These fixtures name every field of the session model. `tsc -b` checks this file,
// so renaming or removing a field fails the typecheck here before it reaches an
// adapter or the dashboard. All values are generic and invented for the test.

const snapshot: SessionsSnapshot = {
  generatedAt: 1_700_000_060_000,
  sources: [
    {
      id: "claude-code",
      label: "Claude Code",
      state: "ok",
      detail: "Found 1 session.",
      watching: [
        { label: "Registry folder", value: "~/.claude/sessions" },
        { label: "Command run", value: "every 30 seconds" },
      ],
      advice: "Correct AGENT_LOOKOUT_CLAUDE_BIN, or unset it.",
      capabilities: {
        "working-and-idle": { level: "yes" },
        "needs-you": { level: "yes" },
        finished: { level: "partly", reason: "Only background jobs." },
        failed: { level: "partly", reason: "Only background jobs." },
        names: { level: "yes" },
        jump: { level: "partly", reason: "Only where a place is found." },
        "quiet-for": { level: "no", reason: "The file read is not rewritten." },
      },
      checkedAt: 1_700_000_060_000,
    },
  ],
  sessions: [
    {
      id: "claude-code:00000000-0000-4000-8000-000000000001",
      source: "claude-code",
      surface: "vscode",
      name: "demo-project",
      cwd: "/Users/example/code/demo",
      project: "demo",
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      startedAt: 1_700_000_000_000,
      statusSince: 1_700_000_030_000,
      pid: 4242,
      alive: true,
      links: {
        open: "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000001",
      },
      stale: false,
    },
  ],
};

const event: SessionEvent = {
  id: "event-1",
  at: 1_700_000_030_000,
  sessionId: "claude-code:00000000-0000-4000-8000-000000000001",
  sessionName: "demo-project",
  kind: "status-changed",
  from: "working",
  to: "needs-you",
  severity: "warning",
};

const point: HistoryPoint = {
  at: 1_700_000_060_000,
  needsYou: 1,
  working: 0,
  idle: 0,
  total: 1,
};

test("a snapshot survives the JSON round trip the API puts it through", () => {
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  expect(JSON.parse(JSON.stringify({ events: [event], points: [point] }))).toEqual({
    events: [event],
    points: [point],
  });
});

test("a session id starts with its source", () => {
  for (const session of snapshot.sessions) {
    expect(session.id.startsWith(`${session.source}:`)).toBe(true);
  }
});

test("each app the model knows has a name, and an app that is not known has none", () => {
  expect(surfaceLabel("terminal")).toBe("Terminal");
  expect(surfaceLabel("vscode")).toBe("VS Code");
  expect(surfaceLabel("desktop")).toBe("Desktop app");
  expect(surfaceLabel("cloud")).toBe("Cloud");
  expect(surfaceLabel("browser")).toBe("Browser");
  expect(surfaceLabel("unknown")).toBeNull();
});
