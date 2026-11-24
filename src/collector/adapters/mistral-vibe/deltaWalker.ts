/**
 * Finding the public state a Vibe `projection_delta` line sets, or where its
 * steps are, by walking the line back from its end as bytes. A poll turns
 * nothing but the state into text (`journal.ts`), and the reader of a
 * session's last message nothing but the steps (`history/replies.ts`).
 *
 * A journal line is the record's JSON with its keys sorted and no spaces
 * (harness/.../vibe/_storage.py, `canonical_json` and `_journal_record_bytes`),
 * so the payload, the record's first key, comes before the header, whose values
 * are strings, numbers and null. From Vibe 3.1.0 the payload can hold the
 * Session API's facts between the delta and the watermark
 * (`ProjectionDeltaPayloadV1`, `_storage.py:1997-2002` at 3.1.4), and from
 * 3.1.4, where the Session API runs local sessions by default, most do:
 *
 * `{"payload":{"delta":[<steps>],"session_api":{…},"watermark":N},"previous_record_sha256":…,"type":"projection_delta"}`
 *
 * `session_api` can hold a tool's arguments as the model wrote them, objects
 * that can hold any keys (`SessionApiFactsV1.tool_calls`), and the steps before
 * the state hold what was said, run and read. So, from the line's end, the walk:
 *
 * - steps over the header's members, to the payload;
 * - takes the payload's last key, `watermark`, then steps over `session_api`
 *   whole when it is there;
 * - steps over the array before them whole, to check that its key is `delta`.
 *   Any other key there, or after `delta`, is a payload it does not know.
 *   Where the steps are is this array (`deltaSpanOf`);
 * - goes into `delta` and through its steps from the last, each an object, to
 *   the newest `{"op":"set_envelope","state":{…}}`, which Vibe makes the last
 *   step (`compute_projection_delta`). The steps before it are stepped over
 *   for the key alone, and its state is the one value the walk gives
 *   (`deltaStateOf`).
 *
 * To step over a value, it finds where the value starts: a string's opening
 * quote is the nearest `"` before its end with an even run of `\` before it,
 * since a `"` in a string is always escaped, and an object or an array is
 * matched bracket for bracket, its strings stepped over the same way. So the
 * bytes of a string, or of a tool's arguments, never read as the record's own
 * structure.
 *
 * The walk needs nothing of the line's start, so it reads the state from the
 * end of a line whose start was not read. When it would go before the bytes it
 * was given, it stops there: they start inside what it was walking. The one
 * exception is the key of the array before `session_api` and `watermark`: on
 * such a line it can be before the bytes given, and the array is then walked
 * as `delta` without it.
 */

/** Where a value's bytes are in a line: from `start` up to, not including, `end`. */
export interface Span {
  start: number;
  end: number;
}

/** The walk reached the start of the bytes given, which start inside the line. */
interface WalkCut {
  kind: "cut";
}

/** The line is not laid out as Vibe writes a `projection_delta` record. */
interface WalkBad {
  kind: "bad";
}

/** What a walk of a `projection_delta` line found of its state. */
export type DeltaState =
  /** The newest `set_envelope` step's state. */
  | { kind: "state"; state: Span }
  /** The delta sets no state. */
  | { kind: "none" }
  | WalkCut
  | WalkBad;

/** What a walk of a `projection_delta` line found of its steps. */
export type DeltaSpan =
  /** The `delta` array, its brackets included, its key checked. */
  | { kind: "delta"; delta: Span }
  /** The array, or its key, starts before the bytes given. */
  | WalkCut
  | WalkBad;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;

const DELTA = Buffer.from("delta");
const WATERMARK = Buffer.from("watermark");
const SESSION_API = Buffer.from("session_api");
const OP = Buffer.from("op");
const STATE = Buffer.from("state");
const SET_ENVELOPE = Buffer.from('"set_envelope"');

class Cut extends Error {}
class Bad extends Error {}

/** A byte of a number, `true`, `false` or `null`. */
const isScalarByte = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x45 ||
  byte === 0x2b ||
  byte === 0x2d ||
  byte === 0x2e;

/**
 * The walk of one `projection_delta` line. `whole` says whether `line` is the
 * whole line, without its newline, or only its end, so that reaching its start
 * is a line not laid out as Vibe writes one, or one cut there. Each step of it
 * throws `Cut` or `Bad` for such a line.
 */
function walkOf(line: Buffer, whole: boolean) {
  /** Before the bytes given. */
  const past = (): never => {
    throw whole ? new Bad() : new Cut();
  };
  const bad = (): never => {
    throw new Bad();
  };
  const byteAt = (at: number): number => (at < 0 ? past() : (line[at] as number));
  const is = (span: Span, bytes: Buffer) =>
    span.end - span.start === bytes.byteLength &&
    line.compare(bytes, 0, bytes.byteLength, span.start, span.end) === 0;

  /** Where the string whose closing quote is at `end - 1` opens. */
  function stringStart(end: number): number {
    let at = end - 1;
    for (;;) {
      at = at > 0 ? line.lastIndexOf(QUOTE, at - 1) : -1;
      if (at === -1) past();
      let run = at;
      while (byteAt(run - 1) === BACKSLASH) run -= 1;
      if ((at - run) % 2 === 0) return at;
      at = run;
    }
  }

  /** Where the object or array whose closing bracket is at `end - 1` opens. */
  function containerStart(end: number): number {
    const closers: number[] = [];
    for (let at = end - 1; ; at -= 1) {
      const byte = byteAt(at);
      if (byte === QUOTE) {
        at = stringStart(at + 1);
      } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        closers.push(byte);
      } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        if (closers.pop() !== (byte === OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET)) throw new Bad();
        if (closers.length === 0) return at;
      }
    }
  }

  /** Where the value that ends at `end` starts. */
  function valueStart(end: number): number {
    const last = byteAt(end - 1);
    if (last === QUOTE) return stringStart(end);
    if (last === CLOSE_BRACE || last === CLOSE_BRACKET) return containerStart(end);
    let at = end;
    while (isScalarByte(byteAt(at - 1))) at -= 1;
    if (at === end) throw new Bad();
    return at;
  }

  /** The member of an object whose value ends at `end`: its key, between the quotes, its value, and where it starts. */
  function memberBefore(end: number): { key: Span; value: Span; start: number } {
    const value = valueStart(end);
    if (byteAt(value - 1) !== COLON || byteAt(value - 2) !== QUOTE) throw new Bad();
    const start = stringStart(value - 1);
    return { key: { start: start + 1, end: value - 2 }, value: { start: value, end }, start };
  }

  /**
   * Where the member or element before the one that starts at `at` ends, past
   * the comma between them. Null when `at` begins its object or array, whose
   * opening bracket is `open`.
   */
  function endBefore(at: number, open: number): number | null {
    const byte = byteAt(at - 1);
    if (byte === open) return null;
    if (byte !== COMMA) throw new Bad();
    return at - 1;
  }

  /** The step whose closing brace is at `end - 1`: where it starts, and its state when it sets one. */
  function stepBefore(end: number): { start: number; state: Span | null } {
    if (byteAt(end - 1) !== CLOSE_BRACE) throw new Bad();
    let op: Span | null = null;
    let state: Span | null = null;
    let at = end - 1;
    for (;;) {
      const member = memberBefore(at);
      if (is(member.key, OP)) op = member.value;
      else if (is(member.key, STATE)) state = member.value;
      const before = endBefore(member.start, OPEN_BRACE);
      if (before !== null) {
        at = before;
        continue;
      }
      if (op === null || !is(op, SET_ENVELOPE)) return { start: member.start - 1, state: null };
      if (state === null || line[state.end - 1] !== CLOSE_BRACE) throw new Bad();
      return { start: member.start - 1, state };
    }
  }

  /**
   * The `delta` array, past the header, `watermark` and `session_api`: where
   * it ends, after its closing bracket, and where it starts once its key is
   * checked. On a line whose start was not read, the key can be before the
   * bytes given, and is not checked: `start` is then null.
   */
  function deltaArray(): { start: number | null; end: number } {
    // The record's header, to the payload, the one value of it that is an object.
    if (byteAt(line.byteLength - 1) !== CLOSE_BRACE) throw new Bad();
    let end = line.byteLength - 1;
    while (byteAt(end - 1) !== CLOSE_BRACE) {
      end = endBefore(memberBefore(end).start, OPEN_BRACE) ?? bad();
    }

    // The payload: `watermark` last, `session_api` before it from 3.1.0, then `delta`.
    const watermark = memberBefore(end - 1);
    if (!is(watermark.key, WATERMARK)) throw new Bad();
    end = endBefore(watermark.start, OPEN_BRACE) ?? bad();
    if (byteAt(end - 1) !== CLOSE_BRACKET) {
      const sessionApi = memberBefore(end);
      if (!is(sessionApi.key, SESSION_API)) throw new Bad();
      end = endBefore(sessionApi.start, OPEN_BRACE) ?? bad();
      if (byteAt(end - 1) !== CLOSE_BRACKET) throw new Bad();
    }

    // The delta, keyed `delta`.
    try {
      const member = memberBefore(end);
      if (!is(member.key, DELTA)) throw new Bad();
      return { start: member.value.start, end };
    } catch (error) {
      if (!(error instanceof Cut)) throw error;
      return { start: null, end };
    }
  }

  return { byteAt, endBefore, stepBefore, deltaArray };
}

/** What `walk` found, or `cut` or `bad` when the line was cut or is not laid out as Vibe writes one. */
function settled<Found>(walk: () => Found): Found | WalkCut | WalkBad {
  try {
    return walk();
  } catch (error) {
    if (error instanceof Cut) return { kind: "cut" };
    if (error instanceof Bad) return { kind: "bad" };
    throw error;
  }
}

/**
 * The newest state a `projection_delta` line sets. `whole` says whether `line`
 * is the whole line, without its newline, or only its end, so that reaching
 * its start is a line not laid out as Vibe writes one, or one cut there.
 */
export function deltaStateOf(line: Buffer, whole: boolean): DeltaState {
  const walk = walkOf(line, whole);
  return settled((): DeltaState => {
    // From the delta's last step. Its key, when it is before the bytes given, is not checked.
    let end = walk.deltaArray().end - 1;
    if (walk.byteAt(end - 1) === OPEN_BRACKET) return { kind: "none" };
    for (;;) {
      const step = walk.stepBefore(end);
      if (step.state !== null) return { kind: "state", state: step.state };
      const before = walk.endBefore(step.start, OPEN_BRACKET);
      if (before === null) return { kind: "none" };
      end = before;
    }
  });
}

/**
 * Where a `projection_delta` line's steps are: its `delta` array, found by the
 * same walk, past the header, `watermark` and `session_api`, none of which is
 * turned into text. `whole` is as for `deltaStateOf`.
 */
export function deltaSpanOf(line: Buffer, whole: boolean): DeltaSpan {
  const walk = walkOf(line, whole);
  return settled((): DeltaSpan => {
    const { start, end } = walk.deltaArray();
    return start === null ? { kind: "cut" } : { kind: "delta", delta: { start, end } };
  });
}
