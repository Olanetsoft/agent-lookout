import { describe, expect, test } from "vitest";

import {
  FAILED_FINISH_REASONS,
  FAILED_TURN_KIND,
  HERMES_AGENT_ROLES,
  mapHermesAgentStatus,
  type HermesAgentNewestRow,
  type HermesAgentStatusInput,
} from "@core/mapping/hermes-agent/hermesAgentMapping";

/** Midday UTC on 1 October 2026. */
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const MINUTE = 60_000;

/** A reply that ended the turn a minute ago. */
function reply(fields: Partial<HermesAgentNewestRow> = {}): HermesAgentNewestRow {
  return {
    role: "assistant",
    kind: null,
    finish: "stop",
    error: null,
    at: NOW - MINUTE,
    ...fields,
  };
}

/** A lease taken two minutes ago, with five left. */
const LIVE = { at: NOW - 2 * MINUTE, until: NOW + 5 * MINUTE };

/** A session that is open, idle on a reply a minute old, with no lease, no label and no question. */
function input(fields: Partial<HermesAgentStatusInput> = {}): HermesAgentStatusInput {
  return {
    endedAt: null,
    endReason: null,
    newest: reply(),
    openQuestions: 0,
    openCalls: 0,
    callsAt: null,
    approvalLabel: null,
    questionLabel: null,
    labelAt: null,
    lease: null,
    holderAlive: null,
    activityAt: NOW - MINUTE,
    now: NOW,
    ...fields,
  };
}

/** The tool call that waits: written 90 seconds ago, in the turn that took its lease two minutes ago. */
const CALLS_AT = NOW - 90_000;

/** A label saved for that call, 30 seconds ago, with the call's tool still to answer. */
const LABELLED = { openCalls: 1, labelAt: NOW - 30_000 };

describe("mapHermesAgentStatus", () => {
  test("follows the table, row by row, in order", () => {
    // Each row of the table in hermesAgentMapping.ts and docs/adapters/hermes-agent.md.
    const waiting = { lease: LIVE, holderAlive: true, callsAt: CALLS_AT };
    expect(mapHermesAgentStatus(input({ ...waiting, openQuestions: 1, openCalls: 1 }))).toEqual({
      status: "needs-you",
      since: CALLS_AT,
      waitingReason: "question",
    });
    expect(mapHermesAgentStatus(input({ ...waiting, ...LABELLED, approvalLabel: 1 }))).toEqual({
      status: "needs-you",
      since: CALLS_AT,
      waitingReason: "permission",
    });
    expect(mapHermesAgentStatus(input({ ...waiting, ...LABELLED, questionLabel: 1 }))).toEqual({
      status: "needs-you",
      since: CALLS_AT,
      waitingReason: "question",
    });
    expect(mapHermesAgentStatus(input({ lease: LIVE, holderAlive: true }))).toEqual({
      status: "working",
      since: LIVE.at,
    });
    expect(
      mapHermesAgentStatus(input({ newest: reply({ kind: FAILED_TURN_KIND, error: 1 }) })),
    ).toEqual({ status: "failed", since: NOW - MINUTE });
    expect(mapHermesAgentStatus(input({ endedAt: NOW - 3 * MINUTE }))).toEqual({
      status: "finished",
      since: NOW - 3 * MINUTE,
    });
    expect(mapHermesAgentStatus(input())).toEqual({ status: "idle", since: NOW - MINUTE });
  });

  test("an open question comes before the approval label, which comes before the question label", () => {
    const all = input({
      lease: LIVE,
      holderAlive: true,
      callsAt: CALLS_AT,
      openQuestions: 2,
      ...LABELLED,
      approvalLabel: 1,
      questionLabel: 1,
    });
    expect(mapHermesAgentStatus(all).waitingReason).toBe("question");
    expect(mapHermesAgentStatus({ ...all, openQuestions: 0 }).waitingReason).toBe("permission");
    expect(mapHermesAgentStatus({ ...all, openQuestions: 0, approvalLabel: 0 }).waitingReason).toBe(
      "question",
    );
  });

  test("a live lease comes before a failed turn and an end stamp", () => {
    const over = input({
      lease: LIVE,
      holderAlive: true,
      newest: reply({ kind: FAILED_TURN_KIND, error: 1 }),
      endedAt: NOW - MINUTE,
    });
    expect(mapHermesAgentStatus(over)).toEqual({ status: "working", since: LIVE.at });
  });

  test("a wait keeps the time of its tool call for as long as it lasts, however the label and lease move", () => {
    const seen = [0, 10_000, MINUTE, 3 * MINUTE].map((later) =>
      mapHermesAgentStatus(
        input({
          now: NOW + later,
          // Hermes Agent renews the lease, and touches the label, as the wait goes on.
          lease: { at: LIVE.at, until: NOW + later + 5 * MINUTE },
          holderAlive: true,
          callsAt: CALLS_AT,
          openCalls: 1,
          approvalLabel: 1,
          labelAt: NOW + later - 10_000,
          activityAt: NOW + later,
        }),
      ),
    );
    expect(new Set(seen.map((status) => status.since))).toEqual(new Set([CALLS_AT]));
    expect(seen.every((status) => status.waitingReason === "permission")).toBe(true);
  });

  test("with no tool call to time it from, neither a label nor a count of questions is a wait", () => {
    const labelled = { lease: LIVE, holderAlive: true, callsAt: null, ...LABELLED };
    const working = { status: "working", since: LIVE.at };
    expect(mapHermesAgentStatus(input({ ...labelled, approvalLabel: 1 }))).toEqual(working);
    expect(mapHermesAgentStatus(input({ ...labelled, questionLabel: 1 }))).toEqual(working);
    expect(mapHermesAgentStatus(input({ ...labelled, openQuestions: 1 }))).toEqual(working);
  });

  test("a call an earlier turn left with no result is no wait in a new turn, as after a gateway was killed while it asked", () => {
    // The clarify call was written 49 minutes ago; this turn took its lease 2 minutes ago.
    const dangling = {
      lease: LIVE,
      holderAlive: true,
      callsAt: NOW - 49 * MINUTE,
      openQuestions: 1,
      openCalls: 1,
    };
    const working = { status: "working", since: LIVE.at };
    expect(mapHermesAgentStatus(input(dangling))).toEqual(working);
    // Nor is an approval label left by that turn, even saved after the call.
    expect(
      mapHermesAgentStatus(input({ ...dangling, approvalLabel: 1, labelAt: NOW - 48 * MINUTE })),
    ).toEqual(working);
    expect(
      mapHermesAgentStatus(input({ ...dangling, questionLabel: 1, labelAt: NOW - 48 * MINUTE })),
    ).toEqual(working);
    // A call written the moment the lease was taken is the turn's.
    expect(mapHermesAgentStatus(input({ ...dangling, callsAt: LIVE.at })).waitingReason).toBe(
      "question",
    );
  });

  test("a label saved before the newest call, or once that call's tools have all answered, is no wait", () => {
    const turn = { lease: LIVE, holderAlive: true, callsAt: CALLS_AT, openCalls: 1 };
    const working = { status: "working", since: LIVE.at };
    for (const label of [{ approvalLabel: 1 }, { questionLabel: 1 }]) {
      // Saved for an earlier call of the turn, before this one was written.
      expect(mapHermesAgentStatus(input({ ...turn, ...label, labelAt: CALLS_AT - 1 }))).toEqual(
        working,
      );
      // Saved for this call, whose tool has answered since.
      expect(
        mapHermesAgentStatus(input({ ...turn, ...label, labelAt: NOW - 30_000, openCalls: 0 })),
      ).toEqual(working);
      // With no time saved, it cannot be placed.
      expect(mapHermesAgentStatus(input({ ...turn, ...label, labelAt: null }))).toEqual(working);
      // Saved the moment the call was written, it is the call's.
      expect(mapHermesAgentStatus(input({ ...turn, ...label, labelAt: CALLS_AT })).status).toBe(
        "needs-you",
      );
    }
  });

  test("an approval label that outlasts its wait is not put on the next tool call, so the wait is never announced again", () => {
    const turn = { lease: LIVE, holderAlive: true, approvalLabel: 1 };
    // The approval waits on a terminal call; Hermes Agent saved the label 40 seconds ago.
    const asking = mapHermesAgentStatus(
      input({ ...turn, callsAt: NOW - 50_000, openCalls: 1, labelAt: NOW - 40_000 }),
    );
    expect(asking).toEqual({
      status: "needs-you",
      since: NOW - 50_000,
      waitingReason: "permission",
    });
    // Approved: the command answered, and the model made another call 5 seconds
    // ago. The label is saved at most once a minute, so it still says it waits.
    const movedOn = mapHermesAgentStatus(
      input({ ...turn, callsAt: NOW - 5_000, openCalls: 1, labelAt: NOW - 40_000 }),
    );
    expect(movedOn).toEqual({ status: "working", since: LIVE.at });
    // While the approved command still runs, the wait keeps its own time.
    const running = mapHermesAgentStatus(
      input({
        ...turn,
        callsAt: NOW - 50_000,
        openCalls: 1,
        labelAt: NOW - 40_000,
        now: NOW + 30_000,
      }),
    );
    expect(running.since).toBe(NOW - 50_000);
  });

  test("a lease that has run out is not live, and the moment it runs out is judged by the clock alone", () => {
    const lease = { at: NOW - 6 * MINUTE, until: NOW };
    expect(mapHermesAgentStatus(input({ lease, holderAlive: true, now: NOW - 1 }))).toMatchObject({
      status: "working",
    });
    expect(mapHermesAgentStatus(input({ lease, holderAlive: true, now: NOW }))).toEqual({
      status: "idle",
      since: NOW - MINUTE,
    });
    // An expired lease with a question open leaves no wait behind.
    expect(
      mapHermesAgentStatus(
        input({ lease, holderAlive: true, openQuestions: 1, openCalls: 1, callsAt: CALLS_AT }),
      ).status,
    ).toBe("idle");
  });

  test("a lease whose process is gone is not live, and one whose process could not be checked trusts its expiry", () => {
    expect(mapHermesAgentStatus(input({ lease: LIVE, holderAlive: false }))).toEqual({
      status: "idle",
      since: NOW - MINUTE,
    });
    expect(
      mapHermesAgentStatus(input({ lease: LIVE, holderAlive: false, openQuestions: 1 })).status,
    ).toBe("idle");
    expect(mapHermesAgentStatus(input({ lease: LIVE, holderAlive: null }))).toEqual({
      status: "working",
      since: LIVE.at,
    });
  });

  test("a failed turn is Hermes Agent's failure row with an error, or a reply that finished on an error", () => {
    expect(FAILED_TURN_KIND).toBe("failed_turn");
    expect(FAILED_FINISH_REASONS).toEqual(["error", "agent_error", "content_filter"]);
    for (const finish of FAILED_FINISH_REASONS) {
      expect(mapHermesAgentStatus(input({ newest: reply({ finish }) })).status, finish).toBe(
        "failed",
      );
    }
    // A failure row with no error, as an interrupt before any text leaves, is idle.
    expect(
      mapHermesAgentStatus(input({ newest: reply({ kind: FAILED_TURN_KIND, error: 0 }) })).status,
    ).toBe("idle");
    expect(
      mapHermesAgentStatus(input({ newest: reply({ kind: FAILED_TURN_KIND, error: null }) }))
        .status,
    ).toBe("idle");
    // An error key on a row that is not a failure row says nothing.
    expect(mapHermesAgentStatus(input({ newest: reply({ error: 1 }) })).status).toBe("idle");
    // Nor does a failure row of anyone but the assistant.
    expect(
      mapHermesAgentStatus(
        input({ newest: reply({ role: "tool", kind: FAILED_TURN_KIND, error: 1 }) }),
      ).status,
    ).toBe("idle");
    // A reply that stopped for another reason, or a turn that asked for tools, is not a failure.
    for (const finish of ["stop", "length", "tool_calls", "interrupted"]) {
      expect(mapHermesAgentStatus(input({ newest: reply({ finish }) })).status, finish).toBe(
        "idle",
      );
    }
  });

  test("a failed session stays failed once it is ended", () => {
    const ended = { endedAt: NOW - 30_000, endReason: "cli_close" };
    expect(
      mapHermesAgentStatus(input({ ...ended, newest: reply({ finish: "agent_error" }) })),
    ).toEqual({ status: "failed", since: NOW - MINUTE });
    expect(
      mapHermesAgentStatus(input({ ...ended, newest: reply({ kind: FAILED_TURN_KIND, error: 1 }) }))
        .status,
    ).toBe("failed");
  });

  test("an idle session with no conversation row yet is timed from the newest time anything of it was written", () => {
    expect(mapHermesAgentStatus(input({ newest: null, activityAt: NOW - 7 * MINUTE }))).toEqual({
      status: "idle",
      since: NOW - 7 * MINUTE,
    });
    expect(mapHermesAgentStatus(input({ newest: null, activityAt: null }))).toEqual({
      status: "idle",
      since: null,
    });
    // A newest row with no time falls back the same way.
    expect(
      mapHermesAgentStatus(input({ newest: reply({ at: null }), activityAt: NOW - 7 * MINUTE }))
        .since,
    ).toBe(NOW - 7 * MINUTE);
  });

  test("a time from the future or before any could be is no time", () => {
    expect(
      mapHermesAgentStatus(input({ lease: { at: NOW + 10 * MINUTE, until: NOW + 15 * MINUTE } })),
    ).toEqual({ status: "working", since: null });
    expect(mapHermesAgentStatus(input({ newest: reply({ at: 5 }), activityAt: null })).since).toBe(
      null,
    );
  });

  test("the roles it knows are the conversation's own", () => {
    expect(HERMES_AGENT_ROLES).toEqual(["user", "assistant", "tool"]);
    for (const role of HERMES_AGENT_ROLES) {
      expect(mapHermesAgentStatus(input({ newest: reply({ role }) })).status, role).toBe("idle");
    }
  });

  describe("a field of the wrong type, or a role it does not know, is unknown, before anything else", () => {
    const live = { lease: LIVE, holderAlive: true };
    test.each<[string, Partial<HermesAgentStatusInput>]>([
      ["a newest row of another role", { newest: reply({ role: "system" }) }],
      ["a newest row of a role it has never seen", { newest: reply({ role: "planner" }) }],
      ["a role that is not text", { newest: reply({ role: 1 }) }],
      ["a role of none", { newest: reply({ role: null }) }],
      ["a kind that is not text", { newest: reply({ kind: 3 }) }],
      ["a finish that is not text", { newest: reply({ finish: undefined }) }],
      ["an error flag of 2", { newest: reply({ error: 2 }) }],
      ["a newest row's time in seconds with a fraction", { newest: reply({ at: NOW - 0.5 }) }],
      ["a newest row's time as text", { newest: reply({ at: String(NOW) }) }],
      ["an end of the wrong type", { endedAt: "yesterday" }],
      ["an end reason that is not text", { endReason: 7 }],
      ["a count of questions below none", { ...live, openQuestions: -1 }],
      ["a count of questions with a fraction", { ...live, openQuestions: 0.5 }],
      ["a count of questions that is not a number", { ...live, openQuestions: "1" }],
      ["a count of open calls below none", { ...live, openCalls: -1 }],
      ["a count of open calls that is not a number", { ...live, openCalls: "1" }],
      ["a label's time that is not a number", { ...live, labelAt: "now" }],
      ["an approval label of 2", { ...live, approvalLabel: 2 }],
      ["a question label that is text", { ...live, questionLabel: "1" }],
      ["a tool call's time that is not a number", { ...live, callsAt: "now" }],
      ["a lease with no start", { lease: { at: null, until: LIVE.until }, holderAlive: true }],
      ["a lease with an end that is not a number", { lease: { at: LIVE.at, until: "soon" } }],
      [
        "a field left undefined, as the reader leaves one of the wrong type",
        { endedAt: undefined },
      ],
    ])("%s", (_what, fields) => {
      expect(mapHermesAgentStatus(input(fields))).toEqual({ status: "unknown", since: null });
    });

    test("even when a live lease would say working", () => {
      expect(mapHermesAgentStatus(input({ ...live, newest: reply({ role: "system" }) }))).toEqual({
        status: "unknown",
        since: null,
      });
    });
  });

  test("never says what a session is asking, which Hermes Agent keeps in its memory", () => {
    const status = mapHermesAgentStatus(
      input({ lease: LIVE, holderAlive: true, callsAt: CALLS_AT, openQuestions: 1, openCalls: 1 }),
    );
    expect(status).not.toHaveProperty("waitingText");
    expect(Object.keys(status).sort()).toEqual(["since", "status", "waitingReason"]);
  });
});
