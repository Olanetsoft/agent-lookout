import { describe, expect, test } from "vitest";

import {
  applyMuseRecord,
  copyMuseFold,
  PENDING_MAX,
  startMuseFold,
  type MuseFold,
  type MuseRecord,
} from "@core/mapping/muse-code/museCodeFold";

const T = 1_795_000_000_000;
const R = "run-1";
const S = "run-2";

/** The fold of these records, the first a run's start. */
function fold(...records: MuseRecord[]): MuseFold {
  const [first, ...rest] = records;
  if (first?.sort !== "started") throw new Error("A fold begins at a start.");
  return rest.reduce((made, record) => applyMuseRecord(made, record), startMuseFold(first));
}

const start = (run = R, at = T): MuseRecord => ({ sort: "started", run, at });
const end = (
  run = R,
  kind: "completed" | "failed" | "cancelled" | "other" = "completed",
  at = T + 9,
): MuseRecord => ({
  sort: "terminal",
  run,
  end: kind,
  at,
});
const ask = (prompt: string, run = R, at = T + 1): MuseRecord => ({
  sort: "asked",
  run,
  prompt,
  at,
});
const request = (action: string, run = R, at = T + 1): MuseRecord => ({
  sort: "requested",
  run,
  action,
  phase: "human_pending",
  at,
});

describe("a fold begins at a run's start", () => {
  test("with the run open since its start, no end, no marker and no wait", () => {
    expect(fold(start())).toEqual({
      run: { id: R, state: "open", openedAt: T },
      lastEnd: null,
      marker: null,
      prompts: new Map(),
      approvals: new Map(),
      lastRecordAt: T,
      crowded: false,
    });
  });

  test("and a later start begins it afresh, a failure before it with it", () => {
    const made = fold(start(), end(R, "failed"), start(S, T + 20));
    expect(made.run).toEqual({ id: S, state: "open", openedAt: T + 20 });
    expect(made.lastEnd).toBeNull();
  });
});

describe("a run's end", () => {
  test("ends the run, clears the marker and every question and approval", () => {
    const made = fold(start(), ask("p1"), request("a1"), end(R, "cancelled", T + 5));
    expect(made.run.state).toBe("ended");
    expect(made.lastEnd).toEqual({ end: "cancelled", at: T + 5 });
    expect(made.prompts.size + made.approvals.size).toBe(0);
  });

  test("a retraction ends it as an end of a word not known, and another run's retraction does nothing", () => {
    expect(fold(start(), { sort: "retracted", run: R, at: T + 3 }).lastEnd).toEqual({
      end: "other",
      at: T + 3,
    });
    const other = fold(start(), { sort: "retracted", run: S, at: T + 3 });
    expect(other.run.state).toBe("open");
    expect(other.lastEnd).toBeNull();
  });

  test("another run's end, as a queued launch that failed, is only the newest end", () => {
    const made = fold(start(), ask("p1"), end(S, "failed", T + 4));
    expect(made.run.state).toBe("open");
    expect(made.lastEnd).toEqual({ end: "failed", at: T + 4 });
    expect(made.prompts.has("p1")).toBe(true);
  });
});

describe("questions and approvals", () => {
  test("count only while the run is open, and only the run's own", () => {
    const made = fold(start(), ask("p1"), ask("p2", S), request("a1"), request("a2", S));
    expect([...made.prompts.keys()]).toEqual(["p1"]);
    expect([...made.approvals.keys()]).toEqual(["a1"]);
    const after = fold(start(), end(), ask("p1"), request("a1"));
    expect(after.prompts.size + after.approvals.size).toBe(0);
  });

  test("an answer closes a question, and a decision or the end of a wait an approval", () => {
    const made = fold(
      start(),
      ask("p1"),
      ask("p2"),
      { sort: "settled", run: R, prompt: "p1", at: T + 2 },
      request("a1"),
      request("a2"),
      { sort: "decided", run: R, action: "a1", at: T + 3 },
      { sort: "wait-ended", action: "a2", at: T + 4 },
    );
    expect([...made.prompts.keys()]).toEqual(["p2"]);
    expect(made.approvals.size).toBe(0);
  });

  test("a review's start and word are kept on an open approval, and nothing is made of one not open", () => {
    const made = fold(
      start(),
      { sort: "requested", run: R, action: "a1", phase: "automated_reviewing", at: T + 1 },
      { sort: "review-started", run: R, action: "a1", at: T + 2 },
      { sort: "review-completed", run: R, action: "a1", clean: false, at: T + 3 },
      { sort: "review-started", run: R, action: "a9", at: T + 4 },
      { sort: "review-completed", run: R, action: "a9", clean: true, at: T + 5 },
    );
    expect([...made.approvals]).toEqual([
      [
        "a1",
        {
          requestedAt: T + 1,
          phase: "automated_reviewing",
          reviewed: true,
          completion: { clean: false, at: T + 3 },
        },
      ],
    ]);
  });

  test(`more than ${PENDING_MAX} open at once makes the fold unsure until the next start`, () => {
    const records: MuseRecord[] = [start()];
    for (let n = 0; n < PENDING_MAX; n += 1) {
      records.push(n % 2 === 0 ? ask(`p${n}`) : request(`a${n}`));
    }
    expect(fold(...records).crowded).toBe(false);
    // The same one again is not one more.
    expect(fold(...records, ask("p0")).crowded).toBe(false);
    const crowded = fold(...records, ask("one-more"));
    expect(crowded.crowded).toBe(true);
    expect(applyMuseRecord(crowded, { sort: "end", at: T + 9 }).marker).toBeNull();
    expect(fold(...records, ask("one-more"), start(S, T + 20)).crowded).toBe(false);
  });
});

describe("the session's end and resume", () => {
  test("close an open run, mark it, and clear every question and approval", () => {
    for (const sort of ["end", "resumed"] as const) {
      const made = fold(start(), ask("p1"), request("a1"), { sort, at: T + 5 });
      expect(made.run.state, sort).toBe("closed");
      expect(made.marker, sort).toEqual({ sort, at: T + 5 });
      expect(made.prompts.size + made.approvals.size, sort).toBe(0);
    }
  });

  test("leave an ended run ended", () => {
    const made = fold(start(), end(), { sort: "end", at: T + 10 });
    expect(made.run.state).toBe("ended");
    expect(made.marker).toEqual({ sort: "end", at: T + 10 });
  });

  test("a closed run opens again on its own later record of a run's or an approval's kind, as of that record", () => {
    const reopeners: MuseRecord[] = [
      { sort: "run-event", run: R, at: T + 20 },
      { sort: "asked", run: R, prompt: "p9", at: T + 20 },
      { sort: "settled", run: R, prompt: "p9", at: T + 20 },
      { sort: "requested", run: R, action: "a9", phase: "human_pending", at: T + 20 },
      { sort: "review-started", run: R, action: "a9", at: T + 20 },
      { sort: "review-completed", run: R, action: "a9", clean: false, at: T + 20 },
    ];
    for (const record of reopeners) {
      const made = fold(start(), ask("p1"), { sort: "resumed", at: T + 10 }, record);
      expect(made.run, record.sort).toEqual({ id: R, state: "open", openedAt: T + 20 });
      expect(made.marker, record.sort).toBeNull();
      // The dead turn's wait stays closed.
      expect(made.prompts.has("p1"), record.sort).toBe(false);
    }
    const asked = fold(start(), { sort: "end", at: T + 10 }, ask("p9", R, T + 20));
    expect([...asked.prompts.keys()]).toEqual(["p9"]);
  });

  test("a decision, a wait's end, a task's record and another run's record do not open it again", () => {
    const stays: MuseRecord[] = [
      { sort: "decided", run: R, action: "a1", at: T + 20 },
      { sort: "wait-ended", action: "a1", at: T + 20 },
      { sort: "other", at: T + 20 },
      { sort: "approval-event", run: R, at: T + 20 },
      { sort: "run-event", run: S, at: T + 20 },
      { sort: "requested", run: S, action: "a2", phase: "human_pending", at: T + 20 },
    ];
    for (const record of stays) {
      const made = fold(start(), request("a1"), { sort: "resumed", at: T + 10 }, record);
      expect(made.run.state, record.sort).toBe("closed");
      expect(made.marker, record.sort).toEqual({ sort: "resumed", at: T + 10 });
      expect(made.approvals.size, record.sort).toBe(0);
    }
  });

  test("an ended run never opens again but by a start, and an end after the resume ends it as usual", () => {
    const made = fold(
      start(),
      end(),
      { sort: "resumed", at: T + 10 },
      { sort: "run-event", run: R, at: T + 20 },
    );
    expect(made.run.state).toBe("ended");
    const failed = fold(start(), { sort: "resumed", at: T + 10 }, end(R, "failed", T + 11));
    expect(failed.run.state).toBe("ended");
    expect(failed.marker).toBeNull();
    expect(failed.lastEnd).toEqual({ end: "failed", at: T + 11 });
  });
});

test("every record taken moves the newest record's time, or makes it none", () => {
  expect(fold(start(), { sort: "other", at: T + 7 }).lastRecordAt).toBe(T + 7);
  expect(fold(start(), { sort: "other", at: null }).lastRecordAt).toBeNull();
  expect(fold(start(), { sort: "other", at: null }, { sort: "end", at: T + 8 }).lastRecordAt).toBe(
    T + 8,
  );
});

test("a copy changes apart from the fold it was made from", () => {
  const made = fold(start(), ask("p1"), {
    sort: "requested",
    run: R,
    action: "a1",
    phase: "automated_reviewing",
    at: T + 1,
  });
  const copy = copyMuseFold(made);
  applyMuseRecord(copy, {
    sort: "review-completed",
    run: R,
    action: "a1",
    clean: false,
    at: T + 3,
  });
  applyMuseRecord(copy, { sort: "settled", run: R, prompt: "p1", at: T + 4 });
  applyMuseRecord(copy, end());
  expect(made.run.state).toBe("open");
  expect(made.prompts.has("p1")).toBe(true);
  expect(made.approvals.get("a1")?.completion).toBeNull();
  expect(copy).not.toEqual(made);
});
