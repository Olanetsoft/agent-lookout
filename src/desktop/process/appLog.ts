// The app's own log, where what would otherwise be lost is written down: an
// error in the main process, a startup that failed, and the collector's own
// warnings, such as an email or webhook setting that is wrong. A packaged app
// has no terminal to print them in.
//
// It is one file, `main.log`, in the folder macOS keeps each app's logs in,
// `~/Library/Logs/Agent Lookout/`. It stays on this machine. When it grows past
// half a megabyte it is moved to `main.old.log`, over the one before, and a new
// one is begun, so the two together never hold much more than a megabyte.
//
// It imports nothing from Electron, so it is tested in plain Node.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

/** The log's name in the app's folder of logs. */
export const LOG_FILE = "main.log";

/** Where the log is moved when it grows too long. */
export const OLD_LOG_FILE = "main.old.log";

/** How long the log may grow before it is moved aside. */
export const MAX_LOG_BYTES = 512 * 1024;

/** Writes one entry. It never throws. */
export type AppLog = (text: string) => void;

export interface AppLogOptions {
  /**
   * The folder the log goes in. It is asked for on each write, so that a
   * folder that cannot be known yet, before the app is ready, only drops that
   * one entry.
   */
  dir: () => string;
  /** Also told each entry, as a development run prints it. */
  echo?: (text: string) => void;
  now?: () => number;
}

/** What an error says, with where it was thrown when that is known. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

/** One entry as the log holds it: the time, then the text, its later lines indented. */
export function logEntry(text: string, at: number): string {
  const body = text.trimEnd().replace(/\r?\n/g, "\n    ");
  return `${new Date(at).toISOString()} ${body}\n`;
}

/** The app's log, written to the folder `dir` names. */
export function createAppLog(options: AppLogOptions): AppLog {
  const now = options.now ?? Date.now;
  return (text) => {
    try {
      options.echo?.(text);
    } catch {
      // Printing is a convenience. The file is the record.
    }
    try {
      const dir = options.dir();
      const file = path.join(dir, LOG_FILE);
      mkdirSync(dir, { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // There is no log yet.
      }
      if (size >= MAX_LOG_BYTES) renameSync(file, path.join(dir, OLD_LOG_FILE));
      appendFileSync(file, logEntry(text, now()), { encoding: "utf8", mode: 0o600 });
    } catch {
      // Not written down. There is nowhere else to say so.
    }
  };
}
