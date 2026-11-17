import path from "node:path";

import {
  primeAgentHolder,
  primeAgentHolderStatus,
  primeAgentJournalStatus,
} from "../../../core/mapping/prime-agent/primeAgentMapping.ts";
import type { SourceFact } from "../../../core/sessions/session.ts";
import { tildify } from "../../files/paths.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import type { ReadProcFile } from "../../processes/linuxProcesses.ts";
import { START_CHECK_TTL_MS } from "../../processes/processStart.ts";
import type { PiStatusAnswer, PiStatusSource } from "../pi/index.ts";
import type { PiEvidence } from "../pi/toSession.ts";
import { every } from "../words.ts";
import { createFolderLister } from "./folders.ts";
import { createHolderCheck, PS_FIELDS, type RunPsWith } from "./holders.ts";
import { createJournalReader, JOURNAL_SUFFIX } from "./journals.ts";
import { createLeaseReader, type Lease } from "./leases.ts";

/**
 * A Prime Agent session's status, from its lease and the journal of the
 * worker the lease names, for the Pi adapter's shared body
 * (`../pi/index.ts`), which reads the session files themselves. Built from
 * Prime Agent's source at v0.10.3 and not yet checked on a computer running it.
 *
 * On each poll that lists a session:
 *
 * 1. `session-leases/` is read (`leases.ts`). Each lease names a session's
 *    file, the process that holds it and, for a daemon worker, the worker's
 *    ID, which is its journal's name.
 * 2. Each lease's process is checked (`holders.ts`).
 * 3. For a session whose lease a process that runs holds, on macOS and Linux,
 *    the worker's journal is found in `daemon-workers/`: in each folder there
 *    of 12 hex digits, one for each socket Prime Agent's daemon listens on,
 *    the file named for the worker's ID, which must be in exactly one. It is
 *    read for its steps (`journals.ts`). No worker's record, `<ID>.json`, is
 *    ever opened: it holds a token that, with the socket named beside it,
 *    controls the worker.
 *
 * `primeAgentMapping.ts` turns what was read into each session's status.
 */

/** The way this reads, named for the poller: the session files, their leases and their workers' journals. */
export const BASIS = "files";

/**
 * The way it reads while `session-leases/` is missing or cannot be listed, or
 * a lease in it cannot be read, when no session can be shown as finished.
 */
export const BASIS_WITHOUT_LEASES = "files-without-leases";

/**
 * The way it reads while `ps` cannot be run to tell a lease's process, when
 * a session whose lease names a process that runs is unknown.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/** Said on every poll on Windows. */
export const WINDOWS_NOTE =
  "On Windows Agent Lookout cannot tell a Prime Agent process from another that was given its process ID since, so a session whose lease is held shows as unknown.";

/** The name of the folder of one daemon's workers: the first 12 hex digits of the SHA-256 of its socket's path. */
export const WORKERS_FOLDER = /^[0-9a-f]{12}$/;

export interface PrimeAgentStatusOptions {
  agentDir: string;
  homeDir: string;
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  now: () => number;
  isAlive: (pid: number) => boolean;
  uptimeMs: () => number;
  runPs: RunPsWith;
  readProcFile?: ReadProcFile;
  sweepMs?: number;
}

/** What Sources says Prime Agent's status is read from, on this system. */
function factsFor(
  platform: NodeJS.Platform,
  leasesName: string,
  workersName: string,
): SourceFact[] {
  const leases = { label: "Leases folder", value: leasesName };
  const workers = { label: "Workers folder", value: workersName };
  const run = {
    label: "Process check run",
    value: `${every(START_CHECK_TTL_MS)} at most, and when a lease appears`,
  };
  const ps = `ps -o ${PS_FIELDS} -p <pids>`;
  if (platform === "darwin") {
    return [leases, workers, { label: "Process check", value: `signal 0, and ${ps}` }, run];
  }
  if (platform === "linux") {
    return [
      leases,
      workers,
      {
        label: "Process check",
        value: `signal 0, /proc/<pid>/stat, and ${ps} when that cannot be compared`,
      },
      run,
    ];
  }
  return [
    leases,
    { label: "Workers folder", value: "not read on this system" },
    { label: "Process check", value: "signal 0 alone; a held lease shows as unknown" },
  ];
}

export function createPrimeAgentStatus(options: PrimeAgentStatusOptions): PiStatusSource {
  const { agentDir, homeDir, io, platform, uptimeMs } = options;
  const readsJournals = platform === "darwin" || platform === "linux";
  const leasesDir = path.join(agentDir, "session-leases");
  const workersDir = path.join(agentDir, "daemon-workers");
  const leasesName = tildify(leasesDir, homeDir);
  const workersName = tildify(workersDir, homeDir);
  const leaseReader = createLeaseReader(agentDir, io, options.sweepMs);
  const workers = createFolderLister(workersDir, io, options.sweepMs);
  const journals = createJournalReader(io);
  const holders = createHolderCheck(options);

  const notes = {
    noLeases: `${leasesName} is missing or could not be listed, so each session shows as unknown.`,
    stray: `A lease in ${leasesName} could not be read, so a session no running prime-agent holds shows as unknown, not finished.`,
    psFailed:
      "ps could not be run to tell whether a lease's process is prime-agent, so a session it holds shows as unknown.",
  };

  /** A folder's or file's `lstat`, or null when it cannot be looked up. */
  async function lookUp(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  /**
   * The one journal named for a worker, in the folders of `daemon-workers/`,
   * or null when there is none, or more than one. A link at a folder's or
   * the journal's name is not followed.
   */
  async function journalOf(
    folders: readonly string[],
    worker: string,
  ): Promise<{ file: string; info: FileInfo } | null> {
    const found: { file: string; info: FileInfo }[] = [];
    for (const name of folders) {
      const folder = path.join(workersDir, name);
      if ((await lookUp(folder))?.kind !== "directory") continue;
      const file = path.join(folder, `${worker}${JOURNAL_SUFFIX}`);
      const info = await lookUp(file);
      if (info?.kind === "file") found.push({ file, info });
    }
    return found.length === 1 ? (found[0] ?? null) : null;
  }

  function detailOf(parts: readonly string[]): string {
    const all = platform === "win32" ? [...parts, WINDOWS_NOTE] : parts;
    return all.join(" ");
  }

  return {
    facts: factsFor(platform, leasesName, workersName),
    emptyBasis: BASIS,
    async read({ now, sessions }): Promise<PiStatusAnswer> {
      const byId = new Map<string, PiEvidence>();
      const unknown: PiEvidence = { status: "unknown", since: null };
      const leases = await leaseReader.read(now);
      if (leases.state !== "listed") {
        for (const { id } of sessions) byId.set(id, unknown);
        return { basis: BASIS_WITHOUT_LEASES, detail: detailOf([notes.noLeases]), byId };
      }

      const bootAt = now - uptimeMs();
      // A lease taken before the computer started cannot be any session's now.
      const stray = leases.stray.some(({ folderMtimeMs }) => folderMtimeMs >= bootAt);
      const own = (id: string) => leases.byId.get(id) ?? [];
      const asked: Lease[] = sessions.flatMap(({ id }) => own(id));
      const { processes, psFailed } = await holders.check(asked, now);

      let folders: readonly string[] | null = null;
      const read = new Set<string>();
      for (const { id } of sessions) {
        const held = own(id);
        const holder = primeAgentHolder({
          listed: true,
          leases: held.map((lease) => processes.get(lease) ?? "unknown"),
          stray,
        });
        const status = primeAgentHolderStatus(holder);
        if (status !== null) {
          byId.set(id, { status, since: null });
          continue;
        }
        const lease = held.find((one) => processes.get(one) === "runs");
        const worker = lease?.activeSessionId;
        if (!readsJournals || lease === undefined || worker === undefined) {
          byId.set(id, unknown);
          continue;
        }
        if (folders === null) {
          const listing = await workers.list(now);
          folders =
            listing.state === "listed"
              ? listing.names.filter((name) => WORKERS_FOLDER.test(name))
              : [];
        }
        const journal = await journalOf(folders, worker);
        const state =
          journal === null ? null : await journals.read(journal.file, journal.info, worker);
        if (journal !== null) read.add(journal.file);
        byId.set(
          id,
          state === null
            ? unknown
            : primeAgentJournalStatus({
                sessionId: id,
                createdAt: lease.createdAt,
                trail: state.trail,
                queue: state.queue,
              }),
        );
      }
      journals.keepOnly(read);

      const parts: string[] = [];
      let basis = BASIS;
      if (stray) {
        parts.push(notes.stray);
        basis = BASIS_WITHOUT_LEASES;
      } else if (psFailed) {
        parts.push(notes.psFailed);
        basis = BASIS_WITHOUT_PROCESSES;
      }
      return { basis, detail: detailOf(parts), byId };
    },
  };
}
