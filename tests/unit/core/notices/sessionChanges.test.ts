import { describe, expect, test } from "vitest";

import type {
  Session,
  SessionsSnapshot,
  SessionStatus,
  SourceHealth,
  SourceId,
  SourceState,
} from "@core/sessions/session";
import {
  EMPTY_CHANGE_MEMORY,
  EMPTY_WAIT_MEMORY,
  readNoticeEvents,
  sessionChanges,
  waitChanges,
  writeNoticeEvents,
  type ChangeMemory,
  type SessionChange,
  type WaitMemory,
} from "@core/notices/sessionChanges";
import { makeSession } from "@tests/fixtures/session";

const at = 1_700_000_060_000;

const A = "claude-code:00000000-0000-4000-8000-00000000000a";
const B = "claude-code:00000000-0000-4000-8000-00000000000b";
const C = "claude-code:00000000-0000-4000-8000-00000000000c";

function source(id: SourceId, state: SourceState = "ok"): SourceHealth {
  return { id, label: id === "codex" ? "Codex" : "Claude Code", state, checkedAt: at };
}

function snapshot(
  sessions: Session[],
  sources: SourceHealth[] = [source("claude-code")],
): SessionsSnapshot {
  return { generatedAt: at, sources, sessions };
}

function waiting(id: string, overrides: Partial<Session> = {}): Session {
  return makeSession({ id, status: "needs-you", waitingReason: "permission", ...overrides });
}

function working(id: string, overrides: Partial<Session> = {}): Session {
  return makeSession({ id, status: "working", ...overrides });
}

/** The memory after each snapshot in turn, starting from nothing. */
function memoryAfter(...snapshots: SessionsSnapshot[]): WaitMemory {
  return snapshots.reduce((memory, each) => waitChanges(memory, each).memory, EMPTY_WAIT_MEMORY);
}

/** The sessions remembered as waiting, as plain data. */
function remembered(memory: WaitMemory): Record<string, string[]> {
  return Object.fromEntries([...memory].map(([id, waits]) => [id, [...waits.keys()]]));
}

/** The status time each remembered wait is kept with, as plain data. */
function rememberedTimes(memory: WaitMemory): Record<string, number | null> {
  return Object.fromEntries([...memory].flatMap(([, waits]) => [...waits]));
}

describe("a source's first answer", () => {
  test("is a baseline: the sessions already waiting are remembered and none has started", () => {
    const result = waitChanges(EMPTY_WAIT_MEMORY, snapshot([waiting(A), working(B), waiting(C)]));

    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [A, C] });
  });

  test("is still a baseline when it follows a searching snapshot with no sessions", () => {
    const searching = waitChanges(
      EMPTY_WAIT_MEMORY,
      snapshot([], [source("claude-code", "searching"), source("codex", "searching")]),
    );
    expect(searching.started).toEqual([]);
    expect(searching.stopped).toEqual([]);
    expect(remembered(searching.memory)).toEqual({});

    const first = waitChanges(searching.memory, snapshot([waiting(A)]));
    expect(first.started).toEqual([]);
    expect(first.stopped).toEqual([]);
    expect(remembered(first.memory)).toEqual({ "claude-code": [A] });
  });

  test("with nobody waiting is remembered too, so the next wait is news", () => {
    const memory = memoryAfter(snapshot([working(A)]));
    expect(remembered(memory)).toEqual({ "claude-code": [] });
    expect(waitChanges(memory, snapshot([waiting(A)])).started).toHaveLength(1);
  });
});

describe("a source that is not set up", () => {
  const F = "status-files:night-shift.json";
  const custom = (status: "needs-you" | "working") =>
    makeSession({
      id: F,
      source: "status-files",
      agent: "Night Shift",
      status,
      ...(status === "needs-you" && { waitingReason: "question" as const }),
    });

  test("has been read, with no sessions, so a wait in the first answer once it is set up has started", () => {
    const memory = memoryAfter(snapshot([], [source("status-files", "not-set-up")]));
    expect(remembered(memory)).toEqual({ "status-files": [] });

    const result = waitChanges(
      memory,
      snapshot([custom("needs-you")], [source("status-files", "ok")]),
    );
    expect(result.started.map((session) => session.id)).toEqual([F]);
  });

  test("taken away while a session waits, ends the wait", () => {
    const memory = memoryAfter(snapshot([custom("needs-you")], [source("status-files", "ok")]));
    const result = waitChanges(memory, snapshot([], [source("status-files", "not-set-up")]));
    expect(result.stopped).toEqual([F]);
    expect(remembered(result.memory)).toEqual({ "status-files": [] });
  });
});

describe("a wait starting", () => {
  test("a session that goes from working to needing you has started, with its name and reason", () => {
    const memory = memoryAfter(snapshot([working(A, { name: "demo-api" })]));
    const now = waiting(A, {
      name: "demo-api",
      waitingReason: "question",
      waitingDetail: "input needed",
    });

    const result = waitChanges(memory, snapshot([now]));

    expect(result.started).toEqual([now]);
    expect(result.started[0]).toMatchObject({ name: "demo-api", waitingReason: "question" });
    expect(result.stopped).toEqual([]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [A] });
  });

  test("a session new to the list and already needing you has started", () => {
    const memory = memoryAfter(snapshot([working(A)]));
    const result = waitChanges(memory, snapshot([working(A), waiting(B)]));
    expect(result.started.map((session) => session.id)).toEqual([B]);
  });

  test("every status but needs-you starts nothing", () => {
    const memory = memoryAfter(snapshot([]));
    const others: SessionStatus[] = ["working", "idle", "finished", "failed", "unknown"];
    const sessions = others.map((status, index) =>
      makeSession({ id: `claude-code:${index}`, status }),
    );
    const result = waitChanges(memory, snapshot(sessions));
    expect(result.started).toEqual([]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [] });
  });

  test("sessions that start together come in the snapshot's order", () => {
    const memory = memoryAfter(snapshot([working(A), working(B), working(C)]));
    const result = waitChanges(memory, snapshot([waiting(C), working(B), waiting(A)]));
    expect(result.started.map((session) => session.id)).toEqual([C, A]);
  });

  test("a session listed twice has started once", () => {
    const memory = memoryAfter(snapshot([]));
    const result = waitChanges(memory, snapshot([waiting(A), waiting(A)]));
    expect(result.started.map((session) => session.id)).toEqual([A]);
  });
});

describe("a wait stopping", () => {
  test.each<SessionStatus>(["working", "idle", "finished", "failed", "unknown"])(
    "a waiting session that is now %s has stopped",
    (status) => {
      const memory = memoryAfter(snapshot([waiting(A), waiting(B)]));
      const result = waitChanges(memory, snapshot([makeSession({ id: A, status }), waiting(B)]));
      expect(result.stopped).toEqual([A]);
      expect(result.started).toEqual([]);
      expect(remembered(result.memory)).toEqual({ "claude-code": [B] });
    },
  );

  test("a waiting session that leaves the list while its source answers has stopped", () => {
    const memory = memoryAfter(snapshot([waiting(A), waiting(B)]));
    const result = waitChanges(memory, snapshot([waiting(B)]));
    expect(result.stopped).toEqual([A]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [B] });
  });

  test("a wait that stops and begins again has started a second time", () => {
    const before = memoryAfter(snapshot([working(A)]), snapshot([waiting(A)]));
    const stopped = waitChanges(before, snapshot([working(A)]));
    expect(stopped.stopped).toEqual([A]);

    const again = waitChanges(stopped.memory, snapshot([waiting(A)]));
    expect(again.started.map((session) => session.id)).toEqual([A]);
  });

  test("one snapshot can stop one wait and start another", () => {
    const memory = memoryAfter(snapshot([waiting(A), working(B)]));
    const result = waitChanges(memory, snapshot([working(A), waiting(B)]));
    expect(result.stopped).toEqual([A]);
    expect(result.started.map((session) => session.id)).toEqual([B]);
  });
});

describe("a wait going on", () => {
  test("a new reason, detail or name on the same wait reports nothing", () => {
    const memory = memoryAfter(
      snapshot([
        waiting(A, {
          name: "demo-project",
          waitingReason: "permission",
          waitingDetail: "permission prompt",
          statusSince: 1_000,
        }),
      ]),
    );
    const result = waitChanges(
      memory,
      snapshot([
        waiting(A, {
          name: "renamed-project",
          waitingReason: "question",
          waitingDetail: "input needed",
          statusSince: 1_000,
        }),
      ]),
    );
    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [A] });
  });

  test.each<[string, number | null]>([
    ["the same", 2_000],
    ["an earlier", 1_000],
    ["no", null],
  ])("%s status time on a session still needing you reports nothing", (_, statusSince) => {
    const memory = memoryAfter(
      snapshot([working(A)]),
      snapshot([waiting(A, { statusSince: 2_000 })]),
    );
    const result = waitChanges(memory, snapshot([waiting(A, { statusSince })]));
    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([]);
    // The latest time the wait was seen with is the one kept.
    expect(rememberedTimes(result.memory)).toEqual({ [A]: 2_000 });
  });

  test("the same snapshot a second time reports nothing", () => {
    const memory = memoryAfter(snapshot([working(A), waiting(B)]));
    const change = snapshot([waiting(A), working(B)]);

    const first = waitChanges(memory, change);
    expect(first.started.map((session) => session.id)).toEqual([A]);
    expect(first.stopped).toEqual([B]);

    const second = waitChanges(first.memory, change);
    expect(second.started).toEqual([]);
    expect(second.stopped).toEqual([]);
    expect(remembered(second.memory)).toEqual(remembered(first.memory));
  });
});

// A source is read every couple of seconds. A session that is answered, works
// for less than that and asks again is needs-you in one snapshot and needs-you
// in the next, and only its status time says the second wait is not the first.
describe("a wait that ends and begins again between two snapshots", () => {
  test("has stopped and started: the session is in both, with its new reason", () => {
    const memory = memoryAfter(
      snapshot([working(A, { name: "demo-api" })]),
      snapshot([waiting(A, { name: "demo-api", waitingReason: "permission", statusSince: 1_000 })]),
    );
    const again = waiting(A, { name: "demo-api", waitingReason: "question", statusSince: 1_700 });

    const result = waitChanges(memory, snapshot([again]));

    expect(result.stopped).toEqual([A]);
    expect(result.started).toEqual([again]);
    expect(result.started[0]).toMatchObject({ name: "demo-api", waitingReason: "question" });
    expect(remembered(result.memory)).toEqual({ "claude-code": [A] });
    expect(rememberedTimes(result.memory)).toEqual({ [A]: 1_700 });
  });

  test("with the reason unchanged has stopped and started all the same", () => {
    const memory = memoryAfter(
      snapshot([working(A)]),
      snapshot([waiting(A, { statusSince: 1_000 })]),
    );
    const result = waitChanges(memory, snapshot([waiting(A, { statusSince: 1_700 })]));
    expect(result.stopped).toEqual([A]);
    expect(result.started.map((session) => session.id)).toEqual([A]);
  });

  test("is reported once: the same snapshot again, and later ones with that time, report nothing", () => {
    const memory = memoryAfter(
      snapshot([working(A)]),
      snapshot([waiting(A, { statusSince: 1_000 })]),
    );
    const again = snapshot([waiting(A, { statusSince: 1_700 })]);
    const first = waitChanges(memory, again);
    expect(first.started).toHaveLength(1);

    const second = waitChanges(first.memory, again);
    expect(second.started).toEqual([]);
    expect(second.stopped).toEqual([]);

    const third = waitChanges(second.memory, snapshot([waiting(A, { statusSince: 1_700 })]));
    expect(third.started).toEqual([]);
    expect(third.stopped).toEqual([]);
  });

  test("each time it happens is reported", () => {
    let memory = memoryAfter(snapshot([working(A)]));
    const reported: number[] = [];
    for (const statusSince of [1_000, 1_700, 1_700, 2_900, 2_900, 4_100]) {
      const result = waitChanges(memory, snapshot([waiting(A, { statusSince })]));
      memory = result.memory;
      reported.push(result.started.length);
    }
    expect(reported).toEqual([1, 1, 0, 1, 0, 1]);
  });

  test("a wait that was already open in a source's first answer begins again as news", () => {
    const first = waitChanges(EMPTY_WAIT_MEMORY, snapshot([waiting(A, { statusSince: 1_000 })]));
    expect(first.started).toEqual([]);

    const result = waitChanges(first.memory, snapshot([waiting(A, { statusSince: 1_700 })]));

    expect(result.stopped).toEqual([A]);
    expect(result.started.map((session) => session.id)).toEqual([A]);
  });

  test("comes in the snapshot's order with the sessions that started outright", () => {
    const memory = memoryAfter(
      snapshot([working(A), waiting(B, { statusSince: 1_000 }), working(C)]),
    );
    const result = waitChanges(
      memory,
      snapshot([waiting(C), waiting(B, { statusSince: 1_700 }), waiting(A)]),
    );
    expect(result.started.map((session) => session.id)).toEqual([C, B, A]);
    expect(result.stopped).toEqual([B]);
  });

  test("leaves the other waits alone, and one that ended outright is stopped only", () => {
    const memory = memoryAfter(
      snapshot([working(A), working(B), working(C)]),
      snapshot([
        waiting(A, { statusSince: 1_000 }),
        waiting(B, { statusSince: 1_000 }),
        waiting(C, { statusSince: 1_000 }),
      ]),
    );
    const result = waitChanges(
      memory,
      snapshot([
        waiting(A, { statusSince: 1_000 }),
        waiting(B, { statusSince: 1_700 }),
        working(C, { statusSince: 1_700 }),
      ]),
    );
    expect(result.started.map((session) => session.id)).toEqual([B]);
    expect([...result.stopped].sort()).toEqual([B, C]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [A, B] });
  });

  test("is seen across answers its source could not give", () => {
    const memory = memoryAfter(
      snapshot([working(A)]),
      snapshot([waiting(A, { statusSince: 1_000 })]),
      snapshot([], [source("claude-code", "error")]),
    );
    const result = waitChanges(memory, snapshot([waiting(A, { statusSince: 1_700 })]));
    expect(result.stopped).toEqual([A]);
    expect(result.started.map((session) => session.id)).toEqual([A]);
  });
});

// A source that cannot say when a status began gives null. That is no news
// about the wait, in either direction.
describe("a wait whose status time is not known", () => {
  test("has not begun again when a time is first given", () => {
    const memory = memoryAfter(
      snapshot([working(A)]),
      snapshot([waiting(A, { statusSince: null })]),
    );
    expect(rememberedTimes(memory)).toEqual({ [A]: null });

    const result = waitChanges(memory, snapshot([waiting(A, { statusSince: 1_000 })]));

    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(rememberedTimes(result.memory)).toEqual({ [A]: 1_000 });
  });

  test("has not begun again when its time is lost and the same time comes back", () => {
    const memory = memoryAfter(
      snapshot([working(A)]),
      snapshot([waiting(A, { statusSince: 1_000 })]),
      snapshot([waiting(A, { statusSince: null })]),
    );
    const result = waitChanges(memory, snapshot([waiting(A, { statusSince: 1_000 })]));
    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([]);
  });

  test("has begun again when its time is lost and a later one comes back", () => {
    const memory = memoryAfter(
      snapshot([working(A)]),
      snapshot([waiting(A, { statusSince: 1_000 })]),
      snapshot([waiting(A, { statusSince: null })]),
    );
    const result = waitChanges(memory, snapshot([waiting(A, { statusSince: 1_700 })]));
    expect(result.stopped).toEqual([A]);
    expect(result.started.map((session) => session.id)).toEqual([A]);
  });

  test("never begins again while no time is given, and still starts and stops as any wait does", () => {
    let memory = memoryAfter(snapshot([working(A)]));
    const seen: [number, number][] = [];
    for (const next of [waiting(A), waiting(A), working(A), waiting(A), waiting(A)]) {
      const result = waitChanges(memory, snapshot([{ ...next, statusSince: null }]));
      memory = result.memory;
      seen.push([result.started.length, result.stopped.length]);
    }
    expect(seen).toEqual([
      [1, 0],
      [0, 0],
      [0, 1],
      [1, 0],
      [0, 0],
    ]);
  });

  test("an earlier time is not kept in place of a later one, so it cannot make the later one news twice", () => {
    const memory = memoryAfter(
      snapshot([working(A)]),
      snapshot([waiting(A, { statusSince: 2_000 })]),
      snapshot([waiting(A, { statusSince: 1_000 })]),
    );
    const result = waitChanges(memory, snapshot([waiting(A, { statusSince: 2_000 })]));
    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([]);
  });
});

describe("a source that did not answer", () => {
  test.each<SourceState>(["error", "searching", "unavailable"])(
    "one that is %s keeps what was remembered and reports nothing",
    (state) => {
      const memory = memoryAfter(snapshot([waiting(A), working(B)]));
      // A source that cannot be read lists no sessions.
      const result = waitChanges(memory, snapshot([], [source("claude-code", state)]));
      expect(result.started).toEqual([]);
      expect(result.stopped).toEqual([]);
      expect(remembered(result.memory)).toEqual({ "claude-code": [A] });
    },
  );

  test("one missing from the snapshot keeps what was remembered and reports nothing", () => {
    const memory = memoryAfter(snapshot([waiting(A), working(B)]));
    const result = waitChanges(memory, snapshot([waiting(B)], []));
    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [A] });
  });

  test("sessions it still lists are not read either", () => {
    const memory = memoryAfter(snapshot([waiting(A), working(B)]));
    const result = waitChanges(
      memory,
      snapshot([working(A), waiting(B)], [source("claude-code", "error")]),
    );
    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [A] });
  });

  test("when it answers again, a wait that went on is not started a second time", () => {
    const failed = memoryAfter(
      snapshot([waiting(A), waiting(B), working(C)]),
      snapshot([], [source("claude-code", "error")]),
      snapshot([], [source("claude-code", "error")]),
    );

    // A went on waiting, B went back to work and C began to wait meanwhile.
    const back = waitChanges(failed, snapshot([waiting(A), working(B), waiting(C)]));

    expect(back.started.map((session) => session.id)).toEqual([C]);
    expect(back.stopped).toEqual([B]);
    expect(remembered(back.memory)).toEqual({ "claude-code": [A, C] });
  });

  test("a source that never answered before failing still gets its baseline", () => {
    const memory = memoryAfter(
      snapshot([], [source("claude-code", "searching")]),
      snapshot([], [source("claude-code", "error")]),
    );
    expect(remembered(memory)).toEqual({});

    const first = waitChanges(memory, snapshot([waiting(A)]));
    expect(first.started).toEqual([]);
    expect(remembered(first.memory)).toEqual({ "claude-code": [A] });
  });
});

// No Codex session is ever reported as waiting today. The second source in
// these tests stands for any source: the logic does not know one from another.
describe("two sources", () => {
  const X = "codex:00000000-0000-4000-8000-00000000000d";
  const both = [source("claude-code"), source("codex")];
  const other = (status: SessionStatus): Session =>
    makeSession({ id: X, source: "codex", status, name: "demo-other" });

  test("each has its own baseline, whenever its first answer comes", () => {
    const first = waitChanges(
      EMPTY_WAIT_MEMORY,
      snapshot([working(A)], [source("claude-code"), source("codex", "searching")]),
    );
    expect(remembered(first.memory)).toEqual({ "claude-code": [] });

    // The second source answers for the first time, with a session already
    // waiting, in the same snapshot as a wait the first source can report.
    const second = waitChanges(first.memory, snapshot([waiting(A), other("needs-you")], both));

    expect(second.started.map((session) => session.id)).toEqual([A]);
    expect(second.stopped).toEqual([]);
    expect(remembered(second.memory)).toEqual({ "claude-code": [A], codex: [X] });
  });

  test("one failing changes nothing for the other", () => {
    const memory = memoryAfter(snapshot([waiting(A), working(B), other("needs-you")], both));

    const result = waitChanges(
      memory,
      snapshot([other("working")], [source("claude-code", "error"), source("codex")]),
    );

    expect(result.started).toEqual([]);
    expect(result.stopped).toEqual([X]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [A], codex: [] });
  });

  test("a session is read only when its own source answered", () => {
    const memory = memoryAfter(snapshot([working(A), other("working")], both));
    const result = waitChanges(
      memory,
      snapshot(
        [waiting(A), other("needs-you")],
        [source("claude-code"), source("codex", "unavailable")],
      ),
    );
    expect(result.started.map((session) => session.id)).toEqual([A]);
    expect(remembered(result.memory)).toEqual({ "claude-code": [A], codex: [] });
  });
});

describe("what it is given", () => {
  test("is not changed", () => {
    const memory = memoryAfter(snapshot([waiting(A), working(B)]));
    const memoryBefore = remembered(memory);
    const next = snapshot([working(A), waiting(B), waiting(C)]);
    const nextBefore = structuredClone(next);

    const result = waitChanges(memory, next);

    expect(result.memory).not.toBe(memory);
    expect(remembered(memory)).toEqual(memoryBefore);
    expect(next).toEqual(nextBefore);
    expect(result.started[0]).toBe(next.sessions[1]);
  });

  test("the starting memory stays empty however often it is used", () => {
    waitChanges(EMPTY_WAIT_MEMORY, snapshot([waiting(A)]));
    waitChanges(EMPTY_WAIT_MEMORY, snapshot([waiting(B)]));
    expect(EMPTY_WAIT_MEMORY.size).toBe(0);
  });
});

// Sessions appear, change status and vanish between snapshots, their status
// times come and go and move both ways, and sources fail and come back, in
// every order. The run is the same every time, so a failure names the step it
// happened at and can be repeated.
describe("over a long run of snapshots", () => {
  const D = "codex:00000000-0000-4000-8000-00000000000d";
  const E = "codex:00000000-0000-4000-8000-00000000000e";
  const F = "status-files:night-shift.json";
  const ids: Record<SourceId, string[]> = {
    "claude-code": [A, B, C],
    codex: [D, E],
    "status-files": [F],
  };
  const sourceOf = (id: string): SourceId =>
    id.startsWith("codex:")
      ? "codex"
      : id.startsWith("status-files:")
        ? "status-files"
        : "claude-code";
  const statuses: SessionStatus[] = [
    "needs-you",
    "needs-you",
    "working",
    "idle",
    "finished",
    "failed",
    "unknown",
  ];
  const states: SourceState[] = [
    "ok",
    "ok",
    "ok",
    "ok",
    "error",
    "searching",
    "unavailable",
    "not-set-up",
  ];
  /** Status times: often the same one, sometimes later or earlier, sometimes not known. */
  const times: (number | null)[] = [null, 1_000, 1_000, 2_000, 3_000];
  const laterOf = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);

  /** Numbers from 0 up to 1 that are the same on every run. */
  function seeded(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  test("what has started and not stopped is exactly what waits, for every source that answered", () => {
    const random = seeded(4);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
    let starts = 0;
    let stops = 0;
    let waitingAtAFirstAnswer = 0;
    let begunAgain = 0;

    // Many runs, each from an empty memory, so a first answer is met many times.
    for (let run = 0; run < 300; run += 1) {
      let memory = EMPTY_WAIT_MEMORY;
      /** The waits someone listening would believe are open. */
      const open = new Set<string>();
      /** The latest status time each open wait has been seen with. */
      const latest = new Map<string, number | null>();
      const answeredBefore = new Set<SourceId>();

      for (let step = 0; step < 25; step += 1) {
        const at = `run ${run}, step ${step}`;
        // A source is sometimes left out, and sometimes cannot be read. A source
        // that cannot be read sometimes lists sessions all the same.
        const sources = (["claude-code", "codex", "status-files"] as const)
          .filter(() => random() > 0.05)
          .map((id) => source(id, pick(states)));
        const sessions = sources.flatMap(({ id }) =>
          ids[id]
            .filter(() => random() > 0.25)
            .map((sessionId) =>
              makeSession({
                id: sessionId,
                source: id,
                status: pick(statuses),
                statusSince: pick(times),
              }),
            ),
        );
        // Read: "ok", or not set up, which was read and holds nothing.
        const ok = new Set(
          sources
            .filter((each) => each.state === "ok" || each.state === "not-set-up")
            .map((each) => each.id),
        );
        const waitsNow = sessions
          .filter((session) => session.status === "needs-you")
          .map((session) => session.id);

        // An open wait has ended and another begun, unseen, exactly when the
        // session still waits with a time later than any its wait was seen with.
        const wasOpen = new Set(open);
        const readWaits = sessions.filter(
          (session) => session.status === "needs-you" && ok.has(session.source),
        );
        const againExpected = readWaits
          .filter((session) => {
            const seen = latest.get(session.id) ?? null;
            const since = session.statusSince;
            return wasOpen.has(session.id) && seen !== null && since !== null && since > seen;
          })
          .map((session) => session.id);

        const result = waitChanges(memory, snapshot(sessions, sources));
        memory = result.memory;

        const again = result.started.map((session) => session.id).filter((id) => wasOpen.has(id));
        expect(again, `${at}: the waits that began again`).toEqual(againExpected);
        for (const id of again) {
          expect(result.stopped, `${at}: ${id} began again without stopping`).toContain(id);
        }
        begunAgain += again.length;

        for (const id of result.stopped) {
          expect(open.has(id), `${at}: ${id} stopped without being open`).toBe(true);
          expect(ok.has(sourceOf(id)), `${at}: ${id} stopped unread`).toBe(true);
          open.delete(id);
        }
        for (const session of result.started) {
          expect(session.status, at).toBe("needs-you");
          expect(open.has(session.id), `${at}: ${session.id} started twice`).toBe(false);
          expect(ok.has(session.source), `${at}: ${session.id} started unread`).toBe(true);
          expect(
            answeredBefore.has(session.source),
            `${at}: ${session.id} started in a first answer`,
          ).toBe(true);
          open.add(session.id);
        }
        // A first answer is the baseline: what waits in it is open, and was not announced.
        for (const id of ok) {
          if (answeredBefore.has(id)) continue;
          answeredBefore.add(id);
          for (const waiting of waitsNow) {
            if (sourceOf(waiting) !== id) continue;
            open.add(waiting);
            waitingAtAFirstAnswer += 1;
          }
        }

        for (const id of ok) {
          const believed = [...open].filter((each) => sourceOf(each) === id).sort();
          const waits = waitsNow.filter((each) => sourceOf(each) === id).sort();
          expect(believed, `${at}: ${id}`).toEqual(waits);
        }
        for (const session of readWaits) {
          const seen = wasOpen.has(session.id) ? (latest.get(session.id) ?? null) : null;
          latest.set(session.id, laterOf(seen, session.statusSince));
        }
        for (const id of [...latest.keys()]) {
          if (!open.has(id)) latest.delete(id);
        }
        starts += result.started.length;
        stops += result.stopped.length;
      }
    }

    // The runs did exercise all four, many times over.
    expect(starts).toBeGreaterThan(500);
    expect(stops).toBeGreaterThan(500);
    expect(waitingAtAFirstAnswer).toBeGreaterThan(100);
    expect(begunAgain).toBeGreaterThan(100);
  });
});

describe("sessionChanges: what happened to each session", () => {
  const D = "claude-code:00000000-0000-4000-8000-00000000000d";

  function withStatus(id: string, status: SessionStatus, overrides: Partial<Session> = {}) {
    return makeSession({ id, status, ...overrides });
  }

  /** The memory after each snapshot in turn, starting from nothing. */
  function seenAfter(...snapshots: SessionsSnapshot[]): ChangeMemory {
    return snapshots.reduce(
      (memory, each) => sessionChanges(memory, each).memory,
      EMPTY_CHANGE_MEMORY,
    );
  }

  /** The changes as plain data: the event and the session's id. */
  function said(changes: SessionChange[]): [string, string][] {
    return changes.map(({ event, session }) => [event, session.id]);
  }

  describe("each event", () => {
    test("a session that starts waiting is needs-you, with the session as it is now", () => {
      const memory = seenAfter(snapshot([working(A)]));
      const now = waiting(A, { name: "checkout-flow", waitingReason: "question" });
      const result = sessionChanges(memory, snapshot([now]));
      expect(result.changes).toEqual([{ event: "needs-you", session: now }]);
      expect(result.stopped).toEqual([]);
    });

    test.each<SessionStatus>(["working", "idle", "needs-you", "unknown", "failed"])(
      "a session that was %s and is now finished has finished",
      (before) => {
        const memory = seenAfter(snapshot([withStatus(A, before)]));
        const now = withStatus(A, "finished", { name: "billing-webhooks" });
        const result = sessionChanges(memory, snapshot([now]));
        expect(result.changes).toEqual([{ event: "finished", session: now }]);
      },
    );

    test.each<SessionStatus>(["working", "idle", "needs-you", "unknown", "finished"])(
      "a session that was %s and is now failed has failed",
      (before) => {
        const memory = seenAfter(snapshot([withStatus(A, before)]));
        const result = sessionChanges(memory, snapshot([withStatus(A, "failed")]));
        expect(said(result.changes)).toEqual([["failed", A]]);
      },
    );

    test.each<SessionStatus>(["working", "idle", "needs-you", "unknown"])(
      "a session that was %s and is gone from the list has ended, as it was last seen",
      (before) => {
        const last = withStatus(A, before, { name: "search-indexing" });
        const memory = seenAfter(snapshot([last, working(B)]));
        const result = sessionChanges(memory, snapshot([working(B)]));
        expect(result.changes).toEqual([{ event: "ended", session: last }]);
      },
    );

    test("a waiting session that ends has its wait stopped as well", () => {
      const memory = seenAfter(snapshot([working(A)]), snapshot([waiting(A)]));
      const result = sessionChanges(memory, snapshot([]));
      expect(said(result.changes)).toEqual([["ended", A]]);
      expect(result.stopped).toEqual([A]);
    });

    test("nothing else is an event: a session going on, appearing, or changing between other statuses", () => {
      const memory = seenAfter(snapshot([working(A), withStatus(B, "idle")]));
      const result = sessionChanges(
        memory,
        snapshot([
          withStatus(A, "idle", { name: "a new name" }),
          working(B),
          working(C),
          withStatus(D, "unknown"),
        ]),
      );
      expect(result.changes).toEqual([]);
      expect(result.stopped).toEqual([]);
    });
  });

  describe("the baseline", () => {
    test("a source's first answer says nothing, whatever is in it", () => {
      const result = sessionChanges(
        EMPTY_CHANGE_MEMORY,
        snapshot([waiting(A), withStatus(B, "finished"), withStatus(C, "failed"), working(D)]),
      );
      expect(result.changes).toEqual([]);
      expect(result.stopped).toEqual([]);
    });

    test("what was already true at the first answer is never announced later", () => {
      const first = snapshot([waiting(A), withStatus(B, "finished"), withStatus(C, "failed")]);
      const memory = seenAfter(first, first);
      // The finished and failed sessions leave the list: they had said what happened.
      const result = sessionChanges(memory, snapshot([waiting(A)]));
      expect(result.changes).toEqual([]);
    });

    test("a source that was searching at first has its first real answer as the baseline", () => {
      const searching = snapshot([], [source("claude-code", "searching")]);
      const memory = seenAfter(searching);
      const first = sessionChanges(memory, snapshot([withStatus(A, "finished"), waiting(B)]));
      expect(first.changes).toEqual([]);

      const next = sessionChanges(first.memory, snapshot([withStatus(B, "failed")]));
      expect(said(next.changes)).toEqual([["failed", B]]);
    });

    test("a session first seen already over says nothing, after the baseline too", () => {
      const memory = seenAfter(snapshot([working(A)]));
      const result = sessionChanges(
        memory,
        snapshot([working(A), withStatus(B, "finished"), withStatus(C, "failed")]),
      );
      expect(result.changes).toEqual([]);
    });

    test("a source that was not set up has a baseline of no sessions, so a session in it that later finishes is news", () => {
      const F = "status-files:night-shift.json";
      const custom = (status: SessionStatus) =>
        makeSession({ id: F, source: "status-files", agent: "Night Shift", status });
      const notSetUp = snapshot([], [source("status-files", "not-set-up")]);
      const memory = seenAfter(notSetUp, snapshot([custom("working")], [source("status-files")]));
      const result = sessionChanges(
        memory,
        snapshot([custom("finished")], [source("status-files")]),
      );
      expect(said(result.changes)).toEqual([["finished", F]]);
    });

    test("each source has a baseline of its own", () => {
      const X = "codex:00000000-0000-4000-8000-00000000000e";
      const codexWorking = makeSession({ id: X, source: "codex", status: "working" });
      const both = [source("claude-code"), source("codex")];
      const memory = seenAfter(snapshot([working(A)], [source("claude-code")]));
      // Codex answers for the first time with a session that has finished: a baseline.
      const result = sessionChanges(
        memory,
        snapshot([withStatus(A, "finished"), { ...codexWorking, status: "finished" }], both),
      );
      expect(said(result.changes)).toEqual([["finished", A]]);
    });
  });

  describe("a source that stops answering", () => {
    test.each<SourceState>(["searching", "unavailable", "error"])(
      "while it is %s, nothing about its sessions is said, and nothing ends",
      (state) => {
        const memory = seenAfter(snapshot([working(A), waiting(B)]));
        const result = sessionChanges(memory, snapshot([], [source("claude-code", state)]));
        expect(result.changes).toEqual([]);
        expect(result.stopped).toEqual([]);
        expect(result.memory.seen).toEqual(memory.seen);
      },
    );

    test("a source missing from the snapshot altogether says nothing either", () => {
      const memory = seenAfter(snapshot([working(A)]));
      const result = sessionChanges(memory, snapshot([], [source("codex")]));
      expect(result.changes).toEqual([]);
    });

    test("when it answers again, what changed meanwhile is said once", () => {
      const memory = seenAfter(
        snapshot([working(A), working(B), working(C)]),
        snapshot([], [source("claude-code", "error")]),
      );
      const result = sessionChanges(memory, snapshot([withStatus(A, "finished"), working(C)]));
      expect(said(result.changes)).toEqual([
        ["finished", A],
        ["ended", B],
      ]);
      expect(
        sessionChanges(result.memory, snapshot([withStatus(A, "finished"), working(C)])).changes,
      ).toEqual([]);
    });
  });

  describe("a source read in more than one way", () => {
    /** An answer of Claude Code read one way, as the poller names it. */
    function readAs(basis: string, sessions: Session[]): SessionsSnapshot {
      return snapshot(sessions, [{ ...source("claude-code"), basis }]);
    }

    /** Every change over the snapshots in turn, starting from nothing. */
    function saidOver(...snapshots: SessionsSnapshot[]): [string, string][] {
      let memory = EMPTY_CHANGE_MEMORY;
      const all: SessionChange[] = [];
      for (const each of snapshots) {
        const result = sessionChanges(memory, each);
        memory = result.memory;
        all.push(...result.changes);
      }
      return said(all);
    }

    test("a job the fallback cannot see has not ended, and its finish is told once when the command answers again", () => {
      const job = (status: SessionStatus) => withStatus(B, status, { name: "billing-webhooks" });
      expect(
        saidOver(
          readAs("registry+feed", [working(A), job("working")]),
          readAs("registry+feed", [working(A), job("working")]),
          // The command failed: the registry alone, which has no such job.
          readAs("registry", [working(A)]),
          readAs("registry", [working(A)]),
          readAs("registry+feed", [working(A), job("finished")]),
        ),
      ).toEqual([["finished", B]]);
    });

    test("the first answer read another way is a baseline, whatever it lacks or holds", () => {
      expect(
        saidOver(
          readAs("registry+feed", [working(A), working(B)]),
          readAs("registry", [withStatus(C, "finished")]),
        ),
      ).toEqual([]);
    });

    test("a session that ends while the other way is in use is told once, when the first way answers again", () => {
      const result = saidOver(
        readAs("registry+feed", [working(A), working(B)]),
        readAs("registry", [working(A), working(B)]),
        readAs("registry", [working(B)]),
        readAs("registry+feed", [working(B)]),
      );
      expect(result).toEqual([["ended", A]]);
    });

    test("a session told to have ended is not told to have finished when the other way lists it so", () => {
      expect(
        saidOver(
          readAs("registry+feed", [working(A)]),
          readAs("registry", [working(A)]),
          readAs("registry", []),
          readAs("registry+feed", [withStatus(A, "finished")]),
        ),
      ).toEqual([["ended", A]]);
    });

    test("a session listed as over is not told to have ended when an older answer read another way is compared", () => {
      expect(
        saidOver(
          readAs("registry", [working(A)]),
          // Already finished at this way's first answer: a baseline.
          readAs("registry+feed", [withStatus(A, "finished")]),
          readAs("registry", []),
        ),
      ).toEqual([]);
    });

    test("one answer read without what tells a finished session apart says nothing, before or after", () => {
      const X = "codex:00000000-0000-4000-8000-00000000000e";
      const Y = "codex:00000000-0000-4000-8000-00000000000f";
      const codex = (id: string, status: SessionStatus) =>
        makeSession({ id, source: "codex", status });
      const readCodex = (basis: string, sessions: Session[]) =>
        snapshot(sessions, [{ ...source("codex"), basis }]);
      expect(
        saidOver(
          readCodex("files", [codex(X, "finished"), codex(Y, "idle")]),
          readCodex("files", [codex(X, "finished"), codex(Y, "idle")]),
          readCodex("files-without-locks", [codex(X, "idle"), codex(Y, "idle")]),
          readCodex("files", [codex(X, "finished"), codex(Y, "idle")]),
        ),
      ).toEqual([]);
    });

    test("a session known to be over is forgotten once no answer of its source lists it", () => {
      let memory = EMPTY_CHANGE_MEMORY;
      for (const each of [
        readAs("registry+feed", [working(A)]),
        readAs("registry+feed", [withStatus(A, "finished")]),
        readAs("registry+feed", []),
      ]) {
        memory = sessionChanges(memory, each).memory;
      }
      expect(memory.over.get("claude-code")?.size).toBe(0);
    });
  });

  test("a session that finishes and then leaves the list has finished, and has not ended", () => {
    const memory = seenAfter(snapshot([working(A)]));
    const finished = sessionChanges(memory, snapshot([withStatus(A, "finished")]));
    expect(said(finished.changes)).toEqual([["finished", A]]);

    const gone = sessionChanges(finished.memory, snapshot([]));
    expect(gone.changes).toEqual([]);
  });

  test("a session that fails and then leaves the list has not ended either", () => {
    const memory = seenAfter(snapshot([working(A)]), snapshot([withStatus(A, "failed")]));
    expect(sessionChanges(memory, snapshot([])).changes).toEqual([]);
  });

  test("two changes in one snapshot are two events: those in the list in its order, then those that ended", () => {
    const memory = seenAfter(snapshot([working(A), working(B), working(C), working(D)]));
    const result = sessionChanges(
      memory,
      snapshot([withStatus(C, "failed"), working(B), waiting(D)]),
    );
    expect(said(result.changes)).toEqual([
      ["failed", C],
      ["needs-you", D],
      ["ended", A],
    ]);
  });

  test("a session that waits and then finishes is announced twice, and its wait stops when it finishes", () => {
    const memory = seenAfter(snapshot([working(A)]));
    const waits = sessionChanges(memory, snapshot([waiting(A)]));
    expect(said(waits.changes)).toEqual([["needs-you", A]]);

    const finishes = sessionChanges(waits.memory, snapshot([withStatus(A, "finished")]));
    expect(said(finishes.changes)).toEqual([["finished", A]]);
    expect(finishes.stopped).toEqual([A]);
  });

  test("a session that waits and finishes between two snapshots has only its finish seen", () => {
    const memory = seenAfter(snapshot([working(A)]));
    const result = sessionChanges(memory, snapshot([withStatus(A, "finished")]));
    expect(said(result.changes)).toEqual([["finished", A]]);
    expect(result.stopped).toEqual([]);
  });

  test("a session that finishes, runs again and finishes again has finished twice", () => {
    const memory = seenAfter(snapshot([working(A)]));
    const once = sessionChanges(memory, snapshot([withStatus(A, "finished")]));
    const running = sessionChanges(once.memory, snapshot([working(A)]));
    expect(running.changes).toEqual([]);
    const twice = sessionChanges(running.memory, snapshot([withStatus(A, "finished")]));
    expect(said(twice.changes)).toEqual([["finished", A]]);
  });

  test("a session listed twice counts once", () => {
    const memory = seenAfter(snapshot([working(A)]));
    const result = sessionChanges(
      memory,
      snapshot([withStatus(A, "finished"), withStatus(A, "finished")]),
    );
    expect(said(result.changes)).toEqual([["finished", A]]);
  });

  test("the same snapshot again reports nothing, and neither argument is changed", () => {
    const memory = seenAfter(snapshot([working(A), waiting(B), working(C)]));
    const next = snapshot([withStatus(A, "finished"), working(B)]);
    const frozen = JSON.stringify(next);
    const listed = (kept: ChangeMemory) => [
      ...(kept.seen.get("claude-code")?.get("")?.keys() ?? []),
    ];
    const seenBefore = listed(memory);

    const result = sessionChanges(memory, next);
    expect(said(result.changes)).toEqual([
      ["finished", A],
      ["ended", C],
    ]);
    expect(JSON.stringify(next)).toBe(frozen);
    expect(listed(memory)).toEqual(seenBefore);

    const again = sessionChanges(result.memory, next);
    expect(again.changes).toEqual([]);
    expect(again.stopped).toEqual([]);
  });

  test("the waits it follows are the ones waitChanges follows", () => {
    const snapshots = [
      snapshot([working(A), waiting(B)]),
      snapshot([waiting(A), working(B)]),
      snapshot([], [source("claude-code", "error")]),
      snapshot([waiting(A, { statusSince: at + 5_000 }), waiting(C)]),
    ];
    let waits: WaitMemory = EMPTY_WAIT_MEMORY;
    let changes: ChangeMemory = EMPTY_CHANGE_MEMORY;
    for (const each of snapshots) {
      const byWaits = waitChanges(waits, each);
      const bySessions = sessionChanges(changes, each);
      waits = byWaits.memory;
      changes = bySessions.memory;
      expect(bySessions.stopped).toEqual(byWaits.stopped);
      expect(
        bySessions.changes.filter((change) => change.event === "needs-you").map((c) => c.session),
      ).toEqual(byWaits.started);
    }
  });
});

describe("a list of events as it is written", () => {
  test("is read whatever its spaces, case, order or repeats, and written in the one order", () => {
    expect(readNoticeEvents("needs-you")).toEqual(["needs-you"]);
    expect(readNoticeEvents(" Ended, needs-you ,FAILED,ended")).toEqual([
      "needs-you",
      "failed",
      "ended",
    ]);
    expect(readNoticeEvents("")).toEqual([]);
    expect(readNoticeEvents("  ")).toEqual([]);
    expect(writeNoticeEvents(["ended", "needs-you", "finished"])).toBe("needs-you,finished,ended");
    expect(writeNoticeEvents([])).toBe("");
  });

  test.each([",", "finished,", "finished,,failed", "finish", "needs you", "on", "finished;failed"])(
    "is not read when any part is not one of the four names: %j",
    (text) => {
      expect(readNoticeEvents(text)).toBeNull();
    },
  );
});
