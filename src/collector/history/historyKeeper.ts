import path from "node:path";

import type {
  HistoryBeginning,
  HistoryKept,
  HistoryRestart,
  HistorySince,
} from "../../core/api.ts";
import type { HistoryPoint, SessionEvent } from "../../core/sessions/session.ts";
import type { EventStore } from "../eventStore.ts";
import type { HistoryStore } from "../historyStore.ts";
import { nodeHistoryFs, type HistoryFs } from "./historyFiles.ts";
import {
  byFileOrder,
  dayEnd,
  dayOf,
  encodeRecord,
  HISTORY_FORMAT_VERSION,
  historyFileName,
  MAX_LINE_LENGTH,
  parseHistoryText,
  parseRecord,
  readHistoryFileName,
  recordAt,
  restartsAmong,
  type HistoryFileName,
  type HistoryRecord,
} from "./historyFormat.ts";
import {
  filesToDelete,
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_BYTES,
  HISTORY_MAX_FILE_BYTES,
  type KeptFile,
} from "./historyLimits.ts";
import { createWriterLock, LOCK_FILE } from "./writerLock.ts";

/** How often what was added is written: every 5 seconds, and once more as Agent Lookout stops. */
export const FLUSH_INTERVAL_MS = 5_000;

/**
 * How long the files get to be read when Agent Lookout starts. They are a few
 * megabytes on this computer's own disk and take a fraction of a second. Past
 * this, something is stuck, such as a home folder on a network drive that has
 * gone away, and this run keeps its history in memory.
 */
export const RESTORE_DEADLINE_MS = 10_000;

/** The most lines held back between two writes. A poll adds one line, and a busy one a few more. */
const MAX_QUEUED_LINES = 50_000;

/** The highest number a day's file can have. */
const MAX_PART = 9_999;

/**
 * How far ahead of this computer's clock a record may be and still be read
 * back. One written further ahead was written while the clock was wrong, and
 * would sit after everything this run records.
 */
const FUTURE_SLACK_MS = 60_000;

/** The most restarts handed back: far more than eight days of ordinary use. */
const MAX_RESTARTS = 500;

export interface HistoryKeeperOptions {
  /** The folder, as an absolute path. */
  dir: string;
  /** The same, as it is shown: `~/.agent-lookout/history`. */
  folder: string;
  /** Defaults to the real file system. Tests pass a folder held in memory. */
  fs?: HistoryFs;
  now?: () => number;
  /** This process, which the lock names. Defaults to `process.pid`. */
  pid?: number;
  /** Whether a process is running, to tell a lock left behind. Defaults to asking the system. */
  isAlive?: (pid: number) => boolean;
  /**
   * Which folders this copy reads sessions from, as a fingerprint, for the
   * lock: `sourcesFingerprint` in `historySettings.ts`. Null when not known.
   */
  sources?: string | null;
  flushIntervalMs?: number;
  restoreDeadlineMs?: number;
  maxBytes?: number;
  maxFileBytes?: number;
  maxAgeMs?: number;
  /** Where the one line goes that says the history cannot be kept. Defaults to nowhere. */
  warn?: (line: string) => void;
}

/** What the files held, oldest first: as much as the stores in memory take. */
export interface RestoredHistory {
  events: SessionEvent[];
  points: HistoryPoint[];
  /** Each time Agent Lookout started again, oldest first: the newest 500, from 8 days at most. */
  restarts: HistoryRestart[];
  /** The newest moment the files hold, or null when they hold nothing. */
  lastAt: number | null;
}

/** How much of what is restored goes into memory: what the stores hold. */
export interface RestoreLimits {
  events: number;
  points: number;
}

export type ClearOutcome =
  { ok: true; at: number } | { ok: false; reason: "not-writing" | "failed"; error: string };

/**
 * Keeps the history on disk, so the Events log and the charts outlast a
 * restart: every event and history point the stores take is written to a file
 * in one folder, and read back when Agent Lookout starts again.
 *
 * - Nothing is written during a poll. What is added waits in memory and is
 *   written every 5 seconds, by another turn of the event loop, and what is
 *   left is written as Agent Lookout stops.
 * - Only what the stores hold is written: events and points, and when watching
 *   started or the history was cleared. An event holds its session's name as
 *   the dashboard shows it, and never what a waiting session is asking or
 *   anything else a session carries: `historyFormat.ts` writes an event field
 *   by field.
 * - The folder is made with mode 700 and each file with mode 600. A file that
 *   is a link, is not an ordinary file, or is larger than a file is allowed to
 *   grow is not read. A line that does not parse is passed over. A file of a
 *   later format is not read, written or deleted, not even by clearing.
 * - The files hold 20 MB at most, and a day's file goes 8 days after its day
 *   ends. The oldest go first.
 * - Only one copy of Agent Lookout writes at a time: `writerLock.ts`.
 */
export interface HistoryKeeper {
  /**
   * Reads what the folder holds, making the folder if it is not there. Resolves
   * with the newest events and points that fit in memory, oldest first, and
   * the restarts among them, or with none when there is nothing to read or it
   * could not be read in time. A record dated later than a minute from now
   * was written while the clock was wrong, and is passed over. Never rejects.
   * Called once, before `start`.
   */
  restore(limits: RestoreLimits): Promise<RestoredHistory>;
  /** Begins writing: takes the lock, notes that watching started, and writes on every beat. */
  start(): void;
  /** Holds these events to be written. */
  addEvents(events: readonly SessionEvent[]): void;
  /** Holds this point to be written. */
  addPoint(point: HistoryPoint): void;
  /** Writes what is held now. Resolves once it is written, or could not be. */
  flush(): Promise<void>;
  /** Writes what is left, at once, and lets the lock go. */
  stop(): void;
  /**
   * Deletes every history file and starts the history again from now, with a
   * record that it was cleared. `forget` empties the stores in memory, at the
   * moment the files are gone, so nothing from before is written again.
   */
  clear(forget: () => void): Promise<ClearOutcome>;
  /** Where the history kept begins, or null when nothing has been kept yet. */
  since(): HistorySince | null;
  /** Where it is kept and how much it holds, for `/api/history`. */
  status(): HistoryKept;
}

/** A file of this version's format, as the keeper knows it. */
interface Known extends KeptFile {
  /** Its first record, or null when it holds none that could be read. */
  first: { at: number; kind: HistoryRecord["kind"] } | null;
}

const BEGINNING: Record<HistoryRecord["kind"], HistoryBeginning> = {
  start: "started",
  cleared: "cleared",
  point: "trimmed",
  event: "trimmed",
};

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isNotOrdinary(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ELOOP" ||
    code === "EISDIR" ||
    code === "EMLINK" ||
    code === "ENXIO" ||
    code === "EOPNOTSUPP" ||
    (error instanceof Error && error.message === "Not an ordinary file.")
  );
}

/** The newest `limit` of a list in time order. */
function newest<T>(list: T[], limit: number): T[] {
  return list.length > limit ? list.slice(list.length - Math.max(0, limit)) : list;
}

export function createHistoryKeeper(options: HistoryKeeperOptions): HistoryKeeper {
  const { dir, folder } = options;
  const fs = options.fs ?? nodeHistoryFs;
  const now = options.now ?? Date.now;
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const restoreDeadlineMs = options.restoreDeadlineMs ?? RESTORE_DEADLINE_MS;
  const maxBytes = options.maxBytes ?? HISTORY_MAX_BYTES;
  const maxFileBytes = options.maxFileBytes ?? HISTORY_MAX_FILE_BYTES;
  // A file is read a little past what one may grow to: the last write as
  // Agent Lookout stops can land beside one still under way. Past this, it is
  // not a file this version wrote.
  const readLimit = Math.floor(maxFileBytes * 1.05);
  const maxAgeMs = options.maxAgeMs ?? HISTORY_MAX_AGE_MS;
  const warn = options.warn ?? (() => {});
  const lock = createWriterLock({
    fs,
    file: path.join(dir, LOCK_FILE),
    pid: options.pid,
    now,
    isAlive: options.isAlive,
    sources: options.sources ?? null,
  });

  /** The files of this format, by name. */
  const files = new Map<string, Known>();
  /** Names where something other than an ordinary file is, which are never written to. */
  const blocked = new Set<string>();
  /**
   * The files this copy has written to since it last began writing. The first
   * write to any other that already holds something starts on a line of its
   * own: a copy that crashed may have left half a line at its end.
   */
  const touched = new Set<string>();
  /** Lines waiting to be written, in the order they were added. */
  let queue: string[] = [];
  /** When watching started, to be written first by the copy that writes. */
  let startedAt: number | null = null;
  /** The day and part being written to. */
  let target: { day: string; part: number } | null = null;

  let restored = false;
  /** Set when the folder cannot be used at all this run: nothing is written. */
  let unusable: string | null = null;
  /** Set while writing fails. */
  let failing: string | null = null;
  /** When the history was last cleared by this copy, for as long as its record could not be written. */
  let clearedAt: number | null = null;
  /** Whether this copy holds the lock, once it has been asked. */
  let writer: boolean | null = null;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Every change to the folder, one after another. */
  let chain: Promise<unknown> = Promise.resolve();

  function serially<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  }

  const full = (name: string) => path.join(dir, name);

  function hold(record: HistoryRecord): void {
    if (unusable !== null || !running) return;
    const line = encodeRecord(record);
    if (line.length > MAX_LINE_LENGTH || byteLength(line) > maxFileBytes) return;
    queue.push(line);
    if (queue.length > MAX_QUEUED_LINES) queue = queue.slice(queue.length - MAX_QUEUED_LINES);
  }

  /** What reading the folder found: what goes into memory, and the files as they are. */
  interface Reading {
    history: RestoredHistory;
    found: Map<string, Known>;
    notFiles: Set<string>;
  }

  /**
   * The records of a file's text this run can take: none written further
   * ahead of the clock than a little, since those would sit after everything
   * this run records, in stores that are kept in time order.
   */
  function recordsIn(text: string, at: number): HistoryRecord[] {
    return parseHistoryText(text).records.filter(
      (record) => recordAt(record) <= at + FUTURE_SLACK_MS,
    );
  }

  async function readAll(limits: RestoreLimits): Promise<Reading | string> {
    try {
      await fs.makeFolder(dir);
    } catch {
      return `Agent Lookout could not make its history folder, ${folder}, so this run keeps history in memory only.`;
    }
    let names: string[];
    try {
      names = await fs.list(dir);
    } catch {
      return `Agent Lookout could not read its history folder, ${folder}, so this run keeps history in memory only.`;
    }

    const ours = names
      .map(readHistoryFileName)
      .filter((file): file is HistoryFileName => file?.version === HISTORY_FORMAT_VERSION)
      .sort(byFileOrder);
    const found = new Map<string, Known>();
    const notFiles = new Set<string>();
    const events = new Map<string, SessionEvent>();
    const points: HistoryPoint[] = [];
    const starts: number[] = [];
    const times: number[] = [];
    let lastAt: number | null = null;
    const at = now();
    for (const file of ours) {
      let info: Awaited<ReturnType<HistoryFs["lstat"]>>;
      try {
        info = await fs.lstat(full(file.name));
      } catch {
        continue;
      }
      if (info.kind !== "file") {
        notFiles.add(file.name);
        continue;
      }
      const known: Known = { ...file, size: info.size, first: null };
      found.set(file.name, known);
      // Too old to keep, or too large to be one of ours: not read, and deleted
      // by age as any other.
      if (dayEnd(file) + maxAgeMs < at || info.size > readLimit) continue;
      let text: string;
      try {
        text = await fs.readRegular(full(file.name), readLimit);
      } catch {
        continue;
      }
      const records = recordsIn(text, at);
      const first = records[0];
      if (first) known.first = { at: recordAt(first), kind: first.kind };
      for (const record of records) {
        const recorded = recordAt(record);
        times.push(recorded);
        if (lastAt === null || recorded > lastAt) lastAt = recorded;
        if (record.kind === "event") events.set(record.event.id, record.event);
        else if (record.kind === "point") points.push(record.point);
        else if (record.kind === "start") starts.push(record.at);
      }
    }

    const eventList = newest(
      [...events.values()].sort((a, b) => a.at - b.at),
      limits.events,
    );
    points.sort((a, b) => a.at - b.at);
    const pointList = newest(
      points.filter((point, index) => point.at !== points[index - 1]?.at),
      limits.points,
    );
    return {
      history: {
        events: eventList,
        points: pointList,
        restarts: newest(restartsAmong(starts, times), MAX_RESTARTS),
        lastAt,
      },
      found,
      notFiles,
    };
  }

  /** The first record a file holds, when it can be read: where it begins the history. */
  async function firstRecordOf(name: string, size: number): Promise<Known["first"]> {
    if (size === 0 || size > readLimit) return null;
    try {
      const first = recordsIn(await fs.readRegular(full(name), readLimit), now())[0];
      return first ? { at: recordAt(first), kind: first.kind } : null;
    } catch {
      return null;
    }
  }

  /**
   * Looks at the folder again and takes the files as they are now: those
   * another copy has made, grown or deleted since this one last looked. A
   * file this copy has not read is read for its first record.
   */
  async function rescan(): Promise<void> {
    let names: string[];
    try {
      names = await fs.list(dir);
    } catch {
      return;
    }
    const there = new Set<string>();
    for (const name of names) {
      const file = readHistoryFileName(name);
      if (file?.version !== HISTORY_FORMAT_VERSION) continue;
      let info: Awaited<ReturnType<HistoryFs["lstat"]>>;
      try {
        info = await fs.lstat(full(name));
      } catch {
        continue;
      }
      if (info.kind !== "file") {
        blocked.add(name);
        continue;
      }
      there.add(name);
      blocked.delete(name);
      const known = files.get(name);
      if (known?.size === info.size) continue;
      // A file that shrank was deleted and made again.
      const fresh = known === undefined || known.first === null || info.size < known.size;
      const first = fresh ? await firstRecordOf(name, info.size) : known.first;
      files.set(name, { ...file, size: info.size, first });
    }
    for (const name of [...files.keys()]) {
      if (!there.has(name)) files.delete(name);
    }
  }

  /** Goes on in today's newest file, so what is written follows what the files hold. */
  function aimAtNewest(): void {
    const day = dayOf(now());
    let part = 0;
    for (const file of files.values()) {
      if (file.day === day && file.part > part) part = file.part;
    }
    target = part > 0 ? { day, part } : null;
  }

  /** Deletes what the age and the cap say must go before `incoming` bytes go to `writingTo`. */
  async function prune(writingTo: string | null, incoming: number): Promise<void> {
    const doomed = filesToDelete([...files.values()], writingTo, incoming, {
      now: now(),
      maxBytes,
      maxAgeMs,
    });
    for (const name of doomed) {
      try {
        await fs.remove(full(name));
      } catch {
        // It stays on disk, but is not counted again: it would only ever be
        // tried again, and the newest history would be let go in its place.
      }
      files.delete(name);
    }
  }

  /**
   * Writes lines to the day's file, going on in the next file of the day when
   * one is full. Said in two ways, for the beat and for the last write as
   * Agent Lookout stops, which cannot wait.
   */
  function* chunks(
    lines: readonly string[],
  ): Generator<{ name: string; text: string }, void, "written" | "blocked"> {
    const day = dayOf(now());
    let part = target?.day === day ? target.part : 1;
    let index = 0;
    while (index < lines.length && part <= MAX_PART) {
      const name = historyFileName(day, part);
      const known = files.get(name);
      const size = known?.size ?? 0;
      const lead = size > 0 && !touched.has(name) ? "\n" : "";
      const room = maxFileBytes - size - lead.length;
      const firstBytes = byteLength(lines[index] as string);
      if (blocked.has(name) || firstBytes > room) {
        part += 1;
        continue;
      }
      let text = lead;
      let bytes = lead.length;
      let end = index;
      while (end < lines.length) {
        const lineBytes = byteLength(lines[end] as string);
        if (bytes - lead.length + lineBytes > room) break;
        text += lines[end];
        bytes += lineBytes;
        end += 1;
      }
      const outcome = yield { name, text };
      if (outcome === "blocked") {
        blocked.add(name);
        part += 1;
        continue;
      }
      const record = parseRecord((lines[index] as string).trim());
      const parsed = readHistoryFileName(name) as HistoryFileName;
      files.set(name, {
        ...parsed,
        size: size + bytes,
        first: known?.first ?? (record && { at: recordAt(record), kind: record.kind }),
      });
      touched.add(name);
      target = { day, part };
      index = end;
    }
  }

  function wrote(): void {
    failing = null;
  }

  function writeFailed(): void {
    // A write that failed may have left part of a line behind.
    touched.clear();
    if (failing === null) {
      failing = `Agent Lookout could not write to its history folder, ${folder}, so new history is kept in memory until it can.`;
      warn(failing);
    }
  }

  async function writeLines(lines: readonly string[]): Promise<boolean> {
    if (lines.length === 0) return true;
    const steps = chunks(lines);
    let step = steps.next("written");
    while (!step.done) {
      const { name, text } = step.value;
      await prune(name, byteLength(text));
      try {
        await fs.append(full(name), text);
      } catch (error) {
        if (isNotOrdinary(error)) {
          step = steps.next("blocked");
          continue;
        }
        writeFailed();
        return false;
      }
      step = steps.next("written");
    }
    wrote();
    return true;
  }

  function writeLinesNow(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const steps = chunks(lines);
    let step = steps.next("written");
    while (!step.done) {
      const { name, text } = step.value;
      try {
        fs.appendNow(full(name), text);
      } catch (error) {
        if (isNotOrdinary(error)) {
          step = steps.next("blocked");
          continue;
        }
        return;
      }
      step = steps.next("written");
    }
  }

  /** What is waiting, with the start first when this copy has not written it yet. */
  function takeQueued(): string[] {
    const lines =
      startedAt === null ? queue : [encodeRecord({ kind: "start", at: startedAt }), ...queue];
    queue = [];
    startedAt = null;
    return lines;
  }

  /** Whether the files have been pruned since this copy began writing. */
  let pruned = false;
  /** The beat under way, so a slow one is never joined by the next. */
  let beating: Promise<void> | null = null;

  function beat(): Promise<void> {
    beating ??= writeBeat().finally(() => {
      beating = null;
    });
    return beating;
  }

  function writeBeat(): Promise<void> {
    return serially(async () => {
      if (!running || unusable !== null) return;
      const kept = lock.held && (await lock.keep());
      // A lock that is gone, or not held yet, is taken when nobody else holds it.
      const holds = kept || (running && (await lock.take()));
      if (!running) {
        // Stopped meanwhile. What was left has been written, and a lock taken
        // since goes with it.
        lock.releaseNow();
        return;
      }
      if (!holds) {
        // Another copy writes what it sees, which is what this one sees too.
        writer = false;
        queue = [];
        startedAt = null;
        // What that copy writes and deletes changes what the folder holds,
        // and where the history begins.
        await rescan();
        return;
      }
      if (!kept) {
        // Just taken: another copy may have made, grown or deleted files
        // since this one last looked, so it looks again before it writes.
        await rescan();
        touched.clear();
        aimAtNewest();
        pruned = false;
      }
      writer = true;
      if (!pruned) {
        pruned = true;
        // Whatever has aged out while nobody was writing goes now.
        await prune(null, 0);
      }
      await writeLines(takeQueued());
    }).catch(() => {});
  }

  return {
    async restore(limits) {
      const none: RestoredHistory = { events: [], points: [], restarts: [], lastAt: null };
      if (restored) return none;
      restored = true;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        deadline = setTimeout(() => resolve("late"), restoreDeadlineMs);
        deadline.unref?.();
      });
      const reading = serially(() => readAll(limits)).catch(
        () =>
          `Agent Lookout could not read its history folder, ${folder}, so this run keeps history in memory only.`,
      );
      const outcome = await Promise.race([reading, late]);
      clearTimeout(deadline);
      if (outcome === "late") {
        unusable = `Agent Lookout could not read its history folder, ${folder}, in time, so this run keeps history in memory only.`;
        warn(unusable);
        return none;
      }
      if (typeof outcome === "string") {
        unusable = outcome;
        warn(unusable);
        return none;
      }
      for (const [name, file] of outcome.found) files.set(name, file);
      for (const name of outcome.notFiles) blocked.add(name);
      aimAtNewest();
      return outcome.history;
    },
    start() {
      if (running) return;
      running = true;
      if (unusable !== null) return;
      // Decided at once, so that a stop that comes before the first beat still
      // writes what was added.
      writer = lock.takeNow();
      pruned = false;
      // Only the copy that writes says that watching started: another copy's
      // start is not one the files saw.
      startedAt = writer ? now() : null;
      void beat();
      timer = setInterval(() => void beat(), flushIntervalMs);
      // The keeper alone should not keep a process alive.
      timer.unref?.();
    },
    addEvents(events) {
      for (const event of events) hold({ kind: "event", event });
    },
    addPoint(point) {
      hold({ kind: "point", point });
    },
    async flush() {
      // A beat under way may have taken what it writes before the last was
      // added, so this one follows it.
      if (beating) await beating;
      await beat();
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      // Written only while the lock is still this copy's: another copy that
      // took it over meanwhile writes what it sees itself.
      if (writer === true && unusable === null && lock.stillHeldNow()) {
        writeLinesNow(takeQueued());
      }
      queue = [];
      startedAt = null;
      writer = null;
      lock.releaseNow();
    },
    clear(forget) {
      return serially(async (): Promise<ClearOutcome> => {
        if (unusable !== null || writer !== true || !lock.held) {
          return {
            ok: false,
            reason: "not-writing",
            error: "Another copy of Agent Lookout keeps the history, or it cannot be written here.",
          };
        }
        let names: string[];
        try {
          names = await fs.list(dir);
        } catch {
          return { ok: false, reason: "failed", error: "The history folder could not be read." };
        }
        let left = 0;
        // Every history file of this format goes. One of a later format is
        // left alone, as everything else is: this version cannot know what
        // it holds.
        for (const name of names) {
          if (readHistoryFileName(name)?.version !== HISTORY_FORMAT_VERSION) continue;
          try {
            const info = await fs.lstat(full(name));
            if (info.kind !== "file") continue;
            await fs.remove(full(name));
            files.delete(name);
          } catch {
            left += 1;
          }
        }
        // What the folder no longer holds is not counted, and what could not
        // be deleted still is, towards the cap and what the card says.
        const listed = new Set(names);
        for (const name of [...files.keys()]) {
          if (!listed.has(name)) files.delete(name);
        }
        touched.clear();
        aimAtNewest();
        if (left > 0) {
          return {
            ok: false,
            reason: "failed",
            error: `${left === 1 ? "One history file" : `${left} history files`} could not be deleted.`,
          };
        }
        const at = now();
        queue = [];
        startedAt = null;
        clearedAt = at;
        forget();
        await writeLines([encodeRecord({ kind: "cleared", at })]);
        return { ok: true, at };
      });
    },
    since() {
      const oldest = [...files.values()].sort(byFileOrder).find((file) => file.first !== null);
      if (!oldest?.first) return clearedAt === null ? null : { at: clearedAt, by: "cleared" };
      return { at: oldest.first.at, by: BEGINNING[oldest.first.kind] };
    },
    status() {
      let bytes = 0;
      for (const file of files.values()) bytes += file.size;
      let problem = unusable ?? failing;
      if (problem === null && writer === false) {
        problem = lock.heldByOtherSources
          ? "Another copy of Agent Lookout on this computer is writing the history, and it reads sessions from other folders than this one. This one keeps what it sees in memory, and takes over when that one stops."
          : "Another copy of Agent Lookout on this computer is writing the history. This one keeps what it sees in memory, and takes over when that one stops.";
      }
      return {
        where: "disk",
        folder,
        bytes,
        maxBytes,
        maxAgeMs,
        canClear: unusable === null && writer === true && lock.held,
        problem,
      };
    },
  };
}

/**
 * The stores in memory, with everything added to them also held to be
 * written. What is read is the store's own.
 */
export function keptEventStore(store: EventStore, keeper: HistoryKeeper): EventStore {
  return {
    add(events) {
      store.add(events);
      keeper.addEvents(events);
    },
    list: (options) => store.list(options),
    clear: () => store.clear(),
    get size() {
      return store.size;
    },
  };
}

export function keptHistoryStore(store: HistoryStore, keeper: HistoryKeeper): HistoryStore {
  return {
    add(point) {
      store.add(point);
      keeper.addPoint(point);
    },
    list: (windowMs, at) => store.list(windowMs, at),
    clear: () => store.clear(),
    get size() {
      return store.size;
    },
  };
}
