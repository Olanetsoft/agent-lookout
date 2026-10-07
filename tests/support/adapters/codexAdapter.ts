// The Codex adapter, cut off from this machine, for the tests that share it: a
// file system held in memory that counts every call, a clock the test moves by
// hand, and a way to run code in another time zone. Nothing here touches a real
// file.
//
// The stand-in has two sides. `io` is what the adapter is given, and it has
// only the four reading methods of `ReadOnlyIo`. Everything that changes the files
// is on the other side, for the test alone.

import nativePath from "node:path";
// The stand-in keeps paths as the tests write them, `/` between their names.
import path from "node:path/posix";

import {
  createCodexAdapter,
  NEEDS_YOU_NOTE,
  type CodexAdapterOptions,
} from "@collector/adapters/codex/index";
import type { ReadOnlyIo, FileInfo, OpenFile } from "@collector/files/readOnlyIo";
import { HOME, NOW } from "@tests/fixtures/codex";
import { asWritten } from "@tests/support/paths";

export type IoMethod = keyof ReadOnlyIo;

export interface IoCall {
  method: IoMethod;
  path: string;
}

interface Entry {
  /** `other` stands for a link, a pipe or a device. */
  kind: "file" | "other";
  data: Uint8Array;
  mtimeMs: number;
  ino: number;
}

function errno(code: string, target: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: ${target}`);
  error.code = code;
  return error;
}

const encoder = new TextEncoder();
const bytesOf = (content: string | Uint8Array) =>
  typeof content === "string" ? encoder.encode(content) : content;

export interface WriteOptions {
  /** Defaults to the clock the files were made with. */
  mtimeMs?: number;
}

/**
 * A file system in memory. Folders exist when something is written in them or
 * when `mkdir` names them. Every call the adapter makes is recorded in `calls`,
 * and every byte range it reads in `reads`.
 */
export function memoryFiles(clock: () => number = () => NOW) {
  const entries = new Map<string, Entry>();
  const folders = new Set<string>();
  /** Paths that refuse every call, with the error code they give. */
  const failing = new Map<string, string>();
  let failEverything: string | null = null;
  const calls: IoCall[] = [];
  const reads: { path: string; position: number; length: number }[] = [];
  let nextIno = 1;
  let openHandles = 0;

  function addFolders(target: string) {
    let dir = path.dirname(target);
    while (!folders.has(dir) && dir !== path.dirname(dir)) {
      folders.add(dir);
      dir = path.dirname(dir);
    }
  }

  function check(method: IoMethod, target: string) {
    calls.push({ method, path: target });
    if (failEverything) throw errno(failEverything, target);
    const code = failing.get(target);
    if (code) throw errno(code, target);
  }

  function infoOf(entry: Entry): FileInfo {
    return {
      kind: entry.kind,
      size: entry.data.byteLength,
      mtimeMs: entry.mtimeMs,
      ino: entry.ino,
    };
  }

  function info(target: string): FileInfo {
    const entry = entries.get(target);
    if (entry) return infoOf(entry);
    if (folders.has(target)) return { kind: "directory", size: 0, mtimeMs: 0, ino: 0 };
    throw errno("ENOENT", target);
  }

  // Each path is taken as the tests write it, whatever system joined it.
  const io: ReadOnlyIo = {
    async readdir(given) {
      const dir = asWritten(given);
      check("readdir", dir);
      if (entries.has(dir)) throw errno("ENOTDIR", dir);
      if (!folders.has(dir)) throw errno("ENOENT", dir);
      const names = new Set<string>();
      for (const child of [...entries.keys(), ...folders]) {
        if (path.dirname(child) === dir) names.add(path.basename(child));
      }
      return [...names];
    },
    async stat(given) {
      const target = asWritten(given);
      check("stat", target);
      return info(target);
    },
    async lstat(given) {
      const target = asWritten(given);
      check("lstat", target);
      return info(target);
    },
    async openRegular(given): Promise<OpenFile> {
      const file = asWritten(given);
      check("openRegular", file);
      if (folders.has(file)) throw errno("EISDIR", file);
      const entry = entries.get(file);
      if (!entry) throw errno("ENOENT", file);
      if (entry.kind !== "file") throw errno("ELOOP", file);
      openHandles += 1;
      let open = true;
      return {
        info: infoOf(entry),
        async read(position, length) {
          if (!open) throw new Error("Read after close.");
          reads.push({ path: file, position, length });
          // The open file follows what is written to it, as a real one does.
          return entry.data.slice(position, position + Math.max(0, length));
        },
        async close() {
          if (open) openHandles -= 1;
          open = false;
        },
      };
    },
  };

  return {
    io,
    calls,
    reads,
    /** Writes a new file in place of anything at that path: a new file, so a new identity. */
    write(given: string, content: string | Uint8Array, options: WriteOptions = {}) {
      const target = asWritten(given);
      addFolders(target);
      entries.set(target, {
        kind: "file",
        data: bytesOf(content),
        mtimeMs: options.mtimeMs ?? clock(),
        ino: nextIno++,
      });
    },
    /** Adds to the end of a file, as Codex adds lines. The file keeps its identity. */
    append(given: string, content: string | Uint8Array, options: WriteOptions = {}) {
      const target = asWritten(given);
      const entry = entries.get(target);
      if (!entry) throw new Error(`No file at ${target}.`);
      const added = bytesOf(content);
      const data = new Uint8Array(entry.data.byteLength + added.byteLength);
      data.set(entry.data);
      data.set(added, entry.data.byteLength);
      entry.data = data;
      entry.mtimeMs = options.mtimeMs ?? clock();
    },
    /** Replaces a file's content in place: the same file, so the same identity. */
    rewrite(given: string, content: string | Uint8Array, options: WriteOptions = {}) {
      const target = asWritten(given);
      const entry = entries.get(target);
      if (!entry) throw new Error(`No file at ${target}.`);
      entry.data = bytesOf(content);
      entry.mtimeMs = options.mtimeMs ?? clock();
    },
    /** Something that is not an ordinary file, such as a link or a pipe, under this name. */
    special(given: string) {
      const target = asWritten(given);
      addFolders(target);
      entries.set(target, {
        kind: "other",
        data: new Uint8Array(),
        mtimeMs: clock(),
        ino: nextIno++,
      });
    },
    mkdir(target: string) {
      addFolders(path.join(asWritten(target), "x"));
    },
    /** Removes a file, or a folder and everything in it. */
    remove(given: string) {
      const target = asWritten(given);
      for (const key of [...entries.keys()]) {
        if (key === target || key.startsWith(`${target}/`)) entries.delete(key);
      }
      for (const key of [...folders]) {
        if (key === target || key.startsWith(`${target}/`)) folders.delete(key);
      }
    },
    /** Every call on this path fails with this code until `heal`. */
    fail(target: string, code = "EACCES") {
      failing.set(asWritten(target), code);
    },
    heal(target: string) {
      failing.delete(asWritten(target));
    },
    /** Every call on any path fails with this code, or works again with null. */
    failAll(code: string | null) {
      failEverything = code;
    },
    /** Forgets the calls and reads recorded so far. */
    forget() {
      calls.length = 0;
      reads.length = 0;
    },
    /** The calls of this kind, or of any kind. */
    count(method?: IoMethod, test: (target: string) => boolean = () => true) {
      return calls.filter((call) => (!method || call.method === method) && test(call.path)).length;
    },
    /** The paths opened, in order. */
    opened() {
      return calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    },
    /** How many opened files have not been closed. */
    openHandles: () => openHandles,
  };
}

export type MemoryFiles = ReturnType<typeof memoryFiles>;

/** A clock a test moves by hand, starting at the fixture's `NOW`. */
export function handClock(start = NOW) {
  let at = start;
  return {
    now: () => at,
    set(ms: number) {
      at = ms;
    },
    advance(ms: number) {
      at += ms;
    },
  };
}

/**
 * An adapter that reads only the stand-in files. With nothing in `env` it looks
 * in `~/.codex`, which is `CODEX_HOME` from the fixtures.
 */
export function codexAdapterFor(files: MemoryFiles, options: CodexAdapterOptions = {}) {
  return createCodexAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    ...options,
  });
}

/**
 * A path in a folder as the adapter shows it: under the home folder with `/`,
 * as `~/.codex/sessions`, and anywhere else as this system writes it.
 */
const shownIn = (home: string, name: string) =>
  home.startsWith("~") ? `${home}/${name}` : nativePath.join(home, name);

/** The four facts, in the order the adapter gives them, for a Codex folder written as people see it. */
export function watching(home: string, read: string) {
  return [
    { label: "Sessions folder", value: shownIn(home, "sessions") },
    { label: "Read", value: read },
    { label: "Open-sessions folder", value: shownIn(home, "thread-writer-locks") },
    { label: "Names file", value: shownIn(home, "session_index.jsonl") },
  ];
}

/** What a healthy poll says, for a sessions folder written as people see it. */
export const healthy = (sessions = "~/.codex/sessions") =>
  `Sessions are read from the files Codex saves in ${sessions}. ${NEEDS_YOU_NOTE}`;

/** The sentence added when this Codex keeps no list of open sessions. */
export const noLockFolder = (locks = "~/.codex/thread-writer-locks") =>
  ` There is no list of open sessions at ${locks}, which Codex keeps from version 0.155 on, so a session that has ended cannot be told from one that is idle, and none is shown as finished.`;

/**
 * Runs `run` with the process in this time zone, and puts the zone back
 * afterwards. Node on Windows keeps the zone it was last given when `TZ` is
 * deleted, so the zone in force before is set again first.
 */
export async function inTimeZone<T>(zone: string, run: () => T | Promise<T>): Promise<T> {
  const before = process.env.TZ;
  const zoneBefore = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  try {
    return await run();
  } finally {
    process.env.TZ = before ?? zoneBefore;
    if (before === undefined) delete process.env.TZ;
  }
}
