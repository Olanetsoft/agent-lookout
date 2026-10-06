import { describe, expect, test } from "vitest";

import { parseGitConfig } from "@collector/git/gitConfig";

/** A config as `git clone` and a little use leave one. */
const CLONED = `[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = true
	ignorecase = true
	precomposeunicode = true
[remote "origin"]
	url = git@github.com:example-org/storefront.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
	merge = refs/heads/main
[branch "checkout-flow"]
	remote = origin
	merge = refs/heads/main
`;

describe("reading a repository's config", () => {
  test("keeps each remote's address and each branch's remote, and nothing else", () => {
    const config = parseGitConfig(CLONED);
    expect(config).toEqual({
      remotes: new Map([["origin", { url: "git@github.com:example-org/storefront.git" }]]),
      branches: new Map([
        ["main", { remote: "origin" }],
        ["checkout-flow", { remote: "origin" }],
      ]),
    });
  });

  test("keeps the remotes in the order the file has them, and the first url of each", () => {
    const config = parseGitConfig(`[remote "upstream"]
  url = https://github.com/example-org/storefront.git
[remote "origin"]
  url = https://github.com/demo-user/storefront.git
  url = https://example.net/mirror/storefront.git
  gh-resolved = base
[remote]
  pushDefault = origin
`);
    expect([...(config?.remotes.keys() ?? [])]).toEqual(["upstream", "origin"]);
    expect(config?.remotes.get("origin")).toEqual({
      url: "https://github.com/demo-user/storefront.git",
      ghResolved: "base",
    });
    expect(config?.pushDefault).toBe("origin");
  });

  test("names and sections are read whatever their case, a subsection's case is kept", () => {
    const config = parseGitConfig(`[REMOTE "Origin"]
  URL = https://github.com/example-org/storefront.git
[Branch "Fix/Rate-Limits"]
  PushRemote = Origin
`);
    expect(config?.remotes.get("Origin")?.url).toBe(
      "https://github.com/example-org/storefront.git",
    );
    expect(config?.branches.get("Fix/Rate-Limits")).toEqual({ pushRemote: "Origin" });
  });

  test("reads values in quotation marks, with git's escapes, and a value run on with a backslash", () => {
    const config = parseGitConfig(`[remote "origin"]
  url = "https://github.com/example-org/store\\
front.git" ; the mirror is gone
[branch "say \\"hi\\""]
  remote = "ori"gin
`);
    expect(config?.remotes.get("origin")?.url).toBe(
      "https://github.com/example-org/storefront.git",
    );
    expect(config?.branches.get('say "hi"')).toEqual({ remote: "origin" });
  });

  test("passes over comments, blank lines, Windows line ends and settings it does not use", () => {
    const config = parseGitConfig(
      [
        "# made by hand",
        "; and kept",
        "",
        "[core]",
        "\teditor = vim # a comment",
        "\tbare",
        '[remote "origin"]   # the one',
        "\turl = git@github.com:example-org/storefront.git ",
        "[include]",
        "\tpath = ~/.gitconfig-work",
        "",
      ].join("\r\n"),
    );
    expect(config?.remotes.get("origin")).toEqual({
      url: "git@github.com:example-org/storefront.git",
    });
  });

  test("reads the old form of a subsection, which git keeps in lower case", () => {
    const config = parseGitConfig(`[remote.Origin]
  url = https://github.com/example-org/storefront.git
`);
    expect(config?.remotes.get("origin")?.url).toBe(
      "https://github.com/example-org/storefront.git",
    );
  });

  test("an empty file has no remotes", () => {
    expect(parseGitConfig("")).toEqual({ remotes: new Map(), branches: new Map() });
  });
});

describe("a file git would refuse gives nothing", () => {
  test.each([
    ["a setting before any section", "url = https://github.com/example-org/storefront.git\n"],
    ["a section head left open", '[remote "origin"\n  url = x\n'],
    ["a subsection with no quotation marks", "[remote origin]\n  url = x\n"],
    ["a quotation mark left open", '[remote "origin"]\n  url = "x\n'],
    ["an escape git does not know", '[remote "origin"]\n  url = x\\q\n'],
    ["a name with a dot in it", '[remote "origin"]\n  url.x = y\n'],
    ["a line that is no setting", '[remote "origin"]\n  = x\n'],
  ])("%s", (_, text) => {
    expect(parseGitConfig(text)).toBeNull();
  });
});
