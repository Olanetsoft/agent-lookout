import { describe, expect, test, vi } from "vitest";

import type { GhAnswer } from "@collector/github/gh";
import {
  createPullRequestFinder,
  PULL_REQUEST_CHECK_MS,
} from "@collector/github/pullRequestFinder";
import type { PullRequestTarget } from "@collector/git/pullRequestTarget";
import type { PullRequest, Session } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";
import { handClock } from "@tests/support/adapters/codexAdapter";

// The finder's timing, with a clock moved by hand and stand-ins for the files
// and for gh: nothing is read and nothing is run.

const CODE = "/Users/example/code";
const STOREFRONT = { owner: "example-org", name: "storefront" };
const REPOSITORY = { id: "9aaa5f0ab35a5f84", name: "storefront" };
const POLL_MS = 2_000;

function pullRequest(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `Pull request ${number}`,
    state: "open",
    checks: { state: "failing", passing: 4, failing: 2, pending: 0 },
    url: `https://github.com/example-org/storefront/pull/${number}`,
    ...overrides,
  };
}

/** A session in a folder of storefront, on a branch. */
function on(id: number, folder: string, branch: string): Session {
  return makeSession({
    id: `status-files:session-${id}.json`,
    source: "status-files",
    cwd: `${CODE}/${folder}`,
    project: folder,
    git: { branch, repository: REPOSITORY },
  });
}

/**
 * The finder, with every folder of storefront in its one git folder, the
 * branch `main` its default, and a gh that answers each branch from `answers`
 * and writes down each question.
 */
function setUp(answers: Record<string, GhAnswer> = {}) {
  const clock = handClock(Date.UTC(2026, 9, 6, 12, 0, 0));
  const asked: string[] = [];
  const read: string[] = [];
  const answer = { ...answers };
  /** A question gh has not answered yet, when `hold` is set. */
  let held: (() => void) | null = null;
  let hold = false;
  const finder = createPullRequestFinder({
    gitFolderOf: (cwd) => (cwd.startsWith(`${CODE}/storefront`) ? `${CODE}/storefront/.git` : null),
    readTarget: async (gitFolder, branch): Promise<PullRequestTarget | null> => {
      read.push(`${gitFolder} ${branch}`);
      return branch === "main" ? null : { repository: STOREFRONT, head: branch };
    },
    ask: async (target) => {
      asked.push(target.head);
      if (hold) await new Promise<void>((resolve) => (held = resolve));
      return answer[target.head] ?? { kind: "none" };
    },
    now: clock.now,
  });

  /** One poll: the sessions given their pull requests, then whatever it started, answered. */
  async function poll(sessions: Session[]): Promise<Session[]> {
    const annotated = finder.annotate(sessions);
    await finder.settled();
    return annotated;
  }

  return {
    finder,
    clock,
    asked,
    read,
    answer,
    poll,
    hold: (on: boolean) => {
      hold = on;
    },
    release: () => {
      held?.();
      held = null;
    },
  };
}

const pullRequestsOf = (sessions: Session[]) => sessions.map((session) => session.git?.pullRequest);

describe("asking", () => {
  test("a poll never waits for gh: the pull request shows from the next poll", async () => {
    const { finder, poll } = setUp({
      "checkout-flow": { kind: "found", pullRequest: pullRequest(51) },
    });
    const sessions = [on(1, "storefront-checkout", "checkout-flow")];

    // The first poll answers at once, before gh has been asked.
    const first = finder.annotate(sessions);
    expect(pullRequestsOf(first)).toEqual([undefined]);
    await finder.settled();

    expect(pullRequestsOf(await poll(sessions))).toEqual([pullRequest(51)]);
    // What it was given is not changed.
    expect(sessions[0]?.git).not.toHaveProperty("pullRequest");
  });

  test("a session on another machine, in a folder of the same path as one here, is never asked about or given one", async () => {
    const { asked, read, poll } = setUp({
      "checkout-flow": { kind: "found", pullRequest: pullRequest(51) },
    });
    const there = makeSession({
      ...on(2, "storefront-checkout", "checkout-flow"),
      id: "remote:devbox:claude-code:2",
      source: "remote:devbox",
      machine: "devbox",
    });
    const sessions = [on(1, "storefront-checkout", "checkout-flow"), there];

    await poll(sessions);
    const annotated = await poll(sessions);
    expect(pullRequestsOf(annotated)).toEqual([pullRequest(51), undefined]);
    expect(annotated[1]).toBe(there);
    // Asked once, for the session here alone.
    expect(asked).toEqual(["checkout-flow"]);
    expect(read).toHaveLength(1);

    // With only the session there, nothing is read or asked.
    const alone = setUp({ "checkout-flow": { kind: "found", pullRequest: pullRequest(51) } });
    await alone.poll([there]);
    expect(pullRequestsOf(await alone.poll([there]))).toEqual([undefined]);
    expect(alone.asked).toEqual([]);
    expect(alone.read).toEqual([]);
  });

  test(`gh is asked once for each branch, then not again for ${PULL_REQUEST_CHECK_MS / 1000} seconds, however often the sessions are polled`, async () => {
    const { clock, asked, read, poll } = setUp();
    const sessions = [on(1, "storefront-checkout", "checkout-flow")];

    await poll(sessions);
    expect(asked).toEqual(["checkout-flow"]);
    expect(read).toHaveLength(1);

    // A poll every two seconds, until just short of two minutes.
    for (let at = POLL_MS; at < PULL_REQUEST_CHECK_MS; at += POLL_MS) {
      clock.advance(POLL_MS);
      await poll(sessions);
    }
    expect(asked).toEqual(["checkout-flow"]);
    expect(read).toHaveLength(1);

    // Two minutes after the first, the remote is read again and gh asked again.
    clock.advance(POLL_MS);
    await poll(sessions);
    expect(asked).toEqual(["checkout-flow", "checkout-flow"]);
    expect(read).toHaveLength(2);
  });

  test("one question for a branch however many sessions and folders are on it, one for each branch", async () => {
    const { asked, poll } = setUp();
    await poll([
      on(1, "storefront-checkout", "checkout-flow"),
      on(2, "storefront-checkout", "checkout-flow"),
      on(3, "storefront-checkout/src", "checkout-flow"),
      on(4, "storefront-search", "search-indexing"),
    ]);
    expect(asked).toEqual(["checkout-flow", "search-indexing"]);
  });

  test("the default branch, and a session in no repository or on no branch, are never asked about", async () => {
    const { asked, read, poll } = setUp();
    await poll([
      on(1, "storefront", "main"),
      makeSession({
        id: "status-files:a.json",
        cwd: `${CODE}/mobile-app`,
        git: { branch: "dev", repository: REPOSITORY },
      }),
      makeSession({
        id: "status-files:b.json",
        cwd: `${CODE}/storefront`,
        git: { commit: "3f9a2c1", repository: REPOSITORY },
      }),
      makeSession({
        id: "status-files:c.json",
        cwd: `${CODE}/storefront`,
        git: { branch: "loose" },
      }),
      makeSession({ id: "status-files:d.json", cwd: null }),
    ]);
    expect(read).toEqual([`${CODE}/storefront/.git main`]);
    expect(asked).toEqual([]);
  });

  test("questions go one after another, and no round starts while one is under way", async () => {
    const { finder, asked, hold, release } = setUp();
    hold(true);
    const sessions = [
      on(1, "storefront-checkout", "checkout-flow"),
      on(2, "storefront-search", "search-indexing"),
    ];

    finder.annotate(sessions);
    await vi.waitFor(() => expect(asked).toEqual(["checkout-flow"]));
    // Polls while the first question is open ask nothing more.
    finder.annotate(sessions);
    finder.annotate(sessions);
    expect(asked).toEqual(["checkout-flow"]);

    hold(false);
    release();
    await finder.settled();
    expect(asked).toEqual(["checkout-flow", "search-indexing"]);
  });

  test("a branch no session is on is forgotten, and asked about afresh when one comes back to it", async () => {
    const { clock, asked, poll } = setUp({
      "checkout-flow": { kind: "found", pullRequest: pullRequest(51) },
    });
    const checkout = on(1, "storefront-checkout", "checkout-flow");

    await poll([checkout]);
    await poll([]);
    clock.advance(POLL_MS);
    const back = await poll([checkout]);
    expect(pullRequestsOf(back)).toEqual([undefined]);
    expect(asked).toEqual(["checkout-flow", "checkout-flow"]);
  });

  test("a branch switched to another is asked about at once", async () => {
    const { clock, asked, poll } = setUp();
    await poll([on(1, "storefront-checkout", "checkout-flow")]);
    clock.advance(10_000);
    await poll([on(1, "storefront-checkout", "fix/rate-limits")]);
    expect(asked).toEqual(["checkout-flow", "fix/rate-limits"]);
  });
});

describe("what gh says", () => {
  test("a pull request found is given to each session on its branch, and none to the others", async () => {
    const { poll } = setUp({ "checkout-flow": { kind: "found", pullRequest: pullRequest(51) } });
    const sessions = [
      on(1, "storefront-checkout", "checkout-flow"),
      on(2, "storefront-checkout/src", "checkout-flow"),
      on(3, "storefront-search", "search-indexing"),
    ];
    await poll(sessions);
    const annotated = await poll(sessions);
    expect(pullRequestsOf(annotated)).toEqual([pullRequest(51), pullRequest(51), undefined]);
    expect(annotated[2]).toBe(sessions[2]);
    expect(annotated[0]?.git).toEqual({
      branch: "checkout-flow",
      repository: REPOSITORY,
      pullRequest: pullRequest(51),
    });
  });

  test("the status says gh is ready, and when it was last asked", async () => {
    const { finder, clock, poll } = setUp();
    expect(finder.status()).toEqual({ on: true, problem: null, gh: "unknown", last: null });
    await poll([on(1, "storefront-checkout", "checkout-flow")]);
    expect(finder.status()).toEqual({
      on: true,
      problem: null,
      gh: "ready",
      last: { at: clock.now(), ok: true },
    });
  });

  test("with no gh, nothing more is asked that round, nothing is shown, and it is looked for again in two minutes", async () => {
    const { finder, clock, asked, answer, poll } = setUp({
      "checkout-flow": { kind: "not-found" },
    });
    const sessions = [
      on(1, "storefront-checkout", "checkout-flow"),
      on(2, "storefront-search", "search-indexing"),
    ];

    await poll(sessions);
    expect(asked).toEqual(["checkout-flow"]);
    expect(finder.status()).toMatchObject({ gh: "not-found", last: null });
    clock.advance(PULL_REQUEST_CHECK_MS - 1);
    expect(pullRequestsOf(await poll(sessions))).toEqual([undefined, undefined]);
    expect(asked).toEqual(["checkout-flow"]);

    answer["checkout-flow"] = { kind: "found", pullRequest: pullRequest(51) };
    clock.advance(1);
    await poll(sessions);
    expect(asked).toEqual(["checkout-flow", "checkout-flow", "search-indexing"]);
    expect(finder.status().gh).toBe("ready");
    expect(pullRequestsOf(await poll(sessions))).toEqual([pullRequest(51), undefined]);
  });

  test("signed out, what was shown goes, since it can no longer be vouched for", async () => {
    const { finder, clock, poll, answer } = setUp({
      "checkout-flow": { kind: "found", pullRequest: pullRequest(51) },
    });
    const sessions = [on(1, "storefront-checkout", "checkout-flow")];
    await poll(sessions);
    expect(pullRequestsOf(await poll(sessions))).toEqual([pullRequest(51)]);

    answer["checkout-flow"] = { kind: "signed-out" };
    clock.advance(PULL_REQUEST_CHECK_MS);
    await poll(sessions);
    expect(finder.status().gh).toBe("signed-out");
    expect(pullRequestsOf(await poll(sessions))).toEqual([undefined]);
  });

  test("a question that fails keeps what was learnt before, says why, and is asked again in two minutes", async () => {
    const { finder, clock, asked, answer, poll } = setUp({
      "checkout-flow": { kind: "found", pullRequest: pullRequest(51) },
    });
    const sessions = [on(1, "storefront-checkout", "checkout-flow")];
    await poll(sessions);

    answer["checkout-flow"] = { kind: "failed", reason: "gh did not answer within 15 seconds" };
    clock.advance(PULL_REQUEST_CHECK_MS);
    await poll(sessions);
    expect(pullRequestsOf(await poll(sessions))).toEqual([pullRequest(51)]);
    expect(finder.status()).toEqual({
      on: true,
      problem: null,
      gh: "ready",
      last: { at: clock.now(), ok: false, reason: "gh did not answer within 15 seconds" },
    });

    clock.advance(PULL_REQUEST_CHECK_MS - 1);
    await poll(sessions);
    expect(asked).toHaveLength(2);
    clock.advance(1);
    await poll(sessions);
    expect(asked).toHaveLength(3);
  });

  test("a branch whose pull request has gone is shown with none", async () => {
    const { clock, answer, poll } = setUp({
      "checkout-flow": { kind: "found", pullRequest: pullRequest(51) },
    });
    const sessions = [on(1, "storefront-checkout", "checkout-flow")];
    await poll(sessions);
    answer["checkout-flow"] = { kind: "none" };
    clock.advance(PULL_REQUEST_CHECK_MS);
    await poll(sessions);
    expect(pullRequestsOf(await poll(sessions))).toEqual([undefined]);
  });
});
