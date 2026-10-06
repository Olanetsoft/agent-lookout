import type { CheckResult, GhState, PullRequestsStatusResponse } from "../../core/api.ts";
import type { PullRequest, Session } from "../../core/sessions/session.ts";
import { readPullRequestTarget, type PullRequestTarget } from "../git/pullRequestTarget.ts";
import type { AskGh, GhAnswer } from "./gh.ts";

/** How long what was learnt of a branch stands before it is asked again. */
export const PULL_REQUEST_CHECK_MS = 120_000;

export interface PullRequestFinderOptions {
  /**
   * The repository's own git folder for a session's folder, as the branch
   * finder last read it: `BranchFinder.gitFolderOf`.
   */
  gitFolderOf: (cwd: string) => string | null;
  /** Asks gh for a branch's pull request: `createGhAsker`. */
  ask: AskGh;
  /** Where a branch's pull request is looked for. Defaults to reading the repository's files. */
  readTarget?: (gitFolder: string, branch: string) => Promise<PullRequestTarget | null>;
  now?: () => number;
  /** Defaults to `PULL_REQUEST_CHECK_MS`. */
  intervalMs?: number;
}

export interface PullRequestFinder {
  /**
   * The sessions, each one on a branch that has a pull request with
   * `git.pullRequest` set to it, as last learnt. It answers at once and never
   * waits for gh: what is due is asked after, and shows from the next poll.
   */
  annotate(sessions: readonly Session[]): Session[];
  /** What `GET /api/pull-requests` answers. */
  status(): PullRequestsStatusResponse;
  /** Resolves once the questions under way have been answered. For tests and for stopping. */
  settled(): Promise<void>;
}

/** Where one session's branch is: its repository's git folder and the branch. */
interface Place {
  key: string;
  gitFolder: string;
  branch: string;
}

/** What was read of one repository's branch: where its pull request is, or null for nowhere. */
interface Read {
  target: PullRequestTarget | null;
  readAt: number;
}

/** What gh last said of one repository's branch. */
interface Asked {
  /** Null when it has none. */
  pullRequest: PullRequest | null;
  askedAt: number;
}

/**
 * Where a session's branch is, or null for one with nothing to ask. A session
 * on another machine works in a folder there, which may share its path with
 * one here, so it is never given a pull request of this computer's.
 */
function placeOf(session: Session, gitFolderOf: (cwd: string) => string | null): Place | null {
  const branch = session.git?.branch;
  if (session.machine !== undefined || session.cwd === null || branch === undefined) return null;
  if (session.git?.repository === undefined) return null;
  const gitFolder = gitFolderOf(session.cwd);
  return gitFolder === null ? null : { key: `${gitFolder}\0${branch}`, gitFolder, branch };
}

/** One question to gh for each repository on github.com and branch, however many folders are on it. */
function questionOf(target: PullRequestTarget): string {
  const { owner, name } = target.repository;
  return `${owner.toLowerCase()}/${name.toLowerCase()}\0${target.head}`;
}

/**
 * Gives each session on a branch of a repository on github.com its pull
 * request, with `AGENT_LOOKOUT_PULL_REQUESTS=on`. The poller calls it with
 * each poll's sessions, after the branch finder.
 *
 * gh is asked once for each repository and branch the sessions are on, and
 * again only once what it said is `PULL_REQUEST_CHECK_MS` old, however many
 * sessions are on that branch and however often the sessions are polled. The
 * repository's remote is read on the same clock. The default branch, and a
 * repository with no remote on github.com, are never asked about. A branch no
 * session is on any more is forgotten.
 *
 * The questions go one after another, never two at once, in the background:
 * a poll never waits for gh. When there is no gh, or it is not signed in,
 * nothing more is asked until the next round, and no pull request is shown,
 * since none can be vouched for. When a question fails, as when gh does not
 * answer in time, what was learnt before stands until the next round.
 */
export function createPullRequestFinder(options: PullRequestFinderOptions): PullRequestFinder {
  const { gitFolderOf, ask } = options;
  const readTarget =
    options.readTarget ?? ((gitFolder, branch) => readPullRequestTarget(gitFolder, branch));
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? PULL_REQUEST_CHECK_MS;
  const reads = new Map<string, Read>();
  const answers = new Map<string, Asked>();
  /** The round under way, if there is one. */
  let running: Promise<void> | null = null;
  /** While there is no gh, or it is not signed in: when the next round may ask. */
  let pausedUntil = -Infinity;
  let gh: GhState = "unknown";
  let last: CheckResult | null = null;

  const due = (at: number, since: number | undefined) => at - (since ?? -Infinity) >= intervalMs;

  /** What one answer of gh comes to. False when no more should be asked this round. */
  function take(question: string, answer: GhAnswer, at: number): boolean {
    switch (answer.kind) {
      case "found":
      case "none":
        gh = "ready";
        last = { at, ok: true };
        answers.set(question, {
          pullRequest: answer.kind === "found" ? answer.pullRequest : null,
          askedAt: at,
        });
        return true;
      case "failed":
        last = { at, ok: false, reason: answer.reason };
        answers.set(question, {
          pullRequest: answers.get(question)?.pullRequest ?? null,
          askedAt: at,
        });
        return true;
      case "not-found":
      case "signed-out":
        gh = answer.kind;
        answers.clear();
        pausedUntil = at + intervalMs;
        return false;
    }
  }

  async function round(places: readonly Place[]): Promise<void> {
    for (const place of places) {
      const target = await readTarget(place.gitFolder, place.branch).catch(() => null);
      reads.set(place.key, { target, readAt: now() });
    }
    const asked = new Set<string>();
    for (const { target } of [...reads.values()]) {
      if (target === null) continue;
      const question = questionOf(target);
      if (asked.has(question)) continue;
      asked.add(question);
      const at = now();
      if (at < pausedUntil) return;
      if (!due(at, answers.get(question)?.askedAt)) continue;
      const answer = await ask(target).catch((): GhAnswer => ({
        kind: "failed",
        reason: "gh could not be run",
      }));
      // A branch no session is on any more while gh was asked is not kept.
      if (
        ![...reads.values()].some((read) => read.target && questionOf(read.target) === question)
      ) {
        continue;
      }
      if (!take(question, answer, now())) return;
    }
  }

  return {
    annotate(sessions) {
      const places = new Map<string, Place>();
      for (const session of sessions) {
        const place = placeOf(session, gitFolderOf);
        if (place !== null) places.set(place.key, place);
      }
      for (const key of reads.keys()) if (!places.has(key)) reads.delete(key);
      const wanted = new Set<string>();
      for (const { target } of reads.values()) if (target) wanted.add(questionOf(target));
      for (const question of answers.keys()) if (!wanted.has(question)) answers.delete(question);

      if (!running) {
        const at = now();
        const toRead = [...places.values()].filter((place) =>
          due(at, reads.get(place.key)?.readAt),
        );
        const toAsk =
          at >= pausedUntil &&
          [...wanted].some((question) => due(at, answers.get(question)?.askedAt));
        if (toRead.length > 0 || toAsk) {
          running = round(toRead)
            .catch(() => {})
            .finally(() => {
              running = null;
            });
        }
      }

      return sessions.map((session) => {
        const place = placeOf(session, gitFolderOf);
        const target = place === null ? null : reads.get(place.key)?.target;
        const pullRequest = target ? answers.get(questionOf(target))?.pullRequest : null;
        return pullRequest && session.git
          ? { ...session, git: { ...session.git, pullRequest } }
          : session;
      });
    },

    status: () => ({ on: true, problem: null, gh, last }),

    settled: () => running ?? Promise.resolve(),
  };
}
