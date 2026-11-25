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

  describe("checked out from a fork that is no remote", () => {
    const branchOf = (lines: string) => config(`${ORIGIN}[branch "patch-1"]\n${lines}`);

    test.each([
      [
        "gh pr checkout",
        `	remote = https://github.com/demo-user/storefront.git
	pushRemote = https://github.com/demo-user/storefront.git
	merge = refs/heads/patch-1
`,
      ],
      ["git push -u <address>", "	remote = git@github.com:demo-user/storefront.git\n"],
      [
        "a push remote alone",
        "	remote = origin\n	pushRemote = ssh://git@github.com/demo-user/storefront\n",
      ],
    ])("%s leaves an address, and it is asked for as owner:branch", (_, lines) => {
      expect(targetOf(branchOf(lines), "patch-1", base, "main")).toEqual({
        repository: STOREFRONT,
        head: "demo-user:patch-1",
      });
    });

    test("a fork with the base's own owner is asked for as owner:branch too", () => {
      const address = "https://github.com/Example-Org/storefront-fork.git";
      for (const lines of [
        `	remote = ${address}\n	pushRemote = ${address}\n	merge = refs/heads/patch-1\n`,
        `	remote = fork\n[remote "fork"]\n	url = ${address}\n`,
      ]) {
        expect(targetOf(branchOf(lines), "patch-1", base, "main"), lines).toEqual({
          repository: STOREFRONT,
          head: "Example-Org:patch-1",
        });
      }
    });

    test("a user name and a token in the address are not kept", () => {
      const target = targetOf(
        branchOf("	remote = https://demo-user:example-token@github.com/demo-user/storefront.git\n"),
        "patch-1",
        base,
        "main",
      );
      expect(target).toEqual({ repository: STOREFRONT, head: "demo-user:patch-1" });
    });

    test("the base repository's own address, another host's and a folder are the branch itself", () => {
      for (const remote of [
        "https://github.com/Example-Org/Storefront.git",
        "https://gitlab.com/demo-user/storefront.git",
        "/Users/example/code/storefront.git",
        ".",
      ]) {
        expect(
          targetOf(branchOf(`	remote = ${remote}\n`), "patch-1", base, "main")?.head,
          remote,
        ).toBe("patch-1");
      }
    });

    test("a remote of that name wins over the name read as an address", () => {
      const named = `[remote "https://github.com/demo-user/storefront.git"]
	url = https://github.com/example-org/storefront.git
`;
      const read = branchOf(`	remote = https://github.com/demo-user/storefront.git\n${named}`);
      expect(targetOf(read, "patch-1", base, "main")?.head).toBe("patch-1");
    });
  });

  describe("checked out as a pull request's own ref", () => {
    const branchOf = (lines: string) => config(`${ORIGIN}[branch "patch-1"]\n${lines}`);

    test("is asked for by its number, in the repository the ref is in", () => {
      expect(
        targetOf(
          branchOf("	remote = origin\n	pushRemote = origin\n	merge = refs/pull/77/head\n"),
          "patch-1",
          base,
          "main",
        ),
      ).toEqual({ repository: STOREFRONT, head: "77" });
      // Whatever the branch is pushed to, and whichever repository is the base.
      expect(
        targetOf(
          branchOf(`	remote = https://github.com/demo-org/storefront.git
	pushRemote = origin
	merge = refs/pull/77/head
`),
          "patch-1",
          base,
          "main",
        ),
      ).toEqual({ repository: { owner: "demo-org", name: "storefront" }, head: "77" });
    });

    test("is that ref alone: another ref of the pull request's, or one that only holds it, is the branch itself", () => {
      const asked = (merge: string) =>
        targetOf(branchOf(`	remote = origin\n	merge = ${merge}\n`), "patch-1", base, "main")?.head;
      expect(asked("refs/pull/077/head")).toBe("77");
      expect(asked("refs/pull/77/merge")).toBe("patch-1");
      expect(asked("refs/heads/refs/pull/77/head")).toBe("patch-1");
      expect(asked("refs/pull/77/head/more")).toBe("patch-1");
      // The last of two, as git takes it.
      expect(asked("refs/pull/77/head\n	merge = refs/heads/patch-1")).toBe("patch-1");
    });

    test("is never asked for by its name", () => {
      for (const lines of [
        "	merge = refs/pull/77/head\n",
        "	remote = .\n	merge = refs/pull/77/head\n",
        "	remote = https://gitlab.com/example-org/storefront.git\n	merge = refs/pull/77/head\n",
        "	remote = origin\n	merge = refs/pull/0/head\n",
        "	remote = origin\n	merge = refs/pull/99999999999999999999/head\n",
      ]) {
        expect(targetOf(branchOf(lines), "patch-1", base, "main"), lines).toBeNull();
      }
    });
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
