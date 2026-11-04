import v8 from "node:v8";
import vm from "node:vm";

import { describe, expect, test } from "vitest";

import {
  emptyFold,
  foldLine,
  openCallbacks,
  openedBy,
  pendingCallbacks,
  settledBy,
} from "@collector/adapters/mistral-vibe/callbacks";
import type { VibeCallback } from "@core/mapping/mistral-vibe/mistralVibeMapping";
import {
  callbackRegistered,
  callbackResolved,
  NOW,
  PRIVATE_WORDS,
  savedCallback,
} from "@tests/fixtures/mistralVibe";

const APPROVAL = "approval-call-1";
const QUESTION = "user-input-call-2";

const approval: VibeCallback = { id: APPROVAL, kind: "approval", createdAt: NOW - 9 };
const question: VibeCallback = { id: QUESTION, kind: "user_input", createdAt: NOW - 5 };

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
    ]);
    expect(kept.flat()).not.toContain(null);
    // Each whole string, if any part held on to it, would be a mebibyte.
    expect(heldBytes() - before).toBeLessThan(16 * MIB);
    expect(kept).toHaveLength(64);
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
