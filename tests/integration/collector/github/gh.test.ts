import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createGhAsker, GH_FIELDS, runGhBinary } from "@collector/github/gh";
import { tempDir } from "@tests/support/node/tempFiles";

// The stand-in gh is a POSIX sh script, which Windows cannot run.
const posixTest = test.skipIf(process.platform === "win32");

// The gh runner against a stand-in gh: a shell script of the test's own, named
// gh, in a folder of its own. It writes down what it was given and answers as
// gh does for each branch. The real gh is never run, and nothing reaches
// GitHub: the fixed places gh is installed in are not looked in.

const REPOSITORY = { owner: "example-org", name: "storefront" };

const check = (name: string, conclusion: string, status = "COMPLETED") => ({
  __typename: "CheckRun",
  name,
  workflowName: "CI",
  status,
  conclusion,
  startedAt: "2026-10-06T10:00:00Z",
  completedAt: "2026-10-06T10:04:00Z",
  detailsUrl: "https://github.com/example-org/storefront/actions/runs/1/job/2",
});

/** What gh prints for each branch with a pull request, as `gh pr view --json` prints it. */
const ANSWERS: Record<string, unknown> = {
  "open-failing": {
    number: 51,
    title: "Show the pull request and its checks",
    state: "OPEN",
    isDraft: false,
    statusCheckRollup: [
      check("lint", "SUCCESS"),
      check("unit", "FAILURE"),
      check("e2e", "", "IN_PROGRESS"),
      {
        __typename: "StatusContext",
        context: "preview",
        state: "SUCCESS",
        startedAt: "2026-10-06T10:00:00Z",
      },
    ],
  },
  draft: {
    number: 52,
    title: "Try a new board layout",
    state: "OPEN",
    isDraft: true,
    statusCheckRollup: [check("lint", "", "QUEUED")],
  },
  merged: {
    number: 49,
    title: "Read each session's branch",
    state: "MERGED",
    isDraft: false,
    statusCheckRollup: [check("lint", "SUCCESS"), check("unit", "SUCCESS")],
  },
};

/**
 * A stand-in gh, with one answer file for each branch above. It writes each
 * argument on a line of its own to `log`, then the settings it was given. Its
 * PATH is the folder it is in alone, so it runs other programs by full path.
 */
async function standInGh(): Promise<{ dir: string; log: string }> {
  const root = await tempDir();
  const dir = path.join(root, "bin");
  await mkdir(dir);
  const log = path.join(root, "log");
  for (const [branch, answer] of Object.entries(ANSWERS)) {
    await writeFile(path.join(root, `${branch}.json`), JSON.stringify(answer));
  }
  const script = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done
printf 'env %s %s %s [%s]\\n' "$GH_PROMPT_DISABLED" "$GH_NO_UPDATE_NOTIFIER" "$NO_COLOR" "$GH_FORCE_TTY" >> "${log}"
case "$8" in
  open-failing|draft|merged) /bin/cat "${root}/$8.json" ;;
  none) echo 'no pull requests found for branch "none"' >&2; exit 1 ;;
  signed-out) printf 'To get started with GitHub CLI, please run:  gh auth login\\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\\n' >&2; exit 4 ;;
  slow) exec /bin/sleep 30 ;;
  junk) echo '<html><body>Something went wrong</body></html>' ;;
  waits) /bin/cat > /dev/null; echo 'no pull requests found for branch "waits"' >&2; exit 1 ;;
  *) echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1 ;;
esac
`;
  const file = path.join(dir, "gh");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return { dir, log };
}

/** What gh asks with the stand-in on PATH, and nothing in the places gh is usually installed. */
function askerFor(dir: string, timeoutMs?: number) {
  return createGhAsker({
    env: { PATH: dir, GH_FORCE_TTY: "1", HOME: "/Users/example" },
    locations: [],
    timeoutMs,
  });
}

const target = (head: string) => ({ repository: REPOSITORY, head });

describe("asking a stand-in gh", () => {
  posixTest("an open pull request with a check failing", async () => {
    const { dir, log } = await standInGh();
    const answer = await askerFor(dir)(target("open-failing"));

    expect(answer).toEqual({
      kind: "found",
      pullRequest: {
        number: 51,
        title: "Show the pull request and its checks",
        state: "open",
        checks: { state: "failing", passing: 2, failing: 1, pending: 1 },
        url: "https://github.com/example-org/storefront/pull/51",
      },
    });
    // Each argument as it was given, the branch after --, and gh's prompts,
    // update checks and colours off, with a setting that would make it act as
    // if in a terminal left out.
    expect((await readFile(log, "utf8")).split("\n")).toEqual([
      "pr",
      "view",
      "--repo",
      "github.com/example-org/storefront",
      "--json",
      GH_FIELDS,
      "--",
      "open-failing",
      "env 1 1 1 []",
      "",
    ]);
  });

  posixTest("a draft, with its checks pending", async () => {
    const { dir } = await standInGh();
    expect(await askerFor(dir)(target("draft"))).toMatchObject({
      kind: "found",
      pullRequest: { number: 52, state: "draft", checks: { state: "pending", pending: 1 } },
    });
  });

  posixTest("a merged pull request, with its checks passing", async () => {
    const { dir } = await standInGh();
    expect(await askerFor(dir)(target("merged"))).toMatchObject({
      kind: "found",
      pullRequest: { number: 49, state: "merged", checks: { state: "passing", passing: 2 } },
    });
  });

  posixTest("a branch with no pull request", async () => {
    const { dir } = await standInGh();
    expect(await askerFor(dir)(target("none"))).toEqual({ kind: "none" });
  });

  posixTest("gh not signed in", async () => {
    const { dir } = await standInGh();
    expect(await askerFor(dir)(target("signed-out"))).toEqual({ kind: "signed-out" });
  });

  posixTest("gh that does not answer in time is given up on", async () => {
    const { dir } = await standInGh();
    const started = Date.now();
    expect(await askerFor(dir, 300)(target("slow"))).toEqual({
      kind: "failed",
      reason: "gh did not answer within 1 second",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  posixTest("an answer that is not gh's JSON", async () => {
    const { dir } = await standInGh();
    expect(await askerFor(dir)(target("junk"))).toEqual({
      kind: "failed",
      reason: "gh's answer could not be read",
    });
  });

  posixTest("gh failing for any other reason says so, and repeats nothing gh said", async () => {
    const { dir } = await standInGh();
    expect(await askerFor(dir)(target("offline"))).toEqual({
      kind: "failed",
      reason: "gh could not get the pull request from GitHub",
    });
  });

  posixTest("gh waiting for input is given none", async () => {
    const { dir } = await standInGh();
    expect(await askerFor(dir, 5_000)(target("waits"))).toEqual({ kind: "none" });
  });

  posixTest(
    "a branch that looks like an option or a shell command is handed over as it is",
    async () => {
      const { dir, log } = await standInGh();
      await askerFor(dir)(target("$(touch pwned); --web"));
      const lines = (await readFile(log, "utf8")).split("\n");
      expect(lines.slice(6, 8)).toEqual(["--", "$(touch pwned); --web"]);
      expect(existsSync(path.join(dir, "pwned"))).toBe(false);
    },
  );
});

describe("with no gh", () => {
  test("nothing is started, and the answer says there is none", async () => {
    const empty = path.join(await tempDir(), "bin");
    await mkdir(empty);
    expect(await askerFor(empty)(target("open-failing"))).toEqual({ kind: "not-found" });
  });

  test("a gh that cannot be started is none too, never an exception", async () => {
    const missing = path.join(await tempDir(), "gh");
    const run = await runGhBinary(missing, ["pr", "view"], { env: {} });
    expect(run).toMatchObject({ notStarted: true, code: null });
  });
});
