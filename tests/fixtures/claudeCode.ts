// Test fixtures only. Every name, path, pid and id here is invented and generic.
// They follow the shapes described in the Claude Code docs for
// `claude agents --json` and observed in the session registry, and nothing in
// them is copied from a real machine. Product code never imports this file.

export const HOME = "/Users/example";

export const ids = {
  busy: "00000000-0000-4000-8000-000000000001",
  permission: "00000000-0000-4000-8000-000000000002",
  question: "00000000-0000-4000-8000-000000000003",
  idle: "00000000-0000-4000-8000-000000000004",
  background: "00000000-0000-4000-8000-000000000005",
} as const;

export const pids = { busy: 4241, permission: 4242, question: 4243, idle: 4244 } as const;

const startedAt = 1_700_000_000_000;

/** What `claude agents --json` prints: four live sessions and one background job. */
export const feedEntries = [
  {
    pid: pids.busy,
    cwd: "/Users/example/code/demo",
    kind: "interactive",
    startedAt,
    sessionId: ids.busy,
    name: "demo-project",
    status: "busy",
  },
  {
    pid: pids.permission,
    cwd: "/Users/example/code/demo-api",
    kind: "interactive",
    startedAt: startedAt + 1_000,
    sessionId: ids.permission,
    name: "demo-api",
    status: "waiting",
    waitingFor: "permission prompt",
  },
  {
    pid: pids.question,
    cwd: "/Users/example/code/demo-docs",
    kind: "interactive",
    startedAt: startedAt + 2_000,
    sessionId: ids.question,
    name: "demo-docs",
    status: "waiting",
    waitingFor: "input needed",
  },
  {
    pid: pids.idle,
    cwd: "/Users/example/code/demo-site",
    kind: "interactive",
    startedAt: startedAt + 3_000,
    sessionId: ids.idle,
    name: "demo-site",
    status: "idle",
  },
  {
    cwd: "/Users/example/code/demo-jobs",
    kind: "background",
    startedAt: startedAt + 4_000,
    sessionId: ids.background,
    name: "nightly-report",
    id: "job-0001",
    state: "blocked",
  },
];

export const feedJson = JSON.stringify(feedEntries, null, 2);

/**
 * The same array followed by what a wrapper around `claude` might print after
 * it: a status card with brackets, braces and quotes of its own.
 */
export const feedJsonWithTrailingText = `${feedJson}
╭─ session tracker ─────────────╮
│ [demo] tracked {12m} "today"  │
╰───────────────────────────────╯
{"tracker": "unrelated json from another tool"}
`;

/** One registry file's content, as Claude Code writes it for a live session. */
export function registryFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: pids.busy,
    sessionId: ids.busy,
    cwd: "/Users/example/code/demo",
    startedAt,
    procStart: "Tue Nov 14 22:13:20 2023",
    version: "2.1.0",
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "claude-vscode",
    name: "demo-project",
    nameSource: "derived",
    status: "busy",
    updatedAt: startedAt + 60_000,
    statusUpdatedAt: startedAt + 30_000,
    ...overrides,
  });
}

/** Registry files for the four live sessions in the feed, by file name. */
export const registryFiles: Record<string, string> = {
  [`${pids.busy}.json`]: registryFile(),
  [`${pids.permission}.json`]: registryFile({
    pid: pids.permission,
    sessionId: ids.permission,
    cwd: "/Users/example/code/demo-api",
    name: "demo-api",
    entrypoint: "claude-desktop",
    status: "waiting",
    waitingFor: "permission prompt",
    statusUpdatedAt: startedAt + 40_000,
  }),
  [`${pids.question}.json`]: registryFile({
    pid: pids.question,
    sessionId: ids.question,
    cwd: "/Users/example/code/demo-docs",
    name: "demo-docs",
    entrypoint: "cli",
    status: "waiting",
    waitingFor: "input needed",
    statusUpdatedAt: startedAt + 50_000,
  }),
  [`${pids.idle}.json`]: registryFile({
    pid: pids.idle,
    sessionId: ids.idle,
    cwd: "/Users/example/code/demo-site",
    name: "demo-site",
    entrypoint: "claude-vscode",
    status: "idle",
    statusUpdatedAt: startedAt + 10_000,
  }),
};
