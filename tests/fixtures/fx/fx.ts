// Test fixtures only. Every id, name, path and word here is invented and
// generic. A log line follows the shape fx's source writes at v0.0.17
// (`appendHeader` and `appendBody` in `src/core/session_manager/schema.zig`,
// `appendLine` in `log.zig`), as written up in docs/adapters/fx.md. Nothing in
// it is copied from a real machine: fx was not run to make it. Product code
// never imports this file.

export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const HOME = "/Users/example";

/** fx's folder when nothing names another, and the folder of session folders in it. */
export const FX_DIR = `${HOME}/.fx`;
export const V2 = `${FX_DIR}/sessions/v2`;

/** The folder the fixture's sessions run in. */
export const WORKSPACE = `${HOME}/demo-project`;

/** When the fixture's session was made: an hour before `NOW`. */
export const STARTED_AT = NOW - HOUR;

/** An id as fx makes one: 12 characters of base64url, never starting with `-`. */
export const SESSION_ID = "aB3dE5fG7hJ9";
export const OTHER_ID = "Zy8xW6vU4tS2";
export const CHILD_ID = "cH1ldS3ss10n";

/** Words that stand for what a person or a model wrote. None may ever leave a log. */
export const PRIVATE_WORDS = "placeholder words that must never leave the session log";

export const logPath = (id: string, dir = V2) => `${dir}/${id}/log.jsonl`;

/**
 * CRC32C, one bit at a time, written apart from the adapter's table loop so
 * that each holds the other to the same value.
 */
export function crc32cBitwise(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A JSON string as fx writes one: `"`, `\` and control bytes escaped, the rest as it is. */
export function jsonString(value: string): string {
  return JSON.stringify(value);
}

/**
 * One whole line: the header, the kind's fields, which start with `,` or are
 * empty, then the checksum of every byte before it. `crc` puts another
 * checksum in its place.
 */
export function frame(
  header: { v?: number; seq: number; ts: number; kind: string },
  body = "",
  crc?: string,
): string {
  const payload = `{"v":${header.v ?? 1},"seq":${header.seq},"ts":${header.ts},"kind":"${header.kind}"${body}`;
  const digits = crc ?? crc32cBitwise(Buffer.from(payload, "utf8")).toString(16).padStart(8, "0");
  return `${payload},"crc":"${digits}"}\n`;
}

/** The fields of a first line, in fx's order, with what a test changes. */
export interface FirstLineFields {
  id?: string;
  workspace?: string;
  role?: "root" | "child" | string;
  host?: string;
  parent?: string;
  forkedFrom?: { id: string; seq: number };
  /** Raw fields added at the end, as a newer fx might write. */
  extra?: string;
  v?: number;
  seq?: number;
  ts?: number;
  kind?: string;
}

export function firstLine(fields: FirstLineFields = {}): string {
  let body = `,"id":${jsonString(fields.id ?? SESSION_ID)}`;
  body += `,"workspace":${jsonString(fields.workspace ?? WORKSPACE)}`;
  body += `,"role":${jsonString(fields.role ?? "root")}`;
  body += `,"host":${jsonString(fields.host ?? "app")}`;
  if (fields.parent !== undefined) body += `,"parent":${jsonString(fields.parent)}`;
  if (fields.forkedFrom !== undefined) {
    body += `,"forked_from":{"id":${jsonString(fields.forkedFrom.id)},"seq":${fields.forkedFrom.seq}}`;
  }
  body += fields.extra ?? "";
  return frame(
    {
      v: fields.v,
      seq: fields.seq ?? 1,
      ts: fields.ts ?? STARTED_AT,
      kind: fields.kind ?? "session_created",
    },
    body,
  );
}

/** Raw JSON an `item` holds, as fx writes a piece: the person's or a model's words, never read. */
export const ITEM_DATA = JSON.stringify({ text: PRIVATE_WORDS, args: { command: PRIVATE_WORDS } });

/**
 * A session's log, a line at a time, with `seq` counted for each and each
 * line's time given or the last one kept. `text()` is the whole log, and
 * `since(mark)` what was added after a mark, for an append.
 */
export function fxLog(first: FirstLineFields = {}) {
  const lines: string[] = [firstLine(first)];
  let seq = first.seq ?? 1;
  let ts = first.ts ?? STARTED_AT;
  let turn = 0;
  const add = (kind: string, body: string, at?: number) => {
    seq += 1;
    if (at !== undefined) ts = at;
    lines.push(frame({ seq, ts, kind }, body));
    return log;
  };
  const log = {
    lines,
    get seq() {
      return seq;
    },
    text: () => lines.join(""),
    mark: () => lines.length,
    since: (mark: number) => lines.slice(mark).join(""),
    turnStarted(at?: number) {
      turn += 1;
      return add("turn_started", `,"turn":${turn}`, at);
    },
    item(at?: number, data = ITEM_DATA, type = "assistant") {
      return add("item", `,"turn":${turn},"type":${jsonString(type)},"data":${data}`, at);
    },
    turnCommitted(at?: number) {
      return add("turn_committed", `,"turn":${turn}`, at);
    },
    turnInterrupted(reason: "cancel" | "failed" | "closed" | "crash", at?: number) {
      return add("turn_interrupted", `,"turn":${turn},"reason":"${reason}"`, at);
    },
    closed(at?: number) {
      return add("closed", "", at);
    },
    set(key: string, value: string, at?: number) {
      return add("set", `,"key":${jsonString(key)},"value":${value}`, at);
    },
    title(at?: number) {
      return log.set("title", jsonString(PRIVATE_WORDS), at);
    },
    snapshot(at?: number) {
      const state = JSON.stringify({ open_turn: null, title: PRIVATE_WORDS });
      return add("snapshot", `,"covers_seq":${seq},"state":${state}`, at);
    },
    compacted(at?: number) {
      return add(
        "compacted",
        `,"turn":${turn},"data":${JSON.stringify({ summary: PRIVATE_WORDS })}`,
        at,
      );
    },
    childSpawned(child = CHILD_ID, at?: number) {
      const data = JSON.stringify({ agent: "helper", purpose: PRIVATE_WORDS });
      return add(
        "child_spawned",
        `,"child":${jsonString(child)},"work_id":"w1","data":${data}`,
        at,
      );
    },
    childFinished(child = CHILD_ID, at?: number) {
      return add(
        "child_finished",
        `,"child":${jsonString(child)},"work_id":"w1","outcome":"ok"`,
        at,
      );
    },
    /** A line of any kind and fields, with the next `seq`. */
    raw(kind: string, body: string, at?: number, v?: number) {
      seq += 1;
      if (at !== undefined) ts = at;
      lines.push(frame({ v, seq, ts, kind }, body));
      return log;
    },
    /** A whole line that fails its checksum, with the next `seq`. */
    bad(at?: number) {
      seq += 1;
      if (at !== undefined) ts = at;
      lines.push(
        frame(
          { seq, ts, kind: "item" },
          `,"turn":${turn},"type":"assistant","data":{}`,
          "00000000",
        ),
      );
      return log;
    },
    /** Skips a `seq`, as a gap in the log. */
    skip() {
      seq += 1;
      return log;
    },
  };
  return log;
}

/** fx's list of sessions, which holds each session's title. It is never opened. */
export const INDEX_LINE = `{"op":"put","id":"${SESSION_ID}","role":"root","host":"app","workspace":${jsonString(WORKSPACE)},"title":${jsonString(PRIVATE_WORDS)},"crc":"00000000"}\n`;
