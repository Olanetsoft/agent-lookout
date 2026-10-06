import type { PullRequest, PullRequestChecks, PullRequestState } from "@core/sessions/session";

/**
 * A branch's pull request in words, as a session's details and the mark beside
 * a branch say it: "Open, 2 checks failing, 1 pending, 4 passing".
 */

/** Each state, as the details name it. */
export const PULL_REQUEST_STATE_LABEL: Record<PullRequestState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const CHECK_ORDER = ["failing", "pending", "passing"] as const;

/**
 * How the checks stand, the news first: "2 checks failing, 1 pending, 4
 * passing", "6 checks passing", "1 check pending", or "no checks". Only the
 * first count names the checks, so the line stays short.
 */
export function checksInWords(checks: PullRequestChecks): string {
  const parts: string[] = [];
  for (const state of CHECK_ORDER) {
    const count = checks[state];
    if (count === 0) continue;
    parts.push(
      parts.length === 0
        ? `${count} ${count === 1 ? "check" : "checks"} ${state}`
        : `${count} ${state}`,
    );
  }
  return parts.length === 0 ? "no checks" : parts.join(", ");
}

/** The line under a pull request in a session's details: "Open, 2 checks failing, 4 passing". */
export function pullRequestLine(pullRequest: PullRequest): string {
  return `${PULL_REQUEST_STATE_LABEL[pullRequest.state]}, ${checksInWords(pullRequest.checks)}`;
}

/**
 * Whether a branch is marked in the list and on the board: its pull request is
 * open, or a draft, and has a check failing. One merged or closed is done with.
 */
export function marksFailingChecks(
  pullRequest: PullRequest | undefined,
): pullRequest is PullRequest {
  return (
    pullRequest !== undefined &&
    (pullRequest.state === "open" || pullRequest.state === "draft") &&
    pullRequest.checks.state === "failing"
  );
}

/** What the mark beside a branch says, in its tooltip and to a screen reader: "#51: 2 checks failing, 4 passing". */
export function failingChecksWords(pullRequest: PullRequest): string {
  return `#${pullRequest.number}: ${checksInWords(pullRequest.checks)}`;
}
