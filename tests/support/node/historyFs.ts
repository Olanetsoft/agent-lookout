// A history folder held in memory, for the unit tests of the history keeper
// and its lock: what `src/collector/history/historyFiles.ts` does to the real
// file system, done to a map. It writes down every change it is asked to make.

import path from "node:path/posix";

import type { HistoryFs } from "@collector/history/historyFiles";
import { asWritten } from "@tests/support/paths";

/** What is at a path: an ordinary file with its text, or something that is not one. */
export interface FakeEntry {
  kind: "file" | "link" | "folder" | "pipe";
  text: string;
  mtimeMs: number;
}

export interface FakeHistoryFs extends HistoryFs {
  /** Everything there is, by full path. */
  entries: Map<string, FakeEntry>;
  /** The folders that were made, by full path. */
  folders: Set<string>;
  /** Each change, as `append <name>`, `create <name>`, `remove <name>` and so on, by file name. */
  changes: string[];
  /** Puts an ordinary file, or something else, at a path. */
  put(file: string, text: string, kind?: FakeEntry["kind"]): void;
  /** The text of an ordinary file, or undefined when there is none at that path. */
  text(file: string): string | undefined;
  /** Set to make every write and every listing fail, as a full disk or a folder gone would. */
  broken: boolean;
}

function failure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** A folder held in memory. `now` is when a file is said to have been written. */
export function fakeHistoryFs(now: () => number = Date.now): FakeHistoryFs {
  const entries = new Map<string, FakeEntry>();
  const folders = new Set<string>();
  const changes: string[] = [];

  // Each path is taken as the tests write it, whatever system joined it.
  const fs: FakeHistoryFs = {
    entries,
    folders,
    changes,
    broken: false,
    put(given, text, kind = "file") {
      const file = asWritten(given);
      folders.add(path.dirname(file));
      entries.set(file, { kind, text, mtimeMs: now() });
    },
    text(file) {
      const entry = entries.get(asWritten(file));
      return entry?.kind === "file" ? entry.text : undefined;
    },
    async makeFolder(given) {
      const dir = asWritten(given);
      if (fs.broken) throw failure("EACCES", "Permission denied.");
      folders.add(dir);
      changes.push(`make ${dir}`);
    },
    async list(given) {
      const dir = asWritten(given);
      if (fs.broken || !folders.has(dir)) throw failure("ENOENT", "No such folder.");
      return [...entries.keys()]
        .filter((file) => path.dirname(file) === dir)
        .map((file) => path.basename(file));
    },
    async lstat(file) {
      return fs.lstatNow(file);
    },
    lstatNow(file) {
      const entry = entries.get(asWritten(file));
      if (!entry) throw failure("ENOENT", "No such file.");
      return {
        kind: entry.kind === "file" ? "file" : "other",
        size: Buffer.byteLength(entry.text),
        mtimeMs: entry.mtimeMs,
      };
    },
    async readRegular(file, maxBytes) {
      return fs.readRegularNow(file, maxBytes);
    },
    readRegularNow(file, maxBytes) {
      const entry = entries.get(asWritten(file));
      if (!entry) throw failure("ENOENT", "No such file.");
      if (entry.kind === "link") throw failure("ELOOP", "A link.");
      if (entry.kind !== "file") throw new Error("Not an ordinary file.");
      if (Buffer.byteLength(entry.text) > maxBytes) throw new Error("Too large.");
      return entry.text;
    },
    async append(file, text) {
      fs.appendNow(file, text);
    },
    appendNow(given, text) {
      const file = asWritten(given);
      if (fs.broken) throw failure("ENOSPC", "No space left.");
      const entry = entries.get(file);
      if (entry?.kind === "link") throw failure("ELOOP", "A link.");
      if (entry && entry.kind !== "file") throw new Error("Not an ordinary file.");
      entries.set(file, { kind: "file", text: (entry?.text ?? "") + text, mtimeMs: now() });
      changes.push(`append ${path.basename(file)}`);
    },
    async create(file, text) {
      fs.createNow(file, text);
    },
    createNow(given, text) {
      const file = asWritten(given);
      if (fs.broken) throw failure("ENOSPC", "No space left.");
      if (entries.has(file)) throw failure("EEXIST", "Already there.");
      entries.set(file, { kind: "file", text, mtimeMs: now() });
      changes.push(`create ${path.basename(file)}`);
    },
    async touch(file, at) {
      const entry = entries.get(asWritten(file));
      if (!entry) throw failure("ENOENT", "No such file.");
      entry.mtimeMs = at;
    },
    async remove(file) {
      fs.removeNow(file);
    },
    removeNow(given) {
      const file = asWritten(given);
      if (fs.broken) throw failure("EACCES", "Permission denied.");
      if (entries.delete(file)) changes.push(`remove ${path.basename(file)}`);
    },
  };
  return fs;
}
