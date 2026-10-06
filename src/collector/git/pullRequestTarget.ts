import path from "node:path";

import type { GitHubRepository } from "../../core/sessions/pullRequest.ts";
import { MAX_BRANCH_LENGTH } from "./gitHead.ts";
import { nodeIo } from "../files/readOnlyIo.ts";
import { readGitFile, type GitIo } from "./branchFinder.ts";
import { MAX_CONFIG_BYTES, parseGitConfig, type GitConfig } from "./gitConfig.ts";
import { gitHubRepositoryOf } from "./remoteUrl.ts";

/**
 * Where a branch's pull request is looked for, worked out from the
 * repository's own files as gh would work it out, with no git command and no
 * question to GitHub. With `AGENT_LOOKOUT_PULL_REQUESTS=on` only, the pull
 * request finder reads two files in the repository's own git folder:
 *
 * - `config`, for its remotes and how the branch is pushed: `gitConfig.ts`.
 * - `refs/remotes/<remote>/HEAD`, which `git clone` writes, one line naming
 *   the default branch of the remote the pull request is looked for in.
 *
 * Only a repository with a remote on github.com has a pull request to look
 * for, and the default branch has none.
 */

/** A branch's pull request, as gh is asked for it. */
export interface PullRequestTarget {
  /** The repository on github.com it is looked for in. */
  repository: GitHubRepository;
  /** The branch, or `owner:branch` for a branch pushed to someone else's copy, a fork. */
  head: string;
}

/**
 * The default branch's usual names, for a repository whose remote's `HEAD`
 * was never written, as when the remote was added by hand.
 */
export const USUAL_DEFAULT_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

/** gh's order for remotes when none was set as the default: these first, then the rest as written. */
const GH_REMOTE_ORDER = ["upstream", "github", "origin"];

/**
 * Whether a branch is one git could have made and gh can be asked about: no
 * space, control character or character git refuses in a name, no `..`, not
 * beginning with a dash, which gh would read as an option, and not cut, as a
 * branch longer than Agent Lookout keeps is.
 *
 * Nor all digits, with or without a `#` before them, as an issue's number
 * often is: gh reads `51` or `#51` as pull request #51, not as a branch, and
 * would answer with that pull request, or fail when #51 is an issue.
 */
export function isAskableBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    Array.from(branch).length < MAX_BRANCH_LENGTH &&
    !/^#?\d+$/.test(branch) &&
    !branch.startsWith("-") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.endsWith(".lock") &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.includes("//") &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x20\x7f~^:?*[\\]/.test(branch)
  );
}

/** A remote's name that can stand in a path under `refs/remotes/`: no `..`, nothing but what git allows. */
function isSafeRemoteName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

/** The remote a pull request is looked for in, as gh chooses it. */
export interface BaseRemote {
  /** The remote's name, or null for a repository `gh repo set-default` named that is no remote. */
  name: string | null;
  repository: GitHubRepository;
}

/**
 * The repository gh looks for a pull request in: the one `gh repo set-default`
 * chose, else the first remote on github.com in gh's own order, `upstream`,
 * `github` and `origin`, then the rest. Null with none on github.com, and
 * when the one chosen is on another host, as a GitHub Enterprise server is.
 */
export function baseRemoteOf(config: GitConfig): BaseRemote | null {
  const onGitHub: { name: string; repository: GitHubRepository }[] = [];
  for (const [name, remote] of config.remotes) {
    const repository = remote.url === undefined ? null : gitHubRepositoryOf(remote.url);
    if (remote.ghResolved === "base") return repository === null ? null : { name, repository };
    if (remote.ghResolved !== undefined) {
      // Or names, as `owner/name`, a repository on the remote's own host.
      const chosen = gitHubRepositoryOf(`https://github.com/${remote.ghResolved}`);
      return repository === null || chosen === null ? null : { name: null, repository: chosen };
    }
    if (repository !== null) onGitHub.push({ name, repository });
  }
  const rank = (name: string) => {
    const at = GH_REMOTE_ORDER.indexOf(name.toLowerCase());
    return at === -1 ? GH_REMOTE_ORDER.length : at;
  };
  const first = [...onGitHub].sort((a, b) => rank(a.name) - rank(b.name))[0];
  return first === undefined ? null : first;
}

/**
 * What a remote's `HEAD` says the default branch is: the name after
 * `ref: refs/remotes/<remote>/`, on one line. Null for anything else.
 */
export function parseRemoteHead(content: string, remote: string): string | null {
  const line = content.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(line)) return null;
  const prefix = `ref: refs/remotes/${remote}/`;
  if (!line.startsWith(prefix)) return null;
  const branch = line.slice(prefix.length).trim();
  return branch === "" ? null : branch;
}

/**
 * Where to look for the pull request of `branch`, or null when there is none
 * to look for: no remote on github.com, or the default branch, which is the
 * one `defaultBranch` names, or with that not known, `main` or `master`.
 *
 * A branch pushed to a remote on github.com whose owner is not the base's, as
 * from a fork, is asked for as `owner:branch`, as gh asks for it. The remote
 * it is pushed to is its `pushRemote`, else `remote.pushDefault`, else its
 * `remote`.
 */
export function targetOf(
  config: GitConfig,
  branch: string,
  base: BaseRemote,
  defaultBranch: string | null,
): PullRequestTarget | null {
  if (!isAskableBranch(branch)) return null;
  if (defaultBranch !== null ? branch === defaultBranch : USUAL_DEFAULT_BRANCHES.has(branch)) {
    return null;
  }
  const own = config.branches.get(branch);
  const pushedTo = own?.pushRemote ?? config.pushDefault ?? own?.remote;
  const url = pushedTo === undefined ? undefined : config.remotes.get(pushedTo)?.url;
  const fork = url === undefined ? null : gitHubRepositoryOf(url);
  const elsewhere =
    fork !== null && fork.owner.toLowerCase() !== base.repository.owner.toLowerCase();
  return { repository: base.repository, head: elsewhere ? `${fork.owner}:${branch}` : branch };
}

/**
 * Reads where to look for a branch's pull request, from the repository's own
 * git folder, the one the branch finder found. Null when there is nothing to
 * look for, or the files cannot be read. Never rejects.
 */
export async function readPullRequestTarget(
  gitFolder: string,
  branch: string,
  io: Pick<GitIo, "openRegular"> = nodeIo,
): Promise<PullRequestTarget | null> {
  try {
    if (!isAskableBranch(branch)) return null;
    const text = await readGitFile(io, path.join(gitFolder, "config"), MAX_CONFIG_BYTES);
    if (typeof text !== "string") return null;
    const config = parseGitConfig(text);
    const base = config === null ? null : baseRemoteOf(config);
    if (config === null || base === null) return null;
    let defaultBranch: string | null = null;
    if (base.name !== null && isSafeRemoteName(base.name)) {
      const head = await readGitFile(
        io,
        path.join(gitFolder, "refs", "remotes", base.name, "HEAD"),
      );
      if (typeof head === "string") defaultBranch = parseRemoteHead(head, base.name);
    }
    return targetOf(config, branch, base, defaultBranch);
  } catch {
    return null;
  }
}
