// The DeepSeek Harness adapter, cut off from this machine, for the tests that
// share it: the same file system held in memory that the Codex tests use, a
// stand-in for `ps` that prints the table a test gives it and writes down
// every run, the computer's start a test sets, and an adapter built from
// them. Nothing here touches a real file or runs a program.

import zlib from "node:zlib";

import {
  createDeepseekHarnessAdapter,
  zstdOf,
  type DeepseekHarnessAdapterOptions,
} from "@collector/adapters/deepseek-harness/index";
import type { PsAnswer } from "@collector/processes/ps";
import {
  HOME,
  logPath,
  NOW,
  PROJECT_FOLDER,
  SESSION_ID,
  SESSIONS_DIR,
  sessionFolder,
} from "@tests/fixtures/deepseek-harness/deepseekHarness";
import {
  handClock as codexHandClock,
  memoryFiles as codexMemoryFiles,
  type MemoryFiles,
} from "@tests/support/adapters/codexAdapter";

export type { MemoryFiles };

/** The file system held in memory, whose files are written at this fixture's `NOW` unless a test says otherwise. */
export const memoryFiles = (clock: () => number = () => NOW) => codexMemoryFiles(clock);

/** A clock a test moves by hand, starting at this fixture's `NOW`. */
export const handClock = (start: number = NOW) => codexHandClock(start);

/** Agent Lookout's own process, as the stand-in `ps` lists it. */
export const OWN_PID = 4242;

/** When the computer started: a day before the fixture's `NOW`, unless a test says otherwise. */
export const BOOT_AT = NOW - 24 * 60 * 60 * 1000;

/** The decoder of this Node.js, or null on one without Zstandard. */
export const ZSTD = zstdOf(zlib);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time as `ps -o lstart=` prints it in UTC: `Tue Nov 17 11:00:00 2026`. */
export function lstart(at: number): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
}

/** One line of `ps -A -o pid=,lstart=,comm=`. */
export const psLine = (pid: number, startedAt: number, program: string) =>
  `${String(pid).padStart(5, " ")} ${lstart(startedAt)} ${program}`;

/**
 * A stand-in for `ps`: what it prints, Agent Lookout's own line first unless
 * a test leaves it out, and each run's arguments and options.
 */
export function standInPs(initial: string[] = []) {
  let lines = initial;
  let ok = true;
  let withOwn = true;
  const runs: { args: readonly string[]; options: { utc?: boolean } | undefined }[] = [];
  return {
    runs,
    /** The programs it lists, as lines from `psLine`, beside Agent Lookout's own. */
    set(next: string[]) {
      lines = next;
      ok = true;
    },
    /** Every run fails, as when `ps` cannot be run. */
    fail() {
      ok = false;
    },
    /** Whether Agent Lookout's own line is in the table. */
    own(listed: boolean) {
      withOwn = listed;
    },
    async run(args: readonly string[], options?: { utc?: boolean }): Promise<PsAnswer> {
      runs.push({ args, options });
      if (!ok) return { ok: false, stdout: "" };
      const all = withOwn ? [psLine(OWN_PID, NOW - 60_000, "node"), ...lines] : lines;
      return { ok: true, stdout: `${all.join("\n")}\n` };
    },
  };
}

export type StandInPs = ReturnType<typeof standInPs>;

/** Each folder's next modified time: within the hour before `NOW`, and never the same twice. */
let folderTime = NOW - 60 * 60 * 1000;

/**
 * Writes a log in place of any other, as DeepSeek Harness publishes one, and
 * moves its folders' times, as making a session's folder and linking its log
 * in do on a disk.
 */
export function writeLog(
  files: MemoryFiles,
  content: string | Uint8Array,
  options: {
    id?: string;
    compressed?: boolean;
    version?: number;
    project?: string;
    mtimeMs?: number;
  } = {},
): string {
  const file = logPath(options.id ?? SESSION_ID, options);
  files.write(file, content, { mtimeMs: options.mtimeMs });
  const folder = sessionFolder(options.id ?? SESSION_ID, options.project ?? PROJECT_FOLDER);
  files.touch(folder, folderTime++);
  files.touch(folder.slice(0, folder.lastIndexOf("/")), folderTime++);
  files.touch(SESSIONS_DIR, folderTime++);
  return file;
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with
 * Node.js's own Zstandard, a `ps` that shows no program but Agent Lookout's
 * own unless the test says otherwise, and a computer that started a day ago.
 * With nothing in `env` it looks in `~/.dsh/sessions`.
 */
export function deepseekHarnessAdapterFor(
  files: MemoryFiles,
  options: DeepseekHarnessAdapterOptions & { ps?: StandInPs } = {},
) {
  const { ps: given, ...rest } = options;
  const now = rest.now ?? (() => NOW);
  const ps = given ?? standInPs();
  return createDeepseekHarnessAdapter({
    env: {},
    homeDir: HOME,
    now,
    io: files.io,
    platform: "darwin",
    zstd: ZSTD,
    nodeVersion: "v22.22.0",
    runPs: (args, runOptions) => ps.run(args, runOptions),
    uptimeMs: () => now() - BOOT_AT,
    ownPid: OWN_PID,
    ...rest,
  });
}
