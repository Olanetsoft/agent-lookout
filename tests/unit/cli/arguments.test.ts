import { describe, expect, test } from "vitest";

import { HELP, parseArguments } from "@cli/arguments";

describe("the start command", () => {
  test("is what runs with no command, or only options, on the default port and with no browser", () => {
    const plain = { kind: "start", options: { port: null, open: false } };
    expect(parseArguments([])).toEqual(plain);
    expect(parseArguments(["start"])).toEqual(plain);
  });

  test("--port takes the number after it, or after an equals sign, with or without the command", () => {
    expect(parseArguments(["--port", "4778"])).toEqual({
      kind: "start",
      options: { port: 4778, open: false },
    });
    expect(parseArguments(["start", "--port=4779"])).toEqual({
      kind: "start",
      options: { port: 4779, open: false },
    });
    // 0 lets the system choose, as AGENT_LOOKOUT_PORT=0 does.
    expect(parseArguments(["--port", "0"])).toEqual({
      kind: "start",
      options: { port: 0, open: false },
    });
    expect(parseArguments(["--port", "65535"])).toEqual({
      kind: "start",
      options: { port: 65_535, open: false },
    });
  });

  test("--open asks for the browser, in any order with --port", () => {
    expect(parseArguments(["--open"])).toEqual({
      kind: "start",
      options: { port: null, open: true },
    });
    expect(parseArguments(["start", "--open", "--port", "4778"])).toEqual({
      kind: "start",
      options: { port: 4778, open: true },
    });
    expect(parseArguments(["--port=4778", "--open"])).toEqual({
      kind: "start",
      options: { port: 4778, open: true },
    });
  });

  test("a second --port takes the place of the first", () => {
    expect(parseArguments(["--port", "4778", "--port", "4779"])).toEqual({
      kind: "start",
      options: { port: 4779, open: false },
    });
  });
});

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
    [["start", "--help"]],
    [["--port", "4778", "--help"]],
    [["--open", "-h"]],
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

  test("names all three commands, and says how start and mcp end", () => {
    expect(HELP).toMatch(
      /^Usage: agent-lookout \[start\] \[--port <number>\] \[--open\]\n {7}agent-lookout status \[--json \| --count\] \[--url <address>\]\n {7}agent-lookout mcp \[--url <address>\]\n/,
    );
    expect(HELP).toContain("Its tools only read.");
    expect(HELP).toContain("start runs until Ctrl+C, then exits with 0.");
    expect(HELP).toContain("then exits with\n0.");
  });

  test("names the options of start, the port it uses and the setting that does the same", () => {
    expect(HELP).toContain("--port <number>  start:");
    expect(HELP).toContain("--open           start: open the address in the default browser");
    expect(HELP).toContain("http://127.0.0.1:4777, on this machine only");
    expect(HELP).toContain("AGENT_LOOKOUT_PORT");
  });

  test("names the setting and the addresses it tries", () => {
    expect(HELP).toContain("AGENT_LOOKOUT_URL");
    expect(HELP).toContain("http://127.0.0.1:4777 (agent-lookout or npm start)");
    expect(HELP).toContain("http://localhost:5173 (npm run dev)");
  });
});

describe("the version", () => {
  test.each([
    [["--version"]],
    [["-v"]],
    [["status", "--version"]],
    [["status", "--frob", "-v"]],
    [["mcp", "-v"]],
    [["start", "--port", "4778", "--version"]],
  ])("%j asks for the version, whatever else was typed", (argv) => {
    expect(parseArguments(argv)).toEqual({ kind: "version" });
  });

  test("gives way to help", () => {
    expect(parseArguments(["--version", "--help"])).toEqual({ kind: "help" });
    expect(parseArguments(["help", "-v"])).toEqual({ kind: "help" });
  });

  test("is in the help", () => {
    expect(HELP).toContain("  -v, --version    Print the version of agent-lookout\n");
  });
});

describe("arguments it cannot use", () => {
  test.each([
    [["stats"], "agent-lookout has no command called stats."],
    [["start", "now"], "start takes only options, not now."],
    [["--json"], "start has no option --json."],
    [["--url", "http://127.0.0.1:4777"], "start has no option --url."],
    [["start", "--host", "0.0.0.0"], "start has no option --host."],
    [["--port"], "--port needs a port number, such as 4778."],
    [["--port", "--open"], "--port needs a port number, such as 4778."],
    [["--port="], "--port needs a port number, such as 4778."],
    [["--port", "http"], "--port takes a number from 0 to 65535, not http."],
    [["--port", "65536"], "--port takes a number from 0 to 65535, not 65536."],
    [["--port=4778.5"], "--port takes a number from 0 to 65535, not 4778.5."],
    [["--port", " 4778"], "--port takes a number from 0 to 65535, not  4778."],
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
