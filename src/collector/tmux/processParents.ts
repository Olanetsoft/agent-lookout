import { execFile } from "node:child_process";

/** Each process's parent, by pid. Empty when `ps` could not be asked. */
export type ReadProcessParents = () => Promise<Map<number, number>>;

/** How long `ps` gets. It normally answers in a few milliseconds. */
const PS_TIMEOUT_MS = 2_000;

/**
 * Every process's id and its parent's id, and nothing else about it: no name,
 * no command and no owner.
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

/**
 * Asks `ps` for every process's parent, in one run. `ps` is run directly, never
 * through a shell, found on a fixed `PATH`, and never on Windows.
 */
export const readProcessParentsWithPs: ReadProcessParents = () =>
  new Promise((resolve) => {
    if (process.platform === "win32") {
      resolve(new Map());
      return;
    }
    try {
      execFile(
        "ps",
        [...PS_PARENTS_ARGS],
        {
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          timeout: PS_TIMEOUT_MS,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout) => {
          resolve(error ? new Map() : parseProcessParents(String(stdout ?? "")));
        },
      );
    } catch {
      resolve(new Map());
    }
  });
