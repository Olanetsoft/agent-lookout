import os from "node:os";
import path from "node:path";

import {
  startV2Scan,
  startV3Scan,
  type KiroLiveness,
  type KiroV2Scan,
  type KiroV3Scan,
} from "../../../core/mapping/kiro-cli/kiroCliMapping.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { pathsOf, tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import {
  createBootClock,
  START_CHECK_TTL_MS,
  type ReadProcessStarts,
} from "../../processes/processStart.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { createRecordProcessCheck } from "../qwen-code/processCheck.ts";
import { every } from "../words.ts";
import { createHeaderReader, type KiroHeader } from "./headers.ts";
import { createLineLog } from "./lineLog.ts";
import { createLockReader, livenessOf, type LockLook, type LockProcess } from "./locks.ts";
import { V2_READING, V3_READING } from "./rows.ts";
import { isRealFolder, readStores, SESSIONS_DIR, type SessionPlace } from "./stores.ts";
import { kiroCliSession, SOURCE_ID } from "./toSession.ts";

/** The variable that names Kiro's folder, for Agent Lookout alone. */
export const KIRO_HOME_ENV = "AGENT_LOOKOUT_KIRO_HOME";

/** Kiro's own variable for its folder. */
export const KIRO_OWN_HOME_ENV = "KIRO_HOME";

/** Where Kiro keeps its files, in the home folder, when nothing names another place. */
export const DEFAULT_KIRO_HOME = ".kiro";

/** How long a folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/**
 * How often every session is looked up in full, for one last written over a
 * day ago that was opened again. Every poll looks for each one's lock, and in
 * the V2 store only lists the folder for it.
 */
export const SWEEP_MS = 60_000;

/** The way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Kiro CLI";

/** Said whenever Kiro CLI is watched, because it is what a person would otherwise expect to see. */
export const V2_NOTE =
  "In Kiro CLI's V2 engine, a session waiting for your approval shows as working, and one in a turn with no tool as idle.";

/** Said whenever Kiro CLI is watched: why an open session can show as finished. */
export const OPEN_NOTE =
  "A session shows as finished once its lock is gone or names a process that has ended. So does a Kiro IDE session with no lock.";

/** Said whenever Kiro CLI is watched, until Agent Lookout has been checked against it. */
export const UNCHECKED_NOTE =
  "Built from Kiro's documentation and open-source readers of its files, and not yet checked on a computer running Kiro CLI.";

/** Said when `KIRO_HOME` is set to a folder Kiro would not take, so its default folder is read. */
export function passedOverNoteFor(homeName: string): string {
  return `${KIRO_OWN_HOME_ENV} is set to a folder Kiro does not use, so ${homeName} is read.`;
}

/** Said when a header is over the most this reads. */
export const TOO_LARGE_NOTE =
  "A Kiro CLI session's header is over 4 MiB, the most Agent Lookout reads, so that session is not shown.";

/** Said when a bucket or the V2 folder could not be listed. */
export const PARTIAL_NOTE =
  "Some of Kiro CLI's session folders could not be listed, so their sessions are not shown.";

/**
 * What a Kiro CLI session can show, from the files this adapter reads. See
 * docs/adapters/kiro-cli.md for each. Built from Kiro's documentation and
 * open-source readers of its files, and not yet checked on a computer running
 * Kiro CLI.
 *
 * - Working and idle come from a V3 session's turn rows, and from a V2
 *   session's newest record, which cannot tell a turn with no tool from idle.
 * - Needs you is a V3 approval or other question Kiro asked in the turn and
 *   has no answer to. V2 writes no wait.
 * - Finished is a session whose lock is gone or names a process that has
 *   ended or was given to another program.
 * - Failed never: the files are not read for errors.
 * - The name is the title Kiro's model gave a V3 session or the person set,
 *   else the folder's. A V2 session takes its folder's name, as V2's title is
 *   the first prompt word for word.
 * - No Jump, no Stop: the lock names Kiro's terminal app, or a helper below
 *   `kiro-cli`, and no terminal or window.
 * - Quiet for is the log's modified time.
 * - No Tokens: no counts are read.
 * - No Answer: Agent Lookout does not talk to Kiro.
 */
export const KIRO_CLI_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "From V3's turn rows. A V2 turn with no tool shows as idle, as V2 writes nothing until it ends.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "While a V3 session waits for your approval or an answer. V2 writes no wait, so one shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once its lock is gone or names a process that has ended. A Kiro IDE session with no lock shows as finished too.",
  },
  failed: {
    level: "no",
    reason: "Kiro's files are not read for errors, so a session never shows as failed.",
  },
  names: {
    level: "partly",
    reason:
      "The title Kiro gives a V3 session, or one you set, else the folder's name. V2's title is your first prompt, so it is not read.",
  },
  jump: {
    level: "no",
    reason: "A session's lock names Kiro's own process, and no terminal or window.",
  },
  "quiet-for": {
    level: "partly",
    reason: "From the session's log, which V2 writes only once each step is done.",
  },
  tokens: { level: "no", reason: "Agent Lookout reads no counts from Kiro's files." },
  stop: {
    level: "no",
    reason: "The process in a session's lock is not one Agent Lookout can confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout does not talk to Kiro, so it cannot send an answer.",
  },
};

/** A setting's value, trimmed. Empty is none. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** Where Kiro's folder is, and why. */
export interface KiroHome {
  home: string;
  /** `AGENT_LOOKOUT_KIRO_HOME` names it. */
  named: boolean;
  /** `KIRO_HOME` names it. */
  fromKiroHome: boolean;
  /** `KIRO_HOME` is set to a folder Kiro does not use, so `~/.kiro` is read. */
  passedOver: boolean;
}

/**
 * Whether Kiro takes `KIRO_HOME`'s value, as its documentation says it does in
 * V3: an absolute path that is not a file system's root, the home folder or a
 * folder above it.
 */
export function kiroTakesHome(value: string, homeDir: string, platform: NodeJS.Platform): boolean {
  const paths = pathsOf(platform);
  if (!paths.isAbsolute(value)) return false;
  const folder = paths.resolve(value);
  if (paths.parse(folder).root === folder) return false;
  const fold = (one: string) => (platform === "win32" ? one.toLowerCase() : one);
  const relative = paths.relative(fold(folder), fold(paths.resolve(homeDir)));
  // The home folder itself, or one it is inside.
  return relative.startsWith("..") || paths.isAbsolute(relative);
}

/**
 * The folder this adapter reads: the one `AGENT_LOOKOUT_KIRO_HOME` names, else
 * `KIRO_HOME` when Kiro would take it, else `~/.kiro`, on every system.
 */
export function kiroHomeFor(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): KiroHome {
  const own = setting(env, KIRO_HOME_ENV);
  if (own !== undefined) {
    return { home: path.resolve(own), named: true, fromKiroHome: false, passedOver: false };
  }
  const kiro = setting(env, KIRO_OWN_HOME_ENV);
  if (kiro !== undefined && kiroTakesHome(kiro, homeDir, platform)) {
    return { home: path.resolve(kiro), named: false, fromKiroHome: true, passedOver: false };
  }
  return {
    home: path.resolve(homeDir, DEFAULT_KIRO_HOME),
    named: false,
    fromKiroHome: false,
    passedOver: kiro !== undefined,
  };
}

/** The sessions folder this adapter reads. */
export function kiroSessionsDirFor(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(kiroHomeFor(env, homeDir, platform).home, SESSIONS_DIR);
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface KiroCliAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** Whether a process runs, with signal 0, which tests a process and sends it nothing. */
  isAlive?: (pid: number) => boolean;
  /** The system's rules for paths, and whether `ps` is asked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** How long the computer has been on, in milliseconds. Defaults to asking the system. */
  uptimeMs?: () => number;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often every session is looked up in full. Defaults to a minute. */
  sweepMs?: number;
  /** Reads when processes started, on a Mac. Defaults to asking `ps`. */
  readProcessStarts?: ReadProcessStarts;
}

/** One session this poll looked up, before its lock's process is judged. */
interface Found {
  place: SessionPlace;
  header: KiroHeader;
  headerInfo: FileInfo;
  logInfo: FileInfo | null;
  /** A link, a folder or anything else is at the log's name, or it could not be looked up. */
  logOther: boolean;
  look: LockLook;
  /** Whether its header or its log was written in the last day. */
  recent: boolean;
}

/** What tells one lock's process from another's, for `ruledOut`. */
const processMark = (pid: number, startedAt: number) => `${pid} ${startedAt}`;

/** What Sources says tells a lock's process from another program given its pid. */
function processCheckFacts(asksPs: boolean, pollIntervalMs: number): SourceFact[] {
  if (!asksPs) {
    return [{ label: "Process check", value: `signal 0 alone, ${every(pollIntervalMs)}` }];
  }
  return [
    { label: "Process check", value: "ps -o pid=,lstart= -p <pids>" },
    {
      label: "Process check run",
      value: `${every(START_CHECK_TTL_MS)} while a session's lock names a process that runs`,
    },
  ];
}

/**
 * Finds Kiro CLI sessions on this computer from the files Kiro keeps, with
 * nothing installed, no setting changed and no Kiro program run. Kiro CLI is
 * not open source: this was built from Kiro's documentation and from
 * open-source readers of its files, and has not yet been checked on a computer
 * running Kiro CLI.
 *
 * Kiro offers no list of its sessions for other programs, so the adapter reads
 * the two stores in `~/.kiro/sessions/` side by side, read-only
 * (`stores.ts`): V3's folder for each session and V2's files in `cli/`. Of
 * each session it reads its header for its folder, its start and, in V3, its
 * title (`headers.ts`), its lock for the process that has it open
 * (`locks.ts`) and, while that is open or not known to be closed, the end of
 * its log for the newest turn (`lineLog.ts`, `rows.ts`).
 *
 * Kiro keeps every session it ran, so a poll looks up in full only the
 * sessions written in the last day, those with a lock and those it shows. For
 * every other session it looks only for a lock, with an `lstat` of its folder
 * and of its lock in V3 and none in V2, whose folder's listing names each
 * lock, and it looks each one up in full once a minute. A session is listed
 * while it is open or not known to be closed, and for a day after it was last
 * written or last seen open.
 *
 * A lock is open when signal 0 finds its process, which sends nothing, it was
 * taken since the computer started and, on a Mac, `ps` says its process started
 * no later than a minute after the lock was taken. Elsewhere, and when `ps`
 * cannot say, whether it is open is not known, and the status is read from the
 * log as for an open one. Only `pid` and `lstart` of a lock's process are
 * asked of `ps`, never its arguments. A lock whose process has ended is left
 * as it is.
 *
 * Kiro not being installed costs nothing: when its folder is missing, the
 * adapter says so and looks again only once a minute. Someone who sets
 * `AGENT_LOOKOUT_KIRO_HOME` means that folder: if it holds no sessions, that
 * is an answer, not a missing Kiro.
 */
export function createKiroCliAdapter(options: KiroCliAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const bootClock = createBootClock(options.uptimeMs ?? (() => os.uptime() * 1000), now);
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const asksPs = platform === "darwin";
  const processCheck = asksPs ? createRecordProcessCheck(options.readProcessStarts, now) : null;

  const { home, named, fromKiroHome, passedOver } = kiroHomeFor(env, homeDir, platform);
  const homeName = tildify(home, homeDir);
  const sessionsDir = path.join(home, SESSIONS_DIR);
  const sessionsName = tildify(sessionsDir, homeDir);
  const headers = createHeaderReader(io, platform);
  const locks = createLockReader(io);
  const v3Logs = createLineLog(io, V3_READING);
  const v2Logs = createLineLog(io, V2_READING);
  const processFacts = processCheckFacts(asksPs, pollIntervalMs);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** When every session was last looked up in full. */
  let sweptAt: number | null = null;
  /** The sessions last found with no lock, written over a day ago and not seen open in it. */
  let settled = new Set<string>();
  /** The last poll that saw each session open, or not known to be closed, kept while it is listed. */
  let openSeen = new Map<string, number>();
  /**
   * Each lock's process `ps` showed is another program, by `processMark`,
   * kept while that pid runs. A pid goes only to a program that starts later,
   * so the answer stands: a later check that cannot answer does not open the
   * session again.
   */
  let ruledOut = new Set<string>();

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    sessions: Session[] = [],
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: [
        { label: "Sessions folder", value: sessionsName },
        { label: "Read", value: read },
        {
          label: "Files read",
          value:
            "session.json, .lock and the end of messages.jsonl of each V3 session; <uuid>.json, <uuid>.lock and the end of <uuid>.jsonl of each V2 one",
        },
        ...processFacts,
      ],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis: BASIS } : { health, sessions: [] };
  }

  /** The notes said whenever Kiro CLI is watched. */
  const passedOverNote = passedOver ? ` ${passedOverNoteFor(homeName)}` : "";
  const alwaysNotes = `${V2_NOTE} ${OPEN_NOTE} ${UNCHECKED_NOTE}${passedOverNote}`;

  /** Kiro is not on this computer, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const where = fromKiroHome
      ? `${KIRO_OWN_HOME_ENV} is set, and there is no ${homeName} folder`
      : `there is no ${homeName} folder`;
    return result(
      "unavailable",
      `Kiro CLI was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.${passedOverNote}`,
      "not found",
      checkedAt,
    );
  }

  /** Whether Kiro's folder is there. Only one that is missing, or is no folder, counts as not there. */
  async function homeIsThere(): Promise<boolean> {
    try {
      return (await io.stat(home)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  /** An ordinary file's `lstat`, or null when there is none at its name or it cannot be looked up. */
  async function lookUp(file: string): Promise<FileInfo | null> {
    try {
      const info = await io.lstat(file);
      return info.kind === "file" ? info : null;
    } catch {
      return null;
    }
  }

  /**
   * A log's `lstat`: an ordinary file's, null when nothing is at its name, and
   * "other" for a link, a folder or anything else there, or a look that failed.
   */
  async function lookUpLog(file: string): Promise<FileInfo | null | "other"> {
    try {
      const info = await io.lstat(file);
      return info.kind === "file" ? info : "other";
    } catch (error) {
      return isMissing(error) ? null : "other";
    }
  }

  /** Whether it is time to look up every session in full. A clock set back counts as time enough. */
  function sweepDue(checkedAt: number): boolean {
    if (sweptAt === null) return true;
    const since = checkedAt - sweptAt;
    return since < 0 || since >= sweepMs;
  }

  function forgetAll(): void {
    settled = new Set();
    openSeen = new Map();
    ruledOut = new Set();
    sweptAt = null;
    const none = new Set<string>();
    headers.keepOnly(none);
    locks.keepOnly(none);
    v3Logs.keepOnly(none);
    v2Logs.keepOnly(none);
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Kiro is believed missing for a while, so a computer without it
    // pays nothing on most polls.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    const stores = await readStores(sessionsDir, io);
    if (stores.state === "unreadable") {
      return result(
        "error",
        `Kiro CLI sessions could not be read: ${sessionsName} could not be listed, or a link or something other than a folder is at its name.${passedOverNote}`,
        "cannot be read",
        checkedAt,
      );
    }
    if (stores.state === "missing") {
      forgetAll();
      if (!(await homeIsThere())) {
        if (named) {
          return result(
            "ok",
            `${KIRO_HOME_ENV} is set, and there is no ${homeName} folder, so no Kiro CLI sessions are listed. ${alwaysNotes}`,
            "not found",
            checkedAt,
          );
        }
        absentAt = checkedAt;
        return notFound(checkedAt);
      }
      absentAt = null;
      return result(
        "ok",
        `Kiro CLI has not saved any sessions in ${homeName} yet. ${alwaysNotes}`,
        every(pollIntervalMs),
        checkedAt,
      );
    }
    absentAt = null;

    const sweep = sweepDue(checkedAt);
    if (sweep) sweptAt = checkedAt;
    const stillSettled = new Set<string>();
    const found: Found[] = [];
    const looked = new Set<string>();
    let tooLarge = false;

    for (const place of stores.places) {
      const { id } = place;
      // A V3 session's folder must be a real folder before anything in it is looked at.
      if (place.folder !== undefined && !(await isRealFolder(place.folder, io))) continue;
      let look: LockLook | null = null;
      if (settled.has(id) && !sweep) {
        // Only a lock brings a settled session back before the next sweep.
        if (place.store === "v2") {
          if (!place.lockListed) {
            stillSettled.add(id);
            continue;
          }
        } else {
          look = await locks.look(place.lock, false);
          if (look.state === "none") {
            stillSettled.add(id);
            continue;
          }
        }
      }
      const headerInfo = await lookUp(place.header);
      if (headerInfo === null) continue;
      const logLook = await lookUpLog(place.log);
      const logInfo = logLook === "other" ? null : logLook;
      const logOther = logLook === "other";
      const newest = Math.max(headerInfo.mtimeMs, logInfo?.mtimeMs ?? 0);
      const recent = isWithinRetention(Math.floor(newest), checkedAt);
      const seenAt = openSeen.get(id);
      const seenRecently = seenAt !== undefined && isWithinRetention(seenAt, checkedAt);
      const folderIsNoLock = place.store === "v2";
      // A session written over a day ago, and not seen open in it, is listed only with a lock.
      if (!recent && !seenRecently) {
        look ??= await locks.look(place.lock, folderIsNoLock);
        if (look.state === "none") {
          stillSettled.add(id);
          continue;
        }
      }
      looked.add(place.header);
      const read = await headers.read(place.header, headerInfo, place.store);
      if (read.state === "too-large") tooLarge = true;
      if (read.state !== "ok" || read.header.subagent) continue;
      looked.add(place.lock);
      look ??= await locks.look(place.lock, folderIsNoLock);
      found.push({ place, header: read.header, headerInfo, logInfo, logOther, look, recent });
    }

    // A lock counts as open only when its process runs, it was taken since the
    // computer started and, on a Mac, `ps` says its process started no later
    // than a minute after it was taken. The computer's start is the earliest
    // seen, so a clock set forward does not put it after locks taken before then.
    const bootedAt = bootClock();
    const facts = new Map<Found, LockProcess>();
    const asked: { pid: number; startedAt: number }[] = [];
    const askedFor = new Map<Found, { pid: number; startedAt: number }>();
    for (const one of found) {
      if (one.look.state !== "held") continue;
      const { pid, startedAt } = one.look.lock;
      const alive = isAlive(pid);
      facts.set(one, { alive, bootedAt, match: null });
      if (alive && startedAt !== null && startedAt >= bootedAt && processCheck !== null) {
        const record = { pid, startedAt };
        asked.push(record);
        askedFor.set(one, record);
      }
    }
    const matches = await processCheck?.matches(asked);
    const stillRuledOut = new Set<string>();
    for (const [one, record] of askedFor) {
      const mark = processMark(record.pid, record.startedAt);
      const match = ruledOut.has(mark) ? "different" : (matches?.get(record) ?? "unknown");
      if (match === "different") stillRuledOut.add(mark);
      const known = facts.get(one);
      if (known) facts.set(one, { ...known, match });
    }
    ruledOut = stillRuledOut;

    const sessions: Session[] = [];
    const stillSeen = new Map<string, number>();
    const logs = new Set<string>();
    for (const one of found) {
      const { place, header, headerInfo, logInfo, logOther, look, recent } = one;
      const live: KiroLiveness = livenessOf(look, facts.get(one));
      const kept = openSeen.get(place.id);
      // Kept no later than this poll, so a clock set back does not put it ahead.
      const seenAt =
        live === "closed"
          ? kept === undefined
            ? undefined
            : Math.min(kept, checkedAt)
          : checkedAt;
      const seenRecently = seenAt !== undefined && isWithinRetention(seenAt, checkedAt);
      if (live === "closed" && !recent && !seenRecently) continue;

      let v3: KiroV3Scan | null = null;
      let v2: KiroV2Scan | null = null;
      if (live !== "closed" && logOther) {
        // A log that is not an ordinary file says nothing: the session is unknown, never idle.
        if (place.store === "v3") v3 = { ...startV3Scan(false), unreadable: true };
        else v2 = startV2Scan(false);
      } else if (live !== "closed" && logInfo !== null) {
        logs.add(place.log);
        try {
          if (place.store === "v3") v3 = await v3Logs.read(place.log, logInfo);
          else v2 = await v2Logs.read(place.log, logInfo);
        } catch {
          // A log that cannot be read this poll says nothing: the session is unknown.
          if (place.store === "v3") v3 = { ...startV3Scan(false), unreadable: true };
          else v2 = startV2Scan(false);
        }
      }

      if (seenAt !== undefined) stillSeen.set(place.id, seenAt);
      sessions.push(
        kiroCliSession({
          sessionId: place.id,
          header,
          live,
          ...(live === "open" && look.state === "held" ? { pid: look.lock.pid } : {}),
          ...(place.store === "v3" ? { v3 } : { v2 }),
          headerWrittenAt: headerInfo.mtimeMs,
          ...(logInfo === null ? {} : { logWrittenAt: logInfo.mtimeMs }),
          ...(seenAt === undefined ? {} : { openSeenAt: seenAt }),
          now: checkedAt,
        }),
      );
    }

    settled = stillSettled;
    openSeen = stillSeen;
    headers.keepOnly(looked);
    locks.keepOnly(looked);
    v3Logs.keepOnly(logs);
    v2Logs.keepOnly(logs);

    let detail = `Sessions are read from the files Kiro CLI saves in ${homeName}, since it offers no list of its sessions for other programs. ${alwaysNotes}`;
    if (tooLarge) detail += ` ${TOO_LARGE_NOTE}`;
    if (stores.partial) detail += ` ${PARTIAL_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: KIRO_CLI_CAPABILITIES,
    lookingIn: `Looking for Kiro CLI sessions in ${homeName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Kiro CLI sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
