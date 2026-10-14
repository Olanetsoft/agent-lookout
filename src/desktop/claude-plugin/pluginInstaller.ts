// The one time the Mac app installs its Claude Code plugin, so Allow and Deny
// work from the first day: the first time the packaged app opens, in the
// background, when it finds the `claude` program it runs for `claude agents`
// and the plugin is not installed.
//
// It runs Claude Code's own commands, and nothing else: `claude plugin list`,
// to see whether a line names the plugin, then `claude plugin marketplace add
// Olanetsoft/agent-lookout`, `claude plugin install agent-lookout@agent-lookout`
// and `claude plugin list` again, to be sure. Each is started directly, never
// through a shell, with fixed arguments, stdin closed and a timeout, through
// the same `runProgram` as `claude agents`, in the same environment. Claude
// Code fetches the marketplace from GitHub and writes the plugin in its own
// folder: that is the one change under `~/.claude`, and it is Claude Code's.
// Of what `claude plugin list` prints, only whether a line names the plugin is
// kept, and the rest is dropped at once.
//
// Before the first command runs, `plugin-install-state.json` says it tried, so
// it never tries again: not after it worked, not after it failed, and not
// after it found the plugin there already. A plugin the person removes stays
// removed. A record that cannot be read, or written, means nothing runs.
//
// Nothing runs in a development run, which shares the packaged app's folder of
// user data, nor where the plugin could do nothing: with answering off, on
// Windows, or where the app does not run `claude` at all. Those are not
// remembered, so a later launch with the defaults can still install it.
// `AGENT_LOOKOUT_PLUGIN_INSTALL=off` at the first launch is remembered, and
// nothing ever runs.
//
// It imports nothing from Electron, so it is tested in plain Node.

import os from "node:os";

import {
  MARKETPLACE_ADD_ARGS,
  PLUGIN_ID,
  PLUGIN_INSTALL_ARGS,
  PLUGIN_LIST_ARGS,
  commandLine,
  type PluginInstallStatus,
  type PluginInstallStep,
} from "../../core/answers/pluginInstall.ts";
import {
  feedEnvironment,
  runProgram,
  type RunCommand,
  type RunResult,
} from "../../collector/adapters/claude-code/feed.ts";
import {
  CLAUDE_BIN_ENV,
  findClaudeBinary,
  type BinarySearch,
} from "../../collector/adapters/claude-code/findBinary.ts";
import { CLAUDE_FEED_ENV, CLAUDE_HOME_ENV } from "../../collector/adapters/claude-code/index.ts";
import { readAnswerSetup } from "../../collector/answers/answerSettings.ts";
import {
  PLUGIN_INSTALL_FILE,
  type PluginInstallOutcome,
  type PluginInstallRecord,
  type PluginInstallStore,
} from "./pluginInstallSettings.ts";

/** Set to `off` before the app first opens, and it never installs the plugin. */
export const PLUGIN_INSTALL_ENV = "AGENT_LOOKOUT_PLUGIN_INSTALL";

/** How long `claude plugin list` gets. */
export const LIST_TIMEOUT_MS = 30_000;

/** How long `claude plugin marketplace add` gets: a git fetch of this repository. */
export const MARKETPLACE_TIMEOUT_MS = 180_000;

/** How long `claude plugin install` gets. */
export const INSTALL_TIMEOUT_MS = 120_000;

/** Terminal colour and cursor codes, which may sit around the plugin's id. */
// eslint-disable-next-line no-control-regex
const TERMINAL_CODES = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** The id, with nothing that could belong to a longer id on either side. */
const NAMES_PLUGIN = new RegExp(
  `(^|[^A-Za-z0-9._@/-])${PLUGIN_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9._@/-])`,
);

/** Whether `claude plugin list` printed a line naming the plugin. Nothing else is read from it. */
export function namesPlugin(stdout: string): boolean {
  return stdout
    .replace(TERMINAL_CODES, "")
    .split(/\r?\n/)
    .some((line) => NAMES_PLUGIN.test(line));
}

/**
 * Why this launch installs nothing, with whether that is remembered:
 *
 * development     a development run, which shares the packaged app's record
 * turned-off      `AGENT_LOOKOUT_PLUGIN_INSTALL=off`, remembered at the first launch
 * answering-off   permission prompts are not answered here, so the plugin would do nothing
 * claude-not-run  the app does not run `claude` at all
 */
export type PluginInstallRefusal =
  | { why: "development" | "answering-off" | "claude-not-run"; recorded: false }
  | { why: "turned-off"; recorded: true };

export interface InstallRefusalOptions {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
  packaged: boolean;
}

/** Why this launch installs nothing, or null when it may. */
export function installRefusal(options: InstallRefusalOptions): PluginInstallRefusal | null {
  const { env, homeDir, platform, packaged } = options;
  if (!packaged) return { why: "development", recorded: false };
  if (env[PLUGIN_INSTALL_ENV]?.trim().toLowerCase() === "off") {
    return { why: "turned-off", recorded: true };
  }
  // Covers AGENT_LOOKOUT_ANSWER=off, Windows, and AGENT_LOOKOUT_CLAUDE_HOME without a socket.
  if (!readAnswerSetup(env, homeDir, platform).on) return { why: "answering-off", recorded: false };
  // Run only where Agent Lookout would run `claude agents`.
  const feedOff = env[CLAUDE_FEED_ENV]?.trim().toLowerCase() === "off";
  const withheld = Boolean(env[CLAUDE_HOME_ENV]?.trim()) && !env[CLAUDE_BIN_ENV]?.trim();
  if (feedOff || withheld) return { why: "claude-not-run", recorded: false };
  return null;
}

export interface PluginInstaller {
  /** Runs the one-time install if this launch should. Never rejects; resolves when done or skipped. */
  start(): Promise<void>;
  /** What the Overview is told. */
  status(): PluginInstallStatus;
  /** What the Overview said was dismissed: remembered, and never said again. */
  markTold(): PluginInstallStatus;
  /** As the app quits: no further step starts. */
  stop(): void;
}

export interface PluginInstallerOptions {
  env: NodeJS.ProcessEnv;
  /** Defaults to this user's. */
  homeDir?: string;
  /** Defaults to this one. */
  platform?: NodeJS.Platform;
  /** Whether this is the packaged app, `app.isPackaged`. */
  packaged: boolean;
  settings: PluginInstallStore;
  now?: () => number;
  /** Defaults to `runProgram`, as for `claude agents`. */
  run?: RunCommand;
  /** Defaults to `findClaudeBinary`, which finds the `claude` that `claude agents` runs. */
  findBinary?: () => Promise<BinarySearch>;
  /** For tests. */
  timeoutsMs?: Partial<{ list: number; marketplace: number; install: number }>;
  /** The app's log. */
  warn?: (line: string) => void;
}

const UNREADABLE = `The record of the Claude Code plugin's install, ${PLUGIN_INSTALL_FILE}, could not be read, so Agent Lookout installs nothing.`;
const UNWRITABLE = `Agent Lookout could not remember in ${PLUGIN_INSTALL_FILE} that it tried to install its Claude Code plugin, so it installs nothing.`;

/** The command a step ran, as a person would type it. */
function commandOf(step: PluginInstallStep): string {
  switch (step) {
    case "marketplace":
      return commandLine(MARKETPLACE_ADD_ARGS);
    case "install":
      return commandLine(PLUGIN_INSTALL_ARGS);
    default:
      return commandLine(PLUGIN_LIST_ARGS);
  }
}

/** The one line the log gets of how it ended. Never anything the command printed. */
function logLine(outcome: PluginInstallOutcome, step: PluginInstallStep | null, why: string) {
  switch (outcome) {
    case "installed":
      return `Agent Lookout installed its Claude Code plugin, ${PLUGIN_ID}.`;
    case "already-installed":
      return "Agent Lookout found its Claude Code plugin installed already, so it installed nothing.";
    case "turned-off":
      return `${PLUGIN_INSTALL_ENV} is off, so Agent Lookout does not install its Claude Code plugin.`;
    default:
      return step === "unfinished"
        ? "Agent Lookout quit before it finished installing its Claude Code plugin, and does not try again."
        : `Agent Lookout could not install its Claude Code plugin: ${commandOf(step ?? "check")} ${why}.`;
  }
}

/** The one-time install of the Claude Code plugin. */
export function createPluginInstaller(options: PluginInstallerOptions): PluginInstaller {
  const env = options.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const run = options.run ?? runProgram;
  const findBinary = options.findBinary ?? (() => findClaudeBinary({ env, homeDir, platform }));
  const timeouts = {
    list: options.timeoutsMs?.list ?? LIST_TIMEOUT_MS,
    marketplace: options.timeoutsMs?.marketplace ?? MARKETPLACE_TIMEOUT_MS,
    install: options.timeoutsMs?.install ?? INSTALL_TIMEOUT_MS,
  };
  const warn = options.warn ?? (() => {});
  const { settings } = options;

  /** What the record says, as it was read or last written. */
  let record: PluginInstallRecord | null = null;
  let running = false;
  let stopped = false;
  let started: Promise<void> | null = null;

  /** Writes how the try ended, and logs it once. */
  function finish(
    tried: PluginInstallRecord,
    outcome: PluginInstallOutcome,
    step: PluginInstallStep | null,
    why = "",
  ): void {
    const ended: PluginInstallRecord = { ...tried, outcome, step, told: false };
    // Not written, the record still says it tried, and the next launch says it did not finish.
    settings.write(ended);
    record = ended;
    running = false;
    warn(logLine(outcome, step, why));
  }

  async function attempt(): Promise<void> {
    const refusal = installRefusal({ env, homeDir, platform, packaged: options.packaged });
    if (refusal !== null && !refusal.recorded) return;

    const reading = settings.read();
    if (reading.kind === "unreadable") {
      warn(UNREADABLE);
      return;
    }
    if (reading.kind === "record") {
      record = reading.record;
      // The app quit during an earlier try. It is said once, and not tried again.
      if (record.outcome === "running") finish(record, "failed", "unfinished");
      return;
    }

    if (refusal !== null) {
      const off: PluginInstallRecord = {
        triedAt: now(),
        outcome: "turned-off",
        step: null,
        told: false,
      };
      if (settings.write(off)) record = off;
      warn(logLine("turned-off", null, ""));
      return;
    }

    // Said at once, so a page that asks while Claude Code is looked for hears it.
    running = true;
    let step: PluginInstallStep = "check";
    let tried: PluginInstallRecord | null = null;
    try {
      const binary = await findBinary();
      if (!binary.found || stopped) {
        // Not tried, so nothing is remembered: a later launch that finds Claude Code tries then.
        running = false;
        return;
      }

      tried = { triedAt: now(), outcome: "running", step: null, told: false };
      // No command runs unless the record already says it was tried.
      if (!settings.write(tried)) {
        warn(UNWRITABLE);
        running = false;
        return;
      }
      record = tried;

      const runStep = (args: readonly string[], timeoutMs: number): Promise<RunResult> =>
        run(binary.path, args, { timeoutMs, env: feedEnvironment(env) });

      const listed = await runStep(PLUGIN_LIST_ARGS, timeouts.list);
      if (!listed.ok) return finish(tried, "failed", "check", listed.problem);
      // Installing a plugin that is there but turned off would turn it on again.
      if (namesPlugin(listed.stdout)) return finish(tried, "already-installed", null);

      if (stopped) return leaveUnderWay();
      step = "marketplace";
      const added = await runStep(MARKETPLACE_ADD_ARGS, timeouts.marketplace);
      if (!added.ok) return finish(tried, "failed", "marketplace", added.problem);

      if (stopped) return leaveUnderWay();
      step = "install";
      const installed = await runStep(PLUGIN_INSTALL_ARGS, timeouts.install);
      if (!installed.ok) return finish(tried, "failed", "install", installed.problem);

      if (stopped) return leaveUnderWay();
      step = "confirm";
      const confirmed = await runStep(PLUGIN_LIST_ARGS, timeouts.list);
      if (!confirmed.ok) return finish(tried, "failed", "confirm", confirmed.problem);
      // "Installed" is said only when the list names it.
      return namesPlugin(confirmed.stdout)
        ? finish(tried, "installed", null)
        : finish(tried, "failed", "confirm", `did not name ${PLUGIN_ID} after the install`);
    } catch {
      if (tried !== null) finish(tried, "failed", step, "ran into an unexpected problem");
      else running = false;
    }
  }

  /** The app is quitting: the record still says it is under way, and the next launch says it did not finish. */
  function leaveUnderWay(): void {
    running = false;
  }

  function status(): PluginInstallStatus {
    if (running) return { state: "running" };
    if (record === null || record.told) return { state: "idle" };
    if (record.outcome === "installed") return { state: "installed" };
    if (record.outcome === "failed" && record.step !== null) {
      return { state: "failed", step: record.step };
    }
    return { state: "idle" };
  }

  return {
    start() {
      started ??= attempt().catch(() => {
        running = false;
      });
      return started;
    },
    status,
    markTold() {
      const current = status();
      if (record !== null && (current.state === "installed" || current.state === "failed")) {
        record = { ...record, told: true };
        // Not written, it is hidden for this run and said again at the next launch.
        settings.write(record);
      }
      return status();
    },
    stop() {
      stopped = true;
    },
  };
}
