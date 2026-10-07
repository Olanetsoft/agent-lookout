import path from "node:path";

import {
  addAgyLogLine,
  emptyAgyLogState,
  readAgyLogLine,
  type AgyLogState,
} from "../../../core/mapping/antigravityLog.ts";
import type { AgySessionProcess } from "../../../core/mapping/antigravityLiveness.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Reading each running agy program's own log, for the few lines that say what
 * the transcripts do not: the folder it works in, the conversation it has
 * open, and an approval it waits for (`antigravityLog.ts`).
 *
 * Each agy program writes its log to `<agy folder>/log/cli-YYYYMMDD_HHMMSS.log`,
 * named for the local time it started, a second or so after it did. A log is
 * read only when one agy program that runs a session, and no other, started
 * in the seconds before its name's time, so a log is tied to the program
 * running now that wrote it. The logs of programs that have ended are not read.
 *
 * Each line is matched against the few kinds used and dropped at once: nothing
 * else of it is kept. A log is read from its start, then only what was added.
 * Every read is bounded: a log longer than the limit is read from the limit's
 * length before its end, and the folder may then not be known.
 */

/** Where the logs are, in the agy folder. */
export const LOG_DIR = "log";

/** The most of a log read at once: on the first read, and of what was added since. */
export const LOG_LIMIT_BYTES = 4 * 1024 * 1024;

/** The longest line kept while its end is not yet written. A longer one is not used. */
const LINE_LIMIT_BYTES = 64 * 1024;

/** How long after a program starts its log may be named. Seen a second after, in agy 1.3.1. */
export const LOG_NAMED_WITHIN_MS = 10_000;

/** `cli-20261007_125834.log`: the local date and time the program started. */
const LOG_NAME = /^cli-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.log$/;

const NEWLINE = 0x0a;

/** The local time a log's name gives, in epoch milliseconds, or null for any other name. */
export function logStartOf(name: string): number | null {
  const match = LOG_NAME.exec(name);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const at = new Date(year, month - 1, day, hour, minute, second);
  if (at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour) return null;
  return at.getTime();
}

/**
 * Which log each program wrote: the one named in the seconds after it
 * started. A log two programs could have written, or a program two logs could
 * be, is left out, so a log is never taken for another program's.
 */
export function matchLogs(
  processes: readonly AgySessionProcess[],
  logs: ReadonlyMap<string, number>,
): (string | null)[] {
  const candidates = (startedAt: number | null) =>
    startedAt === null
      ? []
      : [...logs].filter(([, at]) => at >= startedAt && at - startedAt <= LOG_NAMED_WITHIN_MS);
  const owners = new Map<string, number>();
  for (const { startedAt } of processes) {
    for (const [name] of candidates(startedAt)) owners.set(name, (owners.get(name) ?? 0) + 1);
  }
  return processes.map(({ startedAt }) => {
    const found = candidates(startedAt);
    if (found.length !== 1) return null;
    const [name] = found[0];
    return owners.get(name) === 1 ? name : null;
  });
}

interface Cursor {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Where the bytes read so far end. */
  offset: number;
  /** The bytes after the last newline, not yet a whole line. */
  pending: Buffer;
  state: AgyLogState;
}

export interface AgyLogReader {
  /**
   * What the log of each of these programs says, in the same order, or null
   * for a program whose log is not known or could not be read. Never throws.
   */
  read(processes: readonly AgySessionProcess[]): Promise<(AgyLogState | null)[]>;
}

export function createAgyLogReader(options: { home: string; io: ReadOnlyIo }): AgyLogReader {
  const { io } = options;
  const logDir = path.join(options.home, LOG_DIR);
  const cursors = new Map<string, Cursor>();
  /** The logs by name and start, from the last listing. */
  let listed = new Map<string, number>();
  /** The programs the last listing was made for, by their start. */
  let listedFor = "";

  async function list(processes: readonly AgySessionProcess[]): Promise<void> {
    const key = processes.map((p) => p.startedAt ?? "?").join(",");
    // A program's log can be named a moment after `ps` first shows it, so the
    // folder is listed again while some program has none.
    if (key === listedFor && matchLogs(processes, listed).every((name) => name !== null)) return;
    listedFor = key;
    let names: string[];
    try {
      names = await io.readdir(logDir);
    } catch (error) {
      if (!isMissing(error)) listedFor = "";
      listed = new Map();
      return;
    }
    const next = new Map<string, number>();
    for (const name of names) {
      const at = logStartOf(name);
      if (at !== null) next.set(name, at);
    }
    listed = next;
  }

  function addLines(cursor: Cursor, data: Buffer): void {
    const buffer = cursor.pending.byteLength > 0 ? Buffer.concat([cursor.pending, data]) : data;
    let start = 0;
    let newline = buffer.indexOf(NEWLINE);
    while (newline !== -1) {
      const line = readAgyLogLine(buffer.toString("utf8", start, newline));
      if (line !== null) addAgyLogLine(cursor.state, line);
      start = newline + 1;
      newline = buffer.indexOf(NEWLINE, start);
    }
    const rest = buffer.subarray(start);
    // A line too long to be one of those used is dropped, up to its newline.
    cursor.pending = rest.byteLength > LINE_LIMIT_BYTES ? Buffer.alloc(0) : Buffer.from(rest);
  }

  async function readLog(file: string, info: FileInfo): Promise<AgyLogState> {
    const known = cursors.get(file);
    if (
      known &&
      known.ino === info.ino &&
      known.size === info.size &&
      known.mtimeMs === info.mtimeMs
    ) {
      return known.state;
    }
    const handle = await io.openRegular(file);
    try {
      const opened = handle.info;
      const onward = known !== undefined && known.ino === opened.ino && opened.size >= known.offset;
      const cursor: Cursor = onward
        ? { ...known, state: known.state }
        : {
            ino: opened.ino,
            size: 0,
            mtimeMs: 0,
            offset: 0,
            pending: Buffer.alloc(0),
            state: emptyAgyLogState(),
          };
      let from = cursor.offset;
      if (opened.size - from > LOG_LIMIT_BYTES) {
        // Too much to read at once: only the end, from a line's start. What
        // was asked before then is no longer known.
        from = opened.size - LOG_LIMIT_BYTES;
        cursor.state.ask = null;
        cursor.pending = Buffer.alloc(0);
        const data = Buffer.from(await handle.read(from, opened.size - from));
        const first = data.indexOf(NEWLINE);
        addLines(cursor, first === -1 ? Buffer.alloc(0) : data.subarray(first + 1));
        if (first === -1) cursor.pending = Buffer.alloc(0);
      } else if (opened.size > from) {
        addLines(cursor, Buffer.from(await handle.read(from, opened.size - from)));
      }
      cursor.offset = opened.size;
      cursor.size = opened.size;
      cursor.mtimeMs = opened.mtimeMs;
      cursor.ino = opened.ino;
      cursors.set(file, cursor);
      return cursor.state;
    } finally {
      await handle.close();
    }
  }

  async function read(processes: readonly AgySessionProcess[]): Promise<(AgyLogState | null)[]> {
    if (processes.length === 0) {
      cursors.clear();
      return [];
    }
    await list(processes);
    const names = matchLogs(processes, listed);
    const kept = new Set<string>();
    const states: (AgyLogState | null)[] = [];
    for (const name of names) {
      if (name === null) {
        states.push(null);
        continue;
      }
      const file = path.join(logDir, name);
      kept.add(file);
      try {
        const info = await io.lstat(file);
        states.push(info.kind === "file" ? await readLog(file, info) : null);
      } catch {
        states.push(null);
      }
    }
    for (const file of cursors.keys()) {
      if (!kept.has(file)) cursors.delete(file);
    }
    return states;
  }

  return {
    async read(processes) {
      try {
        return await read(processes);
      } catch {
        return processes.map(() => null);
      }
    },
  };
}
