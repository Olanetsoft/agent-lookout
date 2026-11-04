import { describe, expect, test } from "vitest";

import {
  continuedKimiCodeWait,
  kimiCodeWaitOf,
  mapKimiCodeStatus,
  type KimiCodeInteraction,
  type KimiCodeWait,
} from "@core/mapping/kimi-code/kimiCodeMapping";

describe("mapKimiCodeStatus", () => {
  const status = (fields: Partial<Parameters<typeof mapKimiCodeStatus>[0]> = {}) =>
    mapKimiCodeStatus({
      held: false,
      waiting: false,
      lastHolderRuns: false,
      lastTurnFailed: false,
      ...fields,
    });

  test("a lock a process that runs holds is working, or needs-you while a wait stands", () => {
    expect(status({ held: true })).toBe("working");
    expect(status({ held: true, waiting: true })).toBe("needs-you");
  });

  test("a lock held outranks how the last turn ended, since a new turn is under way", () => {
    expect(status({ held: true, lastTurnFailed: true })).toBe("working");
    expect(status({ held: true, waiting: true, lastTurnFailed: true })).toBe("needs-you");
  });

  test("a wait with no lock held counts for nothing: a crash can leave one in the file", () => {
    expect(status({ waiting: true })).toBe("finished");
    expect(status({ waiting: true, lastHolderRuns: true })).toBe("idle");
  });

  test("with no lock held, a failed last turn is failed, whether or not its process runs", () => {
    expect(status({ lastTurnFailed: true })).toBe("failed");
    expect(status({ lastTurnFailed: true, lastHolderRuns: true })).toBe("failed");
  });

  test("with no lock held, it is idle while its last holder runs, and finished after", () => {
    expect(status({ lastHolderRuns: true })).toBe("idle");
    expect(status()).toBe("finished");
  });
});

describe("kimiCodeWaitOf", () => {
  const LOCKED_AT = 1_000_000;
  const approval = (id: string, at: number): KimiCodeInteraction => ({ id, kind: "approval", at });
  const question = (id: string, at: number): KimiCodeInteraction => ({ id, kind: "question", at });

  test("nothing open is no wait", () => {
    expect(kimiCodeWaitOf([], LOCKED_AT)).toBeNull();
  });

  test("an approval is a wait for permission, and a question a wait for an answer", () => {
    expect(kimiCodeWaitOf([approval("a", LOCKED_AT + 5)], LOCKED_AT)).toEqual({
      reason: "permission",
      since: LOCKED_AT + 5,
      ids: ["a"],
    });
    expect(kimiCodeWaitOf([question("q", LOCKED_AT)], LOCKED_AT)).toEqual({
      reason: "question",
      since: LOCKED_AT,
      ids: ["q"],
    });
  });

  test("one asked before the lock was taken is an earlier process's, left behind", () => {
    expect(kimiCodeWaitOf([approval("a", LOCKED_AT - 1)], LOCKED_AT)).toBeNull();
    expect(
      kimiCodeWaitOf([approval("old", LOCKED_AT - 1), question("q", LOCKED_AT + 1)], LOCKED_AT),
    ).toEqual({ reason: "question", since: LOCKED_AT + 1, ids: ["q"] });
  });

  test("with two open the reason is the approval's, in either order, and the time the oldest's", () => {
    const first = [question("q", LOCKED_AT + 1), approval("a", LOCKED_AT + 2)];
    expect(kimiCodeWaitOf(first, LOCKED_AT)).toEqual({
      reason: "permission",
      since: LOCKED_AT + 1,
      ids: ["q", "a"],
    });
    const second = [approval("a", LOCKED_AT + 1), question("q", LOCKED_AT + 2)];
    expect(kimiCodeWaitOf(second, LOCKED_AT)?.reason).toBe("permission");
  });
});

describe("continuedKimiCodeWait", () => {
  const wait = (since: number, ids: string[]): KimiCodeWait => ({
    reason: "permission",
    since,
    ids,
  });

  test("the first wait is itself", () => {
    expect(continuedKimiCodeWait(undefined, wait(5, ["a"]))).toEqual(wait(5, ["a"]));
  });

  test("settling the older of two keeps the time the wait began", () => {
    expect(continuedKimiCodeWait(wait(5, ["a", "b"]), wait(9, ["b"]))).toEqual(wait(5, ["b"]));
  });

  test("a wait that shares nothing with the one before is new, however soon it came", () => {
    expect(continuedKimiCodeWait(wait(5, ["a"]), wait(9, ["b"]))).toEqual(wait(9, ["b"]));
  });
});
