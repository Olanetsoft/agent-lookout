import { execFile } from "node:child_process";

import type { PullRequest } from "../../core/sessions/session.ts";
import { isExecutableFile, pathCandidates } from "../files/paths.ts";
import type { PullRequestTarget } from "../git/pullRequestTarget.ts";
import { readGhAnswer } from "./ghAnswer.ts";

/**
 * The one way the collector runs the person's own GitHub CLI, gh, with
 * `AGENT_LOOKOUT_PULL_REQUESTS=on`: to ask for one branch's pull request.
 *
 * It is started directly, by its full path, with no shell between, stdin
 * closed and a timeout, and is asked one thing:
 *
 *     gh pr view --repo github.com/<owner>/<name> --json <fields> -- <branch>
 *
 * gh signs in with its own login, as it does in a terminal. Agent Lookout
 * never reads, keeps or passes a token: it hands gh the environment it was
 * started with, as it hands tmux, less its own settings, with gh's prompts,
 * update checks, colours and debug output turned off.
 */

/** How long gh gets to answer. It normally takes a second or two, over the network. */
export const GH_TIMEOUT_MS = 15_000;

/** Far more than any pull request's answer, and a ceiling on what is read. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * The places gh is installed when it is not on `PATH`: Homebrew's two homes,
 * MacPorts and the system's own, as for tmux. An app launched from the Finder
 * or the Dock does not inherit the shell's `PATH`, so without these it would
 * never find it.
 */
export const GH_LOCATIONS = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/opt/local/bin/gh",
  "/usr/bin/gh",
] as const;

/** What gh is asked for: no more than the details show. */
export const GH_FIELDS = "number,title,state,isDraft,statusCheckRollup";

/**
 * The gh binary: the first on `PATH`, then the fixed locations. Null when
 * there is none. On Windows that is a `gh.exe` on `PATH`.
 */
export async function findGhBinary(
  env: NodeJS.ProcessEnv,
  isExecutable?: (candidate: string) => Promise<boolean>,
  locations: readonly string[] = GH_LOCATIONS,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  isExecutable ??= (candidate) => isExecutableFile(candidate, platform);
  const candidates = [...new Set([...pathCandidates(env, "gh", platform), ...locations])];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * The arguments for one question, each handed to gh as it is. The branch
 * comes after `--`, so nothing in it can be read as an option.
 */
export function ghArguments(target: PullRequestTarget): string[] {
  const { owner, name } = target.repository;
  return [
    "pr",
    "view",
    "--repo",
    `github.com/${owner}/${name}`,
    "--json",
    GH_FIELDS,
    "--",
    target.head,
  ];
}

/** Settings of gh's own that would make it ask, print colours or debug output, or check for a newer gh. */
const LEFT_OUT = ["GH_FORCE_TTY", "GH_DEBUG", "DEBUG", "GH_PAGER", "PAGER"];

/** Agent Lookout's own settings, which gh has no use for, the mail server's password among them. */
const OWN_SETTING = /^AGENT_LOOKOUT_/;

/**
 * The environment gh is given: the collector's, so gh finds its own login,
 * without Agent Lookout's own settings, and with gh's prompts, update checks,
 * colours and debugging off.
 */
export function ghEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const given: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!OWN_SETTING.test(name) && !LEFT_OUT.includes(name)) given[name] = value;
  }
  return {
    ...given,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    NO_COLOR: "1",
  };
}

/** How one run of gh ended. */
export interface GhRun {
  /** The exit code, or null when gh never started, timed out or was stopped. */
  code: number | null;
  /** Whether it never started: not there, or not a program this user can run. */
  notStarted: boolean;
  timedOut: boolean;
  /** Whether it printed more than is read. */
  tooLong: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Starts one gh binary directly, with no shell between, stdin closed and a
 * timeout. It never rejects: a failure is an answer.
 */
export function runGhBinary(
  binary: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<GhRun> {
  return new Promise((resolve) => {
    const ran = (outcome: Partial<GhRun>): GhRun => ({
      code: null,
      notStarted: false,
      timedOut: false,
      tooLong: false,
      stdout: "",
      stderr: "",
      ...outcome,
    });
    try {
      const child = execFile(
        binary,
        [...args],
        {
          env: options.env,
          timeout: options.timeoutMs ?? GH_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const printed = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
          if (!error) {
            resolve(ran({ code: 0, ...printed }));
            return;
          }
          // The exit code is a number. A code in words is Node's own: gh
          // could not be started, or printed more than is read.
          const { code, killed } = error as { code?: unknown; killed?: boolean };
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve(ran({ tooLong: true }));
          else if (typeof code === "string") resolve(ran({ notStarted: true }));
          else if (typeof code === "number") resolve(ran({ code, ...printed }));
          else resolve(ran({ timedOut: killed === true, ...printed }));
        },
      );
      child.stdin?.end();
    } catch {
      resolve(ran({ notStarted: true }));
    }
  });
}

/**
 * What gh said of one branch:
 *
 * found       its pull request
 * none        the branch has no pull request
 * not-found   there is no gh to ask
 * signed-out  gh is not signed in to github.com, or its login no longer works
 * failed      gh did not answer, or its answer could not be read: `reason` says which
 */
export type GhAnswer =
  | { kind: "found"; pullRequest: PullRequest }
  | { kind: "none" }
  | { kind: "not-found" }
  | { kind: "signed-out" }
  | { kind: "failed"; reason: string };

/** Asks gh for one branch's pull request. It never rejects. */
export type AskGh = (target: PullRequestTarget) => Promise<GhAnswer>;

/** What gh writes, on stderr, for a branch with no pull request. */
const NO_PULL_REQUEST = /^no pull requests found for branch /m;

/** What gh writes when it is not signed in, or its login has stopped working. */
const SIGN_IN = /gh auth login/;

/** The exit code gh gives when a command needs it to be signed in. */
const SIGN_IN_EXIT = 4;

/** What one run of gh came to. */
export function answerOf(
  run: GhRun,
  target: PullRequestTarget,
  timeoutMs = GH_TIMEOUT_MS,
): GhAnswer {
  if (run.notStarted) return { kind: "not-found" };
  if (run.timedOut) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return {
      kind: "failed",
      reason: `gh did not answer within ${seconds} ${seconds === 1 ? "second" : "seconds"}`,
    };
  }
  if (run.tooLong) return { kind: "failed", reason: "gh's answer could not be read" };
  if (run.code === 0) {
    const pullRequest = readGhAnswer(run.stdout, target.repository);
    return pullRequest === null
      ? { kind: "failed", reason: "gh's answer could not be read" }
      : { kind: "found", pullRequest };
  }
  if (run.code === SIGN_IN_EXIT || SIGN_IN.test(run.stderr)) return { kind: "signed-out" };
  if (run.code === 1 && NO_PULL_REQUEST.test(run.stderr)) return { kind: "none" };
  return { kind: "failed", reason: "gh could not get the pull request from GitHub" };
}

export interface GhAskerOptions {
  /** The collector's environment: where gh is looked for, and what gh is given. */
  env: NodeJS.ProcessEnv;
  /** Replaced in tests. Resolves true when the path is a file this user can run. */
  isExecutable?: (candidate: string) => Promise<boolean>;
  /** Replaced in tests, so the gh installed on this computer is never found. */
  locations?: readonly string[];
  timeoutMs?: number;
}

/**
 * What the collector asks gh with. gh is looked for on each question, so one
 * installed or removed while the collector runs is noticed, and with none,
 * nothing is started.
 */
export function createGhAsker(options: GhAskerOptions): AskGh {
  const env = ghEnvironment(options.env);
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
  return async (target) => {
    try {
      const binary = await findGhBinary(options.env, options.isExecutable, options.locations);
      if (binary === null) return { kind: "not-found" };
      const run = await runGhBinary(binary, ghArguments(target), { env, timeoutMs });
      return answerOf(run, target, timeoutMs);
    } catch {
      return { kind: "failed", reason: "gh could not be run" };
    }
  };
}
