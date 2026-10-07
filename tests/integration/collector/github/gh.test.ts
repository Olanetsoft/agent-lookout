import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createGhAsker, GH_FIELDS, runGhBinary } from "@collector/github/gh";
import { tempDir, writeWindowsStub } from "@tests/support/node/tempFiles";

// The gh runner against a stand-in gh: a shell script of the test's own, named
// gh, in a folder of its own, or on Windows, where a script cannot be one, a
// stand-in gh.exe that does the same. It writes down what it was given and
// answers as gh does for each branch. The real gh is never run, and nothing
// reaches GitHub: the fixed places gh is installed in are not looked in.

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

/** What gh writes when it is not signed in. */
const SIGNED_OUT =
  "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n";

/** A stand-in gh: the folder to put on PATH, the file it writes to, and what its environment must hold. */
interface StandInGh {
  dir: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A stand-in gh, with one answer file for each branch above. It writes each
 * argument on a line of its own to `log`, then the settings it was given. Its
 * PATH is the folder it is in alone, so it runs other programs by full path.
 */
async function standInGh(): Promise<StandInGh> {
  const root = await tempDir();
  const dir = path.join(root, "bin");
  await mkdir(dir);
  const log = path.join(root, "log");
  for (const [branch, answer] of Object.entries(ANSWERS)) {
    await writeFile(path.join(root, `${branch}.json`), JSON.stringify(answer));
  }
  if (process.platform === "win32") return windowsGh(root, log);
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
  return { dir, log, env: {} };
}

/**
 * The same stand-in on Windows: this Node as `gh.exe`, in a folder of its own,
 * which acts as the script above does. Reading its input ends when that input
 * is closed, on Windows with an error that says so.
 */
async function windowsGh(root: string, log: string): Promise<StandInGh> {
  const stub = await writeWindowsStub(
    `const fs = require("node:fs");
  const log = ${JSON.stringify(log)};
  for (const arg of args) fs.appendFileSync(log, arg + "\\n");
  const { GH_PROMPT_DISABLED, GH_NO_UPDATE_NOTIFIER, NO_COLOR, GH_FORCE_TTY = "" } = process.env;
  fs.appendFileSync(log, \`env \${GH_PROMPT_DISABLED} \${GH_NO_UPDATE_NOTIFIER} \${NO_COLOR} [\${GH_FORCE_TTY}]\\n\`);
  const fail = (text, code) => { fs.writeSync(2, text); process.exit(code); };
  const branch = args[7];
  if (["open-failing", "draft", "merged"].includes(branch)) {
    write(fs.readFileSync(path.join(${JSON.stringify(root)}, branch + ".json"), "utf8"));
  } else if (branch === "none") fail('no pull requests found for branch "none"\\n', 1);
  else if (branch === "signed-out") fail(${JSON.stringify(SIGNED_OUT)}, 4);
  else if (branch === "slow") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  else if (branch === "junk") write("<html><body>Something went wrong</body></html>\\n");
  else if (branch === "waits") {
    try { fs.readFileSync(0); } catch {}
    fail('no pull requests found for branch "waits"\\n', 1);
  } else fail("HTTP 502: Bad Gateway (https://api.github.com/graphql)\\n", 1);`,
    "gh.exe",
  );
  // A program on Windows, Node among them, may need the Windows folder named.
  return {
    dir: path.dirname(stub.file),
    log,
    env: { ...stub.env, SystemRoot: process.env.SystemRoot },
  };
}

/** What gh asks with the stand-in on PATH, and nothing in the places gh is usually installed. */
function askerFor(gh: Pick<StandInGh, "dir"> & Partial<StandInGh>, timeoutMs?: number) {
  return createGhAsker({
    env: { ...gh.env, PATH: gh.dir, GH_FORCE_TTY: "1", HOME: "/Users/example" },
    locations: [],
    timeoutMs,
  });
}

const target = (head: string) => ({ repository: REPOSITORY, head });

describe("asking a stand-in gh", () => {
  test("an open pull request with a check failing", async () => {
    const gh = await standInGh();
    const answer = await askerFor(gh)(target("open-failing"));

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
    expect((await readFile(gh.log, "utf8")).split("\n")).toEqual([
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

  test("a draft, with its checks pending", async () => {
    const gh = await standInGh();
    expect(await askerFor(gh)(target("draft"))).toMatchObject({
      kind: "found",
      pullRequest: { number: 52, state: "draft", checks: { state: "pending", pending: 1 } },
    });
  });

  test("a merged pull request, with its checks passing", async () => {
    const gh = await standInGh();
    expect(await askerFor(gh)(target("merged"))).toMatchObject({
      kind: "found",
      pullRequest: { number: 49, state: "merged", checks: { state: "passing", passing: 2 } },
    });
  });

  test("a branch with no pull request", async () => {
    const gh = await standInGh();
    expect(await askerFor(gh)(target("none"))).toEqual({ kind: "none" });
  });

  test("gh not signed in", async () => {
    const gh = await standInGh();
    expect(await askerFor(gh)(target("signed-out"))).toEqual({ kind: "signed-out" });
  });

  test("gh that does not answer in time is given up on", async () => {
    const gh = await standInGh();
    const started = Date.now();
    expect(await askerFor(gh, 300)(target("slow"))).toEqual({
      kind: "failed",
      reason: "gh did not answer within 1 second",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("an answer that is not gh's JSON", async () => {
    const gh = await standInGh();
    expect(await askerFor(gh)(target("junk"))).toEqual({
      kind: "failed",
      reason: "gh's answer could not be read",
    });
  });

  test("gh failing for any other reason says so, and repeats nothing gh said", async () => {
    const gh = await standInGh();
    expect(await askerFor(gh)(target("offline"))).toEqual({
      kind: "failed",
      reason: "gh could not get the pull request from GitHub",
    });
  });

  test("gh waiting for input is given none", async () => {
    const gh = await standInGh();
    expect(await askerFor(gh, 5_000)(target("waits"))).toEqual({ kind: "none" });
  });

  test("a branch that looks like an option or a shell command is handed over as it is", async () => {
    const gh = await standInGh();
    await askerFor(gh)(target("$(touch pwned); --web"));
    const lines = (await readFile(gh.log, "utf8")).split("\n");
    expect(lines.slice(6, 8)).toEqual(["--", "$(touch pwned); --web"]);
    expect(existsSync(path.join(gh.dir, "pwned"))).toBe(false);
  });
});

describe("with no gh", () => {
  test("nothing is started, and the answer says there is none", async () => {
    const empty = path.join(await tempDir(), "bin");
    await mkdir(empty);
    expect(await askerFor({ dir: empty })(target("open-failing"))).toEqual({ kind: "not-found" });
  });

  test("a gh that cannot be started is none too, never an exception", async () => {
    const missing = path.join(await tempDir(), "gh");
    const run = await runGhBinary(missing, ["pr", "view"], { env: {} });
    expect(run).toMatchObject({ notStarted: true, code: null });
  });
});
