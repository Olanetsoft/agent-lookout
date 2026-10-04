import { isMissing, type CodexIo } from "./io.ts";

/**
 * The names people give Codex sessions, from `<codex home>/session_index.jsonl`.
 *
 * Each line is `{"id":"<thread id>","thread_name":"<name>","updated_at":"<time>"}`.
 * Codex appends a line whenever a session is named or renamed, and the newest
 * line for an id wins (codex-rs/rollout/src/session_index.rs). It rewrites the
 * file only to remove a session's names. Only `id` and `thread_name` are kept.
 */
export const SESSION_INDEX_FILE = "session_index.jsonl";

/**
 * The most of the file that is read. The newest names are at the end, so a
 * larger file is read from this far before its end.
 */
export const SESSION_INDEX_LIMIT_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Session names by thread id, in lowercase. A later line wins over an earlier
 * one for the same id. A line that is malformed, or has no id or no name, is
 * skipped.
 */
export function parseSessionIndex(content: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const { id, thread_name: name } = value;
    if (typeof id !== "string" || id === "" || typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed === "") continue;
    names.set(id.toLowerCase(), trimmed);
  }
  return names;
}

export interface SessionIndexReader {
  /** The names as the file holds them now. The file is read only when it has changed. Never throws. */
  names(): Promise<Map<string, string>>;
}

export function createSessionIndexReader(file: string, io: CodexIo): SessionIndexReader {
  let seen: { ino: number; size: number; mtimeMs: number } | null = null;
  let names = new Map<string, string>();

  async function readNames(): Promise<Map<string, string>> {
    const handle = await io.openRegular(file);
    try {
      const { size } = handle.info;
      const from = Math.max(0, size - SESSION_INDEX_LIMIT_BYTES);
      const data = await handle.read(from, size - from);
      let content = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
      // Started part-way through the file: the first line is a piece of one.
      if (from > 0) content = content.slice(content.indexOf("\n") + 1);
      seen = { ino: handle.info.ino, size, mtimeMs: handle.info.mtimeMs };
      return parseSessionIndex(content);
    } finally {
      await handle.close();
    }
  }

  return {
    async names() {
      try {
        const info = await io.lstat(file);
        if (info.kind !== "file") {
          seen = null;
          names = new Map();
          return names;
        }
        if (
          seen &&
          seen.ino === info.ino &&
          seen.size === info.size &&
          seen.mtimeMs === info.mtimeMs
        ) {
          return names;
        }
        names = await readNames();
      } catch (error) {
        // No file means no names yet. A file that cannot be read keeps the
        // names it gave last time, and is tried again on the next poll.
        if (isMissing(error)) {
          seen = null;
          names = new Map();
        }
      }
      return names;
    },
  };
}
