import { describe, expect, test } from "vitest";

import { runByTmux, runCommand } from "@cli/agentLookout";
import type { Reading } from "@cli/localServer";
import type { ReportedSnapshot } from "@cli/statusReport";
import { makeSession } from "@tests/fixtures/session";

// The command with its one request replaced, so the order in which it tries
// addresses, and what it says when none answers, can be checked without asking
// the Agent Lookout that may be running on this machine. The real request is in
// the integration test.

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const quiet: ReportedSnapshot = {
  sources: [{ id: "claude-code", label: "Claude Code", state: "ok" }],
  sessions: [makeSession({ status: "working" })],
};

/** Runs the command with each address answering as `answers` says, and writes down what it asked. */
async function command(
  argv: string[],
  answers: Record<string, Reading>,
  env: NodeJS.ProcessEnv = {},
  terminals = { stdin: true, stdout: true },
) {
  const asked: string[] = [];
  let stdout = "";
  let stderr = "";
  const code = await runCommand({
    argv,
    env,
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    terminals,
    now: () => NOW,
    read: async (address) => {
      asked.push(address);
      return answers[address] ?? { kind: "not-running" };
    },
  });
  return { code, stdout, stderr, asked };
}

describe("with no address named", () => {
  test("asks npm start's address, then npm run dev's, and stops at the first answer", async () => {
    const devOnly = await command(["status"], {
      "http://localhost:5173": { kind: "answered", snapshot: quiet },
    });
    expect(devOnly).toEqual({
      code: 0,
      stdout: "Nothing needs you · 1 working · 0 idle\n",
      stderr: "",
      asked: ["http://127.0.0.1:4777", "http://localhost:5173"],
    });

    const both = await command(["status"], {
      "http://127.0.0.1:4777": { kind: "answered", snapshot: quiet },
      "http://localhost:5173": { kind: "answered", snapshot: quiet },
    });
    expect(both.asked).toEqual(["http://127.0.0.1:4777"]);
  });

  test("when neither answers, says so in one line with how to start it, and exits with 2", async () => {
    expect(await command(["status", "--count"], {})).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "Agent Lookout is not running at http://127.0.0.1:4777 or http://localhost:5173. Start it with npm start or npm run dev in its folder, or give its address with --url.\n",
      asked: ["http://127.0.0.1:4777", "http://localhost:5173"],
    });
  });

  test("another program on npm start's port does not hide Agent Lookout on npm run dev's", async () => {
    const ran = await command(["status", "--count"], {
      "http://127.0.0.1:4777": { kind: "unreadable", why: "it answered with status 404" },
      "http://localhost:5173": { kind: "answered", snapshot: quiet },
    });
    expect(ran).toMatchObject({ code: 0, stdout: "0\n", stderr: "" });
  });

  test("when one address answered with something unreadable, that is what it reports", async () => {
    const ran = await command(["status"], {
      "http://localhost:5173": { kind: "unreadable", why: "its answer is not JSON" },
    });
    expect(ran).toMatchObject({
      code: 2,
      stdout: "",
      stderr: "Agent Lookout could not be read at http://localhost:5173: its answer is not JSON.\n",
    });
  });
});

describe("with an address named", () => {
  test("asks that one only, and does not suggest --url when it was given", async () => {
    const ran = await command(["status", "--url", "http://127.0.0.1:4778"], {});
    expect(ran).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "Agent Lookout is not running at http://127.0.0.1:4778. Start it with npm start or npm run dev in its folder.\n",
      asked: ["http://127.0.0.1:4778"],
    });

    const fromSetting = await command(["status"], {}, { AGENT_LOOKOUT_URL: "http://[::1]:4779" });
    expect(fromSetting.asked).toEqual(["http://[::1]:4779"]);
  });

  test("an address elsewhere is refused without asking anything", async () => {
    const ran = await command(["status", "--url", "http://example.com:4777"], {});
    expect(ran.code).toBe(2);
    expect(ran.asked).toEqual([]);
    expect(ran.stderr).toMatch(/^--url must be an http address on this machine/);
  });
});

describe("the exit code", () => {
  test("is 1 while a session needs you, in every way of printing", async () => {
    const waiting: ReportedSnapshot = {
      ...quiet,
      sessions: [
        makeSession({
          name: "checkout-flow",
          status: "needs-you",
          waitingReason: "permission",
          statusSince: NOW - 4 * 60_000 - 12_000,
        }),
      ],
    };
    const answers = { "http://127.0.0.1:4777": { kind: "answered", snapshot: waiting } as const };

    expect(await command(["status"], answers)).toMatchObject({
      code: 1,
      stdout: "1 needs you · 0 working · 0 idle\ncheckout-flow  Waiting for permission  4m 12s\n",
    });
    expect(await command(["status", "--count"], answers)).toMatchObject({ code: 1, stdout: "1\n" });
    expect((await command(["status", "--json"], answers)).code).toBe(1);
  });

  test("is 2 before any agent has been read, in every way of printing, since nothing was counted", async () => {
    const looking: ReportedSnapshot = {
      sources: [{ id: "claude-code", label: "Claude Code", state: "searching" }],
      sessions: [],
    };
    const answers = { "http://127.0.0.1:4777": { kind: "answered", snapshot: looking } as const };

    expect(await command(["status"], answers)).toMatchObject({
      code: 2,
      stdout: "Agent Lookout is still looking for agents on this computer\n",
      stderr: "",
    });
    expect(await command(["status", "--count"], answers)).toMatchObject({ code: 2, stdout: "–\n" });
    const json = await command(["status", "--json"], answers);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ counted: false });
  });

  test("is 0 for --help, which asks nothing, and 2 for a mistyped command", async () => {
    const help = await command(["--help"], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: agent-lookout status/);
    expect(help.asked).toEqual([]);

    const mistyped = await command(["stauts"], {});
    expect(mistyped).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "agent-lookout has no command called stauts. Run agent-lookout --help to see what it takes.\n",
      asked: [],
    });
  });
});

describe("run by tmux for a status line", () => {
  const TMUX = "/private/tmp/tmux-501/default,4242,0";

  test("is told apart by TMUX being set with neither stdin nor stdout a terminal", () => {
    const none = { stdin: false, stdout: false };
    expect(runByTmux({ env: { TMUX }, terminals: none })).toBe(true);
    expect(runByTmux({ env: {}, terminals: none })).toBe(false);
    // Typed in a tmux pane, piped in a tmux pane, or in a prompt there.
    expect(runByTmux({ env: { TMUX }, terminals: { stdin: true, stdout: true } })).toBe(false);
    expect(runByTmux({ env: { TMUX }, terminals: { stdin: true, stdout: false } })).toBe(false);
  });

  test("doubles each # in a name, so tmux shows it and reads none of it as its own formatting", async () => {
    const hostile: ReportedSnapshot = {
      ...quiet,
      sessions: [
        makeSession({ name: "#[fg=red]#{host}", status: "needs-you", statusSince: NOW - 5_000 }),
      ],
    };
    const answers = { "http://127.0.0.1:4777": { kind: "answered", snapshot: hostile } as const };

    const inTmux = await command(["status"], answers, { TMUX }, { stdin: false, stdout: false });
    expect(inTmux.stdout.split("\n")[1]).toBe("##[fg=red]##{host}  Waiting for you  5s");
    const inAPane = await command(["status"], answers, { TMUX });
    expect(inAPane.stdout.split("\n")[1]).toBe("#[fg=red]#{host}  Waiting for you  5s");
  });
});
