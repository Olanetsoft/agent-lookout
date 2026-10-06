// What another machine's Agent Lookout answers, for the tests of reading one
// over SSH. Every value is invented. Product code never imports this file.

import { CLAUDE_CODE_CAPABILITIES } from "@collector/adapters/claude-code/index";
import { CODEX_CAPABILITIES } from "@collector/adapters/codex/index";
import { STATUS_FILE_CAPABILITIES } from "@collector/adapters/status-files/index";
import type { Session, SessionsSnapshot, SourceHealth } from "@core/sessions/session";

/** A clock in the middle of a working day. */
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

/** The version the other machine runs. */
export const REMOTE_VERSION = "0.2.3";

/** A Claude Code session there that is waiting for permission, with everything a session can carry. */
export function waitingThere(overrides: Partial<Session> = {}): Session {
  return {
    id: "claude-code:00000000-0000-4000-8000-0000000000aa",
    source: "claude-code",
    surface: "terminal",
    name: "demo-api",
    cwd: "/Users/example/code/demo-api",
    project: "demo-api",
    git: {
      branch: "fix-login",
      repository: { id: "0123456789abcdef0123456789abcdef", name: "demo-api" },
      pullRequest: {
        number: 12,
        title: "Fix the login form",
        state: "open",
        checks: { state: "passing", passing: 3, failing: 0, pending: 0 },
        url: "https://github.com/example-org/demo-api/pull/12",
      },
    },
    status: "needs-you",
    waitingReason: "permission",
    waitingDetail: "Claude needs your permission to use Bash",
    waitingText: "Run: npm test",
    startedAt: NOW - 30 * 60_000,
    statusSince: NOW - 2 * 60_000,
    pid: 4242,
    alive: true,
    links: { open: "vscode://file/Users/example/code/demo-api" },
    jump: { kind: "tmux", place: "work:1.0" },
    stop: { how: "signal" },
    // The permission request Agent Lookout there holds for it, which only it can answer.
    ask: {
      requestId: "0123456789abcdef0123456789abcdef",
      tool: "Bash",
      command: "npm run build",
      allow: true,
      until: NOW + 5 * 60_000,
    },
    stale: false,
    ...overrides,
  };
}

/** A session there from a status file, written by an agent with a name of its own. */
export function workingThere(overrides: Partial<Session> = {}): Session {
  return {
    id: "status-files:night-shift.json",
    source: "status-files",
    agent: "Night Shift",
    surface: "unknown",
    name: "demo-docs",
    cwd: "/Users/example/code/demo-docs",
    project: "demo-docs",
    status: "working",
    startedAt: NOW - 10 * 60_000,
    statusSince: NOW - 5 * 60_000,
    lastWriteAt: NOW - 20_000,
    links: {},
    stale: false,
    ...overrides,
  };
}

/** The sources there: Claude Code read, Codex not installed, and a folder of status files. */
export function sourcesThere(): SourceHealth[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      state: "ok",
      capabilities: CLAUDE_CODE_CAPABILITIES,
      checkedAt: NOW,
    },
    {
      id: "codex",
      label: "Codex",
      state: "unavailable",
      capabilities: CODEX_CAPABILITIES,
      checkedAt: NOW,
    },
    {
      id: "status-files",
      label: "Status files",
      state: "ok",
      capabilities: STATUS_FILE_CAPABILITIES,
      checkedAt: NOW,
    },
  ];
}

/** The other machine's answer of `/api/sessions`: its sources, and the sessions given. */
export function snapshotThere(
  sessions: Session[] = [waitingThere(), workingThere()],
): SessionsSnapshot {
  return { generatedAt: NOW, sources: sourcesThere(), sessions };
}
