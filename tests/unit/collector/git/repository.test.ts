import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { REPOSITORY_ID_LENGTH, repositoryId, repositoryOf } from "@collector/git/repository";

const CODE = "/Users/example/code";

/** The repository of a folder with a `.git` folder of its own. */
const plain = (dir: string) => repositoryOf({ dir, gitDir: `${dir}/.git`, commonDir: null });

/** The repository of a worktree, whose git folder's `commondir` names `commonDir`. */
const worktree = (dir: string, commonDir: string, name = "wt") =>
  repositoryOf({ dir, gitDir: `${commonDir}/worktrees/${name}`, commonDir });

/** The repository of a `.git` file naming `gitDir`, which has no `commondir`. */
const linked = (dir: string, gitDir: string) => repositoryOf({ dir, gitDir, commonDir: null });

describe("which repository a folder belongs to", () => {
  test("a .git folder is its own repository, named for the folder that holds it", () => {
    expect(plain(`${CODE}/storefront`)).toEqual({
      id: repositoryId(`${CODE}/storefront/.git`),
      name: "storefront",
    });
  });

  test("two worktrees of one repository, wherever they are, are in the repository and named for it", () => {
    const main = plain(`${CODE}/storefront`);

    expect(
      worktree(`${CODE}/storefront-checkout`, `${CODE}/storefront/.git`, "checkout-flow"),
    ).toEqual(main);
    expect(worktree("/srv/builds/rate-limits", `${CODE}/storefront/.git`, "rate-limits")).toEqual(
      main,
    );
  });

  test("worktrees beside a bare repository in .bare share its id with the folder around them, and its name", () => {
    // billing/.git is a file, "gitdir: ./.bare", and the worktrees sit beside it.
    const container = linked(`${CODE}/billing`, `${CODE}/billing/.bare`);
    const main = worktree(`${CODE}/billing/main`, `${CODE}/billing/.bare`, "main");
    const invoices = worktree(`${CODE}/billing/invoices`, `${CODE}/billing/.bare`, "invoices");

    expect(container).toEqual({ id: repositoryId(`${CODE}/billing/.bare`), name: "billing" });
    expect(main).toEqual(container);
    expect(invoices).toEqual(container);
  });

  test("a worktree of a bare repository named storefront.git is in storefront", () => {
    expect(worktree(`${CODE}/checkout`, `${CODE}/storefront.git`)).toEqual({
      id: repositoryId(`${CODE}/storefront.git`),
      name: "storefront",
    });
  });

  test("a main folder whose git folder is kept apart, and its worktree, are one repository", () => {
    const main = linked(`${CODE}/storefront`, "/srv/git/storefront.git");
    const checkout = worktree(`${CODE}/storefront-checkout`, "/srv/git/storefront.git");

    expect(main).toEqual({ id: repositoryId("/srv/git/storefront.git"), name: "storefront" });
    expect(checkout).toEqual(main);
  });

  test("a submodule is a repository of its own, and its worktree is in it", () => {
    const modules = `${CODE}/platform-api/.git/modules`;
    const docs = linked(`${CODE}/platform-api/docs`, `${modules}/docs`);

    expect(docs).toEqual({ id: repositoryId(`${modules}/docs`), name: "docs" });
    expect(docs?.id).not.toBe(plain(`${CODE}/platform-api`)?.id);
    expect(worktree(`${CODE}/docs-review`, `${modules}/docs`)).toEqual(docs);
  });

  test("a submodule at the path worktrees/x is still a repository of its own", () => {
    const modules = `${CODE}/platform-api/.git/modules`;
    const x = linked(`${CODE}/platform-api/worktrees/x`, `${modules}/worktrees/x`);

    expect(x).toEqual({ id: repositoryId(`${modules}/worktrees/x`), name: "x" });
    expect(x?.id).not.toBe(plain(`${CODE}/platform-api`)?.id);
  });

  test("a repository inside another is its own", () => {
    expect(plain(`${CODE}/infra/modules/network`)).toEqual({
      id: repositoryId(`${CODE}/infra/modules/network/.git`),
      name: "network",
    });
    expect(plain(`${CODE}/infra/modules/network`)?.id).not.toBe(plain(`${CODE}/infra`)?.id);
  });

  test.each([
    ["a hidden folder", `${CODE}/storefront/.repo`, "storefront"],
    ["a name that is only .git", `${CODE}/docs/.git`, "docs"],
    ["a name with .git inside it", `${CODE}/my.github.io.git`, "my.github.io"],
    ["a name with no .git", "/srv/git/platform-api", "platform-api"],
  ])("a worktree's repository whose git folder is %s is named %s", (_what, common, name) => {
    expect(worktree(`${CODE}/checkout`, common)?.name).toBe(name);
  });
});

describe("the repository's name and id", () => {
  test.each([
    ["spaces", `${CODE}/client work/mobile app`, "mobile app"],
    ["letters of any script", `${CODE}/документы`, "документы"],
    ["a dot first", `${CODE}/.dotfiles`, ".dotfiles"],
    ["control characters, which become spaces", `${CODE}/docs\u0007site`, "docs site"],
    ["marks that reorder text", `${CODE}/docs‮site`, "docs site"],
    ["more than 200 characters, cut", `${CODE}/${"d".repeat(300)}`, "d".repeat(200)],
  ])("a name with %s is cleaned as a session's name is", (_what, folder, name) => {
    expect(plain(folder)?.name).toBe(name);
  });

  test.each([
    ["a folder with only control characters", plain(`${CODE}/\u0007\u0008`)],
    ["a worktree of a git folder at the root", worktree(`${CODE}/checkout`, "/")],
    ["a worktree of a hidden git folder at the root", worktree(`${CODE}/checkout`, "/.git")],
  ])("%s, with no name to show, is no repository", (_what, repository) => {
    expect(repository).toBeNull();
  });

  test("the id is the same every time for one repository", () => {
    expect(plain(`${CODE}/storefront`)?.id).toBe(plain(`${CODE}/storefront`)?.id);
    expect(repositoryId(`${CODE}/storefront/.git`)).toBe(repositoryId(`${CODE}/storefront/.git`));
  });

  test("the id is the first characters of the SHA-256 of the git folder's path, in lower-case hexadecimal", () => {
    const gitFolder = `${CODE}/storefront/.git`;
    const id = repositoryId(gitFolder);

    expect(REPOSITORY_ID_LENGTH).toBe(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).toBe(createHash("sha256").update(gitFolder).digest("hex").slice(0, 16));
  });

  test("the id holds neither the path nor any part of it", () => {
    const repository = worktree(`${CODE}/storefront-checkout`, `${CODE}/storefront/.git`);

    for (const part of `${CODE}/storefront/.git`.split("/").filter(Boolean)) {
      expect(repository?.id).not.toContain(part);
    }
    expect(JSON.stringify(repository)).not.toContain(CODE);
  });

  test("repositories of one name in different places have different ids", () => {
    const repositories = [`${CODE}/api`, "/Users/example/work/api", `${CODE}/api/api`].map(plain);

    expect(new Set(repositories.map((repository) => repository?.id)).size).toBe(3);
    expect(new Set(repositories.map((repository) => repository?.name))).toEqual(new Set(["api"]));
  });
});
