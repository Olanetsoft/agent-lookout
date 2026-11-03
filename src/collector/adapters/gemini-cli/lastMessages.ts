import type { LastMessageResponse } from "../../../core/api.ts";
import { messageText } from "../../../core/text.ts";
import type { ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { createTailReader, type TailLimits, type TailReader } from "../../messages/tailReader.ts";

/**
 * What a Gemini CLI session last said, read from the end of its own session
 * file, the one the adapter listed the session from, when the route asks for
 * it.
 *
 * The session file is JSON Lines, written by `chatRecordingService.ts`. These
 * notes are from Gemini CLI's source at v0.64.0, not yet checked on a machine
 * running it:
 *
 * - A message is a line with a string `id` and no `$patch`. Its `type` is
 *   `user`, `gemini`, `info`, `warning` or `error`. The model's reply is a
 *   `gemini` message, and what it says is its `content`: a string, or a list
 *   of parts, or one part. A part with `text` is what the reply says, unless
 *   it is marked `thought`, the model's thinking. A part with a
 *   `functionCall` calls a tool, and says nothing. The reply's `thoughts`
 *   and `toolCalls`, with the tools' results, are fields of their own.
 * - A line with the id of a message in the list replaces it where it stands.
 *   Gemini CLI writes one only for the newest message, as it adds the reply's
 *   token counts or its tool calls (`recordMessageTokens`,
 *   `recordToolCalls`). Every other message line has an id not in the list,
 *   and is added at the end.
 * - `{"$rewindTo":"<id>"}` drops that message and every one after it, or
 *   every message when no message has that id.
 * - `{"$patch":{…}}` replaces the content of the message its `id` names,
 *   then of each one in `updates`, removes the ids in `removeIds`, then
 *   moves the ids in `orderIds` to the end, in that order.
 * - `{"$set":{…}}` with `messages` replaces every message, as Gemini CLI
 *   0.44 to 0.63 wrote it. A header, a line with a string `sessionId` and
 *   `projectHash`, adds any `messages` it holds.
 * - A subagent writes to a file of its own, in a folder of the session's,
 *   which is never read here. What it found reaches this file only as a
 *   tool's result.
 *
 * So the lines read are replayed by those rules, in the order Gemini CLI's
 * own reader tries them (`createJsonlRecordAccumulator`), and the text is
 * that of the newest `gemini` message left whose content has text that is not
 * a thought: those parts' text, joined with nothing between, as Gemini CLI
 * joins them. A reply that only calls tools, or only thinks, is passed over
 * for the one before it. A prompt, a thought, a tool's call, a tool's output
 * and an `info`, `warning` or `error` line are never taken. Each line is
 * judged by its own fields, so a reply's line quoted inside a prompt is part
 * of a string there, and is never taken for one. A line that does not parse,
 * or is none of these, is passed over, as Gemini CLI passes it over.
 *
 * The end that is read can begin after the message a `$rewindTo` or a
 * `$patch` names. Then what that line did is known only in part, and the text
 * is the newest reply only when it surely still stands:
 *
 * - Messages from before the end are always first in the list, as they were
 *   written first and a `$patch` moves only the ids it names.
 * - A `$rewindTo` to an id the end does not hold drops every message the end
 *   holds: the message is before them all, or nowhere.
 * - A `$patch` that moves an id the end does not hold puts there a message
 *   that may or may not be in the list, and whose type is not known. Only a
 *   reply after it can be the newest. A `$rewindTo` to it drops every message
 *   the end holds, and a line of its id every one but that line's.
 * - When no reply the end holds comes after every message it does not, the
 *   newest reply cannot be told, and there is no text.
 */

/** What goes between the text parts of one reply: nothing, as Gemini CLI joins them. */
const PART_BREAK = "";

/** One message, in the list as the end of the file replays it. */
type Entry =
  /** A message whose own line is in the end: the text of its reply, or null when it is not a reply with text. */
  | { seen: true; gemini: boolean; reply: string | null }
  /** A message from before the end that a `$patch` moved here, if there is one of that id at all. */
  | { seen: false };

interface Replay {
  /** Whether the list can hold messages from before the end, which are always first in it. */
  before: boolean;
  /** The messages after those, in Gemini CLI's order, by id. */
  entries: Map<string, Entry>;
}

/** An object, as Gemini CLI's reader takes one: a list among them, whose fields are then never there. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A message, as Gemini CLI's reader tells one: a string `id` and no `$patch`. */
function isMessage(value: unknown): value is Record<string, unknown> & { id: string } {
  return isObject(value) && typeof value.id === "string" && !("$patch" in value);
}

/** A header, as Gemini CLI's reader tells one: a string `sessionId` and `projectHash`. */
function isHeader(value: Record<string, unknown>): boolean {
  return typeof value.sessionId === "string" && typeof value.projectHash === "string";
}

/** What a part says: its text, unless it is a thought, a tool's call or its result. */
function textOfPart(part: unknown): string | null {
  // Gemini CLI takes a string among the parts for a part of that text.
  if (typeof part === "string") return part;
  if (!isObject(part) || Array.isArray(part) || typeof part.text !== "string") return null;
  if (part.thought !== undefined && part.thought !== false) return null;
  if ("functionCall" in part || "functionResponse" in part) return null;
  return part.text;
}

/** The reply's text, from its content, or null when the content holds none. */
export function replyTextOf(content: unknown): string | null {
  const parts = Array.isArray(content) ? content : [content];
  const texts: string[] = [];
  for (const part of parts) {
    const text = textOfPart(part);
    if (text !== null) texts.push(text);
  }
  const text = texts.join(PART_BREAK);
  return text.trim() === "" ? null : text;
}

/** Adds a message, or replaces the one of its id where it stands. */
function put(replay: Replay, message: Record<string, unknown> & { id: string }): void {
  const gemini = message.type === "gemini";
  const entry: Entry = { seen: true, gemini, reply: gemini ? replyTextOf(message.content) : null };
  if (replay.entries.get(message.id)?.seen === false) {
    // It stands where a message from before the end was moved, if that one is
    // there, and otherwise comes last. Either way, what the end holds before
    // it may not be before it.
    replay.entries.clear();
    replay.before = true;
  }
  replay.entries.set(message.id, entry);
}

function rewind(replay: Replay, id: string): void {
  const held = replay.entries.get(id);
  if (held === undefined || !held.seen) {
    // Before every message the end holds, or nowhere, which drops them all.
    replay.entries.clear();
    return;
  }
  let found = false;
  for (const key of [...replay.entries.keys()]) {
    if (key === id) found = true;
    if (found) replay.entries.delete(key);
  }
}

function patch(replay: Replay, change: Record<string, unknown>): void {
  const update = (value: unknown) => {
    if (!isObject(value) || typeof value.id !== "string" || !("content" in value)) return;
    const held = replay.entries.get(value.id);
    if (held?.seen) held.reply = held.gemini ? replyTextOf(value.content) : null;
  };
  // In Gemini CLI's order: the message named at the top, then `updates`, `removeIds` and `orderIds`.
  update(change);
  if (Array.isArray(change.updates)) for (const value of change.updates) update(value);
  if (Array.isArray(change.removeIds)) {
    for (const id of change.removeIds) if (typeof id === "string") replay.entries.delete(id);
  }
  if (Array.isArray(change.orderIds)) {
    const moved = new Map<string, Entry>();
    for (const id of change.orderIds) {
      if (typeof id !== "string" || moved.has(id)) continue;
      const held = replay.entries.get(id);
      if (held !== undefined) moved.set(id, held);
      // One the end does not hold may be among those from before it.
      else if (replay.before) moved.set(id, { seen: false });
    }
    const order = new Map<string, Entry>();
    for (const [id, entry] of replay.entries) if (!moved.has(id)) order.set(id, entry);
    for (const [id, entry] of moved) order.set(id, entry);
    replay.entries = order;
  }
}

/** Moves the replay on by one line, as Gemini CLI's own reader does. */
function apply(replay: Replay, line: string): void {
  if (line.trim() === "") return;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(record)) return;
  if (typeof record.$rewindTo === "string") {
    rewind(replay, record.$rewindTo);
  } else if (isObject(record.$patch)) {
    patch(replay, record.$patch);
  } else if (isMessage(record)) {
    put(replay, record);
  } else if (isObject(record.$set)) {
    if (!Array.isArray(record.$set.messages)) return;
    replay.entries.clear();
    replay.before = false;
    for (const message of record.$set.messages) if (isMessage(message)) put(replay, message);
  } else if (isHeader(record) && Array.isArray(record.messages)) {
    for (const message of record.messages) if (isMessage(message)) put(replay, message);
  }
}

/**
 * The text of a Gemini CLI session's newest reply, from the end of its
 * session file, as it was written, not yet made fit to show. Null when the
 * tail holds no reply that still stands, or cannot tell which is the newest.
 *
 * `fromStart` says whether the tail is the whole file. When it is not, its
 * first line is a part of a longer one and is not read. A reply is one line,
 * so a reply that is read is read whole.
 */
export function lastSaidInSessionFile(tail: string, fromStart: boolean): string | null {
  const replay: Replay = { before: !fromStart, entries: new Map() };
  const pieces = tail.split("\n");
  for (let index = fromStart ? 0 : 1; index < pieces.length; index += 1) {
    apply(replay, pieces[index] ?? "");
  }
  for (const entry of [...replay.entries.values()].reverse()) {
    // A message from before the end, which may be a newer reply.
    if (!entry.seen) return null;
    if (entry.reply !== null) return entry.reply;
  }
  return null;
}

/**
 * The answer the end of a session file gives, made fit to show. Nothing of
 * the tail is kept, and the answer carries no token counts: a session's are
 * on the session already, from the poll's read of its file.
 */
export function answerFrom(tail: string, fromStart: boolean): LastMessageResponse {
  const shown = messageText(lastSaidInSessionFile(tail, fromStart));
  // Nothing said, only what cannot be shown, or a reply that cannot be told.
  if (shown === undefined) {
    return { message: null, reason: fromStart ? "nothing-yet" : "too-far-back" };
  }
  return { message: { text: shown.text, cut: shown.cut } };
}

export interface GeminiCliLastMessagesOptions {
  /** Shared with the other agents' readers. Left out, the reader has its own. */
  limits?: TailLimits;
  io?: ReadOnlyIo;
  now?: () => number;
  /** Runs `run` once, `ms` from now. Tests pass their own. */
  later?: (run: () => void, ms: number) => void;
}

/**
 * Reads what a Gemini CLI session last said when the route asks for it, and
 * only then: no poll reads it. It is told, after each poll, the sessions
 * listed, by id, each with the file the adapter listed it from. The limits
 * are those of every reader of last messages (`createTailReader` in
 * `src/collector/messages/tailReader.ts`). What is Gemini CLI's own:
 *
 * - The file is the session's own file,
 *   `<gemini folder>/tmp/<project>/chats/session-<…>.jsonl`, the one the last
 *   poll listed it from: of two files of one session, the one active last.
 *   It is never a subagent's, which the adapter does not list, nor another
 *   session's, and nothing in a request names it.
 * - A file that has gone is answered `not-found`, and opened again at the
 *   next ask after a second. The next poll that does not list the session
 *   drops it.
 */
export function createGeminiCliLastMessages(
  options: GeminiCliLastMessagesOptions = {},
): TailReader<string> {
  return createTailReader<string>({
    // The target is the file itself, as the adapter's last poll listed it.
    find: (file) => Promise.resolve(file),
    keyOf: (file) => file,
    answerFrom,
    limits: options.limits,
    io: options.io,
    now: options.now,
    later: options.later,
  });
}
