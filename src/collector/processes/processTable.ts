import { runPs } from "./ps.ts";

/** What `ps` says of one process: its parent, its terminal and its program. */
export interface ProcessFacts {
  ppid: number;
  /** The terminal as `ps` names it, `ttys003`, or `??` for none. */
  tty: string;
  /**
   * The program, as the process names itself: for an app, the path of its
   * executable. A process can name itself anything, so this is a clue, not proof.
   */
  path: string;
}

/** Each process, by pid. Empty when `ps` could not be asked. */
export type ReadProcessTable = () => Promise<Map<number, ProcessFacts>>;

/**
 * Every process's id, its parent's id, its terminal and its program, and
 * nothing else about it: no arguments, no owner and no environment. The
 * program comes last because it is the one field that can hold spaces.
 */
export const PS_TABLE_ARGS = ["-A", "-o", "pid=,ppid=,tty=,comm="] as const;

const LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/;

/** Reads what `ps -A -o pid=,ppid=,tty=,comm=` printed. A line not in that shape is left out. */
export function parseProcessTable(stdout: string): Map<number, ProcessFacts> {
  const table = new Map<number, ProcessFacts>();
  for (const line of stdout.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, pid, ppid, tty, program] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    table.set(Number(pid), { ppid: Number(ppid), tty, path: program });
  }
  return table;
}

/**
 * Asks `ps` about every process, in one run. It is run on macOS alone, the one
 * system with a Terminal or an iTerm2.
 */
export const readProcessTableWithPs: ReadProcessTable = async () => {
  if (process.platform !== "darwin") return new Map();
  const answer = await runPs(PS_TABLE_ARGS);
  return answer.ok ? parseProcessTable(answer.stdout) : new Map();
};

/** Each process's parent, from the table, for a test that hands the collector a table of its own. */
export function parentsIn(table: ReadonlyMap<number, ProcessFacts>): Map<number, number> {
  const parents = new Map<number, number>();
  for (const [pid, facts] of table) parents.set(pid, facts.ppid);
  return parents;
}
