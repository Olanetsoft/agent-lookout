import { describe, expect, test } from "vitest";

import { MAX_BRANCH_LENGTH, parseGitFile, parseHead } from "@collector/git/gitHead";

const COMMIT = "3f9a2c17be04d5e6a7b8c9d0e1f2a3b4c5d6e7f8";
const COMMIT_256 = "3f9a2c17be04d5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0";

describe("HEAD", () => {
  test.each([
    ["ref: refs/heads/main\n", "main"],
    ["ref: refs/heads/checkout-flow\n", "checkout-flow"],
    ["ref: refs/heads/fix/rate-limits\n", "fix/rate-limits"],
    // Git reads a missing line break, a carriage return and spaces after the colon too.
    ["ref: refs/heads/main", "main"],
    ["ref: refs/heads/main\r\n", "main"],
    ["ref:refs/heads/main\n", "main"],
    ["ref:   refs/heads/main  \n", "main"],
  ])("%j has the branch %s checked out", (content, branch) => {
    expect(parseHead(content)).toEqual({ branch });
  });

  test("a commit's ID, with no branch checked out, is its first seven characters", () => {
    expect(parseHead(`${COMMIT}\n`)).toEqual({ commit: "3f9a2c1" });
    expect(parseHead(COMMIT)).toEqual({ commit: "3f9a2c1" });
    // A repository that names its commits with SHA-256.
    expect(parseHead(`${COMMIT_256}\n`)).toEqual({ commit: "3f9a2c1" });
  });

  test.each([
    ["nothing", ""],
    ["an empty line", "\n"],
    ["a reference with no branch in it", "ref: refs/heads/\n"],
    ["a reference outside the branches", "ref: refs/remotes/origin/main\n"],
    ["a tag", "ref: refs/tags/v1.0.0\n"],
    ["a reference that is not one", "ref: main\n"],
    ["an ID too short", `${COMMIT.slice(0, 39)}\n`],
    ["an ID too long", `${COMMIT}0\n`],
    ["an ID in capitals", `${COMMIT.toUpperCase()}\n`],
    ["an ID that is not hexadecimal", `${COMMIT.slice(0, 39)}g\n`],
    ["two lines", "ref: refs/heads/main\nref: refs/heads/other\n"],
    ["a reference and then an ID", `ref: refs/heads/main\n${COMMIT}\n`],
    ["JSON", '{"branch":"main"}'],
    ["a word", "main\n"],
    ["junk", "\u0000\u0001\u0002ÿ"],
  ])("%s is no branch and no commit", (_what, content) => {
    expect(parseHead(content)).toBeNull();
  });

  test("a branch is cleaned of control characters and of those that turn text around", () => {
    expect(parseHead("ref: refs/heads/fix\u0007rate-limits\n")).toEqual({
      branch: "fix rate-limits",
    });
    // A right-to-left override would make the name read as another.
    expect(parseHead("ref: refs/heads/main‮gnp.exe\n")).toEqual({ branch: "main gnp.exe" });
    expect(parseHead("ref: refs/heads/⁦⁩\n")).toBeNull();
  });

  test("a branch with odd characters and markup in it is kept as the text it is", () => {
    const branch = "<img src=x onerror=alert(1)>/émoji-🚀/a&b";
    expect(parseHead(`ref: refs/heads/${branch}\n`)).toEqual({ branch });
  });

  test("a branch longer than the limit is cut to it, never inside a character", () => {
    const long = "😀".repeat(MAX_BRANCH_LENGTH + 50);
    const branch = parseHead(`ref: refs/heads/${long}\n`)?.branch ?? "";
    expect(Array.from(branch)).toHaveLength(MAX_BRANCH_LENGTH);
    expect(branch).toBe("😀".repeat(MAX_BRANCH_LENGTH));
    const fits = "b".repeat(MAX_BRANCH_LENGTH);
    expect(parseHead(`ref: refs/heads/${fits}\n`)).toEqual({ branch: fits });
  });
});

describe("a .git file", () => {
  test.each([
    [
      "gitdir: /code/storefront/.git/worktrees/checkout-flow\n",
      "/code/storefront/.git/worktrees/checkout-flow",
    ],
    [
      "gitdir: ../storefront/.git/worktrees/checkout-flow\n",
      "../storefront/.git/worktrees/checkout-flow",
    ],
    ["gitdir: ../.git/modules/docs", "../.git/modules/docs"],
    ["gitdir:  .git-real \r\n", ".git-real"],
  ])("%j names the git folder %s", (content, target) => {
    expect(parseGitFile(content)).toBe(target);
  });

  test.each([
    ["nothing", ""],
    ["no path", "gitdir: \n"],
    ["another word", "worktree: /code/storefront\n"],
    ["a HEAD's contents", "ref: refs/heads/main\n"],
    ["two lines", "gitdir: /code/one\ngitdir: /code/two\n"],
    ["a control character in the path", "gitdir: /code/store\u0000front\n"],
    ["junk", "\u0001\u0002ÿ"],
  ])("%s names no folder", (_what, content) => {
    expect(parseGitFile(content)).toBeNull();
  });
});
