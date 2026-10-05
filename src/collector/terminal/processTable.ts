import { execFile } from "node:child_process";

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

/** How long `ps` gets. It normally answers in a few milliseconds. */
const PS_TIMEOUT_MS = 2_000;

/** Far more than a process table needs, and a ceiling on what is read. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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
 * Asks `ps` about every process, in one run. `ps` is run directly, never
 * through a shell, and found on a fixed `PATH`. It is run on macOS alone, the
 * one system with a Terminal or an iTerm2.
 */
export const readProcessTableWithPs: ReadProcessTable = () =>
  new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve(new Map());
      return;
    }
    try {
      execFile(
        "ps",
        [...PS_TABLE_ARGS],
        {
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          timeout: PS_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout) => {
          resolve(error ? new Map() : parseProcessTable(String(stdout ?? "")));
        },
      );
    } catch {
      resolve(new Map());
    }
  });
