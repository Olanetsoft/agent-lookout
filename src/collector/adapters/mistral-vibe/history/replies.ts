import { deltaSpanOf } from "../deltaWalker.ts";
import { isRecord } from "../envelope.ts";
import { recordTypeOf } from "../journal.ts";

/**
 * Finding a Mistral Vibe session's newest reply in its history, from the steps
 * its journal records since the last save and the pieces of history that save
 * kept. Only the reader of last messages uses it (`lastMessages.ts`), when the
 * route asks.
 *
 * These notes are from Vibe's source at 3.1.4, not yet checked on a computer
 * running it. `harness/…/vibe/` stands for
 * `harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/`, and
 * each line number is one at 3.1.4.
 *
 * - The history is a list of entries, each with an `id`. A reply is an entry
 *   `{"type":"message","role":"assistant","generationStatus":"completed","outcome":{"type":"committed"},"content":[…],…}`
 *   of its own, and what it says is in its `text` blocks,
 *   `{"type":"text","text":…}`. Its other blocks are images, audio and
 *   resources (`_message_entry`, `harness/…/vibe/_projection.py:972`, and the
 *   reply a turn commits, `_projection.py:305-347`). The model's thinking is an
 *   entry of type `reasoning`, a tool's call and its output an `effect`, a
 *   settled question a `callback` and a rewind a `checkpoint`.
 * - A draft that never became the answer stays, its `outcome`
 *   `{"type":"discarded","cause":…}` (`_settled_provisional_entry`,
 *   `_projection.py:1975`). Vibe's own `/copy` passes it over unless its cause
 *   is `interrupt`, an answer cut short (`is_discarded_draft`,
 *   `vibe/cli-rust/src/server/types.rs:803`).
 * - Text still being written is never saved: the journal holds only what is
 *   done (`_without_provisional`, `_projection.py:1266`).
 * - A `projection_delta` record's `payload.delta` says how the history
 *   changed, step by step (`apply_projection_delta`,
 *   `harness/…/vibe/_storage.py:1680`): `append_entry` adds an entry at the
 *   end, `replace_entry` puts one in place of the entry with its `id`,
 *   `remove_entry` takes out every entry with its `id`, `set_history_entries`
 *   makes its list the whole history, and `set_envelope` sets everything but
 *   the history. A `session_relocated` record carries steps too, and beside
 *   them only a watermark, the session's metadata (its folders, its model,
 *   agent and other settings, ids, the digests of a subagent's template and
 *   policy ceiling, hook bindings and where an imported session came from)
 *   and its plugins' names and digests: no Session API facts
 *   (`SessionRelocatedPayloadV1`, `_storage.py:2005`, `SessionMetadataV1`,
 *   `_storage.py:876`, and `PluginLockV1`, `_storage.py:831`).
 * - A rewind, which editing a prompt and an interrupt before any answer are
 *   too, is never a step: Vibe saves the session again with its history cut
 *   (`rewind`, `harness/…/vibe/_host.py:1595`).
 *
 * So the text is that of the newest reply left in the history that is
 * completed, is not a draft Vibe discarded, unless an interrupt cut it short,
 * and has text blocks with something in them: those blocks, joined with a
 * blank line, as Vibe joins them (`PublicMessageEntry.text`,
 * `vibe/app_server/models.py:924`). Thinking, a tool's call or output, a
 * question or its answer, a prompt, an image and an entry a step took out are
 * never taken.
 *
 * Only `projection_delta` and `session_relocated` lines are parsed, told by
 * the end of each line. Of a `projection_delta`, only its `delta` is parsed,
 * found by walking the line back from its end as a poll does
 * (`deltaSpanOf`, `deltaWalker.ts`), never its header or `session_api`, which
 * holds a tool's arguments only when the tool's entry shows something else in
 * their place, as a subagent's does (`_record_tool_call`,
 * `_projection.py:210`). A `session_relocated` line is parsed whole. A
 * `callback_registered` or `callback_resolved` line is never parsed, nor is
 * any other. The steps' entries, prompts, replies, thinking, the tools called
 * with their arguments and what they printed, and questions and their answers
 * among them (`_tool_effect_detail`, `_projection.py:2068`), are parsed in
 * memory, and of each only its id and its reply's text are kept, and only
 * until the answer is made.
 */

/** What goes between the text blocks of one reply: a blank line, as Vibe joins them. */
export const PART_BREAK = "\n\n";

/** The records whose steps change the history. */
const HISTORY_RECORDS = new Set(["projection_delta", "session_relocated"]);

/**
 * The records Vibe writes that never change the history (`JournalRecordV1`,
 * `_storage.py:2089-2105`). Any other is one this reader does not know, and
 * what the history was before it is not known.
 */
const OTHER_RECORDS = new Set([
  "command_reserved",
  "core_input",
  "action_intent",
  "action_result",
  "process_operation_dispatched",
  "process_state_changed",
  "process_notification_submitted",
  "callback_registered",
  "callback_resolved",
  "receipt_succeeded",
  "receipt_failed",
]);

/** What is kept of one entry of the history: its id, and its text when it is a reply. */
export interface Entry {
  id: string | null;
  reply: string | null;
}

/** One step of a journal record that changes the history, with only what is kept of its entries. */
export type Step =
  | { op: "append"; entry: Entry }
  | { op: "replace"; id: string; entry: Entry }
  | { op: "remove"; id: string }
  | { op: "set"; entries: Entry[] }
  /** A step, or a record, this reader cannot follow: what came before it is no longer known. */
  | { op: "lost" };

/**
 * The newest entries of a history that are known, oldest first, and whether
 * older ones may come before them. The known entries are always the history's
 * end: every step adds at the end, or changes or takes out an entry in place.
 */
export interface HistoryWindow {
  entries: Entry[];
  before: boolean;
}

/**
 * The text of an entry of the history, when it is a reply that stands: a
 * completed `message` of role `assistant`, not a draft discarded for a cause
 * but `interrupt`, with `text` blocks that hold more than spaces. Null for any
 * other entry.
 */
export function replyTextOf(entry: unknown): string | null {
  if (!isRecord(entry) || entry.type !== "message" || entry.role !== "assistant") return null;
  if (entry.generationStatus !== "completed") return null;
  const outcome = entry.outcome;
  if (isRecord(outcome) && outcome.type === "discarded" && outcome.cause !== "interrupt") {
    return null;
  }
  if (!Array.isArray(entry.content)) return null;
  const texts: string[] = [];
  for (const block of entry.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  const text = texts.join(PART_BREAK);
  return text.trim() === "" ? null : text;
}

/** What is kept of an entry: its id, and its reply's text. */
export function entryOf(entry: unknown): Entry {
  return {
    id: isRecord(entry) && typeof entry.id === "string" ? entry.id : null,
    reply: replyTextOf(entry),
  };
}

/** What is kept of one step, or `lost` for one this reader does not know. `set_envelope` is no step of the history. */
function stepOf(value: unknown): Step | null {
  if (!isRecord(value)) return { op: "lost" };
  switch (value.op) {
    case "append_entry":
      return isRecord(value.entry) ? { op: "append", entry: entryOf(value.entry) } : { op: "lost" };
    case "replace_entry":
      return typeof value.id === "string" && isRecord(value.entry)
        ? { op: "replace", id: value.id, entry: entryOf(value.entry) }
        : { op: "lost" };
    case "remove_entry":
      return typeof value.id === "string" ? { op: "remove", id: value.id } : { op: "lost" };
    case "set_history_entries":
      return Array.isArray(value.entries)
        ? { op: "set", entries: value.entries.map(entryOf) }
        : { op: "lost" };
    case "set_envelope":
      return null;
    default:
      return { op: "lost" };
  }
}

/**
 * The `delta` of one whole line of a record that changes the history, parsed,
 * or undefined when it cannot be found or parsed. Of a `projection_delta` only
 * the array is parsed, never the header or `session_api`. A
 * `session_relocated` record, which has no Session API facts, is parsed whole.
 */
function deltaOf(line: string, type: string): unknown {
  try {
    if (type === "projection_delta") {
      const bytes = Buffer.from(line, "utf8");
      const found = deltaSpanOf(bytes, true);
      if (found.kind !== "delta") return undefined;
      return JSON.parse(bytes.toString("utf8", found.delta.start, found.delta.end));
    }
    const record: unknown = JSON.parse(line);
    return isRecord(record) && isRecord(record.payload) ? record.payload.delta : undefined;
  } catch {
    return undefined;
  }
}

/** The steps of one whole journal line, none for a line that does not change the history. */
function stepsOfLine(line: string): Step[] {
  const type = recordTypeOf(Buffer.from(line, "utf8"));
  if (type !== null && OTHER_RECORDS.has(type)) return [];
  // A `projection_advanced` record, the whole state some older builds wrote,
  // or a record of a kind this reader does not know.
  if (type === null || !HISTORY_RECORDS.has(type)) return [{ op: "lost" }];
  const delta = deltaOf(line, type);
  if (!Array.isArray(delta)) return [{ op: "lost" }];
  return delta.flatMap((value: unknown) => stepOf(value) ?? []);
}

/**
 * The steps the end of a journal segment records, oldest first. `fromStart`
 * says whether the end is the whole segment. When it is not, its first line is
 * part of a longer one and is not read. The last piece is never read: it is
 * empty, or a record Vibe is still writing, which it cuts off if it stops.
 */
export function historySteps(tail: string, fromStart: boolean): Step[] {
  const pieces = tail.split("\n");
  const steps: Step[] = [];
  for (let index = fromStart ? 0 : 1; index < pieces.length - 1; index += 1) {
    const line = pieces[index] ?? "";
    if (line !== "") steps.push(...stepsOfLine(line));
  }
  return steps;
}

/** The history the steps make of `base`, as Vibe applies them. `base` is left as it was. */
export function replay(base: HistoryWindow, steps: readonly Step[]): HistoryWindow {
  let entries = [...base.entries];
  let before = base.before;
  for (const step of steps) {
    switch (step.op) {
      case "append":
        entries.push(step.entry);
        break;
      case "replace": {
        // An id that is not known is an older entry's, which stays older.
        const at = entries.findIndex((entry) => entry.id === step.id);
        if (at !== -1) entries[at] = step.entry;
        break;
      }
      case "remove":
        entries = entries.filter((entry) => entry.id !== step.id);
        break;
      case "set":
        entries = [...step.entries];
        before = false;
        break;
      case "lost":
        entries = [];
        before = true;
        break;
    }
  }
  return { entries, before };
}

/**
 * What a history says the session last said: the text of its newest reply,
 * or null, with whether entries older than those known may hold one.
 */
export interface ReplyFound {
  text: string | null;
  before: boolean;
}

/** The newest reply in what is known of a history. */
export function newestReply(window: HistoryWindow): ReplyFound {
  for (let index = window.entries.length - 1; index >= 0; index -= 1) {
    const reply = window.entries[index]?.reply ?? null;
    if (reply !== null) return { text: reply, before: window.before };
  }
  return { text: null, before: window.before };
}
