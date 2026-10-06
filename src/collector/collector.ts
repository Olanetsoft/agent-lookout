import type { HistoryRestart } from "../core/api.ts";
import type { SessionsSnapshot } from "../core/sessions/session.ts";
import { createCleanUpRoute } from "./actions/cleanUpRoute.ts";
import { createStopRoute } from "./actions/stopRoute.ts";
import { createActionLimiter, createStopper, type StopperOptions } from "./actions/stopSession.ts";
import { createStopTargets, stopOff } from "./actions/stopTargets.ts";
import { unendedWaits } from "../core/waits/waitTotals.ts";
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
import { createEventStore, EVENT_CAPACITY } from "./eventStore.ts";
import { createBranchFinder } from "./git/branchFinder.ts";
import { createApiHandler, type ApiHandler } from "./handler.ts";
import { createClearHistoryRoute } from "./history/clearRoute.ts";
import type { HistoryFs } from "./history/historyFiles.ts";
import {
  createHistoryKeeper,
  keptEventStore,
  keptHistoryStore,
  type HistoryKeeper,
} from "./history/historyKeeper.ts";
import { memoryOnlyStatus } from "./history/historyLimits.ts";
import { readHistorySetup } from "./history/historySettings.ts";
import { createHistoryStore, HISTORY_CAPACITY } from "./historyStore.ts";
import { createJumpRoute } from "./jumpRoute.ts";
import {
  createServerNotifications,
  notificationsAtStartLine,
  notificationsOnAtStart,
} from "./notifications/serverNotifications.ts";
import {
  createSystemNotifier,
  systemNotificationsShownOn,
  type SystemNotifier,
} from "./notifications/systemNotifier.ts";
import { createPoller, POLL_INTERVAL_MS, type Poller } from "./poller.ts";
import type { ReadProcessStarts } from "./processes/processStart.ts";
import { parentsIn, type ReadProcessTable } from "./processes/processTable.ts";
import { createOsascriptRunner, type RunOsascript } from "./terminal/program.ts";
import { createTabFinder } from "./terminal/tabFinder.ts";
import { createPaneFinder } from "./tmux/paneFinder.ts";
import { createTmuxRunner, type RunTmux } from "./tmux/program.ts";
import { createWaitLedger, ledgerEventStore, ledgerHistoryStore } from "./waits/waitLedger.ts";
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
   * history settings, the email settings and the webhook settings are read.
   * Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * What the history is read from and written to, in the folder
   * `AGENT_LOOKOUT_HISTORY_DIR` names, or `~/.agent-lookout/history`. Defaults
   * to the real file system. With `AGENT_LOOKOUT_HISTORY=off` nothing is.
   */
  historyFs?: HistoryFs;
  /** How often the history held in memory is written. Defaults to every 5 seconds. */
  historyFlushMs?: number;
  /**
   * What shows a notification on this machine when no dashboard page will.
   * Defaults to the system's own, which is `osascript` on macOS and nothing
   * anywhere else. Tests pass one that shows nothing.
   */
  notifier?: SystemNotifier;
  /**
   * The system the collector runs on, which says whether the system's own
   * notifications can be shown. Defaults to this machine's. Tests pass another.
   */
  platform?: NodeJS.Platform;
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
   * Reads every process's parent, terminal and program, to find the tmux pane
   * and the Terminal or iTerm2 tab a session runs in. Defaults to asking `ps`.
   * Tests pass a table of their own.
   */
  readProcesses?: ReadProcessTable;
  /**
   * Reads when processes started, to tell a Claude Code session's process from
   * another that has since been given its pid, and again, with nothing
   * remembered, before a session is stopped. Defaults to asking `ps`. Tests
   * pass their own, so that, with `readProcesses`, the collector runs no `ps`.
   */
  readProcessStarts?: ReadProcessStarts;
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
  /**
   * How the routes that stop sessions act: what sends a signal, how long they
   * wait for a process to end and the clock they wait by, what runs
   * `claude stop`, and what asks `ps` for a start time. Defaults to the real
   * ones. Tests pass a clock that runs ahead, or a runner of their own. Every
   * check is made whatever is passed.
   */
  stopping?: Omit<StopperOptions, "env">;
  /**
   * Told each poll's sessions, after the collector's own notifications, email
   * and webhook have been. The Mac app puts the count that needs you on its
   * Dock icon. A listener that throws changes nothing for the others.
   */
  onSnapshot?: (snapshot: SessionsSnapshot) => void;
  intervalMs?: number;
  now?: () => number;
}

export interface Collector {
  /**
   * Begins polling, once the history kept on disk has been read back, and
   * begins writing it.
   */
  start(): void;
  /** Resolves once polling has begun: at once, or when the history has been read back. */
  whenStarted(): Promise<void>;
  /** Stops polling, and writes what is left of the history at once. */
  stop(): void;
  /** Answers `/api/*`. Mount it in any Node HTTP server. */
  handler: ApiHandler;
  poller: Poller;
  /** The email notifications, or null while email is not set up. */
  email: EmailNotifications | null;
  /** The webhook notifications, or null while no webhook address is set. */
  webhook: WebhookNotifications | null;
  /** What keeps the history on disk, or null with `AGENT_LOOKOUT_HISTORY=off`. */
  history: HistoryKeeper | null;
}

/**
 * The collector in one piece: adapters, poller, stores, the history kept on
 * disk unless `AGENT_LOOKOUT_HISTORY` is off, its own notifications,
 * the email and webhook notifications when they are set up, what finds and
 * selects a tmux pane, what finds and brings forward a Terminal or iTerm2 tab,
 * what stops a Claude Code session when the person asks, unless
 * `AGENT_LOOKOUT_STOP` is off, what reads each session's git branch, and the
 * request handler. Every host builds it the same way: the dev server, the
 * standalone server, and later a desktop app.
 */
export function createCollector(options: CollectorOptions): Collector {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const warn = options.warn ?? console.error;
  // The stores in memory are what the page reads. With history kept on disk,
  // what they take is also written, and what was written is read back into
  // them before the first poll.
  const memoryEvents = createEventStore();
  const memoryHistory = createHistoryStore();
  const historySetup = readHistorySetup(env);
  const keeper = historySetup.on
    ? createHistoryKeeper({
        dir: historySetup.dir,
        folder: historySetup.folder,
        fs: options.historyFs,
        flushIntervalMs: options.historyFlushMs,
        sources: historySetup.sources,
        now,
        warn,
      })
    : null;
  // What `GET /api/waits` is worked out from: the waits and the stretches
  // measured over nine days, further back than the stores hold. It takes what
  // the stores take, and what the history on disk held as it is read back.
  const ledger = createWaitLedger();
  const events = ledgerEventStore(
    keeper ? keptEventStore(memoryEvents, keeper) : memoryEvents,
    ledger,
  );
  const history = ledgerHistoryStore(
    keeper ? keptHistoryStore(memoryHistory, keeper) : memoryHistory,
    ledger,
  );
  // The panes the Claude Code adapter finds are the ones the jump route selects,
  // so the two share one finder and one way of running tmux.
  const tmux = options.tmux ?? createTmuxRunner({ env });
  // A table a test hands in stands in for every `ps` the finders run: the pane
  // finder reads each process's parent from it.
  const { readProcesses } = options;
  const panes = createPaneFinder({
    run: tmux,
    readParents: readProcesses && (async () => parentsIn(await readProcesses())),
    now,
  });
  // The same for the tabs of Terminal and iTerm2: the adapter finds them and
  // the jump route brings them forward.
  const tabs = createTabFinder({ env, readProcesses: options.readProcesses, now });
  const osascript = options.osascript ?? createOsascriptRunner({ env });
  // What each Claude Code session is stopped by: the adapter finds it, and the
  // routes that stop sessions act on it. With AGENT_LOOKOUT_STOP off there are
  // neither the targets nor the routes.
  const stopsOn = !stopOff(env);
  const stopTargets = stopsOn ? createStopTargets() : undefined;
  const platform = options.platform ?? process.platform;
  const notifications = createServerNotifications({
    notifier: options.notifier ?? createSystemNotifier({ platform }),
    onAtStart: notificationsOnAtStart(env),
    now,
  });
  // A notifier handed in, as a desktop host's would be, is taken to show them.
  const notificationsLine = notificationsAtStartLine(
    env,
    options.notifier !== undefined || systemNotificationsShownOn(platform),
  );
  if (notificationsLine !== null) warn(notificationsLine);
  // Read once, here. With nothing set, nothing that could send an email is
  // made, and the mail library is never loaded.
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
        readProcessStarts: options.readProcessStarts,
        stops: stopTargets,
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
      options.onSnapshot?.(snapshot);
    },
  });
  const stopper = createStopper({
    env,
    now,
    readStarts: options.readProcessStarts,
    readParents: readProcesses && (async () => parentsIn(await readProcesses())),
    ...options.stopping,
  });
  const stopRoutes = stopTargets && {
    poller,
    events,
    targets: stopTargets,
    stopper,
    limiter: createActionLimiter(now),
  };
  const handler = createApiHandler({
    version: options.version,
    poller,
    events,
    history,
    notifications,
    email: () => email?.status() ?? emailOff,
    webhook: () => webhook?.status() ?? webhookOff,
    jump: createJumpRoute({ poller, panes, run: tmux, tabs, osascript, now }),
    stop: stopRoutes && createStopRoute(stopRoutes),
    cleanUp: stopRoutes && createCleanUpRoute(stopRoutes),
    clearHistory: createClearHistoryRoute({
      keeper,
      forget: () => {
        memoryEvents.clear();
        memoryHistory.clear();
        ledger.clear();
        restarts = [];
        lastKept = null;
      },
    }),
    historyKept: () => ({
      since: keeper?.since() ?? null,
      kept: keeper?.status() ?? memoryOnlyStatus(),
      restarts: restartsHeld(),
    }),
    waits: () => {
      const since = keeper?.since() ?? { at: poller.startedAt, by: "started" as const };
      return ledger.answer({
        now: now(),
        snapshot: poller.getSnapshot(),
        since,
        runStarts: [since.at, ...restartsHeld().map((restart) => restart.at), poller.startedAt],
        where: keeper ? "disk" : "memory",
      });
    },
    ready: () => restoring,
    now,
  });

  let running = false;
  let restored = keeper === null;
  /** While the history on disk is read back, before the first poll. */
  let restoring: Promise<void> | null = null;
  /** The restarts in the history read back, oldest first. */
  let restarts: HistoryRestart[] = [];
  /** The newest moment the history read back holds, or null when it held nothing. */
  let lastKept: number | null = null;

  /**
   * The restarts in the history held, this run's start among them when it
   * followed history kept from before. Nothing was measured from the last
   * moment before each one to the start, however short the stop.
   */
  function restartsHeld(): HistoryRestart[] {
    const startedAt = poller.startedAt;
    if (lastKept === null || lastKept >= startedAt) return restarts;
    return [...restarts, { at: startedAt, lastBefore: lastKept }];
  }

  function begin(): void {
    ledger.beginRun();
    keeper?.start();
    poller.start();
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (restored || keeper === null) {
        begin();
        return;
      }
      restoring = keeper
        .restore({ events: EVENT_CAPACITY, points: HISTORY_CAPACITY })
        .then((kept) => {
          restored = true;
          memoryEvents.add(kept.events);
          for (const point of kept.points) memoryHistory.add(point);
          restarts = kept.restarts;
          lastKept = kept.lastAt;
          ledger.restore(kept.whole);
          // What each session was last doing, so that what changed while
          // Agent Lookout was stopped is recorded at the first poll. A session
          // whose wait began before the newest events held is among them, so
          // its wait is ended by the first poll that finds it answered or gone.
          poller.resume([...unendedWaits(kept.whole.waitEvents), ...kept.events]);
          if (running) begin();
        })
        .catch(() => {
          // The keeper never rejects. Polling begins all the same.
          restored = true;
          if (running) begin();
        })
        .finally(() => {
          restoring = null;
        });
    },
    whenStarted: () => restoring ?? Promise.resolve(),
    stop() {
      running = false;
      poller.stop();
      keeper?.stop();
    },
    handler,
    poller,
    email,
    webhook,
    history: keeper,
  };
}
