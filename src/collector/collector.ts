import type { Adapter } from "./adapters/adapter.ts";
import { createClaudeCodeAdapter } from "./adapters/claude-code/index.ts";
import { createCodexAdapter } from "./adapters/codex/index.ts";
import { createEventStore } from "./eventStore.ts";
import { createApiHandler, type ApiHandler } from "./handler.ts";
import { createHistoryStore } from "./historyStore.ts";
import { createPoller, POLL_INTERVAL_MS, type Poller } from "./poller.ts";

export interface CollectorOptions {
  /** The app version reported by `/api/health`. */
  version: string;
  /** Defaults to every adapter the app ships: Claude Code and Codex. */
  adapters?: readonly Adapter[];
  /**
   * Where the default adapters read their settings, such as
   * `AGENT_LOOKOUT_CLAUDE_HOME` and `AGENT_LOOKOUT_CODEX_HOME`. Defaults to
   * `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  now?: () => number;
}

export interface Collector {
  /** Begins polling. */
  start(): void;
  /** Stops polling. */
  stop(): void;
  /** Answers `/api/*`. Mount it in any Node HTTP server. */
  handler: ApiHandler;
  poller: Poller;
}

/**
 * The collector in one piece: adapters, poller, stores and the request handler.
 * Every host builds it the same way: the dev server, the standalone server,
 * and later a desktop app.
 */
export function createCollector(options: CollectorOptions): Collector {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const events = createEventStore();
  const history = createHistoryStore();
  const poller = createPoller({
    // Each adapter is told how often it will be polled so that it can say so.
    adapters: options.adapters ?? [
      createClaudeCodeAdapter({ env: options.env, now, pollIntervalMs: intervalMs }),
      createCodexAdapter({ env: options.env, now, pollIntervalMs: intervalMs }),
    ],
    events,
    history,
    intervalMs,
    now,
  });
  const handler = createApiHandler({ version: options.version, poller, events, history, now });

  return {
    start: () => poller.start(),
    stop: () => poller.stop(),
    handler,
    poller,
  };
}
