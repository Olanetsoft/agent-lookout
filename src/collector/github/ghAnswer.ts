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
 * A check run started again is listed once for each run: only the latest of a
 * name is counted, as gh counts them. One that cannot be read is not counted.
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

/** One check: what tells it from another, when it started, and how it stands. Null when it cannot be read. */
function checkOf(value: unknown): { key: string; startedAt: number; state: CheckState } | null {
  if (!isRecord(value)) return null;
  const startedAt = Date.parse(textOf(value.startedAt));
  const at = Number.isNaN(startedAt) ? -Infinity : startedAt;
  if (value.__typename === "CheckRun") {
    const status = textOf(value.status);
    const conclusion = textOf(value.conclusion);
    let state: CheckState | null = null;
    if (RUN_UNFINISHED.has(status)) state = "pending";
    else if (status === "COMPLETED" && RUN_PASSED.has(conclusion)) state = "passing";
    else if (status === "COMPLETED" && RUN_FAILED.has(conclusion)) state = "failing";
    if (state === null) return null;
    return {
      key: `run\0${textOf(value.workflowName)}\0${textOf(value.name)}`,
      startedAt: at,
      state,
    };
  }
  if (value.__typename === "StatusContext") {
    const state = STATUS_STATE[textOf(value.state)];
    if (state === undefined) return null;
    return { key: `status\0${textOf(value.context)}`, startedAt: at, state };
  }
  return null;
}

/** How many checks are in each state, counting only the latest run of each. */
export function checksOf(rollup: unknown): PullRequestChecks {
  const latest = new Map<string, { startedAt: number; state: CheckState }>();
  for (const value of Array.isArray(rollup) ? rollup : []) {
    const check = checkOf(value);
    if (check === null) continue;
    const held = latest.get(check.key);
    if (held === undefined || check.startedAt >= held.startedAt) latest.set(check.key, check);
  }
  const counts = { passing: 0, failing: 0, pending: 0 };
  for (const { state } of latest.values()) counts[state] += 1;
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
