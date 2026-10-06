import { describe, expect, test } from "vitest";

import { checksOf, readGhAnswer } from "@collector/github/ghAnswer";
import { MAX_NAME_LENGTH } from "@core/text";

const STOREFRONT = { owner: "example-org", name: "storefront" };

const run = (
  name: string,
  status: string,
  conclusion = "",
  startedAt = "2026-10-06T10:00:00Z",
) => ({
  __typename: "CheckRun",
  name,
  workflowName: "CI",
  status,
  conclusion,
  startedAt,
  completedAt: "",
  detailsUrl: "https://github.com/example-org/storefront/actions/runs/1/job/2",
});

const status = (context: string, state: string) => ({
  __typename: "StatusContext",
  context,
  state,
  startedAt: "2026-10-06T10:00:00Z",
  targetUrl: "https://ci.example.com/build/1",
});

function answer(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 51,
    title: "Show the pull request and its checks",
    state: "OPEN",
    isDraft: false,
    statusCheckRollup: [],
    ...fields,
  });
}

describe("what gh printed", () => {
  test("an open pull request, with its page built from the repository and the number", () => {
    expect(readGhAnswer(answer(), STOREFRONT)).toEqual({
      number: 51,
      title: "Show the pull request and its checks",
      state: "open",
      checks: { state: "none", passing: 0, failing: 0, pending: 0 },
      url: "https://github.com/example-org/storefront/pull/51",
    });
  });

  test("a draft, a merged and a closed one", () => {
    expect(readGhAnswer(answer({ isDraft: true }), STOREFRONT)?.state).toBe("draft");
    expect(readGhAnswer(answer({ state: "MERGED" }), STOREFRONT)?.state).toBe("merged");
    expect(readGhAnswer(answer({ state: "CLOSED" }), STOREFRONT)?.state).toBe("closed");
    // A merged pull request that was a draft once is merged.
    expect(readGhAnswer(answer({ state: "MERGED", isDraft: true }), STOREFRONT)?.state).toBe(
      "merged",
    );
  });

  test("the title is cleaned of control characters and of marks that reorder text, and cut", () => {
    const reordering = String.fromCodePoint(0x202e);
    const read = readGhAnswer(
      answer({
        title: `Fix${String.fromCharCode(0x1b)}[2J the ${reordering}build\n${"x".repeat(400)}`,
      }),
      STOREFRONT,
    );
    expect(read?.title.startsWith("Fix [2J the  build")).toBe(true);
    expect(Array.from(read?.title ?? "")).toHaveLength(MAX_NAME_LENGTH);
  });

  test("the address GitHub gives is never used: the page is built from the remote", () => {
    const read = readGhAnswer(answer({ url: "https://example.net/phish", number: 7 }), STOREFRONT);
    expect(read?.url).toBe("https://github.com/example-org/storefront/pull/7");
  });

  test.each([
    ["not JSON", "no pull requests found"],
    ["a list", "[]"],
    ["no number", answer({ number: undefined })],
    ["a number that is not one", answer({ number: 0 })],
    ["a number in words", answer({ number: "51" })],
    ["no title", answer({ title: "   " })],
    ["a state gh does not give", answer({ state: "LOCKED" })],
    ["nothing", ""],
  ])("what is not a pull request is none: %s", (_, printed) => {
    expect(readGhAnswer(printed, STOREFRONT)).toBeNull();
  });
});

describe("the checks", () => {
  test("count each check run and commit status by how it stands", () => {
    expect(
      checksOf([
        run("lint", "COMPLETED", "SUCCESS"),
        run("unit", "COMPLETED", "FAILURE"),
        run("e2e", "COMPLETED", "TIMED_OUT"),
        run("docs", "COMPLETED", "SKIPPED"),
        run("deploy", "IN_PROGRESS"),
        run("labels", "QUEUED"),
        status("preview", "SUCCESS"),
        status("coverage", "ERROR"),
        status("license", "PENDING"),
      ]),
    ).toEqual({ state: "failing", passing: 3, failing: 3, pending: 3 });
  });

  test("pending when none failed and some have not finished, passing when all passed, none with no checks", () => {
    expect(checksOf([run("lint", "COMPLETED", "SUCCESS"), run("unit", "IN_PROGRESS")])).toEqual({
      state: "pending",
      passing: 1,
      failing: 0,
      pending: 1,
    });
    expect(checksOf([run("lint", "COMPLETED", "NEUTRAL"), status("preview", "SUCCESS")])).toEqual({
      state: "passing",
      passing: 2,
      failing: 0,
      pending: 0,
    });
    expect(checksOf([])).toEqual({ state: "none", passing: 0, failing: 0, pending: 0 });
    expect(checksOf(null)).toEqual({ state: "none", passing: 0, failing: 0, pending: 0 });
  });

  test("a check run again counts once, as its latest run", () => {
    expect(
      checksOf([
        run("unit", "COMPLETED", "FAILURE", "2026-10-06T10:00:00Z"),
        run("unit", "COMPLETED", "SUCCESS", "2026-10-06T10:20:00Z"),
        run("lint", "COMPLETED", "SUCCESS", "2026-10-06T10:30:00Z"),
        run("lint", "COMPLETED", "CANCELLED", "2026-10-06T10:31:00Z"),
      ]),
    ).toEqual({ state: "failing", passing: 1, failing: 1, pending: 0 });
  });

  test("a check that cannot be read is not counted", () => {
    expect(
      checksOf([
        run("lint", "COMPLETED", "SUCCESS"),
        run("odd", "COMPLETED", "MAYBE"),
        { __typename: "Deployment", state: "FAILURE" },
        "unit",
        null,
      ]),
    ).toEqual({ state: "passing", passing: 1, failing: 0, pending: 0 });
  });
});
