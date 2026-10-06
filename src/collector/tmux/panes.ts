// What tmux prints about its panes, read into shapes, and the walk from a
// process up to the pane it runs in. Pure, so every odd line can be tested.

import { oneLine } from "../../core/text.ts";

/** One pane of a tmux server. */
export interface TmuxPane {
  /** The process tmux started in the pane, usually a shell. */
  pid: number;
  /**
   * tmux's own id for the pane: `%` and a number, which no other pane of that
   * server ever gets. The only thing a command is ever aimed with.
   */
  id: string;
  /** The session, window and pane as tmux writes them, `work:2.1`. For reading only. */
  place: string;
}

/**
 * One pane a line. The session's name comes last because it is the one field
 * that can hold anything, spaces and colons included, so it is whatever is left
 * of the line.
 */
const PANE_FORMAT = "#{pane_pid} #{pane_id} #{window_index} #{pane_index} #{session_name}";

/**
 * Every pane of every session of the server. `-u` has tmux print a name as it
 * is, whatever the locale: without it a letter outside ASCII comes back as `_`.
 */
export const LIST_PANES_ARGS = ["-u", "list-panes", "-a", "-F", PANE_FORMAT] as const;

const PANE_LINE = /^(\d+) (%\d+) (\d+) (\d+) (.*)$/;
const PANE_ID = /^%\d{1,9}$/;

/** Whether a value is a pane id as tmux writes one, and nothing more. */
export function isPaneId(value: unknown): value is string {
  return typeof value === "string" && PANE_ID.test(value);
}

/**
 * A place in words: `work:2.1`. The name is shown to a person and never handed
 * to tmux, so it is tidied for reading by the rule for any name on one line:
 * control characters and the marks that reorder text become spaces, and a
 * name longer than 80 characters is cut. tmux sets no limit of its own.
 */
export function placeOf(sessionName: string, windowIndex: string, paneIndex: string): string {
  return `${oneLine(sessionName)}:${windowIndex}.${paneIndex}`;
}

/**
 * The panes in what `list-panes` printed. A line that is not in the format asked
 * for is left out. A window linked into two sessions is listed once for each,
 * and the first is kept.
 */
export function parsePanes(stdout: string): TmuxPane[] {
  const panes = new Map<string, TmuxPane>();
  for (const line of stdout.split("\n")) {
    const match = PANE_LINE.exec(line);
    if (!match) continue;
    const [, pid, id, windowIndex, paneIndex, sessionName] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const processId = Number(pid);
    if (!Number.isSafeInteger(processId) || processId <= 1) continue;
    if (!isPaneId(id) || panes.has(id)) continue;
    panes.set(id, { pid: processId, id, place: placeOf(sessionName, windowIndex, paneIndex) });
  }
  return [...panes.values()];
}

/**
 * The pane a process runs in: the pane whose own process is that process or the
 * nearest of its ancestors. Undefined when no ancestor is a pane's process.
 *
 * The walk stops at the first process of the system, at a process `ps` did not
 * list, and at one already passed, so a table that loops cannot hold it.
 */
export function paneOfProcess(
  pid: number,
  parents: ReadonlyMap<number, number>,
  panesByPid: ReadonlyMap<number, TmuxPane>,
): TmuxPane | undefined {
  const passed = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && current > 1 && !passed.has(current)) {
    const pane = panesByPid.get(current);
    if (pane) return pane;
    passed.add(current);
    current = parents.get(current);
  }
  return undefined;
}
