import { describe, expect, test } from "vitest";

import {
  checksStateOf,
  isGitHubRepository,
  isPullRequestNumber,
  isPullRequestUrl,
  pullRequestSummaryOf,
  pullRequestUrl,
} from "@core/sessions/pullRequest";

describe("a pull request's page", () => {
  test("is built from the repository and the number", () => {
    expect(pullRequestUrl({ owner: "example-org", name: "storefront" }, 51)).toBe(
      "https://github.com/example-org/storefront/pull/51",
    );
  });

  test("is taken only in that shape, for that number", () => {
    expect(isPullRequestUrl("https://github.com/example-org/storefront/pull/51", 51)).toBe(true);
    for (const url of [
      "https://github.com/example-org/storefront/pull/52",
      "http://github.com/example-org/storefront/pull/51",
      "https://example.net/example-org/storefront/pull/51",
      "https://github.com.example.net/example-org/storefront/pull/51",
      "https://user@github.com/example-org/storefront/pull/51",
      "https://github.com/example-org/storefront/pull/51?x=1",
      "https://github.com/example-org/storefront/pull/51#top",
      "https://github.com/example-org/storefront/pull/51/files",
      "https://github.com/example-org/../pull/51",
      "javascript:alert(1)//https://github.com/example-org/storefront/pull/51",
    ]) {
      expect(isPullRequestUrl(url, 51), url).toBe(false);
    }
  });
});

describe("what GitHub could have given", () => {
  test("owners and names", () => {
    expect(isGitHubRepository("example-org", "storefront")).toBe(true);
    expect(isGitHubRepository("Example-Org", "docs.example.com")).toBe(true);
    expect(isGitHubRepository("-example", "storefront")).toBe(false);
    expect(isGitHubRepository("example_org", "storefront")).toBe(false);
    expect(isGitHubRepository("example-org", "..")).toBe(false);
    expect(isGitHubRepository("example-org", "store front")).toBe(false);
    expect(isGitHubRepository("x".repeat(40), "storefront")).toBe(false);
  });

  test("numbers", () => {
    expect(isPullRequestNumber(51)).toBe(true);
    expect(isPullRequestNumber(0)).toBe(false);
    expect(isPullRequestNumber(1.5)).toBe(false);
    expect(isPullRequestNumber("51")).toBe(false);
    expect(isPullRequestNumber(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("how checks stand", () => {
  test("failing before pending before passing, and none with none", () => {
    expect(checksStateOf({ passing: 5, failing: 1, pending: 2 })).toBe("failing");
    expect(checksStateOf({ passing: 5, failing: 0, pending: 2 })).toBe("pending");
    expect(checksStateOf({ passing: 5, failing: 0, pending: 0 })).toBe("passing");
    expect(checksStateOf({ passing: 0, failing: 0, pending: 0 })).toBe("none");
  });
});

describe("the summary the commands give", () => {
  test("is the number and how the checks stand, and nothing else", () => {
    expect(
      pullRequestSummaryOf({
        number: 51,
        title: "Show the pull request",
        state: "open",
        checks: { state: "passing", passing: 3, failing: 0, pending: 0 },
        url: "https://github.com/example-org/storefront/pull/51",
      }),
    ).toEqual({ number: 51, checks: "passing" });
  });

  test("is none when it cannot be read", () => {
    expect(pullRequestSummaryOf(undefined)).toBeNull();
    expect(pullRequestSummaryOf({ number: 51 })).toBeNull();
    expect(pullRequestSummaryOf({ number: 51, checks: { state: "red" } })).toBeNull();
    expect(pullRequestSummaryOf({ number: "51", checks: { state: "passing" } })).toBeNull();
  });
});
