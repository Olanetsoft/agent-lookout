import { readProcessParentsWithPs, type ReadProcessParents } from "../processes/processParents.ts";
import { LIST_PANES_ARGS, paneOfProcess, parsePanes, type TmuxPane } from "./panes.ts";
import type { RunTmux } from "./program.ts";

/** How often tmux is asked where its panes are. The same beat as the `claude` command. */
export const PANE_LOOK_INTERVAL_MS = 30_000;

/**
 * The soonest it is asked again when a process has turned up that it has not
 * been asked about: a session that started since the last look.
 */
export const PANE_LOOK_SOONEST_MS = 5_000;

export interface PaneFinderOptions {
  run: RunTmux;
  /** Reads each process's parent. Defaults to asking `ps` for that and nothing more. */
  readParents?: ReadProcessParents;
  now?: () => number;
  intervalMs?: number;
  soonestMs?: number;
}

export interface PaneFinder {
  /**
   * Looks for the pane of each of these processes, when a look is due. It
   * never throws and never rejects. A look that fails finds no pane.
   */
  look(pids: readonly number[]): Promise<void>;
  /** The pane the last look found this process in, if it found one. */
  paneOf(pid: number): TmuxPane | undefined;
  /** Makes the next look due, for when tmux has said that what was found is out of date. */
  lookAgain(): void;
}

/**
 * Finds which tmux pane a process runs in, and remembers the answer.
 *
 * A look runs `tmux list-panes` once and, only when that lists a pane, `ps`
 * once for every process's parent. A process is in a pane when it, or one of
 * its ancestors, is the process tmux started in that pane.
 *
 * Each look starts a program, so looks are seldom: one when there is first a
 * process to ask about, one every 30 seconds after that, and one sooner, though
 * never within 5 seconds of the last, when a process has turned up since. With
 * no process to ask about, nothing is run. When tmux is not installed, has no
 * server running or fails, no pane is known, and that is not an error.
 */
export function createPaneFinder(options: PaneFinderOptions): PaneFinder {
  const { run } = options;
  const readParents = options.readParents ?? readProcessParentsWithPs;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? PANE_LOOK_INTERVAL_MS;
  const soonestMs = options.soonestMs ?? PANE_LOOK_SOONEST_MS;

  let lookedAt: number | null = null;
  /** The processes the last look asked about, whether or not it found them a pane. */
  let asked = new Set<number>();
  let found = new Map<number, TmuxPane>();

  function due(pids: readonly number[], at: number): boolean {
    // A clock that was set back starts the beat again.
    if (lookedAt === null || at < lookedAt) return true;
    const since = at - lookedAt;
    if (since >= intervalMs) return true;
    return since >= soonestMs && pids.some((pid) => !asked.has(pid));
  }

  async function find(pids: readonly number[]): Promise<Map<number, TmuxPane>> {
    const panes = new Map<number, TmuxPane>();
    const listed = await run(LIST_PANES_ARGS);
    if (!listed.ok) return panes;

    const panesByPid = new Map<number, TmuxPane>();
    for (const pane of parsePanes(listed.stdout)) {
      if (!panesByPid.has(pane.pid)) panesByPid.set(pane.pid, pane);
    }
    if (panesByPid.size === 0) return panes;

    const parents = await readParents();
    for (const pid of pids) {
      const pane = paneOfProcess(pid, parents, panesByPid);
      if (pane) panes.set(pid, pane);
    }
    return panes;
  }

  return {
    async look(pids) {
      if (pids.length === 0) {
        found = new Map();
        asked = new Set();
        return;
      }
      const at = now();
      if (!due(pids, at)) return;
      lookedAt = at;
      asked = new Set(pids);
      try {
        found = await find(pids);
      } catch {
        found = new Map();
      }
    },
    paneOf: (pid) => found.get(pid),
    lookAgain() {
      lookedAt = null;
    },
  };
}
