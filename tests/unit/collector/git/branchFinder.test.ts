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

afterEach(() => {
  vi.useRealTimers();
});

describe("finding the repository", () => {
  test("a folder that holds .git has its HEAD read", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/storefront`, "ref: refs/heads/main\n");

    expect(await find(files, `${CODE}/storefront`)).toEqual({ branch: "main" });
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
    });
  });

  test("with no branch checked out, the short ID of the commit is given", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/docs`, `${COMMIT}\n`);

    expect(await find(files, `${CODE}/docs`)).toEqual({ commit: "3f9a2c1" });
  });

  test("in repositories one inside another, the nearest wins", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/infra`, "ref: refs/heads/main\n");
    repository(files, `${CODE}/infra/modules/network`, "ref: refs/heads/checkout-flow\n");
    files.mkdir(`${CODE}/infra/modules/network/vpc`);
    files.mkdir(`${CODE}/infra/modules/dns`);

    expect(await find(files, `${CODE}/infra/modules/network/vpc`)).toEqual({
      branch: "checkout-flow",
    });
    expect(await find(files, `${CODE}/infra/modules/dns`)).toEqual({ branch: "main" });
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
    files.write(
      `${CODE}/storefront/.git/worktrees/checkout-flow/HEAD`,
      "ref: refs/heads/checkout-flow\n",
    );
    files.write(
      `${CODE}/storefront-checkout/.git`,
      "gitdir: ../storefront/.git/worktrees/checkout-flow\n",
    );
    files.mkdir(`${CODE}/storefront-checkout/src`);

    expect(await find(files, `${CODE}/storefront-checkout/src`)).toEqual({
      branch: "checkout-flow",
    });
    // The file, then the HEAD it leads to, and nothing else in either git folder.
    expect(files.opened()).toEqual([
      `${CODE}/storefront-checkout/.git`,
      `${CODE}/storefront/.git/worktrees/checkout-flow/HEAD`,
    ]);
    // The repository the worktree belongs to is on its own branch.
    expect(await find(files, `${CODE}/storefront`)).toEqual({ branch: "main" });
  });

  test("an absolute path is followed as it is", async () => {
    const files = memoryFiles();
    files.write(`${CODE}/storefront/.git/worktrees/api-rate-limits/HEAD`, `${COMMIT}\n`);
    files.write(
      `${CODE}/platform-api/.git`,
      `gitdir: ${CODE}/storefront/.git/worktrees/api-rate-limits\n`,
    );

    expect(await find(files, `${CODE}/platform-api`)).toEqual({ commit: "3f9a2c1" });
  });

  test("a submodule's file leads into the git folder of the repository around it", async () => {
    const files = memoryFiles();
    repository(files, `${CODE}/platform-api`, "ref: refs/heads/main\n");
    files.write(`${CODE}/platform-api/.git/modules/docs/HEAD`, "ref: refs/heads/docs-site\n");
    files.write(`${CODE}/platform-api/docs/.git`, "gitdir: ../.git/modules/docs\n");

    expect(await find(files, `${CODE}/platform-api/docs`)).toEqual({ branch: "docs-site" });
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
      { branch: "main" },
      { commit: "3f9a2c1" },
      undefined,
      undefined,
    ]);
    // A session in no repository is the very same session, with no git at all.
    expect(annotated[2]).toBe(sessions[2]);
    expect(annotated[3]).not.toHaveProperty("git");
    // What it was given is not changed.
    expect(sessions[0]).not.toHaveProperty("git");
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
      expect((await finder.annotate(sessions))[0]?.git).toEqual({ branch: "main" });
    }
    expect(files.opened()).toHaveLength(1);

    clock.advance(2_000);
    const later = await finder.annotate(sessions);
    expect(later.map((session) => session.git)).toEqual([
      { branch: "checkout-flow" },
      { branch: "checkout-flow" },
    ]);
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
    expect((await finder.annotate(sessions))[0]?.git).toEqual({ branch: "main" });
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
    expect(first?.map((session) => session.git)).toEqual([{ commit: "3f9a2c1" }, undefined]);

    // The next poll does not wait for it again, and starts no read while it has not answered.
    clock.advance(BRANCH_READ_MS);
    const callsBefore = files.calls.length;
    const second = await finder.annotate(sessions);
    expect(second.map((session) => session.git)).toEqual([{ commit: "3f9a2c1" }, undefined]);
    expect(files.calls).toHaveLength(callsBefore);
    expect(drive.asked).toHaveLength(1);

    // Once it answers, the poll after that has it.
    drive.answer();
    await vi.advanceTimersByTimeAsync(0);
    expect((await finder.annotate(sessions)).map((session) => session.git)).toEqual([
      { commit: "3f9a2c1" },
      { branch: "main" },
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
