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

  describe("in two runs of one workflow", () => {
    /** A check in workflow run `id`, from and to a minute past 10. */
    const inRun = (
      id: number,
      conclusion: string,
      from: number,
      to: number | null,
      name = "unit",
    ) => ({
      ...run(
        name,
        to === null ? "IN_PROGRESS" : "COMPLETED",
        conclusion,
        `2026-10-06T10:${String(from).padStart(2, "0")}:00Z`,
      ),
      // gh prints a time that is not set this way.
      completedAt:
        to === null ? "0001-01-01T00:00:00Z" : `2026-10-06T10:${String(to).padStart(2, "0")}:00Z`,
      detailsUrl: `https://github.com/example-org/storefront/actions/runs/${id}/job/${id}1`,
    });

    test("a push run and a pull request run side by side are two checks", () => {
      expect(
        checksOf([
          inRun(100, "FAILURE", 0, 5),
          inRun(100, "SUCCESS", 0, 5, "lint"),
          inRun(101, "SUCCESS", 1, 4),
          inRun(101, "SUCCESS", 1, 4, "lint"),
        ]),
      ).toEqual({ state: "failing", passing: 3, failing: 1, pending: 0 });
      // Whichever gh lists first, and while the newer has not finished.
      expect(checksOf([inRun(101, "", 1, null), inRun(100, "FAILURE", 0, 5)])).toEqual({
        state: "failing",
        passing: 0,
        failing: 1,
        pending: 1,
      });
    });

    test("a run begun after the older had finished replaces it, as a title check run again does", () => {
      expect(checksOf([inRun(200, "FAILURE", 0, 1), inRun(201, "SUCCESS", 20, 21)])).toEqual({
        state: "passing",
        passing: 1,
        failing: 0,
        pending: 0,
      });
      expect(checksOf([inRun(201, "", 20, null), inRun(200, "FAILURE", 0, 1)]).state).toBe(
        "pending",
      );
    });

    test("a run cancelled for a newer one does not count", () => {
      expect(checksOf([inRun(300, "CANCELLED", 0, 2), inRun(301, "SUCCESS", 1, 6)])).toEqual({
        state: "passing",
        passing: 1,
        failing: 0,
        pending: 0,
      });
      // Nothing replaces the newest.
      expect(checksOf([inRun(300, "SUCCESS", 0, 1), inRun(301, "CANCELLED", 2, 3)]).state).toBe(
        "failing",
      );
    });

    test("an older run started again replaces no newer run, and counts once", () => {
      expect(
        checksOf([
          inRun(100, "FAILURE", 0, 5),
          inRun(101, "FAILURE", 1, 4),
          inRun(100, "SUCCESS", 30, 35),
        ]),
      ).toEqual({ state: "failing", passing: 1, failing: 1, pending: 0 });
    });

    test("a newer run that has not started yet replaces nothing", () => {
      expect(
        checksOf([
          inRun(100, "FAILURE", 0, 5),
          { ...inRun(101, "", 0, null), status: "QUEUED", startedAt: "0001-01-01T00:00:00Z" },
        ]),
      ).toEqual({ state: "failing", passing: 0, failing: 1, pending: 1 });
    });

    test("checks whose links name no workflow run are one check, the latest", () => {
      const elsewhere = (check: object) => ({ ...check, detailsUrl: "https://ci.example.com/1" });
      expect(
        checksOf([elsewhere(inRun(100, "FAILURE", 0, 5)), elsewhere(inRun(101, "SUCCESS", 1, 4))]),
      ).toEqual({ state: "passing", passing: 1, failing: 0, pending: 0 });
    });
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
