import os from "node:os";

import { readProcessTableWithPs, type ReadProcessTable } from "./processTable.ts";
import { terminalJumpOff } from "./program.ts";
import { tabOfProcess, type TerminalTab } from "./terminalTabs.ts";

/** The soonest `ps` is asked again, when a process has turned up since the last time. */
export const TAB_LOOK_SOONEST_MS = 5_000;

export interface TabFinderOptions {
  /** Where `AGENT_LOOKOUT_TERMINAL_JUMP` is read. */
  env: NodeJS.ProcessEnv;
  /** Where iTerm2 keeps its server. Defaults to this user's home folder. */
  homeDir?: string;
  /**
   * Reads every process's parent, terminal and program. Defaults to asking
   * `ps`, which is done on macOS alone: anywhere else the table is empty.
   */
  readProcesses?: ReadProcessTable;
  now?: () => number;
  soonestMs?: number;
}

export interface TabFinder {
  /**
   * Looks for the tab of each of these processes that has not been looked for
   * yet. It never throws and never rejects. A look that fails finds no tab,
   * and is made again later.
   */
  look(pids: readonly number[]): Promise<void>;
  /** The tab a process was found in, if one was. */
  tabOf(pid: number): TerminalTab | undefined;
  /** Forgets what was found for a process, so it is looked for again. */
  forget(pid: number): void;
}

/**
 * Finds which tab of Terminal or iTerm2 a process runs in, and remembers it.
 *
 * A process keeps its terminal and its parents for as long as it runs, so each
 * is looked for once. A look runs `ps` once for every process that turned up
 * since the last, never within 5 seconds of the last look. With no new process,
 * nothing is run. A process that has gone is forgotten.
 *
 * Nothing is looked for while `AGENT_LOOKOUT_TERMINAL_JUMP` is `off`, and
 * `ps` is not asked anywhere but macOS.
 */
export function createTabFinder(options: TabFinderOptions): TabFinder {
  const off = terminalJumpOff(options.env);
  const homeDir = options.homeDir ?? os.homedir();
  const readProcesses = options.readProcesses ?? readProcessTableWithPs;
  const now = options.now ?? Date.now;
  const soonestMs = options.soonestMs ?? TAB_LOOK_SOONEST_MS;

  /** What each process asked about came to: its tab, or null when it has none. */
  const found = new Map<number, TerminalTab | null>();
  let lookedAt: number | null = null;

  return {
    async look(pids) {
      if (off) return;
      const current = new Set(pids);
      for (const pid of found.keys()) {
        if (!current.has(pid)) found.delete(pid);
      }
      const unasked = [...current].filter((pid) => !found.has(pid));
      if (unasked.length === 0) return;

      const at = now();
      // A clock that was set back does not hold a look back.
      if (lookedAt !== null && at >= lookedAt && at - lookedAt < soonestMs) return;
      lookedAt = at;

      let table: Awaited<ReturnType<ReadProcessTable>>;
      try {
        table = await readProcesses();
      } catch {
        return;
      }
      // A process `ps` did not list, as when it did not answer or was not
      // asked, is asked about again at the next look.
      for (const pid of unasked) {
        if (table.has(pid)) found.set(pid, tabOfProcess(pid, table, homeDir) ?? null);
      }
    },
    tabOf: (pid) => found.get(pid) ?? undefined,
    forget(pid) {
      found.delete(pid);
    },
  };
}
