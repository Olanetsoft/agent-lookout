import { runPs } from "./ps.ts";

/** Each process's parent, by pid. Empty when `ps` could not be asked. */
export type ReadProcessParents = () => Promise<Map<number, number>>;

/**
 * Every process's id and its parent's id, and nothing else about it: no name,
 * no terminal, no command and no owner. This is all the tmux pane finder needs,
 * so it is all it asks for.
 */
export const PS_PARENTS_ARGS = ["-A", "-o", "pid=,ppid="] as const;

/** Reads what `ps -A -o pid=,ppid=` printed. A line that is not two numbers is left out. */
export function parseProcessParents(stdout: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/** Asks `ps` for every process's parent, in one run, on every system but Windows. */
export const readProcessParentsWithPs: ReadProcessParents = async () => {
  const answer = await runPs(PS_PARENTS_ARGS);
  return answer.ok ? parseProcessParents(answer.stdout) : new Map();
};
