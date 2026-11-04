import { describe, expect, test } from "vitest";

import {
  mapOpencode2Status,
  opencode2StatusSince,
  type Opencode2TurnFields,
} from "@core/mapping/opencode/opencode2Mapping";
import type { SessionStatus } from "@core/sessions/session";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const MINUTE = 60_000;

const turn = (fields: Partial<Opencode2TurnFields> = {}): Opencode2TurnFields => ({
  claimedAt: null,
  idleAt: null,
  outcome: null,
  ...fields,
});

describe("mapOpencode2Status", () => {
  const table: [string, Opencode2TurnFields, SessionStatus, SessionStatus][] = [
    ["no turn yet, as for a session just made or copied", turn(), "idle", "finished"],
    ["a turn holds its claim", turn({ claimedAt: NOW }), "working", "finished"],
    [
      "a turn that follows one that failed",
      turn({ claimedAt: NOW, idleAt: NOW - MINUTE, outcome: "failed" }),
      "working",
      "finished",
    ],
    [
      "a turn that was cut off, with an outcome of a kind not yet known",
      turn({ claimedAt: NOW, outcome: "abandoned" }),
      "working",
      "finished",
    ],
    ["a turn that succeeded", turn({ idleAt: NOW, outcome: "succeeded" }), "idle", "finished"],
    ["a turn that was stopped", turn({ idleAt: NOW, outcome: "interrupted" }), "idle", "finished"],
    ["a turn that failed", turn({ idleAt: NOW, outcome: "failed" }), "failed", "failed"],
    ["an outcome not known", turn({ idleAt: NOW, outcome: "abandoned" }), "unknown", "unknown"],
    ["an outcome of the wrong type", turn({ outcome: 5 }), "unknown", "unknown"],
    ["an outcome too long to keep", turn({ outcome: undefined }), "unknown", "unknown"],
    ["a claim of the wrong type", turn({ claimedAt: "other" }), "unknown", "unknown"],
    ["an end of the wrong type", turn({ idleAt: "other" }), "unknown", "unknown"],
    [
      "a claim with an end of the wrong type",
      turn({ claimedAt: NOW, idleAt: "other" }),
      "working",
      "finished",
    ],
    ["a claim that is no whole number", turn({ claimedAt: 1.5 }), "unknown", "unknown"],
    [
      "a claim too large to be a time",
      turn({ claimedAt: Number.MAX_SAFE_INTEGER + 2 }),
      "unknown",
      "unknown",
    ],
    [
      "an end too large to be a time",
      turn({ idleAt: Number.MAX_SAFE_INTEGER + 2 }),
      "unknown",
      "unknown",
    ],
  ];

  test.each(table)("%s", (_name, row, open, closed) => {
    expect(mapOpencode2Status({ turn: row, open: true })).toBe(open);
    expect(mapOpencode2Status({ turn: row, open: false })).toBe(closed);
  });

  test("never says a session needs you, since OpenCode 2 keeps its waits in memory", () => {
    for (const [, row] of table) {
      expect(mapOpencode2Status({ turn: row, open: true })).not.toBe("needs-you");
    }
  });
});

describe("opencode2StatusSince", () => {
  const activityAt = NOW - 2 * MINUTE;

  test("working: when the turn took its claim", () => {
    expect(
      opencode2StatusSince(
        "working",
        { turn: turn({ claimedAt: NOW - 5 * MINUTE }), activityAt },
        NOW,
      ),
    ).toBe(NOW - 5 * MINUTE);
  });

  test("idle and failed: when the turn ended, else the newest write", () => {
    const ended = turn({ idleAt: NOW - 3 * MINUTE, outcome: "succeeded" });
    expect(opencode2StatusSince("idle", { turn: ended, activityAt }, NOW)).toBe(NOW - 3 * MINUTE);
    expect(opencode2StatusSince("failed", { turn: ended, activityAt }, NOW)).toBe(NOW - 3 * MINUTE);
    expect(opencode2StatusSince("idle", { turn: turn(), activityAt }, NOW)).toBe(activityAt);
  });

  test("finished, with a turn cut off: the newest write, not the end of the turn before it", () => {
    const cutOff = turn({ claimedAt: NOW - 3 * MINUTE, idleAt: NOW - 60 * MINUTE });
    expect(opencode2StatusSince("finished", { turn: cutOff, activityAt }, NOW)).toBe(activityAt);
  });

  test("a time that could not be right is not known", () => {
    const ahead = NOW + 60 * 60_000;
    expect(
      opencode2StatusSince("working", { turn: turn({ claimedAt: ahead }), activityAt }, NOW),
    ).toBeNull();
    expect(
      opencode2StatusSince("idle", { turn: turn({ idleAt: ahead }), activityAt: null }, NOW),
    ).toBeNull();
  });

  test("unknown has no time", () => {
    expect(
      opencode2StatusSince("unknown", { turn: turn({ idleAt: NOW }), activityAt }, NOW),
    ).toBeNull();
  });
});
