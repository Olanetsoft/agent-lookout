import { describe, expect, test } from "vitest";

import type { Session, SessionsSnapshot, SourceState } from "@core/sessions/session";
import {
  ANSWER_HOLDS_MS,
  answeredNow,
  inAnsweredWait,
  needsYou,
  type AnsweredWait,
} from "@core/waits/answeredWaits";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const OTHER = "claude-code:00000000-0000-4000-8000-000000000002";

const waiting = (overrides: Partial<Session> = {}) =>
  makeSession({
    id: ID,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: T0,
    ...overrides,
  });

/** When the poll the tests put the answers to is made. */
const POLL = T0 + 5_000;

function snapshot(sessions: Session[], state: SourceState = "ok"): SessionsSnapshot {
  return {
    generatedAt: POLL,
    sources: [{ id: "claude-code", label: "Claude Code", state, checkedAt: POLL }],
    sessions,
  };
}

/** An answer to the wait since `since`, given a second before the poll unless `at` says when. */
const answeredAt = (since: number | null, at = POLL - 1_000): AnsweredWait => ({
  source: "claude-code",
  since,
  at,
});

describe("whether a session needs the person", () => {
  test("a session waiting needs the person, and one in a wait that was answered does not", () => {
    expect(needsYou(waiting())).toBe(true);
    expect(needsYou(waiting({ answered: true }))).toBe(false);
  });

  test("a session in any other status does not", () => {
    for (const status of ["working", "idle", "finished", "failed", "unknown"] as const) {
      expect(needsYou(makeSession({ status })), status).toBe(false);
    }
  });
});

describe("whether a session is still in the wait that was answered", () => {
  test("waiting for permission since the same time is the same wait", () => {
    expect(inAnsweredWait(waiting(), { since: T0 })).toBe(true);
  });

  test("a wait since another time is another wait", () => {
    expect(inAnsweredWait(waiting({ statusSince: T0 + 1_500 }), { since: T0 })).toBe(false);
  });

  test("a time that either side does not know says nothing about the wait", () => {
    expect(inAnsweredWait(waiting({ statusSince: null }), { since: T0 })).toBe(true);
    expect(inAnsweredWait(waiting({ statusSince: T0 + 1_500 }), { since: null })).toBe(true);
  });

  test("a wait for anything but permission, or any other status, is not the prompt that was answered", () => {
    expect(inAnsweredWait(waiting({ waitingReason: "question" }), { since: T0 })).toBe(false);
    expect(inAnsweredWait(waiting({ waitingReason: undefined }), { since: T0 })).toBe(false);
    expect(inAnsweredWait(waiting({ status: "working" }), { since: T0 })).toBe(false);
  });
});

describe("the answers put to a poll", () => {
  test("a session still in the wait that was answered is marked, and the answer kept", () => {
    const answers = new Map([[ID, answeredAt(T0)]]);
    const { ids, kept } = answeredNow(answers, snapshot([waiting()]), POLL);
    expect([...ids]).toEqual([ID]);
    expect(kept).toEqual(answers);
  });

  test("an answer is let go once a poll finds its session moved on, in a later wait, or gone", () => {
    for (const sessions of [
      [waiting({ status: "working", waitingReason: undefined })],
      [waiting({ statusSince: T0 + 1_500 })],
      [waiting({ id: OTHER })],
      [],
    ]) {
      const { ids, kept } = answeredNow(new Map([[ID, answeredAt(T0)]]), snapshot(sessions), POLL);
      expect(ids.size, JSON.stringify(sessions)).toBe(0);
      expect(kept.size, JSON.stringify(sessions)).toBe(0);
    }
  });

  test("an answer whose source could not be read this time is kept, and marks nothing", () => {
    for (const state of ["error", "searching", "unavailable"] as const) {
      const answers = new Map([[ID, answeredAt(T0)]]);
      const { ids, kept } = answeredNow(answers, snapshot([], state), POLL);
      expect(ids.size, state).toBe(0);
      expect(kept, state).toEqual(answers);
    }
  });

  test("a source that is not set up was read, so an answer for it is let go", () => {
    const { kept } = answeredNow(new Map([[ID, answeredAt(T0)]]), snapshot([], "not-set-up"), POLL);
    expect(kept.size).toBe(0);
  });

  test("a session nothing was answered for is never marked", () => {
    const { ids } = answeredNow(new Map(), snapshot([waiting()]), POLL);
    expect(ids.size).toBe(0);
  });

  test("an answer stands for its wait until it is ANSWER_HOLDS_MS old, and is let go then, though the session still reads as in that wait", () => {
    const answers = new Map([[ID, answeredAt(T0, POLL - ANSWER_HOLDS_MS + 1)]]);
    expect([...answeredNow(answers, snapshot([waiting()]), POLL).ids]).toEqual([ID]);

    const old = new Map([[ID, answeredAt(T0, POLL - ANSWER_HOLDS_MS)]]);
    const { ids, kept } = answeredNow(old, snapshot([waiting()]), POLL);
    expect(ids.size).toBe(0);
    expect(kept.size).toBe(0);
  });

  test("an answer that old is let go when its source could not be read, and when the clock was set back as far", () => {
    const old = new Map([[ID, answeredAt(T0, POLL - ANSWER_HOLDS_MS)]]);
    expect(answeredNow(old, snapshot([], "error"), POLL).kept.size).toBe(0);

    const ahead = new Map([[ID, answeredAt(T0, POLL + ANSWER_HOLDS_MS)]]);
    expect(answeredNow(ahead, snapshot([waiting()]), POLL).ids.size).toBe(0);
    // A clock set back a moment, as it can be when it is corrected, lets nothing go.
    const moment = new Map([[ID, answeredAt(T0, POLL + 200)]]);
    expect([...answeredNow(moment, snapshot([waiting()]), POLL).ids]).toEqual([ID]);
  });
});
