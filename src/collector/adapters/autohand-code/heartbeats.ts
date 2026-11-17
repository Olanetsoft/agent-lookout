import path from "node:path";

import {
  inFreshWindow,
  type AutohandMode,
  type AutohandPhase,
} from "../../../core/mapping/autohand-code/autohandCodeMapping.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { validPid } from "../../processes/pids.ts";
import { createFolderLister, type FolderLister } from "../prime-agent/folders.ts";
import { isHeartbeatName, isTrusted, nameIsSessions } from "./folders.ts";
import {
  asciiOf,
  bytesAt,
  folderAt,
  isIdByte,
  isWholeObject,
  runAt,
  topKey,
  topStringKey,
  topTime,
  valueAfter,
  wholeNumberAt,
  wordAt,
} from "./jsonBytes.ts";

/**
 * Reading the heartbeats Autohand Code keeps in `active-agents`, for the few
 * fields a status needs. Built from Autohand Code's source at v0.9.11 and not
 * yet checked on a computer running it.
 *
 * While a session runs, Autohand Code rewrites `<session ID>.json`, or
 * `<session ID>.<instance ID>.json` with peer communication on, every 5
 * seconds (`src/session/ActiveAgentRegistry.ts:14`, `:171-175`, `:202-252`),
 * for other programs to read. Its own reader takes a heartbeat only as an
 * ordinary file with one name, of 131,072 bytes or less, and on macOS and
 * Linux only one of the user it runs as that no one else may read or write
 * (`:145-152`); this reads none other. Autohand Code's reader also deletes
 * every heartbeat it finds stale, so it is never run: the folder is read here.
 *
 * A heartbeat holds the instruction the session is working on, the command it
 * runs, the files it wrote and claimed, its git branch and, with peer
 * communication on, its socket's address and public key. This finds only
 * `version`, `pid`, `sessionId`, `workspaceRoot`, `mode`, `startedAt`,
 * `updatedAt` and the `phase` of `activity`, as bytes (`jsonBytes.ts`). `phase`
 * is the first key of `activity` in both of Autohand Code's writers
 * (`src/session/peers/PeerActivityPublisher.ts:60-61`, `src/core/agent.ts:3166`),
 * and the instruction comes after it, so the other keys are looked for only
 * before `phase`. Nothing after it is looked at. `status` is not read: it can
 * lag `phase` (`src/core/agent.ts:3133-3136`).
 *
 * The folder is looked up on each poll and listed when it changed and once a
 * minute (`folders.ts` in the Prime Agent adapter). Each heartbeat is looked up
 * with `lstat`, and opened, read-only and following no link, only when its
 * size, modified time or identity changed: its first 4 KiB, and at most 16 KiB
 * when what is needed is not in those. Before 0.9.8 Autohand Code wrote a
 * heartbeat in place, so a read can catch one half written: what was read of
 * it before stands in, once. Nothing here writes, renames, locks or deletes
 * anything, and no lock folder beside a heartbeat is opened.
 */

/** The most heartbeats read. When more are there, the ones written most recently. */
export const MAX_HEARTBEAT_FILES = 200;

/** The largest heartbeat read, as Autohand Code's own reader (`src/session/ActiveAgentRegistry.ts:149`). */
export const MAX_HEARTBEAT_BYTES = 131_072;

/** The first read of a heartbeat. */
export const HEARTBEAT_FIRST_READ = 4_096;

/** The most of a heartbeat read in all. */
export const HEARTBEAT_READ_LIMIT = 16_384;

/** The most of a heartbeat's process IDs kept for one file, for two programs that share it. */
export const MAX_PIDS_PER_NAME = 8;

/** The longest folder read from a heartbeat. */
const MAX_PATH_BYTES = 8_192;

/** The longest session ID read. */
const MAX_ID_BYTES = 200;

const PHASE_ANCHOR = Buffer.from('\n  "activity": {\n    "phase": "');
const PHASES: readonly AutohandPhase[] = [
  "idle",
  "thinking",
  "editing",
  "running_command",
  "waiting_input",
];
const PHASE_WORDS = PHASES.map((phase) => Buffer.from(`${phase}"`));
const MODES: readonly AutohandMode[] = ["interactive", "command", "rpc"];
const MODE_WORDS = MODES.map((mode) => Buffer.from(`${mode}"`));
const VERSION_ONE = Buffer.from("1,");

/** What is kept of one heartbeat. */
export interface Heartbeat {
  pid: number;
  sessionId: string;
  /** When Autohand Code wrote it, in epoch milliseconds, or null when its time cannot be read. */
  updatedAt: number | null;
  /** When the session was made, as Autohand Code gives it, or null. Not when its process started. */
  startedAt: number | null;
  mode: AutohandMode | null;
  /** Its stage of work, or null when it names none this knows. */
  phase: AutohandPhase | null;
  /** The session's folder, when it is a whole path. */
  workspaceRoot: string | null;
}

/** What one heartbeat's bytes say. */
export type HeartbeatBytes =
  | { state: "ok"; heartbeat: Heartbeat }
  /** More of the file is needed to say. */
  | { state: "more" }
  /** Of a format other than the one this reads. */
  | { state: "newer" }
  /** Not a heartbeat this reads: cut off, written another way, or with no session. */
  | { state: "broken" };

/** How much of a heartbeat the bytes are. */
export interface Extent {
  /** They are the whole file. */
  whole: boolean;
  /** No more of it will be read. */
  last: boolean;
}

/**
 * The kept fields of a heartbeat, from its first bytes. Only the bytes before
 * `phase` are looked at for the other fields, and when there is no `phase`,
 * all of them, with the stage not known.
 */
export function heartbeatOf(
  bytes: Buffer,
  extent: Extent,
  platform: NodeJS.Platform,
): HeartbeatBytes {
  const { whole } = extent;
  const last = extent.last || whole;
  const phaseAt = bytes.indexOf(PHASE_ANCHOR);
  const phaseWord =
    phaseAt < 0 ? -1 : wordAt(bytes, phaseAt + PHASE_ANCHOR.byteLength, PHASE_WORDS);
  // The phase or its word may lie past what was read.
  const phaseCut =
    phaseAt >= 0 &&
    phaseWord < 0 &&
    phaseAt + PHASE_ANCHOR.byteLength + Math.max(...PHASE_WORDS.map((word) => word.byteLength)) >
      bytes.byteLength;
  if (!last && (phaseAt < 0 || phaseCut)) return { state: "more" };
  if (whole && !isWholeObject(bytes)) return { state: "broken" };
  const head = phaseAt < 0 ? bytes : bytes.subarray(0, phaseAt);

  const versionAt = valueAfter(head, topKey("version"));
  if (versionAt < 0) return { state: "broken" };
  if (!bytesAt(head, versionAt, VERSION_ONE)) {
    return wholeNumberAt(head, versionAt) === null ? { state: "broken" } : { state: "newer" };
  }
  const pid = validPid(wholeNumberAt(head, valueAfter(head, topKey("pid"))));
  const idRun = runAt(head, valueAfter(head, topStringKey("sessionId")), MAX_ID_BYTES, isIdByte);
  const sessionId = idRun === null ? null : asciiOf(idRun, MAX_ID_BYTES);
  if (pid === undefined || sessionId === null) return { state: "broken" };

  const modeAt = valueAfter(head, topStringKey("mode"));
  const mode = modeAt < 0 ? -1 : wordAt(head, modeAt, MODE_WORDS);
  const rootAt = valueAfter(head, topKey("workspaceRoot"));
  return {
    state: "ok",
    heartbeat: {
      pid,
      sessionId,
      updatedAt: topTime(head, "updatedAt"),
      startedAt: topTime(head, "startedAt"),
      mode: MODES[mode] ?? null,
      phase: PHASES[phaseWord] ?? null,
      workspaceRoot: rootAt < 0 ? null : folderAt(head, rootAt, MAX_PATH_BYTES, platform),
    },
  };
}

/** A file's identity as last read, so an unchanged one is not opened again. */
interface Identity {
  ino: number;
  size: number;
  mtimeMs: number;
}

const sameIdentity = (a: Identity, b: Identity) =>
  a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** One heartbeat found on this poll, with whether its process runs. */
export interface HeartbeatFound {
  /** The file's name in `active-agents`. */
  name: string;
  heartbeat: Heartbeat;
  /** False when signal 0 found no such process, or the file was already found so and is unchanged. */
  alive: boolean;
}

/** What this poll found in the folder of heartbeats. */
export interface HeartbeatPoll {
  /** `listed`, or why there are none: no folder, or one that cannot be listed or is not this user's. */
  folder: "listed" | "missing" | "unlistable";
  /**
   * Each heartbeat's newest content, and, for a file two programs share, what
   * each other program last wrote in it while that is fresh and its process
   * runs.
   */
  found: HeartbeatFound[];
  /** A heartbeat of another format was found. */
  newer: boolean;
  /** A heartbeat over the most read was found. */
  tooLarge: boolean;
}

interface Known {
  identity: Identity;
  read: HeartbeatBytes;
  /** True once this read stood in for a file that could not be read. */
  stoodIn: boolean;
  /** True once its process was found gone: it stays so while the file is unchanged. */
  dead: boolean;
}

export interface HeartbeatReader {
  /**
   * The heartbeats now, with `alive` asked once for each process. Never
   * rejects for one file: a file that cannot be read is left out.
   */
  read(checkedAt: number, alive: (pid: number) => boolean): Promise<HeartbeatPoll>;
}

export interface HeartbeatReaderOptions {
  dir: string;
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  euid: number | null;
  sweepMs: number;
}

/** A reader of the heartbeats folder, which keeps what it read of each file until it changes. */
export function createHeartbeatReader(options: HeartbeatReaderOptions): HeartbeatReader {
  const { dir, io, platform, euid } = options;
  const lister: FolderLister = createFolderLister(dir, io, options.sweepMs, (info) =>
    isTrusted(info, "heartbeats-folder", platform, euid),
  );
  const known = new Map<string, Known>();
  /** Each file's last content from each process that wrote it, by process, newest last. */
  const byPid = new Map<string, Map<number, Heartbeat>>();

  async function lookUp(name: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(path.join(dir, name));
    } catch {
      return null;
    }
  }

  /** The names read: when more than the most, the ones written most recently. */
  async function chosen(names: readonly string[]): Promise<[string, FileInfo][]> {
    const looked: [string, FileInfo][] = [];
    for (const name of names) {
      const info = await lookUp(name);
      if (info !== null) looked.push([name, info]);
    }
    if (looked.length <= MAX_HEARTBEAT_FILES) return looked;
    return looked
      .sort(([a, x], [b, y]) => y.mtimeMs - x.mtimeMs || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_HEARTBEAT_FILES);
  }

  async function bytesOf(handle: OpenFile): Promise<HeartbeatBytes> {
    const { size } = handle.info;
    const first = Buffer.from(await handle.read(0, Math.min(size, HEARTBEAT_FIRST_READ)));
    const end = Math.min(size, HEARTBEAT_READ_LIMIT);
    const firstRead = heartbeatOf(
      first,
      { whole: first.byteLength >= size, last: end <= first.byteLength },
      platform,
    );
    if (firstRead.state !== "more") return firstRead;
    const rest = Buffer.from(await handle.read(first.byteLength, end - first.byteLength));
    const all = Buffer.concat([first, rest]);
    // Past the most read, a heartbeat with no stage is read without one.
    return heartbeatOf(all, { whole: all.byteLength >= size, last: true }, platform);
  }

  /**
   * What a heartbeat that changed says now, with the identity of the file
   * read: `refused` when the open file is not one this reads, and `failed`
   * when it could not be opened or read.
   */
  async function open(
    name: string,
  ): Promise<{ identity: Identity; read: HeartbeatBytes } | "refused" | "too-large" | "failed"> {
    let handle: OpenFile;
    try {
      handle = await io.openRegular(path.join(dir, name));
    } catch {
      return "failed";
    }
    try {
      const { info } = handle;
      if (!isTrusted(info, "heartbeat", platform, euid)) return "refused";
      if (info.size > MAX_HEARTBEAT_BYTES) return "too-large";
      return { identity: info, read: await bytesOf(handle) };
    } catch {
      return "failed";
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return {
    async read(checkedAt, alive) {
      const listing = await lister.list(checkedAt);
      if (listing.state !== "listed") {
        known.clear();
        byPid.clear();
        return { folder: listing.state, found: [], newer: false, tooLarge: false };
      }
      const found: HeartbeatFound[] = [];
      const seen = new Set<string>();
      let newer = false;
      let tooLarge = false;

      for (const [name, info] of await chosen(listing.names.filter(isHeartbeatName))) {
        if (!isTrusted(info, "heartbeat", platform, euid)) continue;
        if (info.size > MAX_HEARTBEAT_BYTES) {
          tooLarge = true;
          continue;
        }
        let before = known.get(name);
        if (before === undefined || !sameIdentity(before.identity, info)) {
          const opened = await open(name);
          if (opened === "too-large") tooLarge = true;
          if (opened === "refused" || opened === "too-large") continue;
          const unread = opened === "failed" || opened.read.state === "broken";
          if (unread && before?.read.state === "ok" && !before.stoodIn) {
            // Half written, as a read can catch it, or not read this once:
            // what was read before stands in, once.
            before.stoodIn = true;
          } else if (opened === "failed") {
            continue;
          } else {
            before = { identity: opened.identity, read: opened.read, stoodIn: false, dead: false };
            known.set(name, before);
          }
        }
        seen.add(name);
        const { read } = before;
        if (read.state === "newer") newer = true;
        if (read.state !== "ok") continue;
        const { heartbeat } = read;
        if (!nameIsSessions(name, heartbeat.sessionId)) continue;

        // A file found with its process gone stays so while it is unchanged,
        // whatever a later process given the same ID answers.
        if (!before.dead && !alive(heartbeat.pid)) before.dead = true;
        found.push({ name, heartbeat, alive: !before.dead });

        const pids = byPid.get(name) ?? new Map<number, Heartbeat>();
        pids.delete(heartbeat.pid);
        pids.set(heartbeat.pid, heartbeat);
        while (pids.size > MAX_PIDS_PER_NAME) pids.delete(pids.keys().next().value as number);
        byPid.set(name, pids);
        // What another program last wrote here counts while it is fresh and its process runs.
        for (const [pid, other] of pids) {
          if (pid === heartbeat.pid) continue;
          if (inFreshWindow(other.updatedAt, checkedAt) && alive(pid)) {
            found.push({ name, heartbeat: other, alive: true });
          }
        }
      }

      for (const name of [...known.keys()]) if (!seen.has(name)) known.delete(name);
      for (const name of [...byPid.keys()]) if (!seen.has(name)) byPid.delete(name);
      return { folder: "listed", found, newer, tooLarge };
    },
  };
}
