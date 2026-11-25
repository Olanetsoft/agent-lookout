import {
  checksStateOf,
  isPullRequestNumber,
  pullRequestUrl,
  type GitHubRepository,
} from "../../core/sessions/pullRequest.ts";
import type {
  PullRequest,
  PullRequestChecks,
  PullRequestState,
} from "../../core/sessions/session.ts";
import { sessionName } from "../../core/text.ts";

/**
 * What `gh pr view --json number,title,state,isDraft,statusCheckRollup`
 * prints, read into a pull request. Pure.
 *
 * gh prints one JSON object. Of it, the number, the title, the state, whether
 * it is a draft and each check's state are kept, and nothing else: no link,
 * name or text of a check, and no address GitHub gave. The title is text
 * someone wrote on GitHub, so it is cleaned and cut as a session's name is.
 *
 * Each check on the pull request's latest commit is one of two kinds:
 *
 * - A check run, as GitHub Actions makes: `status` is `COMPLETED` once it has
 *   finished, and `conclusion` then says how. Success, skipped and neutral
 *   pass; failure, timed out, cancelled, action required, stale and startup
 *   failure fail.
 * - A commit status, as many other services set: `state` is success, failure
 *   or error, or pending or expected while it has not finished.
 *
 * A check run started again is listed once for each run, and only the latest is
 * counted. A workflow that runs on both `push` and `pull_request` makes two runs
 * of each check, which are two checks. gh gives no event, so they are told apart
 * by the workflow run in the check's link: a check of an older run counts beside
 * a newer run's unless it was cancelled, or had finished before the newer run
 * began, as the first of that run's checks to start says. So two runs for one
 * event that overlap both count. The link and the run are not kept. A check that
 * cannot be read is not counted.
 */

/** How one check stands. */
type CheckState = "passing" | "failing" | "pending";

const RUN_PASSED = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const RUN_FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STALE",
  "STARTUP_FAILURE",
]);
const RUN_UNFINISHED = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"]);

const STATUS_STATE: Record<string, CheckState> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "pending",
  EXPECTED: "pending",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A time gh printed, or null for none. gh prints one that is not set as the year 1. */
function timeOf(value: unknown): number | null {
  const at = Date.parse(textOf(value));
  return at > 0 ? at : null;
}

/** One check, as gh listed it. */
interface Check {
  /** What tells it from another check. */
  key: string;
  /** The workflow run it is in, or 0 for one that names none. A newer run has a larger one. */
  run: number;
  /** When it started: long ago when it has not, or it was not said. */
  startedAt: number;
  /** When it finished: never when it has not, or it was not said. */
  finishedAt: number;
  cancelled: boolean;
  state: CheckState;
}

/** A GitHub Actions check's page, which names its workflow run. */
const RUN_PAGE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\//;

/** The check, or null when it cannot be read. */
function checkOf(value: unknown): Check | null {
  if (!isRecord(value)) return null;
  const common = {
    run: 0,
    startedAt: timeOf(value.startedAt) ?? -Infinity,
    finishedAt: Infinity,
    cancelled: false,
  };
  if (value.__typename === "CheckRun") {
    const status = textOf(value.status);
    const conclusion = textOf(value.conclusion);
    let state: CheckState | null = null;
    if (RUN_UNFINISHED.has(status)) state = "pending";
    else if (status === "COMPLETED" && RUN_PASSED.has(conclusion)) state = "passing";
    else if (status === "COMPLETED" && RUN_FAILED.has(conclusion)) state = "failing";
    if (state === null) return null;
    return {
      ...common,
      key: `run\0${textOf(value.workflowName)}\0${textOf(value.name)}`,
      run: Number(RUN_PAGE.exec(textOf(value.detailsUrl))?.[1] ?? 0),
      finishedAt: timeOf(value.completedAt) ?? Infinity,
      cancelled: conclusion === "CANCELLED",
      state,
    };
  }
  if (value.__typename === "StatusContext") {
    const state = STATUS_STATE[textOf(value.state)];
    if (state === undefined) return null;
    return { ...common, key: `status\0${textOf(value.context)}`, state };
  }
  return null;
}

/** How many checks are in each state, counting only the latest run of each. */
export function checksOf(rollup: unknown): PullRequestChecks {
  /** By what tells a check from another, and then by its workflow run. */
  const latest = new Map<string, Map<number, Check>>();
  /** When each workflow run began: long ago for one that has not, so it replaces nothing. */
  const began = new Map<number, number>();
  for (const value of Array.isArray(rollup) ? rollup : []) {
    const check = checkOf(value);
    if (check === null) continue;
    const runs = latest.get(check.key) ?? new Map<number, Check>();
    latest.set(check.key, runs);
    const held = runs.get(check.run);
    if (held === undefined || check.startedAt >= held.startedAt) runs.set(check.run, check);
    if (check.startedAt > -Infinity) {
      began.set(check.run, Math.min(began.get(check.run) ?? Infinity, check.startedAt));
    }
  }
  /** Whether `newer` is the same check run again, so that `older` no longer counts. */
  const replaces = (newer: Check, older: Check) =>
    newer.run > older.run &&
    (older.cancelled || older.finishedAt < (began.get(newer.run) ?? -Infinity));
  const counts = { passing: 0, failing: 0, pending: 0 };
  for (const runs of latest.values()) {
    const all = [...runs.values()];
    for (const check of all) {
      if (!all.some((other) => replaces(other, check))) counts[check.state] += 1;
    }
  }
  return { state: checksStateOf(counts), ...counts };
}

/** The pull request's state, from gh's `state` and `isDraft`, or null for one gh does not give. */
function stateOf(state: unknown, isDraft: unknown): PullRequestState | null {
  if (state === "OPEN") return isDraft === true ? "draft" : "open";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return null;
}

/**
 * The pull request gh printed, in `repository`, or null when what it printed is
 * not one: not one JSON object, or without a number, a title or a state it
 * could have.
 */
export function readGhAnswer(stdout: string, repository: GitHubRepository): PullRequest | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const { number } = data;
  const state = stateOf(data.state, data.isDraft);
  const title = typeof data.title === "string" ? sessionName(data.title) : undefined;
  if (!isPullRequestNumber(number) || state === null || title === undefined) return null;
  return {
    number,
    title,
    state,
    checks: checksOf(data.statusCheckRollup),
    url: pullRequestUrl(repository, number),
  };
}
