import { describe, expect, test } from "vitest";

import {
  applyUnrealAgentLine,
  copyUnrealAgentReplay,
  MAX_OPEN_OPERATIONS,
  runBeganBy,
  startUnrealAgentReplay,
  unrealAgentPhase,
  type UnrealAgentItem,
  type UnrealAgentLine,
  type UnrealAgentReplay,
} from "@core/mapping/unreal-agent/unrealAgentReplay";

const AT = Date.UTC(2026, 10, 17, 11, 0, 0);
const TURN_1 = "00000003-c3d4-4e5f-8a9b-000000000001";
const TURN_2 = "00000003-c3d4-4e5f-8a9b-000000000002";
const OP_1 = "00000005-c3d4-4e5f-8a9b-000000000001";
const OP_2 = "00000005-c3d4-4e5f-8a9b-000000000002";

/** Items numbered from `first`, a second apart, then any lines given as they are. */
function replayOf(
  lines: (UnrealAgentItem | UnrealAgentLine)[],
  options: { fromStart?: boolean; first?: number } = {},
): UnrealAgentReplay {
  const replay = startUnrealAgentReplay(options.fromStart ?? true);
  let sequence = options.first ?? 1;
  for (const line of lines) {
    if (line.kind === "operation" || (line.kind === "unread" && !("sequence" in line))) {
      applyUnrealAgentLine(replay, line as UnrealAgentLine);
      continue;
    }
    if (line.kind === "item") {
      applyUnrealAgentLine(replay, line);
      continue;
    }
    applyUnrealAgentLine(replay, {
      kind: "item",
      sequence,
      at: AT + sequence * 1000,
      item: line as UnrealAgentItem,
    });
    sequence += 1;
  }
  return replay;
}

const settings: UnrealAgentItem = { kind: "input", input: "settings" };
const message: UnrealAgentItem = { kind: "input", input: "external" };
const heartbeat: UnrealAgentItem = { kind: "input", input: "heartbeat" };
const whenIdle: UnrealAgentItem = { kind: "input", input: "when_idle" };
const hard: UnrealAgentItem = { kind: "input", input: "hard" };
const turn = (id = TURN_1, type: "regular" | "compaction" = "regular"): UnrealAgentItem => ({
  kind: "turn",
  id,
  type,
});
const reply = (
  outcome: "complete" | "failed" | "unclear" = "complete",
  turnId = TURN_1,
): UnrealAgentItem => ({ kind: "reply", turnId, outcome });
const created = (...ids: string[]): UnrealAgentItem => ({ kind: "status-created", ids });
const completed = (...ids: string[]): UnrealAgentItem => ({ kind: "status-completed", ids });
const operation = (id: string, terminal: boolean): UnrealAgentLine => ({
  kind: "operation",
  id,
  terminal,
});

describe("Table A, the phase", () => {
  test("a line not read is unread, before every other row", () => {
    expect(unrealAgentPhase(replayOf([turn(), { kind: "unread" }])).phase).toBe("unread");
    expect(
      unrealAgentPhase(replayOf([turn(), reply(), { kind: "unread" } as UnrealAgentLine])),
    ).toEqual({
      phase: "unread",
      reply: null,
    });
  });

  test("an open turn is busy", () => {
    expect(unrealAgentPhase(replayOf([settings, message, turn()])).phase).toBe("busy");
  });

  test("a message or a heartbeat since the newest turn is busy", () => {
    expect(unrealAgentPhase(replayOf([turn(), reply(), message])).phase).toBe("busy");
    expect(unrealAgentPhase(replayOf([turn(), reply(), heartbeat])).phase).toBe("busy");
  });

  test("a tool call that failed at once, or one that ended, is busy until the next turn", () => {
    expect(unrealAgentPhase(replayOf([turn(), reply(), { kind: "status-done" }])).phase).toBe(
      "busy",
    );
    expect(
      unrealAgentPhase(
        replayOf([turn(), reply(), created(OP_1), operation(OP_1, true), completed(OP_1)]),
      ).phase,
    ).toBe("busy");
    expect(
      unrealAgentPhase(
        replayOf([
          turn(),
          reply(),
          created(OP_1),
          completed(OP_1),
          turn(TURN_2),
          reply("complete", TURN_2),
        ]),
      ),
    ).toEqual({ phase: "waiting", reply: "complete" });
  });

  test("a tool call with its first status and not its second is busy, as is a command that has not ended", () => {
    expect(unrealAgentPhase(replayOf([turn(), reply(), created(OP_1)])).phase).toBe("busy");
    expect(
      unrealAgentPhase(replayOf([turn(), reply(), operation(OP_2, false)], { fromStart: false }))
        .phase,
    ).toBe("busy");
  });

  test("a reply to a compaction turn is busy", () => {
    expect(unrealAgentPhase(replayOf([turn(TURN_1, "compaction"), reply()])).phase).toBe("busy");
  });

  test("an answered regular turn read from the start waits, with how its reply ended", () => {
    for (const outcome of ["complete", "failed", "unclear"] as const) {
      expect(unrealAgentPhase(replayOf([settings, message, turn(), reply(outcome)]))).toEqual({
        phase: "waiting",
        reply: outcome,
      });
    }
  });

  test("a file with no item waits, with no reply", () => {
    expect(unrealAgentPhase(replayOf([]))).toEqual({ phase: "waiting", reply: null });
  });

  test("lines that do not reach the start, or a reply whose turn was not read, are unsure", () => {
    expect(unrealAgentPhase(replayOf([turn(), reply()], { fromStart: false, first: 40 }))).toEqual({
      phase: "unsure",
      reply: "complete",
    });
    expect(unrealAgentPhase(replayOf([reply("failed")], { fromStart: false, first: 40 }))).toEqual({
      phase: "unsure",
      reply: "failed",
    });
  });
});

describe("applying lines", () => {
  test("only the newest turn counts: an older one left without a reply does not", () => {
    expect(
      unrealAgentPhase(replayOf([turn(TURN_1), message, turn(TURN_2), reply("complete", TURN_2)]))
        .phase,
    ).toBe("waiting");
  });

  test("a reply to another turn than the newest is a line not read", () => {
    expect(
      unrealAgentPhase(replayOf([turn(TURN_1), turn(TURN_2), reply("complete", TURN_1)])).phase,
    ).toBe("unread");
  });

  test("a heartbeat's turn answered with no tool call, while a command runs, is busy", () => {
    const replay = replayOf([
      turn(TURN_1),
      reply(),
      created(OP_1),
      operation(OP_1, false),
      heartbeat,
      turn(TURN_2),
      reply("complete", TURN_2),
    ]);
    expect(unrealAgentPhase(replay).phase).toBe("busy");
  });

  test("a file that ends on a command's ending line before the second status is busy", () => {
    // The operation line must not clear the tool call: the coordinator is idle only once the second status is written.
    expect(
      unrealAgentPhase(replayOf([turn(), reply(), created(OP_1), operation(OP_1, true)])).phase,
    ).toBe("busy");
  });

  test("the second status clears the commands of lines that do not reach the start", () => {
    const replay = replayOf([operation(OP_1, false), completed(OP_1), turn(), reply()], {
      fromStart: false,
      first: 9,
    });
    expect(replay.liveOps.size).toBe(0);
    expect(unrealAgentPhase(replay).phase).toBe("unsure");
  });

  test("a fork clears a parent's line not read and its commands, keeps an input not yet answered, and a turn answered after it waits", () => {
    const parent = replayOf([
      turn(TURN_1),
      { kind: "unread" },
      created(OP_1),
      message,
      { kind: "fork" },
    ]);
    expect(parent.unread).toBe(false);
    expect(parent.callOps.size).toBe(0);
    expect(parent.pending).toBe(true);
    expect(unrealAgentPhase(parent).phase).toBe("busy");
    const child = replayOf(
      [
        turn(TURN_1),
        { kind: "unread" },
        created(OP_1),
        message,
        { kind: "fork" },
        turn(TURN_2),
        reply("complete", TURN_2),
      ],
      { fromStart: false, first: 30 },
    );
    expect(child.complete).toBe(true);
    expect(unrealAgentPhase(child)).toEqual({ phase: "waiting", reply: "complete" });
  });

  test("a hard stop keeps what the lines said at it, whatever follows", () => {
    const replay = replayOf([
      settings,
      turn(),
      reply(),
      created(OP_1),
      hard,
      operation(OP_1, false),
    ]);
    expect(replay.run.hard).toEqual({ phase: "busy", reply: null });
    const failed = replayOf([settings, turn(), reply("failed"), hard]);
    expect(failed.run.hard).toEqual({ phase: "waiting", reply: "failed" });
  });

  test("a resume's settings input begins a new run: an older hard stop and when_idle no longer count", () => {
    const resumed = replayOf([settings, whenIdle, turn(), reply(), hard, settings, message]);
    expect(resumed.run).toEqual({ startAt: AT + 6000, whenIdle: false, hard: null });
    expect(unrealAgentPhase(resumed).phase).toBe("busy");
  });

  test("a gap in the items' numbers is a line not read", () => {
    const replay = startUnrealAgentReplay(true);
    applyUnrealAgentLine(replay, { kind: "item", sequence: 1, at: AT, item: turn() });
    applyUnrealAgentLine(replay, { kind: "item", sequence: 3, at: AT, item: reply() });
    expect(unrealAgentPhase(replay).phase).toBe("unread");
    // From the start, the first item must be item 1.
    const late = startUnrealAgentReplay(true);
    applyUnrealAgentLine(late, { kind: "item", sequence: 2, at: AT, item: turn() });
    expect(late.unread).toBe(true);
  });

  test("the lines are complete from the start, from item 1, or from a fork", () => {
    expect(replayOf([turn()], { fromStart: true }).complete).toBe(true);
    expect(replayOf([turn()], { fromStart: false, first: 1 }).complete).toBe(true);
    expect(replayOf([turn()], { fromStart: false, first: 2 }).complete).toBe(false);
    expect(replayOf([turn(), { kind: "fork" }], { fromStart: false, first: 2 }).complete).toBe(
      true,
    );
  });

  test("a run began at its settings input, else at the oldest item read", () => {
    expect(runBeganBy(replayOf([message, settings, turn()]))).toBe(AT + 2000);
    expect(runBeganBy(replayOf([turn(), reply()], { fromStart: false, first: 5 }))).toBe(AT + 5000);
    expect(runBeganBy(replayOf([]))).toBeNull();
  });

  test("a reply that is the newest line is marked, and any later line clears the mark", () => {
    expect(replayOf([turn(), reply()]).endsOnReply).toBe(true);
    expect(replayOf([turn(), reply(), created(OP_1)]).endsOnReply).toBe(false);
    expect(replayOf([turn(), reply(), operation(OP_1, true)]).endsOnReply).toBe(false);
  });

  test("the first input since the newest turn gives the time it waited from", () => {
    const replay = replayOf([turn(), reply(), message, heartbeat]);
    expect(replay.pendingAt).toBe(AT + 3000);
    expect(replayOf([turn(), reply(), message, turn(TURN_2)]).pendingAt).toBeNull();
  });

  test(`more than ${MAX_OPEN_OPERATIONS} commands running is a line not read`, () => {
    const ids = Array.from({ length: MAX_OPEN_OPERATIONS + 1 }, (_, n) => `op-${n}`);
    expect(replayOf([turn(), reply(), created(...ids)]).unread).toBe(true);
    expect(replayOf([turn(), reply(), created(...ids.slice(1))]).unread).toBe(false);
    const lines = ids.map((id) => operation(id, false));
    expect(replayOf([turn(), reply(), ...lines]).unread).toBe(true);
  });

  test("a copy takes lines without changing the replay it came from", () => {
    const replay = replayOf([turn(), reply(), created(OP_1)]);
    const copy = copyUnrealAgentReplay(replay);
    applyUnrealAgentLine(copy, { kind: "item", sequence: 4, at: AT, item: completed(OP_1) });
    applyUnrealAgentLine(copy, { kind: "item", sequence: 5, at: AT, item: settings });
    expect(replay.callOps.has(OP_1)).toBe(true);
    expect(replay.run.startAt).toBeNull();
    expect(copy.callOps.size).toBe(0);
  });
});

describe("the end of the file read in two parts says what it says read whole", () => {
  /** A small generator of sessions, with a seed, so each run tries the same files. */
  function* sessions(seed: number): Generator<(UnrealAgentItem | UnrealAgentLine)[]> {
    let state = seed;
    const next = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let file = 0; file < 200; file += 1) {
      const lines: (UnrealAgentItem | UnrealAgentLine)[] = [settings, message];
      let turns = 0;
      for (let step = 0; step < 12; step += 1) {
        turns += 1;
        const id = `00000003-c3d4-4e5f-8a9b-${String(turns).padStart(12, "0")}`;
        const op = `00000005-c3d4-4e5f-8a9b-${String(turns).padStart(12, "0")}`;
        lines.push(turn(id, next(6) === 0 ? "compaction" : "regular"));
        const ending = next(5);
        if (ending === 0) continue;
        lines.push(reply(next(4) === 0 ? "failed" : "complete", id));
        if (next(2) === 0) {
          lines.push(created(op), operation(op, false));
          if (next(3) > 0) lines.push(operation(op, true), completed(op));
        }
        if (next(4) === 0) lines.push(heartbeat);
      }
      yield lines;
    }
  }

  test("read in two parts at any line, one after the other, a file's phase is the whole file's", () => {
    for (const lines of sessions(7)) {
      const whole = unrealAgentPhase(replayOf(lines));
      for (let half = 0; half <= lines.length; half += 1) {
        const two = replayOf(lines.slice(0, half));
        let sequence = lines.slice(0, half).filter((line) => line.kind !== "operation").length + 1;
        for (const line of lines.slice(half)) {
          if (line.kind === "operation") applyUnrealAgentLine(two, line as UnrealAgentLine);
          else {
            applyUnrealAgentLine(two, {
              kind: "item",
              sequence,
              at: AT + sequence * 1000,
              item: line as UnrealAgentItem,
            });
            sequence += 1;
          }
        }
        expect(unrealAgentPhase(two)).toEqual(whole);
      }
    }
  });
});
