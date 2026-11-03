import type { LastMessageResponse } from "../../../core/api.ts";
import { MAX_MESSAGE_LENGTH, messageText } from "../../../core/text.ts";
import { createEndReader, type TailLimits, type TailReader } from "../../messages/tailReader.ts";
import type { DatabaseReader, DatabaseStamp } from "./database.ts";
import { jsonRows, SESSION_ID } from "./sessionRows.ts";

/**
 * What an OpenCode session last said, asked of OpenCode's database with one
 * fixed question when the route asks for it, and never by a poll.
 *
 * OpenCode keeps every session, message and part in one database, so there
 * is no file of the session's own whose end could be read. The question is
 * asked with the same `sqlite3`, the same address and the same arguments as
 * the poll's (`database.ts`), and its answer stands in for a transcript's
 * end. These notes are from OpenCode's source at v1.19.0, not yet checked on
 * a computer running it:
 *
 * - Each step of a reply is an `assistant` message of its own, and its parts
 *   are rows of `part`, which OpenCode shows in the order of their ids
 *   (`parts` and `hydrate` in `packages/opencode/src/session/message-v2.ts`).
 *   Messages are ordered by `time_created` and `id`, as OpenCode orders them.
 * - A part whose `$.type` is `text` holds what the reply says in `$.text`
 *   (`packages/schema/src/v1/session.ts`). OpenCode marks a text part it
 *   writes itself `synthetic`, and one it leaves out of what the model is
 *   given `ignored` (`toModelMessagesEffect` in `message-v2.ts`). The model's
 *   thinking is a part of type `reasoning`, a tool's call and its output a
 *   part of type `tool`, and a file a part of type `file`.
 * - The summary OpenCode writes when it compacts a session is an `assistant`
 *   message with `$.summary` true (`packages/opencode/src/session/compaction.ts`).
 * - A subagent works in a session of its own, whose `parent_id` names the one
 *   that started it, so its messages are never the root session's.
 * - While a reply is written, its text part is saved empty, and saved again
 *   with its words only once the part ends. The words in between are only
 *   sent to the programs that show the session (`text-start`, `text-delta`
 *   and `text-end` in `packages/opencode/src/session/processor.ts`, and
 *   `updatePartDelta` in `session.ts`, which saves nothing).
 * - `/undo` only sets the session's `revert`, whose `$.messageID` names the
 *   prompt it went back to. The messages from that one on stay in the
 *   database until the next prompt, or command run with `!`, removes them,
 *   and until then OpenCode's window hides them: it cuts the messages it
 *   holds, kept in the order of `time_created` and `id`, at that message,
 *   when it finds it there (`revert` and `cleanup` in
 *   `packages/opencode/src/session/revert.ts`, and `messagesBeforeRevert` in
 *   `packages/tui/src/routes/session/index.tsx`).
 *
 * So the text is that of the newest `assistant` message of the session's
 * own, among its newest 100 messages that `/undo` has not taken back, that
 * is not a compaction's summary and has a text part with something in it
 * that is neither `synthetic` nor `ignored`: those parts' `$.text`, in the
 * order of their ids, joined with a line break, as OpenCode's own "Copy last
 * assistant message" joins them (`packages/tui/src/routes/session/index.tsx`).
 * A step that only thinks or calls tools is passed over for the one before
 * it. A prompt, the thinking, a tool's call or output, a file, a synthetic or
 * ignored part, a compaction's summary, a message `/undo` took back and a
 * subagent's session's text are never taken.
 */

/** How many of a session's newest messages are looked through for its newest reply with text. */
export const MESSAGES_LOOKED_AT = 100;

/**
 * The most of the reply's text the question hands back: the last 4,000
 * characters of each text part, and only the parts that make up the last
 * 4,000 characters of the reply, twice what is kept, so that what is made fit
 * to show is cut by `messageText` and not here.
 */
export const TEXT_HANDED_BACK = 2 * MAX_MESSAGE_LENGTH;

/** What goes between the text parts of one reply: a line break, as OpenCode copies them. */
const PART_BREAK = "\n";

/**
 * Whether a part `p` is text of the reply's own: a `text` part with
 * something in it but spaces, tabs and line breaks, not marked `synthetic`
 * or `ignored`. Its marks are only tested inside SQLite.
 */
const TEXT_PART = [
  "CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') IS 'text'",
  "AND json_type(p.data, '$.text') IS 'text'",
  "AND json_type(p.data, '$.synthetic') IS NOT 'true'",
  "AND json_type(p.data, '$.ignored') IS NOT 'true'",
  "AND trim(json_extract(p.data, '$.text'), char(32, 9, 10, 13)) != '' ELSE 0 END",
].join(" ");

/** Whether a message `m` is a step of a reply, and not the summary of a compaction. Always 0 or 1. */
const REPLY_STEP = [
  "CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') IS 'assistant'",
  "AND json_type(m.data, '$.summary') IS NOT 'true' ELSE 0 END",
].join(" ");

/**
 * Whether `/undo` has left a message `m` alone: it comes before, by
 * `time_created` and `id`, the message `undone` holds, or `undone` holds
 * none. Always 0 or 1.
 */
const NOT_UNDONE =
  "NOT EXISTS (SELECT 1 FROM undone u WHERE (m.time_created, m.id) >= (u.time_created, u.id))";

/**
 * The one question, for one session: what its newest reply with text says.
 * Its id is the only thing put into it, and only once it is an id OpenCode
 * makes, `ses` and letters, digits, `_` and `-` alone, so it cannot end the
 * quotes it is put between. `sqlite3` takes a value to bind only through its
 * own `.parameter` command, which reads that value as SQL first, so a checked
 * id is no less safe than one bound that way. Null for any other id.
 *
 * It prints one `reply` row, with how many text parts the reply has, none
 * when no reply among the newest 100 messages has text, and whether the
 * session has more than 100 messages. Then a `text` row for each text part
 * needed for the reply's last 4,000 characters, newest last by `n`, with its
 * last 4,000 characters, and `cut` 1 when that left some of it out.
 *
 * The messages counted and looked through are those `/undo` has not taken
 * back. `undone` holds the message the session's `revert` names, when it is
 * JSON and the session has that message, and only its id and time are
 * compared with each message's. Nothing of `revert` is printed.
 *
 * The session must be a root session, as every listed one is. Each `data` is
 * read only once `json_valid` says it is JSON, so one row that is not is
 * passed over rather than failing the whole answer.
 */
export function lastTextQuery(sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const limit = MESSAGES_LOOKED_AT;
  const kept = TEXT_HANDED_BACK;
  return [
    "WITH asked AS (SELECT s.id,",
    "CASE WHEN json_valid(s.revert) THEN json_extract(s.revert, '$.messageID') END AS undo_from",
    `FROM session s WHERE s.id = '${sessionId}' AND s.parent_id IS NULL),`,
    "undone AS (SELECT c.id, c.time_created FROM message c",
    "WHERE c.session_id = (SELECT id FROM asked) AND c.id = (SELECT undo_from FROM asked)),",
    `recent AS (SELECT m.id, m.time_created, ${REPLY_STEP} AS step FROM message m`,
    `WHERE m.session_id = (SELECT id FROM asked) AND ${NOT_UNDONE}`,
    `ORDER BY m.time_created DESC, m.id DESC LIMIT ${limit}),`,
    "reply AS (SELECT r.id FROM recent r WHERE r.step = 1",
    `AND EXISTS (SELECT 1 FROM part p WHERE p.message_id = r.id AND ${TEXT_PART})`,
    "ORDER BY r.time_created DESC, r.id DESC LIMIT 1),",
    "texts AS (SELECT p.id, json_extract(p.data, '$.text') AS t FROM part p",
    `WHERE p.message_id = (SELECT id FROM reply) AND ${TEXT_PART}),`,
    "ends AS (SELECT id, t, coalesce(sum(length(t) + 1) OVER",
    "(ORDER BY id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS after FROM texts)",
    "SELECT 'reply' AS kind, (SELECT count(*) FROM texts) AS parts,",
    "(SELECT count(*) FROM (SELECT 1 FROM message m WHERE m.session_id = (SELECT id FROM asked)",
    `AND ${NOT_UNDONE} LIMIT ${limit + 1})) > ${limit} AS more, NULL AS n, NULL AS cut, NULL AS text`,
    "UNION ALL SELECT 'text', NULL, NULL, row_number() OVER (ORDER BY id),",
    `length(t) > ${kept}, substr(t, -${kept}) FROM ends WHERE after < ${kept}`,
  ].join(" ");
}

const UNREADABLE: LastMessageResponse = { message: null, reason: "unreadable" };

/** A count, or null for anything else. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A flag SQLite printed: 0 or 1, else null. */
function flag(value: unknown): boolean | null {
  return value === 0 ? false : value === 1 ? true : null;
}

/** The reply's text as the question printed it, not yet made fit to show, or null when it is not that answer. */
function replyOf(
  stdout: string,
): { parts: number; more: boolean; text: string | null; cut: boolean } | null {
  const rows = jsonRows(stdout);
  if (rows === null) return null;
  let reply: { parts: number; more: boolean } | null = null;
  const texts: { n: number; cut: boolean; text: string }[] = [];
  for (const row of rows) {
    if (row.kind === "reply") {
      const parts = count(row.parts);
      const more = flag(row.more);
      if (reply !== null || parts === null || more === null) return null;
      reply = { parts, more };
    } else if (row.kind === "text") {
      const n = count(row.n);
      const cut = flag(row.cut);
      if (n === null || cut === null || typeof row.text !== "string") return null;
      texts.push({ n, cut, text: row.text });
    } else {
      return null;
    }
  }
  if (reply === null || texts.length > reply.parts) return null;
  if (reply.parts === 0) return { ...reply, text: null, cut: false };
  if (texts.length === 0) return null;
  texts.sort((a, b) => a.n - b.n);
  return {
    ...reply,
    text: texts.map((part) => part.text).join(PART_BREAK),
    // A part's start, or a whole part before those printed, was left out.
    cut: texts.length < reply.parts || texts.some((part) => part.cut),
  };
}

/**
 * The answer what `sqlite3` printed for `lastTextQuery` gives, made fit to
 * show. Nothing of what it printed is kept, and the answer carries no token
 * counts, which Agent Lookout does not read for OpenCode.
 */
export function answerFrom(stdout: string): LastMessageResponse {
  const reply = replyOf(stdout);
  if (reply === null) return UNREADABLE;
  const shown = messageText(reply.text);
  // Nothing said among the newest messages, or only what cannot be shown.
  if (shown === undefined) {
    return { message: null, reason: reply.more ? "too-far-back" : "nothing-yet" };
  }
  return { message: { text: shown.text, cut: shown.cut || reply.cut } };
}

export interface OpencodeLastMessagesOptions {
  /** What asks OpenCode's database, as the adapter's poll reads it. */
  reader: Pick<DatabaseReader, "askOnce">;
  /** The database's path, which `reader` reads. */
  database: string;
  /** Shared with the other agents' readers. Left out, the reader has its own. */
  limits?: TailLimits;
  now?: () => number;
  /** Runs `run` once, `ms` from now. Tests pass their own. */
  later?: (run: () => void, ms: number) => void;
}

/**
 * Reads what an OpenCode session last said when the route asks for it, and
 * only then: no poll asks it. It is told, after each poll, the sessions
 * listed, by id, each with OpenCode's own id for it. The limits are those of
 * every reader of last messages (`createEndReader` in
 * `src/collector/messages/tailReader.ts`), with one look at the database
 * counted as one read. What is OpenCode's own:
 *
 * - Its transcript is the database, and its end is what `lastTextQuery`
 *   prints for the session, asked with `askOnce`, at most 256 KB of it. The
 *   question is asked again only once the database or its `-wal` has
 *   changed since the last answer.
 * - No database there is `not-found`. One that cannot be read, a `sqlite3`
 *   that fails or is not found, or an answer that is not this question's, is
 *   `unreadable`.
 */
export function createOpencodeLastMessages(
  options: OpencodeLastMessagesOptions,
): TailReader<string> {
  const { reader, database } = options;
  return createEndReader<string, DatabaseStamp>({
    find: () => Promise.resolve(database),
    async readEnd(_file, known, sessionId) {
      const question = lastTextQuery(sessionId);
      if (question === null) throw new Error("Not an id OpenCode makes for a session.");
      const read = await reader.askOnce(question, known);
      if (read.unchanged) return read;
      return { unchanged: false, stamp: read.stamp, tail: read.stdout, fromStart: true };
    },
    answerFrom: (stdout) => answerFrom(stdout),
    limits: options.limits,
    now: options.now,
    later: options.later,
  });
}
