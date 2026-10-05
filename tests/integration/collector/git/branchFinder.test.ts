import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { nodeIo } from "@collector/adapters/codex/io";
import { BRANCH_READ_MS, createBranchFinder, findGitHead } from "@collector/git/branchFinder";
import type { GitHead, Session } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";
import { handClock } from "@tests/support/adapters/codexAdapter";
import { tempDir } from "@tests/support/node/tempFiles";

const COMMIT = "3f9a2c17be04d5e6a7b8c9d0e1f2a3b4c5d6e7f8";

/** Writes a file, making its folders. */
async function put(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/**
 * Repositories made of plain files, as git lays them out, with no git needed:
 *
 *   storefront/           on main, with a worktree's git folder in it
 *   storefront-checkout/  a worktree of storefront, on checkout-flow, by a relative path
 *   platform-api/         a worktree of storefront, on fix/rate-limits, by a whole path
 *   docs/                 on no branch, at a commit
 *   infra/                on main, with modules/network, a repository of its own, inside
 *   mobile-app/           in no repository
 *
 * The temporary folder stands in for the home folder, so no walk leaves it.
 */
async function code() {
  const home = await tempDir();
  const at = (...parts: string[]) => path.join(home, "code", ...parts);
  await put(at("storefront", ".git", "HEAD"), "ref: refs/heads/main\n");
  await put(at("storefront", ".git", "config"), "[core]\n\tbare = false\n");
  await put(at("storefront", ".git", "packed-refs"), `${COMMIT} refs/heads/main\n`);
  await put(
    at("storefront", ".git", "worktrees", "checkout-flow", "HEAD"),
    "ref: refs/heads/checkout-flow\n",
  );
  await put(
    at("storefront", ".git", "worktrees", "api-rate-limits", "HEAD"),
    "ref: refs/heads/fix/rate-limits\n",
  );
  await mkdir(at("storefront", "src", "checkout"), { recursive: true });
  await put(
    at("storefront-checkout", ".git"),
    "gitdir: ../storefront/.git/worktrees/checkout-flow\n",
  );
  await mkdir(at("storefront-checkout", "src"), { recursive: true });
  await put(
    at("platform-api", ".git"),
    `gitdir: ${at("storefront", ".git", "worktrees", "api-rate-limits")}\n`,
  );
  await put(at("docs", ".git", "HEAD"), `${COMMIT}\n`);
  await put(at("infra", ".git", "HEAD"), "ref: refs/heads/main\n");
  await put(at("infra", "modules", "network", ".git", "HEAD"), "ref: refs/heads/infra-terraform\n");
  await mkdir(at("infra", "modules", "dns"), { recursive: true });
  await mkdir(at("mobile-app"), { recursive: true });
  return { home, at };
}

function find(cwd: string, home: string): Promise<GitHead | null> {
  return findGitHead(cwd, { io: nodeIo, homeDir: home });
}

/** Every file and folder under a folder, with when it was last changed. */
async function everything(dir: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const name of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, name);
    found.set(file, (await stat(file)).mtimeMs);
  }
  return found;
}

describe("real repositories made of plain files", () => {
  test("each folder has the branch or commit git would give it", async () => {
    const { home, at } = await code();

    expect(await find(at("storefront"), home)).toEqual({ branch: "main" });
    expect(await find(at("storefront", "src", "checkout"), home)).toEqual({ branch: "main" });
    expect(await find(at("storefront-checkout"), home)).toEqual({ branch: "checkout-flow" });
    expect(await find(at("storefront-checkout", "src"), home)).toEqual({
      branch: "checkout-flow",
    });
    expect(await find(at("platform-api"), home)).toEqual({ branch: "fix/rate-limits" });
    expect(await find(at("docs"), home)).toEqual({ commit: "3f9a2c1" });
    expect(await find(at("infra", "modules", "network"), home)).toEqual({
      branch: "infra-terraform",
    });
    expect(await find(at("infra", "modules", "dns"), home)).toEqual({ branch: "main" });
    expect(await find(at("mobile-app"), home)).toBeNull();
    expect(await find(at("gone"), home)).toBeNull();
  });

  test("nothing is written, and nothing but the .git file and HEAD is opened", async () => {
    const { home, at } = await code();
    const before = await everything(home);
    const opened: string[] = [];
    const io = {
      ...nodeIo,
      openRegular: (file: string) => (opened.push(file), nodeIo.openRegular(file)),
    };

    for (const folder of ["storefront", "storefront-checkout", "platform-api", "docs"]) {
      await findGitHead(at(folder), { io, homeDir: home });
    }

    expect(opened.map((file) => path.relative(at(), file))).toEqual([
      "storefront/.git/HEAD",
      "storefront-checkout/.git",
      "storefront/.git/worktrees/checkout-flow/HEAD",
      "platform-api/.git",
      "storefront/.git/worktrees/api-rate-limits/HEAD",
      "docs/.git/HEAD",
    ]);
    expect(await everything(home)).toEqual(before);
  });

  test("a HEAD or a .git that is a symbolic link is not followed", async () => {
    const { home, at } = await code();
    await mkdir(at("checkout-flow", ".git"), { recursive: true });
    await symlink(at("storefront", ".git", "HEAD"), at("checkout-flow", ".git", "HEAD"));
    await mkdir(at("billing-webhooks"));
    await symlink(at("storefront", ".git"), at("billing-webhooks", ".git"));

    expect(await find(at("checkout-flow"), home)).toBeNull();
    expect(await find(at("billing-webhooks"), home)).toBeNull();
  });

  test("a folder reached through a link is read where the link leads", async () => {
    const { home, at } = await code();
    await symlink(at("storefront-checkout"), at("checkout-link"));

    expect(await find(at("checkout-link"), home)).toEqual({ branch: "checkout-flow" });
  });

  test.skipIf(process.platform === "win32")(
    "a HEAD that is a named pipe is passed over without the read waiting on it",
    async () => {
      const { home, at } = await code();
      await mkdir(at("search-indexing", ".git"), { recursive: true });
      execFileSync("mkfifo", [at("search-indexing", ".git", "HEAD")]);

      expect(await find(at("search-indexing"), home)).toBeNull();
    },
  );

  test("the finder gives sessions their branches, and sees a branch switched once its reading is old", async () => {
    const { home, at } = await code();
    const clock = handClock();
    const finder = createBranchFinder({ homeDir: home, now: clock.now });
    const sessions: Session[] = [
      makeSession({ id: "status-files:checkout-flow.json", cwd: at("storefront-checkout") }),
      makeSession({ id: "status-files:docs-site.json", cwd: at("docs") }),
      makeSession({ id: "status-files:mobile-onboarding.json", cwd: at("mobile-app") }),
    ];
    const heads = async () => (await finder.annotate(sessions)).map((session) => session.git);

    expect(await heads()).toEqual([{ branch: "checkout-flow" }, { commit: "3f9a2c1" }, undefined]);

    // The worktree checks out another branch, and the docs a branch at last.
    await writeFile(
      at("storefront", ".git", "worktrees", "checkout-flow", "HEAD"),
      "ref: refs/heads/billing-webhooks\n",
    );
    await writeFile(at("docs", ".git", "HEAD"), "ref: refs/heads/docs-site\n");
    clock.advance(BRANCH_READ_MS - 1);
    expect(await heads()).toEqual([{ branch: "checkout-flow" }, { commit: "3f9a2c1" }, undefined]);
    clock.advance(1);
    expect(await heads()).toEqual([
      { branch: "billing-webhooks" },
      { branch: "docs-site" },
      undefined,
    ]);

    // The repository goes, and so does the branch.
    await rm(at("docs", ".git"), { recursive: true });
    clock.advance(BRANCH_READ_MS);
    expect(await heads()).toEqual([{ branch: "billing-webhooks" }, undefined, undefined]);
  });
});
