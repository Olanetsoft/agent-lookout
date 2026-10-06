// A repository on github.com, as Agent Lookout names it, and the address of
// one of its pull requests. The collector builds the address from a remote
// and a number, and the dashboard takes one only in this shape, so nothing
// GitHub or a remote says can turn the link into one to anywhere else.

import { CHECKS_STATES, type ChecksState, type PullRequestChecks } from "./session.ts";

/** A repository on github.com: its owner, a user or an organisation, and its name. */
export interface GitHubRepository {
  owner: string;
  name: string;
}

/**
 * An owner as GitHub allows one: letters, digits and dashes, beginning with a
 * letter or a digit, 39 characters at most.
 */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** A repository's name as GitHub allows one: letters, digits, dots, dashes and underscores, 100 at most. */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The largest pull request number taken: far past any repository's. */
export const MAX_PULL_REQUEST_NUMBER = 1_000_000_000;

/** Whether an owner and a name are ones GitHub could have given. */
export function isGitHubRepository(owner: string, name: string): boolean {
  return OWNER.test(owner) && NAME.test(name) && name !== "." && name !== "..";
}

/** Whether a number is one a pull request could have. */
export function isPullRequestNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_PULL_REQUEST_NUMBER
  );
}

/** The page of a pull request on github.com. */
export function pullRequestUrl(repository: GitHubRepository, number: number): string {
  return `https://github.com/${repository.owner}/${repository.name}/pull/${number}`;
}

const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/;

/**
 * Whether an address is the page of pull request `number` on github.com, in
 * the one shape `pullRequestUrl` writes: no other host, path, query or
 * fragment, and no user name or password.
 */
export function isPullRequestUrl(url: string, number: number): boolean {
  const match = PULL_REQUEST_URL.exec(url);
  if (match === null) return false;
  const [, owner = "", name = "", written = ""] = match;
  return isGitHubRepository(owner, name) && written === String(number);
}

/**
 * How checks stand from their counts: failing when any failed, pending when
 * none failed and some have not finished, passing when the rest passed, and
 * none with no checks.
 */
export function checksStateOf(counts: Omit<PullRequestChecks, "state">): ChecksState {
  if (counts.failing > 0) return "failing";
  if (counts.pending > 0) return "pending";
  return counts.passing > 0 ? "passing" : "none";
}

/**
 * A branch's pull request as `agent-lookout status` and `agent-lookout mcp`
 * give it: its number and how its checks stand, and never its title, which
 * is text someone wrote on GitHub.
 */
export interface PullRequestSummary {
  number: number;
  /** `failing`, `pending`, `passing`, or `none` for a pull request with no checks. */
  checks: ChecksState;
}

/**
 * The summary of a pull request in an answer of `/api/sessions`, read as the
 * commands read the rest of it, field by field. Null when there is none that
 * can be read, as with pull requests off.
 */
export function pullRequestSummaryOf(value: unknown): PullRequestSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const { number, checks } = value as { number?: unknown; checks?: unknown };
  if (!isPullRequestNumber(number) || typeof checks !== "object" || checks === null) return null;
  const state = (checks as { state?: unknown }).state;
  return CHECKS_STATES.includes(state as ChecksState)
    ? { number, checks: state as ChecksState }
    : null;
}
