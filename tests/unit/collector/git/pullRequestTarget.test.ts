import { describe, expect, test } from "vitest";

import { MAX_CONFIG_BYTES, parseGitConfig, type GitConfig } from "@collector/git/gitConfig";
import { MAX_BRANCH_LENGTH } from "@collector/git/gitHead";
import {
  baseRemoteOf,
  isAskableBranch,
  parseRemoteHead,
  readPullRequestTarget,
  targetOf,
} from "@collector/git/pullRequestTarget";
import { memoryFiles } from "@tests/support/adapters/codexAdapter";

const GIT = "/Users/example/code/storefront/.git";
const STOREFRONT = { owner: "example-org", name: "storefront" };

function config(text: string): GitConfig {
  const read = parseGitConfig(text);
  if (read === null) throw new Error("The test's config could not be read.");
  return read;
}

const ORIGIN = `[remote "origin"]
	url = git@github.com:example-org/storefront.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "checkout-flow"]
	remote = origin
	merge = refs/heads/main
`;

describe("which repository the pull request is in", () => {
  test("the one remote on github.com", () => {
    expect(baseRemoteOf(config(ORIGIN))).toEqual({ name: "origin", repository: STOREFRONT });
  });

  test("upstream before origin, as gh chooses, when nothing was set as the default", () => {
    const remotes = config(`[remote "origin"]
  url = https://github.com/demo-user/storefront.git
[remote "upstream"]
  url = https://github.com/example-org/storefront.git
`);
    expect(baseRemoteOf(remotes)).toEqual({ name: "upstream", repository: STOREFRONT });
  });

  test("the remote gh repo set-default chose comes first", () => {
    const remotes = config(`[remote "upstream"]
  url = https://github.com/example-org/storefront.git
[remote "origin"]
  url = https://github.com/demo-user/storefront.git
  gh-resolved = base
`);
    expect(baseRemoteOf(remotes)).toEqual({
      name: "origin",
      repository: { owner: "demo-user", name: "storefront" },
    });
  });

  test("a remote on another host is passed over, and one chosen there means none", () => {
    expect(
      baseRemoteOf(
        config(`[remote "work"]
  url = git@github.example.com:example-org/storefront.git
[remote "origin"]
  url = git@github.com:example-org/storefront.git
`),
      ),
    ).toEqual({ name: "origin", repository: STOREFRONT });
    expect(
      baseRemoteOf(
        config(`[remote "origin"]
  url = git@github.com:example-org/storefront.git
[remote "work"]
  url = git@github.example.com:example-org/storefront.git
  gh-resolved = base
`),
      ),
    ).toBeNull();
  });

  test("a repository with no remote on github.com has none", () => {
    expect(baseRemoteOf(config(""))).toBeNull();
    expect(
      baseRemoteOf(
        config(`[remote "origin"]\n  url = https://gitlab.com/example-org/storefront.git\n`),
      ),
    ).toBeNull();
  });
});

describe("where the branch's pull request is looked for", () => {
  const base = { name: "origin", repository: STOREFRONT };

  test("the branch itself, in the base repository, whatever upstream it tracks", () => {
    expect(targetOf(config(ORIGIN), "checkout-flow", base, "main")).toEqual({
      repository: STOREFRONT,
      head: "checkout-flow",
    });
  });

  test("a branch pushed to a fork is asked for as owner:branch", () => {
    const forked = config(`[remote "upstream"]
  url = https://github.com/example-org/storefront.git
[remote "origin"]
  url = https://github.com/demo-user/storefront.git
[branch "checkout-flow"]
  remote = origin
`);
    const upstream = { name: "upstream", repository: STOREFRONT };
    expect(targetOf(forked, "checkout-flow", upstream, "main")).toEqual({
      repository: STOREFRONT,
      head: "demo-user:checkout-flow",
    });
  });

  test("a push remote, or remote.pushDefault, is where the branch was pushed", () => {
    const pushed = config(`[remote "upstream"]
  url = https://github.com/example-org/storefront.git
[remote "fork"]
  url = https://github.com/demo-user/storefront.git
[remote]
  pushDefault = fork
[branch "checkout-flow"]
  remote = upstream
`);
    const upstream = { name: "upstream", repository: STOREFRONT };
    expect(targetOf(pushed, "checkout-flow", upstream, "main")?.head).toBe(
      "demo-user:checkout-flow",
    );
  });

  test("none for the default branch, as the remote's HEAD names it", () => {
    expect(targetOf(config(ORIGIN), "develop", base, "develop")).toBeNull();
    // With the remote's HEAD naming another, main is a branch like any other.
    expect(targetOf(config(ORIGIN), "main", base, "develop")?.head).toBe("main");
  });

  test("none for main or master when the remote's HEAD was never written", () => {
    expect(targetOf(config(ORIGIN), "main", base, null)).toBeNull();
    expect(targetOf(config(ORIGIN), "master", base, null)).toBeNull();
    expect(targetOf(config(ORIGIN), "checkout-flow", base, null)?.head).toBe("checkout-flow");
  });
});

describe("a branch gh can be asked about", () => {
  test.each([
    "checkout-flow",
    "fix/rate-limits",
    "release-2.4",
    "UPPER_case",
    "51-checkout",
    "issue/51",
    "v2",
  ])("%s", (branch) => {
    expect(isAskableBranch(branch)).toBe(true);
  });

  test.each([
    ["one gh would read as a pull request's number", "51"],
    ["one gh would read as a pull request's number after #", "#51"],
    ["one gh would read as an option", "--web"],
    ["one with a space", "checkout flow"],
    ["one with two dots", "a..b"],
    ["one with a colon", "owner:branch"],
    ["one ending in .lock", "checkout.lock"],
    ["one with git's reflog syntax", "main@{1}"],
    ["nothing", ""],
    ["one cut to the longest kept", "x".repeat(MAX_BRANCH_LENGTH)],
  ])("never %s", (_, branch) => {
    expect(isAskableBranch(branch)).toBe(false);
  });
});

describe("a remote's HEAD", () => {
  test("names the default branch", () => {
    expect(parseRemoteHead("ref: refs/remotes/origin/main\n", "origin")).toBe("main");
    expect(parseRemoteHead("ref: refs/remotes/origin/release/2.x", "origin")).toBe("release/2.x");
  });

  test("anything else names none", () => {
    expect(parseRemoteHead("ref: refs/remotes/upstream/main\n", "origin")).toBeNull();
    expect(parseRemoteHead("3f9a2c17be04d5e6a7b8c9d0e1f2a3b4c5d6e7f8\n", "origin")).toBeNull();
    expect(parseRemoteHead("ref: refs/remotes/origin/main\nmore\n", "origin")).toBeNull();
  });
});

describe("reading it from the repository's git folder", () => {
  test("reads the config and the remote's HEAD, and nothing else", async () => {
    const files = memoryFiles();
    files.write(`${GIT}/config`, ORIGIN);
    files.write(`${GIT}/refs/remotes/origin/HEAD`, "ref: refs/remotes/origin/main\n");

    expect(await readPullRequestTarget(GIT, "checkout-flow", files.io)).toEqual({
      repository: STOREFRONT,
      head: "checkout-flow",
    });
    expect(await readPullRequestTarget(GIT, "main", files.io)).toBeNull();
    expect(files.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `openRegular ${GIT}/config`,
      `openRegular ${GIT}/refs/remotes/origin/HEAD`,
      `openRegular ${GIT}/config`,
      `openRegular ${GIT}/refs/remotes/origin/HEAD`,
    ]);
    expect(files.openHandles()).toBe(0);
  });

  test("a branch that cannot be asked about reads nothing", async () => {
    const files = memoryFiles();
    files.write(`${GIT}/config`, ORIGIN);
    expect(await readPullRequestTarget(GIT, "--web", files.io)).toBeNull();
    expect(await readPullRequestTarget(GIT, "51", files.io)).toBeNull();
    expect(await readPullRequestTarget(GIT, "#51", files.io)).toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a branch of digits alone is not asked about, even one pushed to a fork", () => {
    const forked = config(`[remote "upstream"]
  url = https://github.com/example-org/storefront.git
[remote "origin"]
  url = https://github.com/demo-user/storefront.git
[branch "51"]
  remote = origin
`);
    const upstream = { name: "upstream", repository: STOREFRONT };
    expect(targetOf(forked, "51", upstream, "main")).toBeNull();
    expect(
      targetOf(config(ORIGIN), "#51", { name: "origin", repository: STOREFRONT }, "main"),
    ).toBeNull();
  });

  test("a config that is not there, too large or unreadable gives nothing", async () => {
    const files = memoryFiles();
    expect(await readPullRequestTarget(GIT, "checkout-flow", files.io)).toBeNull();

    files.write(`${GIT}/config`, `${ORIGIN}# ${"x".repeat(MAX_CONFIG_BYTES)}\n`);
    expect(await readPullRequestTarget(GIT, "checkout-flow", files.io)).toBeNull();

    files.write(`${GIT}/config`, '[remote "origin"\n');
    expect(await readPullRequestTarget(GIT, "checkout-flow", files.io)).toBeNull();
  });

  test("a remote whose name would lead out of the git folder has its HEAD left unread", async () => {
    const files = memoryFiles();
    files.write(
      `${GIT}/config`,
      `[remote "../../.."]\n  url = git@github.com:example-org/storefront.git\n`,
    );
    expect(await readPullRequestTarget(GIT, "checkout-flow", files.io)).toEqual({
      repository: STOREFRONT,
      head: "checkout-flow",
    });
    expect(files.calls.map((call) => call.path)).toEqual([`${GIT}/config`]);
  });
});
