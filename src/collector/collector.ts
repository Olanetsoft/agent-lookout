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
import { createBranchFinder } from "./git/branchFinder.ts";
import { createApiHandler, type ApiHandler } from "./handler.ts";
import { createHistoryStore } from "./historyStore.ts";
import { createJumpRoute } from "./jumpRoute.ts";
import {
  createServerNotifications,
  notificationsOnAtStart,
} from "./notifications/serverNotifications.ts";
import { createSystemNotifier, type SystemNotifier } from "./notifications/systemNotifier.ts";
import { createPoller, POLL_INTERVAL_MS, type Poller } from "./poller.ts";
import type { ReadProcessTable } from "./terminal/processTable.ts";
import { createOsascriptRunner, type RunOsascript } from "./terminal/program.ts";
import { createTabFinder } from "./terminal/tabFinder.ts";
import { createPaneFinder } from "./tmux/paneFinder.ts";
import { createTmuxRunner, type RunTmux } from "./tmux/program.ts";
import {
  createWebhookNotifications,
  webhookOffStatus,
  type WebhookNotifications,
} from "./webhook/webhookNotifications.ts";
import { createHttpSender, type CreateWebhookSender } from "./webhook/webhookSender.ts";
import { readWebhookSetup, webhookProblemLine } from "./webhook/webhookSettings.ts";

export interface CollectorOptions {
  /** The app version reported by `/api/health`. */
  version: string;
  /** Defaults to every adapter the app ships: Claude Code, Codex and status files. */
  adapters?: readonly Adapter[];
  /**
   * Where the default adapters read their settings, such as
   * `AGENT_LOOKOUT_CLAUDE_HOME`, `AGENT_LOOKOUT_CODEX_HOME` and
   * `AGENT_LOOKOUT_STATUS_DIR`, and where `AGENT_LOOKOUT_NOTIFICATIONS`, the
   * email settings and the webhook settings are read. Defaults to `process.env`.
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
   * What runs `/usr/bin/osascript` to bring a session's Terminal or iTerm2 tab
   * forward when the dashboard asks. Defaults to running it on macOS, unless
   * `AGENT_LOOKOUT_TERMINAL_JUMP` is `off`. Tests pass one that runs nothing.
   */
  osascript?: RunOsascript;
  /**
   * Reads every process's parent, terminal and program, to find the Terminal
   * or iTerm2 tab a session runs in. Defaults to asking `ps`. Tests pass a
   * table of their own.
   */
  readProcesses?: ReadProcessTable;
  /**
   * Makes what sends an email, once email has been set up in the environment.
   * Defaults to the mail server named there. With email not set up it is never
   * called. Tests pass one that sends nothing, or one with short timeouts.
   */
  createEmailSender?: CreateEmailSender;
  /**
   * Makes what posts to the webhook, once its address has been set in the
   * environment. Defaults to posting there over HTTPS. With no address set it
   * is never called. Tests pass one with a short timeout, aimed at a server of
   * their own on 127.0.0.1.
   */
  createWebhookSender?: CreateWebhookSender;
  /**
   * Where the one line goes that says email or the webhook is off because a
   * setting is wrong. Defaults to the console's errors.
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
  /** The webhook notifications, or null while no webhook address is set. */
  webhook: WebhookNotifications | null;
}

/**
 * The collector in one piece: adapters, poller, stores, its own notifications,
 * the email and webhook notifications when they are set up, what finds and
 * selects a tmux pane, what finds and brings forward a Terminal or iTerm2 tab,
 * what reads each session's git branch, and the request handler. Every host
 * builds it the same way: the dev server, the standalone server, and later a
 * desktop app.
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
  // The same for the tabs of Terminal and iTerm2: the adapter finds them and
  // the jump route brings them forward.
  const tabs = createTabFinder({ env, readProcesses: options.readProcesses, now });
  const osascript = options.osascript ?? createOsascriptRunner({ env });
  const notifications = createServerNotifications({
    notifier: options.notifier ?? createSystemNotifier(),
    onAtStart: notificationsOnAtStart(env),
    now,
  });
  // Read once, here. With nothing set, nothing that could send an email is
  // made, and the mail library is never loaded.
  const warn = options.warn ?? console.error;
  const emailSetup = readEmailSetup(env);
  if (!emailSetup.on && emailSetup.problem !== null) {
    warn(emailProblemLine(emailSetup.problem));
  }
  const email = emailSetup.on
    ? createEmailNotifications({
        settings: emailSetup.settings,
        sender: (options.createEmailSender ?? createSmtpSender)(emailSetup.settings),
        now,
      })
    : null;
  const emailOff = emailOffStatus(emailSetup.on ? null : emailSetup.problem);
  const branches = createBranchFinder({ now });
  // The same for the webhook: with no address set, nothing that could post is
  // made, and Node's HTTPS client is never loaded.
  const webhookSetup = readWebhookSetup(env);
  if (!webhookSetup.on && webhookSetup.problem !== null) {
    warn(webhookProblemLine(webhookSetup.problem));
  }
  const createWebhookSender: CreateWebhookSender =
    options.createWebhookSender ??
    ((settings) => createHttpSender(settings, { version: options.version }));
  const webhook = webhookSetup.on
    ? createWebhookNotifications({
        settings: webhookSetup.settings,
        sender: createWebhookSender(webhookSetup.settings),
        now,
      })
    : null;
  const webhookOff = webhookOffStatus(webhookSetup.on ? null : webhookSetup.problem);
  const poller = createPoller({
    // Each adapter is told how often it will be polled so that it can say so.
    adapters: options.adapters ?? [
      createClaudeCodeAdapter({
        env: options.env,
        now,
        pollIntervalMs: intervalMs,
        panes,
        terminals: tabs,
      }),
      createCodexAdapter({ env: options.env, now, pollIntervalMs: intervalMs }),
      createStatusFileAdapter({ env: options.env, now, pollIntervalMs: intervalMs }),
    ],
    events,
    history,
    intervalMs,
    now,
    // Every source's sessions alike are given the branch of their folder.
    annotate: (sessions) => branches.annotate(sessions),
    // The poller runs for as long as the app does, with a dashboard open or
    // not, so a wait that begins with no page open is still seen here.
    onSnapshot: (snapshot) => {
      email?.handle(snapshot);
      webhook?.handle(snapshot);
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
    webhook: () => webhook?.status() ?? webhookOff,
    jump: createJumpRoute({ poller, panes, run: tmux, tabs, osascript, now }),
    now,
  });

  return {
    start: () => poller.start(),
    stop: () => poller.stop(),
    handler,
    poller,
    email,
    webhook,
  };
}
