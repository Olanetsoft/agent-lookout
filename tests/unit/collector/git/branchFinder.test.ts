import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { GitIo } from "@collector/git/branchFinder";
import {
  BRANCH_READ_MS,
  createBranchFinder,
  findGitHead,
  MAX_LEVELS,
  READ_WAIT_MS,
} from "@collector/git/branchFinder";
import { MAX_GIT_FILE_BYTES } from "@collector/git/gitHead";
import { repositoryId } from "@collector/git/repository";
import { makeSession } from "@tests/fixtures/session";
import { handClock, memoryFiles } from "@tests/support/adapters/codexAdapter";

const HOME = "/Users/example";
const CODE = `${HOME}/code`;
const COMMIT = "3f9a2c17be04d5e6a7b8c9d0e1f2a3b4c5d6e7f8";

/** A repository with its git folder in it, on the branch given. */
function repository(files: ReturnType<typeof memoryFiles>, dir: string, head: string) {
  files.write(`${dir}/.git/HEAD`, head);
  return dir;
}

function find(files: ReturnType<typeof memoryFiles>, cwd: string, homeDir = HOME) {
  return findGitHead(cwd, { io: files.io, homeDir });
}

/**
 * A worktree's git folder in `common`, the repository's own, on the branch
 * given, with the `commondir` git writes in it.
 */
function worktreeIn(
  files: ReturnType<typeof memoryFiles>,
  common: string,
  name: string,
  head: string,
) {
  files.write(`${common}/worktrees/${name}/HEAD`, head);
  files.write(`${common}/worktrees/${name}/commondir`, "../..\n");
  return `${common}/worktrees/${name}`;
}

/** The repository whose main working folder is `folder`, with its .git folder, as the finder gives it. */
function inRepository(folder: string) {
  return { id: repositoryId(`${folder}/.git`), name: path.basename(folder) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("finding the repository", () => {
  test("a folder that holds .git has its HEAD read", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");

    expect(await find(files, `${CODE}/storefront`)).toEqual({
      branch: "main",
      repository: inRepository(`${CODE}/storefront`),
    });
    // Only the folder, its .git and the HEAD are touched, and nothing is listed.
    expect(files.calls).toEqual([
      { method: "stat", path: `${CODE}/storefront` },
      { method: "lstat", path: `${CODE}/storefront/.git` },
      { method: "openRegular", path: `${CODE}/storefront/.git/HEAD` },
    ]);
    expect(files.openHandles()).toBe(0);
  });

  test("a folder inside a repository is in it, as many folders up as it is", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/platform-api`, "ref: refs/heads/fix/rate-limits\n");
    files.mkdir(`${CODE}/platform-api/src/routes/billing`);

    expect(await find(files, `${CODE}/platform-api/src/routes/billing`)).toEqual({
      branch: "fix/rate-limits",
      repository: inRepository(`${CODE}/platform-api`),
    });
  });

  test("with no branch checked out, the short ID of the commit is given", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/docs`, `${COMMIT}\n`);

    expect(await find(files, `${CODE}/docs`)).toEqual({
      commit: "3f9a2c1",
      repository: inRepository(`${CODE}/docs`),
    });
  });

  test("in repositories one inside another, the nearest wins", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/infra`, "ref: refs/heads/main\n");
    repository(files, `${CODE}/infra/modules/network`, "ref: refs/heads/checkout-flow\n");
    files.mkdir(`${CODE}/infra/modules/network/vpc`);
    files.mkdir(`${CODE}/infra/modules/dns`);

    // Each is a repository of its own.
    expect(await find(files, `${CODE}/infra/modules/network/vpc`)).toEqual({
      branch: "checkout-flow",
      repository: inRepository(`${CODE}/infra/modules/network`),
    });
    expect(await find(files, `${CODE}/infra/modules/dns`)).toEqual({
      branch: "main",
      repository: inRepository(`${CODE}/infra`),
    });
  });

  test("the nearest .git that cannot be read gives nothing, not the repository above it", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/infra`, "ref: refs/heads/main\n");
    files.write(`${CODE}/infra/vendor/.git/HEAD`, "not a head\n");
    files.write(`${CODE}/infra/broken/.git`, "not a git file\n");
    files.special(`${CODE}/infra/linked/.git`);

    expect(await find(files, `${CODE}/infra/vendor`)).toBeNull();
    expect(await find(files, `${CODE}/infra/broken`)).toBeNull();
    expect(await find(files, `${CODE}/infra/linked`)).toBeNull();
    // A link is never opened.
    expect(files.opened()).not.toContain(`${CODE}/infra/linked/.git`);
  });

  test("a folder in no repository has nothing, and the walk stops short of the home folder", async () => {
    const files = memoryFiles();
    files.mkdir(`${CODE}/mobile-app/src`);
    // A repository in the home folder itself, as some keep their settings in.
    repository(files, HOME, "ref: refs/heads/main\n");

    expect(await find(files, `${CODE}/mobile-app/src`)).toBeNull();
    const looked = files.calls.filter((call) => call.method === "lstat").map((call) => call.path);
    expect(looked).toEqual([
      `${CODE}/mobile-app/src/.git`,
      `${CODE}/mobile-app/.git`,
      `${CODE}/.git`,
    ]);
    // The home folder itself is in no repository either.
    expect(await find(files, HOME)).toBeNull();
  });

  test("outside the home folder the walk stops short of the root", async () => {
    const files = memoryFiles();
    files.mkdir("/srv/builds/storefront");

    expect(await find(files, "/srv/builds/storefront")).toBeNull();
    const looked = files.calls.filter((call) => call.method === "lstat").map((call) => call.path);
    expect(looked).toEqual(["/srv/builds/storefront/.git", "/srv/builds/.git", "/srv/.git"]);
    expect(await find(files, "/")).toBeNull();
  });

  test(`it looks in no more than ${MAX_LEVELS} folders`, async () => {
    const files = memoryFiles();
    const deep = `/srv/${Array.from({ length: MAX_LEVELS + 5 }, (_, n) => `d${n}`).join("/")}`;
    files.mkdir(deep);
    repository(files, "/srv", "ref: refs/heads/main\n");

    expect(await find(files, deep)).toBeNull();
    expect(files.count("lstat")).toBe(MAX_LEVELS);
  });

  test.each([
    ["does not exist", `${CODE}/storefront/gone`],
    ["is a file", `${CODE}/storefront/README.md`],
    ["is not a whole path", "code/storefront"],
    ["is empty", ""],
  ])("a folder that %s is in no repository", async (_what, cwd) => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    files.write(`${CODE}/storefront/README.md`, "# storefront\n");

    expect(await find(files, cwd)).toBeNull();
    // Nothing is read on behalf of a folder that is not there.
    expect(files.opened()).toEqual([]);
  });

  test("a folder that cannot be looked in gives nothing, and the walk goes no further", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    files.mkdir(`${CODE}/storefront/private`);
    files.fail(`${CODE}/storefront/private/.git`, "EACCES");

    expect(await find(files, `${CODE}/storefront/private`)).toBeNull();
    expect(files.opened()).toEqual([]);
  });
});

describe("a .git file, as in a worktree or a submodule", () => {
  test("a relative path is followed from the folder the file is in", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    worktreeIn(
      files,
      `${CODE}/storefront/.git`,
      "checkout-flow",
      "ref: refs/heads/checkout-flow\n",
    );
    files.write(
      `${CODE}/storefront-checkout/.git`,
      "gitdir: ../storefront/.git/worktrees/checkout-flow\n",
    );
    files.mkdir(`${CODE}/storefront-checkout/src`);

    // The worktree belongs to the repository it was made from.
    expect(await find(files, `${CODE}/storefront-checkout/src`)).toEqual({
      branch: "checkout-flow",
      repository: inRepository(`${CODE}/storefront`),
    });
    // The file, then the HEAD it leads to and the commondir beside it, and
    // nothing else in either git folder.
    expect(files.opened()).toEqual([
      `${CODE}/storefront-checkout/.git`,
      `${CODE}/storefront/.git/worktrees/checkout-flow/HEAD`,
      `${CODE}/storefront/.git/worktrees/checkout-flow/commondir`,
    ]);
    // The repository the worktree belongs to is on its own branch.
    expect(await find(files, `${CODE}/storefront`)).toEqual({
      branch: "main",
      repository: inRepository(`${CODE}/storefront`),
    });
  });

  test("an absolute path is followed as it is", async () => {
    const files = memoryFiles();
    worktreeIn(files, `${CODE}/storefront/.git`, "api-rate-limits", `${COMMIT}\n`);
    files.write(
      `${CODE}/platform-api/.git`,
      `gitdir: ${CODE}/storefront/.git/worktrees/api-rate-limits\n`,
    );

    expect(await find(files, `${CODE}/platform-api`)).toEqual({
      commit: "3f9a2c1",
      repository: inRepository(`${CODE}/storefront`),
    });
  });

  test("a submodule's file leads into the git folder of the repository around it", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/platform-api`, "ref: refs/heads/main\n");
    files.write(`${CODE}/platform-api/.git/modules/docs/HEAD`, "ref: refs/heads/docs-site\n");
    files.write(`${CODE}/platform-api/docs/.git`, "gitdir: ../.git/modules/docs\n");

    // A submodule is a repository of its own, named for its folder. Its git
    // folder has no commondir: it is the repository's own.
    expect(await find(files, `${CODE}/platform-api/docs`)).toEqual({
      branch: "docs-site",
      repository: { id: repositoryId(`${CODE}/platform-api/.git/modules/docs`), name: "docs" },
    });
    expect(files.opened()).toEqual([
      `${CODE}/platform-api/docs/.git`,
      `${CODE}/platform-api/.git/modules/docs/HEAD`,
      `${CODE}/platform-api/.git/modules/docs/commondir`,
    ]);
  });

  test("a submodule at the path worktrees/x is a repository of its own, not a worktree", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/platform-api`, "ref: refs/heads/main\n");
    files.write(`${CODE}/platform-api/.git/modules/worktrees/x/HEAD`, "ref: refs/heads/main\n");
    files.write(
      `${CODE}/platform-api/worktrees/x/.git`,
      "gitdir: ../../.git/modules/worktrees/x\n",
    );

    expect((await find(files, `${CODE}/platform-api/worktrees/x`))?.repository).toEqual({
      id: repositoryId(`${CODE}/platform-api/.git/modules/worktrees/x`),
      name: "x",
    });
  });

  test("a submodule and a worktree made from it are one repository", async () => {
    const files = memoryFiles();
    const modules = `${CODE}/platform-api/.git/modules`;
    files.write(`${modules}/docs/HEAD`, "ref: refs/heads/main\n");
    files.write(`${CODE}/platform-api/docs/.git`, "gitdir: ../.git/modules/docs\n");
    const review = worktreeIn(files, `${modules}/docs`, "docs-review", "ref: refs/heads/review\n");
    files.write(`${CODE}/docs-review/.git`, `gitdir: ${review}\n`);

    const docs = await find(files, `${CODE}/platform-api/docs`);
    expect(docs?.repository).toEqual({ id: repositoryId(`${modules}/docs`), name: "docs" });
    expect((await find(files, `${CODE}/docs-review`))?.repository).toEqual(docs?.repository);
  });

  test("worktrees beside a bare repository in .bare are one repository with the folder around them", async () => {
    const files = memoryFiles();
    const bare = `${CODE}/billing/.bare`;
    files.write(`${bare}/HEAD`, "ref: refs/heads/main\n");
    files.write(`${CODE}/billing/.git`, "gitdir: ./.bare\n");
    files.write(
      `${CODE}/billing/main/.git`,
      `gitdir: ${worktreeIn(files, bare, "main", "ref: refs/heads/main\n")}\n`,
    );
    files.write(
      `${CODE}/billing/invoices/.git`,
      `gitdir: ${worktreeIn(files, bare, "invoices", "ref: refs/heads/invoice-export\n")}\n`,
    );

    const heads = [
      await find(files, `${CODE}/billing`),
      await find(files, `${CODE}/billing/main`),
      await find(files, `${CODE}/billing/invoices`),
    ];

    expect(heads.map((head) => head?.branch)).toEqual(["main", "main", "invoice-export"]);
    for (const head of heads) {
      expect(head?.repository).toEqual({ id: repositoryId(bare), name: "billing" });
    }
  });

  test("a main folder whose git folder is kept apart, and its worktree, are one repository", async () => {
    const files = memoryFiles();
    const apart = "/srv/git/storefront.git";
    files.write(`${apart}/HEAD`, "ref: refs/heads/main\n");
    files.write(`${CODE}/storefront/.git`, `gitdir: ${apart}\n`);
    files.write(
      `${CODE}/storefront-checkout/.git`,
      `gitdir: ${worktreeIn(files, apart, "checkout", "ref: refs/heads/checkout-flow\n")}\n`,
    );

    const main = await find(files, `${CODE}/storefront`);
    expect(main?.repository).toEqual({ id: repositoryId(apart), name: "storefront" });
    expect((await find(files, `${CODE}/storefront-checkout`))?.repository).toEqual(
      main?.repository,
    );
  });

  test("the main folder and two worktrees are one repository, as each worktree's commondir says", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    worktreeIn(files, `${CODE}/storefront/.git`, "checkout", "ref: refs/heads/checkout-flow\n");
    worktreeIn(files, `${CODE}/storefront/.git`, "rates", "ref: refs/heads/fix/rate-limits\n");
    // One commondir as git writes it, the other a whole path.
    files.rewrite(`${CODE}/storefront/.git/worktrees/rates/commondir`, `${CODE}/storefront/.git\n`);
    // A relative path that climbs, with a slash at its end, and a whole path elsewhere.
    files.write(
      `${CODE}/worktrees/storefront-checkout/.git`,
      "gitdir: ../../storefront/./.git/worktrees/checkout/\n",
    );
    files.write("/srv/builds/rates/.git", `gitdir: ${CODE}/storefront/.git/worktrees/rates\n`);

    const heads = [
      await find(files, `${CODE}/storefront`),
      await find(files, `${CODE}/worktrees/storefront-checkout`),
      await find(files, "/srv/builds/rates"),
    ];

    expect(heads.map((head) => head?.branch)).toEqual(["main", "checkout-flow", "fix/rate-limits"]);
    for (const head of heads) expect(head?.repository).toEqual(inRepository(`${CODE}/storefront`));
    // Nothing is listed, and nothing else is opened.
    expect(files.opened()).toEqual([
      `${CODE}/storefront/.git/HEAD`,
      `${CODE}/worktrees/storefront-checkout/.git`,
      `${CODE}/storefront/.git/worktrees/checkout/HEAD`,
      `${CODE}/storefront/.git/worktrees/checkout/commondir`,
      "/srv/builds/rates/.git",
      `${CODE}/storefront/.git/worktrees/rates/HEAD`,
      `${CODE}/storefront/.git/worktrees/rates/commondir`,
    ]);
    expect(files.count("readdir")).toBe(0);
  });

  test.each<[string, (files: ReturnType<typeof memoryFiles>, file: string) => void]>([
    ["says nothing", (files, file) => files.write(file, "")],
    ["says it on two lines", (files, file) => files.write(file, "../..\n../..\n")],
    ["has a control character in it", (files, file) => files.write(file, "../\u0000..\n")],
    ["is not text", (files, file) => files.write(file, new Uint8Array([0x2e, 0xff, 0x0a]))],
    [
      "is over the limit",
      (files, file) => files.write(file, `${"../".repeat(MAX_GIT_FILE_BYTES)}\n`),
    ],
    ["is a link or a pipe", (files, file) => files.special(file)],
    ["is a folder", (files, file) => files.mkdir(file)],
    ["cannot be opened", (files, file) => files.fail(file)],
  ])("a worktree whose commondir %s has its branch, and no repository", async (_what, spoil) => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    const gitDir = worktreeIn(
      files,
      `${CODE}/storefront/.git`,
      "checkout",
      "ref: refs/heads/checkout-flow\n",
    );
    files.remove(`${gitDir}/commondir`);
    spoil(files, `${gitDir}/commondir`);
    files.write(`${CODE}/storefront-checkout/.git`, `gitdir: ${gitDir}\n`);

    // The repository is never guessed at from where the git folder is.
    expect(await find(files, `${CODE}/storefront-checkout`)).toEqual({ branch: "checkout-flow" });
    expect(files.openHandles()).toBe(0);
  });

  test.each([
    ["names a folder that is not there", "gitdir: ../nowhere\n"],
    ["says something else", "ref: refs/heads/main\n"],
    ["is empty", ""],
  ])("a .git file that %s gives nothing", async (_what, content) => {
    const files = memoryFiles();
    files.write(`${CODE}/storefront-checkout/.git`, content);

    expect(await find(files, `${CODE}/storefront-checkout`)).toBeNull();
  });
});

describe("what is read", () => {
  test("a HEAD over the limit is not read at all", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, `ref: refs/heads/${"a".repeat(1024 * 1024)}\n`);

    expect(await find(files, `${CODE}/storefront`)).toBeNull();
    expect(files.reads).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("a .git file over the limit is not read at all", async () => {
    const files = memoryFiles();
    files.write(`${CODE}/storefront-checkout/.git`, `gitdir: ${"a/".repeat(MAX_GIT_FILE_BYTES)}\n`);

    expect(await find(files, `${CODE}/storefront-checkout`)).toBeNull();
    expect(files.reads).toEqual([]);
  });

  test("a HEAD just within the limit is read, and its long branch cut to a length", async () => {
    const files = memoryFiles();
    const prefix = "ref: refs/heads/";
    repository(
      files,
      `${CODE}/storefront`,
      `${prefix}${"b".repeat(MAX_GIT_FILE_BYTES - prefix.length)}`,
    );

    const head = await find(files, `${CODE}/storefront`);
    expect(head?.branch).toBe("b".repeat(200));
    expect(files.reads).toEqual([
      { path: `${CODE}/storefront/.git/HEAD`, position: 0, length: MAX_GIT_FILE_BYTES + 1 },
    ]);
  });

  test("a HEAD that is not text is no branch", async () => {
    const files = memoryFiles();
    files.write(
      `${CODE}/storefront/.git/HEAD`,
      new Uint8Array([...new TextEncoder().encode("ref: refs/heads/ma"), 0xff, 0xfe, 0x0a]),
    );

    expect(await find(files, `${CODE}/storefront`)).toBeNull();
  });

  test("a HEAD that is a link, a pipe or a folder is not read", async () => {
    const files = memoryFiles();
    files.special(`${CODE}/storefront/.git/HEAD`);
    files.mkdir(`${CODE}/platform-api/.git/HEAD`);

    expect(await find(files, `${CODE}/storefront`)).toBeNull();
    expect(await find(files, `${CODE}/platform-api`)).toBeNull();
    expect(files.reads).toEqual([]);
  });

  test("a HEAD that cannot be opened gives nothing, and never rejects", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    files.fail(`${CODE}/storefront/.git/HEAD`, "EACCES");

    await expect(find(files, `${CODE}/storefront`)).resolves.toBeNull();
  });
});

describe("the finder", () => {
  function finderFor(files: ReturnType<typeof memoryFiles>, clock = handClock(), io?: GitIo) {
    return {
      finder: createBranchFinder({ io: io ?? files.io, homeDir: HOME, now: clock.now }),
      clock,
    };
  }

  const at = (n: number, cwd: string | null) =>
    makeSession({ id: `status-files:session-${n}.json`, source: "status-files", cwd });

  /**
   * The files, where the stat of each folder `hangs` picks does not answer, as
   * on a network drive that has gone away, until `answer` is called.
   */
  function goneDrive(files: ReturnType<typeof memoryFiles>, hangs: (target: string) => boolean) {
    const asked: string[] = [];
    const waiting: (() => void)[] = [];
    const io: GitIo = {
      ...files.io,
      stat: (target) => {
        if (!hangs(target)) return files.io.stat(target);
        asked.push(target);
        return new Promise((resolve) => {
          waiting.push(() => resolve({ kind: "directory", size: 0, mtimeMs: 0, ino: 0 }));
        });
      },
    };
    return { io, asked, answer: () => waiting.splice(0).forEach((resolve) => resolve()) };
  }

  test("gives each session in a repository its branch or commit, and leaves the others as they are", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    repository(files, `${CODE}/docs`, `${COMMIT}\n`);
    files.mkdir(`${CODE}/mobile-app`);
    const { finder } = finderFor(files);
    const sessions = [
      at(1, `${CODE}/storefront`),
      at(2, `${CODE}/docs`),
      at(3, `${CODE}/mobile-app`),
      at(4, null),
    ];

    const annotated = await finder.annotate(sessions);

    expect(annotated.map((session) => session.git)).toEqual([
      { branch: "main", repository: inRepository(`${CODE}/storefront`) },
      { commit: "3f9a2c1", repository: inRepository(`${CODE}/docs`) },
      undefined,
      undefined,
    ]);
    // A session in no repository is the very same session, with no git at all.
    expect(annotated[2]).toBe(sessions[2]);
    expect(annotated[3]).not.toHaveProperty("git");
    // What it was given is not changed.
    expect(sessions[0]).not.toHaveProperty("git");
  });

  test("keeps each folder's repository's own git folder for the pull request finder, and gives it to no session", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    const common = `${CODE}/storefront/.git`;
    worktreeIn(files, common, "storefront-checkout", "ref: refs/heads/checkout-flow\n");
    files.write(
      `${CODE}/storefront-checkout/.git`,
      `gitdir: ${common}/worktrees/storefront-checkout\n`,
    );
    files.mkdir(`${CODE}/mobile-app`);
    const { finder } = finderFor(files);

    // Before a folder is read, nothing is known of it.
    expect(finder.gitFolderOf(`${CODE}/storefront`)).toBeNull();
    const annotated = await finder.annotate([
      at(1, `${CODE}/storefront`),
      at(2, `${CODE}/storefront-checkout`),
      at(3, `${CODE}/mobile-app`),
    ]);

    // The main folder and its worktree share the repository's own git folder.
    expect(finder.gitFolderOf(`${CODE}/storefront`)).toBe(common);
    expect(finder.gitFolderOf(`${CODE}/storefront-checkout`)).toBe(common);
    expect(finder.gitFolderOf(`${CODE}/mobile-app`)).toBeNull();
    expect(JSON.stringify(annotated)).not.toContain(`${common}/`);
    expect(JSON.stringify(annotated)).not.toContain(`"${common}"`);
  });

  test("a session on another machine keeps the branch read there, and its folder is never looked for here", async () => {
    const files = memoryFiles();
    // A folder of the same path on this machine, on another branch.
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    const { finder } = finderFor(files);
    const there = makeSession({
      id: "remote:devbox:claude-code:1",
      source: "remote:devbox",
      machine: "devbox",
      cwd: `${CODE}/storefront`,
      git: { branch: "checkout-flow" },
    });
    const elsewhere = makeSession({
      id: "remote:devbox:claude-code:2",
      source: "remote:devbox",
      machine: "devbox",
      cwd: `${CODE}/storefront`,
    });

    const annotated = await finder.annotate([there, elsewhere]);

    expect(annotated[0]).toBe(there);
    expect(annotated[1]).toBe(elsewhere);
    expect(annotated[1]).not.toHaveProperty("git");
  });

  test(`reads a folder once however many sessions are in it, then not again for ${BRANCH_READ_MS / 1000} seconds`, async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    const { finder, clock } = finderFor(files);
    const sessions = [at(1, `${CODE}/storefront`), at(2, `${CODE}/storefront`)];

    await finder.annotate(sessions);
    expect(files.opened()).toEqual([`${CODE}/storefront/.git/HEAD`]);

    // The branch is switched. Polls every 2 seconds go on with what was read.
    files.rewrite(`${CODE}/storefront/.git/HEAD`, "ref: refs/heads/checkout-flow\n");
    for (let poll = 1; poll < BRANCH_READ_MS / 2_000; poll += 1) {
      clock.advance(2_000);
      expect((await finder.annotate(sessions))[0]?.git?.branch).toBe("main");
    }
    expect(files.opened()).toHaveLength(1);

    clock.advance(2_000);
    const later = await finder.annotate(sessions);
    expect(later.map((session) => session.git?.branch)).toEqual(["checkout-flow", "checkout-flow"]);
    expect(files.opened()).toHaveLength(2);
  });

  test("a repository made after a session began is found at the next read", async () => {
    const files = memoryFiles();
    files.mkdir(`${CODE}/storefront`);
    const { finder, clock } = finderFor(files);
    const sessions = [at(1, `${CODE}/storefront`)];

    expect((await finder.annotate(sessions))[0]).not.toHaveProperty("git");
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    clock.advance(BRANCH_READ_MS);
    expect((await finder.annotate(sessions))[0]?.git).toEqual({
      branch: "main",
      repository: inRepository(`${CODE}/storefront`),
    });
  });

  test("forgets a folder no session is in, so one that comes back is read afresh", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    const { finder } = finderFor(files);

    await finder.annotate([at(1, `${CODE}/storefront`)]);
    await finder.annotate([]);
    await finder.annotate([at(1, `${CODE}/storefront`)]);
    expect(files.opened()).toHaveLength(2);
  });

  test(`a read that does not answer holds a poll for ${READ_WAIT_MS / 1000} second at most, and no poll after it`, async () => {
    vi.useFakeTimers();
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");
    repository(files, `${CODE}/docs`, `${COMMIT}\n`);
    const drive = goneDrive(files, (target) => target === `${CODE}/storefront`);
    const clock = handClock();
    const { finder } = finderFor(files, clock, drive.io);
    const sessions = [at(1, `${CODE}/docs`), at(2, `${CODE}/storefront`)];

    let first: Awaited<ReturnType<typeof finder.annotate>> | undefined;
    void finder.annotate(sessions).then((done) => (first = done));
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS - 1);
    expect(first).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // The folder read before it has its commit. The one that did not answer has nothing yet.
    expect(first?.map((session) => session.git?.commit)).toEqual(["3f9a2c1", undefined]);

    // The next poll does not wait for it again, and starts no read while it has not answered.
    clock.advance(BRANCH_READ_MS);
    const callsBefore = files.calls.length;
    const second = await finder.annotate(sessions);
    expect(second.map((session) => session.git?.commit)).toEqual(["3f9a2c1", undefined]);
    expect(files.calls).toHaveLength(callsBefore);
    expect(drive.asked).toHaveLength(1);

    // Once it answers, the poll after that has it.
    drive.answer();
    await vi.advanceTimersByTimeAsync(0);
    expect((await finder.annotate(sessions)).map((session) => session.git)).toEqual([
      { commit: "3f9a2c1", repository: inRepository(`${CODE}/docs`) },
      { branch: "main", repository: inRepository(`${CODE}/storefront`) },
    ]);
  });

  test("however many folders are on a drive that does not answer, only one read waits on it", async () => {
    vi.useFakeTimers();
    const files = memoryFiles();
    const drive = goneDrive(files, (target) => target.startsWith("/Volumes/shared/"));
    const { finder, clock } = finderFor(files, handClock(), drive.io);
    const sessions = Array.from({ length: 10 }, (_, n) => at(n, `/Volumes/shared/storefront-${n}`));

    const first = finder.annotate(sessions);
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS);
    expect((await first).map((session) => session.git)).toEqual(sessions.map(() => undefined));
    for (let poll = 0; poll < 10; poll += 1) {
      clock.advance(2_000);
      await finder.annotate(sessions);
    }
    // One stat holds one of the few threads Node reads files with, never all of them.
    expect(drive.asked).toEqual(["/Volumes/shared/storefront-0"]);
  });

  test("a folder that leaves the list while its read hangs, and comes back, is not read again", async () => {
    vi.useFakeTimers();
    const files = memoryFiles();
    const drive = goneDrive(files, (target) => target === "/Volumes/shared/storefront");
    const { finder, clock } = finderFor(files, handClock(), drive.io);
    const sessions = [at(1, "/Volumes/shared/storefront")];

    const first = finder.annotate(sessions);
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS);
    await first;
    for (let poll = 0; poll < 5; poll += 1) {
      clock.advance(BRANCH_READ_MS);
      await finder.annotate([]);
      await finder.annotate(sessions);
    }
    expect(drive.asked).toHaveLength(1);
  });
});
