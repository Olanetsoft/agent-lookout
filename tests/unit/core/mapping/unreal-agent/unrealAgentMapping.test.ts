import { describe, expect, test } from "vitest";

import type { UnrealAgentLiveness } from "@core/mapping/unreal-agent/unrealAgentLiveness";
import {
  mapUnrealAgentStatus,
  REPLY_SETTLE_MS,
  unrealAgentEnded,
  unrealAgentPhaseNow,
} from "@core/mapping/unreal-agent/unrealAgentMapping";
import {
  applyUnrealAgentLine,
  startUnrealAgentReplay,
  type UnrealAgentItem,
  type UnrealAgentReplay,
} from "@core/mapping/unreal-agent/unrealAgentReplay";

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TURN = "00000003-c3d4-4e5f-8a9b-000000000001";
const OP = "00000005-c3d4-4e5f-8a9b-000000000001";

function replayOf(items: UnrealAgentItem[], fromStart = true): UnrealAgentReplay {
  const replay = startUnrealAgentReplay(fromStart);
  items.forEach((item, index) =>
    applyUnrealAgentLine(replay, {
      kind: "item",
      sequence: (fromStart ? 1 : 20) + index,
      at: NOW - 10 * MINUTE + index * SECOND,
      item,
    }),
  );
  return replay;
}

const settings: UnrealAgentItem = { kind: "input", input: "settings" };
const whenIdle: UnrealAgentItem = { kind: "input", input: "when_idle" };
const hard: UnrealAgentItem = { kind: "input", input: "hard" };
const turn: UnrealAgentItem = { kind: "turn", id: TURN, type: "regular" };
const reply = (outcome: "complete" | "failed" | "unclear"): UnrealAgentItem => ({
  kind: "reply",
  turnId: TURN,
  outcome,
});
const created: UnrealAgentItem = { kind: "status-created", ids: [OP] };

/** Written a minute ago, past the settle time, unless a test says otherwise. */
const status = (
  replay: UnrealAgentReplay,
  liveness: UnrealAgentLiveness,
  writtenAt = NOW - MINUTE,
) => mapUnrealAgentStatus({ replay, liveness, writtenAt, now: NOW });

const busy = replayOf([settings, turn]);
const idle = replayOf([settings, turn, reply("complete")]);
const failed = replayOf([settings, turn, reply("failed")]);
const unclear = replayOf([settings, turn, reply("unclear")]);
const unsure = replayOf([turn, reply("complete")], false);
const unread = replayOf([settings, { kind: "unread" }]);

describe("Table C, the status", () => {
  test("a line not read is unknown, whatever else holds", () => {
    for (const liveness of ["closed", "may-be-open", "cannot-tell"] as const) {
      expect(status(unread, liveness)).toBe("unknown");
    }
  });

  test("a waiting session whose reply failed is failed, closed or not", () => {
    for (const liveness of ["closed", "may-be-open", "cannot-tell"] as const) {
      expect(status(failed, liveness)).toBe("failed");
    }
  });

  test("a waiting session whose reply is unclear, or an unsure one whose reply failed or is unclear, is unknown", () => {
    for (const liveness of ["closed", "may-be-open", "cannot-tell"] as const) {
      expect(status(unclear, liveness)).toBe("unknown");
      expect(status(replayOf([turn, reply("failed")], false), liveness)).toBe("unknown");
      expect(status(replayOf([turn, reply("unclear")], false), liveness)).toBe("unknown");
    }
  });

  test("a session that ended is finished, whatever the programs", () => {
    const stopped = replayOf([settings, turn, reply("complete"), hard]);
    const runner = replayOf([settings, whenIdle, turn, reply("complete")]);
    for (const liveness of ["closed", "may-be-open", "cannot-tell"] as const) {
      expect(status(stopped, liveness)).toBe("finished");
      expect(status(runner, liveness)).toBe("finished");
      expect(status(replayOf([settings, turn, hard]), liveness)).toBe("finished");
    }
  });

  test("a session no program could hold is finished", () => {
    expect(status(busy, "closed")).toBe("finished");
    expect(status(idle, "closed")).toBe("finished");
    expect(status(unsure, "closed")).toBe("finished");
  });

  test("a busy session is working, and unknown after 30 quiet minutes", () => {
    expect(status(busy, "may-be-open")).toBe("working");
    expect(status(busy, "cannot-tell")).toBe("working");
    expect(status(busy, "may-be-open", NOW - 29 * MINUTE)).toBe("working");
    expect(status(busy, "may-be-open", NOW - 31 * MINUTE)).toBe("unknown");
  });

  test("a busy session written more than a minute ahead of the clock is unknown", () => {
    expect(status(busy, "may-be-open", NOW + 2 * MINUTE)).toBe("unknown");
  });

  test("a waiting session is idle when a program may hold it, and unknown when that cannot be told", () => {
    expect(status(idle, "may-be-open")).toBe("idle");
    expect(status(idle, "cannot-tell")).toBe("unknown");
  });

  test("an unsure session is unknown unless it is closed", () => {
    expect(status(unsure, "may-be-open")).toBe("unknown");
    expect(status(unsure, "cannot-tell")).toBe("unknown");
  });

  test("a when_idle run that is still busy has not ended", () => {
    const working = replayOf([settings, whenIdle, turn]);
    expect(unrealAgentEnded(working, NOW - MINUTE, NOW)).toBe(false);
    expect(status(working, "may-be-open")).toBe("working");
    // A when_idle from an earlier run does not end the new one.
    const resumed = replayOf([settings, whenIdle, turn, reply("complete"), settings]);
    expect(unrealAgentEnded(resumed, NOW - MINUTE, NOW)).toBe(false);
    expect(status(resumed, "may-be-open")).toBe("idle");
  });
});

describe("a reply that is the newest line settles first", () => {
  test(`a complete reply written less than ${REPLY_SETTLE_MS} ms ago in a when_idle run is working, and then finished`, () => {
    const runner = replayOf([settings, whenIdle, turn, reply("complete")]);
    expect(status(runner, "may-be-open", NOW - 500)).toBe("working");
    expect(status(runner, "may-be-open", NOW - 3 * SECOND)).toBe("finished");
  });

  test("a reply that hit its token limit is working at first, and then failed", () => {
    const limited = replayOf([settings, turn, reply("failed")]);
    expect(status(limited, "may-be-open", NOW - 500)).toBe("working");
    expect(status(limited, "may-be-open", NOW - 3 * SECOND)).toBe("failed");
  });

  test("a reply in a session no program could hold is taken at once, as nothing more can be written", () => {
    const limited = replayOf([settings, turn, reply("failed")]);
    expect(status(limited, "closed", NOW - 500)).toBe("failed");
    expect(status(replayOf([settings, turn, reply("complete")]), "closed", NOW - 500)).toBe(
      "finished",
    );
  });

  test("a reply followed by its tool call's status does not settle: it is busy for the status", () => {
    const calling = replayOf([settings, turn, reply("complete"), created]);
    expect(unrealAgentPhaseNow(calling, NOW - 500, NOW)).toEqual({ phase: "busy", reply: null });
    expect(unrealAgentPhaseNow(calling, NOW - MINUTE, NOW)).toEqual({ phase: "busy", reply: null });
  });

  test("what the lines said at a hard stop never settles", () => {
    const stopped = replayOf([settings, turn, reply("failed"), hard]);
    expect(unrealAgentPhaseNow(stopped, NOW - 500, NOW)).toEqual({
      phase: "waiting",
      reply: "failed",
    });
    expect(status(stopped, "may-be-open", NOW - 500)).toBe("failed");
  });
});

describe("what a session goes through", () => {
  test("a model call that fails outright shows working, then unknown, then finished, never failed", () => {
    const cut = replayOf([settings, turn]);
    const shown = [
      status(cut, "may-be-open", NOW - MINUTE),
      status(cut, "may-be-open", NOW - 40 * MINUTE),
      status(cut, "closed", NOW - 50 * MINUTE),
    ];
    expect(shown).toEqual(["working", "unknown", "finished"]);
  });

  test("a hard stop after a failed reply is failed", () => {
    expect(status(replayOf([settings, turn, reply("failed"), hard]), "closed")).toBe("failed");
  });

  test("lines after a hard stop, as of commands it cancels, do not change what it said", () => {
    const stopped = replayOf([settings, turn, reply("failed"), hard]);
    applyUnrealAgentLine(stopped, { kind: "operation", id: OP, terminal: false });
    expect(unrealAgentPhaseNow(stopped, NOW - MINUTE, NOW)).toEqual({
      phase: "waiting",
      reply: "failed",
    });
    expect(status(stopped, "may-be-open")).toBe("failed");
  });

  test("a hard stop in a run before a resume does not end the new run", () => {
    const resumed = replayOf([
      settings,
      turn,
      reply("complete"),
      hard,
      settings,
      { kind: "input", input: "external" },
    ]);
    expect(status(resumed, "may-be-open")).toBe("working");
  });
});
