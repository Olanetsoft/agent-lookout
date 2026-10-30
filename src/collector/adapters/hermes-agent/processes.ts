import { readlink } from "node:fs/promises";

import { isProcessAlive, validPid } from "../../processes/pids.ts";

/**
 * Whether the process holding a Hermes Agent turn lease still exists, so a
 * turn whose process was killed stops showing as working at once, rather
 * than for up to the 300 seconds its lease has left.
 *
 * A lease's holder is `pid=<n>[:pidns=<id>]:turn=<id>:platform=<p>`
 * (`agent/turn_facade_lease.py`), cut to its pid and pid namespace inside
 * SQLite (`sessionRows.ts`). The pid is checked with signal 0, which asks the
 * system whether the process exists and sends it nothing
 * (`../../processes/pids.ts`), by Hermes Agent's own strict rule for leases
 * (`holder_pid_checkable` in `hermes_state_pidns.py`):
 *
 * - where there are no pid namespaces, as on macOS, the pid is checked;
 * - on Linux, only when the holder names the pid namespace Agent Lookout runs
 *   in, read once from `/proc/self/ns/pid`. A holder in another namespace,
 *   such as a container sharing the folder, or one that names none, is not
 *   checked, and its lease's expiry is trusted. So is every holder while
 *   Agent Lookout's own namespace could not be read.
 *
 * Built from Hermes Agent's source at v0.22.5, and not yet checked on a
 * computer running Hermes Agent.
 */

/** Where Linux names the pid namespace a process runs in, as a link: `pid:[4026531836]`. */
export const OWN_PID_NAMESPACE_LINK = "/proc/self/ns/pid";

/**
 * Agent Lookout's own pid namespace: none where the system has none, or on
 * Linux its number, or null when it could not be read.
 */
export type PidNamespace = { supported: false } | { supported: true; id: number | null };

/** The number in what `/proc/self/ns/pid` links to, `pid:[4026531836]`, or null. */
export function parsePidNamespace(link: string): number | null {
  const match = /\[(\d{1,15})\]/.exec(link);
  return match === null ? null : Number(match[1]);
}

/** Reads the link `/proc/self/ns/pid`. Tests pass their own. */
export type ReadLink = (target: string) => Promise<string>;

export interface PidNamespaceReader {
  /** Agent Lookout's own pid namespace. Never throws. */
  read(): Promise<PidNamespace>;
}

/**
 * Reads Agent Lookout's own pid namespace on Linux, and nothing elsewhere.
 * A number read is kept, since a process never moves to another namespace.
 * A read that failed is not, and is tried again next time.
 */
export function createPidNamespaceReader(
  options: { platform?: NodeJS.Platform; readLink?: ReadLink } = {},
): PidNamespaceReader {
  const platform = options.platform ?? process.platform;
  const read = options.readLink ?? ((target: string) => readlink(target));
  let known: PidNamespace | null = platform === "linux" ? null : { supported: false };
  return {
    async read() {
      if (known !== null) return known;
      let id: number | null;
      try {
        id = parsePidNamespace(await read(OWN_PID_NAMESPACE_LINK));
      } catch {
        id = null;
      }
      if (id === null) return { supported: true, id: null };
      known = { supported: true, id };
      return known;
    },
  };
}

/**
 * Whether a lease's process exists: true or false when its pid may be
 * checked here, and null when it may not, so the lease's expiry is trusted.
 */
export function leaseHolderAlive(
  holder: { pid: number | null; pidns: number | null },
  namespace: PidNamespace,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean | null {
  const pid = validPid(holder.pid);
  if (pid === undefined) return null;
  if (namespace.supported) {
    if (holder.pidns === null || namespace.id === null) return null;
    if (holder.pidns !== namespace.id) return null;
  }
  try {
    return isAlive(pid);
  } catch {
    return null;
  }
}
