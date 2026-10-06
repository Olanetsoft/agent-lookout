import { describe, expect, test } from "vitest";

import { gitHubRepositoryOf } from "@collector/git/remoteUrl";

const STOREFRONT = { owner: "example-org", name: "storefront" };

describe("a remote on github.com", () => {
  test.each([
    "https://github.com/example-org/storefront.git",
    "https://github.com/example-org/storefront",
    "https://github.com/example-org/storefront/",
    "https://github.com/example-org/storefront.git/",
    "http://github.com/example-org/storefront.git",
    "https://www.github.com/example-org/storefront.git",
    "HTTPS://GitHub.com/example-org/storefront.git",
  ])("over HTTPS: %s", (url) => {
    expect(gitHubRepositoryOf(url)).toEqual(STOREFRONT);
  });

  test.each([
    "git@github.com:example-org/storefront.git",
    "git@github.com:example-org/storefront",
    "github.com:example-org/storefront.git",
    "git@github.com:/example-org/storefront.git",
    "ssh://git@github.com/example-org/storefront.git",
    "ssh://git@github.com:22/example-org/storefront.git",
    "ssh://git@ssh.github.com:443/example-org/storefront.git",
    "git+ssh://git@github.com/example-org/storefront.git",
    "git://github.com/example-org/storefront.git",
  ])("over SSH or git: %s", (url) => {
    expect(gitHubRepositoryOf(url)).toEqual(STOREFRONT);
  });

  test("a user name and password in the address are never kept", () => {
    const repository = gitHubRepositoryOf(
      "https://demo-user:example-password@github.com/example-org/storefront.git",
    );
    expect(repository).toEqual(STOREFRONT);
    expect(JSON.stringify(repository)).not.toContain("example-password");
  });

  test("a name with dots, dashes and underscores is kept as it is, and only a last .git goes", () => {
    expect(gitHubRepositoryOf("git@github.com:Example-Org/docs.example.com.git")).toEqual({
      owner: "Example-Org",
      name: "docs.example.com",
    });
    expect(gitHubRepositoryOf("https://github.com/example-org/my_repo-2")).toEqual({
      owner: "example-org",
      name: "my_repo-2",
    });
  });

  test("spaces around the address are left out", () => {
    expect(gitHubRepositoryOf("  https://github.com/example-org/storefront.git \n")).toEqual(
      STOREFRONT,
    );
  });
});

describe("any other remote is passed over", () => {
  test.each([
    [
      "a GitHub Enterprise server over HTTPS",
      "https://github.example.com/example-org/storefront.git",
    ],
    ["a GitHub Enterprise server over SSH", "git@github.example.com:example-org/storefront.git"],
    [
      "GitHub Enterprise Cloud with data residency",
      "https://example.ghe.com/example-org/storefront.git",
    ],
    ["a host that only ends like github.com", "https://notgithub.com/example-org/storefront.git"],
    [
      "a host with github.com in front",
      "https://github.com.example.net/example-org/storefront.git",
    ],
    ["an SSH alias for github.com", "git@github-work:example-org/storefront.git"],
    ["another forge", "https://gitlab.com/example-org/storefront.git"],
    ["a folder on this computer", "/Users/example/code/storefront.git"],
    ["a relative folder", "../storefront"],
    ["a file address", "file:///Users/example/code/storefront.git"],
    ["a scheme git does not use for GitHub", "ftp://github.com/example-org/storefront.git"],
  ])("%s", (_, url) => {
    expect(gitHubRepositoryOf(url)).toBeNull();
  });

  test.each([
    ["the owner alone", "https://github.com/example-org"],
    ["a page under the repository", "https://github.com/example-org/storefront/pulls"],
    ["a query", "https://github.com/example-org/storefront.git?ref=main"],
    ["a fragment", "https://github.com/example-org/storefront.git#main"],
    ["an escape", "https://github.com/example-org/store%2Ffront.git"],
    ["an owner GitHub would not allow", "https://github.com/-example/storefront.git"],
    ["a name that is a dot", "https://github.com/example-org/..git"],
    ["a space inside", "https://github.com/example org/storefront.git"],
    ["nothing", ""],
  ])("an address that names no repository: %s", (_, url) => {
    expect(gitHubRepositoryOf(url)).toBeNull();
  });
});
