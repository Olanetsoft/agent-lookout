import { describe, expect, test } from "vitest";

import {
  answerOf,
  findGhBinary,
  GH_FIELDS,
  GH_LOCATIONS,
  ghArguments,
  ghEnvironment,
  type GhRun,
} from "@collector/github/gh";

// What the collector asks gh and makes of its answers, with nothing run. The
// tests that run a stand-in gh are in the integration group.

const TARGET = { repository: { owner: "example-org", name: "storefront" }, head: "checkout-flow" };

function ran(fields: Partial<GhRun>): GhRun {
  return {
    code: null,
    notStarted: false,
    timedOut: false,
    tooLong: false,
    stdout: "",
    stderr: "",
    ...fields,
  };
}

describe("what gh is asked", () => {
  test("one pull request, by repository and branch, with the branch after --", () => {
    expect(ghArguments(TARGET)).toEqual([
      "pr",
      "view",
      "--repo",
      "github.com/example-org/storefront",
      "--json",
      GH_FIELDS,
      "--",
      "checkout-flow",
    ]);
    expect(GH_FIELDS).toBe("number,title,state,isDraft,statusCheckRollup");
  });

  test("gh is given the collector's environment, without Agent Lookout's own settings, and with its prompts, update checks, colours and debugging off", () => {
    const env = ghEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      GH_CONFIG_DIR: "/Users/example/.config/gh",
      GH_FORCE_TTY: "1",
      GH_DEBUG: "api",
      DEBUG: "1",
      GH_PAGER: "less",
      AGENT_LOOKOUT_PULL_REQUESTS: "on",
      AGENT_LOOKOUT_SMTP_URL: "smtps://name:example-password@mail.example.com",
      AGENT_LOOKOUT_WEBHOOK_URL: "https://hooks.example.com/services/T000/B000/XXXX",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      GH_CONFIG_DIR: "/Users/example/.config/gh",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_SPINNER_DISABLED: "1",
      NO_COLOR: "1",
    });
  });
});

describe("finding gh", () => {
  test("the first on PATH, then the usual places, and none when there is none", async () => {
    const on = (found: string[]) => async (candidate: string) => found.includes(candidate);
    expect(
      await findGhBinary(
        { PATH: "/Users/example/bin:/usr/local/bin" },
        on(["/usr/local/bin/gh"]),
        GH_LOCATIONS,
        "linux",
      ),
    ).toBe("/usr/local/bin/gh");
    expect(await findGhBinary({}, on(["/opt/homebrew/bin/gh"]), GH_LOCATIONS, "darwin")).toBe(
      "/opt/homebrew/bin/gh",
    );
    expect(await findGhBinary({ PATH: "/usr/bin" }, on([]), GH_LOCATIONS, "linux")).toBeNull();
    expect(GH_LOCATIONS).toEqual([
      "/opt/homebrew/bin/gh",
      "/usr/local/bin/gh",
      "/opt/local/bin/gh",
      "/usr/bin/gh",
    ]);
  });

  test("a relative folder on PATH is never looked in", async () => {
    const asked: string[] = [];
    await findGhBinary(
      { PATH: "bin:.:/usr/bin" },
      async (candidate) => {
        asked.push(candidate);
        return false;
      },
      [],
      "linux",
    );
    expect(asked).toEqual(["/usr/bin/gh"]);
  });

  test("on Windows, a gh.exe on Path, and never a script", async () => {
    const asked: string[] = [];
    const found = await findGhBinary(
      { Path: "C:\\Program Files\\GitHub CLI;bin" },
      async (candidate) => {
        asked.push(candidate);
        return candidate.endsWith(".exe");
      },
      [],
      "win32",
    );
    expect(found).toBe("C:\\Program Files\\GitHub CLI\\gh.exe");
    expect(asked).toEqual([
      "C:\\Program Files\\GitHub CLI\\gh.com",
      "C:\\Program Files\\GitHub CLI\\gh.exe",
    ]);
  });
});

describe("what an answer comes to", () => {
  const found = JSON.stringify({
    number: 51,
    title: "Show the pull request",
    state: "OPEN",
    isDraft: false,
    statusCheckRollup: [],
  });

  test("a pull request", () => {
    expect(answerOf(ran({ code: 0, stdout: found }), TARGET)).toMatchObject({
      kind: "found",
      pullRequest: { number: 51, state: "open" },
    });
  });

  test("a branch with none", () => {
    expect(
      answerOf(
        ran({ code: 1, stderr: 'no pull requests found for branch "checkout-flow"\n' }),
        TARGET,
      ),
    ).toEqual({ kind: "none" });
  });

  test("gh not signed in, by its exit code or by what it says", () => {
    expect(
      answerOf(
        ran({ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" }),
        TARGET,
      ),
    ).toEqual({
      kind: "signed-out",
    });
    expect(
      answerOf(
        ran({
          code: 1,
          stderr: "HTTP 401: Bad credentials\nTry authenticating with:  gh auth login",
        }),
        TARGET,
      ),
    ).toEqual({ kind: "signed-out" });
  });

  test("gh not there", () => {
    expect(answerOf(ran({ notStarted: true }), TARGET)).toEqual({ kind: "not-found" });
  });

  test("gh too slow, too long, unreadable or failing is a failure, with a reason of its own", () => {
    expect(answerOf(ran({ timedOut: true }), TARGET, 15_000)).toEqual({
      kind: "failed",
      reason: "gh did not answer within 15 seconds",
    });
    expect(answerOf(ran({ tooLong: true }), TARGET)).toEqual({
      kind: "failed",
      reason: "gh's answer could not be read",
    });
    expect(answerOf(ran({ code: 0, stdout: "<html>rate limited</html>" }), TARGET)).toEqual({
      kind: "failed",
      reason: "gh's answer could not be read",
    });
    expect(
      answerOf(ran({ code: 1, stderr: "error connecting to api.github.com" }), TARGET),
    ).toEqual({ kind: "failed", reason: "gh could not get the pull request from GitHub" });
  });

  test("what gh said is never repeated in a reason", () => {
    const answer = answerOf(ran({ code: 2, stderr: "token ghp_example1234 was refused" }), TARGET);
    expect(JSON.stringify(answer)).not.toContain("ghp_");
  });
});
