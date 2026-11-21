import {
  primeAgentLeaseProcess,
  type LeaseProcess,
} from "../../../core/mapping/prime-agent/primeAgentMapping.ts";
import {
  readProcFile,
  startTicksOf,
  statFileOf,
  type ReadProcFile,
} from "../../processes/linuxProcesses.ts";
import {
  compareProcessStart,
  createBootClock,
  START_CHECK_TTL_MS,
} from "../../processes/processStart.ts";
import type { PsAnswer } from "../../processes/ps.ts";
import { rememberingCheck, type RecordProcess } from "../qwen-code/processCheck.ts";
import type { Lease } from "./leases.ts";

/**
 * Telling whether the process each Prime Agent lease names still holds it.
 * Built from Prime Agent's source at v0.10.3 and not yet checked on a
 * computer running it.
 *
 * Prime Agent counts a lease's owner as gone when its pid is not running, or
 * when the lease records the process's start and the process with that pid
 * now started at another time (`owner_alive` in `crates/pa-daemon/src/lease.rs`).
 * It writes that start as `process_start_id` in `crates/pa-types/src/platform/process.rs`
 * makes it: on Linux `proc:` and field 22 of `/proc/<pid>/stat`; on macOS
 * `ps:` and the start as `ps -o lstart=` prints it in the C locale and UTC;
 * and on Windows `win:` and the process's creation time. So, for each lease:
 *
 * - signal 0 is sent to its pid on every poll, which tests a process and
 *   sends it nothing;
 * - on Linux, for a `proc:` start, field 22 of `/proc/<pid>/stat` is read and
 *   compared with it, and nothing else of the line is kept;
 * - on macOS, and on Linux for a lease whose start was not compared, `ps` is
 *   asked when the process started and the name of its program, in one run
 *   for every such lease, `ps -o pid=,lstart=,comm= -p <pids>`, in UTC. A
 *   `ps:` start is compared with what it prints. A lease whose start cannot
 *   be compared counts only while its process is `prime-agent`, and not at
 *   all when it was taken before the computer started;
 * - on Windows nothing is asked: a pid there cannot be told from another
 *   program's, so a lease whose process runs cannot be told.
 *
 * Each answer of `/proc` and `ps` is kept for 30 seconds, so a poll every 2
 * seconds does not mean a read every 2 seconds, and a new lease is asked about
 * at once (`rememberingCheck`). What the rules make of the answers is
 * `primeAgentLeaseProcess`.
 */

/** The fields asked of `ps`, and nothing else about any process. */
export const PS_FIELDS = "pid=,lstart=,comm=";

/** What asks `ps`, as `runPs` does. */
export type RunPsWith = (args: readonly string[], options?: { utc?: boolean }) => Promise<PsAnswer>;

/** The names of Prime Agent's program, as `ps -o comm=` prints them. */
export const PRIME_AGENT_PROGRAMS: ReadonlySet<string> = new Set(["prime-agent"]);

/** A line of `ps -o pid=,lstart=,comm=`: its pid, `lstart` (five words) and the program, which can hold spaces. */
const PS_LINE =
  /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/;

/** What `ps` said of one process: when it started and its program, as printed. */
interface PsRow {
  lstart: string;
  program: string;
}

/** Each process `ps -o pid=,lstart=,comm=` printed, by its pid. A line not of that shape is left out. */
export function parsePsRows(stdout: string): Map<number, PsRow> {
  const rows = new Map<number, PsRow>();
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match)
      rows.set(Number(match[1]), { lstart: match[2] as string, program: match[3] as string });
  }
  return rows;
}

/** Whether a program as `ps` names it, its name or a path ending in it, is Prime Agent's. */
function isPrimeAgent(program: string): boolean {
  return PRIME_AGENT_PROGRAMS.has(program.slice(program.lastIndexOf("/") + 1));
}

export interface HolderOptions {
  platform: NodeJS.Platform;
  /** Signal 0. */
  isAlive: (pid: number) => boolean;
  /** How long the computer has been on, in milliseconds. */
  uptimeMs: () => number;
  runPs: RunPsWith;
  readProcFile?: ReadProcFile;
  now: () => number;
}

/** What the checks said of the leases asked about. */
export interface HolderAnswer {
  /** Each lease's answer, by the lease. */
  processes: ReadonlyMap<Lease, LeaseProcess>;
  /** Whether `ps` could not be run for a lease that needed it. */
  psFailed: boolean;
}

export interface HolderCheck {
  /** What each of these leases' processes says, asked at `at`. Never rejects. */
  check(leases: readonly Lease[], at: number): Promise<HolderAnswer>;
}

/** The lease as `rememberingCheck` takes a record: its pid, when it was taken, and the start Prime Agent wrote. */
interface Checked extends RecordProcess {
  lease: Lease;
  startedAt: number;
}

const ANSWER: Record<LeaseProcess, "same" | "different" | "unknown"> = {
  runs: "same",
  gone: "different",
  unknown: "unknown",
};

const FROM_ANSWER: Record<"same" | "different" | "unknown", LeaseProcess> = {
  same: "runs",
  different: "gone",
  unknown: "unknown",
};

export function createHolderCheck(options: HolderOptions): HolderCheck {
  const { platform, isAlive, uptimeMs, runPs, now } = options;
  const readFile = options.readProcFile ?? readProcFile;
  const asksPs = platform === "darwin" || platform === "linux";
  const readsProc = platform === "linux";
  const bootClock = createBootClock(uptimeMs);
  let bootAt = 0;
  let psFailed = false;

  const procCheck = rememberingCheck(
    {
      async read(pids) {
        const ticks = new Map<number, string>();
        await Promise.all(
          pids.map(async (pid) => {
            try {
              const found = startTicksOf(await readFile(statFileOf(pid)));
              if (found !== null) ticks.set(pid, found);
            } catch {
              // The process has gone, or its `stat` cannot be read: nothing to compare.
            }
          }),
        );
        return ticks;
      },
      keyOf: (record) =>
        record.procStart?.startsWith("proc:") ? `${record.pid} ${record.procStart}` : null,
      compare: (record, ticks) =>
        ticks === undefined
          ? "unknown"
          : record.procStart === `proc:${ticks}`
            ? "same"
            : "different",
    },
    now,
    START_CHECK_TTL_MS,
  );

  const psCheck = rememberingCheck(
    {
      async read(pids) {
        const answer = await runPs(["-o", PS_FIELDS, "-p", pids.join(",")], { utc: true });
        // `ps` exits with an error when one of the pids has gone and still
        // prints the others, so its output is read whatever the exit code.
        psFailed = !answer.ok && answer.stdout.trim() === "";
        const rows = new Map<number, string>();
        for (const [pid, row] of parsePsRows(answer.stdout)) {
          rows.set(pid, `${row.lstart}\n${row.program}`);
        }
        return rows;
      },
      keyOf: (record) => `${record.pid} ${record.startedAt} ${record.procStart ?? "-"}`,
      compare: (record, value) => {
        const [lstart, program] = value === undefined ? [] : value.split("\n");
        const recorded = record.procStart?.startsWith("ps:")
          ? record.procStart.slice(3)
          : undefined;
        return ANSWER[
          primeAgentLeaseProcess({
            alive: true,
            start: compareProcessStart(recorded, lstart),
            beforeBoot: (record.startedAt ?? 0) < bootAt,
            program:
              program === undefined
                ? "not-listed"
                : isPrimeAgent(program)
                  ? "prime-agent"
                  : "other",
          })
        ];
      },
    },
    now,
    START_CHECK_TTL_MS,
  );

  return {
    async check(leases, at) {
      bootAt = bootClock(at);
      const processes = new Map<Lease, LeaseProcess>();
      const alive = leases.filter((lease) => isAlive(lease.pid));
      for (const lease of leases) if (!alive.includes(lease)) processes.set(lease, "gone");

      const records = alive.map((lease): Checked => ({
        lease,
        pid: lease.pid,
        startedAt: lease.createdAt,
        ...(lease.processStartId === undefined ? {} : { procStart: lease.processStartId }),
      }));
      const beforeBoot = (record: Checked) => record.startedAt < bootAt;

      // Linux: a `proc:` start is compared with `/proc` first.
      let rest = records;
      if (readsProc) {
        const procMatches = await procCheck.matches(
          records.filter((record) => record.procStart?.startsWith("proc:")),
        );
        rest = [];
        for (const record of records) {
          const start = procMatches.get(record) ?? "unknown";
          if (start === "unknown") rest.push(record);
          else
            processes.set(
              record.lease,
              primeAgentLeaseProcess({
                alive: true,
                start,
                beforeBoot: beforeBoot(record),
                program: null,
              }),
            );
        }
      }

      // A lease whose start `ps` cannot compare, taken before the boot, is
      // gone without asking `ps`.
      const toAsk: Checked[] = [];
      for (const record of rest) {
        const comparable = asksPs && record.procStart?.startsWith("ps:") === true;
        if (!comparable && beforeBoot(record)) processes.set(record.lease, "gone");
        else if (asksPs) toAsk.push(record);
        else {
          processes.set(
            record.lease,
            primeAgentLeaseProcess({
              alive: true,
              start: "unknown",
              beforeBoot: false,
              program: null,
            }),
          );
        }
      }

      const psMatches = await psCheck.matches(toAsk);
      for (const record of toAsk) {
        processes.set(record.lease, FROM_ANSWER[psMatches.get(record) ?? "unknown"]);
      }
      return {
        processes,
        psFailed: psFailed && toAsk.some((record) => processes.get(record.lease) === "unknown"),
      };
    },
  };
}
