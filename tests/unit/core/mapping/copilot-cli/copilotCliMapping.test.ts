import { describe, expect, test } from "vitest";

import {
  applyCopilotRecord,
  startCopilotFold,
  type CopilotFold,
  type CopilotRecord,
} from "@core/mapping/copilot-cli/copilotCliFold";
import {
  copilotCliStatusOf,
  PERMISSION_AGE_MS,
  type CopilotCliFacts,
} from "@core/mapping/copilot-cli/copilotCliMapping";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const T = NOW - 60_000;

function fold(...records: CopilotRecord[]): CopilotFold {
  const made = startCopilotFold();
  for (const record of [{ sort: "start", cwd: null, at: T } as CopilotRecord, ...records]) {
    applyCopilotRecord(made, record);
  }
  return made;
}

const facts = (made: CopilotFold, fields: Partial<CopilotCliFacts> = {}): CopilotCliFacts => ({
  fold: made,
  live: true,
  writtenAt: NOW - 1_000,
  changedAt: NOW - 1_000,
  now: NOW,
  seen: new Map(),
  waited: new Set(),
  ...fields,
});

const statusOf = (made: CopilotFold, fields: Partial<CopilotCliFacts> = {}) =>
  copilotCliStatusOf(facts(made, fields));

const user: CopilotRecord = { sort: "user", at: T + 1_000 };
const turnStart = (turn: string, at = T + 2_000): CopilotRecord => ({
  sort: "turn-start",
  turn,
  sub: null,
  at,
});
const turnEnd = (turn: string, at = T + 3_000): CopilotRecord => ({
  sort: "turn-end",
  turn,
  sub: null,
  at,
});

describe("each row of the table", () => {
  test("1: a shutdown of type error is failed, since its time, whatever the lock says", () => {
    const made = fold({ sort: "shutdown", kind: "error", at: T + 5_000 });
    for (const live of [true, false, null]) {
      expect(statusOf(made, { live })).toEqual({
        status: "failed",
        since: T + 5_000,
        showsLastWrite: false,
      });
    }
  });

  test("2: any other shutdown is finished, since its time", () => {
    for (const kind of ["routine", "other"] as const) {
      expect(statusOf(fold({ sort: "shutdown", kind, at: T + 5_000 }))).toEqual({
        status: "finished",
        since: T + 5_000,
        showsLastWrite: false,
      });
    }
  });

  test("3: with no lock that counts it is finished, since the log or folder last changed", () => {
    expect(statusOf(fold(user, turnStart("0")), { live: false, changedAt: NOW - 9_000 })).toEqual({
      status: "finished",
      since: NOW - 9_000,
      showsLastWrite: false,
    });
    // A time that cannot be right is none.
    expect(statusOf(fold(), { live: false, changedAt: NOW + 3_600_000 }).since).toBeNull();
  });

  test("4: locks that could not be listed, or a line that could not be read, are unknown", () => {
    expect(statusOf(fold(user), { live: null }).status).toBe("unknown");
    expect(statusOf(fold(user, { sort: "unreadable" })).status).toBe("unknown");
  });

  test("5: a permission request open a second or more needs you, since the oldest", () => {
    const made = fold(
      user,
      turnStart("0"),
      { sort: "permission", request: "r-1", byHook: false, at: NOW - 20_000 },
      { sort: "permission", request: "r-2", byHook: false, at: NOW - 30_000 },
      { sort: "tool-start", call: "c-1", ask: true, at: NOW - 40_000 },
    );
    expect(statusOf(made)).toEqual({
      status: "needs-you",
      since: NOW - 30_000,
      waitingReason: "permission",
      wait: { since: NOW - 30_000, ids: ["permission:r-1", "permission:r-2"] },
      showsLastWrite: false,
    });
  });

  test("5: a request younger than a second is not yet a wait, by its time or by when it was first seen", () => {
    const young = fold(user, turnStart("0"), {
      sort: "permission",
      request: "r-1",
      byHook: false,
      at: NOW - PERMISSION_AGE_MS + 1,
    });
    expect(statusOf(young).status).toBe("working");
    expect(statusOf(young, { now: NOW + 1 }).status).toBe("needs-you");
    // One with no time waits once it has been seen open for a second.
    const untimed = fold(user, turnStart("0"), {
      sort: "permission",
      request: "r-1",
      byHook: false,
      at: null,
    });
    expect(statusOf(untimed, { seen: new Map([["r-1", NOW - 500]]) }).status).toBe("working");
    expect(statusOf(untimed, { seen: new Map([["r-1", NOW - 1_000]]) })).toMatchObject({
      status: "needs-you",
      since: NOW - 1_000,
    });
    // One that waited at the last poll waits for as long as it is open, as after a clock set back.
    expect(statusOf(young, { waited: new Set(["r-1"]) }).status).toBe("needs-you");
  });

  test("6: an open ask_user call needs you for an answer, since it began", () => {
    const made = fold(user, turnStart("0"), {
      sort: "tool-start",
      call: "c-1",
      ask: true,
      at: NOW - 15_000,
    });
    expect(statusOf(made)).toEqual({
      status: "needs-you",
      since: NOW - 15_000,
      waitingReason: "question",
      wait: { since: NOW - 15_000, ids: ["question:c-1"] },
      showsLastWrite: false,
    });
  });

  test("7: a session.error as the newest lifecycle line is unknown", () => {
    expect(statusOf(fold(user, turnStart("0"), { sort: "error", at: T + 4_000 })).status).toBe(
      "unknown",
    );
  });

  test("8: working while a turn is open, after a message, after a turn that asked for tools, or while a tool or sub-agent runs", () => {
    const working = [
      fold(user, turnStart("0")),
      fold(user),
      fold(user, turnStart("0"), { sort: "reply", tools: true }, turnEnd("0")),
      fold(user, turnStart("0"), { sort: "reply", tools: false }, turnEnd("0"), {
        sort: "tool-start",
        call: "c-1",
        ask: false,
        at: T + 4_000,
      }),
      fold(user, turnStart("0"), { sort: "reply", tools: false }, turnEnd("0"), {
        sort: "turn-start",
        turn: "0",
        sub: "task-1",
        at: T + 4_000,
      }),
    ];
    for (const made of working) {
      expect(statusOf(made)).toEqual({ status: "working", since: T + 1_000, showsLastWrite: true });
    }
    // With no message in this lifetime, the open turn's start.
    expect(statusOf(fold(turnStart("0", T + 2_000))).since).toBe(T + 2_000);
  });

  test("9: lines that went unread, or tool requests that could not be read, are unknown", () => {
    const gap = fold(user, turnStart("0"), { sort: "gap" });
    expect(statusOf(gap).status).toBe("unknown");
    // A turn line after the gap tells again.
    expect(statusOf(fold(user, { sort: "gap" }, turnStart("4"))).status).toBe("working");
    expect(
      statusOf(fold(user, turnStart("0"), { sort: "reply", tools: null }, turnEnd("0"))).status,
    ).toBe("unknown");
    expect(statusOf(startCopilotFold()).status).toBe("unknown");
  });

  test("10: idle after a turn that asked for no tools, an abort, a task's completion, or a start alone", () => {
    const idle: [CopilotFold, number][] = [
      [fold(user, turnStart("0"), { sort: "reply", tools: false }, turnEnd("0")), T + 3_000],
      [fold(user, turnStart("0"), turnEnd("0"), { sort: "abort", at: T + 4_000 }), T + 4_000],
      [
        fold(user, turnStart("0"), turnEnd("0"), {
          sort: "task-complete",
          goesOn: false,
          at: T + 4_000,
        }),
        T + 4_000,
      ],
      [fold(), T],
      [fold({ sort: "resume", cwd: null, continuePending: false, at: T + 7_000 }), T + 7_000],
    ];
    for (const [made, since] of idle) {
      expect(statusOf(made)).toEqual({ status: "idle", since, showsLastWrite: false });
    }
  });
});

describe("a task's completion", () => {
  // Autopilot's last turn: a reply that calls task_complete, its run, and the turn's end.
  const lastTurn = (goesOn: boolean | null) =>
    fold(
      user,
      turnStart("5"),
      { sort: "reply", tools: true },
      { sort: "tool-start", call: "c-5", ask: false, at: T + 2_100 },
      { sort: "task-complete", goesOn, at: T + 2_200 },
      { sort: "tool-end", call: "c-5" },
      turnEnd("5"),
    );

  test("one Copilot accepted ends the run with the turn that called it: idle", () => {
    expect(statusOf(lastTurn(false))).toEqual({
      status: "idle",
      since: T + 3_000,
      showsLastWrite: false,
    });
  });

  test("one Copilot rejected goes on working, and one whose outcome does not say is unknown", () => {
    expect(statusOf(lastTurn(true)).status).toBe("working");
    expect(statusOf(lastTurn(null)).status).toBe("unknown");
    // The same when it comes after the turn's end.
    const after = (goesOn: boolean | null) =>
      fold(user, turnStart("0"), { sort: "reply", tools: true }, turnEnd("0"), {
        sort: "task-complete",
        goesOn,
        at: T + 4_000,
      });
    expect(statusOf(after(true)).status).toBe("working");
    expect(statusOf(after(null)).status).toBe("unknown");
    // A new turn tells again.
    const told = lastTurn(null);
    applyCopilotRecord(told, turnStart("6", T + 5_000));
    expect(statusOf(told).status).toBe("working");
  });
});

test("a long session of requests a hook settled stays idle between requests", () => {
  const made = fold();
  for (let n = 0; n < 300; n += 1) {
    for (const record of [
      user,
      turnStart(`a-${n}`),
      { sort: "reply", tools: true },
      { sort: "tool-start", call: `c-${n}`, ask: false, at: T + 2_100 },
      { sort: "permission", request: `h-${n}`, byHook: true, at: T + 2_200 },
      { sort: "permission-end", request: `h-${n}` },
      { sort: "tool-end", call: `c-${n}` },
      turnEnd(`a-${n}`),
      turnStart(`b-${n}`),
      { sort: "reply", tools: false },
      turnEnd(`b-${n}`),
    ] as CopilotRecord[]) {
      applyCopilotRecord(made, record);
    }
  }
  expect(statusOf(made).status).toBe("idle");
});

test("no timer ever turns working into idle", () => {
  const made = fold(user, turnStart("0"));
  expect(statusOf(made, { now: NOW + 7 * 24 * 3_600_000 }).status).toBe("working");
});
