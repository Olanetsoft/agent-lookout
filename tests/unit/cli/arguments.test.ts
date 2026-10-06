import { describe, expect, test } from "vitest";

import { HELP, parseArguments } from "@cli/arguments";

describe("the status command", () => {
  test("prints lines for a person unless told otherwise, and names no address", () => {
    expect(parseArguments(["status"])).toEqual({
      kind: "status",
      options: { output: "text", url: null },
    });
  });

  test("--json and --count choose how it prints", () => {
    expect(parseArguments(["status", "--json"])).toEqual({
      kind: "status",
      options: { output: "json", url: null },
    });
    expect(parseArguments(["status", "--count"])).toEqual({
      kind: "status",
      options: { output: "count", url: null },
    });
  });

  test("--url takes the address after it, or after an equals sign, in any order", () => {
    expect(parseArguments(["status", "--url", "http://127.0.0.1:4778", "--count"])).toEqual({
      kind: "status",
      options: { output: "count", url: "http://127.0.0.1:4778" },
    });
    expect(parseArguments(["status", "--json", "--url=http://localhost:5180"])).toEqual({
      kind: "status",
      options: { output: "json", url: "http://localhost:5180" },
    });
  });

  test("a second --url takes the place of the first", () => {
    expect(
      parseArguments(["status", "--url", "http://127.0.0.1:1", "--url", "http://127.0.0.1:2"]),
    ).toEqual({ kind: "status", options: { output: "text", url: "http://127.0.0.1:2" } });
  });
});

describe("the mcp command", () => {
  test("names no address unless --url gives one", () => {
    expect(parseArguments(["mcp"])).toEqual({ kind: "mcp", options: { url: null } });
    expect(parseArguments(["mcp", "--url", "http://127.0.0.1:4778"])).toEqual({
      kind: "mcp",
      options: { url: "http://127.0.0.1:4778" },
    });
    expect(parseArguments(["mcp", "--url=http://localhost:5180"])).toEqual({
      kind: "mcp",
      options: { url: "http://localhost:5180" },
    });
  });
});

describe("help", () => {
  test.each([
    [["--help"]],
    [["-h"]],
    [["help"]],
    [["status", "--help"]],
    [["status", "--frob", "-h"]],
    [["mcp", "--help"]],
  ])("%j asks for help, whatever else was typed", (argv) => {
    expect(parseArguments(argv)).toEqual({ kind: "help" });
  });

  test("says what each exit code means", () => {
    expect(HELP).toContain("0  Nothing needs you");
    expect(HELP).toContain("1  One or more sessions need you");
    expect(HELP).toContain(
      [
        "  2  Agent Lookout could not be reached or read, has not read any agent",
        "     yet, or the command was mistyped",
      ].join("\n"),
    );
  });

  test("names both commands, and says how mcp ends", () => {
    expect(HELP).toMatch(
      /^Usage: agent-lookout status \[--json \| --count\] \[--url <address>\]\n {7}agent-lookout mcp \[--url <address>\]\n/,
    );
    expect(HELP).toContain("Its\ntools only read.");
    expect(HELP).toContain("then exits with\n0.");
  });

  test("names the setting and the addresses it tries", () => {
    expect(HELP).toContain("AGENT_LOOKOUT_URL");
    expect(HELP).toContain("http://127.0.0.1:4777 (npm start)");
    expect(HELP).toContain("http://localhost:5173 (npm run dev)");
  });
});

describe("arguments it cannot use", () => {
  test.each([
    [[], "agent-lookout needs a command: status or mcp."],
    [["stats"], "agent-lookout has no command called stats."],
    [["status", "--verbose"], "status has no option --verbose."],
    [["status", "checkout-flow"], "status takes only options, not checkout-flow."],
    [["status", "--url"], "--url needs an address, such as http://127.0.0.1:4777."],
    [["status", "--url", "--json"], "--url needs an address, such as http://127.0.0.1:4777."],
    [["status", "--url="], "--url needs an address, such as http://127.0.0.1:4777."],
    [["status", "--json", "--count"], "Choose one of --json and --count."],
    [["mcp", "--json"], "mcp has no option --json."],
    [["mcp", "--count"], "mcp has no option --count."],
    [["mcp", "list_sessions"], "mcp takes only options, not list_sessions."],
    [["mcp", "--url"], "--url needs an address, such as http://127.0.0.1:4777."],
  ])("%j is refused in one sentence that points to --help", (argv, sentence) => {
    expect(parseArguments(argv)).toEqual({
      kind: "error",
      message: `${sentence} Run agent-lookout --help to see what it takes.`,
    });
  });
});
