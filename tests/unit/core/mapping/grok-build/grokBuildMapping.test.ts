import { describe, expect, test } from "vitest";

import {
  emptyGrokBuildTurn,
  grokBuildFinishedAt,
  mapGrokBuildStatus,
  NO_OUTPUT_MS,
  turnIsLeftOver,
  type GrokBuildFacts,
  type GrokBuildTurn,
} from "@core/mapping/grok-build/grokBuildMapping";
import { CLOCK_SLACK_MS, WRITE_TIME_STEP_MS } from "@core/time";
import { MINUTE, NOW, OPENED_AT, SECOND } from "@tests/fixtures/grok-build/grokBuild";

/** A turn that started a minute ago and is writing. */
const started = (fields: Partial<GrokBuildTurn> = {}): GrokBuildTurn => ({
  ...emptyGrokBuildTurn(),
  boundary: "started",
  at: NOW - MINUTE,
  schemaOk: true,
  outputSeen: true,
  turnLineAt: NOW - 30 * SECOND,
  ...fields,
});

const ended = (outcome: GrokBuildTurn["outcome"], at = NOW - MINUTE): GrokBuildTurn => ({
  ...emptyGrokBuildTurn(),
  boundary: "ended",
  at,
  outcome,
});

/** A listed session whose process runs, its log last written 5 seconds ago, with no plan waiting. */
function facts(turn: GrokBuildTurn | null, fields: Partial<GrokBuildFacts> = {}): GrokBuildFacts {
  return {
    alive: true,
    listed: true,
    log: turn === null ? { state: "unreadable" } : { state: "ok", turn },
    writtenAt: NOW - 5 * SECOND,
    plan: false,
    planWrittenAt: null,
    openedAt: OPENED_AT,
    now: NOW,
    ...fields,
  };
}

describe("the rows, in order", () => {
  test("1. a session whose process has ended is finished, whatever its log says", () => {
    for (const turn of [started(), started({ openQuestions: 1 }), ended("error"), null]) {
      expect(mapGrokBuildStatus(facts(turn, { alive: false })).status).toBe("finished");
    }
  });

  test("1. a plan waiting does not hold a session whose process has ended, listed or not", () => {
    for (const listed of [true, false]) {
      const status = mapGrokBuildStatus(facts(started(), { alive: false, listed, plan: true }));
      expect(status.status).toBe("finished");
    }
  });

  test("1. a session listed no more is finished once its turn is over", () => {
    for (const turn of [
      ended("completed"),
      ended("cancelled"),
      ended("error"),
      emptyGrokBuildTurn(),
    ]) {
      expect(mapGrokBuildStatus(facts(turn, { listed: false })).status).toBe("finished");
    }
  });

  test("1. a session listed no more whose log cannot say, or whose plan file cannot, is finished", () => {
    expect(mapGrokBuildStatus(facts(null, { listed: false })).status).toBe("finished");
    expect(
      mapGrokBuildStatus(facts(started(), { listed: false, log: { state: "no-folder" } })).status,
    ).toBe("finished");
    expect(
      mapGrokBuildStatus(facts(ended("completed"), { listed: false, plan: "unknown" })).status,
    ).toBe("finished");
    expect(mapGrokBuildStatus(facts(started({ malformed: true }), { listed: false })).status).toBe(
      "finished",
    );
  });

  test("1. a session listed no more with a turn left over is finished, not unknown", () => {
    const quiet = started({ outputSeen: false });
    const status = mapGrokBuildStatus(
      facts(quiet, { listed: false, writtenAt: NOW - NO_OUTPUT_MS - WRITE_TIME_STEP_MS }),
    );
    expect(status.status).toBe("finished");
  });

  test("1. a session listed no more shows while its turn runs, a question is open or a plan waits", () => {
    expect(mapGrokBuildStatus(facts(started(), { listed: false })).status).toBe("working");
    expect(
      mapGrokBuildStatus(
        facts(started({ openQuestions: 1, questionSince: NOW - 9 * SECOND }), { listed: false }),
      ).status,
    ).toBe("needs-you");
    expect(
      mapGrokBuildStatus(facts(ended("completed"), { listed: false, plan: true })).status,
    ).toBe("needs-you");
  });

  test("1. the time a session ended is the later of its listing and its log's last write", () => {
    expect(mapGrokBuildStatus(facts(started(), { alive: false })).since).toBe(NOW - 5 * SECOND);
    expect(
      mapGrokBuildStatus(facts(started(), { alive: false, writtenAt: OPENED_AT - MINUTE })).since,
    ).toBe(OPENED_AT);
    expect(mapGrokBuildStatus(facts(started(), { alive: false, writtenAt: null })).since).toBe(
      OPENED_AT,
    );
  });

  test("2. a listed session is unknown when its log cannot say", () => {
    const unknowns: [string, GrokBuildFacts][] = [
      ["no folder", facts(started(), { log: { state: "no-folder" } })],
      ["no log", facts(null)],
      ["too far back", facts({ ...emptyGrokBuildTurn(), tooFar: true })],
      [
        "a bad line",
        facts(ended("completed"), {
          log: { state: "ok", turn: { ...ended("completed"), malformed: true } },
        }),
      ],
      ["an outcome it does not know", facts(ended("other"))],
      ["a newer format", facts(started({ schemaOk: false }))],
      ["a plan file it cannot read", facts(ended("completed"), { plan: "unknown" })],
    ];
    for (const [why, given] of unknowns) {
      expect(mapGrokBuildStatus(given), why).toEqual({ status: "unknown", since: null });
    }
  });

  test("2. unknown comes before a question or a plan", () => {
    expect(
      mapGrokBuildStatus(facts(started({ openQuestions: 1, malformed: true, questionSince: NOW })))
        .status,
    ).toBe("unknown");
    expect(mapGrokBuildStatus(facts(started({ schemaOk: false }), { plan: true })).status).toBe(
      "unknown",
    );
  });

  test("3. a question open in the open turn needs you, since the first of the open questions", () => {
    const status = mapGrokBuildStatus(
      facts(started({ openQuestions: 2, questionSince: NOW - 20 * SECOND })),
    );
    expect(status).toEqual({
      status: "needs-you",
      since: NOW - 20 * SECOND,
      waitingReason: "question",
      wait: "question",
    });
  });

  test("3. a plan waiting needs you, since its call in the open turn", () => {
    const status = mapGrokBuildStatus(
      facts(started({ planToolAt: NOW - 40 * SECOND }), {
        plan: true,
        planWrittenAt: NOW - 30 * SECOND,
      }),
    );
    expect(status).toEqual({
      status: "needs-you",
      since: NOW - 40 * SECOND,
      waitingReason: "question",
      wait: "plan-call",
    });
  });

  test("3. a plan re-parked after a restart, with no call in an open turn, is since the later of its file's write and the listing", () => {
    const afterListing = mapGrokBuildStatus(
      facts(ended("interrupted"), { plan: true, planWrittenAt: OPENED_AT + MINUTE }),
    );
    expect(afterListing).toMatchObject({
      status: "needs-you",
      since: OPENED_AT + MINUTE,
      wait: "plan-file",
    });
    const beforeListing = mapGrokBuildStatus(
      facts(ended("interrupted"), { plan: true, planWrittenAt: OPENED_AT - 3 * MINUTE }),
    );
    expect(beforeListing).toMatchObject({
      status: "needs-you",
      since: OPENED_AT,
      wait: "plan-file",
    });
  });

  test("3. a newer exit_plan_mode call starts a new wait", () => {
    const first = mapGrokBuildStatus(
      facts(started({ planToolAt: NOW - 40 * SECOND }), { plan: true }),
    );
    const second = mapGrokBuildStatus(
      facts(started({ planToolAt: NOW - 5 * SECOND }), { plan: true }),
    );
    expect(first.since).toBe(NOW - 40 * SECOND);
    expect(second.since).toBe(NOW - 5 * SECOND);
  });

  test("3. a question's time stays while the questions are open", () => {
    const one = started({ openQuestions: 1, questionSince: NOW - 20 * SECOND });
    const two = { ...one, openQuestions: 2 };
    expect(mapGrokBuildStatus(facts(one)).since).toBe(mapGrokBuildStatus(facts(two)).since);
  });

  test("3. a question in a turn that has ended does not need you", () => {
    const status = mapGrokBuildStatus(facts({ ...ended("completed"), openQuestions: 1 }));
    expect(status.status).toBe("idle");
  });

  test("4. a turn started is working, since its start", () => {
    expect(mapGrokBuildStatus(facts(started()))).toEqual({
      status: "working",
      since: NOW - MINUTE,
    });
  });

  test("4. a wait for a tool's approval is working", () => {
    // Grok Build writes a permission check around every tool call, so it is not a wait.
    expect(mapGrokBuildStatus(facts(started())).status).toBe("working");
  });

  test("5. a turn that ended on an error, or that a crash cut off, is failed until the next starts", () => {
    expect(mapGrokBuildStatus(facts(ended("error")))).toEqual({
      status: "failed",
      since: NOW - MINUTE,
    });
    expect(mapGrokBuildStatus(facts(ended("interrupted")))).toEqual({
      status: "failed",
      since: NOW - MINUTE,
    });
  });

  test("6. a turn that completed or was cancelled is idle, since its end", () => {
    expect(mapGrokBuildStatus(facts(ended("completed")))).toEqual({
      status: "idle",
      since: NOW - MINUTE,
    });
    expect(mapGrokBuildStatus(facts(ended("cancelled")))).toEqual({
      status: "idle",
      since: NOW - MINUTE,
    });
  });

  test("5 and 6. a turn that ended before the listing, as in a session resumed later, is so since the listing", () => {
    const before = OPENED_AT - 2 * 24 * 60 * MINUTE;
    for (const [outcome, status] of [
      ["completed", "idle"],
      ["cancelled", "idle"],
      ["error", "failed"],
    ] as const) {
      expect(mapGrokBuildStatus(facts(ended(outcome, before)))).toEqual({
        status,
        since: OPENED_AT,
      });
    }
    // A listing whose time cannot be right leaves the turn's end.
    expect(
      mapGrokBuildStatus(facts(ended("completed", before), { openedAt: NOW + 5 * MINUTE })),
    ).toEqual({ status: "idle", since: before });
  });

  test("6. a log with no turn yet is idle since the listing", () => {
    expect(mapGrokBuildStatus(facts(emptyGrokBuildTurn()))).toEqual({
      status: "idle",
      since: OPENED_AT,
    });
  });
});

describe("a turn left over", () => {
  const quiet = started({ outputSeen: false, turnLineAt: NOW - 3 * MINUTE });

  test("rule 1: nothing from the model and a log quiet for 2 minutes and 2 seconds", () => {
    const at = (quietFor: number) =>
      mapGrokBuildStatus(facts(quiet, { writtenAt: NOW - quietFor })).status;
    expect(at(119 * SECOND)).toBe("working");
    expect(at(NO_OUTPUT_MS + WRITE_TIME_STEP_MS - 1)).toBe("working");
    expect(at(NO_OUTPUT_MS + WRITE_TIME_STEP_MS)).toBe("unknown");
  });

  test("rule 1 does not hold once the model wrote", () => {
    const wrote = { ...quiet, outputSeen: true };
    expect(mapGrokBuildStatus(facts(wrote, { writtenAt: NOW - 10 * MINUTE })).status).toBe(
      "working",
    );
  });

  test("rule 1 does not hold for a log written after the clock, as when it was set back", () => {
    expect(mapGrokBuildStatus(facts(quiet, { writtenAt: NOW + 10 * SECOND })).status).toBe(
      "working",
    );
    expect(mapGrokBuildStatus(facts(quiet, { writtenAt: NOW + 10 * MINUTE })).status).toBe(
      "working",
    );
  });

  test("rule 2: a turn that started more than a minute before the listing, with no turn line since", () => {
    const at = (before: number, turnLineAt: number | null = OPENED_AT - 2 * MINUTE) =>
      mapGrokBuildStatus(facts(started({ at: OPENED_AT - before, turnLineAt }))).status;
    expect(at(CLOCK_SLACK_MS + SECOND)).toBe("unknown");
    expect(at(CLOCK_SLACK_MS - SECOND)).toBe("working");
    expect(at(CLOCK_SLACK_MS + SECOND, null)).toBe("unknown");
    expect(at(CLOCK_SLACK_MS + SECOND, OPENED_AT)).toBe("working");
    expect(at(CLOCK_SLACK_MS + SECOND, OPENED_AT + SECOND)).toBe("working");
  });

  test("rule 2 is judged against the first listing by the process that lists the session again", () => {
    // Listed at OPENED_AT, a question asked, then gone back to after /new by the same process.
    const turn = started({
      at: OPENED_AT + MINUTE,
      turnLineAt: OPENED_AT + MINUTE + 10 * SECOND,
      openQuestions: 1,
      questionSince: OPENED_AT + MINUTE + 10 * SECOND,
    });
    const again = NOW - MINUTE;
    expect(mapGrokBuildStatus(facts(turn, { openedAt: again })).status).toBe("unknown");
    expect(
      mapGrokBuildStatus(facts(turn, { openedAt: again, firstOpenedAt: OPENED_AT })),
    ).toMatchObject({ status: "needs-you", since: OPENED_AT + MINUTE + 10 * SECOND });
    const running = { ...turn, openQuestions: 0, questionSince: null };
    expect(
      mapGrokBuildStatus(facts(running, { openedAt: again, firstOpenedAt: OPENED_AT })).status,
    ).toBe("working");
    // A turn that started before that first listing is still left over.
    const older = started({ at: OPENED_AT - 5 * MINUTE, turnLineAt: OPENED_AT - 4 * MINUTE });
    expect(
      mapGrokBuildStatus(facts(older, { openedAt: again, firstOpenedAt: OPENED_AT })).status,
    ).toBe("unknown");
  });

  test("rule 2 takes no part when a time cannot be right", () => {
    const future = facts(started({ at: OPENED_AT - 5 * MINUTE }), { openedAt: NOW + 5 * MINUTE });
    expect(turnIsLeftOver(future.log.state === "ok" ? future.log.turn : started(), future)).toBe(
      false,
    );
    const early = facts(started({ at: Date.UTC(2019, 0, 1), turnLineAt: null }));
    expect(mapGrokBuildStatus(early).status).toBe("working");
  });

  test("neither rule holds for a turn that ended", () => {
    expect(turnIsLeftOver(ended("completed"), facts(ended("completed")))).toBe(false);
  });
});

describe("times", () => {
  test("every time is judged against the clock of the poll", () => {
    const ahead = started({ at: NOW + 5 * MINUTE });
    expect(mapGrokBuildStatus(facts(ahead)).since).toBeNull();
    expect(mapGrokBuildStatus(facts(ahead, { now: NOW + 5 * MINUTE })).since).toBe(
      NOW + 5 * MINUTE,
    );
  });

  test("a finished time takes the plausible one of the two", () => {
    expect(grokBuildFinishedAt(NOW + 10 * MINUTE, NOW - MINUTE, NOW)).toBe(NOW - MINUTE);
    expect(grokBuildFinishedAt(OPENED_AT, NOW + 10 * MINUTE, NOW)).toBe(OPENED_AT);
    expect(grokBuildFinishedAt(NOW + 10 * MINUTE, null, NOW)).toBeNull();
    expect(grokBuildFinishedAt(OPENED_AT, NOW - 0.5, NOW)).toBe(NOW - 1);
  });
});
