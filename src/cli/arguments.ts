// What the `agent-lookout` command was asked to do, read from its arguments.
// It has two commands: `status`, with three ways to print what it finds, and
// `mcp`, which serves the same to an agent over stdin and stdout.

/** How `status` prints: lines for a person, JSON for a program, or the bare count. */
export type StatusOutput = "text" | "json" | "count";

export interface StatusOptions {
  output: StatusOutput;
  /** The address given with `--url`, as typed, or null when none was. */
  url: string | null;
}

export interface McpOptions {
  /** The address given with `--url`, as typed, or null when none was. */
  url: string | null;
}

export type ParsedArguments =
  | { kind: "help" }
  | { kind: "status"; options: StatusOptions }
  | { kind: "mcp"; options: McpOptions }
  | { kind: "error"; message: string };

export const HELP = `Usage: agent-lookout status [--json | --count] [--url <address>]
       agent-lookout mcp [--url <address>]

status prints which sessions need you, from the Agent Lookout running on
this machine. mcp gives the same to an AI agent: it is a Model Context
Protocol server on stdin and stdout, for the agent's app to start. Its
tools only read. Neither command starts Agent Lookout, and neither asks
anything but Agent Lookout's own server.

Options:
  --json           status: print the counts and the waiting sessions as JSON
  --count          status: print only the number of sessions that need you
  --url <address>  Where Agent Lookout runs, such as http://127.0.0.1:4777.
                   AGENT_LOOKOUT_URL does the same. Without either, it tries
                   http://127.0.0.1:4777 (npm start), then
                   http://localhost:5173 (npm run dev).
                   Only an address on this machine is accepted.
  -h, --help       Print this help

Exit codes of status:
  0  Nothing needs you
  1  One or more sessions need you
  2  Agent Lookout could not be reached or read, has not read any agent
     yet, or the command was mistyped

mcp runs until the app that started it closes its stdin, then exits with
0. It exits with 2 when the command was mistyped or the address refused.
`;

const SEE_HELP = "Run agent-lookout --help to see what it takes.";

function error(message: string): ParsedArguments {
  return { kind: "error", message: `${message} ${SEE_HELP}` };
}

/**
 * Reads the arguments that follow the program's name. `--help` anywhere wins,
 * so it always works, whatever else was typed.
 */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv[0] === "help" || argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { kind: "help" };
  }

  const [command, ...rest] = argv;
  if (command === undefined) return error("agent-lookout needs a command: status or mcp.");
  if (command !== "status" && command !== "mcp") {
    return error(`agent-lookout has no command called ${command}.`);
  }

  let json = false;
  let count = false;
  let url: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === "--json" && command === "status") {
      json = true;
    } else if (arg === "--count" && command === "status") {
      count = true;
    } else if (arg === "--url") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return error("--url needs an address, such as http://127.0.0.1:4777.");
      }
      url = value;
      index += 1;
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
      if (url === "") return error("--url needs an address, such as http://127.0.0.1:4777.");
    } else if (arg.startsWith("-")) {
      return error(`${command} has no option ${arg}.`);
    } else {
      return error(`${command} takes only options, not ${arg}.`);
    }
  }

  if (command === "mcp") return { kind: "mcp", options: { url } };
  if (json && count) return error("Choose one of --json and --count.");
  return {
    kind: "status",
    options: { output: json ? "json" : count ? "count" : "text", url },
  };
}
