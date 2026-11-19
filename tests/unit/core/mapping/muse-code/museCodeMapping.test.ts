import { describe, expect, test } from "vitest";

import {
  applyMuseRecord,
  startMuseFold,
  type MuseFold,
  type MuseRecord,
} from "@core/mapping/muse-code/museCodeFold";
import {
  ASK_DELAY_MS,
  decidedAtOf,
  museCodeStatusOf,
  QUIET_MS,
  REVIEW_LIMIT_MS,
  settledByLog,
  type MuseCodeFacts,
} from "@core/mapping/muse-code/museCodeMapping";
import { CLOCK_SLACK_MS } from "@core/time";

const NOW = 1_795_000_000_000;
const MINUTE = 60_000;
const R = "run-1";
const OPENED = NOW - 10 * MINUTE;

function fold(...records: MuseRecord[]): MuseFold {
  return records.reduce(
    (made, record) => applyMuseRecord(made, record),
    startMuseFold({ sort: "started", run: R, at: OPENED }),
  );
}

const facts = (fields: Partial<MuseCodeFacts> & { fold?: MuseFold }): MuseCodeFacts => {
  const { fold: made, ...rest } = fields;
  return {
    view: { state: "ok", fold: made ?? fold() },
    writer: "backed",
    writtenAt: NOW - 1_000,
    decidedAt: NOW - 1_000,
    now: NOW,
    waited: new Set(),
    ...rest,
  };
};

const status = (fields: Parameters<typeof facts>[0]) => museCodeStatusOf(facts(fields));

const ended = (
  end: "completed" | "failed" | "cancelled" | "other",
  at = NOW - MINUTE,
): MuseRecord => ({
  sort: "terminal",
  run: R,
  end,
  at,
});
const approval = (
  phase: "automated_reviewing" | "human_pending" | "other" | "none",
  at = NOW - 5_000,
): MuseRecord => ({
  sort: "requested",
  run: R,
  action: "a1",
  phase,
  at,
});

describe("each row of the status", () => {
  test("1: a view too far back or unsure is unknown, whatever else holds", () => {
    for (const view of [{ state: "too-far" }, { state: "unsure" }] as const) {
      expect(museCodeStatusOf({ ...facts({ writer: "gone" }), view })).toMatchObject({
        status: "unknown",
        since: null,
      });
    }
  });

  test("2: a run not open whose newest end failed is failed, through a resume and a session's end, and with ps saying none runs", () => {
    for (const after of [
      [],
      [{ sort: "resumed", at: NOW - 30_000 }],
      [{ sort: "end", at: NOW - 30_000 }],
    ] as MuseRecord[][]) {
      for (const writer of ["backed", "gone", "maybe"] as const) {
        expect(status({ fold: fold(ended("failed"), ...after), writer })).toEqual({
          status: "failed",
          since: NOW - MINUTE,
          showsLastWrite: false,
        });
      }
    }
  });

  test("2: another run's failed end, as a queued launch's, leaves the open run working and unsettled", () => {
    const made = fold({ sort: "terminal", run: "run-2", end: "failed", at: NOW - MINUTE });
    expect(made.lastEnd).toEqual({ end: "failed", at: NOW - MINUTE });
    expect(status({ fold: made }).status).toBe("working");
    expect(settledByLog({ state: "ok", fold: made })).toBe(false);
  });

  test("2: a failure whose time cannot be right is unknown, as it only stops a finish", () => {
    for (const at of [null, NOW + CLOCK_SLACK_MS + 1]) {
      expect(status({ fold: fold(ended("failed", at as number)), writer: "gone" })).toMatchObject({
        status: "unknown",
      });
    }
  });

  test("3: a run closed by the session's end, or ended before it, is finished since the end, whatever ps says", () => {
    for (const before of [[], [ended("completed")]] as MuseRecord[][]) {
      for (const writer of ["backed", "maybe"] as const) {
        expect(
          status({ fold: fold(...before, { sort: "end", at: NOW - 30_000 }), writer }),
        ).toEqual({
          status: "finished",
          since: NOW - 30_000,
          showsLastWrite: false,
        });
      }
    }
    expect(status({ fold: fold({ sort: "end", at: null }), writer: "gone" }).status).toBe(
      "unknown",
    );
  });

  test("4: with no word from ps, a session not settled by its log is unknown", () => {
    for (const made of [
      fold(),
      fold(ended("completed")),
      fold({ sort: "asked", run: R, prompt: "p", at: NOW }),
    ]) {
      expect(status({ fold: made, writer: "maybe" })).toMatchObject({ status: "unknown" });
    }
  });

  test("5: with no Muse Code that could hold it, a session is finished since the time judged", () => {
    expect(status({ writer: "gone", decidedAt: NOW - 3 * MINUTE })).toEqual({
      status: "finished",
      since: NOW - 3 * MINUTE,
      showsLastWrite: false,
    });
    expect(status({ writer: "gone", decidedAt: null }).since).toBeNull();
  });

  test("6: an open question is needing you, for a question, however quiet, since it was asked", () => {
    expect(
      status({
        fold: fold({ sort: "asked", run: R, prompt: "p1", at: NOW - 2 * MINUTE }),
        writtenAt: NOW - 2 * QUIET_MS,
      }),
    ).toEqual({
      status: "needs-you",
      since: NOW - 2 * MINUTE,
      waitingReason: "question",
      wait: { since: NOW - 2 * MINUTE, ids: ["question:p1"] },
      showsLastWrite: false,
    });
  });

  test("6: an approval waiting with a question is for permission, since the earliest wait", () => {
    const made = fold(
      { sort: "asked", run: R, prompt: "p1", at: NOW - MINUTE },
      approval("human_pending", NOW - 2 * MINUTE),
    );
    expect(status({ fold: made })).toMatchObject({
      status: "needs-you",
      since: NOW - 2 * MINUTE,
      waitingReason: "permission",
      wait: { ids: ["question:p1", "approval:a1"] },
    });
  });

  test("7: an open run written in the last 30 minutes is working since it opened, with its last write shown", () => {
    expect(status({ writtenAt: NOW - QUIET_MS + 1 })).toEqual({
      status: "working",
      since: OPENED,
      showsLastWrite: true,
    });
  });

  test("8: an open run quiet for 30 minutes, or with no write that can be right, is unknown", () => {
    for (const writtenAt of [NOW - QUIET_MS, null, NOW + CLOCK_SLACK_MS + 1]) {
      expect(status({ writtenAt })).toMatchObject({ status: "unknown" });
    }
  });

  test("9: a run that ended otherwise, or a session resumed, is idle since that end or resume", () => {
    for (const end of ["completed", "cancelled", "other"] as const) {
      expect(status({ fold: fold(ended(end)) })).toEqual({
        status: "idle",
        since: NOW - MINUTE,
        showsLastWrite: false,
      });
    }
    expect(status({ fold: fold({ sort: "resumed", at: NOW - 20_000 }) })).toMatchObject({
      status: "idle",
      since: NOW - 20_000,
    });
    expect(
      status({ fold: fold(ended("completed"), { sort: "resumed", at: NOW - 20_000 }) }),
    ).toMatchObject({
      status: "idle",
      since: NOW - 20_000,
    });
    // A resume shows no dead turn's work or wait.
    const resumed = fold(
      { sort: "asked", run: R, prompt: "p1", at: NOW - MINUTE },
      { sort: "resumed", at: NOW - 20_000 },
    );
    expect(status({ fold: resumed }).status).toBe("idle");
  });
});

describe("when an approval waits for the person", () => {
  const waits = (made: MuseFold, now = NOW, waited: string[] = []) =>
    museCodeStatusOf(facts({ fold: made, now, waited: new Set(waited) }));
  const requestedAt = NOW - 5_000;

  test("human_pending: at once, since it was asked", () => {
    expect(waits(fold(approval("human_pending", requestedAt)))).toMatchObject({
      status: "needs-you",
      since: requestedAt,
      waitingReason: "permission",
    });
  });

  test("automated_reviewing: working until the reviewer's word that is not a clean approval, then since that word", () => {
    const held = fold(approval("automated_reviewing", requestedAt), {
      sort: "review-started",
      run: R,
      action: "a1",
      at: requestedAt + 10,
    });
    expect(waits(held).status).toBe("working");
    const escalated = applyMuseRecord(held, {
      sort: "review-completed",
      run: R,
      action: "a1",
      clean: false,
      at: requestedAt + 20_000,
    });
    expect(waits(escalated, requestedAt + 21_000)).toMatchObject({
      status: "needs-you",
      since: requestedAt + 20_000,
    });
    const approved = fold(approval("automated_reviewing", requestedAt), {
      sort: "review-completed",
      run: R,
      action: "a1",
      clean: true,
      at: requestedAt + 20_000,
    });
    expect(waits(approved, requestedAt + 10 * REVIEW_LIMIT_MS).status).toBe("working");
  });

  test("automated_reviewing with no word: needing you 2 minutes after the request, since then", () => {
    const held = fold(approval("automated_reviewing", requestedAt));
    expect(waits(held, requestedAt + REVIEW_LIMIT_MS - 1).status).toBe("working");
    expect(waits(held, requestedAt + REVIEW_LIMIT_MS)).toMatchObject({
      status: "needs-you",
      since: requestedAt + REVIEW_LIMIT_MS,
    });
  });

  test("no phase, or one not known, with a review record: as for the reviewer's", () => {
    for (const phase of ["none", "other"] as const) {
      const held = fold(approval(phase, requestedAt), {
        sort: "review-started",
        run: R,
        action: "a1",
        at: requestedAt + 10,
      });
      expect(waits(held, requestedAt + ASK_DELAY_MS + 1).status, phase).toBe("working");
      expect(waits(held, requestedAt + REVIEW_LIMIT_MS).status, phase).toBe("needs-you");
    }
  });

  test("no phase, or one not known, with the reviewer's word and no record that it started: as for the reviewer's", () => {
    for (const phase of ["none", "other"] as const) {
      const word = (clean: boolean) =>
        fold(approval(phase, requestedAt), {
          sort: "review-completed",
          run: R,
          action: "a1",
          clean,
          at: requestedAt + 10,
        });
      expect(waits(word(true), requestedAt + ASK_DELAY_MS + 1).status, phase).toBe("working");
      expect(waits(word(false), requestedAt + ASK_DELAY_MS + 1), phase).toMatchObject({
        status: "needs-you",
        since: requestedAt + 10,
      });
    }
  });

  test("no phase, or one not known, and no review record: needing you 6 seconds after the request, since it", () => {
    for (const phase of ["none", "other"] as const) {
      const made = fold(approval(phase, requestedAt));
      expect(waits(made, requestedAt + ASK_DELAY_MS - 1).status, phase).toBe("working");
      expect(waits(made, requestedAt + ASK_DELAY_MS), phase).toMatchObject({
        status: "needs-you",
        since: requestedAt,
      });
    }
  });

  test("a timer needs a request time that can be right", () => {
    for (const phase of ["automated_reviewing", "none"] as const) {
      expect(waits(fold(approval(phase, null as unknown as number))).status, phase).toBe("working");
    }
    expect(waits(fold(approval("human_pending", null as unknown as number)))).toMatchObject({
      status: "needs-you",
      since: null,
    });
  });

  test("one that waited at the last poll waits while it is open, whatever the timers say, as after a clock set back", () => {
    const held = fold(approval("automated_reviewing", requestedAt));
    const back = requestedAt + 1_000;
    expect(waits(held, back).status).toBe("working");
    expect(waits(held, back, ["a1"])).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
    });
    const plain = fold(approval("none", requestedAt));
    expect(waits(plain, back, ["a1"])).toMatchObject({ status: "needs-you", since: requestedAt });
  });
});

describe("the time ps and the computer's start are judged against", () => {
  const withNewest = (at: number | null) => ({ lastRecordAt: at });

  test("is the newest record's time, never later than the file's last write", () => {
    expect(decidedAtOf(withNewest(NOW - MINUTE), NOW - 1_000, NOW)).toBe(NOW - MINUTE);
    expect(decidedAtOf(withNewest(NOW - 1_000), NOW - MINUTE + 0.5, NOW)).toBe(NOW - MINUTE);
  });

  test("is the file's last write when the record has no time, and none when either cannot be right", () => {
    expect(decidedAtOf(withNewest(null), NOW - 1_000, NOW)).toBe(NOW - 1_000);
    expect(decidedAtOf(null, NOW - 1_000, NOW)).toBe(NOW - 1_000);
    expect(decidedAtOf(withNewest(NOW + CLOCK_SLACK_MS + 1), NOW - 1_000, NOW)).toBeNull();
    expect(decidedAtOf(withNewest(NOW - MINUTE), null, NOW)).toBeNull();
    expect(decidedAtOf(withNewest(NOW - MINUTE), NOW + CLOCK_SLACK_MS + 1, NOW)).toBeNull();
  });
});

test("a session settled by its log alone needs no word from ps: unknown views, failures and ends", () => {
  expect(settledByLog({ state: "too-far" })).toBe(true);
  expect(settledByLog({ state: "unsure" })).toBe(true);
  expect(settledByLog({ state: "ok", fold: fold(ended("failed")) })).toBe(true);
  expect(settledByLog({ state: "ok", fold: fold({ sort: "end", at: NOW }) })).toBe(true);
  expect(settledByLog({ state: "ok", fold: fold(ended("completed")) })).toBe(false);
  expect(settledByLog({ state: "ok", fold: fold({ sort: "resumed", at: NOW }) })).toBe(false);
  expect(settledByLog({ state: "ok", fold: fold() })).toBe(false);
});
