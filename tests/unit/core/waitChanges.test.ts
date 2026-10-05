import { describe, expect, test } from "vitest";

import type {
  Session,
  SessionsSnapshot,
  SessionStatus,
  SourceHealth,
  SourceId,
  SourceState,
} from "@core/session";
import { EMPTY_WAIT_MEMORY, waitChanges, type WaitMemory } from "@core/waitChanges";
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
  const ids: Record<SourceId, string[]> = { "claude-code": [A, B, C], codex: [D, E] };
  const sourceOf = (id: string): SourceId => (id.startsWith("codex:") ? "codex" : "claude-code");
  const statuses: SessionStatus[] = [
    "needs-you",
    "needs-you",
    "working",
    "idle",
    "finished",
    "failed",
    "unknown",
  ];
  const states: SourceState[] = ["ok", "ok", "ok", "ok", "error", "searching", "unavailable"];
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
        const sources = (["claude-code", "codex"] as const)
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
        const ok = new Set(sources.filter((each) => each.state === "ok").map((each) => each.id));
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
