import type { Adapter } from "./adapters/adapter.ts";
import { createClaudeCodeAdapter } from "./adapters/claude-code/index.ts";
import { createCodexAdapter } from "./adapters/codex/index.ts";
import { createStatusFileAdapter } from "./adapters/status-files/index.ts";
import {
  createEmailNotifications,
  emailOffStatus,
  type EmailNotifications,
} from "./email/emailNotifications.ts";
import { emailProblemLine, readEmailSetup } from "./email/emailSettings.ts";
import { createSmtpSender, type CreateEmailSender } from "./email/smtpSender.ts";
import { createEventStore } from "./eventStore.ts";
import { createApiHandler, type ApiHandler } from "./handler.ts";
import { createHistoryStore } from "./historyStore.ts";
import { createJumpRoute } from "./jumpRoute.ts";
import {
  createServerNotifications,
  notificationsOnAtStart,
} from "./notifications/serverNotifications.ts";
import { createSystemNotifier, type SystemNotifier } from "./notifications/systemNotifier.ts";
import { createPoller, POLL_INTERVAL_MS, type Poller } from "./poller.ts";
import { createPaneFinder } from "./tmux/paneFinder.ts";
import { createTmuxRunner, type RunTmux } from "./tmux/program.ts";

export interface CollectorOptions {
  /** The app version reported by `/api/health`. */
  version: string;
  /** Defaults to every adapter the app ships: Claude Code, Codex and status files. */
  adapters?: readonly Adapter[];
  /**
   * Where the default adapters read their settings, such as
   * `AGENT_LOOKOUT_CLAUDE_HOME`, `AGENT_LOOKOUT_CODEX_HOME` and
   * `AGENT_LOOKOUT_STATUS_DIR`, and where `AGENT_LOOKOUT_NOTIFICATIONS` and
   * the email settings are read. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * What shows a notification on this machine when no dashboard page will.
   * Defaults to the system's own, which is `osascript` on macOS and nothing
   * anywhere else. Tests pass one that shows nothing.
   */
  notifier?: SystemNotifier;
  /**
   * What runs tmux, to find the pane a session runs in and to select it when
   * the dashboard asks. Defaults to the tmux on this machine, when there is
   * one and `AGENT_LOOKOUT_TMUX` is not `off`. Tests pass one that runs nothing.
   */
  tmux?: RunTmux;
  /**
   * Makes what sends an email, once email has been set up in the environment.
   * Defaults to the mail server named there. With email not set up it is never
   * called. Tests pass one that sends nothing, or one with short timeouts.
   */
  createEmailSender?: CreateEmailSender;
  /**
   * Where the one line goes that says email is off because a setting is wrong.
   * Defaults to the console's errors.
   */
  warn?: (line: string) => void;
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
  /** The email notifications, or null while email is not set up. */
  email: EmailNotifications | null;
}

/**
 * The collector in one piece: adapters, poller, stores, its own notifications,
 * the email notifications when they are set up, what finds and selects a tmux
 * pane, and the request handler. Every host builds it the same way: the dev
 * server, the standalone server, and later a desktop app.
 */
export function createCollector(options: CollectorOptions): Collector {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const events = createEventStore();
  const history = createHistoryStore();
  // The panes the Claude Code adapter finds are the ones the jump route selects,
  // so the two share one finder and one way of running tmux.
  const tmux = options.tmux ?? createTmuxRunner({ env });
  const panes = createPaneFinder({ run: tmux, now });
  const notifications = createServerNotifications({
    notifier: options.notifier ?? createSystemNotifier(),
    onAtStart: notificationsOnAtStart(env),
    now,
  });
  // Read once, here. With nothing set, nothing that could send an email is
  // made, and the mail library is never loaded.
  const emailSetup = readEmailSetup(env);
  if (!emailSetup.on && emailSetup.problem !== null) {
    (options.warn ?? console.error)(emailProblemLine(emailSetup.problem));
  }
  const email = emailSetup.on
    ? createEmailNotifications({
        settings: emailSetup.settings,
        sender: (options.createEmailSender ?? createSmtpSender)(emailSetup.settings),
        now,
      })
    : null;
  const emailOff = emailOffStatus(emailSetup.on ? null : emailSetup.problem);
  const poller = createPoller({
    // Each adapter is told how often it will be polled so that it can say so.
    adapters: options.adapters ?? [
      createClaudeCodeAdapter({ env: options.env, now, pollIntervalMs: intervalMs, panes }),
      createCodexAdapter({ env: options.env, now, pollIntervalMs: intervalMs }),
      createStatusFileAdapter({ env: options.env, now, pollIntervalMs: intervalMs }),
    ],
    events,
    history,
    intervalMs,
    now,
    // The poller runs for as long as the app does, with a dashboard open or
    // not, so a wait that begins with no page open is still seen here.
    onSnapshot: (snapshot) => {
      email?.handle(snapshot);
      notifications.handle(snapshot);
    },
  });
  const handler = createApiHandler({
    version: options.version,
    poller,
    events,
    history,
    notifications,
    email: () => email?.status() ?? emailOff,
    jump: createJumpRoute({ poller, panes, run: tmux, now }),
    now,
  });

  return {
    start: () => poller.start(),
    stop: () => poller.stop(),
    handler,
    poller,
    email,
  };
}
