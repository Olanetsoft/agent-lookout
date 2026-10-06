import type { PullRequestsStatusResponse } from "../../core/api.ts";

/**
 * The one setting for pull requests, read from the environment the collector
 * starts with. It is off unless set to `on`, because with it on the collector
 * runs the person's own gh, which sends the names of a session's repository
 * and branch to GitHub. Anything but `on` or `off` is a setting that cannot
 * be read, and leaves it off, with one line that names the setting, as a wrong
 * email setting does.
 */

/** `on` to show each session's pull request and its checks. Off unless set. */
export const PULL_REQUESTS_ENV = "AGENT_LOOKOUT_PULL_REQUESTS";

/**
 * on   the collector asks gh.
 * off  it does not. `problem` says the setting is wrong, or is null when it
 *      was left out or set to `off`, which needs no word.
 */
export type PullRequestsSetup = { on: true } | { on: false; problem: string | null };

/** Reads the setting. It never throws. */
export function readPullRequestsSetup(env: NodeJS.ProcessEnv): PullRequestsSetup {
  const said = env[PULL_REQUESTS_ENV]?.trim().toLowerCase();
  if (said === undefined || said === "" || said === "off") return { on: false, problem: null };
  if (said === "on") return { on: true };
  return { on: false, problem: `${PULL_REQUESTS_ENV} must be on or off.` };
}

/** The line the collector prints once at start when pull requests are off because of the setting. */
export function pullRequestsProblemLine(problem: string): string {
  return `Pull requests are off: ${problem}`;
}

/** What `GET /api/pull-requests` answers while pull requests are off. */
export function pullRequestsOffStatus(problem: string | null): PullRequestsStatusResponse {
  return { on: false, problem, gh: null, last: null };
}
