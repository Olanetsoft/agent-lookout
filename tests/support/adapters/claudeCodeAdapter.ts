// The Claude Code adapter, cut off from this machine, for the tests that share
// it: the unit tests that hand it stand-ins for everything, and the integration
// tests that give it real folders. Nothing here touches a file or a process.

import type { RunCommand } from "@collector/adapters/claude-code/feed";
import {
  createClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
} from "@collector/adapters/claude-code/index";
import { feedJson, HOME } from "@tests/fixtures/claudeCode";

/** The fixed clock every adapter here reads. */
export const now = 1_700_000_100_000;

/** A pretend claude binary. Only `isExecutable` below admits that it exists. */
export const BIN = "/opt/tools/claude";

/** A command that prints this and succeeds. */
export const prints =
  (stdout: string): RunCommand =>
  async () => ({ ok: true, stdout });

/** A command that fails, for this reason. */
export const fails =
  (problem: string): RunCommand =>
  async () => ({ ok: false, problem });

/** The fixtures' pids are invented, so `ps` must not be asked about them. */
export const noStartTimes = async () => new Map<number, string>();

/**
 * An adapter cut off from this machine: its own claude home, a pretend binary,
 * a fixed clock, and every process alive unless a test says otherwise. The
 * claude home is only a path to it, so a test that also replaces `registryIo`
 * can name a folder that does not exist.
 */
export function adapterFor(claudeHome: string, options: ClaudeCodeAdapterOptions = {}) {
  return createClaudeCodeAdapter({
    env: { AGENT_LOOKOUT_CLAUDE_HOME: claudeHome, AGENT_LOOKOUT_CLAUDE_BIN: BIN },
    homeDir: HOME,
    now: () => now,
    isAlive: () => true,
    isExecutable: async (candidate) => candidate === BIN,
    run: prints(feedJson),
    readProcessStarts: noStartTimes,
    ...options,
  });
}

/** The four facts, in the order the adapter gives them. */
export const watching = (
  folder: string,
  registryRead: string,
  commandRun: string,
  command?: string,
) => [
  { label: "Registry folder", value: folder },
  { label: "Registry read", value: registryRead },
  { label: "Command", value: command ?? "claude agents --json --all" },
  { label: "Command run", value: commandRun },
];

/** What is said when the claude command is held back because only the folder was named. */
export const WITHHELD =
  "The claude command is not run, because it would list the sessions of the usual Claude Code folder. Set AGENT_LOOKOUT_CLAUDE_BIN as well to name a command to run.";
