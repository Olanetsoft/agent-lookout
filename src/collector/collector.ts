import type { HistoryRestart } from "../core/api.ts";
import type { SessionsSnapshot } from "../core/sessions/session.ts";
import { staleAfterMs } from "../core/time-rules/timeRules.ts";
import { createCleanUpRoute } from "./actions/cleanUpRoute.ts";
import { createStopRoute } from "./actions/stopRoute.ts";
import { createActionLimiter, createStopper, type StopperOptions } from "./actions/stopSession.ts";
import { createStopTargets, stopOff } from "./actions/stopTargets.ts";
import { createAnswering, type Answering, type AnsweringOptions } from "./answers/answering.ts";
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
import { createGhAsker, type AskGh } from "./github/gh.ts";
import { createPullRequestFinder, type PullRequestFinder } from "./github/pullRequestFinder.ts";
import {
  pullRequestsOffStatus,
  pullRequestsProblemLine,
  readPullRequestsSetup,
} from "./github/pullRequestSettings.ts";
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
import { createRemotes, type Remotes, type RemotesOptions } from "./remotes/remotes.ts";
import { remotesProblemLine } from "./remotes/remoteSettings.ts";
import type { ReadProcessStarts } from "./processes/processStart.ts";
import {
  createCollectorSettings,
  type CollectorSettings,
  type SettingsStore,
} from "./settings/collectorSettings.ts";
import { readSettingsSetup } from "./settings/settingsFile.ts";
import { createTimeRulesRoute } from "./settings/timeRulesRoute.ts";
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
   * history settings, the email settings, the webhook settings and
   * `AGENT_LOOKOUT_SETTINGS_FILE` are read. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * What reads and writes the settings file, `~/.agent-lookout/settings.json`
   * or the one `AGENT_LOOKOUT_SETTINGS_FILE` names. Defaults to the real file
   * system. Tests pass a file of their own in the environment, or this.
   */
  settingsStore?: SettingsStore;
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
   * What asks the person's own gh for a branch's pull request, once
   * `AGENT_LOOKOUT_PULL_REQUESTS=on` is set. Defaults to the gh on this
   * machine. With the setting off it is never called. Tests pass a stand-in.
   */
  gh?: AskGh;
  /**
   * Where the one line goes that says email, the webhook or pull requests are
   * off because a setting is wrong. Defaults to the console's errors.
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
   * How permission prompts are answered from the dashboard: where the home
   * folder is, what reads a session's registry file again and what runs the
   * held requests' checks. Defaults to the real ones. The socket is opened as
   * the collector starts, unless `AGENT_LOOKOUT_ANSWER` is off. A collector
   * handed adapters of its own opens none unless this is passed.
   */
  answering?: Pick<AnsweringOptions, "homeDir" | "status" | "every" | "platform">;
  /**
   * How the other machines `AGENT_LOOKOUT_REMOTES` names are reached: how ssh
   * is found, started and started again, and how a machine is read through
   * its tunnel. Defaults to the real ones. Tests shorten the waits, and name a
   * stand-in ssh in the environment.
   */
  remotes?: Pick<RemotesOptions, "tunnels" | "read">;
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
   * begins writing it. The tunnels to other machines start at once.
   */
  start(): void;
  /** Resolves once polling has begun: at once, or when the history has been read back. */
  whenStarted(): Promise<void>;
  /** Stops polling, writes what is left of the history at once, and ends every ssh it started. */
  stop(): void;
  /** Answers `/api/*`. Mount it in any Node HTTP server. */
  handler: ApiHandler;
  poller: Poller;
  /** The email notifications, or null while email is not set up. */
  email: EmailNotifications | null;
  /** The webhook notifications, or null while no webhook address is set. */
  webhook: WebhookNotifications | null;
  /** What gives each branch its pull request, or null while `AGENT_LOOKOUT_PULL_REQUESTS` is not on. */
  pullRequests: PullRequestFinder | null;
  /** What keeps the history on disk, or null with `AGENT_LOOKOUT_HISTORY=off`. */
  history: HistoryKeeper | null;
  /** Answering permission prompts: resolves once its socket listens, or has said why not. */
  answering: Pick<Answering, "start" | "stop">;
  /** The other machines read over SSH, none unless `AGENT_LOOKOUT_REMOTES` names them. */
  remotes: Remotes;
  /** The settings the collector keeps itself: the time rules. */
  settings: CollectorSettings;
}

/**
 * The collector in one piece: adapters, poller, stores, the history kept on
 * disk unless `AGENT_LOOKOUT_HISTORY` is off, its own notifications,
 * the email and webhook notifications when they are set up, what finds and
 * selects a tmux pane, what finds and brings forward a Terminal or iTerm2 tab,
 * what stops a Claude Code session when the person asks, unless
 * `AGENT_LOOKOUT_STOP` is off, what holds a Claude Code session's permission
 * request and answers it when the person presses Allow or Deny, unless
 * `AGENT_LOOKOUT_ANSWER` is off, what reads each session's git branch, with
 * `AGENT_LOOKOUT_PULL_REQUESTS=on` what asks gh for each branch's pull request,
 * the other machines `AGENT_LOOKOUT_REMOTES` names, each read through an ssh
 * tunnel of its own, the time rules kept in its settings file, and the
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
  // Read once, here, as the collector starts. A change made in the dashboard
  // is put in force at once and written back.
  const settings = createCollectorSettings({
    setup: readSettingsSetup(env),
    store: options.settingsStore,
  });
  if (settings.problemAtStart !== null) warn(settings.problemAtStart);
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
  // Read once, here, as email's settings are. With pull requests off, gh is
  // never looked for, and no repository's configuration is read.
  const pullRequestsSetup = readPullRequestsSetup(env);
  if (!pullRequestsSetup.on && pullRequestsSetup.problem !== null) {
    warn(pullRequestsProblemLine(pullRequestsSetup.problem));
  }
  const pullRequests = pullRequestsSetup.on
    ? createPullRequestFinder({
        gitFolderOf: (cwd) => branches.gitFolderOf(cwd),
        ask: options.gh ?? createGhAsker({ env }),
        now,
      })
    : null;
  const pullRequestsOff = pullRequestsOffStatus(
    pullRequestsSetup.on ? null : pullRequestsSetup.problem,
  );
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
  // The other machines: with none named, no ssh is looked for or run.
  const remotes = createRemotes({
    env,
    version: options.version,
    now,
    pollIntervalMs: intervalMs,
    ...options.remotes,
  });
  if (remotes.problem !== null) warn(remotesProblemLine(remotes.problem));
  const localAdapters = options.adapters ?? [
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
  ];
  const poller = createPoller({
    // Each adapter is told how often it will be polled so that it can say so.
    // The other machines come after this one's own sources.
    adapters: [...localAdapters, ...remotes.adapters],
    events,
    history,
    intervalMs,
    now,
    // Every source's sessions alike are given the branch of their folder, and
    // with pull requests on, the branch's pull request, as last learnt.
    // Every snapshot carries the time rules in force, and is stale by them.
    timeRules: () => settings.timeRules(),
    annotate: async (sessions) => {
      const onBranches = await branches.annotate(sessions);
      return pullRequests ? pullRequests.annotate(onBranches) : onBranches;
    },
    // The poller runs for as long as the app does, with a dashboard open or
    // not, so a wait that begins with no page open is still seen here.
    onSnapshot: (snapshot) => {
      answering?.observe(snapshot);
      email?.handle(snapshot);
      webhook?.handle(snapshot);
      notifications.handle(snapshot);
      options.onSnapshot?.(snapshot);
    },
  });
  // The permission requests the plugin's hook sends, held while each session
  // waits. What the page is sent of them is added to the snapshot as it is
  // served, so nothing that keeps or sends a snapshot ever sees them.
  // Only the Claude Code adapter the collector builds itself reads the
  // registry the held requests are checked against, so a collector handed
  // adapters of its own answers nothing, unless it is told how to.
  const answers = options.adapters === undefined || options.answering !== undefined;
  const answering: Answering | null = answers
    ? createAnswering({ env, poller, events, now, warn, ...options.answering })
    : null;
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
    staleAfterMs: () => staleAfterMs(settings.timeRules()),
  };
  const handler = createApiHandler({
    version: options.version,
    poller,
    serveSnapshot: answering ? (snapshot) => answering.serve(snapshot) : undefined,
    answer: answering?.route,
    events,
    history,
    notifications,
    email: () => email?.status() ?? emailOff,
    webhook: () => webhook?.status() ?? webhookOff,
    pullRequests: () => pullRequests?.status() ?? pullRequestsOff,
    jump: createJumpRoute({ poller, panes, run: tmux, tabs, osascript, now }),
    stop: stopRoutes && createStopRoute(stopRoutes),
    cleanUp: stopRoutes && createCleanUpRoute(stopRoutes),
    settings: () => settings.status(),
    timeRules: createTimeRulesRoute({ settings }),
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
  /** While the answer socket is being opened, or once it has been. */
  let answerStart: Promise<void> | null = null;
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
      answerStart ??= answering?.start() ?? Promise.resolve();
      remotes.start();
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
      answerStart = null;
      void answering?.stop();
      void remotes.stop();
    },
    handler,
    poller,
    email,
    webhook,
    pullRequests,
    history: keeper,
    answering: {
      start: () => (answerStart ??= answering?.start() ?? Promise.resolve()),
      stop: async () => {
        await answering?.stop();
      },
    },
    remotes,
    settings,
  };
}
