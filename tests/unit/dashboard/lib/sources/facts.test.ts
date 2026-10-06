import { expect, test } from "vitest";

import { splitFacts } from "@dashboard/lib/sources/facts";

const facts = (sentence: string) =>
  splitFacts(sentence)
    .filter((run) => run.fact)
    .map((run) => run.text);

test("a command and a folder inside a sentence are found, and the sentence is left as it was", () => {
  const sentence =
    "Listed by claude agents --json, with apps and status times from ~/.claude/sessions.";
  const runs = splitFacts(sentence);

  expect(runs).toEqual([
    { text: "Listed by ", fact: false },
    { text: "claude agents --json", fact: true },
    { text: ", with apps and status times from ", fact: false },
    { text: "~/.claude/sessions", fact: true },
    { text: ".", fact: false },
  ]);
  expect(runs.map((run) => run.text).join("")).toBe(sentence);
});

test("a variable name and the absolute paths it points at are facts", () => {
  expect(
    facts(
      "AGENT_LOOKOUT_CLAUDE_BIN is set to /tmp/example/bin/not-claude, which is not a program this user can run, and there is no session registry at /tmp/example/sessions.",
    ),
  ).toEqual(["AGENT_LOOKOUT_CLAUDE_BIN", "/tmp/example/bin/not-claude", "/tmp/example/sessions"]);
});

test("the command on its own, PATH and a list of folders are facts", () => {
  expect(
    facts(
      "The claude command was not found on PATH or in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin",
    ),
  ).toEqual(["claude", "PATH", "~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
});

test("a route in a connection problem is a fact", () => {
  expect(facts("The local server answered /api/sessions with error 404.")).toEqual([
    "/api/sessions",
  ]);
});

test("gh, and the command that signs it in, are facts", () => {
  expect(facts("Install gh, the GitHub CLI, and sign in with gh auth login.")).toEqual([
    "gh",
    "gh auth login",
  ]);
  expect(facts("gh did not answer within 15 seconds.")).toEqual(["gh"]);
  // Inside a word it is no command.
  expect(facts("The light was high and the night long.")).toEqual([]);
});

test("a flag on its own and a Windows path are facts", () => {
  expect(facts("Run it again with --json.")).toEqual(["--json"]);
  expect(facts("Looked in C:\\Users\\example\\.claude\\sessions, and found nothing.")).toEqual([
    "C:\\Users\\example\\.claude\\sessions",
  ]);
});

test.each([
  "Claude Code was not found.",
  "Something unexpected went wrong while reading Claude Code sessions.",
  "It checks every two seconds and/or when asked, on 9/30/2026.",
  "Open http://localhost:4777 in a browser.",
  "A well-known, long-running task - nothing else.",
  "",
])("%j has no facts in it", (sentence) => {
  expect(facts(sentence)).toEqual([]);
  expect(
    splitFacts(sentence)
      .map((run) => run.text)
      .join(""),
  ).toBe(sentence);
});
