// Test fixtures only. Every id, name and path here is invented and generic.
// The lines follow the shapes in Codex's source at rust-v0.160.0, as written up
// in docs/adapters/codex.md, and nothing in them is copied from a real machine.
// Product code never imports this file.
//
// The folder `codex-home/` beside this file is the same kind of data laid out on
// disk, as Codex lays out its own folder. `tests/README.md` lists what is in it.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const CODEX_HOME = `${HOME}/.codex`;

/**
 * Midday UTC on 1 October 2026, the day the fixture's sessions were written.
 * At midday UTC it is 1 October in every time zone or the day after, so the
 * folder `sessions/2026/10/01` is always today's or yesterday's.
 */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A generic thread id whose last two characters are these. */
export const threadId = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

/** The thread ids of the sessions in `codex-home/`. */
export const ids = {
  working: threadId("c1"),
  idle: threadId("c2"),
  finished: threadId("c3"),
  aborted: threadId("c4"),
  subagent: threadId("c5"),
  reverted: threadId("c6"),
  malformed: threadId("c7"),
  metaOnly: threadId("c8"),
  resumed: threadId("c9"),
  compressed: threadId("ca"),
  mcp: threadId("cb"),
  archived: threadId("cc"),
  old: threadId("cd"),
  /** Another agent's session, imported by the Codex desktop app and not used since. */
  imported: threadId("ce"),
  /** A session the Codex desktop app ran, which records its source as `vscode`. */
  desktop: threadId("cf"),
} as const;

/** The id of the second file of the reverted session in `codex-home/`. */
export const revertedRolloutId = threadId("d6");

/** A time as Codex writes it: `YYYY-MM-DDTHH:MM:SS.mmmZ`, in UTC. */
export const at = (ms: number) => new Date(ms).toISOString();

/** A rollout file's name. `created` is the local time in the name, as `2026-10-01T09-00-00`. */
export function rolloutName(created: string, thread: string, rolloutId?: string): string {
  return `rollout-${created}-${thread}${rolloutId ? `_${rolloutId}` : ""}.jsonl`;
}

/** A rollout file's path under a Codex folder, in the day folder its name gives. */
export function rolloutPath(
  home: string,
  created: string,
  thread: string,
  rolloutId?: string,
): string {
  const [year, month, day] = created.slice(0, 10).split("-");
  return `${home}/sessions/${year}/${month}/${day}/${rolloutName(created, thread, rolloutId)}`;
}

/** The lock file Codex keeps while a process has this thread open. */
export const lockPath = (home: string, thread: string) =>
  `${home}/thread-writer-locks/${thread}.lock`;

/**
 * A `session_meta` line, with the large and private fields Codex also writes
 * there, so a test can check they are dropped.
 */
export function metaLine(time: number, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: at(time),
    type: "session_meta",
    payload: {
      id: ids.working,
      session_id: ids.working,
      timestamp: at(time),
      cwd: "/Users/example/code/demo",
      originator: "codex_cli_rs",
      cli_version: "0.160.0",
      source: "cli",
      model_provider: "openai",
      base_instructions: { text: "Placeholder instructions for a generic session." },
      dynamic_tools: [{ name: "demo_tool", description: "A placeholder tool." }],
      git: {
        commit_hash: "0000000000000000000000000000000000000000",
        branch: "main",
        repository_url: "https://example.com/demo.git",
      },
      creator_user_id: "user-example",
      creator_account_id: "account-example",
      ...payload,
    },
  });
}

/** A turn line: an `event_msg` whose payload type is `task_started`, `task_complete` and so on. */
export function turnLine(
  time: number,
  type: string,
  payload: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    timestamp: at(time),
    type: "event_msg",
    payload: { type, turn_id: "turn-0001", ...payload },
  });
}

/** A message line, which the adapter never parses. */
export function messageLine(time: number, text = "A placeholder message.", role = "user"): string {
  return JSON.stringify({
    timestamp: at(time),
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
}

/** An `event_msg` that is not a turn line, such as Codex's token counts. */
export function eventLine(time: number, type: string): string {
  return JSON.stringify({ timestamp: at(time), type: "event_msg", payload: { type } });
}

/**
 * One `TokenUsage` as Codex writes it: input with the cached part inside it,
 * output with reasoning inside it, and a total the provider gave.
 */
export function usage(
  input: number,
  cached: number,
  output: number,
  more: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: Math.floor(output / 2),
    total_tokens: input + output,
    ...more,
  };
}

/**
 * Rate limits as a `token_count` line carries them, with an invented plan and
 * balance, so a test can check that none of it is kept.
 */
export const RATE_LIMITS = {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_790_000_000 },
  secondary: { used_percent: 3.25, window_minutes: 10_080, resets_at: 1_790_500_000 },
  credits: { has_credits: true, unlimited: false, balance: "987.65" },
  individual_limit: null,
  spend_control_reached: false,
  plan_type: "example-plan",
  rate_limit_reached_type: null,
};

/** The running total a `token_count` line carries beside the newest reply's, which is never kept. */
export const TOTAL_USAGE = usage(4_210_330, 3_900_000, 61_200);

/**
 * A `token_count` line, as Codex writes one after each reply
 * (codex-rs/protocol/src/protocol.rs, `TokenCountEvent`): the newest reply's
 * usage in `info.last_token_usage`, with the running total and the model's
 * context window beside it, and the rate limits after. With `last` null,
 * `info` is null, as Codex writes it before the first reply.
 */
export function tokenCountLine(
  time: number,
  last: Record<string, unknown> | null,
  rateLimits: Record<string, unknown> | null = RATE_LIMITS,
): string {
  return JSON.stringify({
    timestamp: at(time),
    type: "event_msg",
    payload: {
      type: "token_count",
      info:
        last === null
          ? null
          : {
              total_token_usage: TOTAL_USAGE,
              last_token_usage: last,
              model_context_window: 258_400,
            },
      rate_limits: rateLimits,
    },
  });
}

/** A rollout file's content: one line each, every line ended. */
export const rollout = (...lines: string[]) => lines.map((line) => `${line}\n`).join("");

/** A line of `session_index.jsonl`. */
export function indexLine(thread: string, name: string, time: number = NOW - HOUR): string {
  return JSON.stringify({ id: thread, thread_name: name, updated_at: at(time) });
}

/**
 * The sessions `codex-home/` holds, as the adapter reports them with the clock
 * at `NOW`, in order of id. Sessions left out are not here: the subagent, the
 * `mcp` thread, the compressed and archived files, the session whose last line
 * is more than a day old, and the session imported from another agent.
 */
export const fixtureSessions = [
  {
    id: `codex:${ids.working}`,
    name: "demo-project",
    project: "demo",
    surface: "terminal",
    status: "working",
    startedAt: Date.parse("2026-10-01T09:00:00.000Z"),
    statusSince: Date.parse("2026-10-01T11:55:00.000Z"),
  },
  {
    id: `codex:${ids.idle}`,
    name: "demo-api",
    project: "demo-api",
    surface: "vscode",
    status: "idle",
    startedAt: Date.parse("2026-10-01T10:00:00.000Z"),
    statusSince: Date.parse("2026-10-01T11:30:00.000Z"),
    // From the token count line just before its `task_complete`: the newest reply's counts alone.
    tokens: { input: 52_480, cached: 44_032, output: 1_206 },
  },
  {
    id: `codex:${ids.finished}`,
    name: "docs-pass",
    project: "demo-docs",
    surface: "terminal",
    status: "finished",
    startedAt: Date.parse("2026-10-01T10:30:00.000Z"),
    statusSince: Date.parse("2026-10-01T10:45:00.000Z"),
  },
  {
    id: `codex:${ids.aborted}`,
    name: "demo-site",
    project: "demo-site",
    surface: "desktop",
    status: "idle",
    startedAt: Date.parse("2026-10-01T08:00:00.000Z"),
    statusSince: Date.parse("2026-10-01T08:20:00.000Z"),
  },
  {
    id: `codex:${ids.reverted}`,
    name: "demo-jobs",
    project: "demo-jobs",
    surface: "terminal",
    status: "working",
    startedAt: Date.parse("2026-10-01T07:00:00.000Z"),
    statusSince: Date.parse("2026-10-01T11:45:00.000Z"),
  },
  {
    id: `codex:${ids.malformed}`,
    name: "demo-tests",
    project: "demo-tests",
    surface: "terminal",
    status: "idle",
    startedAt: Date.parse("2026-10-01T09:30:00.000Z"),
    statusSince: Date.parse("2026-10-01T11:10:00.000Z"),
  },
  {
    id: `codex:${ids.metaOnly}`,
    name: "demo-notes",
    project: "demo-notes",
    surface: "vscode",
    status: "idle",
    startedAt: Date.parse("2026-10-01T11:58:00.000Z"),
    statusSince: Date.parse("2026-10-01T11:58:00.000Z"),
  },
  {
    id: `codex:${ids.resumed}`,
    name: "demo-cli",
    project: "demo-cli",
    surface: "terminal",
    status: "working",
    startedAt: Date.parse("2026-09-20T08:00:00.000Z"),
    statusSince: Date.parse("2026-10-01T11:50:00.000Z"),
  },
  {
    id: `codex:${ids.desktop}`,
    // The desktop app writes no names file entry, so the folder names it.
    name: "demo-desktop",
    project: "demo-desktop",
    surface: "desktop",
    status: "idle",
    startedAt: Date.parse("2026-10-01T11:20:00.000Z"),
    statusSince: Date.parse("2026-10-01T11:25:00.000Z"),
  },
] as const;
