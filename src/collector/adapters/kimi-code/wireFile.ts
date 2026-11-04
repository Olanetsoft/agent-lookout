import type { KimiCodeInteraction } from "../../../core/mapping/kimi-code/kimiCodeMapping.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { wireFilePath, wireFolderIsReal, type SessionPlace } from "./paths.ts";
import { isRecord } from "./sessionIndex.ts";

/**
 * Reading a session's event file for the approvals and questions left
 * unanswered, and nothing else. Built from Kimi Code's source at 2.4.1 and not
 * yet checked on a computer running it.
 *
 * `agents/main/wire.jsonl` is JSON Lines, one record per line, appended as the
 * session runs. It holds every prompt, reply, tool call and request to the model.
 * A line is `{"type":"<type>",<its fields>,"time":<Unix ms>}`, with `type` first
 * (`serialize` in `app/event/event2.ts`). Two types matter here
 * (`agent/interaction/interactionOps.ts`):
 *
 * `{"type":"interaction.request","agentId":…,"id":…,"kind":…,"toolCallId":…,"request":…,"time":…}`
 * `{"type":"interaction.resolved","agentId":…,"id":…,"response":…,"time":…}`
 *
 * `kind` is `approval`, `question` or `user_tool`, and only the first two wait for
 * the person: Kimi Code's own `resolvePendingInteraction` counts no other.
 *
 * So the reader:
 *
 * - is asked only while a process that runs holds the session's lock, and
 *   only when the file changed;
 * - reads at most the file's last 1 MiB, opened without following a link and
 *   only inside real folders. A wait is the file's newest line, or close to it,
 *   so a read this long finds it, and a line longer than that is not read;
 * - looks through those bytes for the start of a line of one of the two types,
 *   and turns no other line into text. A line of JSON has no line break inside
 *   it, so those bytes cannot be inside a prompt or a reply;
 * - parses only those lines, takes `id`, `kind` and `time` from each, and drops
 *   the rest with it. `request` and `response` hold what was asked and answered,
 *   and are never kept;
 * - leaves a last line with no line break yet for the next read, since Kimi Code
 *   is still writing it.
 *
 * Nothing here writes, renames, deletes or locks anything.
 */

/** The most of a file's end read at once. */
export const WIRE_TAIL_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

/** Where a line of either type begins. */
const INTERACTION_LINE = Buffer.from('\n{"type":"interaction.');

/** An id as Kimi Code makes one: `approval_<uuid>`, `question_<uuid>`, or `main:interaction-3`. */
const INTERACTION_ID = /^[A-Za-z0-9:._-]{1,128}$/;

/** What one line says of an interaction, or null for a line that is not one this reads. */
function lineOf(line: string): { opened: KimiCodeInteraction } | { closed: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { type, id, kind, time } = value;
  if (typeof id !== "string" || !INTERACTION_ID.test(id)) return null;
  if (type === "interaction.resolved") return { closed: id };
  if (type !== "interaction.request") return null;
  if (kind !== "approval" && kind !== "question") return null;
  if (typeof time !== "number" || !Number.isSafeInteger(time)) return null;
  return { opened: { id, kind, at: time } };
}

/**
 * The interactions the whole lines in `data` leave unanswered, oldest first. An
 * answer to one asked before `data` begins closes nothing, and the first bytes
 * of `data`, the file's first line or a line cut into, are not looked at.
 */
export function openInteractions(data: Buffer): KimiCodeInteraction[] {
  const open = new Map<string, KimiCodeInteraction>();
  let found = data.indexOf(INTERACTION_LINE);
  while (found !== -1) {
    const start = found + 1;
    const end = data.indexOf(NEWLINE, start);
    if (end === -1) break;
    const line = lineOf(data.toString("utf8", start, end));
    if (line !== null) {
      if ("closed" in line) open.delete(line.closed);
      else open.set(line.opened.id, line.opened);
    }
    found = data.indexOf(INTERACTION_LINE, end);
  }
  return [...open.values()];
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface WireReader {
  /**
   * What a session's event file leaves unanswered, given its `lstat`, read only
   * when that changed. When it cannot be read, what was read of it before stands.
   */
  read(place: SessionPlace, info: FileInfo): Promise<KimiCodeInteraction[]>;
  /** The `lstat` of a session's last read, or null with none remembered. */
  lastLook(sessionId: string): FileInfo | null;
  /** Forgets every session not in this set. */
  keepOnly(sessionIds: ReadonlySet<string>): void;
}

export function createWireReader(home: string, io: ReadOnlyIo): WireReader {
  const remembered = new Map<string, { info: FileInfo; open: KimiCodeInteraction[] }>();

  async function readEnd(place: SessionPlace): Promise<KimiCodeInteraction[]> {
    if (!(await wireFolderIsReal(home, place, io))) return [];
    const handle = await io.openRegular(wireFilePath(home, place));
    try {
      const { size } = handle.info;
      const from = Math.max(0, size - WIRE_TAIL_BYTES);
      const bytes = await handle.read(from, size - from);
      return openInteractions(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } finally {
      await handle.close();
    }
  }

  return {
    async read(place, info) {
      const known = remembered.get(place.id);
      if (known && sameFile(known.info, info)) return known.open;
      try {
        const open = await readEnd(place);
        remembered.set(place.id, { info, open });
        return open;
      } catch {
        // Unreadable this time: what was read before stands, and it is tried again next poll.
        return known?.open ?? [];
      }
    },
    lastLook(sessionId) {
      return remembered.get(sessionId)?.info ?? null;
    },
    keepOnly(sessionIds) {
      for (const sessionId of remembered.keys()) {
        if (!sessionIds.has(sessionId)) remembered.delete(sessionId);
      }
    },
  };
}
