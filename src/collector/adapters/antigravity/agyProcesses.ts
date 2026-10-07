import type { AgySessionProcess } from "../../../core/mapping/antigravityLiveness.ts";
import { processStartTime } from "../../processes/processStart.ts";
import { runPs, type PsAnswer } from "../../processes/ps.ts";

/**
 * Which agy programs run, from `ps`, for which Antigravity CLI conversations
 * may be open.
 *
 * Two runs, both direct, never through a shell, from `/usr/bin` or `/bin`, in
 * the C locale:
 *
 * 1. `ps -A -o pid=,ppid=,lstart=,comm=`, in UTC: every process's id, its
 *    parent's, when it started and its program, and nothing else, to find the
 *    programs named `agy`.
 * 2. Only when an agy program is found that was not seen before,
 *    `ps -o pid=,args= -p <their ids>`: the command lines of those programs
 *    alone, to leave out agy's own commands, such as `agy remote-control`,
 *    which are not sessions, and to find a conversation named with
 *    `--conversation <id>`. A command line can hold a prompt, given with `-p`:
 *    each is read for those two things and dropped at once. Only whether the
 *    program is a session and the conversation's id are kept, for as long as
 *    the program runs.
 *
 * It is never run on Windows, which has no `ps`.
 */

/** The table of every process: its id, its parent's, when it started and its program. */
export const AGY_TABLE_ARGS = ["-A", "-o", "pid=,ppid=,lstart=,comm="] as const;

/** The command lines of these processes, and nothing else about them. */
export function agyCommandLineArgs(pids: readonly number[]): string[] {
  return ["-o", "pid=,args=", "-p", pids.join(",")];
}

/**
 * agy's own commands, as `agy --help` lists them in 1.3.1. A program started
 * as one of these, such as the background daemon `agy remote-control` starts,
 * is not a session.
 */
export const AGY_COMMANDS: ReadonlySet<string> = new Set([
  "agent",
  "agents",
  "changelog",
  "help",
  "install",
  "mcp",
  "mic-serve",
  "models",
  "plugin",
  "plugins",
  "remote-control",
  "update",
]);

/** Options that print something and end, which are not sessions either. */
const NOT_A_SESSION_OPTIONS: ReadonlySet<string> = new Set([
  "-h",
  "-help",
  "--help",
  "-version",
  "--version",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A line of the table: pid, parent, `lstart` (five words) and the program, which can hold spaces. */
const TABLE_LINE =
  /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/;

/** One agy program in the table. */
export interface AgyRow {
  pid: number;
  ppid: number;
  /** `lstart` as `ps` printed it, which with the pid tells this program from a later one with the same pid. */
  start: string;
  /** When it started, to the second. Null when `lstart` could not be read. */
  startedAt: number | null;
}

/** Whether a program, as `ps` names it, is agy: `agy`, or a path whose last part is `agy`. */
export function isAgyProgram(program: string): boolean {
  const name = program.split(/[\\/]/).pop()?.toLowerCase();
  return name === "agy" || name === "agy.exe";
}

/** The agy programs in what the table printed. Every other process is dropped as it is read. */
export function parseAgyTable(stdout: string): AgyRow[] {
  const rows: AgyRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = TABLE_LINE.exec(line);
    if (!match || !isAgyProgram(match[4] as string)) continue;
    const start = (match[3] as string).replace(/\s+/g, " ");
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      start,
      startedAt: processStartTime(start),
    });
  }
  return rows;
}

/** What is kept of an agy program's command line. */
export interface AgyCommandLine {
  /** False for one of agy's own commands, or an option that prints something and ends. */
  session: boolean;
  /** The conversation named with `--conversation <id>`, in lower case. */
  conversation?: string;
}

/** Where the program's own name ends in a command line: `agy`, or a path ending in it. */
const PROGRAM_IN_LINE = /(?:^|[\\/])agy(?:\.exe)?(?=\s|$)/i;

/**
 * Reads an agy command line, as `ps -o args=` prints it, for the two things
 * kept. `ps` joins the arguments with spaces, so one that holds spaces cannot
 * be told apart: a line is a session unless its first word after the program
 * is one of agy's commands, which a prompt given with `-p` never is, since `-p`
 * comes first. A line that does not show the program is taken as a session
 * that names no conversation.
 */
export function readAgyCommandLine(line: string): AgyCommandLine {
  const program = PROGRAM_IN_LINE.exec(line);
  if (!program) return { session: true };
  const words = line
    .slice(program.index + program[0].length)
    .split(/\s+/)
    .filter((word) => word !== "");
  const first = words[0];
  if (first !== undefined && (AGY_COMMANDS.has(first) || NOT_A_SESSION_OPTIONS.has(first))) {
    return { session: false };
  }
  for (const [index, word] of words.entries()) {
    let value: string | undefined;
    if (word === "--conversation" || word === "-conversation") value = words[index + 1];
    else if (word.startsWith("--conversation=")) value = word.slice("--conversation=".length);
    else if (word.startsWith("-conversation=")) value = word.slice("-conversation=".length);
    else continue;
    if (value !== undefined && UUID.test(value)) {
      return { session: true, conversation: value.toLowerCase() };
    }
  }
  return { session: true };
}

/** Each pid's command line, from what `ps -o pid=,args=` printed. */
export function parseCommandLines(stdout: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) lines.set(Number(match[1]), match[2] as string);
  }
  return lines;
}

/** The agy programs that run sessions, or `ok: false` when `ps` could not say. */
export type AgyProcessList = { ok: true; sessions: AgySessionProcess[] } | { ok: false };

/** Runs `ps` with these arguments. Tests pass their own. */
export type RunPs = (args: readonly string[], options?: { utc?: boolean }) => Promise<PsAnswer>;

export interface AgyProcessReader {
  /** Runs `ps` now. Never throws. */
  read(): Promise<AgyProcessList>;
}

export function createAgyProcessReader(
  options: { run?: RunPs; platform?: NodeJS.Platform } = {},
): AgyProcessReader {
  const run = options.run ?? runPs;
  const platform = options.platform ?? process.platform;
  /** What each program's command line said, by pid and start, for as long as it runs. */
  const known = new Map<string, AgyCommandLine>();

  async function read(): Promise<AgyProcessList> {
    if (platform === "win32") return { ok: false };
    const table = await run(AGY_TABLE_ARGS, { utc: true });
    if (!table.ok) return { ok: false };
    const all = parseAgyTable(table.stdout);
    // A program agy itself started, under another agy, belongs to that one's session.
    const agyPids = new Set(all.map((row) => row.pid));
    const rows = all.filter((row) => !agyPids.has(row.ppid));

    const keyOf = (row: AgyRow) => `${row.pid} ${row.start}`;
    const current = new Set(rows.map(keyOf));
    for (const key of known.keys()) {
      if (!current.has(key)) known.delete(key);
    }
    const unseen = rows.filter((row) => !known.has(keyOf(row)));
    /** Programs that ended between the two runs. */
    const ended = new Set<number>();
    if (unseen.length > 0) {
      // `ps` says it failed when one of the programs has ended, and still prints the others.
      const answer = await run(agyCommandLineArgs(unseen.map((row) => row.pid)));
      const lines = parseCommandLines(answer.stdout);
      for (const row of unseen) {
        const line = lines.get(row.pid);
        if (line !== undefined) known.set(keyOf(row), readAgyCommandLine(line));
        else if (answer.ok || lines.size > 0) ended.add(row.pid);
      }
    }

    const sessions: AgySessionProcess[] = [];
    for (const row of rows) {
      if (ended.has(row.pid)) continue;
      // A program whose command line could not be read is taken as a session that names nothing.
      const line = known.get(keyOf(row)) ?? { session: true };
      if (!line.session) continue;
      sessions.push(
        line.conversation === undefined
          ? { startedAt: row.startedAt }
          : { startedAt: row.startedAt, conversation: line.conversation },
      );
    }
    return { ok: true, sessions };
  }

  return {
    async read() {
      try {
        return await read();
      } catch {
        return { ok: false };
      }
    },
  };
}
