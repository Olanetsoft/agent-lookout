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

/** One adapter's way to ask the finder about its sessions' processes. */
export interface PaneAsker {
  /**
   * Says which processes this asker wants panes for, in place of the ones it
   * named before, and looks for the pane of each process every asker names,
   * when a look is due. It never throws and never rejects. A look that fails
   * finds no pane.
   */
  look(pids: readonly number[]): Promise<void>;
  /** The pane the last look found this process in, if it found one. */
  paneOf(pid: number): TmuxPane | undefined;
}

export interface PaneFinder {
  /**
   * A new asker. Each adapter that has sessions in terminals asks through one
   * of its own, so a look one of them asks for never drops the processes
   * another named.
   */
  asker(): PaneAsker;
  /** The pane the last look found this process in, if it found one, whichever asker named it. */
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
 * Each adapter names its own processes through an asker of its own. A look is
 * for the processes every asker named at its latest look, all at once, so two
 * adapters cost no more than one, and a process no asker names any more is
 * forgotten. A look already under way is waited for, so each asker knows what
 * it found.
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
  /** The processes each asker named at its latest look. */
  const named = new Map<object, ReadonlySet<number>>();
  /** The look being made, while one is. */
  let underWay: Promise<void> | null = null;

  /** Every process some asker names. */
  function wanted(): Set<number> {
    const pids = new Set<number>();
    for (const own of named.values()) for (const pid of own) pids.add(pid);
    return pids;
  }

  function due(pids: ReadonlySet<number>, at: number): boolean {
    // A clock that was set back starts the beat again.
    if (lookedAt === null || at < lookedAt) return true;
    const since = at - lookedAt;
    if (since >= intervalMs) return true;
    return since >= soonestMs && [...pids].some((pid) => !asked.has(pid));
  }

  async function find(pids: ReadonlySet<number>): Promise<Map<number, TmuxPane>> {
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

  async function look(asker: object, pids: readonly number[]): Promise<void> {
    named.set(asker, new Set(pids));
    while (underWay !== null) await underWay;

    // A process no asker names any more is forgotten: its pane, and that it
    // was asked about, so one that is named again counts as one that has
    // turned up.
    const pidsNow = wanted();
    for (const pid of found.keys()) {
      if (!pidsNow.has(pid)) found.delete(pid);
    }
    for (const pid of asked) {
      if (!pidsNow.has(pid)) asked.delete(pid);
    }
    if (pidsNow.size === 0) return;
    const at = now();
    if (!due(pidsNow, at)) return;
    lookedAt = at;
    asked = pidsNow;
    const looking = (async () => {
      try {
        found = await find(pidsNow);
      } catch {
        found = new Map();
      }
    })();
    underWay = looking;
    try {
      await looking;
    } finally {
      if (underWay === looking) underWay = null;
    }
  }

  const paneOf = (pid: number) => found.get(pid);

  return {
    asker() {
      const asker = {};
      return { look: (pids) => look(asker, pids), paneOf };
    },
    paneOf,
    lookAgain() {
      lookedAt = null;
    },
  };
}
