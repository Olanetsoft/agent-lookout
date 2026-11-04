import type { VibeCallback } from "../../../core/mapping/mistral-vibe/mistralVibeMapping.ts";
import { isRecord } from "./envelope.ts";

/**
 * Reading what Vibe has open from the person, an approval or a question, for
 * the little this adapter needs.
 *
 * Vibe calls either a callback. It journals one as it asks, `callback_registered`
 * with the kind `approval` or `user_input`, and once as it is settled,
 * `callback_resolved`, whether the person answered, declined or stopped the
 * turn (harness/.../vibe/_storage.py, `register_callback`, `resolve_callback`,
 * and _session.py, `_request_approval`, `_request_user_input` and
 * `_close_open_callbacks`, the same at 2.26.1 and 3.0.4). A save takes what is
 * open into the next generation's `runtime-state.json`, whose `callbacks` hold
 * every callback with its `state`, and its segment begins with no record of it.
 *
 * A record holds what the callback says: a tool's arguments and why it is
 * asked, a question, an answer. So nothing past its first keys is read. A
 * journal line is JSON with its keys sorted, and a callback's own keys, in
 * `routing`, are `callbackId` and `createdAt` before `detail`:
 *
 * `{"payload":{"callback_id":"…","kind":"…","routing":{"callbackId":"…","createdAt":N,"detail":{…}…`
 *
 * `{"payload":{"callback_id":"…","result":…`
 *
 * A `"` inside a JSON string is always escaped, so text can never read as
 * these. Of `runtime-state.json`, already read whole for the session's folder,
 * the same fields of a pending callback are kept, and nothing else of it.
 */

/** The most of a line's start looked at. A line can be 64 MiB. */
export const CALLBACK_HEAD_BYTES = 1024;

/** The longest callback id read. Vibe makes one from a tool call's id. */
const CALLBACK_ID_LENGTH = 256;

const REGISTERED =
  /^\{"payload":\{"callback_id":"([^"\\]{1,256})","kind":"([a-z_]{1,64})","routing":\{"callbackId":"[^"\\]{1,256}","createdAt":(\d{1,16})[,}]/;

const RESOLVED = /^\{"payload":\{"callback_id":"([^"\\]{1,256})",/;

/**
 * A string of its own, from a part of a line's first bytes. V8 keeps a part of
 * 13 characters or more as a slice of the whole string, so an id held on to
 * would keep alive the rest of those bytes, which can hold a tool's arguments,
 * a question or an answer.
 */
const copied = (part: string) => Buffer.from(part).toString();

/** What one journal line says of a callback. */
export type CallbackLine = { opened: VibeCallback } | { settled: string };

/** The callback a `callback_registered` line opens, from its first bytes. Null when they are not as Vibe writes them. */
export function openedBy(head: string): CallbackLine | null {
  const match = REGISTERED.exec(head);
  if (match === null) return null;
  const createdAt = Number(match[3]);
  if (!Number.isSafeInteger(createdAt)) return null;
  return {
    opened: { id: copied(match[1] as string), kind: copied(match[2] as string), createdAt },
  };
}

/** The callback a `callback_resolved` line settles, from its first bytes. Null when they are not as Vibe writes them. */
export function settledBy(head: string): CallbackLine | null {
  const match = RESOLVED.exec(head);
  return match === null ? null : { settled: copied(match[1] as string) };
}

/** What the lines of a segment read so far say of callbacks. */
export interface CallbackFold {
  /** Opened in those lines and not settled in them, by id. */
  open: Map<string, VibeCallback>;
  /** Settled in those lines with no opening in them: opened before the segment, or before the lines read. */
  settled: Set<string>;
  /** Whether those lines start at the segment's start, so that `settled` holds all it settled. */
  whole: boolean;
}

/** Nothing read yet. */
export function emptyFold(whole: boolean): CallbackFold {
  return { open: new Map(), settled: new Set(), whole };
}

/** Takes in one line, in the order Vibe wrote them. */
export function foldLine(fold: CallbackFold, line: CallbackLine): void {
  if ("opened" in line) fold.open.set(line.opened.id, line.opened);
  else if (!fold.open.delete(line.settled)) fold.settled.add(line.settled);
}

/**
 * The pending callbacks of a generation's `callbacks`, as `RuntimeCallbackV1`
 * lays them out. One that is not as Vibe writes it is left out.
 */
export function pendingCallbacks(callbacks: unknown): VibeCallback[] {
  if (!Array.isArray(callbacks)) return [];
  const pending: VibeCallback[] = [];
  for (const each of callbacks as unknown[]) {
    if (!isRecord(each) || each.state !== "pending" || !isRecord(each.routing)) continue;
    const { callback_id: id, kind } = each;
    const { createdAt } = each.routing;
    if (typeof id !== "string" || id === "" || id.length > CALLBACK_ID_LENGTH) continue;
    if (typeof kind !== "string" || kind === "" || kind.length > 64) continue;
    if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) continue;
    pending.push({ id, kind, createdAt });
  }
  return pending;
}

/**
 * What is open now: what the generation saved as pending and the segment since
 * has not settled, and what the segment opened. When its start was not read, a
 * saved callback may have been settled in what was not, so none is taken as open.
 */
export function openCallbacks(saved: readonly VibeCallback[], fold: CallbackFold): VibeCallback[] {
  const carried = fold.whole ? saved.filter((each) => !fold.settled.has(each.id)) : [];
  return [...carried.filter((each) => !fold.open.has(each.id)), ...fold.open.values()];
}
