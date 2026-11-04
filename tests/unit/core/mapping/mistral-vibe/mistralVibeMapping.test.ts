import { describe, expect, test } from "vitest";

import {
  continuedVibeWait,
  isMistralVibeUserSession,
  isVibeTurnInFlight,
  mapMistralVibeStatus,
  vibeLeaseHeld,
  vibeWaitOf,
  type VibeCallback,
  type VibeHeld,
  type VibeWait,
  type VibeWaitFields,
} from "@core/mapping/mistral-vibe/mistralVibeMapping";

const HELD: VibeHeld[] = [true, false, "unknown"];

const LEASE_TAKEN = 1_000_000;
const TURN_BEGAN = 2_000_000;

const approval = (createdAt: number, id = "approval-call-1"): VibeCallback => ({
  id,
  kind: "approval",
  createdAt,
});

const question = (createdAt: number, id = "user-input-call-1"): VibeCallback => ({
  id,
  kind: "user_input",
  createdAt,
});

function wait(callbacks: VibeCallback[], fields: Partial<VibeWaitFields> = {}) {
  return vibeWaitOf({
    callbacks,
    statusType: "running",
    held: true,
    leaseTakenAt: LEASE_TAKEN,
    turnStartedAt: TURN_BEGAN,
    ...fields,
  });
}

describe("what a Vibe session waits for", () => {
  test("an approval is a wait for permission and a question is one for an answer, from when Vibe asked", () => {
    expect(wait([approval(TURN_BEGAN + 5)])).toEqual({
      reason: "permission",
      since: TURN_BEGAN + 5,
      ids: ["approval-call-1"],
    });
    expect(wait([question(TURN_BEGAN + 5)])).toEqual({
      reason: "question",
      since: TURN_BEGAN + 5,
      ids: ["user-input-call-1"],
    });
    expect(wait([])).toBeNull();
  });

  test("a kind this mapping does not know is no wait", () => {
    expect(wait([{ id: "tool-1", kind: "client_tool", createdAt: TURN_BEGAN + 5 }])).toBeNull();
    expect(
      wait([{ id: "constructor", kind: "constructor", createdAt: TURN_BEGAN + 5 }]),
    ).toBeNull();
  });

  test("a kind this mapping does not know neither hides a wait beside it nor gives it a time", () => {
    const other = (createdAt: number) => ({
      id: `tool-${createdAt}`,
      kind: "client_tool",
      createdAt,
    });
    expect(wait([other(TURN_BEGAN + 1), approval(TURN_BEGAN + 5), other(TURN_BEGAN + 9)])).toEqual({
      reason: "permission",
      since: TURN_BEGAN + 5,
      ids: ["approval-call-1"],
    });
  });

  test("it needs a program that holds the session, by a lease that says when it was taken", () => {
    const open = [approval(TURN_BEGAN + 5)];
    expect(wait(open, { held: false })).toBeNull();
    expect(wait(open, { held: "unknown" })).toBeNull();
    expect(wait(open, { leaseTakenAt: null })).toBeNull();
  });

  test("it needs a turn in flight, the only time Vibe counts an open callback", () => {
    const open = [approval(TURN_BEGAN + 5)];
    expect(wait(open, { statusType: "blocked" })).not.toBeNull();
    for (const statusType of ["idle", "failed", "archived", "paused", undefined, 3]) {
      expect(wait(open, { statusType }), String(statusType)).toBeNull();
      expect(isVibeTurnInFlight(statusType)).toBe(false);
    }
  });

  test("what an earlier program opened is left behind, though it stays open on disk", () => {
    const reopened = { leaseTakenAt: TURN_BEGAN + 60 };
    expect(wait([question(TURN_BEGAN + 5)], reopened)).toBeNull();
    expect(wait([question(TURN_BEGAN + 60)], reopened)).not.toBeNull();
  });

  test("what an earlier turn opened is left behind, and with no time for the turn only the lease decides", () => {
    expect(wait([approval(TURN_BEGAN - 5)])).toBeNull();
    expect(wait([approval(TURN_BEGAN)])).not.toBeNull();
    expect(wait([approval(LEASE_TAKEN + 5)], { turnStartedAt: null })).not.toBeNull();
    expect(wait([approval(LEASE_TAKEN - 5)], { turnStartedAt: null })).toBeNull();
  });

  test("with two open, the reason is the newest's and the time the oldest's, in whatever order they come", () => {
    const first = approval(TURN_BEGAN + 5);
    const second = question(TURN_BEGAN + 9);
    const both = { reason: "question", since: TURN_BEGAN + 5 };
    expect(wait([first, second])).toMatchObject(both);
    expect(wait([second, first])).toMatchObject(both);
    expect(wait([first])).toMatchObject({ reason: "permission", since: TURN_BEGAN + 5 });
    expect(wait([second])).toMatchObject({ reason: "question", since: TURN_BEGAN + 9 });
  });

  test("of two opened in one millisecond, the reason is the later one's, as Vibe takes it", () => {
    expect(wait([approval(TURN_BEGAN + 5), question(TURN_BEGAN + 5)])).toMatchObject({
      reason: "question",
    });
  });

  test("a left-behind callback neither gives the time nor the reason of one that stands", () => {
    expect(wait([question(TURN_BEGAN - 5), approval(TURN_BEGAN + 5)])).toEqual({
      reason: "permission",
      since: TURN_BEGAN + 5,
      ids: ["approval-call-1"],
    });
  });
});

describe("a Vibe wait from one poll to the next", () => {
  const before: VibeWait = { reason: "permission", since: 100, ids: ["a", "b"] };

  test("keeps the time it began for as long as any callback it hung on stands", () => {
    const left: VibeWait = { reason: "question", since: 110, ids: ["b"] };
    expect(continuedVibeWait(before, left)).toEqual({ ...left, since: 100 });
    expect(
      continuedVibeWait(before, { reason: "question", since: 110, ids: ["b", "c"] }).since,
    ).toBe(100);
    expect(
      continuedVibeWait(
        { reason: "question", since: 110, ids: ["b"] },
        { reason: "permission", since: 100, ids: ["a", "b"] },
      ).since,
    ).toBe(100);
  });

  test("is new when it shares no callback with the one before, however soon it came", () => {
    const next: VibeWait = { reason: "question", since: 110, ids: ["c"] };
    expect(continuedVibeWait(before, next)).toEqual(next);
  });

  test("with none before, is as the poll found it", () => {
    expect(continuedVibeWait(undefined, before)).toEqual(before);
  });
});

describe("a Vibe session's status", () => {
  test.each([
    ["running", true, "working"],
    ["running", "unknown", "working"],
    ["running", false, "finished"],
    ["idle", true, "idle"],
    ["idle", "unknown", "idle"],
    ["idle", false, "finished"],
    ["failed", true, "failed"],
    ["failed", "unknown", "failed"],
    ["failed", false, "failed"],
  ] as const)("%s, held %s, is %s", (statusType, held, status) => {
    expect(mapMistralVibeStatus({ statusType, held })).toBe(status);
  });

  test("a wait Vibe holds only in memory, blocked, shows as working with no callback read, and finishes once let go", () => {
    expect(mapMistralVibeStatus({ statusType: "blocked", held: true })).toBe("working");
    expect(mapMistralVibeStatus({ statusType: "blocked", held: "unknown" })).toBe("working");
    expect(mapMistralVibeStatus({ statusType: "blocked", held: false })).toBe("finished");
  });

  test("with no wait found, no status needs you", () => {
    for (const statusType of ["idle", "running", "blocked", "failed", "archived", undefined]) {
      for (const held of HELD) {
        expect(mapMistralVibeStatus({ statusType, held })).not.toBe("needs-you");
      }
    }
  });

  test("a wait needs you only with a turn in flight in a session a program holds", () => {
    const waiting = (statusType: unknown, held: VibeHeld, tooNew?: boolean) =>
      mapMistralVibeStatus({ statusType, held, tooNew, waiting: true });
    expect(waiting("running", true)).toBe("needs-you");
    expect(waiting("blocked", true)).toBe("needs-you");
    expect(waiting("running", "unknown")).toBe("working");
    expect(waiting("running", false)).toBe("finished");
    expect(waiting("idle", true)).toBe("idle");
    expect(waiting("failed", true)).toBe("failed");
    expect(waiting("archived", true)).toBe("unknown");
    expect(waiting("running", true, true)).toBe("unknown");
  });

  test("a state that was not read, a word Vibe uses only between its programs, or one it may add later, is not known", () => {
    for (const held of HELD) {
      for (const statusType of [undefined, null, 3, "", "archived", "paused", "Running"]) {
        expect(mapMistralVibeStatus({ statusType, held })).toBe("unknown");
      }
    }
  });

  test("a store a newer Vibe wrote has no status, whatever it says", () => {
    for (const held of HELD) {
      for (const statusType of ["idle", "running", "failed"]) {
        expect(mapMistralVibeStatus({ statusType, held, tooNew: true })).toBe("unknown");
      }
    }
  });
});

describe("whether a lease is held", () => {
  test("with no folder of leases to list, it is not known", () => {
    for (const locked of [true, false]) {
      for (const alive of [true, false, null]) {
        expect(vibeLeaseHeld({ leaseFolder: false, locked, alive })).toBe("unknown");
      }
    }
  });

  test("with no lock, it is not held, whatever a leftover pid says", () => {
    for (const alive of [true, false, null]) {
      expect(vibeLeaseHeld({ leaseFolder: true, locked: false, alive })).toBe(false);
    }
  });

  test("with a lock, it is held while its pid runs, or while its pid is still being written", () => {
    expect(vibeLeaseHeld({ leaseFolder: true, locked: true, alive: true })).toBe(true);
    expect(vibeLeaseHeld({ leaseFolder: true, locked: true, alive: null })).toBe(true);
  });

  test("a lock whose pid no longer runs was left behind by a program that crashed", () => {
    expect(vibeLeaseHeld({ leaseFolder: true, locked: true, alive: false })).toBe(false);
  });
});

describe("which sessions a person looks for", () => {
  test("a session of its own and a fork are, a subagent is not", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(isMistralVibeUserSession(id, "root")).toBe(true);
    expect(isMistralVibeUserSession(id, "fork")).toBe(true);
    expect(isMistralVibeUserSession(id, "subagent")).toBe(false);
  });

  test("an id Vibe gives subagents is a subagent's, whatever its store says", () => {
    expect(isMistralVibeUserSession("child-000000000000000000000001", "root")).toBe(false);
    expect(isMistralVibeUserSession("child-000000000000000000000001")).toBe(false);
  });

  test("a session whose kind is missing or unfamiliar is kept", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(isMistralVibeUserSession(id)).toBe(true);
    expect(isMistralVibeUserSession(id, null)).toBe(true);
    expect(isMistralVibeUserSession(id, "helper")).toBe(true);
  });
});
