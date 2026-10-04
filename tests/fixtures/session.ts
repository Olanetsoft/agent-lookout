// Test fixtures only. Product code never imports this file: the product never
// shows invented data.

import type { Session } from "@core/session";

/** A generic session for tests. Every value is invented. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "claude-code:00000000-0000-4000-8000-000000000001",
    source: "claude-code",
    surface: "terminal",
    name: "demo-project",
    cwd: "/Users/example/code/demo",
    project: "demo",
    status: "idle",
    startedAt: 1_700_000_000_000,
    statusSince: 1_700_000_030_000,
    links: {},
    stale: false,
    ...overrides,
  };
}
