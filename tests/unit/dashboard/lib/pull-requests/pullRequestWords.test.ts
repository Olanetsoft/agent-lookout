import { describe, expect, test } from "vitest";

import type { PullRequest } from "@core/sessions/session";
import {
  checksInWords,
  failingChecksWords,
  marksFailingChecks,
  pullRequestLine,
} from "@dashboard/lib/pull-requests/pullRequestWords";

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 51,
    title: "Show the pull request and its checks",
    state: "open",
    checks: { state: "failing", passing: 4, failing: 2, pending: 1 },
    url: "https://github.com/example-org/storefront/pull/51",
    ...overrides,
  };
}

describe("the checks in words", () => {
  test("the news first, and only the first count names the checks", () => {
    expect(checksInWords({ state: "failing", passing: 4, failing: 2, pending: 1 })).toBe(
      "2 checks failing, 1 pending, 4 passing",
    );
    expect(checksInWords({ state: "pending", passing: 5, failing: 0, pending: 1 })).toBe(
      "1 check pending, 5 passing",
    );
    expect(checksInWords({ state: "passing", passing: 6, failing: 0, pending: 0 })).toBe(
      "6 checks passing",
    );
    expect(checksInWords({ state: "failing", passing: 0, failing: 1, pending: 0 })).toBe(
      "1 check failing",
    );
    expect(checksInWords({ state: "none", passing: 0, failing: 0, pending: 0 })).toBe("no checks");
  });
});

describe("a pull request's line in a session's details", () => {
  test("its state, then its checks", () => {
    expect(pullRequestLine(pullRequest())).toBe("Open, 2 checks failing, 1 pending, 4 passing");
    expect(
      pullRequestLine(
        pullRequest({
          state: "draft",
          checks: { state: "none", passing: 0, failing: 0, pending: 0 },
        }),
      ),
    ).toBe("Draft, no checks");
    expect(
      pullRequestLine(
        pullRequest({
          state: "merged",
          checks: { state: "passing", passing: 6, failing: 0, pending: 0 },
        }),
      ),
    ).toBe("Merged, 6 checks passing");
    expect(pullRequestLine(pullRequest({ state: "closed" }))).toBe(
      "Closed, 2 checks failing, 1 pending, 4 passing",
    );
  });
});

describe("the mark beside a branch", () => {
  test("is for an open pull request, or a draft, with a check failing", () => {
    expect(marksFailingChecks(pullRequest())).toBe(true);
    expect(marksFailingChecks(pullRequest({ state: "draft" }))).toBe(true);
  });

  test("is not for one merged or closed, one whose checks are not failing, or a branch with none", () => {
    expect(marksFailingChecks(pullRequest({ state: "merged" }))).toBe(false);
    expect(marksFailingChecks(pullRequest({ state: "closed" }))).toBe(false);
    expect(
      marksFailingChecks(
        pullRequest({ checks: { state: "pending", passing: 1, failing: 0, pending: 1 } }),
      ),
    ).toBe(false);
    expect(marksFailingChecks(undefined)).toBe(false);
  });

  test("says which pull request, and how its checks stand", () => {
    expect(failingChecksWords(pullRequest())).toBe("#51: 2 checks failing, 1 pending, 4 passing");
  });
});
