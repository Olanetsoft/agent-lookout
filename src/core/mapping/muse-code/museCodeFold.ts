// What a Muse Code session's log says of its newest turn, folded from its
// records. Pure, so the collector today and a browser or desktop host later
// share one fold.
//
// Muse Code writes one line for each record of a session to its log, each
// with `recorded_at` in microseconds. The reader
// (`src/collector/adapters/muse-code/records.ts`) turns each line it takes
// into one `MuseRecord`, from bytes. The fold here begins at the newest
// `started` of a run on the session's own stream and keeps only what the
// status needs: whether that run is open, how the newest run ended, whether
// Muse Code wrote that it let the session go or resumed it, and which
// questions and approvals are open. No text but record IDs is kept. Built
// from Meta's documentation, its MIT-licensed Muse Code SDK and protocol
// schema at 1.4.24, its cookbook, and open-source readers of Muse Code's
// files, and not yet checked on a computer running it. See
// docs/adapters/muse-code.md.

/** The most questions and approvals kept open at once. More makes the fold unsure until the next run starts. */
export const PENDING_MAX = 64;

/** How a run ended, from its `terminal` record. `other` is a word this does not know, which still ends it. */
export type MuseEnd = "completed" | "failed" | "cancelled" | "other";

/** An approval request's `presentation_phase`, or `none` when the request has none. */
export type MusePhase = "automated_reviewing" | "human_pending" | "other" | "none";

/**
 * One record of the session's own stream, as far as the status needs it.
 * `at` is its `recorded_at` in epoch milliseconds, as written, or null when it
 * has none of the shape read.
 */
export type MuseRecord =
  | { sort: "started"; run: string; at: number | null }
  | { sort: "terminal"; run: string; end: MuseEnd; at: number | null }
  | { sort: "retracted"; run: string; at: number | null }
  /** A question to the person, `user_input_prompt_requested`. */
  | { sort: "asked"; run: string; prompt: string; at: number | null }
  /** Its answer, or its timeout, `user_input_prompt_settled`. */
  | { sort: "settled"; run: string; prompt: string; at: number | null }
  /** Any other event of a run. */
  | { sort: "run-event"; run: string; at: number | null }
  | { sort: "requested"; run: string; action: string; phase: MusePhase; at: number | null }
  | { sort: "review-started"; run: string; action: string; at: number | null }
  /** The automated reviewer's word: `clean` when it approved, did not time out and did not fail. */
  | { sort: "review-completed"; run: string; action: string; clean: boolean; at: number | null }
  | { sort: "decided"; run: string; action: string; at: number | null }
  /** Any other event of an approval. */
  | { sort: "approval-event"; run: string; at: number | null }
  /** A record of a task, or of any other kind of `runtime.session` record. */
  | { sort: "other"; at: number | null }
  /** `approval_wait.effect.terminal`, which closes an approval's wait. */
  | { sort: "wait-ended"; action: string; at: number | null }
  /** `session.end`: the host let the session go. */
  | { sort: "end"; at: number | null }
  /** `session.resumed`: a host took the session up again. */
  | { sort: "resumed"; at: number | null };

/** An open approval of the open run. */
export interface MuseApproval {
  requestedAt: number | null;
  phase: MusePhase;
  /** Whether `automated_review_started` was written for it. */
  reviewed: boolean;
  /** `automated_review_completed`, when it was written. */
  completion: { clean: boolean; at: number | null } | null;
}

/** What a session's log says, from the newest `started` of a run on its own stream. */
export interface MuseFold {
  /**
   * The run that `started` opened: `open` while it runs, `ended` once its
   * `terminal` or `run_retracted` is written, and `closed` when a
   * `session.end` or `session.resumed` came while it was open.
   */
  run: { id: string; state: "open" | "ended" | "closed"; openedAt: number | null };
  /** The newest `terminal` of any run, with its time. */
  lastEnd: { end: MuseEnd; at: number | null } | null;
  /** The newest `session.end` or `session.resumed`, unless a later record of the run opened it or ended it. */
  marker: { sort: "end" | "resumed"; at: number | null } | null;
  /** The open run's open questions, by prompt ID, with when each was asked. */
  prompts: Map<string, number | null>;
  /** The open run's open approvals, by pending action ID. */
  approvals: Map<string, MuseApproval>;
  /** The time of the newest record taken, as written, or null when it has none. */
  lastRecordAt: number | null;
  /** More than `PENDING_MAX` questions and approvals were open at once: unsure until the next run starts. */
  crowded: boolean;
}

/** A fold that begins at a `started` record. */
export function startMuseFold(record: Extract<MuseRecord, { sort: "started" }>): MuseFold {
  return {
    run: { id: record.run, state: "open", openedAt: record.at },
    lastEnd: null,
    marker: null,
    prompts: new Map(),
    approvals: new Map(),
    lastRecordAt: record.at,
    crowded: false,
  };
}

/** A copy that one more record can change while the original stands. */
export function copyMuseFold(fold: MuseFold): MuseFold {
  const approvals = new Map<string, MuseApproval>();
  for (const [id, approval] of fold.approvals) {
    approvals.set(id, {
      ...approval,
      completion: approval.completion === null ? null : { ...approval.completion },
    });
  }
  return {
    run: { ...fold.run },
    lastEnd: fold.lastEnd === null ? null : { ...fold.lastEnd },
    marker: fold.marker === null ? null : { ...fold.marker },
    prompts: new Map(fold.prompts),
    approvals,
    lastRecordAt: fold.lastRecordAt,
    crowded: fold.crowded,
  };
}

/**
 * Whether a record opens again a run that a `session.end` or
 * `session.resumed` closed: one of that run's own, of a run's events other
 * than its end, or an approval's request or review. So a run that recovery
 * takes up again, and the fresh request recovery writes for an approval it
 * parked, open it again. A decision, `approval_wait.effect.terminal` and a
 * task's record do not, as recovery closes the old approval whether or not
 * the turn goes on, and may write such records then.
 */
function reopens(record: MuseRecord, run: string): boolean {
  switch (record.sort) {
    case "asked":
    case "settled":
    case "run-event":
    case "requested":
    case "review-started":
    case "review-completed":
      return record.run === run;
    default:
      return false;
  }
}

function closeWaits(fold: MuseFold): void {
  fold.prompts.clear();
  fold.approvals.clear();
}

/** Whether more than `PENDING_MAX` questions and approvals would be open with one more. */
function full(fold: MuseFold): boolean {
  return fold.prompts.size + fold.approvals.size >= PENDING_MAX;
}

function crowd(fold: MuseFold): MuseFold {
  fold.crowded = true;
  closeWaits(fold);
  return fold;
}

/**
 * The fold after one more record, newer than every record before it. It
 * changes `fold` in place, so a caller that keeps the one before applies it
 * to a copy. A `started` begins a fold of its own (`startMuseFold`), and is
 * the caller's to apply.
 *
 * - A `terminal` or `run_retracted` of the run ends it, and clears the
 *   marker and every open question and approval, as Meta's own fold retires a
 *   pending prompt when its turn ends. A `terminal` of another run, as a
 *   queued launch that failed, is only the newest end.
 * - A `session.end` or `session.resumed` is the marker, closes the run when
 *   it is open, and clears every open question and approval, so a session
 *   resumed after a crash does not show the dead turn's wait unless that
 *   run writes again, as below.
 * - A closed run opens again on its own record of the kinds `reopens` names,
 *   as of that record's time, and the marker is cleared.
 * - A question or an approval counts only while the run is open, and only
 *   one of the run's own; its answer, decision or end closes it.
 */
export function applyMuseRecord(fold: MuseFold, record: MuseRecord): MuseFold {
  fold.lastRecordAt = record.at;
  if (record.sort === "started") return startMuseFold(record);
  if (fold.crowded) return fold;
  const { run } = fold;
  if (run.state === "closed" && reopens(record, run.id)) {
    run.state = "open";
    run.openedAt = record.at;
    fold.marker = null;
  }
  switch (record.sort) {
    case "terminal":
    case "retracted": {
      // A run taken back ends as one of a word not known; Muse Code writes its cancelled end after.
      if (record.sort === "retracted" && record.run !== run.id) return fold;
      fold.lastEnd = { end: record.sort === "terminal" ? record.end : "other", at: record.at };
      if (record.run === run.id) {
        run.state = "ended";
        fold.marker = null;
        closeWaits(fold);
      }
      return fold;
    }
    case "end":
    case "resumed":
      fold.marker = { sort: record.sort, at: record.at };
      if (run.state === "open") run.state = "closed";
      closeWaits(fold);
      return fold;
    case "asked":
      if (run.state !== "open" || record.run !== run.id) return fold;
      if (!fold.prompts.has(record.prompt) && full(fold)) return crowd(fold);
      fold.prompts.set(record.prompt, record.at);
      return fold;
    case "settled":
      fold.prompts.delete(record.prompt);
      return fold;
    case "requested":
      if (run.state !== "open" || record.run !== run.id) return fold;
      if (!fold.approvals.has(record.action) && full(fold)) return crowd(fold);
      fold.approvals.set(record.action, {
        requestedAt: record.at,
        phase: record.phase,
        reviewed: false,
        completion: null,
      });
      return fold;
    case "review-started": {
      const approval = fold.approvals.get(record.action);
      if (approval !== undefined) approval.reviewed = true;
      return fold;
    }
    case "review-completed": {
      const approval = fold.approvals.get(record.action);
      if (approval !== undefined) approval.completion = { clean: record.clean, at: record.at };
      return fold;
    }
    case "decided":
    case "wait-ended":
      fold.approvals.delete(record.action);
      return fold;
    default:
      return fold;
  }
}
