import type { PullRequestsStatusResponse } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readPullRequestsStatus } from "@dashboard/lib/api/readApi";
import { sentenceStart } from "@dashboard/lib/format";
import {
  clockAt,
  STATUS_TIMEOUT_MS,
  type SendingWords,
} from "@dashboard/lib/notifications/sendingWords";

/**
 * Whether the app shows each session's pull request, and whether gh can be
 * asked, as Settings says it. The page only reads this. The setting lives in
 * the environment Agent Lookout starts with, and nothing on the page can turn
 * it on or off.
 */

/** Asks the app whether pull requests are shown. Null when it did not answer, or answered with something else. */
export async function fetchPullRequestsStatus(): Promise<PullRequestsStatusResponse | null> {
  try {
    const response = await apiRequest("/api/pull-requests", {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return readPullRequestsStatus(await response.json());
  } catch {
    return null;
  }
}

/** Said under the state while gh is asked: what goes to GitHub, and how. */
const WHAT_IS_SENT =
  "Your own gh sends GitHub the name of each repository and branch it is asked about, with its own login.";

/**
 * Whether gh is asked about branches, so that their names go to GitHub: with
 * pull requests on, and gh neither missing nor signed out. Before gh has been
 * looked for, it is taken to be asked.
 */
export function asksGitHub(status: PullRequestsStatusResponse): boolean {
  return status.on && status.gh !== null && status.gh !== "not-found" && status.gh !== "signed-out";
}

/**
 * What the Pull requests card in Settings says. With no gh, or gh not signed
 * in, the state says that no pull request is shown, the note under it says
 * why and what to do, and nothing is said of what goes to GitHub, since
 * nothing does. A setting that is on but not working never reads like one
 * that works.
 */
export function pullRequestsWords(status: PullRequestsStatusResponse, now: number): SendingWords {
  if (!status.on || status.gh === null) {
    return status.problem === null
      ? {
          state: "Pull requests are off.",
          asking: null,
          title: null,
          detail:
            "Set AGENT_LOOKOUT_PULL_REQUESTS=on to show each session's pull request and its checks, through your own gh.",
        }
      : {
          state: "Pull requests are off.",
          asking: null,
          title: "Pull requests are not set up correctly",
          detail: `${status.problem} Correct it and start Agent Lookout again.`,
        };
  }

  switch (status.gh) {
    case "not-found":
      return {
        state: "No pull request is shown.",
        asking: null,
        title: "The GitHub CLI was not found",
        detail: "Install gh, then sign in with gh auth login.",
      };
    case "signed-out":
      return {
        state: "No pull request is shown.",
        asking: null,
        title: "The GitHub CLI is not signed in",
        detail: "Run gh auth login in a terminal to sign in to github.com.",
      };
    case "unknown":
    case "ready":
      break;
  }
  const said = {
    state: "Pull requests are shown for branches of repositories on github.com.",
    asking: WHAT_IS_SENT,
  };
  const { last } = status;
  if (last === null) {
    return { ...said, title: null, detail: "No session is on a branch to ask about yet." };
  }
  return last.ok
    ? { ...said, title: null, detail: `Last checked at ${clockAt(last.at, now)}.` }
    : {
        ...said,
        title: "The last check did not work",
        // gh is a command's name, and keeps its small letters at the start of a sentence.
        detail: `${last.reason.startsWith("gh") ? last.reason : sentenceStart(last.reason)}. It is tried again within 2 minutes.`,
      };
}
