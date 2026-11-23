import v8 from "node:v8";
import vm from "node:vm";

import { describe, expect, test, vi } from "vitest";

import {
  emptyFold,
  foldLine,
  openCallbacks,
  openedBy,
  pendingCallbacks,
  resumedBy,
  settledBy,
} from "@collector/adapters/mistral-vibe/callbacks";
import type { VibeCallback } from "@core/mapping/mistral-vibe/mistralVibeMapping";
import {
  appendStep,
  callbackRegistered,
  callbackResolved,
  canonical,
  checkpointEntry,
  effectEntry,
  historyDelta,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  resumedEntry,
  resumedRecord,
  savedCallback,
  sessionId,
  userEntry,
  type StateFields,
} from "@tests/fixtures/mistralVibe";

const APPROVAL = "approval-call-1";
const QUESTION = "user-input-call-2";

const approval: VibeCallback = { id: APPROVAL, kind: "approval", createdAt: NOW - 9 };
const question: VibeCallback = { id: QUESTION, kind: "user_input", createdAt: NOW - 5 };

/** A mark's line up to the end of its first step. */
const STEP_END = '},"op":"append_entry"}';
const stepOf = (line: string) => line.slice(0, line.indexOf(STEP_END) + STEP_END.length);

describe("the start of a callback's record", () => {
  test("says which callback was opened, of what kind, and when", () => {
    expect(openedBy(callbackRegistered(7, { id: APPROVAL, createdAt: NOW - 9 }))).toEqual({
      opened: approval,
    });
    expect(
      openedBy(callbackRegistered(7, { id: QUESTION, kind: "user_input", createdAt: NOW - 5 })),
    ).toEqual({ opened: question });
  });

  test("says which callback was settled, however it was", () => {
    expect(settledBy(callbackResolved(8, APPROVAL))).toEqual({ settled: APPROVAL });
    expect(
      settledBy(callbackResolved(8, APPROVAL, "failed", { code: "callback_closed", message: "" })),
    ).toEqual({ settled: APPROVAL });
  });

  test("is enough: nothing after the time is looked at", () => {
    const line = callbackRegistered(7, { id: APPROVAL, createdAt: NOW - 9 });
    const head = line.slice(0, line.indexOf('"detail"'));
    expect(head).not.toContain(PRIVATE_WORDS);
    expect(openedBy(head)).toEqual({ opened: approval });
  });

  test("with an escaped id or one too long, another key before the time, or a time that is missing, is not a whole number or is too large, says nothing", () => {
    const registered = (routing: string) =>
      `{"payload":{"callback_id":"a","kind":"approval","routing":{${routing}`;
    expect(openedBy(registered('"callbackId":"a","createdAt":1730000000000,'))).not.toBeNull();
    expect(openedBy(registered('"callbackId":"a","title":"x",'))).toBeNull();
    expect(openedBy(registered('"callbackId":"a","createdAt":"1730000000000",'))).toBeNull();
    expect(openedBy(registered('"callbackId":"a","createdAt":9999999999999999,'))).toBeNull();
    expect(openedBy(registered('"callbackId":"a","createdAt":1730000000000.5,'))).toBeNull();
    expect(openedBy(registered('"title":"x","createdAt":1730000000000,'))).toBeNull();
    expect(
      openedBy(registered('"callbackId":"a","title":"x","createdAt":1730000000000,')),
    ).toBeNull();
    const long = "x".repeat(257);
    expect(openedBy(registered(`"callbackId":"${long}","createdAt":1730000000000,`))).toBeNull();
    expect(
      openedBy(
        `{"payload":{"callback_id":"${long}","kind":"approval","routing":{"callbackId":"a","createdAt":1730000000000,`,
      ),
    ).toBeNull();
    expect(settledBy(`{"payload":{"callback_id":"${long}","result":null`)).toBeNull();
    expect(openedBy('{"payload":{"callback_id":"a\\"b","kind":"approval","routing":{')).toBeNull();
    expect(settledBy('{"payload":{"callback_id":"a\\"b","result":null')).toBeNull();
    expect(openedBy('{"payload":{"action_id":"a"')).toBeNull();
    expect(settledBy("not a record")).toBeNull();
  });
});

describe("the start of the mark Vibe 3.1.4 journals as it takes up a turn after a restart", () => {
  const RUNNING: StateFields = {
    id: sessionId("a1"),
    status: "running",
    turn: { status: "in_progress", startedAt: NOW - 5 * MINUTE },
  };
  const bytes = (text: string) => Buffer.from(text.replace(/\n$/, ""));
  const MARKED = NOW - 20_000;

  test("says which turn was taken up, and when", () => {
    expect(resumedBy(bytes(resumedRecord(7, RUNNING, MARKED)))).toEqual({
      resumed: { turnId: "turn-1", at: MARKED },
    });
    expect(resumedBy(bytes(resumedRecord(7, RUNNING, MARKED, "turn-9", 3)))).toEqual({
      resumed: { turnId: "turn-9", at: MARKED },
    });
  });

  test("is read the same when the mark is the record's only step", () => {
    const alone = historyDelta(7, [appendStep(resumedEntry(MARKED))]);
    expect(resumedBy(bytes(alone))).toEqual({ resumed: { turnId: "turn-1", at: MARKED } });
  });

  test("a record whose first step is any other entry says nothing", () => {
    const first = (entry: unknown) =>
      resumedBy(bytes(historyDelta(7, [appendStep(entry)], { state: RUNNING })));
    expect(first(effectEntry("effect-1"))).toBeNull();
    expect(first(checkpointEntry("checkpoint-rewind-1"))).toBeNull();
    expect(first(userEntry("user-1"))).toBeNull();
    expect(first({ ...resumedEntry(MARKED), kind: "rewind" })).toBeNull();
    expect(first({ ...resumedEntry(MARKED), message: PRIVATE_WORDS })).toBeNull();
    expect(first({ ...resumedEntry(MARKED), details: { note: PRIVATE_WORDS } })).toBeNull();
    expect(first({ ...resumedEntry(MARKED), createdAt: 1e16 })).toBeNull();
    expect(first({ ...resumedEntry(MARKED), createdAt: 2 ** 53 })).toBeNull();
    expect(first({ ...resumedEntry(MARKED), createdAt: MARKED + 0.5 })).toBeNull();
    expect(first({ ...resumedEntry(MARKED), turnId: null })).toBeNull();
  });

  test("a mark that is not the first step, or the mark's words in a prompt, say nothing", () => {
    const second = historyDelta(7, [
      appendStep(userEntry("user-1")),
      appendStep(resumedEntry(MARKED)),
    ]);
    expect(resumedBy(bytes(second))).toBeNull();
    const quoted = userEntry("user-1", canonical(appendStep(resumedEntry(MARKED))));
    expect(resumedBy(bytes(historyDelta(7, [appendStep(quoted)])))).toBeNull();
  });

  test("a record that is not laid out as Vibe writes one says nothing", () => {
    expect(resumedBy(bytes("not a record"))).toBeNull();
    expect(resumedBy(bytes('{"payload":{"delta":[{"entry":{"createdAt":'))).toBeNull();
    expect(resumedBy(bytes(resumedRecord(7, RUNNING, MARKED).slice(0, 200)))).toBeNull();
    const step = stepOf(resumedRecord(7, RUNNING, MARKED));
    expect(resumedBy(bytes(step))).toBeNull();
    expect(resumedBy(bytes(`${step}x`))).toBeNull();
  });
});

describe("what of a `projection_delta` line is turned into text", () => {
  const RUNNING: StateFields = {
    id: sessionId("a1"),
    status: "running",
    turn: { status: "in_progress", startedAt: NOW - 5 * MINUTE },
  };
  const MARKED = NOW - 20_000;

  /** What `resumedBy` says of a line, and the text it made of that line's bytes. */
  function decodedOf(line: string) {
    const own = new TextEncoder().encode(line.replace(/\n$/, ""));
    const decoded: string[] = [];
    const toText = Buffer.prototype.toString;
    const spy = vi.spyOn(Buffer.prototype, "toString").mockImplementation(function (
      this: Buffer,
      encoding,
      start,
      end,
    ) {
      const text = toText.call(this, encoding, start, end);
      if (this.buffer === own.buffer) decoded.push(text);
      return text;
    });
    try {
      return { said: resumedBy(own), decoded };
    } finally {
      spy.mockRestore();
    }
  }

  test("of the mark, only its own step, never the state after it, which holds the first thing asked", () => {
    const line = resumedRecord(7, RUNNING, MARKED);
    expect(line.indexOf(PRIVATE_WORDS)).toBeGreaterThan(stepOf(line).length);
    const { said, decoded } = decodedOf(line);
    expect(said).toEqual({ resumed: { turnId: "turn-1", at: MARKED } });
    expect(decoded).toEqual([stepOf(line)]);
  });

  test("of a line whose first step is not the mark, nothing", () => {
    const first = (entry: unknown) =>
      decodedOf(historyDelta(7, [appendStep(entry)], { state: RUNNING }));
    // An entry that is not the mark from its first byte, though it is from its time on.
    const { createdAt, ...rest } = resumedEntry(MARKED);
    for (const entry of [
      effectEntry("effect-1"),
      checkpointEntry("checkpoint-rewind-1"),
      userEntry("user-1"),
      { ...rest, createdBy: createdAt },
    ]) {
      expect(first(entry)).toEqual({ said: null, decoded: [] });
    }
  });

  test("of a mark whose step does not end within the first 1 KiB, nothing", () => {
    const long = { ...resumedEntry(MARKED), sessionId: "s".repeat(1100) };
    expect(decodedOf(historyDelta(7, [appendStep(long)], { state: RUNNING }))).toEqual({
      said: null,
      decoded: [],
    });
  });
});

describe("what is kept of a line's start", () => {
  const MIB = 1024 * 1024;

  /** A string as a read of a file makes one: flat, and as long as a mebibyte. */
  const lineStart = (start: string) => Buffer.from(start.padEnd(MIB, "x")).toString();

  /** How much is in use once all that can go has gone. */
  function heldBytes() {
    v8.setFlagsFromString("--expose-gc");
    (vm.runInNewContext("gc") as () => void)();
    return process.memoryUsage().heapUsed;
  }

  test("holds on to none of the rest, which can say what a person wrote", () => {
    const before = heldBytes();
    const kept = Array.from({ length: 64 }, (_, index) => [
      openedBy(
        lineStart(
          `{"payload":{"callback_id":"approval-call-${index}","kind":"a_kind_a_newer_vibe_writes","routing":{"callbackId":"approval-call-${index}","createdAt":1730000000000,"detail":`,
        ),
      ),
      settledBy(lineStart(`{"payload":{"callback_id":"approval-call-${index}","result":`)),
      resumedBy(
        Buffer.from(
          historyDelta(7, [appendStep(resumedEntry(NOW, `turn-of-a-long-name-${index}`))]).padEnd(
            MIB,
            "x",
          ),
        ),
      ),
    ]);
    expect(kept.flat()).not.toContain(null);
    // Each whole string, if any part held on to it, would be a mebibyte.
    expect(heldBytes() - before).toBeLessThan(16 * MIB);
    expect(kept).toHaveLength(64);
  });

  test("keeps a mark's turn apart from the text of the step it was read from", () => {
    const count = 32_768;
    const before = heldBytes();
    const kept = Array.from({ length: count }, (_, index) =>
      resumedBy(
        Buffer.from(
          historyDelta(7, [
            appendStep({
              ...resumedEntry(NOW, `turn-of-a-long-name-${index}`),
              sessionId: "s".repeat(128),
            }),
          ]),
        ),
      ),
    );
    expect(kept).not.toContain(null);
    // A turn's id that held on to its step would keep some 470 bytes more each, 15 MiB in all.
    expect(heldBytes() - before).toBeLessThan(8 * MIB);
    expect(kept).toHaveLength(count);
  });
});

describe("what a segment's lines say", () => {
  test("a callback is open from the line that opens it to the line that settles it", () => {
    const fold = emptyFold(true);
    foldLine(fold, { opened: approval });
    expect([...fold.open.values()]).toEqual([approval]);
    foldLine(fold, { settled: APPROVAL });
    expect(fold.open.size).toBe(0);
    expect(fold.settled.size).toBe(0);
  });

  test("a callback settled with no line that opens it was opened before those lines", () => {
    const fold = emptyFold(true);
    foldLine(fold, { settled: APPROVAL });
    expect(fold.settled).toEqual(new Set([APPROVAL]));
  });

  test("the newest mark of a turn taken up stands, and opens or settles nothing", () => {
    const fold = emptyFold(true);
    expect(fold.resumed).toBeNull();
    foldLine(fold, { opened: approval });
    foldLine(fold, { resumed: { turnId: "turn-1", at: NOW - 9 } });
    foldLine(fold, { resumed: { turnId: "turn-1", at: NOW - 2 } });
    expect(fold.resumed).toEqual({ turnId: "turn-1", at: NOW - 2 });
    expect([...fold.open.values()]).toEqual([approval]);
    expect(fold.settled.size).toBe(0);
  });
});

describe("what is open", () => {
  test("is what the generation saved and the segment has not settled, and what the segment opened", () => {
    const fold = emptyFold(true);
    foldLine(fold, { opened: question });
    expect(openCallbacks([approval], fold)).toEqual([approval, question]);
    foldLine(fold, { settled: APPROVAL });
    expect(openCallbacks([approval], fold)).toEqual([question]);
  });

  test("a saved callback the segment opens again is taken once, by the newer record", () => {
    const fold = emptyFold(true);
    foldLine(fold, { opened: { ...approval, createdAt: NOW } });
    expect(openCallbacks([approval], fold)).toEqual([{ ...approval, createdAt: NOW }]);
  });

  test("with the segment's start not read, a saved callback may have been settled, so it is not taken as open", () => {
    const fold = emptyFold(false);
    foldLine(fold, { opened: question });
    expect(openCallbacks([approval], fold)).toEqual([question]);
  });
});

describe("the callbacks a generation saved", () => {
  test("keep only a pending one's id, kind and time", () => {
    const pending = pendingCallbacks([
      savedCallback({ id: APPROVAL, createdAt: NOW - 9 }),
      savedCallback({ id: QUESTION, kind: "user_input", createdAt: NOW - 5 }),
    ]);
    expect(pending).toEqual([approval, question]);
    expect(JSON.stringify(pending)).not.toContain(PRIVATE_WORDS);
  });

  test("leave out one settled, and one not as Vibe writes it", () => {
    const pending = savedCallback({ id: APPROVAL, createdAt: NOW - 9 });
    expect(
      pendingCallbacks([
        { ...pending, state: "resolved" },
        { ...pending, state: "failed" },
        { ...pending, callback_id: "" },
        { ...pending, callback_id: "x".repeat(257) },
        { ...pending, callback_id: 7 },
        { ...pending, kind: "" },
        { ...pending, kind: "k".repeat(65) },
        { ...pending, kind: null },
        { ...pending, routing: null },
        { ...pending, routing: {} },
        { ...pending, routing: { createdAt: "soon" } },
        { ...pending, routing: { createdAt: 1.5 } },
        "not a callback",
        null,
      ]),
    ).toEqual([]);
  });

  test("are none when the field is missing or not a list", () => {
    expect(pendingCallbacks(undefined)).toEqual([]);
    expect(pendingCallbacks({ callback_id: APPROVAL })).toEqual([]);
  });
});
