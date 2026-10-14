import { describe, expect, test } from "vitest";

import {
  isMistralVibeUserSession,
  mapMistralVibeStatus,
  vibeLeaseHeld,
  type VibeHeld,
} from "@core/mapping/mistral-vibe/mistralVibeMapping";

const HELD: VibeHeld[] = [true, false, "unknown"];

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

  test("a wait Vibe holds only in memory, blocked, shows as working until Needs you is read, and finishes once let go", () => {
    expect(mapMistralVibeStatus({ statusType: "blocked", held: true })).toBe("working");
    expect(mapMistralVibeStatus({ statusType: "blocked", held: "unknown" })).toBe("working");
    expect(mapMistralVibeStatus({ statusType: "blocked", held: false })).toBe("finished");
  });

  test("no status never needs you", () => {
    for (const statusType of ["idle", "running", "blocked", "failed", "archived", undefined]) {
      for (const held of HELD) {
        expect(mapMistralVibeStatus({ statusType, held })).not.toBe("needs-you");
      }
    }
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
