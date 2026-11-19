import type {
  MuseEnd,
  MusePhase,
  MuseRecord,
} from "../../../core/mapping/muse-code/museCodeFold.ts";
import { literalOf } from "../autohand-code/jsonBytes.ts";
import { folder } from "../pi/sessionFile.ts";
import { walkLine, type Token, type WantedKey } from "./jsonWalker.ts";

/**
 * What one line of a Muse Code session log says, as far as a session's
 * status needs it, from its bytes. Built from Meta's documentation, its
 * MIT-licensed Muse Code SDK and protocol schema at 1.4.24 and its cookbook,
 * and from open-source readers of Muse Code's files, not from Muse Code's own
 * program, and not yet checked on a computer running it. See
 * docs/adapters/muse-code.md.
 *
 * Each line is a record, `{schema_version, id, stream {kind, id}, sequence,
 * recorded_at, record_type, durability, causation_id, payload_type,
 * payload_schema_version, payload}`, with `recorded_at` in microseconds since
 * the epoch (`RawLogRecordEnvelope` in `schema/msp/experimental/
 * msp.schema.json` of meta-models/muse-code-sdk at 5d8ba2e). Some lines are a
 * `retained_marker` or a `retained_frame` instead. A line is walked only when
 * its first `LINE_MAX` bytes hold one of the byte strings `BYTE_FILTER`
 * names, and is judged in this order:
 *
 * 1. A top-level `retained_frame` or `retained_marker` key: passed over, and a
 *    frame is never opened.
 * 2. A syntax error, a depth past 32, or a wanted path met twice: unreadable.
 * 3. No top-level `payload_type` string of the table below: passed over.
 * 4. Not on the session's own stream, `{"kind":"session","id":<its folder's
 *    name>}`: passed over, as another stream's record.
 * 5. `schema_version` not exactly `1`: unreadable, and newer when it is a
 *    whole number above 1.
 * 6. A field its kind needs missing, or not of its kind: unreadable.
 *
 * | `payload_type`                  | `payload.kind` | `event.kind`                  | Read                                        |
 * | ------------------------------- | -------------- | ----------------------------- | ------------------------------------------- |
 * | `runtime.session`               | `run`          | `started`, `run_retracted`, any other | `payload.run_id`                   |
 * | `runtime.session`               | `run`          | `terminal`                    | `payload.run_id`, `event.terminal`          |
 * | `runtime.session`               | `run`          | `user_input_prompt_requested`, `_settled` | `payload.run_id`, `event.prompt_id` |
 * | `runtime.session`               | `approval`     | `requested`                   | `payload.run_id`, `event.pending_action_id`, `event.presentation_phase` |
 * | `runtime.session`               | `approval`     | `automated_review_started`, `decision_applied` | `payload.run_id`, `event.pending_action_id` |
 * | `runtime.session`               | `approval`     | `automated_review_completed`  | the same, `event.status`, `event.timed_out`, `event.failure` |
 * | `runtime.session`               | `approval`     | any other                     | `payload.run_id`                            |
 * | `runtime.session`               | any other      | none                          | nothing more                                |
 * | `approval_wait.effect.terminal` | none           | none                          | `payload.record.pending_action_id`          |
 * | `session.end`, `session.resumed` | none          | none                          | nothing more                                |
 * | `runtime.session.metadata`, in the log's first 64 KiB only | none | none     | `payload.record.workspace_root`             |
 *
 * Every line taken gives `recorded_at` too, from its digits. Only two kinds of
 * bytes ever become text, each found as bytes first: the workspace folder, one
 * JSON string of at most 16 KiB, by `literalOf`, kept only when it is a whole
 * path of at most 4,096 characters with no control character; and the IDs,
 * 1 to 128 bytes each of a letter, a digit, `.`, `_`, `:` or `-`, as
 * `latin1`. Every word is compared as bytes with a closed list, and the
 * stream's ID with the folder's name. A prompt, a question, an answer, a
 * command, its output, a reply, a review and every other field are stepped
 * over as bytes.
 */

/** The most of one line held and walked. */
export const LINE_MAX = 1024 * 1024;

/** The longest ID kept. */
export const MAX_ID_BYTES = 128;

/** The longest workspace folder decoded, between its quotes. */
export const MAX_FOLDER_BYTES = 16 * 1024;

/** The schema version this reads. */
const SCHEMA_VERSION = Buffer.from("1");

/** The byte strings one of which a line must hold to be walked: a `payload_type` the table reads, quotes included. */
export const BYTE_FILTER: readonly Buffer[] = [
  '"runtime.session"',
  '"approval_wait.effect.terminal"',
  '"session.end"',
  '"session.resumed"',
].map((word) => Buffer.from(word));

/** The same, for a line of the log's first 64 KiB read for the workspace folder. */
export const HEAD_FILTER: readonly Buffer[] = [Buffer.from('"runtime.session.metadata"')];

const FRAME = 0;
const MARKER = 1;
const SCHEMA = 2;
const STREAM_KIND = 3;
const STREAM_ID = 4;
const RECORDED_AT = 5;
const PAYLOAD_TYPE = 6;
const PAYLOAD_KIND = 7;
const RUN_ID = 8;
const EVENT_KIND = 9;
const TERMINAL = 10;
const PROMPT_ID = 11;
const ACTION_ID = 12;
const PHASE = 13;
const STATUS = 14;
const TIMED_OUT = 15;
const FAILURE = 16;
const RECORD_ACTION_ID = 17;
const WORKSPACE_ROOT = 18;
const LEAVES = 19;

const key = (name: string, leaf?: number, children?: readonly WantedKey[]): WantedKey => ({
  key: Buffer.from(name),
  ...(leaf === undefined ? {} : { leaf }),
  ...(children === undefined ? {} : { children }),
});

function wantedKeys(head: boolean): readonly WantedKey[] {
  const record = head
    ? [key("workspace_root", WORKSPACE_ROOT)]
    : [key("pending_action_id", RECORD_ACTION_ID)];
  return [
    key("retained_frame", FRAME),
    key("retained_marker", MARKER),
    key("schema_version", SCHEMA),
    key("stream", undefined, [key("kind", STREAM_KIND), key("id", STREAM_ID)]),
    key("recorded_at", RECORDED_AT),
    key("payload_type", PAYLOAD_TYPE),
    key("payload", undefined, [
      key("kind", PAYLOAD_KIND),
      key("run_id", RUN_ID),
      key("event", undefined, [
        key("kind", EVENT_KIND),
        key("terminal", TERMINAL),
        key("prompt_id", PROMPT_ID),
        key("pending_action_id", ACTION_ID),
        key("presentation_phase", PHASE),
        key("status", STATUS),
        key("timed_out", TIMED_OUT),
        key("failure", FAILURE),
      ]),
      key("record", undefined, record),
    ]),
  ];
}

const TAIL_KEYS = wantedKeys(false);
const HEAD_KEYS = wantedKeys(true);

/** The payload types read, as the table names them. */
const TYPES = [
  "runtime.session",
  "approval_wait.effect.terminal",
  "session.end",
  "session.resumed",
  "runtime.session.metadata",
] as const;
type PayloadType = (typeof TYPES)[number];

const RUN_EVENTS = [
  "started",
  "terminal",
  "run_retracted",
  "user_input_prompt_requested",
  "user_input_prompt_settled",
] as const;
const APPROVAL_EVENTS = [
  "requested",
  "automated_review_started",
  "automated_review_completed",
  "decision_applied",
] as const;
const ENDS = ["completed", "failed", "cancelled"] as const;
const PHASES = ["automated_reviewing", "human_pending"] as const;

/** What one line is, as far as the status needs it. */
export type JudgedLine =
  /** Not walked, a frame or a marker, another stream's, of a type not read, or one that decides nothing. */
  | { sort: "passed" }
  /** It would decide, and cannot be read: `newer` when its `schema_version` is a whole number above 1. */
  | { sort: "unreadable"; newer: boolean }
  | { sort: "record"; record: MuseRecord };

/** What the log's first 64 KiB give, from its metadata record. */
export interface HeadRecord {
  /** The workspace folder, or null when it is not one that can be kept. */
  cwd: string | null;
  /** The record's `recorded_at`, in epoch milliseconds, or null. */
  at: number | null;
}

const PASSED: JudgedLine = { sort: "passed" };
const UNREADABLE: JudgedLine = { sort: "unreadable", newer: false };

/** Whether a line's first bytes hold one of these byte strings. */
export function passesFilter(line: Buffer, filter: readonly Buffer[]): boolean {
  return filter.some((word) => line.indexOf(word) >= 0);
}

function stringBytes(line: Buffer, token: Token | undefined): Buffer | null {
  if (token?.type !== "string" || token.escaped) return null;
  return line.subarray(token.start, token.end);
}

/** Which of `words` a token is, by its bytes, or -1 for another word, and -2 for no string. */
function wordOf(line: Buffer, token: Token | undefined, words: readonly string[]): number {
  if (token?.type !== "string") return -2;
  const bytes = stringBytes(line, token);
  if (bytes === null) return -1;
  return words.findIndex(
    (word) => bytes.byteLength === word.length && bytes.equals(Buffer.from(word)),
  );
}

const isIdByte = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x2e ||
  byte === 0x5f ||
  byte === 0x3a ||
  byte === 0x2d;

/** An ID as text, when it is a string of 1 to 128 bytes each of `[A-Za-z0-9._:-]`, else null. */
export function idOf(line: Buffer, token: Token | undefined): string | null {
  const bytes = stringBytes(line, token);
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_ID_BYTES) return null;
  for (const byte of bytes) if (!isIdByte(byte)) return null;
  // Checked to be ASCII, so no byte becomes anything else.
  return bytes.toString("latin1");
}

/**
 * `recorded_at` in epoch milliseconds, when it is 1 to 16 digits with no sign,
 * fraction or exponent and no more than the largest safe integer, worked out
 * from the digits' values; else null.
 */
export function timeOf(line: Buffer, token: Token | undefined): number | null {
  if (token?.type !== "number") return null;
  const digits = token.end - token.start;
  if (digits < 1 || digits > 16) return null;
  let value = 0;
  for (let at = token.start; at < token.end; at += 1) {
    const byte = line[at] as number;
    if (byte < 0x30 || byte > 0x39) return null;
    value = value * 10 + (byte - 0x30);
  }
  return value <= Number.MAX_SAFE_INTEGER ? Math.floor(value / 1000) : null;
}

/** Whether a `schema_version` that is not 1 is a whole number above it. */
function newerSchema(line: Buffer, token: Token | undefined): boolean {
  if (token?.type !== "number") return false;
  for (let at = token.start; at < token.end; at += 1) {
    const byte = line[at] as number;
    if (byte < 0x30 || byte > 0x39) return false;
  }
  // A JSON number of digits alone has no leading zero, so any but `1` and `0` is above 1.
  return !(
    token.end - token.start === 1 &&
    (line[token.start] === 0x30 || line[token.start] === 0x31)
  );
}

/** The leaves a line's kind reads, past the envelope's, as the leaves read so far give that kind. */
function kindLeaves(
  line: Buffer,
  got: readonly (Token | undefined)[],
  head: boolean,
): readonly number[] | null {
  const type = wordOf(line, got[PAYLOAD_TYPE], TYPES);
  if (type < 0) return [];
  const name = TYPES[type] as PayloadType;
  // The first 64 KiB are read for the metadata record alone, and the rest never for it.
  if ((name === "runtime.session.metadata") !== head) return [];
  if (name === "runtime.session.metadata") return [WORKSPACE_ROOT];
  if (name === "approval_wait.effect.terminal") return [RECORD_ACTION_ID];
  if (name !== "runtime.session") return [];
  const kind = got[PAYLOAD_KIND];
  if (kind === undefined) return null;
  const payloadKind = wordOf(line, kind, ["run", "approval"]);
  if (payloadKind < 0) return [PAYLOAD_KIND];
  const event = got[EVENT_KIND];
  if (event === undefined) return null;
  if (payloadKind === 0) {
    const which = RUN_EVENTS[wordOf(line, event, RUN_EVENTS)];
    if (which === "terminal") return [RUN_ID, TERMINAL];
    if (which === "user_input_prompt_requested" || which === "user_input_prompt_settled") {
      return [RUN_ID, PROMPT_ID];
    }
    return [RUN_ID];
  }
  const which = APPROVAL_EVENTS[wordOf(line, event, APPROVAL_EVENTS)];
  if (which === "requested") return [RUN_ID, ACTION_ID, PHASE];
  if (which === "automated_review_completed")
    return [RUN_ID, ACTION_ID, STATUS, TIMED_OUT, FAILURE];
  if (which === "automated_review_started" || which === "decision_applied")
    return [RUN_ID, ACTION_ID];
  return [RUN_ID];
}

const ENVELOPE = [SCHEMA, STREAM_KIND, STREAM_ID, RECORDED_AT, PAYLOAD_TYPE];

/** The leaves of a line, walked until its kind's are read. */
function walked(line: Buffer, whole: boolean, head: boolean) {
  const got: (Token | undefined)[] = new Array<Token | undefined>(LEAVES);
  const end = walkLine(line, whole, head ? HEAD_KEYS : TAIL_KEYS, (leaf, token) => {
    got[leaf] = token;
    if (ENVELOPE.some((wanted) => got[wanted] === undefined)) return false;
    const leaves = kindLeaves(line, got, head);
    return leaves !== null && leaves.every((wanted) => got[wanted] !== undefined);
  });
  return { end, got };
}

type Envelope =
  | { state: "passed" }
  | { state: "unreadable"; newer: boolean }
  | { state: "ok"; type: PayloadType; got: (Token | undefined)[]; at: number | null };

/** Steps 1 to 5: what the envelope of a line says, before its kind's own fields. */
function envelopeOf(line: Buffer, whole: boolean, folderName: Buffer, head: boolean): Envelope {
  const { end, got } = walked(line, whole, head);
  if (got[FRAME] !== undefined || got[MARKER] !== undefined) return { state: "passed" };
  if (end === "error") return { state: "unreadable", newer: false };
  const type = wordOf(line, got[PAYLOAD_TYPE], TYPES);
  if (type < 0) return { state: "passed" };
  const name = TYPES[type] as PayloadType;
  if ((name === "runtime.session.metadata") !== head) return { state: "passed" };
  const streamKind = stringBytes(line, got[STREAM_KIND]);
  const streamId = stringBytes(line, got[STREAM_ID]);
  if (streamKind === null || !streamKind.equals(Buffer.from("session"))) return { state: "passed" };
  if (streamId === null || !streamId.equals(folderName)) return { state: "passed" };
  const schema = got[SCHEMA];
  const isOne =
    schema?.type === "number" && line.subarray(schema.start, schema.end).equals(SCHEMA_VERSION);
  if (!isOne) return { state: "unreadable", newer: newerSchema(line, schema) };
  return { state: "ok", type: name, got, at: timeOf(line, got[RECORDED_AT]) };
}

/**
 * What a line of the log says, from `line`, its first `LINE_MAX` bytes at
 * most, without its line break. `whole` says whether those are all of it.
 * `folderName` is the session folder's name, as bytes, which a record of the
 * session's own stream names as its stream's ID.
 */
export function judgeLine(line: Buffer, whole: boolean, folderName: Buffer): JudgedLine {
  if (!passesFilter(line, BYTE_FILTER)) return PASSED;
  const envelope = envelopeOf(line, whole, folderName, false);
  if (envelope.state === "passed") return PASSED;
  if (envelope.state === "unreadable")
    return envelope.newer ? { sort: "unreadable", newer: true } : UNREADABLE;
  const { type, got, at } = envelope;
  const record = (made: MuseRecord | null): JudgedLine =>
    made === null ? UNREADABLE : { sort: "record", record: made };
  if (type === "session.end") return record({ sort: "end", at });
  if (type === "session.resumed") return record({ sort: "resumed", at });
  if (type === "approval_wait.effect.terminal") {
    const action = idOf(line, got[RECORD_ACTION_ID]);
    return record(action === null ? null : { sort: "wait-ended", action, at });
  }
  const payloadKind = wordOf(line, got[PAYLOAD_KIND], ["run", "approval"]);
  if (payloadKind === -2) return UNREADABLE;
  if (payloadKind === -1) return record({ sort: "other", at });
  if (got[EVENT_KIND]?.type !== "string") return UNREADABLE;
  const run = idOf(line, got[RUN_ID]);
  if (run === null) return UNREADABLE;
  if (payloadKind === 0) {
    const which = RUN_EVENTS[wordOf(line, got[EVENT_KIND], RUN_EVENTS)];
    if (which === "started") return record({ sort: "started", run, at });
    if (which === "run_retracted") return record({ sort: "retracted", run, at });
    if (which === "terminal") {
      const word = wordOf(line, got[TERMINAL], ENDS);
      if (word === -2) return UNREADABLE;
      const end: MuseEnd = word < 0 ? "other" : (ENDS[word] as MuseEnd);
      return record({ sort: "terminal", run, end, at });
    }
    if (which === "user_input_prompt_requested" || which === "user_input_prompt_settled") {
      const prompt = idOf(line, got[PROMPT_ID]);
      if (prompt === null) return UNREADABLE;
      return record({
        sort: which === "user_input_prompt_requested" ? "asked" : "settled",
        run,
        prompt,
        at,
      });
    }
    return record({ sort: "run-event", run, at });
  }
  const which = APPROVAL_EVENTS[wordOf(line, got[EVENT_KIND], APPROVAL_EVENTS)];
  if (which === undefined) return record({ sort: "approval-event", run, at });
  const action = idOf(line, got[ACTION_ID]);
  if (action === null) return UNREADABLE;
  if (which === "requested") {
    const phaseToken = got[PHASE];
    const word = wordOf(line, phaseToken, PHASES);
    const phase: MusePhase =
      phaseToken === undefined ? "none" : word < 0 ? "other" : (PHASES[word] as MusePhase);
    return record({ sort: "requested", run, action, phase, at });
  }
  if (which === "automated_review_started")
    return record({ sort: "review-started", run, action, at });
  if (which === "decision_applied") return record({ sort: "decided", run, action, at });
  const approved = wordOf(line, got[STATUS], ["approved"]) === 0;
  const timedOut = got[TIMED_OUT]?.type === "true";
  const failure = got[FAILURE];
  const failed = failure !== undefined && failure.type !== "null";
  return record({
    sort: "review-completed",
    run,
    action,
    clean: approved && !timedOut && !failed,
    at,
  });
}

/**
 * The metadata record a line of the log's first 64 KiB is, on the session's
 * own stream, or null for any other line: its workspace folder and its time.
 * The folder is decoded alone, by JSON's own rules, and kept only when
 * `folder` takes it on this system's rules.
 */
export function judgeHeadLine(
  line: Buffer,
  folderName: Buffer,
  platform: NodeJS.Platform,
): HeadRecord | null {
  if (!passesFilter(line, HEAD_FILTER)) return null;
  const envelope = envelopeOf(line, true, folderName, true);
  if (envelope.state !== "ok") return null;
  const token = envelope.got[WORKSPACE_ROOT];
  let cwd: string | null = null;
  if (token?.type === "string" && token.end - token.start <= MAX_FOLDER_BYTES) {
    const value = literalOf(line, token.start - 1, MAX_FOLDER_BYTES);
    cwd = value === null ? null : folder(value, platform);
  }
  return { cwd, at: envelope.at };
}
