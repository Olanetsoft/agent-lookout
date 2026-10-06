import { afterEach, expect, test, vi } from "vitest";

import { NOTIFICATIONS_HEADER, type PullRequestsStatusResponse } from "@core/api";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import {
  asksGitHub,
  fetchPullRequestsStatus,
  pullRequestsWords,
} from "@dashboard/lib/pull-requests/pullRequestsStatus";

afterEach(() => {
  setApiHost();
});

const NOW = new Date(2026, 9, 6, 14, 30).getTime();
const AT_1402 = new Date(2026, 9, 6, 14, 2).getTime();

const OFF: PullRequestsStatusResponse = { on: false, problem: null, gh: null, last: null };
const ON: PullRequestsStatusResponse = {
  on: true,
  problem: null,
  gh: "ready",
  last: { at: AT_1402, ok: true },
};

const SENT =
  "Your own gh sends GitHub the name of each repository and branch it is asked about, with its own login.";

test("with nothing set, Settings says pull requests are off and how to turn them on", () => {
  expect(pullRequestsWords(OFF, NOW)).toEqual({
    state: "Pull requests are off.",
    asking: null,
    title: null,
    detail:
      "Set AGENT_LOOKOUT_PULL_REQUESTS=on to show each session's pull request and its checks, through your own gh.",
  });
});

test("with the setting wrong, it says which, and what to do", () => {
  expect(
    pullRequestsWords({ ...OFF, problem: "AGENT_LOOKOUT_PULL_REQUESTS must be on or off." }, NOW),
  ).toEqual({
    state: "Pull requests are off.",
    asking: null,
    title: "Pull requests are not set up correctly",
    detail:
      "AGENT_LOOKOUT_PULL_REQUESTS must be on or off. Correct it and start Agent Lookout again.",
  });
});

test("with them on, it says where they show, what goes to GitHub and when gh was last asked", () => {
  expect(pullRequestsWords(ON, NOW)).toEqual({
    state: "Pull requests are shown for branches of repositories on github.com.",
    asking: SENT,
    title: null,
    detail: "Last checked at 14:02.",
  });
  expect(pullRequestsWords({ ...ON, gh: "unknown", last: null }, NOW).detail).toBe(
    "No session is on a branch to ask about yet.",
  );
});

test("with no gh, or gh not signed in, the state says no pull request is shown, the note says what to do, and nothing is said of GitHub", () => {
  expect(pullRequestsWords({ ...ON, gh: "not-found", last: null }, NOW)).toEqual({
    state: "No pull request is shown.",
    asking: null,
    title: "The GitHub CLI was not found",
    detail: "Install gh, then sign in with gh auth login.",
  });
  expect(pullRequestsWords({ ...ON, gh: "signed-out" }, NOW)).toEqual({
    state: "No pull request is shown.",
    asking: null,
    title: "The GitHub CLI is not signed in",
    detail: "Run gh auth login in a terminal to sign in to github.com.",
  });
});

test("names go to GitHub only while gh is asked: on, and gh neither missing nor signed out", () => {
  expect(asksGitHub(ON)).toBe(true);
  expect(asksGitHub({ ...ON, gh: "unknown", last: null })).toBe(true);
  expect(asksGitHub({ ...ON, gh: "not-found" })).toBe(false);
  expect(asksGitHub({ ...ON, gh: "signed-out" })).toBe(false);
  expect(asksGitHub(OFF)).toBe(false);
  expect(asksGitHub({ ...OFF, problem: "AGENT_LOOKOUT_PULL_REQUESTS must be on or off." })).toBe(
    false,
  );
});

test("a last check that did not work says why", () => {
  expect(
    pullRequestsWords(
      { ...ON, last: { at: AT_1402, ok: false, reason: "gh did not answer within 15 seconds" } },
      NOW,
    ),
  ).toMatchObject({
    title: "The last check did not work",
    detail: "gh did not answer within 15 seconds. It is tried again within 2 minutes.",
  });
});

test("the status is read through the app's own seam, and anything else comes back as null", async () => {
  const host = vi.fn<ApiHost>(async () => new Response(JSON.stringify(ON)));
  setApiHost(host);
  expect(await fetchPullRequestsStatus()).toEqual(ON);
  const [path, init] = host.mock.calls[0] ?? [];
  expect(path).toBe("/api/pull-requests");
  expect(new Headers(init?.headers).get(NOTIFICATIONS_HEADER)).toBe("off");

  setApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await fetchPullRequestsStatus()).toBeNull();
  setApiHost(async () => new Response(JSON.stringify(ON), { status: 500 }));
  expect(await fetchPullRequestsStatus()).toBeNull();
  setApiHost(async () => new Response("<!doctype html>"));
  expect(await fetchPullRequestsStatus()).toBeNull();
});
