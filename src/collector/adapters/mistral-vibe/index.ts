import os from "node:os";
import path from "node:path";

import {
  isMistralVibeUserSession,
  vibeLeaseHeld,
} from "../../../core/mapping/mistral-vibe/mistralVibeMapping.ts";
import { FINISHED_RETENTION_MS, isWithinRetention } from "../../../core/sessions/retention.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { plausibleTime } from "../../../core/time.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import type { Envelope } from "./envelope.ts";
import { createJournalReader, type Newest } from "./journal.ts";
import { createLeaseReader, LEASE_DIR } from "./leases.ts";
import {
  createStoreReader,
  legacyWrittenSince,
  scanStores,
  STORE_DIR,
  storeWrittenAt,
} from "./stores.ts";
import { mistralVibeSession, SOURCE_ID } from "./toSession.ts";

/** The variable that names Vibe's session folder, for Agent Lookout alone. */
export const VIBE_SESSION_DIR_ENV = "AGENT_LOOKOUT_VIBE_SESSION_DIR";

/** Vibe's own variable for its folder, documented by Vibe. Vibe and this adapter then read the same place. */
export const VIBE_OWN_HOME_ENV = "VIBE_HOME";

/** Where Vibe keeps its files, under the home folder, when `VIBE_HOME` is not set. */
export const DEFAULT_VIBE_HOME = [".vibe"] as const;

/** Where Vibe saves its sessions in its folder, unless its own settings move them. */
export const SESSION_DIR_IN_HOME = ["logs", "session"] as const;

/** A path as Vibe reads one from `VIBE_HOME`: a `~` at its start is the home folder. */
function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir, value.slice(2));
  return value;
}

/**
 * The session folder this adapter reads: the one
 * `AGENT_LOOKOUT_VIBE_SESSION_DIR` names, otherwise `logs/session` in Vibe's
 * own `VIBE_HOME`, otherwise `~/.vibe/logs/session`. A folder Vibe's
 * `config.toml` names in `[session_logging] save_dir` is not followed: the
 * setting is how to name it.
 */
export function vibeSessionDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const own = env[VIBE_SESSION_DIR_ENV]?.trim() || undefined;
  if (own !== undefined) return path.resolve(own);
  const vibeHome = env[VIBE_OWN_HOME_ENV]?.trim() || undefined;
  const home =
    vibeHome !== undefined
      ? expandHome(vibeHome, homeDir)
      : path.join(homeDir, ...DEFAULT_VIBE_HOME);
  return path.resolve(home, ...SESSION_DIR_IN_HOME);
}

/** How long a session folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/**
 * The least time between two looks through every store for sessions no Vibe
 * program holds, while `unified/` keeps changing. Vibe rewrites its own index
 * of sessions there each time one of its programs lists them, so the folder's
 * time moves far more often than sessions are made. A session a program
 * holds is found through its lease, on every poll.
 */
export const SCAN_MIN_MS = 30_000;

/** The most time between two looks through every store, even when nothing seems to have changed. */
export const SCAN_MAX_MS = 5 * 60_000;

/**
 * How long a lease must have been held before it lists a session Vibe last
 * wrote to more than a day ago, or opens a session Vibe has not written to
 * since it took the lease. To clear old process output, Vibe takes the lease
 * of every stored session that ran a process, however old, and holds them all
 * until it is done (harness/.../vibe/_host.py, `_cleanup_process_output_once`).
 * Those sessions are not listed, or shown as open, for that.
 */
export const OLD_SESSION_LEASE_MS = 30_000;

/** The usual way this adapter reads, named for the poller. */
export const BASIS = "files";

/**
 * The way it reads while the folder of leases is missing or cannot be listed.
 * Then no session can be shown as finished, so a session that had finished
 * shows as idle. Named apart, so that one poll without the leases is not
 * compared with one that had them.
 */
export const BASIS_WITHOUT_LEASES = "files-without-leases";

const LABEL = "Mistral Vibe";

/** Said whenever Vibe is watched, until Needs you is read. */
export const NEEDS_YOU_NOTE =
  "This version does not read when Mistral Vibe waits for your approval, so a waiting session shows as working.";

/** Said whenever Vibe is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from the source of Mistral Vibe 2.26.1 and not yet checked on a computer running Vibe, so a status can be wrong.";

/** Said when a store was written by a newer Vibe than this adapter knows. */
export const NEWER_STORE_NOTE =
  "Some Mistral Vibe sessions were written by a newer Vibe than Agent Lookout knows, so their status is not shown.";

/** Said when the older engine saved a session in the last day. */
export const LEGACY_NOTE =
  "Sessions Vibe ran on its older engine, the default before 2.26.0, are not shown.";

/** Said while the folder of leases cannot be listed. */
export const WITHOUT_LEASES_NOTE =
  "Vibe's folder of open sessions could not be listed, so no Mistral Vibe session is shown as finished.";

/**
 * What a Mistral Vibe session can show, from the files this adapter reads.
 * See docs/adapters/mistral-vibe.md for each.
 *
 * - Working and idle are the status of the newest public state, from the
 *   journal or the generation (`mistralVibeMapping.ts`).
 * - Needs you not yet: the requests Vibe journals while it waits are not read
 *   by this version, so a waiting session shows as working.
 * - Finished is a session no Vibe program holds the lease of, or whose lease
 *   was taken less than 30 seconds ago with nothing written to it since. The
 *   desktop app lets go of a session's lease after each turn, so its sessions
 *   finish then.
 * - Failed is a turn that ended on an error Vibe recorded. A Vibe that stops
 *   mid-turn without closing records none, and its lease is left behind for a
 *   program that no longer runs, so the session shows as finished.
 * - The name is the title Vibe or the person gives a session, else its
 *   folder's. With Vibe's titles turned off, it has none.
 * - No Jump: the files name no terminal or window, and Vibe documents no link.
 * - Quiet for is the journal segment's own modified time, moved by every
 *   record Vibe adds.
 * - Tokens not yet: this version does not read them.
 * - No Stop: the process that holds a session's lease can hold others' too.
 * - No Answer: Vibe takes answers only in its own terminal, editor or app.
 */
export const MISTRAL_VIBE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": {
    level: "no",
    reason:
      "This version does not read Vibe's approval waits, so a session waiting for you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once no Vibe program holds it, or one took it in the last 30 seconds and wrote nothing. The desktop app lets go after each turn.",
  },
  failed: {
    level: "partly",
    reason:
      "When a turn ends on an error Vibe records. A Vibe that stops mid-turn without closing shows as finished.",
  },
  names: {
    level: "partly",
    reason:
      "The title Vibe or you give a session. Until it has one, or with Vibe's titles turned off, its folder's name.",
  },
  jump: {
    level: "no",
    reason:
      "Vibe's files name no terminal or window, and Vibe documents no link that opens a session.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "no", reason: "This version does not read Vibe's token counts." },
  stop: {
    level: "no",
    reason:
      "The process holding a Vibe session can hold others too, so none can be confirmed and stopped alone.",
  },
  answer: {
    level: "no",
    reason: "Vibe takes its answers only in its own terminal, editor or app.",
  },
};

/** Everything the adapter touches outside itself. Tests replace these. */
export interface MistralVibeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** Whether a process runs, for the pid a lease names. Defaults to asking the system. */
  isAlive?: (pid: number) => boolean;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing session folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** The least time between two looks through every store. Defaults to 30 seconds. */
  scanMinMs?: number;
  /** The most time between two looks through every store. Defaults to 5 minutes. */
  scanMaxMs?: number;
}

/** Where the session folder was named. */
type DirFrom = "agent-lookout" | "vibe" | "default";

/** A folder's identity and time, to see whether it changed. */
type Mark = { ino: number; mtimeMs: number } | null;

const sameMark = (a: Mark, b: Mark) =>
  a === b || (a !== null && b !== null && a.ino === b.ino && a.mtimeMs === b.mtimeMs);

/**
 * Finds Mistral Vibe sessions on this machine from the files Vibe keeps, with
 * nothing installed, no setting changed and no program run.
 *
 * Vibe documents no listing of its sessions for another program to read: its
 * own `--resume` is a picker for a person. So the adapter reads Vibe's files,
 * which Vibe does not document either, read-only, as Vibe 2.26.1's source
 * writes them:
 *
 * - The folder of leases, `<session folder>/active`, listed on every poll, and
 *   each held lease's `<id>.lock.json` when it changes, for which sessions a
 *   Vibe program holds (`leases.ts`).
 * - Each session's store, `<session folder>/unified/<id>`: its `CURRENT`, and
 *   the manifest, public state and runtime state of the generation it names,
 *   once each while it follows the session (`stores.ts`).
 * - The journal segment that generation names, read from its end and then as
 *   it grows, for the newest public state (`journal.ts`).
 *
 * A session is listed for 24 hours after Vibe last wrote to its `CURRENT` or
 * its journal, and while a Vibe program holds it. One older than that is
 * listed only once its lease is 30 seconds old (`OLD_SESSION_LEASE_MS`), and
 * nothing of its store is opened before. A lease younger than that, with
 * nothing written to the session since, does not show it as open. A lease
 * whose `.lock.json` gives no time yet counts from the poll that first found
 * it so. The stores
 * of sessions no program holds are looked through on the first poll, and then
 * at most every 30 seconds, when `unified/` or the session folder changed, and
 * at least every 5 minutes.
 * Subagents, sessions being deleted and sessions not yet saved are left out.
 * Forks are listed. Sessions the older engine saved are not, and the card
 * says so when it saved one in the last day.
 *
 * Vibe not being installed costs nothing: when the session folder is
 * missing, the adapter says so and looks again only once a minute, with a
 * single `stat`.
 *
 * The folder is the one `AGENT_LOOKOUT_VIBE_SESSION_DIR` names, then
 * `logs/session` in Vibe's own `VIBE_HOME`, then `~/.vibe/logs/session`
 * (`vibeSessionDirFor`). Someone who sets `AGENT_LOOKOUT_VIBE_SESSION_DIR`
 * means that folder: if it holds no sessions, that is an answer, not a
 * missing Vibe.
 */
export function createMistralVibeAdapter(options: MistralVibeAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const scanMinMs = options.scanMinMs ?? SCAN_MIN_MS;
  const scanMaxMs = options.scanMaxMs ?? SCAN_MAX_MS;

  const dirFrom: DirFrom = env[VIBE_SESSION_DIR_ENV]?.trim()
    ? "agent-lookout"
    : env[VIBE_OWN_HOME_ENV]?.trim()
      ? "vibe"
      : "default";
  const sessionDir = vibeSessionDirFor(env, homeDir);
  const storesDir = path.join(sessionDir, STORE_DIR);
  const leaseDir = path.join(sessionDir, LEASE_DIR);

  const dirName = tildify(sessionDir, homeDir);
  const storesName = tildify(storesDir, homeDir);
  const leasesName = tildify(leaseDir, homeDir);

  const leases = createLeaseReader(leaseDir, io);
  const stores = createStoreReader(storesDir, io);
  const journals = createJournalReader(io);

  /** When the session folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** The sessions followed from one poll to the next: those written in the last day, or a program has held a while. */
  let tracked = new Set<string>();
  /** The newest state last read from each session's journal, kept for a poll that cannot read it. */
  const lastNewest = new Map<string, Newest>();
  /** When the stores were last looked through, and how `unified/` and the session folder were then. */
  let scannedAt: number | null = null;
  let scannedMarks: [Mark, Mark] = [null, null];
  /** When the older engine last saved a session, as of the last look. */
  let legacyAt: number | null = null;
  /**
   * For each lock whose `.lock.json` gives no time, as while Vibe is still
   * writing it, the poll that first found it so. That counts as when the lease
   * was taken.
   */
  const untimedSince = new Map<string, number>();

  function watching(read: string): SourceFact[] {
    return [
      { label: "Sessions folder", value: storesName },
      { label: "Read", value: read },
      { label: "Open-sessions folder", value: leasesName },
    ];
  }

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: watching(read),
      checkedAt,
    };
    return state === "ok" ? { health, sessions: [], basis: BASIS } : { health, sessions: [] };
  }

  /** Vibe is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const where =
      dirFrom === "vibe"
        ? `${VIBE_OWN_HOME_ENV} is set, and there is no ${dirName} folder`
        : `there is no ${dirName} folder`;
    return result(
      "unavailable",
      `Mistral Vibe was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** The always-said notes, and those whose condition holds, after the first sentence. */
  function notes(extra: readonly string[]): string {
    return [NEEDS_YOU_NOTE, UNCHECKED_NOTE, ...extra].join(" ");
  }

  /** A folder's mark, or null when it is not a folder there. Throws when it cannot be looked at. */
  async function markOf(target: string, follow: boolean): Promise<Mark> {
    try {
      const info = follow ? await io.stat(target) : await io.lstat(target);
      return info.kind === "directory" ? { ino: info.ino, mtimeMs: info.mtimeMs } : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Whether it is time to look through every store again. A clock set back counts as time enough. */
  function scanDue(checkedAt: number, marks: [Mark, Mark]): boolean {
    if (scannedAt === null) return true;
    const since = checkedAt - scannedAt;
    if (since < 0 || since >= scanMaxMs) return true;
    const changed = !sameMark(marks[0], scannedMarks[0]) || !sameMark(marks[1], scannedMarks[1]);
    return changed && since >= scanMinMs;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Vibe is believed missing for a while, so a machine without it
    // pays nothing on most polls.
    if (dirFrom !== "agent-lookout" && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }
    let dirMark: Mark;
    try {
      dirMark = await markOf(sessionDir, true);
    } catch {
      return result(
        "error",
        `Mistral Vibe sessions could not be read: the folder ${dirName} could not be looked at.`,
        "cannot be read",
        checkedAt,
      );
    }
    if (dirMark === null) {
      tracked = new Set();
      lastNewest.clear();
      scannedAt = null;
      legacyAt = null;
      if (dirFrom === "agent-lookout") {
        return result(
          "ok",
          `${VIBE_SESSION_DIR_ENV} is set to ${dirName}, which is not there, so no Mistral Vibe sessions are listed. ${notes([])}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    let storesMark: Mark;
    try {
      storesMark = await markOf(storesDir, false);
    } catch {
      return result(
        "error",
        `Mistral Vibe sessions could not be read: the folder ${storesName} could not be looked at.`,
        "cannot be read",
        checkedAt,
      );
    }

    const found = await leases.read();
    if (found.supported) {
      for (const [id, lease] of found.held) {
        if (lease.acquiredAt !== null) untimedSince.delete(id);
        else if (!untimedSince.has(id)) untimedSince.set(id, checkedAt);
      }
      for (const id of untimedSince.keys()) {
        if (!found.held.has(id)) untimedSince.delete(id);
      }
    } else {
      untimedSince.clear();
    }
    const extra: string[] = [];

    if (scanDue(checkedAt, [dirMark, storesMark])) {
      const scan = storesMark === null ? null : await scanStores(storesDir, io);
      if (scan?.state === "unreadable") {
        return result(
          "error",
          `Mistral Vibe sessions could not be read: the folder ${storesName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      if (scan?.state === "ok") {
        for (const [id, writtenAt] of scan.written) {
          if (isWithinRetention(writtenAt, checkedAt)) tracked.add(id);
        }
      }
      legacyAt = await legacyWrittenSince(sessionDir, io, checkedAt - FINISHED_RETENTION_MS);
      scannedAt = checkedAt;
      scannedMarks = [dirMark, storesMark];
    }
    const legacySeen = legacyAt !== null && isWithinRetention(legacyAt, checkedAt);

    if (storesMark === null) {
      tracked = new Set();
      lastNewest.clear();
      if (legacySeen) extra.push(LEGACY_NOTE);
      if (!found.supported) extra.push(WITHOUT_LEASES_NOTE);
      const answer = result(
        "ok",
        `Mistral Vibe has not saved any sessions in ${storesName} yet. ${notes(extra)}`,
        every(pollIntervalMs),
        checkedAt,
      );
      return { ...answer, basis: found.supported ? BASIS : BASIS_WITHOUT_LEASES };
    }

    const candidates = new Set(tracked);
    if (found.supported) for (const id of found.held.keys()) candidates.add(id);

    const kept = new Set<string>();
    const journalFiles = new Set<string>();
    const sessions: Session[] = [];
    let tooNewSeen = false;

    for (const id of [...candidates].sort()) {
      const lease = found.supported ? found.held.get(id) : undefined;
      const held = vibeLeaseHeld({
        leaseFolder: found.supported,
        locked: lease !== undefined,
        alive: lease === undefined || lease.pid === null ? null : isAlive(lease.pid),
      });
      /** When a program that runs took the lease, when the lease says. */
      const acquiredAt = held === true ? (lease?.acquiredAt ?? null) : null;
      const heldFor = acquiredAt === null ? null : checkedAt - acquiredAt;
      const heldAWhile = heldFor !== null && heldFor >= OLD_SESSION_LEASE_MS;
      /** When it was taken, or, when the lease gives no time, when a poll first found it so. */
      const takenAt = held === true ? (acquiredAt ?? untimedSince.get(id) ?? null) : null;

      // A session only a lease names, which the look through the stores did not
      // find written in the last day, is opened only once a program that runs
      // has held it a while. A lease left behind, or one Vibe takes for a
      // moment to clear old output, opens nothing.
      if (!tracked.has(id) && !heldAWhile) {
        if (held !== true) continue;
        const writtenAt = await storeWrittenAt(storesDir, id, io);
        if (writtenAt !== null && !isWithinRetention(writtenAt, checkedAt)) continue;
      }

      const read = await stores.read(id);
      // A lease with no store yet is a session Vibe has not saved, and drops
      // it if it closes unused. It is followed while its lease is held.
      if (read.state !== "ok") {
        if (held === true && read.state !== "invalid") kept.add(id);
        continue;
      }
      const { store, current } = read;

      let journalInfo: FileInfo | null = null;
      let newest: Newest = { kind: "beyond" };
      if (store.journal !== null) {
        const file = path.join(storesDir, id, ...store.journal.split("/"));
        try {
          journalInfo = await io.lstat(file);
          if (journalInfo.kind !== "file") throw new Error("Not an ordinary file.");
          newest = await journals.read(file, journalInfo);
          journalFiles.add(file);
          lastNewest.set(id, newest);
        } catch {
          // Unreadable this time. What was read of it before stands.
          if (journalInfo?.kind !== "file") journalInfo = null;
          newest = lastNewest.get(id) ?? { kind: "beyond" };
          journalFiles.add(file);
        }
      }

      // Every record Vibe adds moves the segment's time, and every save moves `CURRENT`'s.
      const lastWrite = Math.max(current.mtimeMs, journalInfo?.mtimeMs ?? -Infinity);
      const lastActivity = plausibleTime(Math.floor(lastWrite), checkedAt);
      const recent = lastActivity !== null && isWithinRetention(lastActivity, checkedAt);
      if (!recent && !heldAWhile) continue;
      kept.add(id);
      if (!isMistralVibeUserSession(id, store.kind) || store.deleting) continue;

      // Vibe takes the lease of a closed session for a moment, as it does for
      // every session with old process output while it clears that output. So
      // a lease taken less than 30 seconds ago opens the session only once Vibe
      // writes to it, as a program that uses the session does at once.
      const justTaken =
        takenAt !== null &&
        checkedAt >= takenAt &&
        checkedAt - takenAt < OLD_SESSION_LEASE_MS &&
        Math.floor(lastWrite) < takenAt;

      const envelope: Envelope | null =
        newest.kind === "state" ? newest.envelope : newest.kind === "none" ? store.snapshot : null;
      const title =
        newest.kind === "state" ? newest.envelope.title : (store.snapshot?.title ?? null);
      if (store.tooNew) tooNewSeen = true;
      sessions.push(
        mistralVibeSession({
          sessionId: id,
          envelope,
          title,
          cwd: store.cwd,
          held: justTaken ? false : held,
          tooNew: store.tooNew,
          writtenAt: journalInfo?.mtimeMs,
          now: checkedAt,
        }),
      );
    }
    tracked = kept;
    stores.keepOnly(kept);
    journals.keepOnly(journalFiles);
    for (const id of lastNewest.keys()) {
      if (!kept.has(id)) lastNewest.delete(id);
    }

    if (tooNewSeen) extra.push(NEWER_STORE_NOTE);
    if (legacySeen) extra.push(LEGACY_NOTE);
    if (!found.supported) extra.push(WITHOUT_LEASES_NOTE);
    const detail = `Sessions are read from the files Mistral Vibe saves in ${dirName}, since Vibe offers no list of its sessions for other programs. ${notes(extra)}`;
    const answer = result("ok", detail, every(pollIntervalMs), checkedAt);
    return { ...answer, sessions, basis: found.supported ? BASIS : BASIS_WITHOUT_LEASES };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: MISTRAL_VIBE_CAPABILITIES,
    lookingIn: `Looking for Mistral Vibe sessions in ${dirName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Mistral Vibe sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
